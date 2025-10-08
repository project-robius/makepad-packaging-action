import * as core from '@actions/core';
import stringArgv from 'string-argv';
import type { Artifact, BuildOptions } from './types';
import { buildProject } from './build';


async function run(): Promise<void> {
  try {
    const args = stringArgv(core.getInput('args'));

    const include_debug = core.getBooleanInput('include_debug'); // default: false
    const include_release = core.getBooleanInput('include_release'); // default: true

    const build_options: BuildOptions = {
      args,
    }

    const release_artifacts: Artifact[] = [];
    const debug_artifacts: Artifact[] = [];

    if (include_release) {
      release_artifacts.push(
        ...(await buildProject(
          false,
          build_options,
        ))
      )
    }

    if (include_debug) {
      debug_artifacts.push(
        ...(await buildProject(
          true,
          build_options,
        ))
      )
    }

    const artifacts = release_artifacts.concat(debug_artifacts);

    if (artifacts.length === 0) {
      console.log('No artifacts were built.');
      return;
    }

    console.log(`Found artifacts:\n${artifacts.map((a) => a.path).join('\n')}`);

  } catch (error) {
    //@ts-expect-error
    core.setFailed(error.message);
  }
}

await run();