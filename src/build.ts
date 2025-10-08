import type { Artifact, BuildOptions, MobileTarget, TargetInfo } from "./types";
import { checkAndInstallDesktopDependencies, checkAndInstallMobileDependencies, getTargetInfo } from "./utils";

export async function buildProject(
  debug: boolean,
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

  console.log(`======== Build Target Info ========\nTarget platform type: ${target_info.type}\nTarget platform: ${target_info.target_platform} (${target_info.arch})`);

  if (target_info.type === 'desktop') {
    // Desktop build logic
    return await buildDesktopArtifacts();
  } else if (target_info.type === 'mobile') {
    // Mobile build logic
    return await buildMobileArtifacts(target_info.target_platform as MobileTarget);
  } else {
    throw new Error(`Unsupported target type: ${target_info.type}`);
  }
}


async function buildDesktopArtifacts(): Promise<Artifact[]> {
  const desktopDeps = await checkAndInstallDesktopDependencies();
  console.log('Desktop build dependencies:', desktopDeps);
  return [];
}

async function buildMobileArtifacts(mobile_target: MobileTarget): Promise<Artifact[]> {
  const mobileDeps = await checkAndInstallMobileDependencies(mobile_target);
  console.log('Mobile build dependencies:', mobileDeps);
  return [];
}