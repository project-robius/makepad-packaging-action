import * as core from '@actions/core';
import * as github from '@actions/github';
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import type { Artifact, TargetArch, TargetPlatform } from '../types';
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

type ReleaseAssetSummary = {
  id: number;
  name: string;
  api_url: string;
  browser_download_url: string;
};

export type UploadedReleaseAsset = {
  id: number;
  name: string;
  url: string;
  artifact: Artifact;
  uploadPath: string;
};

type UpdaterFormat = 'nsis' | 'wix' | 'appimage' | 'app' | 'apk' | 'ipa';

type UpdaterPlatformEntry = {
  url: string;
  signature?: string;
  format: UpdaterFormat;
};

type ReleaseRepositoryContext = {
  owner?: string;
  repo?: string;
  githubBaseUrl?: string;
};

function resolveReleaseRepositoryContext(
  context?: ReleaseRepositoryContext,
): { owner: string; repo: string } {
  return {
    owner: trimToString(context?.owner) || github.context.repo.owner,
    repo: trimToString(context?.repo) || github.context.repo.repo,
  };
}

function getOctokitClient(token: string, githubBaseUrl?: string): Octokit {
  const baseUrl = trimToString(githubBaseUrl);
  return baseUrl
    ? github.getOctokit(token, { baseUrl })
    : github.getOctokit(token);
}

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

