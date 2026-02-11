import * as core from '@actions/core';
import * as github from '@actions/github';
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import type { Artifact, TargetPlatform } from '../types';
import { execCommand, normalizeTagName, retry, sleep, trimToString } from '../utils';

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Minimal release shape consumed by this action workflow.
 */
export type ReleaseSummary = {
  id: number;
  html_url: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  tag_name?: string | null;
  created_at?: string | null;
};

function mapRelease(release: {
  id: number;
  html_url: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  tag_name?: string | null;
  created_at?: string | null;
}): ReleaseSummary {
  return {
    id: release.id,
    html_url: release.html_url,
    name: release.name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    tag_name: release.tag_name,
    created_at: release.created_at,
  };
}

async function getReleaseByTag(
  octokit: Octokit,
  owner: string,
  repo: string,
  tagName: string,
): Promise<ReleaseSummary | null> {
  try {
    const existing = await octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag: tagName,
    });
    return mapRelease(existing.data);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return null;
    }
    throw error;
  }
}

export async function getReleaseById(
  octokit: Octokit,
  owner: string,
  repo: string,
  releaseId: number,
): Promise<ReleaseSummary | null> {
  try {
    const existing = await octokit.rest.repos.getRelease({
      owner,
      repo,
      release_id: releaseId,
    });
    return mapRelease(existing.data);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return null;
    }
    throw error;
  }
}

async function listReleasesByTag(
  octokit: Octokit,
  owner: string,
  repo: string,
  tagName: string,
): Promise<ReleaseSummary[]> {
  const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
    owner,
    repo,
    per_page: 100,
  });
  return releases
    .filter((release) => release.tag_name === tagName)
    .map((release) => mapRelease(release));
}

function sortByCreatedAt(releases: ReleaseSummary[]): ReleaseSummary[] {
  return releases.sort((a, b) => {
    const aTime = a.created_at ? Date.parse(a.created_at) : 0;
    const bTime = b.created_at ? Date.parse(b.created_at) : 0;
    return aTime - bTime;
  });
}

async function findReleaseByTag(
  octokit: Octokit,
  owner: string,
  repo: string,
  tagName: string,
): Promise<ReleaseSummary | null> {
  const direct = await getReleaseByTag(octokit, owner, repo, tagName);
  if (direct) {
    return direct;
  }

  const matches = await listReleasesByTag(octokit, owner, repo, tagName);

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    core.warning(`Multiple releases found for tag ${tagName}; using the earliest one.`);
  }

  const sorted = sortByCreatedAt(matches);
  return sorted[0];
}

async function resolveCanonicalRelease(
  octokit: Octokit,
  owner: string,
  repo: string,
  tagName: string,
): Promise<{ canonical: ReleaseSummary | null; duplicates: ReleaseSummary[] }> {
  const matches = await listReleasesByTag(octokit, owner, repo, tagName);
  if (matches.length === 0) {
    return { canonical: null, duplicates: [] };
  }

  const sorted = sortByCreatedAt(matches);
  return { canonical: sorted[0], duplicates: sorted.slice(1) };
}

async function resolveCanonicalReleaseWithStabilization(
  octokit: Octokit,
  owner: string,
  repo: string,
  tagName: string,
  attempts: number = 5,
  delay: number = 1000,
): Promise<{ canonical: ReleaseSummary | null; duplicates: ReleaseSummary[] }> {
  let lastKey: string | null = null;
  let resolved: { canonical: ReleaseSummary | null; duplicates: ReleaseSummary[] } = {
    canonical: null,
    duplicates: [],
  };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    resolved = await resolveCanonicalRelease(octokit, owner, repo, tagName);
    const { canonical, duplicates } = resolved;

    if (canonical) {
      const key = [canonical.id, ...duplicates.map((release) => release.id)].join(',');
      if (key === lastKey) {
        return resolved;
      }
      lastKey = key;
    }

    if (attempt < attempts) {
      await sleep(delay);
    }
  }

  return resolved;
}

