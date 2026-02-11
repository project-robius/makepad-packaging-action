import type { Artifact, BuildOptions, InitOptions } from "../../types";
import { buildDesktopArtifactsForPlatform } from "./common";

export async function buildLinuxDesktopArtifacts(
  root: string,
  initOptions: InitOptions,
  buildOptions: BuildOptions,
): Promise<Artifact[]> {
  console.log("Building desktop artifacts for Linux...");
  return buildDesktopArtifactsForPlatform(root, initOptions, buildOptions, "linux");
}
