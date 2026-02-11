import { AndroidPackagingConfig } from "./builds/mobile/android";
import { parse_manifest_toml, resolveManifestPackageField } from "./utils";

export class PackagingConfig {

  android_config!: AndroidPackagingConfig;
  // ios_config?: IOSPackagingConfig; // Define iOSPackagingConfig similarly when needed
  // other mobile platform configs...

  public static fromMobilePackagingConfig(project_path: string): PackagingConfig {
    // if (existsSync(join(project_path, 'makepad-packaging.toml'))) {
    //   // Load and parse the makepad-packaging.toml file, to find the [mobile] section
    //   // TODO: Implement parsing logic, but for now, just return a dummy config
      
    //   const config = new PackagingConfig();

    //   const default_config = config.get_default_packaging_config(project_path);
    //   config.android_config = default_config.android_config;
    //   // config.ios_config = ... // Load iOS config if present
    //   return config;
    // }
    // throw new Error('Mobile packaging configuration not found.');
    const config = new PackagingConfig();
    const default_config = config.get_default_packaging_config(project_path);
    config.android_config = default_config.android_config;

    return config;
  }

  private get_default_packaging_config(project_path: string): {
    android_config: AndroidPackagingConfig;
  } {
    const manifest = parse_manifest_toml(project_path) as Record<string, unknown> | null;
    if (manifest) {
      const name = resolveManifestPackageField(project_path, 'name');
      const version = resolveManifestPackageField(project_path, 'version');
      if (!name || !version) {
        throw new Error('Could not resolve package name/version from Cargo.toml (including workspace.package inheritance).');
      }
      const identifier = `org.makepad.${name.toLowerCase()}`;
      const main_binary_name = name; // Default to package name, can be overridden by [[bin]] section if needed.
      return {
        android_config: {
          identifier,
          product_name: name,
          version,
          main_binary_name,
        }
      };
    } 

    throw new Error('Could not determine default packaging configuration from Cargo.toml');
  }

}
