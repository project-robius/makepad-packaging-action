import os from "os";
import { execSync, spawn } from "child_process";
import type { DesktopBuildDependencies, MobileTarget, TargetArch, TargetInfo, TargetPlatform, TargetPlatformType } from "./types";
import which from 'which';
import { readFileSync } from "fs";
import { join } from "path";
import { JsonMap, parse as parseToml } from '@iarna/toml';

export function getTargetInfo(triple?: string): TargetInfo {
  let target_platform: TargetPlatform = 
    process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos'
    : 'linux';
  let host_platform: TargetPlatform = target_platform;
  let type: TargetPlatformType = 'desktop';
  let arch: TargetArch = process.arch === 'x64' ? 'x86_64'
      : process.arch === 'arm64' ? 'aarch64'
      : (() => { throw new Error(`Unsupported host architecture: ${process.arch}`) })();

  if (triple) {
    if (triple.includes('android')) {
      target_platform = 'android';
      type = 'mobile';
    } else if (triple.includes('ios')) {
      target_platform = 'ios';
      type = 'mobile';
    } else if (triple.includes('windows')) {
      target_platform = 'windows';
    } else if (triple.includes('darwin') || triple.includes('macos')) {
      target_platform = 'macos';
    } else if (triple.includes('linux')) {
      target_platform = 'linux';
    }

    if (triple.includes('-')) {
      // cargo target triples always start with arch and only x86_64 and aarch64 are supported.
      arch = triple.split('-')[0] as TargetArch;
    } else {
      throw new Error(`Invalid target triple: ${triple}`);
    }

    // See README.md for more details on platform-specific considerations.
    if (target_platform === 'macos' && host_platform !== 'macos') {
      throw new Error('macOS builds are only supported on macOS hosts.');
    }

    if (target_platform === 'ios' && host_platform !== 'macos') {
      throw new Error('iOS builds are only supported on macOS hosts.');
    }

    if (target_platform === 'android' && (host_platform === 'windows' || host_platform === 'macos')) {
      console.warn(
        'Warning: Android targets are best supported on Linux hosts.'
      )
    }
  }

  console.log(`Determined target platform: ${target_platform}, architecture: ${arch}, type: ${type}`);

  return {
    target_platform,
    arch,
    type,
  }
}

// export async function checkAndInstallDesktopDependencies(): Promise<DesktopBuildDependencies> {
//   const result: DesktopBuildDependencies = {
//     cargo_packager_info: { installed: false }
//   };

//   if (!isCommandAvailable('cargo-packager')) {
//     console.log('⚙️  cargo-packager not found, installing...');

//     await retry(
//       async () => {
//         execSync('cargo +stable install --force --locked cargo-packager', { stdio: 'inherit' });
//       },
//       3,
//       2000,
//       (attempt, error) => {
//         console.warn(`❌ Install failed (attempt ${attempt}): ${error.message}`);
//         console.log('⏳ Retrying...');
//       }
//     );
//     console.log('✅ cargo-packager installed successfully.');
//   } else {
//     console.log('✅ cargo-packager already installed.');
//   }

//   // Check again and update the result
//   result.cargo_packager_info.installed = isCommandAvailable('cargo-packager');

//   if (result.cargo_packager_info.installed) {
//     try {
//       result.cargo_packager_info.path = execSync(
//         os.platform() === 'win32' ? 'where cargo-packager' : 'command -v cargo-packager',
//         { encoding: 'utf8' }
//       ).trim();
//     } catch {
//       result.cargo_packager_info.path = undefined;
//     }
//   }

//   return result;
// }

// export async function checkAndInstallMobileDependencies(mobile_target: MobileTarget): Promise<MobileBuildDependencies> {
//   const dependencies: MobileBuildDependencies = {
//     cargo_makepad_info: { installed: false, toolchain_installed: false },
//   };

//   if (!isCommandAvailable('cargo-makepad')) {
//     console.log('⚙️  cargo-makepad not found. Installing...');
//     await retry(
//       async () => {
//         await execCommand('cargo', [
//           'install',
//           '--force',
//           '--git',
//           'https://github.com/makepad/makepad.git',
//           '--branch',
//           'dev',
//           'cargo-makepad',
//         ]);
//       },
//       3,
//       2000,
//       (attempt, err) => {
//         console.warn(`❌ Attempt ${attempt} to install cargo-makepad failed:`, err);
//         console.log('⏳ Retrying...');
//       }
//     );
//     console.log('✅ cargo-makepad installed successfully.');
//     dependencies.cargo_makepad_info.installed = true;
//   } else {
//     console.log('✅ cargo-makepad already installed.');
//     dependencies.cargo_makepad_info.installed = true;
//   }

//   const toolchainCommand =
//     mobile_target === 'ios'
//       ? ['makepad', 'apple', 'ios', 'install-toolchain']
//       : ['makepad', 'android', 'install-toolchain'];

//   console.log(`🔧 Installing toolchain for ${mobile_target}...`);
//   await retry(
//     async () => {
//       await execCommand('cargo', toolchainCommand);
//     },
//     3,
//     2000,
//     (attempt, err) => {
//       console.warn(`❌ Attempt ${attempt} to install ${mobile_target} toolchain failed:`, err);
//       console.log('⏳ Retrying...');
//     }
//   );

//   dependencies.cargo_makepad_info.toolchain_installed = true;
//   console.log(`✅ ${mobile_target} toolchain installed successfully.\n`);

//   return dependencies;
// }

export function isCommandAvailable(command: string): { installed: boolean; path?: string } {
  try {
    const cmdPath = which.sync(command);
    return { installed: true, path: cmdPath };
  } catch {
    return { installed: false };
  }
}

export function execCommand(
  cmd: string,
  args: string[] = [],
  options: { captureOutput?: boolean; keyword?: string; cwd?: string } = {}
): Promise<{ code: number; output: string; matched: boolean }> {
  return new Promise((resolve, reject) => {
    let output = '';
    let matched = false;

    const child = spawn(cmd, args, {
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: options.cwd,
    });

    child.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(text);
      if (options.captureOutput) output += text;
      if (options.keyword && text.includes(options.keyword)) matched = true;
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      process.stderr.write(text);
      if (options.captureOutput) output += text;
      if (options.keyword && text.includes(options.keyword)) matched = true;
    });

    child.on('error', (err) => reject(err));

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ code: 0, output, matched });
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}

export async function retry<T>(
  fn: () => Promise<T> | T,
  retries: number = 3,
  delay: number = 1000,
  onRetry?: (attempt: number, error: any) => void
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        if (onRetry) onRetry(attempt, error);
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }
  throw lastError;
}

export function parse_manifest_toml(path: string): JsonMap | null {
  const contents = readFileSync(join(path, 'Cargo.toml')).toString();
  try {
    const config = parseToml(contents);
    return config;
  } catch (e) {
    // @ts-expect-error
    const msg = e.message;
    console.error('Error parsing Cargo.toml:', msg);
    return null;
  }
}