export async function ensureRelease(params: {
  token: string;
  tagName: string;
  releaseName?: string;
  releaseBody?: string;
  draft: boolean;
  prerelease: boolean;
}): Promise<{ id: number; html_url: string }> {
  const { token, tagName: rawTagName, releaseName, releaseBody, draft, prerelease } = params;
  const tagName = normalizeTagName(rawTagName);
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  core.info(`Ensuring release for tag "${tagName}"...`);

  const ensureTagRef = async (): Promise<'created' | 'exists' | 'skipped'> => {
    const ref = tagName.startsWith('refs/tags/') ? tagName : `refs/tags/${tagName}`;
    try {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref,
        sha: github.context.sha,
      });
      return 'created';
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 422) {
        try {
          const lookup = tagName.startsWith('refs/tags/')
            ? tagName.replace('refs/', '')
            : `tags/${tagName}`;
          await octokit.rest.git.getRef({ owner, repo, ref: lookup });
          return 'exists';
        } catch (lookupError) {
          const lookupStatus = (lookupError as { status?: number }).status;
          if (lookupStatus === 404) {
            core.warning(`Failed to create tag ref ${ref}; continuing without tag lock.`);
            return 'skipped';
          }
          throw lookupError;
        }
      }
      throw error;
    }
  };

  const existing = await findReleaseByTag(octokit, owner, repo, tagName);
  if (existing) {
    const shouldUpdate = Boolean(releaseName || releaseBody);
    if (!shouldUpdate) {
      core.info(`Reusing existing release id=${existing.id} for tag "${tagName}".`);
      return { id: existing.id, html_url: existing.html_url };
    }

    const updated = await octokit.rest.repos.updateRelease({
      owner,
      repo,
      release_id: existing.id,
      name: releaseName || existing.name || tagName,
      body: releaseBody ?? existing.body ?? undefined,
      draft: existing.draft,
      prerelease: existing.prerelease,
    });
    core.info(`Updated existing release id=${updated.data.id} for tag "${tagName}".`);

    return { id: updated.data.id, html_url: updated.data.html_url };
  }

  const tagLock = await ensureTagRef();
  if (tagLock === 'exists') {
    const waited = await retry(async () => {
      const release = await findReleaseByTag(octokit, owner, repo, tagName);
      if (!release) {
        throw new Error('Release not visible yet.');
      }
      return release;
    }, 5, 1000).catch(() => null);
    if (waited) {
      const shouldUpdate = Boolean(releaseName || releaseBody);
      if (!shouldUpdate) {
        core.info(`Detected concurrently created release id=${waited.id} for tag "${tagName}".`);
        return { id: waited.id, html_url: waited.html_url };
      }

      const updated = await octokit.rest.repos.updateRelease({
        owner,
        repo,
        release_id: waited.id,
        name: releaseName || waited.name || tagName,
        body: releaseBody ?? waited.body ?? undefined,
        draft: waited.draft,
        prerelease: waited.prerelease,
      });
      core.info(`Updated concurrently created release id=${updated.data.id} for tag "${tagName}".`);
      return { id: updated.data.id, html_url: updated.data.html_url };
    }
  }

  try {
    const maybeExisting = await retry(async () => {
      const release = await findReleaseByTag(octokit, owner, repo, tagName);
      if (!release) {
        throw new Error('Release not visible yet.');
      }
      return release;
    }, 2, 750).catch(() => null);

    if (maybeExisting) {
      core.info(`Release became visible during retry; using id=${maybeExisting.id} for tag "${tagName}".`);
      return { id: maybeExisting.id, html_url: maybeExisting.html_url };
    }

    const created = await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tagName,
      name: releaseName || tagName,
      body: releaseBody,
      draft,
      prerelease,
    });
    core.info(`Created release id=${created.data.id} for tag "${tagName}".`);

    const stabilized = await resolveCanonicalReleaseWithStabilization(
      octokit,
      owner,
      repo,
      tagName,
      5,
      750,
    );

    if (stabilized.canonical && stabilized.canonical.id !== created.data.id) {
      try {
        await octokit.rest.repos.deleteRelease({
          owner,
          repo,
          release_id: created.data.id,
        });
        core.warning(`Deleted duplicate release ${created.data.id} for tag ${tagName}.`);
      } catch (deleteError) {
        core.warning(`Failed to delete duplicate release ${created.data.id}: ${(deleteError as Error).message}`);
      }
      return { id: stabilized.canonical.id, html_url: stabilized.canonical.html_url };
    }

    return { id: created.data.id, html_url: created.data.html_url };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 422) {
      const resolved = await retry(async () => {
        const release = await findReleaseByTag(octokit, owner, repo, tagName);
        if (!release) {
          throw new Error('Release not visible yet.');
        }
        return release;
      }, 3, 1000);
      core.info(`Resolved existing release id=${resolved.id} after create conflict for tag "${tagName}".`);
      return { id: resolved.id, html_url: resolved.html_url };
    }
    throw error;
  }
}

/**
 * Best-effort cleanup for duplicate releases that point to the same tag.
 */
