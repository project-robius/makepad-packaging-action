export interface ManifestToml {
  package: {
    name: string;
    version: string;
  }
}

export interface BuildOptions {
  args: string[] | null;
  target_info?: TargetInfo;
  mode?: 'debug' | 'release';
  app_name?: string;
  app_version?: string;
  identifier?: string;
  main_binary_name?: string;
  packager_args?: string[];
  packager_formats?: string[];
  mobile_cargo_extra_args?: string[];
  android_cargo_extra_args?: string[];
  ios_cargo_extra_args?: string[];
  android_abi?: AndroidABI;
  android_full_ndk?: boolean;
  android_variant?: AndroidVariant;
  ios_org?: string;
  ios_app?: string;
  ios_profile?: string;
  ios_cert?: string;
  ios_sim?: boolean;
  ios_create_ipa?: boolean;
  apple_certificate?: string;
  apple_certificate_password?: string;
  apple_provisioning_profile?: string;
  apple_keychain_password?: string;
  apple_signing_identity?: string;
}

export interface InitOptions {
  identifier?: string; // e.g., com.example.makepadapp
  app_name?: string; // e.g., MakepadApp
  app_version?: string; // e.g., 1.0.0
  main_binary_name?: string; // e.g., makepad_app
}

export interface Artifact {
  path: string;
  mode: 'debug' | 'release';
  version: string;
  platform: TargetPlatform;
  arch: TargetArch;
}

export type MobileTarget = 'ios' | 'android';
export type DesktopTarget = 'windows' | 'linux' | 'macos';
export type TargetPlatform =  MobileTarget | DesktopTarget; // TODO: add 'wasm'
export type TargetPlatformType = 'desktop' | 'mobile'; // TODO: add 'web'
export type TargetArch = 'x86_64' | 'aarch64' | 'armv7' | 'i686'; // TODO: add 'wasm32' or experimental 'wasm64'
export type AndroidABI = 'all' | 'x86_64' | 'aarch64' | 'armv7' | 'i686';
export type AndroidVariant = 'default' | 'quest';

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
