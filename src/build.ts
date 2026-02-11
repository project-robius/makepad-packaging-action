import { buildDesktopArtifacts } from "./builds/desktop";
import { buildMobileArtifacts, checkAndInstallMobilePackagingTools } from "./builds/mobile";
import type { Artifact, BuildOptions, InitOptions } from "./types";
import { getTargetInfo } from "./utils";

export async function buildProject(
  root: string,
  debug: boolean,
  initOptions: InitOptions,
  buildOptions: BuildOptions,
): Promise<Artifact[]> {
  const args = debug
    ? (buildOptions.args ?? [])
    : (buildOptions.args ?? []).concat(["--release"]);

  const target_triple = parseTargetTripleFromArgs(args);
  const target_info = target_triple
    ? getTargetInfo(target_triple)
    : getTargetInfo();

  buildOptions = {
    ...buildOptions,
    args,
    target_info,
    mode: debug ? "debug" : "release",
  };

  console.log(
    `======== Build Target Info ========\nTarget platform type: ${target_info.type}\nTarget platform: ${target_info.target_platform} (${target_info.arch})\n===================================`,
  );

  const target_platform_type = target_info.type;
  if (target_platform_type === "desktop") {
    return await buildDesktopArtifacts(root, initOptions, buildOptions);
  } else if (target_platform_type === "mobile") {
    await checkAndInstallMobilePackagingTools();
    return await buildMobileArtifacts(root, initOptions, buildOptions);
  } else {
    throw new Error(`Unsupported target type: ${target_platform_type}`);
  }
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