export async function cleanupDuplicateReleases(params: {
  token: string;
  tagName: string;
  keepReleaseId: number;
}): Promise<void> {
  const { token, tagName: rawTagName, keepReleaseId } = params;
  const tagName = normalizeTagName(rawTagName);
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const matches = await listReleasesByTag(octokit, owner, repo, tagName);
  if (matches.length <= 1) {
    return;
  }

  const sorted = sortByCreatedAt(matches);
  const keep = sorted.find((release) => release.id === keepReleaseId) ?? sorted[0];
  if (!keep) {
    return;
  }

  if (keep.id !== keepReleaseId) {
    core.warning(`Release ${keepReleaseId} not found for tag ${tagName}; keeping ${keep.id} as canonical.`);
  }

  const keepAssets = await octokit.rest.repos.listReleaseAssets({
    owner,
    repo,
    release_id: keep.id,
    per_page: 100,
  });
  const keepAssetNames = new Set(keepAssets.data.map((asset) => asset.name));

  for (const release of sorted) {
    if (release.id === keep.id) continue;

    const duplicateAssets = await octokit.rest.repos.listReleaseAssets({
      owner,
      repo,
      release_id: release.id,
      per_page: 100,
    });

    const extraAssets = duplicateAssets.data.filter(
      (asset) => !keepAssetNames.has(asset.name),
    );

    if (extraAssets.length > 0) {
      core.warning(
        `Duplicate release ${release.id} for tag ${tagName} has assets not on the canonical release; skipping delete.`,
      );
      continue;
    }

    try {
      await octokit.rest.repos.deleteRelease({
        owner,
        repo,
        release_id: release.id,
      });
      core.info(`Deleted duplicate release ${release.id} for tag ${tagName}.`);
    } catch (deleteError) {
      core.warning(
        `Failed to delete duplicate release ${release.id}: ${(deleteError as Error).message}`,
      );
    }
  }
}

// Preferred upload formats per platform when multiple artifacts are produced.
const RECOMMENDED_EXTENSIONS: Record<TargetPlatform, string[]> = {
  macos: ['dmg', 'pkg'],
  windows: ['msi', 'exe'],
  linux: ['deb', 'appimage', 'rpm'],
  android: ['apk'],
  ios: ['ipa'],
  ohos: ['hap'],
};

function getExtensionInfo(filePath: string): { raw: string; lower: string } {
  const ext = extname(filePath);
  const raw = ext.startsWith('.') ? ext.slice(1) : ext;
  return { raw, lower: raw.toLowerCase() };
}

function sanitizeAssetNamePart(value?: string | null): string | undefined {
  const trimmed = trimToString(value);
  if (!trimmed) return undefined;
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || undefined;
}

function normalizeAssetName(name: string): string {
  return trimToString(name).replace(/[\\/]+/g, '-').replace(/\s+/g, '-');
}

function applyTemplate(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.split(key).join(value);
  }
  return result;
}

function ensureUniqueAssetName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }

  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let index = 2;
  let candidate = `${base}-${index}${ext}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function filterArtifactsForUpload(artifacts: Artifact[]): Artifact[] {
  const groupInfo = new Map<string, { recommended: string[]; hasRecommended: boolean }>();

  for (const artifact of artifacts) {
    const key = `${artifact.platform}|${artifact.arch}|${artifact.mode}`;
    let info = groupInfo.get(key);
    if (!info) {
      const recommended = RECOMMENDED_EXTENSIONS[artifact.platform] ?? [];
      info = { recommended, hasRecommended: false };
      groupInfo.set(key, info);
    }
    const ext = getExtensionInfo(artifact.path).lower;
    if (info.recommended.length > 0 && info.recommended.includes(ext)) {
      info.hasRecommended = true;
    }
  }

  const filtered: Artifact[] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.platform}|${artifact.arch}|${artifact.mode}`;
    const info = groupInfo.get(key);
    if (!info || info.recommended.length === 0 || !info.hasRecommended) {
      filtered.push(artifact);
      continue;
    }
    const ext = getExtensionInfo(artifact.path).lower;
    if (info.recommended.includes(ext)) {
      filtered.push(artifact);
    }
  }

  return filtered;
}

