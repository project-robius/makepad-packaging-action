# Makepad Packaging Action

[English](README.md) | [简体中文](README_zh.md)

## 打包说明

### 桌面端

使用以下工具为你的 Makepad 应用创建安装程序或分发包。

底层使用 `cargo-packager` 和 `robius-packaging-commands` 来生成包。

### 移动端

`cargo-makepad` 用于构建 iOS 和 Android 平台的移动应用。

### 平台限制说明

注意：受平台限制，目前仅支持在如下环境构建：

* 在 Linux 系统上构建 Linux 安装包
* 在 Windows 系统上构建 Windows 安装程序
* 在 macOS 系统上构建 macOS 磁盘镜像 / `.app` 包
* 在 macOS 系统上构建 iOS 应用
* Android 可在任意操作系统上构建

## Action 参考

### 目标

- 为 Makepad 的桌面端、移动端和 Web 目标提供一步打包
- 支持上传到 GitHub Release，并可选使用 tag/name/body 模板
- 从 `Cargo.toml` 自动推导合理默认值
- 适配矩阵构建（通过 `args` 传入特定 target triple）

### Inputs

这些输入已在 `action.yaml` 中定义：

- `args`: 传给构建命令的额外参数（例如 `--release --target x86_64-unknown-linux-gnu`）
- `packager_formats`: `cargo packager` 的逗号分隔格式（例如 `deb,dmg,nsis`）
- `packager_args`: 仅传给 `cargo packager` 的额外参数
- `tagName`: GitHub Release 标签，支持 `__VERSION__` 占位符。若省略且 workflow 运行在 tag ref 上，会使用该 tag。
- `releaseName`: Release 标题，支持 `__VERSION__` 占位符
- `releaseBody`: Release 正文（Markdown）
- `releaseId`: 已存在的 GitHub Release ID（将资产上传到该 release，并跳过创建 release）
- `uploadUpdaterJson`: 是否上传/更新 `latest.json`（默认：`true`）
- `uploadUpdaterSignatures`: 是否上传 `.sig` 文件（若与构建产物同名同目录），并写入 `latest.json`（默认：`true`）
- `retryAttempts`: release 资产与 `latest.json` 上传发生冲突时的额外重试次数（默认：`0`）
- `asset_name_template`: 资产命名模板（`__APP__`, `__VERSION__`, `__PLATFORM__`, `__ARCH__`, `__MODE__`, `__EXT__`, `__FILENAME__`, `__BASENAME__`）
- `asset_prefix`: 可选前缀，会追加到生成的资产名之前
- `releaseDraft`: 是否创建草稿 release（`true`/`false`）
- `prerelease`: 是否标记为预发布（`true`/`false`）
- `github_token`: 用于创建/上传 release 的 token（默认读取环境变量 `GITHUB_TOKEN`）
- `project_path`: Makepad 项目根路径（默认：`.`）
- `app_name`: 覆盖应用名（若省略则自动从 `Cargo.toml` 读取）
- `app_version`: 覆盖版本号（若省略则自动从 `Cargo.toml` 读取）
- `identifier`: 覆盖 bundle identifier
- `include_release`: 是否包含 release 构建（默认：`true`）
- `include_debug`: 是否包含 debug 构建（默认：`false`）
- `upload_to_testflight`: 是否上传 iOS IPA 到 TestFlight（默认：`false`）。优先级高于 `MAKEPAD_IOS_UPLOAD_TESTFLIGHT`
- `enable_macos_notarization`: 是否启用 macOS 的 APP_STORE_CONNECT -> APPLE_API 公证凭据映射（默认：`false`）

### 环境变量

移动端与签名相关配置仅通过环境变量提供：

- `MAKEPAD_ANDROID_ABI`: Android ABI 覆盖（`x86_64`, `aarch64`, `armv7`, `i686`），默认 `aarch64`
- `MAKEPAD_ANDROID_FULL_NDK`: 是否安装完整 Android NDK（`true`/`false`），默认 `false`
- `MAKEPAD_ANDROID_VARIANT`: Android 构建变体（`default`, `quest`），默认 `default`

