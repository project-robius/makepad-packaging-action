import * as core from '@actions/core';
import * as github from '@actions/github';
import stringArgv from 'string-argv';
import type { Artifact, BuildOptions, InitOptions, ManifestToml, TargetPlatform } from './types';
import { buildProject } from './build';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execCommand, parse_manifest_toml, retry } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;

type ReleaseSummary = {
  id: number;
  html_url: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  tag_name?: string | null;
  created_at?: string | null;
};


async function run(): Promise<void> {
  try {
    console.log('Starting Makepad Packaging Action...');
    const projectPath = resolve(
      process.cwd(),
      core.getInput('project_path') || process.argv[2],
    );

    const args = stringArgv(core.getInput('args'));

    const app_name = normalizeInput(core.getInput('app_name'));
    const app_version = normalizeInput(core.getInput('app_version'));
    const include_debug = core.getBooleanInput('include_debug'); // default: false
    const include_release = core.getBooleanInput('include_release'); // default: true

    const identifier = normalizeInput(core.getInput('identifier'));

    const packager_args = stringArgv(core.getInput('packager_args'));
    const packager_formats_input = core.getInput('packager_formats');
    const packager_formats = packager_formats_input
      ? packager_formats_input
          .split(',')
          .map((format) => format.trim())
          .filter(Boolean)
      : [];

    const android_abi = getEnvValue('MAKEPAD_ANDROID_ABI') ?? 'aarch64';
    const android_full_ndk = parseEnvBool(getEnvValue('MAKEPAD_ANDROID_FULL_NDK'));
    const android_variant = getEnvValue('MAKEPAD_ANDROID_VARIANT') ?? 'default';

    const ios_org = getEnvValue('MAKEPAD_IOS_ORG');
    const ios_app = getEnvValue('MAKEPAD_IOS_APP');
    const ios_profile = getEnvValue('MAKEPAD_IOS_PROFILE');
    const ios_cert = getEnvValue('MAKEPAD_IOS_CERT');
    const ios_sim = parseEnvBool(getEnvValue('MAKEPAD_IOS_SIM') ?? 'false');
    const ios_create_ipa = parseEnvBool(getEnvValue('MAKEPAD_IOS_CREATE_IPA') ?? 'false');

    const apple_certificate = getEnvValue('APPLE_CERTIFICATE');
    const apple_certificate_password = getEnvValue('APPLE_CERTIFICATE_PASSWORD');
    const apple_provisioning_profile = getEnvValue('APPLE_PROVISIONING_PROFILE');
    const apple_keychain_password = getEnvValue('APPLE_KEYCHAIN_PASSWORD');
    const apple_signing_identity = getEnvValue('APPLE_SIGNING_IDENTITY');
    const ohos_deveco_home = getEnvValue('DEVECO_HOME') ?? getEnvValue('OHOS_DEVECO_HOME');
    const ohos_signing_p12_base64 =
      getEnvValue('OHOS_P12_BASE64') ?? getEnvValue('OHOS_P12_B64');
    const ohos_signing_profile_base64 =
      getEnvValue('OHOS_PROFILE_BASE64') ?? getEnvValue('OHOS_PROFILE_B64');
    const ohos_signing_cert_base64 =
      getEnvValue('OHOS_CERT_BASE64') ?? getEnvValue('OHOS_CERT_B64');
    const ohos_signing_store_password =
      getEnvValue('OHOS_P12_PASSWORD') ?? getEnvValue('OHOS_STORE_PASSWORD');
    const ohos_signing_key_alias = getEnvValue('OHOS_KEY_ALIAS');
    const ohos_signing_key_password = getEnvValue('OHOS_KEY_PASSWORD');
    const ohos_signing_sign_alg = getEnvValue('OHOS_SIGN_ALG');

    const tag_name_input = normalizeInput(core.getInput('tagName'));
    const release_name_input = normalizeInput(core.getInput('releaseName'));
    const release_body_input = normalizeInput(core.getInput('releaseBody'));
    const release_id_input = normalizeInput(core.getInput('releaseId'));
    const asset_name_template = normalizeInput(core.getInput('asset_name_template'));
    const asset_prefix = normalizeInput(core.getInput('asset_prefix'));
    const release_draft = core.getBooleanInput('releaseDraft');
    const prerelease = core.getBooleanInput('prerelease');
    const github_token = normalizeInput(core.getInput('github_token')) || process.env.GITHUB_TOKEN || '';

    const has_release_id = Boolean(release_id_input);
    const release_id = has_release_id ? Number(release_id_input) : undefined;
    if (has_release_id && (!Number.isInteger(release_id) || (release_id as number) <= 0)) {
      throw new Error('releaseId must be a positive integer.');
    }

    const build_options: BuildOptions = {
      args,
      packager_args: packager_args.length ? packager_args : undefined,
      packager_formats: packager_formats.length ? packager_formats : undefined,
      android_abi: android_abi as BuildOptions['android_abi'],
      android_full_ndk,
      android_variant: android_variant as BuildOptions['android_variant'],
      ios_org,
      ios_app,
      ios_profile,
      ios_cert,
      ios_sim,
      ios_create_ipa,
      apple_certificate,
      apple_certificate_password,
      apple_provisioning_profile,
      apple_keychain_password,
      apple_signing_identity,
      ohos_deveco_home,
      ohos_signing_p12_base64,
      ohos_signing_profile_base64,
      ohos_signing_cert_base64,
      ohos_signing_store_password,
      ohos_signing_key_alias,
      ohos_signing_key_password,
      ohos_signing_sign_alg,
    };

    const init_options: InitOptions = {
      identifier,
      app_name,
      app_version,
    };

    const manifest = parse_manifest_toml(projectPath) as ManifestToml | null;
    const resolved_app_name = app_name || manifest?.package?.name;
    const resolved_app_version = app_version || manifest?.package?.version;


    const release_artifacts: Artifact[] = [];
    const debug_artifacts: Artifact[] = [];

    if (include_release) {
      release_artifacts.push(
        ...(await buildProject(
          projectPath,
          false,
          init_options,
          build_options,
        ))
      )
    }

    if (include_debug) {
      debug_artifacts.push(
        ...(await buildProject(
          projectPath,
          true,
          init_options,
          build_options,
        ))
      )
    }

    const artifacts = release_artifacts.concat(debug_artifacts);

    if (resolved_app_name) {
      core.setOutput('app_name', resolved_app_name);
    }
    if (resolved_app_version) {
      core.setOutput('app_version', resolved_app_version);
    }
    core.setOutput('artifacts', JSON.stringify(artifacts));

    if (!tag_name_input && !has_release_id && (release_name_input || release_body_input)) {
      core.warning('Release inputs provided without tagName; release upload skipped.');
    }

    if (has_release_id) {
      const releaseId = release_id as number;
      if (!github_token) {
        throw new Error('GITHUB_TOKEN (or github_token input) is required for release upload.');
      }

      if (tag_name_input || release_name_input || release_body_input) {
        core.info(
          'releaseId provided; tagName/releaseName/releaseBody inputs are ignored for release creation.',
        );
      }
      if (release_draft || prerelease) {
        core.info('releaseId provided; releaseDraft/prerelease inputs are ignored for release creation.');
      }

      const octokit = github.getOctokit(github_token);
      const { owner, repo } = github.context.repo;
      try {
        const release = await getReleaseById(octokit, owner, repo, releaseId);
        if (release) {
          core.setOutput('release_url', release.html_url);
        }
      } catch (error) {
        core.warning(`Failed to fetch release ${release_id_input}: ${(error as Error).message}`);
      }

      if (artifacts.length > 0) {
        await uploadReleaseAssets({
          token: github_token,
          releaseId,
          artifacts,
          assetNameTemplate: asset_name_template,
          assetPrefix: asset_prefix,
          appName: resolved_app_name,
          appVersion: resolved_app_version,
        });
      }
    } else if (tag_name_input) {
      if (!github_token) {
        throw new Error('GITHUB_TOKEN (or github_token input) is required for release upload.');
      }

      const resolved_tag_raw = replaceVersion(tag_name_input, resolved_app_version);
      const resolved_tag = normalizeTagName(resolved_tag_raw);
      if (resolved_tag !== resolved_tag_raw) {
        core.info(`Normalized tagName from "${resolved_tag_raw}" to "${resolved_tag}".`);
      }
      const resolved_release_name = release_name_input
        ? replaceVersion(release_name_input, resolved_app_version)
        : undefined;
      const release_body = release_body_input || undefined;

      const release = await ensureRelease({
        token: github_token,
        tagName: resolved_tag,
        releaseName: resolved_release_name,
        releaseBody: release_body,
        draft: release_draft,
        prerelease,
      });

      core.setOutput('release_url', release.html_url);

      if (artifacts.length > 0) {
        await uploadReleaseAssets({
          token: github_token,
          releaseId: release.id,
          artifacts,
          assetNameTemplate: asset_name_template,
          assetPrefix: asset_prefix,
          appName: resolved_app_name,
          appVersion: resolved_app_version,
        });
      }

      await cleanupDuplicateReleases({
        token: github_token,
        tagName: resolved_tag,
        keepReleaseId: release.id,
      });
    }

    if (artifacts.length === 0) {
      console.log('No artifacts were built.');
      return;
    }

    console.log(`Found artifacts:\n${artifacts.map((a) => a.path).join('\n')}`);

  } catch (error) {
    //@ts-expect-error
    core.setFailed(error.message);
  }
}

