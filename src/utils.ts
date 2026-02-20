import os from "os";
import { execSync, spawn } from "child_process";
import type { DesktopBuildDependencies, MobileTarget, TargetArch, TargetInfo, TargetPlatform, TargetPlatformType } from "./types";
import which from 'which';
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { JsonMap, parse as parseToml } from '@iarna/toml';

/**
 * Resolve target platform/architecture from a Rust target triple or host defaults.
 */
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

    if (triple.includes('ohos') || triple.includes('openharmony')) {
      throw new Error(
        'OpenHarmony packaging is currently not supported by this action.',
      );
    }

    if (triple.includes('-')) {
      // cargo target triples always start with arch.
      arch = triple.split('-')[0] as TargetArch;
      const supported_arches: TargetArch[] = ['x86_64', 'aarch64', 'armv7', 'i686'];
      if (!supported_arches.includes(arch)) {
        throw new Error(`Unsupported target architecture: ${arch}`);
      }
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

export function isCommandAvailable(command: string): { installed: boolean; path?: string } {
  try {
    const cmdPath = which.sync(command);
    return { installed: true, path: cmdPath };
  } catch {
    return { installed: false };
  }
}

/**
 * Spawn a command and optionally capture output for downstream parsing.
 */
export function execCommand(
  cmd: string,
  args: string[] = [],
  options: { captureOutput?: boolean; keyword?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; output: string; matched: boolean }> {
  return new Promise((resolve, reject) => {
    let output = '';
    let matched = false;

    const child = spawn(cmd, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: options.env ?? process.env,
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
        const error = new Error(`${cmd} exited with code ${code}`) as Error & {
          output?: string;
          exitCode?: number;
        };
        if (options.captureOutput) {
          error.output = output;
        }
        error.exitCode = code ?? undefined;
        reject(error);
      }
    });
  });
}

/**
 * Retry a function with fixed delay.
 */
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

/**
 * Parse Cargo.toml under the given project path.
 */
export function parse_manifest_toml(path: string): JsonMap | null {
  try {
    const contents = readFileSync(join(path, 'Cargo.toml')).toString();
    const config = parseToml(contents);
    return config;
  } catch (e) {
    // @ts-expect-error
    const msg = e.message;
    console.error('Error parsing Cargo.toml:', msg);
    return null;
  }
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isWorkspaceFieldRef(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.workspace === true;
}

function resolveWorkspacePackageField(
  startPath: string,
  field: 'name' | 'version',
): string | undefined {
  let dir = resolve(startPath);

  while (true) {
    const manifestPath = join(dir, 'Cargo.toml');
    if (existsSync(manifestPath)) {
      const manifest = parse_manifest_toml(dir) as Record<string, unknown> | null;
      const workspace = manifest?.workspace as Record<string, unknown> | undefined;
      const workspacePackage = workspace?.package as Record<string, unknown> | undefined;
      const resolvedField = toNonEmptyString(workspacePackage?.[field]);
      if (resolvedField) {
        return resolvedField;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return undefined;
}

export function resolveManifestPackageField(
  path: string,
  field: 'name' | 'version',
): string | undefined {
  const manifest = parse_manifest_toml(path) as Record<string, unknown> | null;
  const packageTable = manifest?.package as Record<string, unknown> | undefined;
  const directField = toNonEmptyString(packageTable?.[field]);
  if (directField) {
    return directField;
  }

  if (isWorkspaceFieldRef(packageTable?.[field])) {
    return resolveWorkspacePackageField(path, field);
  }

  return undefined;
}

/**
 * Convert arbitrary input to a trimmed string.
 */
export function trimToString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

/**
 * Normalize string-like inputs and collapse empty values to undefined.
 */
export function normalizeInput(value?: string): string | undefined {
  const trimmed = trimToString(value);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read and normalize an environment variable.
 */
export function getEnvValue(name: string): string | undefined {
  return normalizeInput(process.env[name]);
}

/**
 * Parse common truthy environment values.
 */
export function parseEnvBool(value?: string): boolean {
  const normalized = trimToString(value).toLowerCase();
  if (!normalized) return false;
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function looksLikePemPrivateKey(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(value);
}

function decodeBase64Utf8(value: string, envName: string): string {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized) {
    throw new Error(`${envName} is set but empty after trimming whitespace.`);
  }

  const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim();
  if (!decoded) {
    throw new Error(`${envName} is not valid base64 content.`);
  }
  return decoded;
}

function tryDecodePemFromBase64(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    return undefined;
  }

  const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim();
  if (!decoded || !looksLikePemPrivateKey(decoded)) {
    return undefined;
  }

  return decoded;
}

export function resolveAppStoreConnectApiKey(): string | undefined {
  const key_content_base64 = getEnvValue('APP_STORE_CONNECT_API_KEY_CONTENT_BASE64');
  const key_base64 = getEnvValue('APP_STORE_CONNECT_API_KEY_BASE64');
  const explicit_base64_name = key_content_base64
    ? 'APP_STORE_CONNECT_API_KEY_CONTENT_BASE64'
    : key_base64
      ? 'APP_STORE_CONNECT_API_KEY_BASE64'
      : undefined;
  const explicit_base64 = key_content_base64 ?? key_base64;

  if (explicit_base64_name && explicit_base64) {
    const decoded = decodeBase64Utf8(explicit_base64, explicit_base64_name);
    if (!looksLikePemPrivateKey(decoded)) {
      throw new Error(`${explicit_base64_name} did not decode to a valid PEM private key.`);
    }
    return decoded;
  }

  const direct =
    getEnvValue('APP_STORE_CONNECT_API_KEY') ??
    getEnvValue('APP_STORE_CONNECT_API_KEY_CONTENT');
  if (!direct) {
    return undefined;
  }

  if (looksLikePemPrivateKey(direct)) {
    return direct;
  }

  const auto_decoded = tryDecodePemFromBase64(direct);
  if (auto_decoded) {
    return auto_decoded;
  }

  return direct;
}

export function replaceVersion(input: string, version?: string): string {
  if (!version) return input;
  return input.replace(/__VERSION__/g, version);
}

export function normalizeTagName(tagName: string): string {
  const trimmed = trimToString(tagName);
  if (trimmed.startsWith('refs/tags/')) {
    return trimmed.slice('refs/tags/'.length);
  }
  if (trimmed.startsWith('tags/')) {
    return trimmed.slice('tags/'.length);
  }
  return trimmed;
}

export function deriveTagNameFromRef(ref?: string | null): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith('refs/tags/')) {
    return ref.slice('refs/tags/'.length);
  }
  if (ref.startsWith('tags/')) {
    return ref.slice('tags/'.length);
  }
  return undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
