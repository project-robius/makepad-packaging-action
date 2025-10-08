export interface BuildOptions {
  args: string[] | null;
}

export interface Artifact {
  path: string;
  mode: 'debug' | 'release';
  version: string;
}

export type MobileTarget = 'ios' | 'android';
export type DesktopTarget = 'windows' | 'linux' | 'macos';
export type TargetPlatform =  MobileTarget | DesktopTarget; // TODO: add 'wasm'
export type TargetPlatformType = 'desktop' | 'mobile'; // TODO: add 'web'
export type TargetArch = 'x86_64' | 'aarch64'; // TODO: add 'wasm32' or experimental 'wasm64'

export interface TargetInfo {
  target_platform: TargetPlatform;
  arch: TargetArch;
  type: TargetPlatformType;
}

export interface DesktopBuildDependencies {
  cargo_packager_info: {
    installed: boolean;
    path?: string;
  }
}

export interface MobileBuildDependencies {
  cargo_makepad_info: {
    installed: boolean;
    toolchain_installed: boolean;
    path?: string;
  }
}