await run();

function normalizeInput(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getEnvValue(name: string): string | undefined {
  return normalizeInput(process.env[name]);
}

function parseEnvBool(value?: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function replaceVersion(input: string, version?: string): string {
  if (!version) return input;
  return input.replace(/__VERSION__/g, version);
}

function normalizeTagName(tagName: string): string {
  const trimmed = tagName.trim();
  if (trimmed.startsWith('refs/tags/')) {
    return trimmed.slice('refs/tags/'.length);
  }
  if (trimmed.startsWith('tags/')) {
    return trimmed.slice('tags/'.length);
  }
  return trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function getReleaseById(
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

async function ensureRelease(params: {
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
      return { id: resolved.id, html_url: resolved.html_url };
    }
    throw error;
  }
}

async function cleanupDuplicateReleases(params: {
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
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || undefined;
}

function normalizeAssetName(name: string): string {
  return name.trim().replace(/[\\/]+/g, '-').replace(/\s+/g, '-');
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

async function uploadReleaseAssets(params: {
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

  const filteredArtifacts = filterArtifactsForUpload(artifacts);
  if (filteredArtifacts.length !== artifacts.length) {
    core.info(`Filtered artifacts for release upload: ${filteredArtifacts.length}/${artifacts.length} selected.`);
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
    if (!existsSync(artifact.path)) {
      core.warning(`Artifact not found on disk: ${artifact.path}`);
      continue;
    }

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
    }

    const uploadStat = statSync(uploadPath);
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