- `MAKEPAD_IOS_ORG`: iOS 组织标识（例如 `com.example`）
- `MAKEPAD_IOS_APP`: iOS 应用名
- `MAKEPAD_IOS_PROFILE`: provisioning profile UUID 或路径（可选；当 Apple 相关 env 存在时可自动推导）
- `MAKEPAD_IOS_CERT`: 签名证书指纹（可选；当 Apple 相关 env 存在时可自动推导）
- `MAKEPAD_IOS_SIM`: 是否构建 iOS 模拟器版本（`true`/`false`），默认 `false`
- `MAKEPAD_IOS_CREATE_IPA`: 是否从 `.app` 生成 IPA（`true`/`false`），默认 `false`
- `MAKEPAD_IOS_UPLOAD_TESTFLIGHT`: 是否上传 IPA 到 TestFlight（`true`/`false`），默认 `false`
- `APP_STORE_CONNECT_API_KEY` 或 `APP_STORE_CONNECT_API_KEY_CONTENT`: App Store Connect API Key 内容（`.p8` PEM 文本）
- `APP_STORE_CONNECT_API_KEY_CONTENT_BASE64`（或 `APP_STORE_CONNECT_API_KEY_BASE64`）: base64 编码的 `.p8` 内容（可选，可替代明文 PEM）
- `APP_STORE_CONNECT_KEY_ID`: App Store Connect Key ID
- `APP_STORE_CONNECT_ISSUER_ID`: App Store Connect Issuer ID
- `APPLE_CERTIFICATE`: base64 编码的 Apple 签名证书（`.p12`）
- `APPLE_CERTIFICATE_PASSWORD`: 证书密码
- `APPLE_PROVISIONING_PROFILE`: base64 编码的 provisioning profile（`.mobileprovision`）
- `APPLE_KEYCHAIN_PASSWORD`: 临时 keychain 密码
- `APPLE_SIGNING_IDENTITY`: 用于定位证书的签名身份名称（默认：`Apple Distribution`）
- `APPLE_KEYCHAIN_PROFILE`: 可选，用于 macOS `notarytool` 的 keychain profile
- `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`: 可选，Apple ID 公证凭据（macOS）
- `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH`: 可选，App Store Connect 公证凭据（macOS）
- `MAKEPAD_MACOS_ENABLE_NOTARIZATION`: 可选，通过环境变量启用 APP_STORE_CONNECT -> APPLE_API 公证凭据映射（`true`/`false`）

### iOS（cargo-makepad）参考

Action 中常用命令：

```bash
# 安装工具链
cargo makepad apple ios install-toolchain

# 运行模拟器版本
cargo makepad apple ios --org=org.example --app=MyApp run-sim -p my-app --release

# 运行真机版本（需要 provisioning profile）
cargo makepad apple ios --org=org.example --app=MyApp run-device -p my-app --release

# 列出证书 / profile / 设备
cargo makepad apple list
```

iOS 真机构建需要 provisioning profile。请在 Xcode 中创建一个空应用，组织名和产品名与计划使用的一致（不要包含空格或特殊字符），并至少在真机上运行一次以生成 profile。随后将对应值用于 `MAKEPAD_IOS_ORG` 与 `MAKEPAD_IOS_APP`。

如果存在多个签名身份或 profile，可设置 `MAKEPAD_IOS_PROFILE` 和 `MAKEPAD_IOS_CERT`（或提供 `APPLE_SIGNING_IDENTITY` 让 action 自动选择证书）。

action 在真机构建时使用 `--device=iPhone`。

