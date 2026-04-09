import { existsSync } from "fs";
import { join } from "path";
import type { AndroidABI, AndroidVariant, Artifact, BuildOptions, TargetArch } from "../../types";
import { execCommand, retry } from "../../utils";

export type AndroidHostOs = 'windows_x64' | 'macos_x64' | 'macos_aarch64' | 'linux_x64';

// 'default' is the standard Android build variant, 'quest' is for Oculus Quest (now Meta Quest) VR devices
export interface AndroidBuildOptions {
  abi: AndroidABI;
  package_name: string;
  app_label: string;
  sdk_path?: string;
  full_ndk?: boolean; // Install the full NDK prebuilts for the selected host OS (default installs a minimal subset). Required for apps compiling native code in Rust.
  keep_sdk_sources?: boolean; // Keep downloaded SDK source files (default is to remove them).
  host_os?: AndroidHostOs;
  variant?: AndroidVariant;
}

export interface AndroidPackagingConfig {
  identifier: string; // e.g., com.example.makepadapp
  product_name: string; // e.g., MakepadApp
  version: string; // e.g., 1.0.0
  main_binary_name: string; // e.g., makepad_app
}

export async function installAndroidBuildDependencies(abi: AndroidABI, fullNdk: boolean = false) {
  console.log(`🔧 Installing Android build dependencies for ABI: ${abi}...`);
  let installed = false;

  await retry(async () => {
    const args = [
      'makepad',
      'android',
      `--abi=${abi}`,
      'install-toolchain',
    ];

    if (fullNdk) {
      args.push('--full-ndk');
    }

    const { matched } = await execCommand(
        'cargo',
        args,
        {
          captureOutput: true,
          keyword: 'Android toolchain has been installed',
        }
      );

      if (matched) {
        installed = true;
        console.log('🎉 Android toolchain installation verified successfully.');
      } else {
        throw new Error('Android toolchain installation verification failed. Will retry...');
      }
    }, 3, 5000, (attempt, err) => {
      console.warn(`❌ Attempt ${attempt} to install Android build dependencies failed:`, err);
      console.log('⏳ Retrying...');
    }
  );

  if (!installed) {
    throw new Error('❌ Android toolchain installation did not complete successfully after retries.');
  }

  console.log(`✅ Android build dependencies for ABI '${abi}' are installed and verified.`);
}

export async function buildAndroidArtifacts(
  root: string,
  buildOptions: BuildOptions
): Promise<Artifact[]> {
  console.log('Building Android artifacts...');

  const { target_info: { arch }, app_name, app_version, identifier, main_binary_name, mode, android_abi, android_variant } = buildOptions as {
    target_info: { arch: TargetArch };
    app_name: string;
    app_version: string;
    identifier: string;
    main_binary_name: string;
    mode: 'debug' | 'release';
    mobile_cargo_extra_args?: string[];
    android_cargo_extra_args?: string[];
    android_abi?: AndroidABI;
    android_variant?: AndroidVariant;
  };

  const { value: package_identifier, changed: identifier_changed } = sanitizeAndroidPackageName(identifier);
  if (identifier_changed) {
    console.warn(`⚠️  Android package name normalized from "${identifier}" to "${package_identifier}".`);
  }

  const resolved_abi = resolveAndroidAbi(android_abi, arch);
  const variant_arg = android_variant && android_variant !== 'default'
    ? [`--variant=${android_variant}`]
    : [];
  const cargo_extra_args = [
    ...(buildOptions.mobile_cargo_extra_args ?? []),
    ...(buildOptions.android_cargo_extra_args ?? []),
  ];
  if (cargo_extra_args.length > 0) {
    console.log(`Using ${cargo_extra_args.length} extra Android cargo arg(s).`);
  }

  const apk_prefix = `${app_name}_v${app_version}_${resolved_abi}`;

  if (mode === 'debug') {
    console.log(' ⚙️  Building Android debug APK...');
    console.log(' ⚠️  WARNING - compiling a DEBUG build of the application, this creates a very slow and big app. Try adding --release for a fast, or --profile=small for a small build.');

    await execCommand('cargo', [
      'makepad',
      'android',
      `--abi=${resolved_abi}`,
      '--package-name=' + package_identifier,
      '--app-label=' + `${apk_prefix}_debug`,
      ...variant_arg,
      'build',
      '-p',
      main_binary_name,
      ...cargo_extra_args,
    ], { cwd: root });

    const apk_file_name = `${apk_prefix}_debug.apk`;
    const apk_build_path = resolveAndroidApkBuildPath(root, main_binary_name, apk_file_name);

    return [{
      path: join(apk_build_path, apk_file_name),
      mode: 'debug',
      version: app_version,
      platform: 'android',
      arch: resolved_abi,
    }]
  } else {
    console.log(' ⚙️  Building Android release APK...');
    
    await execCommand('cargo', [
      'makepad',
      'android',
      `--abi=${resolved_abi}`,
      '--package-name=' + package_identifier,
      '--app-label=' + apk_prefix,
      ...variant_arg,
      'build',
      '-p',
      main_binary_name,
      ...cargo_extra_args,
      '--release',
    ], { cwd: root });

    const apk_file_name = `${apk_prefix}.apk`;
    const apk_build_path = resolveAndroidApkBuildPath(root, main_binary_name, apk_file_name);

    return [{
      path: join(apk_build_path, apk_file_name),
      mode: 'release',
      version: app_version,
      platform: 'android',
      arch: resolved_abi,
    }];
  }
}

function resolveAndroidApkBuildPath(root: string, main_binary_name: string, apk_file_name: string): string {
  const apk_build_paths = [
    join(root, 'android', 'makepad-android-apk', main_binary_name, 'apk'),
    join(root, 'target', 'makepad-android-apk', main_binary_name, 'apk'),
  ];

  for (const apk_build_path of apk_build_paths) {
    const apk_path = join(apk_build_path, apk_file_name);
    if (existsSync(apk_path)) {
      return apk_build_path;
    }
  }

  return apk_build_paths[0];
}

function resolveAndroidAbi(requested: AndroidABI | undefined, arch: TargetArch): Exclude<AndroidABI, 'all'> {
  if (requested === 'all') {
    throw new Error('android_abi=all is not supported by this action.');
  }

  const resolved = (requested ?? arch) as Exclude<AndroidABI, 'all'>;
  const allowed: Exclude<AndroidABI, 'all'>[] = ['x86_64', 'aarch64', 'armv7', 'i686'];
  if (!allowed.includes(resolved)) {
    throw new Error(`Unsupported Android ABI: ${resolved}`);
  }

  return resolved;
}

function sanitizeAndroidPackageName(identifier: string): { value: string; changed: boolean } {
  const original = String(identifier ?? '');
  const parts = original
    .split('.')
    .map((part) => String(part).trim())
    .filter(Boolean)
    .map((part) => {
      let normalized = part.replace(/-/g, '_').replace(/[^A-Za-z0-9_]/g, '_');
      if (!normalized) {
        normalized = 'app';
      }
      if (!/^[A-Za-z]/.test(normalized)) {
        normalized = `app_${normalized}`;
      }
      return normalized.toLowerCase();
    });

  const sanitized = parts.length > 0 ? parts.join('.') : 'org.makepad.app';
  return { value: sanitized, changed: sanitized !== original };
}