async function listReleaseAssets(
  octokit: Octokit,
  owner: string,
  repo: string,
  releaseId: number,
): Promise<ReleaseAssetSummary[]> {
  const assets = await octokit.paginate(octokit.rest.repos.listReleaseAssets, {
    owner,
    repo,
    release_id: releaseId,
    per_page: 100,
  });

  return assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    api_url: asset.url,
    browser_download_url: asset.browser_download_url,
  }));
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
  commitish?: string;
  generateReleaseNotes?: boolean;
  owner?: string;
  repo?: string;
  githubBaseUrl?: string;
}): Promise<{ id: number; html_url: string }> {
  const {
    token,
    tagName: rawTagName,
    releaseName,
    releaseBody,
    draft,
    prerelease,
    commitish,
    generateReleaseNotes,
  } = params;
  const tagName = normalizeTagName(rawTagName);
  const octokit = getOctokitClient(token, params.githubBaseUrl);
  const { owner, repo } = resolveReleaseRepositoryContext(params);
  const resolvedCommitish = trimToString(commitish) || github.context.sha;
  core.info(`Ensuring release for tag "${tagName}"...`);

  const createRelease = async (targetCommitish?: string) => {
    return octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tagName,
      name: releaseName || tagName,
      body: releaseBody,
      draft,
      prerelease,
      target_commitish: targetCommitish,
      generate_release_notes: Boolean(generateReleaseNotes),
    });
  };

  const ensureTagRef = async (): Promise<'created' | 'exists' | 'skipped'> => {
    const ref = tagName.startsWith('refs/tags/') ? tagName : `refs/tags/${tagName}`;
    try {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref,
        sha: resolvedCommitish,
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

    let created;
    try {
      created = await createRelease(resolvedCommitish);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = String((error as Error).message || '');
      const isCommitishError =
        status === 422 &&
        /commit|sha|target[_-]?commitish|not found|unprocessable/i.test(message);
      if (!isCommitishError) {
        throw error;
      }
      core.warning(
        `Failed to create release with target_commitish="${resolvedCommitish}". Retrying without target_commitish.`,
      );
      created = await createRelease(undefined);
    }
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
  owner?: string;
  repo?: string;
  githubBaseUrl?: string;
}): Promise<void> {
  const { token, tagName: rawTagName, keepReleaseId } = params;
  const tagName = normalizeTagName(rawTagName);
  const octokit = getOctokitClient(token, params.githubBaseUrl);
  const { owner, repo } = resolveReleaseRepositoryContext(params);

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

function renderPattern(
  pattern: string,
  values: Record<string, string>,
): string {
  return pattern.replace(/\[(\w+)\]/g, (match, key: string) => {
    const normalized = key.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(values, normalized)) {
      return match;
    }
    return values[normalized];
  });
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
  releaseAssetNamePattern?: string;
  assetPrefix?: string;
  appName?: string;
  appVersion?: string;
}): string {
  const {
    artifact,
    uploadPath,
    assetNameTemplate,
    releaseAssetNamePattern,
    assetPrefix,
    appName,
    appVersion,
  } = params;
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
  } else if (releaseAssetNamePattern) {
    name = renderPattern(releaseAssetNamePattern, {
      app: values['__APP__'],
      name: values['__APP__'],
      version: values['__VERSION__'],
      platform: values['__PLATFORM__'],
      arch: values['__ARCH__'],
      mode: values['__MODE__'],
      ext: values['__EXT__'],
      filename: values['__FILENAME__'],
      basename: values['__BASENAME__'],
    });
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
  releaseAssetNamePattern?: string;
  assetPrefix?: string;
  appName?: string;
  appVersion?: string;
  retryAttempts?: number;
  uploadUpdaterSignatures?: boolean;
  owner?: string;
  repo?: string;
  githubBaseUrl?: string;
}): Promise<UploadedReleaseAsset[]> {
  const {
    token,
    releaseId,
    artifacts,
    assetNameTemplate,
    releaseAssetNamePattern,
    assetPrefix,
    appName,
    appVersion,
    retryAttempts = 0,
    uploadUpdaterSignatures = true,
  } = params;
  const octokit = getOctokitClient(token, params.githubBaseUrl);
  const { owner, repo } = resolveReleaseRepositoryContext(params);
  core.info(`Preparing release asset upload. release_id=${releaseId}, artifacts=${artifacts.length}`);

  const filteredArtifacts = filterArtifactsForUpload(artifacts).filter((artifact) => {
    if (uploadUpdaterSignatures) return true;
    return getExtensionInfo(artifact.path).lower !== 'sig';
  });
  if (filteredArtifacts.length !== artifacts.length) {
    core.info(`Filtered artifacts for release upload: ${filteredArtifacts.length}/${artifacts.length} selected.`);
  }

  const missingArtifacts = filteredArtifacts
    .filter((artifact) => !existsSync(artifact.path))
    .map((artifact) => artifact.path);
  if (missingArtifacts.length > 0) {
    throw new Error(`Missing artifacts on disk:\n${missingArtifacts.join('\n')}`);
  }

  const usedNames = new Set<string>();
  const uploadedAssets: UploadedReleaseAsset[] = [];
  const maxAttempts = Math.max(2, Math.trunc(retryAttempts) + 1);

  const uploadAssetWithRetry = async (
    assetName: string,
    uploadPath: string,
  ): Promise<{ id: number; name: string; url: string }> => {
    const uploaded = await retry(async () => {
      const existingAssets = await listReleaseAssets(octokit, owner, repo, releaseId);
      const existing = existingAssets.find((asset) => asset.name === assetName);
      if (existing) {
        try {
          await octokit.rest.repos.deleteReleaseAsset({
            owner,
            repo,
            asset_id: existing.id,
          });
          core.info(`Replaced existing release asset "${assetName}" (asset_id=${existing.id}).`);
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status !== 404) {
            throw error;
          }
        }
      }

      const uploadStat = statSync(uploadPath);
      core.info(`Uploading asset "${assetName}" (${uploadStat.size} bytes)...`);
      try {
        const response = await octokit.rest.repos.uploadReleaseAsset({
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
        return {
          id: response.data.id,
          name: response.data.name,
          url: response.data.browser_download_url,
        };
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 422) {
          throw new Error(`Asset upload conflict for "${assetName}"`);
        }
        throw error;
      }
    }, maxAttempts, 700, (attempt, error) => {
      core.warning(
        `Upload attempt ${attempt}/${maxAttempts} failed for "${assetName}": ${(error as Error).message}`,
      );
    });

    return uploaded;
  };

  const findCompanionSignaturePath = (
    originalPath: string,
    finalUploadPath: string,
  ): string | undefined => {
    const candidates = Array.from(
      new Set([
        `${originalPath}.sig`,
        `${finalUploadPath}.sig`,
      ]),
    );
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  };

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
      releaseAssetNamePattern,
      assetPrefix,
      appName,
      appVersion,
    });
    assetName = ensureUniqueAssetName(assetName, usedNames);

    const uploaded = await uploadAssetWithRetry(assetName, uploadPath);

    uploadedAssets.push({
      id: uploaded.id,
      name: uploaded.name,
      url: uploaded.url,
      artifact,
      uploadPath,
    });

    if (uploadUpdaterSignatures && getExtensionInfo(uploadPath).lower !== 'sig') {
      const companionSignaturePath = findCompanionSignaturePath(artifact.path, uploadPath);
      if (companionSignaturePath) {
        let signatureAssetName = `${assetName}.sig`;
        signatureAssetName = ensureUniqueAssetName(signatureAssetName, usedNames);
        await uploadAssetWithRetry(signatureAssetName, companionSignaturePath);
      }
    }
  }

  return uploadedAssets;
}

