import { PackagingConfig } from "../../config";
import type { Artifact, BuildOptions, InitOptions, MobileTarget, TargetArch } from "../../types";
import { execCommand, isCommandAvailable, retry } from "../../utils";
import { buildAndroidArtifacts, installAndroidBuildDependencies } from "./android";
import { buildIosArtifacts, installIosBuildDependencies } from "./ios";

interface MobilePackagingToolsInfo {
  cargo_makepad_info: {
    installed: boolean;
    path?: string | undefined;
  };
}

// Use Makepad official `cargo-makepad` tool for mobile packaging.
// See `cargo-makepad` for more details: https://github.com/makepad/makepad/tree/dev/tools/cargo_makepad
export async function checkAndInstallMobilePackagingTools(): Promise<MobilePackagingToolsInfo> {
  const packaging_tools_info: MobilePackagingToolsInfo = {
    cargo_makepad_info: {
      installed: false,
    },
  };

  // 1. Check `cargo-makepad` whether it is installed
  const { installed, path } = isCommandAvailable("cargo-makepad");
  if (installed) {
    console.log("cargo-makepad is already installed.");
    packaging_tools_info.cargo_makepad_info.installed = true;
    packaging_tools_info.cargo_makepad_info.path = path;
    return packaging_tools_info;
  }

  // 2. Install `cargo-makepad` if not installed
  console.log("cargo-makepad not found, installing...");
  await retry(async () => {
    await execCommand("cargo", [
      "install",
      "--force",
      "--git",
      "https://github.com/makepad/makepad.git",
      "--branch",
      "dev",
      "cargo-makepad",
    ]);
  }, 3, 5000, (attempt, err) => {
    console.warn(`Attempt ${attempt} to install cargo-makepad failed:`, err);
    console.log("Retrying...");
  });

  // 3. Verify installation
  const verify = isCommandAvailable("cargo-makepad");
  if (!verify.installed) {
    throw new Error("Failed to install cargo-makepad.");
  }

  // 4. Update packaging tools info
  console.log("cargo-makepad installed successfully.");
  packaging_tools_info.cargo_makepad_info.installed = verify.installed;
  packaging_tools_info.cargo_makepad_info.path = verify.path;

  return packaging_tools_info;
}

export async function buildMobileArtifacts(
  root: string,
  initOptions: InitOptions,
  buildOptions: BuildOptions,
): Promise<Artifact[]> {
  console.log("Building for mobile...");

  const { android_config } = PackagingConfig.fromMobilePackagingConfig(root);

  const { target_info: { target_platform, arch } } = buildOptions as {
    target_info: { target_platform: MobileTarget; arch: TargetArch };
  };

  const { app_version, app_name, identifier, main_binary_name } = initOptions;

  buildOptions.app_version = app_version ?? android_config.version;
  buildOptions.app_name = app_name ?? android_config.product_name;
  buildOptions.identifier = identifier ?? android_config.identifier;
  buildOptions.main_binary_name = main_binary_name ?? android_config.main_binary_name;

  if (target_platform === "android") {
    await installAndroidBuildDependencies(
      buildOptions.android_abi ?? arch,
      buildOptions.android_full_ndk ?? false,
    );
    return await buildAndroidArtifacts(root, buildOptions);
  }

  if (target_platform === "ios") {
    await installIosBuildDependencies();
    return await buildIosArtifacts(root, buildOptions);
  }

  return [];
}
