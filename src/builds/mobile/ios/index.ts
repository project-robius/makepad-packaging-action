import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { randomBytes } from "crypto";
import type { Artifact, BuildOptions, TargetArch } from "../../../types";
import { execCommand, retry } from "../../../utils";

export async function installIosBuildDependencies(): Promise<void> {
  console.log('🔧 Installing iOS build dependencies...');
  await retry(async () => {
    await execCommand('cargo', ['makepad', 'apple', 'ios', 'install-toolchain']);
  }, 3, 5000, (attempt, err) => {
    console.warn(`❌ Attempt ${attempt} to install iOS toolchain failed:`, err);
    console.log('⏳ Retrying...');
  });
  console.log('✅ iOS toolchain installed successfully.');
}

export async function buildIosArtifacts(
  root: string,
  buildOptions: BuildOptions,
): Promise<Artifact[]> {
  console.log('Building iOS artifacts...');

  const {
    target_info,
    app_name,
    app_version,
    identifier,
    main_binary_name,
    mode,
    ios_org,
    ios_app,
    ios_profile,
    ios_cert,
    ios_sim,
    ios_create_ipa,
    mobile_cargo_extra_args,
    ios_cargo_extra_args,
    apple_certificate,
    apple_certificate_password,
    apple_provisioning_profile,
    apple_keychain_password,
    apple_signing_identity,
  } = buildOptions;

  if (!target_info) {
    throw new Error('Missing target info for iOS build.');
  }

  if (!main_binary_name) {
    throw new Error('Missing main binary name for iOS build.');
  }

  const resolved = resolveIosIdentifiers({
    ios_org,
    ios_app,
    identifier,
    app_name,
    main_binary_name,
  });

  let resolved_profile = ios_profile;
  let resolved_cert = ios_cert;
  let signing_cleanup: (() => Promise<void>) | undefined;

  try {

  if (!ios_sim && (!resolved_profile || !resolved_cert)) {
    const signing = await ensureIosSigning({
      ios_profile: resolved_profile,
      ios_cert: resolved_cert,
      apple_certificate,
      apple_certificate_password,
      apple_provisioning_profile,
      apple_keychain_password,
      apple_signing_identity,
    });
    resolved_profile = signing.profile;
    resolved_cert = signing.cert;
    signing_cleanup = signing.cleanup;
  }

  if (!ios_sim && (!resolved_profile || !resolved_cert)) {
    throw new Error('ios_profile and ios_cert are required for iOS device builds.');
  }

  const cargo_args = [
    'makepad',
    'apple',
    'ios',
    `--org=${resolved.org}`,
    `--app=${resolved.app}`,
  ];

  if (resolved_profile) cargo_args.push(`--profile=${resolved_profile}`);
  if (resolved_cert) cargo_args.push(`--cert=${resolved_cert}`);
  if (!ios_sim) {
    cargo_args.push('--device=iPhone');
  }
  cargo_args.push(ios_sim ? 'run-sim' : 'run-device');
  cargo_args.push('-p', main_binary_name);
  const platform_cargo_extra_args = [
    ...(mobile_cargo_extra_args ?? []),
    ...(ios_cargo_extra_args ?? []),
  ];
  if (platform_cargo_extra_args.length > 0) {
    console.log(`Using ${platform_cargo_extra_args.length} extra iOS cargo arg(s).`);
    cargo_args.push(...platform_cargo_extra_args);
  }
  if (mode === 'release') cargo_args.push('--release');

  await execCommand('cargo', cargo_args, { cwd: root });

  const target_dir = resolveIosTargetDir(target_info.arch, ios_sim);
  const output_dir = join(root, 'target', 'makepad-apple-app', target_dir, mode ?? 'release');
  const app_bundle_name = `${resolved.app}.app`;
  const app_bundle_path = join(output_dir, app_bundle_name);

  if (!existsSync(app_bundle_path)) {
    console.warn(`⚠️  iOS app bundle not found: ${app_bundle_path}`);
  }

  const artifacts: Artifact[] = [{
    path: app_bundle_path,
    mode: mode ?? 'release',
    version: app_version ?? '0.0.0',
    platform: 'ios',
    arch: target_info.arch,
  }];

  if (ios_create_ipa) {
    if (ios_sim) {
      console.warn('⚠️  ios_create_ipa is ignored for simulator builds.');
    } else {
      if (!app_version) {
        throw new Error('app_version is required to create an IPA.');
      }
      const ipa_label = app_name ?? resolved.app;
      const ipa_name = `${ipa_label}-${app_version}-ios.ipa`;
      const payload_dir = join(output_dir, 'Payload');

      rmSync(payload_dir, { recursive: true, force: true });
      mkdirSync(payload_dir, { recursive: true });

      await execCommand('ditto', [app_bundle_name, join('Payload', app_bundle_name)], { cwd: output_dir });
      await execCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', 'Payload', ipa_name], { cwd: output_dir });

      artifacts.push({
        path: join(output_dir, ipa_name),
        mode: mode ?? 'release',
        version: app_version,
        platform: 'ios',
        arch: target_info.arch,
      });
    }
  }

  return artifacts;
  } finally {
    if (signing_cleanup) {
      try {
        await signing_cleanup();
      } catch (cleanupError) {
        console.warn(
          `Failed to clean up temporary iOS signing resources: ${(cleanupError as Error).message}`,
        );
      }
    }
  }
}