type UpdaterPlatformName = 'windows' | 'linux' | 'darwin' | 'android' | 'ios';

type UpdaterAssetCandidate = {
  assetName: string;
  url: string;
  platform: UpdaterPlatformName;
  arch: TargetArch;
  format?: UpdaterFormat;
};

type UpdaterJsonDocument = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, UpdaterPlatformEntry>;
};

const UPDATER_JSON_ASSET_NAME = 'latest.json';

const UPDATER_FORMAT_PRIORITY: Record<UpdaterPlatformName, UpdaterFormat[]> = {
  windows: ['nsis', 'wix'],
  linux: ['appimage'],
  darwin: ['app'],
  android: ['apk'],
  ios: ['ipa'],
};

const SUPPORTED_UPDATER_FORMATS = new Set([
  'nsis',
  'wix',
  'appimage',
  'app',
  'apk',
  'ipa',
]);

const UPDATER_BASE_KEY_PATTERN = /^(windows|linux|darwin|android|ios)-(x86_64|aarch64|armv7|i686)$/;

function isUpdaterFormat(value: string): value is UpdaterFormat {
  return SUPPORTED_UPDATER_FORMATS.has(value);
}

function isSignatureAssetName(name: string): boolean {
  return trimToString(name).toLowerCase().endsWith('.sig');
}

function isUpdaterJsonAssetName(name: string): boolean {
  return trimToString(name).toLowerCase() === UPDATER_JSON_ASSET_NAME;
}

function toUpdaterPlatformName(platform: TargetPlatform): UpdaterPlatformName {
  return platform === 'macos' ? 'darwin' : platform;
}

function getLowerAssetSuffix(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tar.gz')) {
    return 'tar.gz';
  }
  return getExtensionInfo(fileName).lower;
}

function inferUpdaterFormat(fileName: string, platform?: TargetPlatform): UpdaterFormat | undefined {
  const lower = fileName.toLowerCase();
  const suffix = getLowerAssetSuffix(fileName);
  if (!suffix) return undefined;

  if (suffix === 'msi') {
    return 'wix';
  }

  if (suffix === 'exe') {
    if (platform === 'windows') {
      return 'nsis';
    }
    if (lower.includes('setup') || lower.includes('nsis')) {
      return 'nsis';
    }
    return undefined;
  }

  if (suffix === 'appimage') {
    return 'appimage';
  }

  if (suffix === 'app') {
    return 'app';
  }

  if (suffix === 'apk') {
    return 'apk';
  }

  if (suffix === 'ipa') {
    return 'ipa';
  }

  if (suffix === 'tar.gz') {
    if (platform === 'macos' || /(^|[._-])app([._-]|$)/.test(lower)) {
      return 'app';
    }
    return undefined;
  }

  return undefined;
}

function inferPlatformFromAssetName(fileName: string, format?: string): TargetPlatform | undefined {
  const lower = fileName.toLowerCase();

  if (
    lower.includes('windows') ||
    format === 'nsis' ||
    format === 'wix' ||
    lower.endsWith('.exe') ||
    lower.endsWith('.msi')
  ) {
    return 'windows';
  }

  if (lower.includes('android') || lower.endsWith('.apk')) {
    return 'android';
  }

  if (lower.includes('ios') || lower.endsWith('.ipa')) {
    return 'ios';
  }

  if (
    lower.includes('darwin') ||
    lower.includes('macos') ||
    format === 'app'
  ) {
    return 'macos';
  }

  if (
    lower.includes('linux') ||
    format === 'appimage'
  ) {
    return 'linux';
  }

  return undefined;
}

