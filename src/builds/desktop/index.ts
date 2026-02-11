import type { Artifact, BuildOptions, InitOptions } from "../../types";
import { getTargetInfo } from "../../utils";
import { buildLinuxDesktopArtifacts } from "./linux";
import { buildMacosDesktopArtifacts } from "./macos";
import { buildWindowsDesktopArtifacts } from "./windows";

export async function buildDesktopArtifacts(
  root: string,
  initOptions: InitOptions,
  buildOptions: BuildOptions,
): Promise<Artifact[]> {
  const target_info = buildOptions.target_info ?? getTargetInfo();

  switch (target_info.target_platform) {
    case "windows":
      return buildWindowsDesktopArtifacts(root, initOptions, buildOptions);
    case "linux":
      return buildLinuxDesktopArtifacts(root, initOptions, buildOptions);
    case "macos":
      return buildMacosDesktopArtifacts(root, initOptions, buildOptions);
    default:
      throw new Error(`Unsupported desktop target platform: ${target_info.target_platform}`);
  }
}
