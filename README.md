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

## Action Design (Draft)

This section describes the planned action interface and behavior. It is a design draft; implementation is in progress.

### Goals

- One-step packaging for Makepad desktop, mobile, and web targets
- GitHub Release upload with optional tag/name/body templating
- Sensible defaults sourced from `Cargo.toml`
- Matrix-friendly usage (pass `args` to target specific triples)

### Inputs (current)

These inputs are already defined in `action.yaml`:

- `args`: extra args passed to build commands (e.g. `--release --target x86_64-unknown-linux-gnu`)
- `packager_formats`: comma-separated formats for `cargo packager` (e.g. `deb,dmg,nsis`)
- `packager_args`: extra args passed only to `cargo packager`
- `tagName`: GitHub Release tag, supports `__VERSION__` placeholder
- `releaseName`: Release title, supports `__VERSION__` placeholder
- `releaseBody`: Release body markdown
- `releaseDraft`: create draft release (`true`/`false`)
- `prerelease`: mark as prerelease (`true`/`false`)
- `github_token`: token for release creation/upload (defaults to env `GITHUB_TOKEN`)
- `project_path`: Makepad project root (default: `.`)
- `app_name`: override app name (auto from `Cargo.toml` if omitted)
- `app_version`: override version (auto from `Cargo.toml` if omitted)
- `identifier`: override bundle identifier
- `include_release`: include release build (default: `true`)
- `include_debug`: include debug build (default: `false`)

### Inputs (planned additions)

Android:

- `android_abi`: `x86_64` | `aarch64` | `armv7` | `i686` | `all`
- `android_full_ndk`: `true`/`false`
- `android_variant`: `default` | `quest`

iOS:

- `ios_profile`: provisioning profile UUID or path
- `ios_cert`: signing cert fingerprint
- `ios_device`: device name (for `run-device`)
- `ios_sim`: `true`/`false` for simulator build

Web:

- `wasm_profile`: `release` | `debug`

### Outputs (current)

- `artifacts`: JSON array of `{ path, platform, arch, mode, version }`
- `app_name`: resolved app name
- `app_version`: resolved version
- `release_url`: GitHub Release URL (if created)

### Behavior (current)

- Determine target from `args` (`--target`), else default to host platform
- Resolve app metadata from `Cargo.toml` unless overridden
- Install packaging tools per target (`cargo-packager`, `cargo-makepad`)
- Build artifacts and collect outputs into a normalized list
- If `tagName` provided, create/update a GitHub Release and upload artifacts

### Placeholder replacement

When `tagName` or `releaseName` contains `__VERSION__`, it is replaced with the resolved app version.

### Example: matrix release (tauri-style)

```yaml
- uses: tyreseluo/makepad-packaging-action@v1
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

### Example: Android only

```yaml
- uses: tyreseluo/makepad-packaging-action@v1
  with:
    args: --target aarch64-linux-android
    android_abi: aarch64
```

### Current implementation status

- Desktop packaging: implemented (cargo-packager)
- Android packaging: implemented (APK build)
- iOS packaging: placeholder only
- Web packaging: not implemented yet
- Release upload: implemented