function inferArchFromAssetName(fileName: string): TargetArch | undefined {
  const lower = fileName.toLowerCase();
  if (lower.includes('x86_64') || lower.includes('amd64') || lower.includes('x64')) {
    return 'x86_64';
  }
  if (lower.includes('aarch64') || lower.includes('arm64')) {
    return 'aarch64';
  }
  if (lower.includes('armv7') || lower.includes('armhf')) {
    return 'armv7';
  }
  if (lower.includes('i686') || lower.includes('x86')) {
    return 'i686';
  }
  return undefined;
}

function getUpdaterFormatPriority(
  platform: UpdaterPlatformName,
  format: UpdaterFormat | undefined,
): number {
  if (!format) return Number.MAX_SAFE_INTEGER;
  const list = UPDATER_FORMAT_PRIORITY[platform] ?? [];
  const index = list.indexOf(format);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER - 1;
}

function isMobileUpdaterPlatform(platform: UpdaterPlatformName): boolean {
  return platform === 'android' || platform === 'ios';
}

function normalizeUpdaterPlatforms(value: unknown): Record<string, UpdaterPlatformEntry> {
  const result: Record<string, UpdaterPlatformEntry> = {};
  if (!value || typeof value !== 'object') {
    return result;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!UPDATER_BASE_KEY_PATTERN.test(key)) continue;
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const url = trimToString(obj.url);
    if (!url) continue;
    const format = trimToString(obj.format).toLowerCase();
    if (!isUpdaterFormat(format)) continue;
    const platform = key.split('-')[0] as UpdaterPlatformName;
    const signature = trimToString(obj.signature);
    if (!signature && !isMobileUpdaterPlatform(platform)) continue;

    result[key] = signature
      ? { url, signature, format }
      : { url, format };
  }

  return result;
}

function resolveUpdaterVersion(
  appVersion?: string,
  releaseTagName?: string | null,
  existingVersion?: string,
): string {
  const fromAppVersion = trimToString(appVersion);
  if (fromAppVersion) return fromAppVersion;

  const normalizedTag = normalizeTagName(trimToString(releaseTagName));
  if (normalizedTag) {
    return normalizedTag.startsWith('v') ? normalizedTag.slice(1) : normalizedTag;
  }

  const fromExisting = trimToString(existingVersion);
  if (fromExisting) return fromExisting;

  return '0.0.0';
}

function buildReleaseAssetDownloadUrl(
  owner: string,
  repo: string,
  tagName?: string | null,
  assetName?: string,
): string | undefined {
  const tag = normalizeTagName(trimToString(tagName));
  const name = trimToString(assetName);
  if (!tag || !name) {
    return undefined;
  }
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

function buildUpdaterCandidateFromReleaseAsset(
  asset: ReleaseAssetSummary,
  uploadedByName: Map<string, UploadedReleaseAsset>,
  releaseAssetUrl: (asset: ReleaseAssetSummary) => string,
): UpdaterAssetCandidate | null {
  if (isUpdaterJsonAssetName(asset.name) || isSignatureAssetName(asset.name)) {
    return null;
  }

  const uploaded = uploadedByName.get(asset.name);
  let platform: TargetPlatform | undefined;
  let arch: TargetArch | undefined;
  let format: UpdaterFormat | undefined;

  if (uploaded) {
    platform = uploaded.artifact.platform;
    arch = uploaded.artifact.arch;
    format = inferUpdaterFormat(uploaded.uploadPath, platform) ?? inferUpdaterFormat(asset.name, platform);
  } else {
    format = inferUpdaterFormat(asset.name);
    platform = inferPlatformFromAssetName(asset.name, format);
    arch = inferArchFromAssetName(asset.name);
    if (platform && !format) {
      format = inferUpdaterFormat(asset.name, platform);
    }
  }

  if (!platform || !arch || !format || !isUpdaterFormat(format)) {
    return null;
  }

  if (!SUPPORTED_UPDATER_FORMATS.has(format)) {
    return null;
  }

  return {
    assetName: asset.name,
    url: releaseAssetUrl(asset),
    platform: toUpdaterPlatformName(platform),
    arch,
    format,
  };
}

function resolveGithubApiBaseUrl(githubBaseUrl?: string): string {
  const configured = trimToString(githubBaseUrl) || trimToString(process.env.GITHUB_API_URL);
  const base = configured || 'https://api.github.com';
  return base.replace(/\/+$/, '');
}

async function downloadReleaseAssetText(params: {
  asset: ReleaseAssetSummary;
  token: string;
  owner: string;
  repo: string;
  githubBaseUrl?: string;
}): Promise<string> {
  const { asset, token, owner, repo, githubBaseUrl } = params;
  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': 'makepad-packaging-action',
  };
  if (trimToString(token)) {
    headers.Authorization = `Bearer ${token}`;
  }

  const apiBase = resolveGithubApiBaseUrl(githubBaseUrl);
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const apiUrl = `${apiBase}/repos/${encodedOwner}/${encodedRepo}/releases/assets/${asset.id}`;
  const apiResponse = await fetch(apiUrl, {
    method: 'GET',
    headers,
    redirect: 'follow',
  });

  if (apiResponse.ok) {
    return apiResponse.text();
  }

  const fallbackResponse = await fetch(asset.browser_download_url, {
    method: 'GET',
    headers,
    redirect: 'follow',
  });
  if (!fallbackResponse.ok) {
    throw new Error(
      `Failed to download release asset via API (${apiResponse.status} ${apiResponse.statusText}) and browser URL (${fallbackResponse.status} ${fallbackResponse.statusText}).`,
    );
  }
  return fallbackResponse.text();
}

