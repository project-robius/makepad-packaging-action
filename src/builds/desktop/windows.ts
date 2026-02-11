import type { Artifact, BuildOptions, InitOptions } from "../../types";
import { buildDesktopArtifactsForPlatform } from "./common";

export async function buildWindowsDesktopArtifacts(
  root: string,
  initOptions: InitOptions,
  buildOptions: BuildOptions,
): Promise<Artifact[]> {
  console.log("Building desktop artifacts for Windows...");
  return buildDesktopArtifactsForPlatform(root, initOptions, buildOptions, "windows");
}
