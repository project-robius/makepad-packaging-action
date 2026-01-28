# Makepad Packaging Action

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

- One-step packaging for Makepad desktop, mobile, and web targets
- GitHub Release upload with optional tag/name/body templating
- Sensible defaults sourced from `Cargo.toml`
- Matrix-friendly usage (pass `args` to target specific triples)

### Inputs

These inputs are already defined in `action.yaml`:

- `args`: extra args passed to build commands (e.g. `--release --target x86_64-unknown-linux-gnu`)
- `packager_formats`: comma-separated formats for `cargo packager` (e.g. `deb,dmg,nsis`)
- `packager_args`: extra args passed only to `cargo packager`
- `tagName`: GitHub Release tag, supports `__VERSION__` placeholder
- `releaseName`: Release title, supports `__VERSION__` placeholder
- `releaseBody`: Release body markdown
- `releaseId`: existing GitHub Release ID (uploads assets to this release and skips release creation)
- `asset_name_template`: template for asset names (`__APP__`, `__VERSION__`, `__PLATFORM__`, `__ARCH__`, `__MODE__`, `__EXT__`, `__FILENAME__`, `__BASENAME__`)
- `asset_prefix`: optional prefix prepended to generated asset names
- `releaseDraft`: create draft release (`true`/`false`)
- `prerelease`: mark as prerelease (`true`/`false`)
- `github_token`: token for release creation/upload (defaults to env `GITHUB_TOKEN`)
- `project_path`: Makepad project root (default: `.`)
- `app_name`: override app name (auto from `Cargo.toml` if omitted)
- `app_version`: override version (auto from `Cargo.toml` if omitted)
- `identifier`: override bundle identifier
- `include_release`: include release build (default: `true`)
- `include_debug`: include debug build (default: `false`)

### Environment variables

Mobile and signing configuration is provided via env vars only:

- `MAKEPAD_ANDROID_ABI`: Android ABI override (`x86_64`, `aarch64`, `armv7`, `i686`), default `aarch64`
- `MAKEPAD_ANDROID_FULL_NDK`: install full Android NDK (`true`/`false`), default `false`
- `MAKEPAD_ANDROID_VARIANT`: Android build variant (`default`, `quest`), default `default`

- `MAKEPAD_IOS_ORG`: iOS org identifier (e.g. `com.example`)
- `MAKEPAD_IOS_APP`: iOS app name
- `MAKEPAD_IOS_PROFILE`: provisioning profile UUID or path (optional, auto-derived when Apple envs are set)
- `MAKEPAD_IOS_CERT`: signing certificate fingerprint (optional, auto-derived when Apple envs are set)
- `MAKEPAD_IOS_SIM`: build for iOS simulator (`true`/`false`), default `false`
- `MAKEPAD_IOS_CREATE_IPA`: create IPA from .app bundle (`true`/`false`), default `false`
- `APPLE_CERTIFICATE`: base64-encoded Apple signing certificate (.p12)
- `APPLE_CERTIFICATE_PASSWORD`: password for the certificate
- `APPLE_PROVISIONING_PROFILE`: base64-encoded provisioning profile (.mobileprovision)
- `APPLE_KEYCHAIN_PASSWORD`: password for the temporary keychain
- `APPLE_SIGNING_IDENTITY`: signing identity common name used to locate the certificate (default: `Apple Distribution`)

OpenHarmony (HAP) signing configuration (CI-friendly):

- `DEVECO_HOME`: path to DevEco Command Line Tools or DevEco Studio install (optional; the action auto-detects common install paths)
- `OHOS_P12_BASE64`: base64-encoded `.p12` signing certificate
- `OHOS_PROFILE_BASE64`: base64-encoded `.p7b` profile
- `OHOS_P12_PASSWORD`: password for the `.p12` store
- `OHOS_KEY_ALIAS`: key alias (default: `debugKey`)
- `OHOS_KEY_PASSWORD`: key password (defaults to `OHOS_P12_PASSWORD`)
- `OHOS_CERT_BASE64`: base64-encoded `.cer` (optional; will be extracted from `.p12` if missing)
- `OHOS_SIGN_ALG`: signing algorithm (default: `SHA256withECDSA`)

If `DEVECO_HOME` is not set, the action tries common install paths like `~/command-line-tools`, `/opt/command-line-tools`, or `/Applications/DevEco Studio.app/Contents`.

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

### Outputs

- `artifacts`: JSON array of `{ path, platform, arch, mode, version }`
- `app_name`: resolved app name
- `app_version`: resolved version
- `release_url`: GitHub Release URL (if created)

### Behavior

- Determine target from `args` (`--target`), else default to host platform
- Mobile builds require a target triple (e.g. `aarch64-linux-android`, `aarch64-apple-ios`, `aarch64-unknown-linux-ohos`)
- Resolve app metadata from `Cargo.toml` unless overridden
- Install packaging tools per target (`cargo-packager`, `cargo-makepad`)
- Build artifacts and collect outputs into a normalized list
- If `releaseId` provided, upload artifacts to that release (no release creation)
- If `tagName` provided (and `releaseId` not set), create/update a GitHub Release and upload artifacts
- Release upload filters to recommended formats per platform when available (e.g. macOS `.dmg`, iOS `.ipa`)
- If an artifact is a directory (like `.app`), it is zipped before upload
- Asset names default to a unique `app-version-platform-arch-mode.ext` pattern unless overridden
- Release upload requires a token with `contents: write` permission

### Placeholder replacement

When `tagName` or `releaseName` contains `__VERSION__`, it is replaced with the resolved app version.

### iOS signing convenience

For iOS device builds, supply certificate and provisioning profile via env vars.
When `MAKEPAD_IOS_PROFILE`/`MAKEPAD_IOS_CERT` are omitted, the action will install and extract them.

```yaml
- uses: Project-Robius-China/makepad-packaging-action@main
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
- uses: Project-Robius-China/makepad-packaging-action@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    tagName: app-v__VERSION__
    releaseName: "App v__VERSION__"
    releaseBody: "See the assets to download this version and install."
    releaseDraft: true
    prerelease: false
    args: ${{ matrix.args }}

### Example: upload to an existing release

Create the release once, then pass its ID to every build job so assets land on the same page.

```yaml
jobs:
  create-release:
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
    needs: create-release
    runs-on: ubuntu-22.04
    steps:
      - uses: Project-Robius-China/makepad-packaging-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          releaseId: ${{ needs.create-release.outputs.release_id }}
          args: --target aarch64-linux-android
```
```

### Example: Android only

```yaml
- uses: Project-Robius-China/makepad-packaging-action@v1
  with:
    args: --target aarch64-linux-android
```

### Current implementation status

- Desktop packaging: implemented (cargo-packager)
- Android packaging: implemented (APK build)
- iOS packaging: implemented (app bundle, optional IPA)
- OpenHarmony packaging: implemented (signed HAP build)
- Web packaging: not implemented yet
- Release upload: implemented

### Roadmap

- Web packaging (`wasm_profile`)
