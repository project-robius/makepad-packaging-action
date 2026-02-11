import * as core from '@actions/core';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Artifact } from '../../types';
import { execCommand } from '../../utils';

/**
 * Upload the release IPA artifact to TestFlight via xcrun altool.
 */
export async function uploadToTestFlight(params: {
  artifacts: Artifact[];
  apiKey: string;
  keyId: string;
  issuerId: string;
}): Promise<void> {
  const { artifacts, apiKey, keyId, issuerId } = params;
  const ipa = pickIosIpaArtifact(artifacts);
  if (!ipa) {
    throw new Error(
      'TestFlight upload requested but no .ipa artifact was built. Set MAKEPAD_IOS_CREATE_IPA=true and build for device.'
    );
  }
  if (!existsSync(ipa.path) || !statSync(ipa.path).isFile()) {
    throw new Error(`TestFlight upload failed: IPA not found at ${ipa.path}`);
  }
  core.info(`Selected IPA for TestFlight upload: ${ipa.path}`);

  const key_dir = join(homedir(), 'private_keys');
  mkdirSync(key_dir, { recursive: true });
  const key_path = join(key_dir, `AuthKey_${keyId}.p8`);
  const key_existed_before = existsSync(key_path);
  const previous_key_contents = key_existed_before ? readFileSync(key_path) : undefined;
  writeFileSync(key_path, apiKey);

  try {
    core.info(`Uploading ${basename(ipa.path)} to TestFlight...`);
    await execCommand('xcrun', [
      'altool',
      '--upload-app',
      '--type',
      'ios',
      '--file',
      ipa.path,
      '--apiKey',
      keyId,
      '--apiIssuer',
      issuerId,
      '--verbose',
    ]);
    core.info('Successfully uploaded to TestFlight.');
  } finally {
    try {
      if (key_existed_before && previous_key_contents !== undefined) {
        writeFileSync(key_path, previous_key_contents);
      } else {
        rmSync(key_path, { force: true });
      }
    } catch (cleanupError) {
      core.warning(
        `Failed to clean up App Store Connect API key file: ${(cleanupError as Error).message}`,
      );
    }
  }
}

function pickIosIpaArtifact(artifacts: Artifact[]): Artifact | undefined {
  const ipa_candidates = artifacts.filter(
    (artifact) => artifact.platform === 'ios' && artifact.path.toLowerCase().endsWith('.ipa'),
  );
  if (ipa_candidates.length === 0) {
    return undefined;
  }
  return ipa_candidates.find((artifact) => artifact.mode === 'release') ?? ipa_candidates[0];
}
