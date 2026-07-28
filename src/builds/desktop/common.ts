import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import type { Artifact, BuildOptions, DesktopTarget, InitOptions } from "../../types";
import {
  execCommand,
  getTargetInfo,
  isCommandAvailable,
  parse_manifest_toml,
  resolveManifestPackageField,
  retry,
  sleep,
} from "../../utils";

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
    console.log(`${label} is already installed.`);
    return { installed, path };
  }

  console.log(`${label} not found, installing...`);
  await retry(async () => {
    await execCommand("cargo", installArgs);
  }, 3, 5000, (attempt, err) => {
    console.warn(`Attempt ${attempt} to install ${label} failed:`, err);
    console.log("Retrying...");
  });

  const verify = isCommandAvailable(command);
  if (!verify.installed) {
    throw new Error(`Failed to install ${label}.`);
  }

  console.log(`${label} installed successfully.`);
  return { installed: verify.installed, path: verify.path };
}

async function checkAndInstallDesktopPackagingTools(): Promise<DesktopPackagingToolsInfo> {
  const cargo_packager_info = await ensureCargoToolInstalled(
    "cargo-packager",
    "cargo-packager",
    ["install", "--force", "--locked", "cargo-packager"],
  );

  // 0.3.2 computes .deb deps with `dpkg-shlibdeps` (plus dlopen/exec detection) and
  // adds the `verify-deb` subcommand the `verify_deb` input needs. It's also the first
  // version that falls back to apt-file for a dlopen'd lib that isn't installed on the
  // build host, instead of quietly leaving the dependency out. Installed from crates.io
  // rather than git so the version is exact and immutable -- a `--git` install tracks
  // the default branch and breaks as soon as it bumps.
  const robius_packaging_commands_info = await ensureCargoToolInstalled(
    "robius-packaging-commands",
    "robius-packaging-commands",
    [
      "install",
      "--force",
      "--locked",
      "--version",
      "0.3.2",
      "robius-packaging-commands",
    ],
  );

  return {
    cargo_packager_info,
    robius_packaging_commands_info,
  };
}

function resolveDesktopDefaults(
  root: string,
  initOptions: InitOptions,
): { app_name: string; app_version: string; out_dir: string } {
  const manifest = parse_manifest_toml(root) as Record<string, any> | null;
  if (!manifest || !manifest.package) {
    throw new Error("Failed to read Cargo.toml package metadata.");
  }

  const app_name = initOptions.app_name ?? resolveManifestPackageField(root, "name");
  const app_version = initOptions.app_version ?? resolveManifestPackageField(root, "version");

  if (!app_name || !app_version) {
    throw new Error("Missing app name or version from Cargo.toml (including workspace.package inheritance).");
  }

  const out_dir = resolvePackagerOutDir(root, manifest);
  return { app_name, app_version, out_dir };
}

function resolvePackagerOutDir(root: string, manifest: Record<string, any>): string {
  const out_dir = manifest?.package?.metadata?.packager?.out_dir;
  const out_dir_text = typeof out_dir === "string" ? out_dir.trim() : "";
  if (out_dir_text.length > 0) {
    return isAbsolute(out_dir_text) ? out_dir_text : join(root, out_dir_text);
  }
  return join(root, "dist");
}

function parseTargetTripleFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--target" || arg === "-t") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        return next;
      }
    }
    if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length).trim();
      if (value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

function readBeforeEachPackageCommand(manifest: Record<string, any>): string | undefined {
  const packager = manifest?.package?.metadata?.packager as Record<string, any> | undefined;
  if (!packager) {
    return undefined;
  }
  const command =
    packager.before_each_package_command ??
    packager["before-each-package-command"];
  return typeof command === "string" ? command : undefined;
}

function parsePathToBinaryArg(command: string): string | undefined {
  const match = command.match(/--path-to-binary(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (!match) {
    return undefined;
  }
  return match[1] ?? match[2] ?? match[3];
}

function assertNoLikelyPackagerTargetMismatch(root: string, args: string[]): void {
  const targetTriple = parseTargetTripleFromArgs(args);
  if (!targetTriple) {
    return;
  }

  const manifest = parse_manifest_toml(root) as Record<string, any> | null;
  if (!manifest) {
    return;
  }

  const beforeEachCommand = readBeforeEachPackageCommand(manifest);
  if (!beforeEachCommand) {
    return;
  }

  const lowerCommand = beforeEachCommand.toLowerCase();
  const usesRobiusBeforeEach =
    lowerCommand.includes("robius-packaging-commands") &&
    (lowerCommand.includes("before-each-package") || lowerCommand.includes("before_each_package"));
  if (!usesRobiusBeforeEach) {
    return;
  }

  const pathToBinary = parsePathToBinaryArg(beforeEachCommand);
  if (!pathToBinary) {
    return;
  }

  const normalizedPath = pathToBinary.replace(/\\/g, "/").toLowerCase();
  const hasPlainReleasePath = normalizedPath.includes("/target/release/");
  const hasTargetTripleInPath = normalizedPath.includes(`/target/${targetTriple.toLowerCase()}/release/`);
  if (hasPlainReleasePath && !hasTargetTripleInPath) {
    throw new Error(
      [
        "Detected likely cargo-packager target path mismatch.",
        `You passed '--target ${targetTriple}', but package.metadata.packager.before_each_package_command uses '--path-to-binary ${pathToBinary}'.`,
        "This usually causes cargo-packager to search target/<triple>/release/<binary> while before-each-package builds into target/release/<binary>, resulting in an unclear I/O path error.",
        "Fix one of the following:",
        "1) On native runners, remove --target from action args.",
        `2) Update --path-to-binary to include target triple, e.g. ../target/${targetTriple}/release/<binary>.`,
        "3) Ensure your before-each-package build command uses the same target triple.",
      ].join("\n")
    );
  }
}

function isDesktopArtifactFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  const suffixes = [
    ".deb",
    ".rpm",
    ".appimage",
    ".dmg",
    ".pkg",
    ".exe",
    ".msi",
    ".tar.gz",
    ".zip",
  ];

  return suffixes.some((suffix) => lower.endsWith(suffix));
}

function collectDesktopArtifacts(
  outDir: string,
  mode: "debug" | "release",
  version: string,
  platform: Artifact["platform"],
  arch: Artifact["arch"],
): Artifact[] {
  if (!existsSync(outDir)) {
    console.warn(`Packaging output directory not found: ${outDir}`);
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

function hasMacosNotarizationEnv(env: NodeJS.ProcessEnv): boolean {
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return true;
  }
  if (env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID) {
    return true;
  }
  if (env.APPLE_API_KEY && env.APPLE_API_ISSUER && env.APPLE_API_KEY_PATH) {
    return true;
  }
  return false;
}

function shouldRetryMacosPackagerFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const output = (error as { output?: string } | undefined)?.output ?? "";
  const text = `${message}\n${output}`.toLowerCase();
  return text.includes("resource busy") || text.includes("create-dmg");
}

async function cleanupMacosDmgBusyState(volumeName: string, outDir: string): Promise<void> {
  try {
    const mountPath = `/Volumes/${volumeName}`;
    const info = await execCommand("hdiutil", ["info"], { captureOutput: true });
    const devices = new Set<string>();
    for (const line of info.output.split("\n")) {
      if (!line.includes(mountPath)) continue;
      const device = line.trim().split(/\s+/)[0];
      if (device?.startsWith("/dev/disk")) {
        devices.add(device);
      }
    }

    for (const device of devices) {
      try {
        console.warn(`Detaching mounted DMG device before retry: ${device}`);
        await execCommand("hdiutil", ["detach", device, "-force"]);
      } catch (detachError) {
        console.warn(`Failed to detach ${device}: ${(detachError as Error).message}`);
      }
    }
  } catch (scanError) {
    console.warn(`Failed to inspect mounted DMG devices: ${(scanError as Error).message}`);
  }

  if (!existsSync(outDir)) {
    return;
  }

  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".dmg")) continue;
    const path = join(outDir, entry.name);
    try {
      rmSync(path, { force: true });
      console.warn(`Removed stale DMG before retry: ${path}`);
    } catch (removeError) {
      console.warn(`Failed to remove stale DMG ${path}: ${(removeError as Error).message}`);
    }
  }
}

/**
 * Makes `apt-file` available before building a .deb, so the packaging tool can work out
 * which package ships a dlopen'd library.
 *
 * It normally asks the local filesystem (`ldconfig` + `dpkg -S`), which only works if the
 * library happens to be installed. A CI runner has no GPU or desktop stack, so e.g.
 * libEGL isn't there and the dependency would go missing. apt-file answers from the
 * archive's file lists instead, so it doesn't matter what's installed here.
 *
 * Best-effort: if this fails, the packaging tool still errors out with a clear message
 * rather than quietly dropping the dependency.
 */
