import { existsSync, readdirSync } from "fs";
import { isAbsolute, join } from "path";
import { buildAndroidArtifacts, installAndroidBuildDependencies } from "./builds/android";
import { buildOhosArtifacts, installOhosBuildDependencies } from "./builds/ohos";
import { buildIosArtifacts, installIosBuildDependencies } from "./builds/ios";
import { PackagingConfig } from "./config";
import type { Artifact, BuildOptions, InitOptions, MobileTarget, TargetArch } from "./types";
import { execCommand, getTargetInfo, isCommandAvailable, parse_manifest_toml, retry } from "./utils";

export async function buildProject(
  root: string,
  debug: boolean,
  initOptions: InitOptions,
  buildOptions: BuildOptions,
): Promise<Artifact[]> {
  const args = debug
    ? (buildOptions.args ?? [])
    : (buildOptions.args ?? []).concat(['--release']);

  const target_arg_index = args.findIndex(
    (arg) => arg === '--target' || arg === '-t'
  )

  let target_triple: string | undefined;

  if (target_arg_index >= 0) {
    // Ensure that there is a value after the --target or -t argument
    const next = args[target_arg_index + 1];
    if (next && !next.startsWith('-')) {
      target_triple = next;
    }
  }

  const target_info = target_triple
    ? getTargetInfo(target_triple)
    : getTargetInfo();

  buildOptions = {
    ...buildOptions,
    args,
    target_info,
    mode: debug ? 'debug' : 'release',
  };

  console.log(`======== Build Target Info ========\nTarget platform type: ${target_info.type}\nTarget platform: ${target_info.target_platform} (${target_info.arch})\n===================================`);

  const target_platform_type = target_info.type;
  if (target_platform_type === 'desktop') {
    // Desktop build logic
    return await buildDesktopArtifacts(root, initOptions, buildOptions);
  } else if (target_platform_type === 'mobile') {
    // Check and install mobile packaging tools.
    await checkAndInstallMobilePackagingTools();
    return await buildMobileArtifacts(root, initOptions, buildOptions);
  } else {
    throw new Error(`Unsupported target type: ${target_platform_type}`);
  }
}

interface MobilePackagingToolsInfo {
  cargo_makepad_info: {
    installed: boolean;
    path?: string | undefined;
  }
}

interface DesktopPackagingToolsInfo {
  cargo_packager_info: {
    installed: boolean;
    path?: string | undefined;
  };
  robius_packaging_commands_info: {
    installed: boolean;
    path?: string | undefined;
  };
}

async function ensureCargoToolInstalled(
  command: string,
  label: string,
  installArgs: string[],
): Promise<{ installed: boolean; path?: string }> {
  const { installed, path } = isCommandAvailable(command);
  if (installed) {
    console.log(`✅ ${label} already installed.`);
    return { installed, path };
  }

  console.log(`⚙️  ${label} not found. Installing...`);
  await retry(async () => {
    await execCommand('cargo', installArgs);
  }, 3, 5000, (attempt, err) => {
    console.warn(`❌ Attempt ${attempt} to install ${label} failed:`, err);
    console.log('⏳ Retrying...');
  });

  const verify = isCommandAvailable(command);
  if (!verify.installed) {
    throw new Error(`Failed to install ${label}.`);
  }

  console.log(`✅ ${label} installed successfully.`);
  return { installed: verify.installed, path: verify.path };
}

async function checkAndInstallDesktopPackagingTools(): Promise<DesktopPackagingToolsInfo> {
  const cargo_packager_info = await ensureCargoToolInstalled(
    'cargo-packager',
    'cargo-packager',
    ['install', '--force', '--locked', 'cargo-packager'],
  );

  const robius_packaging_commands_info = await ensureCargoToolInstalled(
    'robius-packaging-commands',
    'robius-packaging-commands',
    [
      'install',
      '--force',
      '--locked',
      '--version',
      '0.2.1',
      '--git',
      'https://github.com/project-robius/robius-packaging-commands.git',
      'robius-packaging-commands',
    ],
  );

  return {
    cargo_packager_info,
    robius_packaging_commands_info,
  };
}

// Use Makepad official `cargo-makepad` tool for mobile packaging.
// See `cargo-makepad` for more details: https://github.com/makepad/makepad/tree/dev/tools/cargo_makepad
async function checkAndInstallMobilePackagingTools(): Promise<MobilePackagingToolsInfo> {
  const packaging_tools_info: MobilePackagingToolsInfo = {
    cargo_makepad_info: {
      installed: false,
    },
  };

  // 1. Check `cargo-makepad` whether it is installed
  const { installed, path } = isCommandAvailable('cargo-makepad');
  if (installed) {
    console.log('✅ cargo-makepad already installed.');
    packaging_tools_info.cargo_makepad_info.installed = true;
    packaging_tools_info.cargo_makepad_info.path = path;
    return packaging_tools_info;
  }

  // 2. Install `cargo-makepad` if not installed
  console.log('⚙️  cargo-makepad not found. Installing...');
  await retry(async () => {
    await execCommand('cargo', [
      'install',
      '--force',
      '--git',
      'https://github.com/makepad/makepad.git',
      '--branch',
      'dev',
      'cargo-makepad',
    ]);
  }, 3, 5000, (attempt, err) => {
    console.warn(`❌ Attempt ${attempt} to install cargo-makepad failed:`, err);
    console.log('⏳ Retrying...');
  });

  // 3. Verify installation
  const verify = isCommandAvailable('cargo-makepad');
  if (!verify.installed) {
    throw new Error('Failed to install cargo-makepad.');
  }

  // 4. Update packaging tools info
  console.log('✅ cargo-makepad installed successfully.');
  packaging_tools_info.cargo_makepad_info.installed = verify.installed;
  packaging_tools_info.cargo_makepad_info.path = verify.path;

  return packaging_tools_info;
}