function resolveIosIdentifiers(params: {
  ios_org?: string;
  ios_app?: string;
  identifier?: string;
  app_name?: string;
  main_binary_name?: string;
}): { org: string; app: string } {
  const { ios_org, ios_app, identifier, app_name, main_binary_name } = params;

  let org = ios_org;
  let app = ios_app ?? app_name ?? main_binary_name;

  if (!org && identifier) {
    const parts = identifier.split('.').filter(Boolean);
    if (parts.length >= 2) {
      org = parts.slice(0, -1).join('.');
      if (!app) app = parts[parts.length - 1];
    }
  }

  if (!org) {
    org = 'org.makepad';
  }
  if (!app) {
    throw new Error('ios_app or app_name is required for iOS builds.');
  }

  return { org, app };
}

function resolveIosTargetDir(arch: TargetArch, ios_sim?: boolean): string {
  if (ios_sim) {
    if (arch === 'x86_64') {
      return 'x86_64-apple-ios';
    }
    if (arch === 'aarch64') {
      return 'aarch64-apple-ios-sim';
    }
    throw new Error(`Unsupported iOS simulator arch: ${arch}`);
  }

  return 'aarch64-apple-ios';
}

async function ensureIosSigning(params: {
  ios_profile?: string;
  ios_cert?: string;
  apple_certificate?: string;
  apple_certificate_password?: string;
  apple_provisioning_profile?: string;
  apple_keychain_password?: string;
  apple_signing_identity?: string;
}): Promise<{ profile?: string; cert?: string; cleanup?: () => Promise<void> }> {
  const {
    ios_profile,
    ios_cert,
    apple_certificate,
    apple_certificate_password,
    apple_provisioning_profile,
    apple_keychain_password,
    apple_signing_identity,
  } = params;

  if (ios_profile && ios_cert) {
    return { profile: ios_profile, cert: ios_cert };
  }

  if (!apple_certificate || !apple_certificate_password || !apple_provisioning_profile) {
    return { profile: ios_profile, cert: ios_cert };
  }

  const temp_root = process.env.RUNNER_TEMP ?? tmpdir();
  const nonce = randomBytes(4).toString('hex');
  const cert_path = join(temp_root, `makepad_cert_${nonce}.p12`);
  const profile_path = join(temp_root, `makepad_profile_${nonce}.mobileprovision`);
  const profile_plist_path = join(temp_root, `makepad_profile_${nonce}.plist`);
  const keychain_path = join(temp_root, `makepad_signing_${nonce}.keychain-db`);
  const keychain_password = apple_keychain_password ?? `makepad-${nonce}`;
  let installed_profile_path: string | undefined;
  let installed_profile_existed_before = false;

  const cleanup = async (): Promise<void> => {
    if (installed_profile_path && !installed_profile_existed_before) {
      rmSync(installed_profile_path, { force: true });
    }
    rmSync(cert_path, { force: true });
    rmSync(profile_path, { force: true });
    rmSync(profile_plist_path, { force: true });

    try {
      await execCommand('security', ['delete-keychain', keychain_path]);
    } catch {
      // Ignore cleanup failures; keychain may not exist yet or may already be removed.
    }
  };

  try {
    writeFileSync(cert_path, Buffer.from(apple_certificate, 'base64'));
    writeFileSync(profile_path, Buffer.from(apple_provisioning_profile, 'base64'));

    await execCommand('security', ['create-keychain', '-p', keychain_password, keychain_path]);
    await execCommand('security', ['set-keychain-settings', '-lut', '21600', keychain_path]);
    await execCommand('security', ['unlock-keychain', '-p', keychain_password, keychain_path]);
    await execCommand('security', [
      'import',
      cert_path,
      '-P',
      apple_certificate_password,
      '-A',
      '-t',
      'cert',
      '-f',
      'pkcs12',
      '-k',
      keychain_path,
    ]);
    await execCommand('security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:',
      '-k',
      keychain_password,
      keychain_path,
    ]);
    await execCommand('security', ['list-keychain', '-d', 'user', '-s', keychain_path]);

    const decoded_profile = await execCommand('security', ['cms', '-D', '-i', profile_path], { captureOutput: true });
    writeFileSync(profile_plist_path, decoded_profile.output);
    const uuid_output = await execCommand('/usr/libexec/PlistBuddy', ['-c', 'Print UUID', profile_plist_path], { captureOutput: true });
    const profile_uuid = String(uuid_output.output ?? '').trim().split('\n').pop()?.trim();

    if (!profile_uuid) {
      throw new Error('Failed to read UUID from provisioning profile.');
    }

    const profiles_dir = join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');
    mkdirSync(profiles_dir, { recursive: true });
    installed_profile_path = join(profiles_dir, `${profile_uuid}.mobileprovision`);
    installed_profile_existed_before = existsSync(installed_profile_path);
    copyFileSync(profile_path, installed_profile_path);

    const cert = await resolveSigningFingerprint(keychain_path, apple_signing_identity);

    return { profile: ios_profile ?? profile_uuid, cert: ios_cert ?? cert, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function resolveSigningFingerprint(keychainPath: string, signingIdentity?: string): Promise<string> {
  const resolved_identity = signingIdentity ?? 'Apple Distribution';
  const with_identity = await execCommand(
    'security',
    ['find-certificate', '-c', resolved_identity, '-a', '-Z', keychainPath],
    { captureOutput: true },
  );

  let fingerprint = extractFingerprint(with_identity.output);
  if (!fingerprint && signingIdentity) {
    const fallback = await execCommand('security', ['find-certificate', '-a', '-Z', keychainPath], { captureOutput: true });
    fingerprint = extractFingerprint(fallback.output);
  }

  if (!fingerprint) {
    throw new Error('Failed to determine signing certificate fingerprint.');
  }

  return fingerprint;
}

function extractFingerprint(output: string): string | undefined {
  const text = String(output ?? '');
  const match = text.match(/SHA-1 hash:\s*([A-F0-9]+)/i) || text.match(/SHA-1:\s*([A-F0-9]+)/i);
  return match?.[1]?.trim();
}
