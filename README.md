# Makepad Packaging Action

[English](README.md) | [简体中文](README_zh.md)

Build and package a [Makepad](https://github.com/makepad/makepad) app for macOS, Windows,
Linux, Android and iOS, and optionally upload the results to a GitHub Release.

Ready-to-copy workflows live in [`examples/`](examples/).

## Contents

- [Quick start](#quick-start)
- [Packaging Details](#packaging-details)
  - [For Desktop](#for-desktop)
  - [For Mobile](#for-mobile)
  - [Platform-specific considerations](#platform-specific-considerations)
- [Action Reference](#action-reference)
  - [Goals](#goals)
  - [Inputs](#inputs)
  - [Environment variables](#environment-variables)
  - [Packaging tool versions](#packaging-tool-versions)
  - [Outputs](#outputs)
  - [How it works](#how-it-works)
  - [Behavior notes](#behavior-notes)
  - [Verifying `.deb` dependencies](#verifying-deb-dependencies)
  - [iOS (cargo-makepad) reference](#ios-cargo-makepad-reference)
  - [macOS signing and notarization convenience](#macos-signing-and-notarization-convenience)
  - [Updater signatures](#updater-signatures)
  - [Placeholder replacement](#placeholder-replacement)
  - [Release Modes](#release-modes)
  - [iOS signing convenience](#ios-signing-convenience)
  - [Example: matrix release](#example-matrix-release)
  - [Example: upload to an existing release](#example-upload-to-an-existing-release)
  - [Example: Android only](#example-android-only)
- [Development](#development)
  - [Current implementation status](#current-implementation-status)
  - [Roadmap](#roadmap)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE)

## Quick start

The action builds and packages, but it does not check out your code or install a Rust
toolchain, so a working job needs at least:

```yaml
jobs:
  package:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@stable

      # Makepad's Linux system dependencies. Not needed on macOS or Windows.
      - run: |
          sudo apt-get update
          sudo apt-get install -y libssl-dev pkg-config llvm clang libclang-dev \
            binfmt-support libxcursor-dev libx11-dev libasound2-dev libpulse-dev \
            libwayland-dev libxkbcommon-dev libegl1

      - uses: project-robius/makepad-packaging-action@v1.7.0
        with:
          packager_formats: deb
```

`@v1` also works and floats to the newest v1.x release; pin an exact tag when you want
builds to stay reproducible.

## Packaging Details

### For Desktop

[`cargo-packager`](https://github.com/crabnebula-dev/cargo-packager) and
[`robius-packaging-commands`](https://github.com/project-robius/robius-packaging-commands)
are used under the hood to create the packages. Both are installed for you; see
[Packaging tool versions](#packaging-tool-versions).

### For Mobile

[`cargo-makepad`](https://github.com/makepad/makepad/tree/dev/tools/cargo_makepad) is used
to build the mobile applications for iOS and Android platforms.

It is installed from the exact makepad revision your `Cargo.lock` pins for
`makepad-widgets`, so the build tool always matches the makepad your app depends on,
including forks. See [Packaging tool versions](#packaging-tool-versions) for the fallback
rules.

### Platform-specific considerations

Two of these are enforced: targeting macOS or iOS from a non-macOS host fails immediately.
The rest are practical limits that surface later as a build error rather than an upfront
check, and none of the checks run at all unless you pass a `--target` triple.

* Linux packages on a Linux OS machine
* Windows installer executables on a Windows OS machine
* macOS disk images / app bundles on a macOS machine (enforced)
* iOS apps on a macOS machine (enforced)
* Android, on a machine with any OS! (building on Windows or macOS logs a warning)

## Action Reference

### Goals

- One-step packaging for Makepad desktop and mobile targets
- GitHub Release upload with optional tag/name/body templating
- Sensible defaults sourced from `Cargo.toml`
- Matrix-friendly usage (pass `args` to target specific triples)

### Inputs

These inputs are already defined in `action.yaml`. Build and packaging inputs are
`snake_case`; GitHub Release inputs are `camelCase`, matching the API they wrap.

- `args`: extra build args (e.g. `--target x86_64-unknown-linux-gnu`). On desktop these are
  forwarded to `cargo packager`; on mobile only `--target` is read, to pick iOS vs Android,
  and the rest is ignored (use the `*_CARGO_EXTRA_ARGS` env vars for `cargo makepad` flags).
  `--release` is appended automatically for the release build.
- `packager_formats`: comma-separated formats for `cargo packager` (e.g. `deb,dmg,nsis`).
  Ignored if `--formats` is already present in `args` or `packager_args`. Requesting `deb`
  on Linux also triggers [apt-file setup](#verifying-deb-dependencies).
- `packager_args`: extra args passed only to `cargo packager`
- `robius_packaging_commands_version`: pin the version of `robius-packaging-commands`
  installed for desktop packaging (e.g. `0.3.3`). A pinned version is installed even if
  another one is already on PATH. When unset, an existing copy on PATH is reused as-is and
  only an absent tool is fetched, in which case the latest published version is installed.
- `verify_deb`: verify each built `.deb` declares every runtime dependency it actually uses,
  **before any artifact is uploaded** (default: `false`). See
  [Verifying `.deb` dependencies](#verifying-deb-dependencies).
- `verify_deb_args`: extra args passed to `verify-deb` (e.g. `--host`, `--image ubuntu:22.04`, `--run-secs 20`)
- `verify_strict`: when `true` (default), a failed verification fails the job and nothing is uploaded; `false` reports warnings and uploads anyway
- `tagName`: GitHub Release tag, supports `__VERSION__` placeholder. If omitted and the workflow runs on a tag ref, that tag is used.
- `releaseName`: Release title, supports `__VERSION__` placeholder
- `releaseBody`: Release body markdown
- `releaseId`: existing GitHub Release ID (uploads assets to this release and skips release
  creation). `tagName`, `releaseName`, `releaseBody`, `releaseDraft`, `prerelease` and
  `generateReleaseNotes` are all ignored when this is set.
- `releaseCommitish`: branch/commit SHA for creating tag/release (default: current commit SHA)
- `uploadUpdaterJson`: upload/update `latest.json` updater metadata asset on the release (default: `true`)
- `uploadUpdaterSignatures`: upload `.sig` files (if present next to built assets) and include signatures in `latest.json` (default: `true`)
- `retryAttempts`: additional retry attempts for release-asset/latest.json upload conflicts (default: `0`). Uploads always get at least 2 attempts, so this adds to that floor.
- `owner`: release target repository owner (default: current repo owner)
- `repo`: release target repository name (default: current repo name)
- `githubBaseUrl`: custom GitHub API base URL for GHE/self-hosted APIs (default: env `GITHUB_API_URL`, which GitHub Actions always sets)
- `generateReleaseNotes`: use GitHub generated release notes when creating a release (default: `false`)
- `releaseAssetNamePattern`: pattern naming for uploaded assets, supports `[app] [name] [version] [platform] [arch] [mode] [ext] [filename] [basename]`. Ignored, with a warning, when `asset_name_template` is also set.
- `asset_name_template`: template for asset names (`__APP__`, `__VERSION__`, `__PLATFORM__`, `__ARCH__`, `__MODE__`, `__EXT__`, `__FILENAME__`, `__BASENAME__`). Takes precedence over `releaseAssetNamePattern`.
- `asset_prefix`: optional prefix prepended to generated asset names
- `releaseDraft`: create the release as a draft (default: `false`); ignored when `releaseId` is set
- `prerelease`: mark as a prerelease (default: `false`); ignored when `releaseId` is set
- `github_token`: token for release creation/upload (defaults to env `GITHUB_TOKEN`)
- `project_path`: Makepad project root, resolved relative to the working directory (default: `.`)
- `projectPath`: alias of `project_path`; `project_path` wins if both are set
- `app_name`: override app name (auto from `Cargo.toml` if omitted)
- `app_version`: override version (auto from `Cargo.toml` if omitted)
- `identifier`: override bundle identifier. Mobile only: it becomes the Android package name
  and seeds the iOS org/app derivation. Desktop packaging ignores it and uses the identifier
  in `[package.metadata.packager]`. Defaults to `org.makepad.<crate name>`.
- `include_release`: include release build (default: `true`)
- `include_debug`: include debug build (default: `false`). Enabling both re-scans the same
  output directory, so release artifacts are collected a second time and labelled `debug`.
- `upload_to_testflight`: upload iOS IPA to TestFlight (default: `false`). OR'd with
  `MAKEPAD_IOS_UPLOAD_TESTFLIGHT`, so either one enables it and setting this to `false`
  will not switch off an upload the env var turned on.
- `enable_macos_notarization`: enable macOS APP_STORE_CONNECT -> APPLE_API credential mapping
  (default: `false`). Also OR'd with `MAKEPAD_MACOS_ENABLE_NOTARIZATION`.

### Environment variables

Mobile and signing configuration is provided via env vars only. Booleans accept
`true`/`1`/`yes`/`on` (case-insensitive); anything else is false.

- `MAKEPAD_ANDROID_ABI`: Android ABI to build (`x86_64`, `aarch64`, `armv7`, `i686`), default
  `aarch64`. This, not the `--target` triple, is what selects the ABI, so
  `--target x86_64-linux-android` still produces an `aarch64` build unless you set this.
  `all` is rejected.
- `MAKEPAD_ANDROID_FULL_NDK`: install full Android NDK (`true`/`false`), default `false`
- `MAKEPAD_ANDROID_VARIANT`: Android build variant (`default`, `quest`), default `default`
- `MAKEPAD_MOBILE_CARGO_EXTRA_ARGS`: extra args appended to both iOS and Android `cargo makepad` build commands
- `MAKEPAD_ANDROID_CARGO_EXTRA_ARGS`: extra args appended only to Android `cargo makepad` build commands

- `MAKEPAD_IOS_ORG`: iOS org identifier (e.g. `com.example`). If unset, it is derived from
  `identifier` (everything before the last dot), falling back to `org.makepad`, which will
  not match a real provisioning profile.
- `MAKEPAD_IOS_APP`: iOS app name. Falls back to `app_name`, then the crate's binary name;
  the build only fails if none of the three resolve.
- `MAKEPAD_IOS_PROFILE`: provisioning profile UUID or path (optional, auto-derived when Apple envs are set)
- `MAKEPAD_IOS_CERT`: signing certificate fingerprint (optional, auto-derived when Apple envs are set)
- `MAKEPAD_IOS_SIM`: build for iOS simulator (`true`/`false`), default `false`
- `MAKEPAD_IOS_CREATE_IPA`: create IPA from .app bundle (`true`/`false`), default `false`. Ignored for simulator builds.
- `MAKEPAD_IOS_UPLOAD_TESTFLIGHT`: upload IPA to TestFlight (`true`/`false`), default `false`
- `MAKEPAD_IOS_CARGO_EXTRA_ARGS`: extra args appended only to iOS `cargo makepad` build commands
- `APP_STORE_CONNECT_API_KEY` or `APP_STORE_CONNECT_API_KEY_CONTENT`: App Store Connect API key content (`.p8` PEM text)
- `APP_STORE_CONNECT_API_KEY_CONTENT_BASE64` (or `APP_STORE_CONNECT_API_KEY_BASE64`): base64-encoded `.p8` content (optional alternative to plain PEM text)
- `APP_STORE_CONNECT_KEY_ID`: App Store Connect key ID
- `APP_STORE_CONNECT_ISSUER_ID`: App Store Connect issuer ID
- `APPLE_CERTIFICATE`: base64-encoded Apple signing certificate (.p12)
- `APPLE_CERTIFICATE_PASSWORD`: password for the certificate
- `APPLE_PROVISIONING_PROFILE`: base64-encoded provisioning profile (.mobileprovision)
- `APPLE_KEYCHAIN_PASSWORD`: password for the temporary keychain
- `APPLE_SIGNING_IDENTITY`: signing identity common name used to locate the certificate
  (default: `Apple Distribution`). If nothing matches, the first certificate in the temporary
  keychain is used rather than failing, so a typo here signs with the wrong identity.
- `APPLE_KEYCHAIN_PROFILE`: optional notarization keychain profile for macOS `notarytool`
- `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`: optional Apple ID notarization credentials for macOS
- `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH`: optional App Store Connect notarization credentials for macOS
- `MAKEPAD_MACOS_ENABLE_NOTARIZATION`: optional env fallback for enabling APP_STORE_CONNECT -> APPLE_API credential mapping (`true`/`false`)

For faster mobile CI builds (mirroring `robrix#729`), you can pass Cargo profile overrides:

```yaml
env:
  MAKEPAD_MOBILE_CARGO_EXTRA_ARGS: >-
    --config profile.dev.opt-level=0
    --config profile.dev.debug=false
    --config profile.dev.lto=off
    --config profile.dev.strip=true
    --config profile.dev.debug-assertions=false
```

### Packaging tool versions

The action installs the tools it needs, so you do not have to add `cargo install` steps.

**`cargo-makepad`** (mobile builds only) is installed from the git repo and revision your
`Cargo.lock` pins for `makepad-widgets`, so the build tool always matches the makepad your
app compiles against, forks included. The lookup walks up from `project_path` to find the
nearest `Cargo.lock`, so workspace members work too. An already-installed `cargo-makepad` is
reused only when its revision matches; otherwise it is reinstalled. If `makepad-widgets` is
not a git dependency, or no lockfile is found, it falls back to upstream `makepad/makepad`
branch `dev` and any installed copy is accepted.

**`robius-packaging-commands`** (desktop builds only) is installed from crates.io, so a
pinned version is exact and immutable. With `robius_packaging_commands_version` set, that
version is installed even if another is already on PATH. With it unset, an existing copy on
PATH is reused untouched, and only an absent tool triggers an install of the latest
published version.

**`cargo-packager`** (desktop builds only) is installed from crates.io at its latest version
when absent, and an existing copy on PATH is reused.

### Outputs

- `artifacts`: JSON array of `{ path, platform, arch, mode, version }` with absolute paths.
  This lists everything built, including artifacts the release step later filters out.
- `app_name`: resolved app name; omitted if it cannot be resolved
- `app_version`: resolved version; omitted if it cannot be resolved
- `release_id`: GitHub Release ID used for upload (if any)
- `release_url`: GitHub Release URL, set both when the action creates a release and when it
  uploads to an existing `releaseId`

### How it works

1. Read inputs and resolve app metadata from `Cargo.toml` unless overridden.
2. Determine the target from `args` (`--target`), else default to the host platform. Mobile
   builds require a target triple (e.g. `aarch64-linux-android`, `aarch64-apple-ios`), and
   OpenHarmony targets fail fast.
3. Install the packaging tools for that target (see
   [Packaging tool versions](#packaging-tool-versions)).
4. Build the release build, then the debug build if `include_debug` is on, and collect the
   artifacts into a normalized list.
5. If `verify_deb=true`, verify every built `.deb` **before any upload**, so a package with a
   missing runtime dependency never reaches a release.
6. Upload to the release named by `releaseId` or `tagName`, write `latest.json`, and finally
   upload to TestFlight if enabled.

### Behavior notes

- Android package names are normalized to valid Java identifiers (e.g. `dora-studio` → `dora_studio`)
- Desktop artifacts are collected from `[package.metadata.packager].out_dir` (default
  `<root>/dist`) by file extension, with no filename filtering, so unrelated files with a
  packaged extension sitting in that directory are picked up too
- Before packaging with an explicit `--target`, the action fails fast if your
  `before-each-package-command` points `--path-to-binary` at an untripled `target/release/`
  path, since that mismatch otherwise packages a stale or missing binary
- If `releaseId` provided, upload artifacts to that release (no release creation)
- If `tagName` provided (and `releaseId` not set), create/update a GitHub Release and upload artifacts
- Concurrent jobs sharing a `tagName` are handled by locking on the tag ref, waiting for the
  release list to settle, and cleaning up duplicate releases that carry no unique assets.
  Passing an explicit `releaseId` is still the more predictable pattern for large matrices.
- Supports publishing to another repository via `owner` + `repo` (token must have permission there)
- Supports GitHub Enterprise/self-hosted API URLs via `githubBaseUrl`
- Release upload groups artifacts by platform/arch/mode and, when a group contains a
  recommended format, drops the rest of that group. Recommended formats are macOS
  `.dmg`/`.pkg`, Windows `.msi`/`.exe`, Linux `.deb`/`.appimage`/`.rpm`, Android `.apk` and
  iOS `.ipa`. This is why an iOS `.app` is not uploaded once an `.ipa` exists.
- If an artifact is a directory (like `.app`), it is zipped before upload
- Asset names default to a unique `app-version-platform-arch-mode.ext` pattern unless overridden.
  Colliding names are numbered, and an existing release asset with the same name is replaced.
- When `uploadUpdaterJson=true`, release upload creates/updates a `latest.json` asset
  (`version`, `notes`, `pub_date`, `platforms`). Any existing `latest.json` on the release is
  merged rather than overwritten, so matrix jobs accumulate platform entries instead of
  clobbering each other.
- For draft releases, updater URLs are generated using the release tag (`/releases/download/<tag>/<asset>`) and become publicly downloadable after the release is published
- `latest.json` entries are mapped only from `.msi`, Windows `.exe`, `.appimage`, `.app`,
  `.apk`, `.ipa` and macOS `.tar.gz`. Formats like `.dmg`, `.pkg`, `.deb` and `.rpm` have no
  updater mapping, so a macOS or Linux release that ships only those produces no updater
  entry for that platform.
- If `<artifact>.sig` exists next to an uploaded artifact and `uploadUpdaterSignatures=true`, it is uploaded as `<asset>.sig` and used as `signature` in `latest.json`
- Desktop entries require signatures in `latest.json`; mobile entries (`apk`/`ipa`) are allowed without `signature`
- Release upload requires a token with `contents: write` permission

### Verifying `.deb` dependencies

A `.deb` declares its runtime dependencies, but they cannot be fully derived by
static analysis: `dpkg-shlibdeps` sees only linked libraries, so anything loaded
via `dlopen` (OpenGL/EGL, D-Bus) or spawned as a program (`xdg-open`) is invisible
to it. A package can therefore install cleanly and then fail to start.

Setting `verify_deb: true` runs `robius-packaging-commands verify-deb` on every
built `.deb` **before any artifact is uploaded**. It installs the package into a
minimal container using only its declared `Depends` (which also proves
installability), boots the app under `strace`, and fails if the app loads a
library or spawns a program that no declared dependency provides. On failure it
prints the exact packages that are missing and the command that adds them.

`robius-packaging-commands` is installed by the desktop build, so no extra step is needed:

```yaml
- uses: project-robius/makepad-packaging-action@v1.7.0
  with:
    packager_formats: deb
    releaseId: ${{ needs.create_release.outputs.release_id }}
    verify_deb: true
```

Any `.deb` build on Linux also installs `apt-file` and refreshes its index first (roughly
20s and 300MB), so the dependency resolver can identify the package owning a `dlopen`'d
library from the archive's file lists instead of only what happens to be installed on the
runner. It is best-effort and logs a warning if it fails.

Container mode needs a container engine on the runner (GitHub-hosted Linux
runners have Docker preinstalled). Pass `--host` via `verify_deb_args` to check
against the runner itself instead, which needs no container but is a weaker test.

While rolling this out, `verify_strict: false` reports problems as warnings
without blocking uploads:

```yaml
    verify_deb: true
    verify_strict: false
```

Note that verification observes only the code paths a short boot exercises, so a
pass means the startup-critical dependencies are present, not that the dependency
list is provably complete.

### iOS (cargo-makepad) reference

For a CI build the action runs `cargo makepad apple ios ... run-device` (or `run-sim` for
simulator builds) with `--device=iPhone`, then locates the built `.app` bundle. A missing
bundle is reported as a warning, not a failure, so check the artifact list if a later step
finds nothing to package.

Common `cargo-makepad` commands, if you want to reproduce a build locally:

```bash
# Install toolchain
cargo makepad apple ios install-toolchain

# Run on simulator
cargo makepad apple ios --org=org.example --app=MyApp run-sim -p my-app --release

# Run on device (requires provisioning profile)
cargo makepad apple ios --org=org.example --app=MyApp run-device -p my-app --release

# List certificates/profiles/devices
cargo makepad apple list
```

iOS device builds require a provisioning profile. Create an empty app in Xcode with the
same organization and product names you plan to use (no spaces or unusual characters),
then run it on a real device at least once so the profile is generated. Use those values
for `MAKEPAD_IOS_ORG` and `MAKEPAD_IOS_APP`.

If you have multiple signing identities or profiles, set `MAKEPAD_IOS_PROFILE` and
`MAKEPAD_IOS_CERT` (or provide `APPLE_SIGNING_IDENTITY` so the action can select the right cert).

To upload to TestFlight, set `upload_to_testflight=true` (or `MAKEPAD_IOS_UPLOAD_TESTFLIGHT=true`) and provide:
- `APP_STORE_CONNECT_API_KEY` (or `APP_STORE_CONNECT_API_KEY_CONTENT`)
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`

When TestFlight upload is enabled, the action requires a device build (`MAKEPAD_IOS_SIM=false`)
and automatically forces `MAKEPAD_IOS_CREATE_IPA=true`.

`APP_STORE_CONNECT_API_KEY_CONTENT` is usually plain multi-line PEM text. If you prefer storing base64 in secrets, set `APP_STORE_CONNECT_API_KEY_CONTENT_BASE64` (or `APP_STORE_CONNECT_API_KEY_BASE64`).

### macOS signing and notarization convenience

For macOS desktop packaging, `cargo-packager` can use:

- `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` for signing certificate import (same pair reused by iOS device signing)
- notarization credentials via one of:
  - `APPLE_KEYCHAIN_PROFILE`
  - `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`
  - `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH`

If `enable_macos_notarization=true` (or `MAKEPAD_MACOS_ENABLE_NOTARIZATION=true`) and explicit macOS notarization env vars are not set, this action automatically reuses:
- `APP_STORE_CONNECT_API_KEY(_CONTENT)`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`

It writes a temporary `AuthKey_<KEY_ID>.p8` file and maps them to `APPLE_API_*` for `cargo-packager`.

DMG creation retries after detaching mounted volumes and deleting stale `.dmg` files, so
`hdiutil` "resource busy" messages followed by a retry in the log are expected recovery, not
a failure.

### Placeholder replacement

When `tagName` or `releaseName` contains `__VERSION__`, it is replaced with the resolved app version.

### Updater signatures

- You do not pass signatures in a dedicated action input.
- This action does not sign anything. Produce the `.sig` files yourself, typically with
  `cargo packager signer sign`, and make them available beside the built artifacts.
- Place signature files beside built artifacts using the `<artifact>.sig` naming convention.
- Example: if an uploaded asset resolves to `robrix-1.2.3-windows-x86_64-release.exe`, provide a file ending with `.exe.sig` for that artifact source path.
- With `uploadUpdaterSignatures=true` (default), the action uploads those `.sig` files and writes them into `latest.json` under each matched platform entry.
- Desktop entries without a corresponding `.sig` are skipped from `latest.json`.

### Release Modes

Use one of these patterns depending on workflow size:

- `Simple mode` (single job / quick setup): call this action once with `tagName` (or `releaseId`) and let it build + upload in one step. This is useful when you want minimal YAML and fast setup.
- `Robust matrix mode` (recommended for many parallel jobs): create the GitHub Release once, pass its `releaseId` into each build job, and let each job upload only to that existing release. This avoids release-creation races and keeps multi-platform uploads consistent.
- `Build-only mode`: omit both `tagName` and `releaseId` if you only want artifacts from the build step and will handle release publishing elsewhere.

### iOS signing convenience

For iOS device builds, supply certificate and provisioning profile via env vars.
When `MAKEPAD_IOS_PROFILE`/`MAKEPAD_IOS_CERT` are omitted, the action will install and extract them.

```yaml
- uses: project-robius/makepad-packaging-action@v1.7.0
  env:
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
    APPLE_PROVISIONING_PROFILE: ${{ secrets.APPLE_PROVISIONING_PROFILE }}
    APPLE_KEYCHAIN_PASSWORD: ${{ secrets.APPLE_KEYCHAIN_PASSWORD }}
  with:
    args: --target aarch64-apple-ios
```

### Example: matrix release

```yaml
- uses: project-robius/makepad-packaging-action@v1.7.0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    tagName: app-v__VERSION__
    releaseName: "App v__VERSION__"
    releaseBody: "See the assets to download this version and install."
    releaseDraft: true
    prerelease: false
    args: ${{ matrix.args }}
```

### Example: upload to an existing release

Create the release once, then pass its ID to every build job so assets land on the same page.

```yaml
jobs:
  create_release:
    runs-on: ubuntu-22.04
    outputs:
      release_id: ${{ steps.create_release.outputs.id }}
    steps:
      - uses: softprops/action-gh-release@v2
        id: create_release
        with:
          tag_name: v1.2.3
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  package:
    needs: create_release
    runs-on: ubuntu-22.04
    steps:
      - uses: project-robius/makepad-packaging-action@v1.7.0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          releaseId: ${{ needs.create_release.outputs.release_id }}
          args: --target aarch64-linux-android
```

### Example: Android only

```yaml
- uses: project-robius/makepad-packaging-action@v1.7.0
  with:
    args: --target aarch64-linux-android
```

More complete workflows, including desktop matrices, debug+release builds, custom asset
naming and iOS TestFlight, are in [`examples/`](examples/).

## Development

`dist/index.js` is the committed bundle that GitHub actually runs, so **editing `src/`
without rebuilding ships no change at all**. After any source edit:

```bash
bun install && bun run build   # or: npm install && npm run build
git add dist/
```

Bump `version` in `package.json` in the same commit, then tag the release.

### Current implementation status

- Desktop packaging: implemented (cargo-packager)
- Android packaging: implemented (APK build)
- iOS packaging: implemented (app bundle, optional IPA)
- OpenHarmony packaging: not implemented
- Web packaging: not implemented yet
- Release upload: implemented

### Roadmap

- Web packaging
