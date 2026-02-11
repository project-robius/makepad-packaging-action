import * as core from '@actions/core';
import * as github from '@actions/github';
import stringArgv from 'string-argv';
import type { Artifact, BuildOptions, InitOptions } from './types';
import { buildProject } from './build';
import { resolve } from 'node:path';
import {
  deriveTagNameFromRef,
  getEnvValue,
  normalizeInput,
  normalizeTagName,
  parseEnvBool,
  replaceVersion,
  resolveManifestPackageField,
} from './utils';
import { uploadToTestFlight } from './builds/mobile/ios/testflight';
import {
  cleanupDuplicateReleases,
  ensureRelease,
  getReleaseById,
  uploadReleaseAssets,
} from './release';


/**
 * Action entry point: parse inputs/env, build artifacts, then publish outputs/releases.
 */
async function run(): Promise<void> {
  try {
    console.log('Starting Makepad Packaging Action...');
    // 1) Resolve action inputs and environment configuration.
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
    const mobile_cargo_extra_args = stringArgv(getEnvValue('MAKEPAD_MOBILE_CARGO_EXTRA_ARGS') ?? '');
    const android_cargo_extra_args = stringArgv(getEnvValue('MAKEPAD_ANDROID_CARGO_EXTRA_ARGS') ?? '');

    const ios_org = getEnvValue('MAKEPAD_IOS_ORG');
    const ios_app = getEnvValue('MAKEPAD_IOS_APP');
    const ios_profile = getEnvValue('MAKEPAD_IOS_PROFILE');
    const ios_cert = getEnvValue('MAKEPAD_IOS_CERT');
    const ios_sim = parseEnvBool(getEnvValue('MAKEPAD_IOS_SIM') ?? 'false');
    let ios_create_ipa = parseEnvBool(getEnvValue('MAKEPAD_IOS_CREATE_IPA') ?? 'false');
    const ios_upload_testflight = parseEnvBool(getEnvValue('MAKEPAD_IOS_UPLOAD_TESTFLIGHT') ?? 'false');
    const ios_cargo_extra_args = stringArgv(getEnvValue('MAKEPAD_IOS_CARGO_EXTRA_ARGS') ?? '');
    const app_store_connect_api_key =
      getEnvValue('APP_STORE_CONNECT_API_KEY') ??
      getEnvValue('APP_STORE_CONNECT_API_KEY_CONTENT');
    const app_store_connect_key_id = getEnvValue('APP_STORE_CONNECT_KEY_ID');
    const app_store_connect_issuer_id = getEnvValue('APP_STORE_CONNECT_ISSUER_ID');

    const apple_certificate = getEnvValue('APPLE_CERTIFICATE');
    const apple_certificate_password = getEnvValue('APPLE_CERTIFICATE_PASSWORD');
    const apple_provisioning_profile = getEnvValue('APPLE_PROVISIONING_PROFILE');
    const apple_keychain_password = getEnvValue('APPLE_KEYCHAIN_PASSWORD');
    const apple_signing_identity = getEnvValue('APPLE_SIGNING_IDENTITY');

    const tag_name_input_raw = normalizeInput(core.getInput('tagName'));
    const tag_name_from_ref = deriveTagNameFromRef(github.context.ref);
    const tag_name_input = tag_name_input_raw ?? tag_name_from_ref;
    if (!tag_name_input_raw && tag_name_from_ref) {
      core.info(`tagName not provided; using ref tag "${tag_name_from_ref}".`);
    }
    const release_name_input = normalizeInput(core.getInput('releaseName'));
    const release_body_input = normalizeInput(core.getInput('releaseBody'));
    const release_id_input = normalizeInput(core.getInput('releaseId'));
    const asset_name_template = normalizeInput(core.getInput('asset_name_template'));
    const asset_prefix = normalizeInput(core.getInput('asset_prefix'));
    const release_draft = core.getBooleanInput('releaseDraft');
    const prerelease = core.getBooleanInput('prerelease');
    const github_token = normalizeInput(core.getInput('github_token')) || process.env.GITHUB_TOKEN || '';
    core.info(`Project path: ${projectPath}`);
    core.info(`Build modes enabled -> release=${include_release}, debug=${include_debug}`);
    if (args.length > 0) {
      core.info(`Build args provided: ${args.length} token(s).`);
    }
    if (mobile_cargo_extra_args.length > 0) {
      core.info(`MAKEPAD_MOBILE_CARGO_EXTRA_ARGS enabled: ${mobile_cargo_extra_args.length} token(s).`);
    }
    if (android_cargo_extra_args.length > 0) {
      core.info(`MAKEPAD_ANDROID_CARGO_EXTRA_ARGS enabled: ${android_cargo_extra_args.length} token(s).`);
    }
    if (ios_cargo_extra_args.length > 0) {
      core.info(`MAKEPAD_IOS_CARGO_EXTRA_ARGS enabled: ${ios_cargo_extra_args.length} token(s).`);
    }

    if (ios_upload_testflight) {
      if (ios_sim) {
        throw new Error('MAKEPAD_IOS_UPLOAD_TESTFLIGHT requires a device build; set MAKEPAD_IOS_SIM=false.');
      }
      if (!app_store_connect_api_key || !app_store_connect_key_id || !app_store_connect_issuer_id) {
        throw new Error(
          'TestFlight upload requires APP_STORE_CONNECT_API_KEY(_CONTENT), APP_STORE_CONNECT_KEY_ID, and APP_STORE_CONNECT_ISSUER_ID.'
        );
      }
      if (!ios_create_ipa) {
        ios_create_ipa = true;
        core.info('MAKEPAD_IOS_UPLOAD_TESTFLIGHT enabled; forcing MAKEPAD_IOS_CREATE_IPA=true.');
      }
    }

    const has_release_id = Boolean(release_id_input);
    const release_id = has_release_id ? Number(release_id_input) : undefined;
    if (has_release_id && (!Number.isInteger(release_id) || (release_id as number) <= 0)) {
      throw new Error('releaseId must be a positive integer.');
    }

    const build_options: BuildOptions = {
      args,
      packager_args: packager_args.length ? packager_args : undefined,
      packager_formats: packager_formats.length ? packager_formats : undefined,
      mobile_cargo_extra_args: mobile_cargo_extra_args.length ? mobile_cargo_extra_args : undefined,
      android_cargo_extra_args: android_cargo_extra_args.length ? android_cargo_extra_args : undefined,
      ios_cargo_extra_args: ios_cargo_extra_args.length ? ios_cargo_extra_args : undefined,
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

    const resolved_app_name = app_name || resolveManifestPackageField(projectPath, 'name');
    const resolved_app_version = app_version || resolveManifestPackageField(projectPath, 'version');
    core.info(
      `Resolved app metadata -> name=${resolved_app_name ?? '(unknown)'}, version=${resolved_app_version ?? '(unknown)'}`,
    );


    const release_artifacts: Artifact[] = [];
    const debug_artifacts: Artifact[] = [];

    // 2) Build artifacts.
    if (include_release) {
      core.info('Starting release build...');
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
      core.info('Starting debug build...');
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
    core.info(
      `Build completed. release_artifacts=${release_artifacts.length}, debug_artifacts=${debug_artifacts.length}, total=${artifacts.length}`,
    );

    if (resolved_app_name) {
      core.setOutput('app_name', resolved_app_name);
    }
    if (resolved_app_version) {
      core.setOutput('app_version', resolved_app_version);
    }
    core.setOutput('artifacts', JSON.stringify(artifacts));

    const release_metadata_provided = Boolean(
      release_name_input || release_body_input || release_draft || prerelease
    );
    if (!tag_name_input && !has_release_id && release_metadata_provided) {
      core.warning('Release inputs provided without tagName; release upload skipped.');
    }

    // 3) Publish release artifacts when configured.
    if (has_release_id) {
      const releaseId = release_id as number;
      if (!github_token) {
        throw new Error('GITHUB_TOKEN (or github_token input) is required for release upload.');
      }
      core.info(`Release mode: upload to existing release id=${releaseId}.`);

      if (tag_name_input_raw || release_name_input || release_body_input) {
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
        core.info(`Uploading ${artifacts.length} artifact(s) to release id=${releaseId}...`);
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
      core.info(`Release mode: ensured release id=${release.id} for tag=${resolved_tag}.`);

      core.setOutput('release_url', release.html_url);

      if (artifacts.length > 0) {
        core.info(`Uploading ${artifacts.length} artifact(s) to release id=${release.id}...`);
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

    // 4) Optional post-build delivery.
    if (ios_upload_testflight) {
      core.info('TestFlight upload enabled; uploading IPA...');
      await uploadToTestFlight({
        artifacts,
        apiKey: app_store_connect_api_key as string,
        keyId: app_store_connect_key_id as string,
        issuerId: app_store_connect_issuer_id as string,
      });
    }

    if (artifacts.length === 0) {
      console.log('No artifacts were built.');
      return;
    }

    console.log(`Found artifacts:\n${artifacts.map((a) => a.path).join('\n')}`);

  } catch (error) {
    if (error instanceof Error) {
      core.error(error.stack ?? error.message);
      core.setFailed(error.message);
      return;
    }
    const fallback = String(error);
    core.error(fallback);
    core.setFailed(fallback);
  }
}

await run();