若要上传到 TestFlight，设置 `upload_to_testflight=true`（或 `MAKEPAD_IOS_UPLOAD_TESTFLIGHT=true`）并提供：
- `APP_STORE_CONNECT_API_KEY`（或 `APP_STORE_CONNECT_API_KEY_CONTENT`）
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`

`APP_STORE_CONNECT_API_KEY_CONTENT` 通常是多行 PEM 明文。如果你更倾向在 secrets 中存 base64，可设置 `APP_STORE_CONNECT_API_KEY_CONTENT_BASE64`（或 `APP_STORE_CONNECT_API_KEY_BASE64`）。

### macOS 签名与公证便捷配置

对于 macOS 桌面打包，`cargo-packager` 可使用：

- `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` 导入签名证书（与 iOS 真机签名复用同一对）
- 以下任一公证凭据组合：
  - `APPLE_KEYCHAIN_PROFILE`
  - `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`
  - `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH`

如果 `enable_macos_notarization=true`（或 `MAKEPAD_MACOS_ENABLE_NOTARIZATION=true`）且未设置上述 macOS 公证环境变量，本 action 会自动复用：
- `APP_STORE_CONNECT_API_KEY(_CONTENT)`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`

它会写入临时 `AuthKey_<KEY_ID>.p8` 文件，并映射到 `APPLE_API_*` 供 `cargo-packager` 使用。

### Outputs

- `artifacts`: JSON 数组，元素结构为 `{ path, platform, arch, mode, version }`
- `app_name`: 解析后的应用名
- `app_version`: 解析后的版本号
- `release_url`: GitHub Release URL（若已创建）

### 行为说明

- 通过 `args` 中的 `--target` 解析目标；未指定时默认使用宿主平台
- 移动端构建需要 target triple（例如 `aarch64-linux-android`, `aarch64-apple-ios`）
- 应用元信息默认从 `Cargo.toml` 解析（除非显式覆盖）
- 按目标平台安装打包工具（`cargo-packager`, `cargo-makepad`）
- 构建产物并统一整理为标准输出结构
- Android 包名会被规范为合法 Java 标识符（例如 `dora-studio` → `dora_studio`）
- 若提供 `releaseId`，资产上传到该 release（不创建新 release）
- 若提供 `tagName`（且未提供 `releaseId`），创建/更新 GitHub Release 并上传资产
- 注意：GitHub Release 创建不是原子操作。多个 job 同时使用同一 `tagName` 可能竞争并创建多个 draft；建议单独建 release，再向各构建 job 传 `releaseId`
- 上传 release 资产时会优先筛选平台推荐格式（例如 macOS `.dmg`、iOS `.ipa`）
- 若构建产物是目录（如 `.app`），会先压缩再上传
- 默认资产名采用唯一模式 `app-version-platform-arch-mode.ext`（除非自定义）
- 当 `uploadUpdaterJson=true` 时，action 会创建/更新 `latest.json`（`version`, `notes`, `pub_date`, `platforms`）
- `latest.json` 目前支持从以下已签名格式写入：Windows（`nsis`, `wix`）、Linux（`appimage`）、macOS（`app`）、Android（`apk`）、iOS（`ipa`）
- 桌面端条目要求签名；移动端（`apk`/`ipa`）允许无 `signature` 写入 `latest.json`
- 对于缺少 `.sig` 的桌面端资产，`latest.json` 会跳过该条目
- 上传 release 需要 token 拥有 `contents: write` 权限

### 占位符替换

当 `tagName` 或 `releaseName` 包含 `__VERSION__` 时，会替换为解析后的应用版本号。

### iOS 签名便捷用法

对于 iOS 真机构建，可通过环境变量提供证书和 provisioning profile。
当未设置 `MAKEPAD_IOS_PROFILE`/`MAKEPAD_IOS_CERT` 时，action 会自动安装并提取。

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

### 示例：矩阵发布

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

### 示例：上传到已有 Release

先创建 release，再把其 ID 传给每个构建 job，确保资产归档到同一个页面。

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
      - uses: project-robius/makepad-packaging-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          releaseId: ${{ needs.create-release.outputs.release_id }}
          args: --target aarch64-linux-android
```

### 示例：仅 Android

```yaml
- uses: project-robius/makepad-packaging-action@v1
  with:
    args: --target aarch64-linux-android
```

### 当前实现状态

- Desktop packaging: implemented (cargo-packager)
- Android packaging: implemented (APK build)
- iOS packaging: implemented (app bundle, optional IPA)
- OpenHarmony packaging: not implemented
- Web packaging: not implemented yet
- Release upload: implemented

### 路线图

- Web packaging (`wasm_profile`)
