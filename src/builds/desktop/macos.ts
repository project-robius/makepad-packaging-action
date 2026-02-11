import type { Artifact, BuildOptions, InitOptions } from "../../types";
import { buildDesktopArtifactsForPlatform } from "./common";

export async function buildMacosDesktopArtifacts(
  root: string,
  initOptions: InitOptions,
  buildOptions: BuildOptions,
): Promise<Artifact[]> {
  console.log("Building desktop artifacts for macOS...");
  return buildDesktopArtifactsForPlatform(root, initOptions, buildOptions, "macos");
}
