# Makepad Packaging Action

[English](README.md) | [简体中文](README_zh.md)

## Packaging Details

### For Desktop

Use the following tools to create an installer or package for your Makepad application.

`cargo-packager` and `robius-packaging-commands` are used under the hood to create the packages.

### For Mobile

`cargo-makepad` is used to build the mobile applications for iOS and Android platforms.

### Platform-specific considerations

Note: that due to platform restrictions, you can currently only build:

* Linux packages on a Linux OS machine
* Windows installer executables on a Windows OS machine
* macOS disk images / app bundles on a macOS machine
* iOS apps on a macOS machine.
* Android, on a machine with any OS!

## Action Reference

### Goals

- One-step packaging for Makepad desktop and mobile targets
- GitHub Release upload with optional tag/name/body templating
- Sensible defaults sourced from `Cargo.toml`
- Matrix-friendly usage (pass `args` to target specific triples)

### Inputs

These inputs are already defined in `action.yaml`:

- `args`: extra args passed to build commands (e.g. `--release --target x86_64-unknown-linux-gnu`)
- `packager_formats`: comma-separated formats for `cargo packager` (e.g. `deb,dmg,nsis`)
- `packager_args`: extra args passed only to `cargo packager`
- `tagName`: GitHub Release tag, supports `__VERSION__` placeholder. If omitted and the workflow runs on a tag ref, that tag is used.
- `releaseName`: Release title, supports `__VERSION__` placeholder
- `releaseBody`: Release body markdown
- `releaseId`: existing GitHub Release ID (uploads assets to this release and skips release creation)
- `releaseCommitish`: branch/commit SHA for creating tag/release (default: current commit SHA)
- `uploadUpdaterJson`: upload/update `latest.json` updater metadata asset on the release (default: `true`)
- `uploadUpdaterSignatures`: upload `.sig` files (if present next to built assets) and include signatures in `latest.json` (default: `true`)
- `retryAttempts`: additional retry attempts for release-asset/latest.json upload conflicts (default: `0`)
- `owner`: release target repository owner (default: current repo owner)
- `repo`: release target repository name (default: current repo name)
- `githubBaseUrl`: custom GitHub API base URL (for GHE/self-hosted APIs)
- `generateReleaseNotes`: use GitHub generated release notes when creating a release (default: `false`)
- `releaseAssetNamePattern`: pattern naming for uploaded assets, supports `[app] [name] [version] [platform] [arch] [mode] [ext] [filename] [basename]`
- `asset_name_template`: template for asset names (`__APP__`, `__VERSION__`, `__PLATFORM__`, `__ARCH__`, `__MODE__`, `__EXT__`, `__FILENAME__`, `__BASENAME__`)
- `asset_prefix`: optional prefix prepended to generated asset names
- `releaseDraft`: create draft release (`true`/`false`)
- `prerelease`: mark as prerelease (`true`/`false`)
- `github_token`: token for release creation/upload (defaults to env `GITHUB_TOKEN`)
- `project_path`: Makepad project root (default: `.`)
- `projectPath`: alias of `project_path`
- `app_name`: override app name (auto from `Cargo.toml` if omitted)
- `app_version`: override version (auto from `Cargo.toml` if omitted)
- `identifier`: override bundle identifier
- `include_release`: include release build (default: `true`)
- `include_debug`: include debug build (default: `false`)
- `upload_to_testflight`: upload iOS IPA to TestFlight (default: `false`). Takes precedence over `MAKEPAD_IOS_UPLOAD_TESTFLIGHT`.
- `enable_macos_notarization`: enable macOS APP_STORE_CONNECT -> APPLE_API credential mapping (default: `false`)

### Environment variables

Mobile and signing configuration is provided via env vars only:

- `MAKEPAD_ANDROID_ABI`: Android ABI override (`x86_64`, `aarch64`, `armv7`, `i686`), default `aarch64`
- `MAKEPAD_ANDROID_FULL_NDK`: install full Android NDK (`true`/`false`), default `false`
- `MAKEPAD_ANDROID_VARIANT`: Android build variant (`default`, `quest`), default `default`
- `MAKEPAD_MOBILE_CARGO_EXTRA_ARGS`: extra args appended to both iOS and Android `cargo makepad` build commands
- `MAKEPAD_ANDROID_CARGO_EXTRA_ARGS`: extra args appended only to Android `cargo makepad` build commands

