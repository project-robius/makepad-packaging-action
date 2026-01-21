import * as core from '@actions/core';
import * as github from '@actions/github';
import stringArgv from 'string-argv';
import type { Artifact, BuildOptions, InitOptions, ManifestToml } from './types';
import { buildProject } from './build';
import { basename, resolve } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { parse_manifest_toml, retry } from './utils';


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

    const tag_name_input = normalizeInput(core.getInput('tagName'));
    const release_name_input = normalizeInput(core.getInput('releaseName'));
    const release_body_input = normalizeInput(core.getInput('releaseBody'));
    const release_draft = core.getBooleanInput('releaseDraft');
    const prerelease = core.getBooleanInput('prerelease');
    const github_token = normalizeInput(core.getInput('github_token')) || process.env.GITHUB_TOKEN || '';

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

    if (!tag_name_input && (release_name_input || release_body_input)) {
      core.warning('Release inputs provided without tagName; release upload skipped.');
    }

    if (tag_name_input) {
      if (!github_token) {
        throw new Error('GITHUB_TOKEN (or github_token input) is required for release upload.');
      }

      const resolved_tag = replaceVersion(tag_name_input, resolved_app_version);
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
        });
      }
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

async function ensureRelease(params: {
  token: string;
  tagName: string;
  releaseName?: string;
  releaseBody?: string;
  draft: boolean;
  prerelease: boolean;
}): Promise<{ id: number; html_url: string }> {
  const { token, tagName, releaseName, releaseBody, draft, prerelease } = params;
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const getReleaseByTag = async (): Promise<{ id: number; html_url: string; name?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean } | null> => {
    try {
      const existing = await octokit.rest.repos.getReleaseByTag({
        owner,
        repo,
        tag: tagName,
      });
      return {
        id: existing.data.id,
        html_url: existing.data.html_url,
        name: existing.data.name,
        body: existing.data.body,
        draft: existing.data.draft,
        prerelease: existing.data.prerelease,
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) {
        return null;
      }
      throw error;
    }
  };

  const existing = await getReleaseByTag();
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

  try {
    const created = await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tagName,
      name: releaseName || tagName,
      body: releaseBody,
      draft,
      prerelease,
    });

    return { id: created.data.id, html_url: created.data.html_url };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 422) {
      const resolved = await retry(async () => {
        const release = await getReleaseByTag();
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

async function uploadReleaseAssets(params: {
  token: string;
  releaseId: number;
  artifacts: Artifact[];
}): Promise<void> {
  const { token, releaseId, artifacts } = params;
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const existingAssets = await octokit.rest.repos.listReleaseAssets({
    owner,
    repo,
    release_id: releaseId,
    per_page: 100,
  });
  const existingByName = new Map(
    existingAssets.data.map((asset) => [asset.name, asset.id]),
  );

  for (const artifact of artifacts) {
    if (!existsSync(artifact.path)) {
      core.warning(`Artifact not found on disk: ${artifact.path}`);
      continue;
    }

    const assetName = basename(artifact.path);
    const existingId = existingByName.get(assetName);
    if (existingId) {
      await octokit.rest.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: existingId,
      });
    }

    const stat = statSync(artifact.path);
    await octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: releaseId,
      name: assetName,
      data: createReadStream(artifact.path) as unknown as string,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
      },
    });
  }
}