async function zipDirectory(sourceDir: string, destZip: string): Promise<void> {
  if (process.platform === 'win32') {
    const escapedSource = sourceDir.replace(/'/g, "''");
    const escapedDest = destZip.replace(/'/g, "''");
    const command = `Compress-Archive -Path '${escapedSource}' -DestinationPath '${escapedDest}' -Force`;
    await execCommand('powershell', ['-NoProfile', '-Command', command]);
    return;
  }

  await execCommand('zip', ['-r', destZip, basename(sourceDir)], { cwd: dirname(sourceDir) });
}

function buildAssetName(params: {
  artifact: Artifact;
  uploadPath: string;
  assetNameTemplate?: string;
  assetPrefix?: string;
  appName?: string;
  appVersion?: string;
}): string {
  const { artifact, uploadPath, assetNameTemplate, assetPrefix, appName, appVersion } = params;
  const extension = getExtensionInfo(uploadPath);
  const uploadFilename = basename(uploadPath);
  const uploadBasename = extension.raw
    ? uploadFilename.slice(0, -(extension.raw.length + 1))
    : uploadFilename;

  const values: Record<string, string> = {
    '__APP__': sanitizeAssetNamePart(appName) ?? '',
    '__VERSION__': sanitizeAssetNamePart(appVersion) ?? '',
    '__PLATFORM__': sanitizeAssetNamePart(artifact.platform) ?? '',
    '__ARCH__': sanitizeAssetNamePart(artifact.arch) ?? '',
    '__MODE__': sanitizeAssetNamePart(artifact.mode) ?? '',
    '__EXT__': sanitizeAssetNamePart(extension.raw) ?? '',
    '__FILENAME__': sanitizeAssetNamePart(uploadFilename) ?? '',
    '__BASENAME__': sanitizeAssetNamePart(uploadBasename) ?? '',
  };

  let name: string;

  if (assetNameTemplate) {
    name = applyTemplate(assetNameTemplate, values);
  } else {
    const parts = [
      values['__APP__'],
      values['__VERSION__'],
      values['__PLATFORM__'],
      values['__ARCH__'],
      values['__MODE__'],
    ].filter(Boolean);
    const base = parts.length > 0 ? parts.join('-') : values['__BASENAME__'] || uploadBasename;
    name = extension.raw ? `${base}.${extension.raw}` : base;
  }

  const prefix = sanitizeAssetNamePart(assetPrefix);
  if (prefix) {
    name = `${prefix}-${name}`;
  }

  const normalized = normalizeAssetName(name);
  return normalized || uploadFilename;
}

export async function uploadReleaseAssets(params: {
  token: string;
  releaseId: number;
  artifacts: Artifact[];
  assetNameTemplate?: string;
  assetPrefix?: string;
  appName?: string;
  appVersion?: string;
}): Promise<void> {
  const { token, releaseId, artifacts, assetNameTemplate, assetPrefix, appName, appVersion } = params;
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  core.info(`Preparing release asset upload. release_id=${releaseId}, artifacts=${artifacts.length}`);

  const filteredArtifacts = filterArtifactsForUpload(artifacts);
  if (filteredArtifacts.length !== artifacts.length) {
    core.info(`Filtered artifacts for release upload: ${filteredArtifacts.length}/${artifacts.length} selected.`);
  }

  const missingArtifacts = filteredArtifacts
    .filter((artifact) => !existsSync(artifact.path))
    .map((artifact) => artifact.path);
  if (missingArtifacts.length > 0) {
    throw new Error(`Missing artifacts on disk:\n${missingArtifacts.join('\n')}`);
  }

  const existingAssets = await octokit.rest.repos.listReleaseAssets({
    owner,
    repo,
    release_id: releaseId,
    per_page: 100,
  });
  const existingByName = new Map(
    existingAssets.data.map((asset) => [asset.name, asset.id]),
  );

  const usedNames = new Set<string>();

  for (const artifact of filteredArtifacts) {
    let uploadPath = artifact.path;
    const stat = statSync(uploadPath);
    if (stat.isDirectory()) {
      const tempRoot = mkdtempSync(join(tmpdir(), 'makepad-packaging-action-'));
      const zipPath = join(tempRoot, `${basename(uploadPath)}.zip`);
      core.info(`Zipping directory artifact: ${uploadPath} -> ${zipPath}`);
      await zipDirectory(uploadPath, zipPath);
      uploadPath = zipPath;
    }

    let assetName = buildAssetName({
      artifact,
      uploadPath,
      assetNameTemplate,
      assetPrefix,
      appName,
      appVersion,
    });
    assetName = ensureUniqueAssetName(assetName, usedNames);

    const existingId = existingByName.get(assetName);
    if (existingId) {
      await octokit.rest.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: existingId,
      });
      core.info(`Replaced existing release asset "${assetName}" (asset_id=${existingId}).`);
    }

    const uploadStat = statSync(uploadPath);
    core.info(`Uploading asset "${assetName}" (${uploadStat.size} bytes)...`);
    await octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: releaseId,
      name: assetName,
      data: createReadStream(uploadPath) as unknown as string,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': uploadStat.size,
      },
    });
  }
}