export async function uploadUpdaterJson(params: {
  token: string;
  releaseId: number;
  appVersion?: string;
  releaseTagName?: string | null;
  releaseBody?: string | null;
  releaseCreatedAt?: string | null;
  uploadedAssets?: UploadedReleaseAsset[];
  retryAttempts?: number;
  owner?: string;
  repo?: string;
  githubBaseUrl?: string;
}): Promise<void> {
  const {
    token,
    releaseId,
    appVersion,
    releaseTagName,
    releaseBody,
    releaseCreatedAt,
    uploadedAssets,
    retryAttempts = 0,
  } = params;

  const octokit = getOctokitClient(token, params.githubBaseUrl);
  const { owner, repo } = resolveReleaseRepositoryContext(params);
  const release = await octokit.rest.repos.getRelease({
    owner,
    repo,
    release_id: releaseId,
  });
  const resolvedReleaseTag = normalizeTagName(
    trimToString(releaseTagName) || trimToString(release.data.tag_name),
  );
  if (release.data.draft) {
    core.warning(
      `Release id=${releaseId} is draft. Asset URLs in updater JSON are prepared for tag "${resolvedReleaseTag || '(missing-tag)'}" and will be publicly downloadable only after publishing the release.`,
    );
  }
  const releaseAssetUrl = (asset: ReleaseAssetSummary): string =>
    buildReleaseAssetDownloadUrl(owner, repo, resolvedReleaseTag, asset.name) ??
    asset.browser_download_url;

  const releaseAssets = await listReleaseAssets(octokit, owner, repo, releaseId);
  const releaseAssetByName = new Map(releaseAssets.map((asset) => [asset.name, asset]));
  const uploadedByName = new Map((uploadedAssets ?? []).map((asset) => [asset.name, asset]));

  let existingPlatforms: Record<string, UpdaterPlatformEntry> = {};
  let existingVersion: string | undefined;
  let existingNotes: string | undefined;
  let existingPubDate: string | undefined;

  const existingUpdaterAsset = releaseAssetByName.get(UPDATER_JSON_ASSET_NAME);
  if (existingUpdaterAsset) {
    try {
      const existingText = await downloadReleaseAssetText({
        asset: existingUpdaterAsset,
        token,
        owner,
        repo,
        githubBaseUrl: params.githubBaseUrl,
      });
      const parsed = JSON.parse(existingText) as Record<string, unknown>;
      existingVersion = trimToString(parsed.version);
      existingNotes = trimToString(parsed.notes);
      existingPubDate = trimToString(parsed.pub_date);
      existingPlatforms = normalizeUpdaterPlatforms(parsed.platforms);
    } catch (error) {
      core.warning(`Failed to parse existing ${UPDATER_JSON_ASSET_NAME}: ${(error as Error).message}`);
    }
  }

  const candidates = releaseAssets
    .map((asset) => buildUpdaterCandidateFromReleaseAsset(asset, uploadedByName, releaseAssetUrl))
    .filter((candidate): candidate is UpdaterAssetCandidate => Boolean(candidate));

  if (candidates.length === 0) {
    core.warning(`No release assets were mappable for updater JSON on release id=${releaseId}; skipping.`);
    return;
  }

  const signatureByAssetName = new Map<string, ReleaseAssetSummary>();
  for (const asset of releaseAssets) {
    if (!isSignatureAssetName(asset.name)) continue;
    const baseName = asset.name.slice(0, -'.sig'.length);
    if (!baseName) continue;
    signatureByAssetName.set(baseName, asset);
  }

  const signatureCache = new Map<string, string | undefined>();
  const getSignatureForAsset = async (assetName: string): Promise<string | undefined> => {
    if (signatureCache.has(assetName)) {
      return signatureCache.get(assetName);
    }

    const signatureAsset = signatureByAssetName.get(assetName);
    if (!signatureAsset) {
      signatureCache.set(assetName, undefined);
      return undefined;
    }

    try {
      const signatureText = trimToString(
        await downloadReleaseAssetText({
          asset: signatureAsset,
          token,
          owner,
          repo,
          githubBaseUrl: params.githubBaseUrl,
        }),
      );
      const value = signatureText || undefined;
      signatureCache.set(assetName, value);
      return value;
    } catch (error) {
      core.warning(`Failed to read signature asset "${signatureAsset.name}": ${(error as Error).message}`);
      signatureCache.set(assetName, undefined);
      return undefined;
    }
  };

  const baseEntries = new Map<string, { priority: number; entry: UpdaterPlatformEntry }>();

  for (const candidate of candidates) {
    if (!candidate.format) {
      continue;
    }
    const requiresSignature = !isMobileUpdaterPlatform(candidate.platform);
    const signature = await getSignatureForAsset(candidate.assetName);
    if (requiresSignature && !signature) {
      core.warning(
        `Skipping updater entry for "${candidate.assetName}" because no signature asset was available.`,
      );
      continue;
    }

    const entry: UpdaterPlatformEntry = {
      url: candidate.url,
      format: candidate.format,
    };
    if (signature) {
      entry.signature = signature;
    }

    const baseKey = `${candidate.platform}-${candidate.arch}`;
    const priority = getUpdaterFormatPriority(
      candidate.platform,
      candidate.format,
    );
    const existing = baseEntries.get(baseKey);
    if (!existing || priority < existing.priority) {
      baseEntries.set(baseKey, { priority, entry });
    }
  }

  const platforms: Record<string, UpdaterPlatformEntry> = { ...existingPlatforms };
  for (const [key, value] of baseEntries) {
    platforms[key] = value.entry;
  }
  if (Object.keys(platforms).length === 0) {
    core.warning(`No valid signed updater entries remained for release id=${releaseId}; skipping latest.json upload.`);
    return;
  }

  const payload: UpdaterJsonDocument = {
    version: resolveUpdaterVersion(appVersion, releaseTagName, existingVersion),
    notes: trimToString(releaseBody) || existingNotes || 'Draft release, will be updated later.',
    pub_date: trimToString(releaseCreatedAt) || existingPubDate || new Date().toISOString(),
    platforms,
  };

  const encoded = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const maxAttempts = Math.max(2, Math.trunc(retryAttempts) + 1);
  await retry(async () => {
    const currentAssets = await listReleaseAssets(octokit, owner, repo, releaseId);
    const staleUpdaterAsset = currentAssets.find((asset) => isUpdaterJsonAssetName(asset.name));
    if (staleUpdaterAsset) {
      try {
        await octokit.rest.repos.deleteReleaseAsset({
          owner,
          repo,
          asset_id: staleUpdaterAsset.id,
        });
        core.info(`Replaced existing updater JSON asset "${UPDATER_JSON_ASSET_NAME}".`);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404) {
          throw error;
        }
      }
    }

    try {
      await octokit.rest.repos.uploadReleaseAsset({
        owner,
        repo,
        release_id: releaseId,
        name: UPDATER_JSON_ASSET_NAME,
        data: encoded as unknown as string,
        headers: {
          'content-type': 'application/json',
          'content-length': encoded.byteLength,
        },
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 422) {
        throw new Error('latest.json upload conflict, retrying...');
      }
      throw error;
    }
  }, maxAttempts, 600, (attempt, error) => {
    core.warning(
      `latest.json upload attempt ${attempt}/${maxAttempts} failed: ${(error as Error).message}`,
    );
  });

  core.info(
    `Uploaded updater JSON asset "${UPDATER_JSON_ASSET_NAME}" with ${Object.keys(platforms).length} platform entry(ies).`,
  );
}