- `MAKEPAD_IOS_ORG`: iOS org identifier (e.g. `com.example`)
- `MAKEPAD_IOS_APP`: iOS app name
- `MAKEPAD_IOS_PROFILE`: provisioning profile UUID or path (optional, auto-derived when Apple envs are set)
- `MAKEPAD_IOS_CERT`: signing certificate fingerprint (optional, auto-derived when Apple envs are set)
- `MAKEPAD_IOS_SIM`: build for iOS simulator (`true`/`false`), default `false`
- `MAKEPAD_IOS_CREATE_IPA`: create IPA from .app bundle (`true`/`false`), default `false`
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
- `APPLE_SIGNING_IDENTITY`: signing identity common name used to locate the certificate (default: `Apple Distribution`)
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

### iOS (cargo-makepad) reference

Common commands used by the action:

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
The action uses `--device=iPhone` for device builds.

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

### Outputs

- `artifacts`: JSON array of `{ path, platform, arch, mode, version }`
- `app_name`: resolved app name
- `app_version`: resolved version
- `release_id`: GitHub Release ID used for upload (if any)
- `release_url`: GitHub Release URL (if created)

### Behavior

- Determine target from `args` (`--target`), else default to host platform
- Mobile builds require a target triple (e.g. `aarch64-linux-android`, `aarch64-apple-ios`)
- OpenHarmony targets are currently unsupported and will fail fast
- Resolve app metadata from `Cargo.toml` unless overridden
- Install packaging tools per target (`cargo-packager`, `cargo-makepad`)
- Build artifacts and collect outputs into a normalized list
- Android package names are normalized to valid Java identifiers (e.g. `dora-studio` → `dora_studio`)
- If `releaseId` provided, upload artifacts to that release (no release creation)
- If `tagName` provided (and `releaseId` not set), create/update a GitHub Release and upload artifacts
- Note: GitHub Release creation is not atomic. If multiple jobs call the action with the same `tagName`, they can race and create separate drafts; prefer a single create-release job and pass `releaseId` to each job to keep assets together.
- Supports publishing to another repository via `owner` + `repo` (token must have permission there)
- Supports GitHub Enterprise/self-hosted API URLs via `githubBaseUrl`
- Release upload filters to recommended formats per platform when available (e.g. macOS `.dmg`, iOS `.ipa`)
- If an artifact is a directory (like `.app`), it is zipped before upload
- Asset names default to a unique `app-version-platform-arch-mode.ext` pattern unless overridden
- When `uploadUpdaterJson=true`, release upload creates/updates a `latest.json` asset (`version`, `notes`, `pub_date`, `platforms`) suitable for static updater metadata hosted on GitHub Releases CDN
- For draft releases, updater URLs are generated using the release tag (`/releases/download/<tag>/<asset>`) and become publicly downloadable after the release is published
- `latest.json` entries are currently mapped from signed assets with formats: Windows (`nsis`, `wix`), Linux (`appimage`), macOS (`app`), Android (`apk`), iOS (`ipa`)
- If `<artifact>.sig` exists next to an uploaded artifact and `uploadUpdaterSignatures=true`, it is uploaded as `<asset>.sig` and used as `signature` in `latest.json`
- Desktop entries require signatures in `latest.json`; mobile entries (`apk`/`ipa`) are allowed without `signature`
- Upload steps support retries via `retryAttempts` to reduce failures from concurrent asset conflicts
- Release upload requires a token with `contents: write` permission

### Placeholder replacement

When `tagName` or `releaseName` contains `__VERSION__`, it is replaced with the resolved app version.

### Updater signatures

- You do not pass signatures in a dedicated action input.
- Instead, place signature files beside built artifacts using the `<artifact>.sig` naming convention.
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
- uses: project-robius/makepad-packaging-action@main
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
- uses: project-robius/makepad-packaging-action@v1
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
      - uses: project-robius/makepad-packaging-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          releaseId: ${{ needs.create_release.outputs.release_id }}
          args: --target aarch64-linux-android
```

### Example: Android only

```yaml
- uses: project-robius/makepad-packaging-action@v1
  with:
    args: --target aarch64-linux-android
```

### Current implementation status

- Desktop packaging: implemented (cargo-packager)
- Android packaging: implemented (APK build)
- iOS packaging: implemented (app bundle, optional IPA)
- OpenHarmony packaging: not implemented
- Web packaging: not implemented yet
- Release upload: implemented

### Roadmap

- Web packaging (`wasm_profile`)