function resolveDesktopDefaults(
  root: string,
  initOptions: InitOptions,
): { app_name: string; app_version: string; out_dir: string } {
  const manifest = parse_manifest_toml(root) as Record<string, any> | null;
  if (!manifest || !manifest.package) {
    throw new Error('Failed to read Cargo.toml package metadata.');
  }

  const app_name = initOptions.app_name ?? manifest.package.name;
  const app_version = initOptions.app_version ?? manifest.package.version;

  if (!app_name || !app_version) {
    throw new Error('Missing app name or version from Cargo.toml.');
  }

  const out_dir = resolvePackagerOutDir(root, manifest);

  return { app_name, app_version, out_dir };
}

function resolvePackagerOutDir(
  root: string,
  manifest: Record<string, any>,
): string {
  const out_dir = manifest?.package?.metadata?.packager?.out_dir;
  if (typeof out_dir === 'string' && out_dir.trim().length > 0) {
    return isAbsolute(out_dir) ? out_dir : join(root, out_dir);
  }

  return join(root, 'dist');
}

function isDesktopArtifactFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  const suffixes = [
    '.deb',
    '.rpm',
    '.appimage',
    '.dmg',
    '.pkg',
    '.exe',
    '.msi',
    '.tar.gz',
    '.zip',
  ];

  return suffixes.some((suffix) => lower.endsWith(suffix));
}

function collectDesktopArtifacts(
  outDir: string,
  mode: 'debug' | 'release',
  version: string,
  platform: Artifact['platform'],
  arch: Artifact['arch'],
): Artifact[] {
  if (!existsSync(outDir)) {
    console.warn(`⚠️  Packaging output directory not found: ${outDir}`);
    return [];
  }

  const artifacts: Artifact[] = [];
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!isDesktopArtifactFile(entry.name)) continue;
    artifacts.push({
      path: join(outDir, entry.name),
      mode,
      version,
      platform,
      arch,
    });
  }

  return artifacts;
}

async function buildDesktopArtifacts(
  root: string,
  initOptions: InitOptions,
  buildOptions: BuildOptions,
): Promise<Artifact[]> {
  console.log('Building for desktop...');

  await checkAndInstallDesktopPackagingTools();

  const { app_version, out_dir } = resolveDesktopDefaults(root, initOptions);
  const target_info = buildOptions.target_info ?? getTargetInfo();
  const args = buildOptions.args ?? [];
  const packager_args = buildOptions.packager_args ?? [];
  const packager_formats = buildOptions.packager_formats ?? [];

  const packager_cli_args = [...args, ...packager_args];
  const has_formats_arg = packager_cli_args.some((arg) => arg.startsWith('--formats'));
  if (packager_formats.length > 0 && !has_formats_arg) {
    packager_cli_args.push('--formats', packager_formats.join(','));
  }

  await execCommand('cargo', ['packager', ...packager_cli_args], { cwd: root });

  const mode = buildOptions.mode ?? 'release';
  const artifacts = collectDesktopArtifacts(
    out_dir,
    mode,
    app_version,
    target_info.target_platform,
    target_info.arch,
  );

  if (artifacts.length === 0) {
    console.warn(`⚠️  No desktop artifacts found in ${out_dir}`);
  }

  return artifacts;
}

async function buildMobileArtifacts(root: string, initOptions: InitOptions, buildOptions: BuildOptions): Promise<Artifact[]> {
  console.log('Building for mobile...');

  const { android_config } = PackagingConfig.fromMobilePackagingConfig(root);

  const { target_info: { target_platform, arch } } = buildOptions as {
    target_info: { target_platform: MobileTarget; arch: TargetArch };
  };

  const { app_version, app_name, identifier, main_binary_name } = initOptions;

  buildOptions.app_version = app_version ?? android_config.version;
  buildOptions.app_name = app_name ?? android_config.product_name;
  buildOptions.identifier = identifier ?? android_config.identifier;
  buildOptions.main_binary_name = main_binary_name ?? android_config.main_binary_name;

  if (target_platform === 'android') {
    // Ensure Android build dependencies are installed
    await installAndroidBuildDependencies(
      buildOptions.android_abi ?? arch,
      buildOptions.android_full_ndk ?? false,
    );

    return await buildAndroidArtifacts(
      root,
      buildOptions
    );
  }

  if (target_platform === 'ios') {
    await installIosBuildDependencies();
    return await buildIosArtifacts(root, buildOptions);
  }

  if (target_platform === 'ohos') {
    await installOhosBuildDependencies();
    return await buildOhosArtifacts(root, buildOptions);
  }

  return [];
}