async function ensureAptFileIndex(): Promise<void> {
  try {
    if (!isCommandAvailable("apt-file").installed) {
      console.log("apt-file not found, installing...");
      await execCommand("sudo", ["apt-get", "update", "-qq"]);
      await execCommand("sudo", ["apt-get", "install", "-y", "-qq", "apt-file"]);
    }
    // Roughly 20s and 300MB of index, which is cheap next to the build itself.
    console.log("Updating apt-file index so dlopen'd libraries can be resolved...");
    await execCommand("sudo", ["apt-file", "update"]);
  } catch (error) {
    console.warn(
      `Could not set up apt-file (${error instanceof Error ? error.message : String(error)}). ` +
      "Dependencies for dlopen'd libraries that aren't installed here may not be resolvable.",
    );
  }
}

export async function buildDesktopArtifactsForPlatform(
  root: string,
  initOptions: InitOptions,
  buildOptions: BuildOptions,
  platform: DesktopTarget,
): Promise<Artifact[]> {
  await checkAndInstallDesktopPackagingTools();

  const { app_name, app_version, out_dir } = resolveDesktopDefaults(root, initOptions);
  const target_info = buildOptions.target_info ?? getTargetInfo();
  const args = buildOptions.args ?? [];
  const packager_args = buildOptions.packager_args ?? [];
  const packager_formats = buildOptions.packager_formats ?? [];

  assertNoLikelyPackagerTargetMismatch(root, args);

  if (platform === "linux" && packager_formats.some((f) => f.toLowerCase() === "deb")) {
    await ensureAptFileIndex();
  }

  const packager_cli_args = [...args, ...packager_args];
  const has_formats_arg = packager_cli_args.some((arg) => arg.startsWith("--formats"));
  if (packager_formats.length > 0 && !has_formats_arg) {
    packager_cli_args.push("--formats", packager_formats.join(","));
  }

  const command_env: NodeJS.ProcessEnv = { ...process.env };
  let generated_notary_temp_dir: string | undefined;

  if (
    platform === "macos" &&
    buildOptions.enable_macos_notarization &&
    !hasMacosNotarizationEnv(command_env) &&
    buildOptions.app_store_connect_api_key &&
    buildOptions.app_store_connect_key_id &&
    buildOptions.app_store_connect_issuer_id
  ) {
    const tmp_prefix = join(process.env.RUNNER_TEMP ?? tmpdir(), "makepad-notary-");
    generated_notary_temp_dir = mkdtempSync(tmp_prefix);
    const private_keys_dir = join(generated_notary_temp_dir, "private_keys");
    mkdirSync(private_keys_dir, { recursive: true });
    const api_key_path = join(private_keys_dir, `AuthKey_${buildOptions.app_store_connect_key_id}.p8`);
    writeFileSync(api_key_path, buildOptions.app_store_connect_api_key, { mode: 0o600 });
    command_env.APPLE_API_KEY = buildOptions.app_store_connect_key_id;
    command_env.APPLE_API_ISSUER = buildOptions.app_store_connect_issuer_id;
    command_env.APPLE_API_KEY_PATH = api_key_path;
    console.log("Reusing APP_STORE_CONNECT_* credentials for macOS notarization.");
  }

  try {
    const maxPackagerAttempts = platform === "macos" ? 3 : 1;
    for (let attempt = 1; attempt <= maxPackagerAttempts; attempt++) {
      try {
        await execCommand("cargo", ["packager", ...packager_cli_args], {
          cwd: root,
          env: command_env,
          captureOutput: platform === "macos",
        });
        break;
      } catch (error) {
        const isLastAttempt = attempt === maxPackagerAttempts;
        if (platform !== "macos" || isLastAttempt || !shouldRetryMacosPackagerFailure(error)) {
          throw error;
        }

        console.warn(
          `cargo packager failed on macOS (attempt ${attempt}/${maxPackagerAttempts}): ${(error as Error).message}`,
        );
        console.warn("Retrying after cleaning mounted/stale DMG resources...");
        await cleanupMacosDmgBusyState(app_name, out_dir);
        await sleep(2000 * attempt);
      }
    }
  } finally {
    if (generated_notary_temp_dir) {
      rmSync(generated_notary_temp_dir, { recursive: true, force: true });
    }
  }

  const mode = buildOptions.mode ?? "release";
  const artifacts = collectDesktopArtifacts(
    out_dir,
    mode,
    app_version,
    platform,
    target_info.arch,
  );

  if (artifacts.length === 0) {
    console.warn(`No desktop artifacts found in ${out_dir}`);
  }

  return artifacts;
}
