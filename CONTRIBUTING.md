# Contributing

Bug reports, workflow examples and PRs are all welcome. Before you touch anything, read the
next section, since it is the one thing that trips up every newcomer to this repo.

## `dist/index.js` is what actually runs

`action.yaml` points `runs.main` at `dist/index.js`, so GitHub executes the committed bundle,
not your TypeScript. **Editing `src/` without rebuilding ships literally nothing**: the job
keeps running the old code and your change is invisible. Every source change needs a rebuilt
`dist/index.js` committed alongside it.

There is no CI in this repo, so nothing catches a stale bundle for you.

## Prerequisites

- Node. The action itself runs on GitHub's `node24` runtime, so keep the bundle compatible
  with Node 24.
- `bun` (`packageManager` pins `bun@1.1.30`) or npm. Either works. Only `bun.lock` is tracked,
  so do not commit a `package-lock.json` if you use npm.

## Build loop

```bash
bun install && bun run build   # or: npm install && npm run build
```

`build` is `ncc build src/index.ts -o dist -m`, which bundles the entry point and every
runtime dependency into a single minified `dist/index.js`.

The loop for any change:

1. Edit `src/`.
2. Typecheck with `npx tsc --noEmit`. Always pass `--noEmit`: `tsconfig.json` sets
   `outDir: dist`, so a bare `tsc` emits over the bundle.
3. Rebuild.
4. `git add dist/index.js` and commit it in the same commit as the source change.

The build is deterministic, so if `git diff --stat dist/` is empty after a rebuild, your edit
did not change the bundle. That is a useful sanity check that you rebuilt the right thing.

There is no test suite and no linter configured, so the typecheck plus a real workflow run is
the whole safety net. `tsconfig.json` is `strict`, so keep it clean.

## Repo layout

- `src/index.ts`: the entry point. Resolves inputs and env, then runs build, `.deb`
  verification, release upload, and TestFlight upload in that order.
- `src/build.ts`: picks the desktop or mobile path from the resolved target.
- `src/builds/desktop/`: the `cargo-packager` + `robius-packaging-commands` path. `index.ts`
  dispatches on target platform to `linux.ts`, `macos.ts` and `windows.ts`, which are thin
  wrappers, so nearly all of the real work (tool install, packaging, artifact collection)
  lives in `common.ts`. Start there.
- `src/builds/mobile/`: the `cargo-makepad` path. `index.ts` installs `cargo-makepad` at the
  revision your app's `Cargo.lock` pins for `makepad-widgets`, `android.ts` builds APKs,
  `ios/index.ts` builds the `.app` bundle and an optional `.ipa`, and `ios/testflight.ts`
  does the upload.
- `src/release/index.ts`: everything GitHub Release. Create or look up a release, clean up
  duplicates from concurrent matrix jobs, upload assets, and merge `latest.json`.
- `src/verify.ts`: runs `robius-packaging-commands verify-deb` on built `.deb`s before upload.
- `src/config.ts`, `src/utils.ts`, `src/types.d.ts`: mobile packaging config derived from
  `Cargo.toml`, shared helpers (command exec, retry, manifest parsing, target triple parsing),
  and shared types.

Docs live in `README.md` with a Chinese translation in `README_zh.md`, and copy-paste
workflows live in `examples/`.

## Releasing

Releases are cut by hand, roughly like this:

- Bump `version` in `package.json` in the same commit as the change, with `dist/` rebuilt.
- Use the repo's conventional-commit subject style, scoped, with the bump named in the
  subject. Recent examples:

  ```
  feat(tools): match `cargo-makepad` to the app's makepad rev, bump to v1.7.0
  fix(deb): set up apt-file so dlopen'd libs resolve on CI. Bump to v1.6.2
  ```

- Update the exact `@vX.Y.Z` pins in `README.md`, `README_zh.md` and `examples/`.
- Tag `vX.Y.Z`, then move the floating `v1` tag onto the same commit, because the README tells
  users `@v1` follows the newest v1.x release.
