import * as core from '@actions/core';
import type { Artifact } from './types';
import { execCommand, isCommandAvailable } from './utils';

const VERIFY_TOOL = 'robius-packaging-commands';

export interface VerifyDebOptions {
  /** Extra arguments forwarded to `verify-deb`, e.g. `--host` or `--image ubuntu:22.04`. */
  extraArgs: string[];
  /** When false, a verification failure warns instead of failing the job. */
  strict: boolean;
}

/**
 * Verifies that each built `.deb` declares every runtime dependency it actually uses,
 * by running `robius-packaging-commands verify-deb` on it.
 *
 * This runs *before* any artifact is uploaded, so a package with a missing dependency
 * fails the job rather than reaching a published release. Static dependency detection
 * cannot prove completeness for dlopen'd libraries or spawned programs, so this
 * empirical check is what actually gates the release.
 *
 * Throws when `strict` and any package fails; otherwise reports failures as warnings.
 */
export async function verifyDebArtifacts(
  artifacts: Artifact[],
  options: VerifyDebOptions,
): Promise<void> {
  const debs = artifacts.filter((artifact) => artifact.path.endsWith('.deb'));
  if (debs.length === 0) {
    core.info('verify_deb: no .deb artifacts were built; nothing to verify.');
    return;
  }

  const tool = isCommandAvailable(VERIFY_TOOL);
  if (!tool.installed) {
    const message =
      `verify_deb is enabled but \`${VERIFY_TOOL}\` was not found on PATH. ` +
      `Install it before this step, e.g. \`cargo install ${VERIFY_TOOL} --locked\`.`;
    if (options.strict) {
      throw new Error(message);
    }
    core.warning(`${message} Skipping verification.`);
    return;
  }

  const failures: string[] = [];
  for (const deb of debs) {
    core.startGroup(`verify-deb: ${deb.path}`);
    try {
      await execCommand(VERIFY_TOOL, ['verify-deb', '--deb', deb.path, ...options.extraArgs]);
      core.info(`verify-deb passed: ${deb.path}`);
    } catch (error) {
      // A non-zero exit means the package is missing a runtime dependency; the tool
      // has already printed the specific packages and the command that fixes them.
      failures.push(deb.path);
      core.error(
        `verify-deb failed for ${deb.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      core.endGroup();
    }
  }

  if (failures.length === 0) {
    core.info(`verify_deb: all ${debs.length} package(s) verified successfully.`);
    return;
  }

  const summary =
    `verify-deb reported dependency problems in ${failures.length} of ${debs.length} ` +
    `package(s): ${failures.join(', ')}. See the logs above for the packages to add.`;
  if (options.strict) {
    // Fail before uploading, so a broken package never reaches a release.
    throw new Error(summary);
  }
  core.warning(`${summary} Continuing because verify_strict is false.`);
}
