# Makepad Packaging Action

[English](README.md) | [简体中文](README_zh.md)

为 macOS、Windows、Linux、Android 和 iOS 构建并打包 [Makepad](https://github.com/makepad/makepad)
应用，并可选择把产物上传到 GitHub Release。

可以直接复制使用的 workflow 见 [`examples/`](examples/)。

## 目录

- [快速开始](#快速开始)
- [打包说明](#打包说明)
  - [桌面端](#桌面端)
  - [移动端](#移动端)
  - [平台限制说明](#平台限制说明)
- [Action 参考](#action-参考)
  - [目标](#目标)
  - [Inputs](#inputs)
  - [环境变量](#环境变量)
  - [打包工具版本](#打包工具版本)
  - [Outputs](#outputs)
  - [工作流程](#工作流程)
  - [行为说明](#行为说明)
  - [验证 `.deb` 依赖](#验证-deb-依赖)
  - [iOS 参考 (cargo-makepad)](#ios-参考-cargo-makepad)
  - [macOS 签名与公证便捷配置](#macos-签名与公证便捷配置)
  - [更新器签名](#更新器签名)
  - [占位符替换](#占位符替换)
  - [Release 模式](#release-模式)
  - [iOS 签名便捷用法](#ios-签名便捷用法)
  - [矩阵发布示例](#矩阵发布示例)
  - [上传到已有 Release 示例](#上传到已有-release-示例)
  - [仅构建 Android 示例](#仅构建-android-示例)
- [开发](#开发)
  - [当前实现状态](#当前实现状态)
  - [路线图](#路线图)
- [贡献指南](CONTRIBUTING.md)
- [许可证](LICENSE)

## 快速开始

这个 action 只负责构建和打包，它不会 checkout 你的代码，也不会安装 Rust 工具链，所以一个能跑通的
job 至少需要：

```yaml
jobs:
  package:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@stable

      # Makepad 在 Linux 上的系统依赖。macOS 和 Windows 不需要。
      - run: |
          sudo apt-get update
          sudo apt-get install -y libssl-dev pkg-config llvm clang libclang-dev \
            binfmt-support libxcursor-dev libx11-dev libasound2-dev libpulse-dev \
            libwayland-dev libxkbcommon-dev libegl1

      - uses: project-robius/makepad-packaging-action@v1.8.1
        with:
          packager_formats: deb
```

`@v1` 也可以用，它会自动跟随最新的 v1.x 发布；如果希望构建结果可复现，就固定到某个具体的 tag。

## 打包说明

### 桌面端

底层使用 [`cargo-packager`](https://github.com/crabnebula-dev/cargo-packager) 和
[`robius-packaging-commands`](https://github.com/project-robius/robius-packaging-commands)
来生成包。这两个工具都会自动安装，详见[打包工具版本](#打包工具版本)。

### 移动端

[`cargo-makepad`](https://github.com/makepad/makepad/tree/dev/tools/cargo_makepad)
用于构建 iOS 和 Android 平台的移动应用。

它安装自你的 `Cargo.lock` 中 `makepad-widgets` 所固定的那个 makepad revision，因此构建工具
始终和应用依赖的 makepad 保持一致，fork 也一样。回退规则见[打包工具版本](#打包工具版本)。

### 平台限制说明

其中两条是强制检查的：在非 macOS 宿主机上构建 macOS 或 iOS 会立即失败。其余的属于实际限制，
不会提前检查，而是到构建阶段才以错误的形式暴露出来；并且只有在传入 `--target` triple 时，
上述所有检查（含强制检查）才会执行。

* 在 Linux 系统上构建 Linux 安装包
* 在 Windows 系统上构建 Windows 安装程序
* 在 macOS 系统上构建 macOS 磁盘镜像 / `.app` 包（强制检查）
* 在 macOS 系统上构建 iOS 应用（强制检查）
* Android 可在任意操作系统上构建（在 Windows 或 macOS 上构建会打印一条 warning）

## Action 参考

### 目标

- 为 Makepad 的桌面端和移动端目标提供一步打包
- 支持上传到 GitHub Release，并可选使用 tag/name/body 模板
- 从 `Cargo.toml` 自动推导合理默认值
- 适配矩阵构建（通过 `args` 传入特定 target triple）

### Inputs

这些输入已在 `action.yaml` 中定义。构建与打包相关的输入是 `snake_case`；GitHub Release 相关的
输入是 `camelCase`，与它们封装的 API 保持一致。

- `args`: 额外的构建参数（例如 `--target x86_64-unknown-linux-gnu`）。桌面端会原样转发给
  `cargo packager`；移动端只读取 `--target` 用来区分 iOS 和 Android，其余部分会被忽略
  （`cargo makepad` 的参数请用 `*_CARGO_EXTRA_ARGS` 环境变量传）。release 构建会自动追加 `--release`。
- `packager_formats`: 传给 `cargo packager` 的格式列表，逗号分隔（例如 `deb,dmg,nsis`）。
  如果 `args` 或 `packager_args` 里已经有 `--formats`，该输入会被忽略。在 Linux 上请求 `deb`
  还会触发 [apt-file 的准备工作](#验证-deb-依赖)。
- `packager_args`: 仅传给 `cargo packager` 的额外参数
- `robius_packaging_commands_version`: 固定桌面打包所安装的 `robius-packaging-commands` 版本
  （例如 `0.3.3`）。指定版本后，即使 PATH 上已经有另一个版本，也会安装这个指定版本。不设置时，
  PATH 上已有的副本原样复用，只有工具不存在时才会安装，且安装的是最新发布版本。
- `verify_deb`: **在上传任何产物之前**，验证每个构建出的 `.deb` 是否声明了它实际用到的全部运行时
  依赖（默认：`false`）。见[验证 `.deb` 依赖](#验证-deb-依赖)。
- `verify_deb_args`: 传给 `verify-deb` 的额外参数（例如 `--host`、`--image ubuntu:22.04`、`--run-secs 20`）
- `verify_strict`: 为 `true`（默认）时，验证失败会让 job 失败，并且不上传任何东西；为 `false` 时只报 warning，照常上传
- `tagName`: GitHub Release 标签，支持 `__VERSION__` 占位符。若省略且 workflow 运行在 tag ref 上，会使用该 tag。
- `releaseName`: Release 标题，支持 `__VERSION__` 占位符
- `releaseBody`: Release 正文（Markdown）
- `releaseId`: 已存在的 GitHub Release ID（将资产上传到该 release，并跳过创建 release）。设置了它之后，
  `tagName`、`releaseName`、`releaseBody`、`releaseDraft`、`prerelease` 和 `generateReleaseNotes`
  都会被忽略。
- `releaseCommitish`: 创建 tag/release 所基于的分支或 commit SHA（默认：当前 commit SHA）
- `uploadUpdaterJson`: 是否在 release 上上传/更新 `latest.json` 更新器元数据资产（默认：`true`）
- `uploadUpdaterSignatures`: 是否上传 `.sig` 文件（若与构建产物同目录存在），并把签名写入 `latest.json`（默认：`true`）
- `retryAttempts`: release 资产与 `latest.json` 上传发生冲突时的额外重试次数（默认：`0`）。上传本身至少会尝试 2 次，这个值是在此基础上追加的。
- `owner`: 发布目标仓库的 owner（默认：当前仓库 owner）
- `repo`: 发布目标仓库名（默认：当前仓库名）
- `githubBaseUrl`: 自定义 GitHub API base URL，用于 GHE 或自建 API（默认：环境变量 `GITHUB_API_URL`，GitHub Actions 总会设置它）
- `generateReleaseNotes`: 创建 release 时是否使用 GitHub 自动生成的 release notes（默认：`false`）
- `releaseAssetNamePattern`: 上传资产的命名模式，支持 `[app] [name] [version] [platform] [arch] [mode] [ext] [filename] [basename]`。同时设置了 `asset_name_template` 时会被忽略，并打印一条 warning。
- `asset_name_template`: 资产命名模板（`__APP__`, `__VERSION__`, `__PLATFORM__`, `__ARCH__`, `__MODE__`, `__EXT__`, `__FILENAME__`, `__BASENAME__`）。优先级高于 `releaseAssetNamePattern`。
- `asset_prefix`: 可选前缀，会加在生成的资产名之前
- `releaseDraft`: 是否创建草稿 release（默认：`false`）；设置了 `releaseId` 时忽略
- `prerelease`: 是否标记为预发布（默认：`false`）；设置了 `releaseId` 时忽略
- `github_token`: 用于创建/上传 release 的 token（默认读取环境变量 `GITHUB_TOKEN`）
- `project_path`: Makepad 项目根路径，相对于工作目录解析（默认：`.`）
- `projectPath`: `project_path` 的别名；两者都设置时以 `project_path` 为准
- `app_name`: 覆盖应用名。默认取 `[package.metadata.packager].product_name`，其次是 `Cargo.toml`
  的 name。移动端还会用它拼出 `<name>_v<version>_<abi>` 的产物前缀。
- `app_version`: 覆盖版本号（若省略则自动从 `Cargo.toml` 读取）
- `identifier`: 覆盖 bundle identifier。仅对移动端生效：它会成为 Android 包名，并用于推导 iOS 的
  org/app。桌面打包会忽略它，改用 `[package.metadata.packager]` 里的 identifier。默认取
  `[package.metadata.packager].identifier`，未设置时才回退到 `org.makepad.<crate name>`。
- `android_app_label`: Android 图标下显示的名称。默认与应用名相同，只有需要两者不一致时才设置。
- `include_release`: 是否包含 release 构建（默认：`true`）
- `include_debug`: 是否包含 debug 构建（默认：`false`）。两者都开启会重新扫描同一个输出目录，
  所以 release 产物会被再收集一遍，并被标记为 `debug`。
- `upload_to_testflight`: 是否上传 iOS IPA 到 TestFlight（默认：`false`）。它与
  `MAKEPAD_IOS_UPLOAD_TESTFLIGHT` 之间是 OR 关系，任意一个为真就会启用上传，所以把它设为
  `false` 并不能关掉环境变量已经打开的上传。
- `enable_macos_notarization`: 是否启用 macOS 的 APP_STORE_CONNECT -> APPLE_API 凭据映射
  （默认：`false`）。同样与 `MAKEPAD_MACOS_ENABLE_NOTARIZATION` 取 OR。

### 环境变量

移动端与签名相关的配置只能通过环境变量提供。布尔值接受 `true`/`1`/`yes`/`on`（不区分大小写），
其他值一律视为 false。

- `MAKEPAD_ANDROID_ABI`: 要构建的 Android ABI（`x86_64`, `aarch64`, `armv7`, `i686`），默认
  `aarch64`。决定 ABI 的是这个变量而不是 `--target` triple，所以不设置它的话，
  `--target x86_64-linux-android` 仍然会产出 `aarch64` 的构建。`all` 不被接受。
- `MAKEPAD_ANDROID_FULL_NDK`: 是否安装完整 Android NDK（`true`/`false`），默认 `false`
- `MAKEPAD_ANDROID_VARIANT`: Android 构建变体（`default`, `quest`），默认 `default`
- `MAKEPAD_MOBILE_CARGO_EXTRA_ARGS`: 追加到 iOS 和 Android 两边 `cargo makepad` 构建命令上的额外参数
- `MAKEPAD_ANDROID_CARGO_EXTRA_ARGS`: 只追加到 Android `cargo makepad` 构建命令上的额外参数

- `MAKEPAD_IOS_ORG`: iOS 组织标识（例如 `com.example`）。未设置时会从 `identifier` 推导
  （取最后一个点之前的部分），再退回到 `org.makepad`，而这个值不会匹配到任何真实的
  provisioning profile。
- `MAKEPAD_IOS_APP`: iOS 应用名。未设置时依次回退到 `app_name`、crate 的二进制名；三者都解析不出来才会构建失败。
- `MAKEPAD_IOS_PROFILE`: provisioning profile UUID 或路径（可选；当 Apple 相关 env 存在时可自动推导）
- `MAKEPAD_IOS_CERT`: 签名证书指纹（可选；当 Apple 相关 env 存在时可自动推导）
- `MAKEPAD_IOS_SIM`: 是否构建 iOS 模拟器版本（`true`/`false`），默认 `false`
- `MAKEPAD_IOS_CREATE_IPA`: 是否从 `.app` 生成 IPA（`true`/`false`），默认 `false`。模拟器构建会忽略它。
- `MAKEPAD_IOS_UPLOAD_TESTFLIGHT`: 是否上传 IPA 到 TestFlight（`true`/`false`），默认 `false`
- `MAKEPAD_IOS_CARGO_EXTRA_ARGS`: 只追加到 iOS `cargo makepad` 构建命令上的额外参数
- `APP_STORE_CONNECT_API_KEY` 或 `APP_STORE_CONNECT_API_KEY_CONTENT`: App Store Connect API Key 内容（`.p8` PEM 文本）
- `APP_STORE_CONNECT_API_KEY_CONTENT_BASE64`（或 `APP_STORE_CONNECT_API_KEY_BASE64`）: base64 编码的 `.p8` 内容（可选，可替代明文 PEM）
- `APP_STORE_CONNECT_KEY_ID`: App Store Connect 的 Key ID
- `APP_STORE_CONNECT_ISSUER_ID`: App Store Connect 的 Issuer ID
- `APPLE_CERTIFICATE`: base64 编码的 Apple 签名证书（`.p12`）
- `APPLE_CERTIFICATE_PASSWORD`: 证书密码
- `APPLE_PROVISIONING_PROFILE`: base64 编码的 provisioning profile（`.mobileprovision`）
- `APPLE_KEYCHAIN_PASSWORD`: 临时 keychain 密码
- `APPLE_SIGNING_IDENTITY`: 用于定位证书的签名身份名称（默认：`Apple Distribution`）。如果没有任何
  证书匹配，会直接使用临时 keychain 里的第一张证书而不是报错，所以这里写错会用错误的身份签名。
- `APPLE_KEYCHAIN_PROFILE`: 可选，用于 macOS `notarytool` 的 keychain profile
- `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`: 可选，Apple ID 公证凭据（macOS）
- `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH`: 可选，App Store Connect 公证凭据（macOS）
- `MAKEPAD_MACOS_ENABLE_NOTARIZATION`: 可选，通过环境变量启用 APP_STORE_CONNECT -> APPLE_API 凭据映射（`true`/`false`）

想让移动端 CI 构建更快（参考 `robrix#729` 的做法），可以传入 Cargo profile 覆盖：

```yaml
env:
  MAKEPAD_MOBILE_CARGO_EXTRA_ARGS: >-
    --config profile.dev.opt-level=0
    --config profile.dev.debug=false
    --config profile.dev.lto=off
    --config profile.dev.strip=true
    --config profile.dev.debug-assertions=false
```

### 打包工具版本

action 会自己安装需要的工具，你不用再加 `cargo install` 步骤。

**`cargo-makepad`**（仅移动端构建）安装自你的 `Cargo.lock` 中 `makepad-widgets` 所固定的 git 仓库
和 revision，这样构建工具始终和应用实际编译所依赖的 makepad 一致，fork 也一样。查找会从
`project_path` 逐级向上寻找最近的 `Cargo.lock`，所以 workspace 成员也能正常工作。已经装好的
`cargo-makepad` 只有在 revision 匹配时才会复用，否则会重新安装。如果 `makepad-widgets` 不是 git
依赖，或者找不到 lockfile，就回退到上游 `makepad/makepad` 的 `dev` 分支，并接受任何已安装的副本。

**`robius-packaging-commands`**（仅桌面端构建）安装自 crates.io，所以固定版本是精确且不可变的。
设置了 `robius_packaging_commands_version` 时，即使 PATH 上已经有另一个版本，也会安装指定的这个。
不设置时，PATH 上已有的副本原样保留，只有工具不存在时才会触发安装，装的是最新发布版本。

**`cargo-packager`**（仅桌面端构建）在不存在时从 crates.io 安装最新版本，PATH 上已有的副本会直接复用。

### Outputs

- `artifacts`: JSON 数组，元素结构为 `{ path, platform, arch, mode, version }`，路径为绝对路径。
  它列出的是构建出的全部产物，包括后续 release 步骤会过滤掉的那些。
- `app_name`: 解析出的应用名；解析不出来时不设置
- `app_version`: 解析出的版本号；解析不出来时不设置
- `release_id`: 用于上传的 GitHub Release ID（如果有）
- `release_url`: GitHub Release URL，无论是本 action 创建的 release，还是上传到已有的 `releaseId`，都会设置

### 工作流程

1. 读取输入，并从 `Cargo.toml` 解析应用元信息（除非被显式覆盖）。
2. 从 `args` 的 `--target` 确定目标平台，未指定时默认使用宿主平台。移动端构建必须给出 target triple
   （例如 `aarch64-linux-android`、`aarch64-apple-ios`），OpenHarmony 目标会直接快速失败。
3. 为该目标安装打包工具（见[打包工具版本](#打包工具版本)）。
4. 先构建 release 版本，若开启了 `include_debug` 再构建 debug 版本，然后把产物整理成统一的列表。
5. 若 `verify_deb=true`，**在任何上传之前**验证每个构建出的 `.deb`，这样缺少运行时依赖的包永远
   不会进入 release。
6. 上传到 `releaseId` 或 `tagName` 指定的 release，写入 `latest.json`，最后在启用的情况下上传到 TestFlight。

### 行为说明

- Android 包名会被规范为合法的 Java 标识符（例如 `dora-studio` → `dora_studio`）
- 桌面端产物按文件扩展名从 `[package.metadata.packager].out_dir`（默认 `<root>/dist`）收集，
  不做文件名过滤，所以目录里其他带相同扩展名的无关文件也会被一并收进来
- 使用显式 `--target` 打包前，如果你的 `before-each-package-command` 把 `--path-to-binary` 指向了
  不带 triple 的 `target/release/` 路径，action 会快速失败，因为这种不匹配会打包到过期甚至不存在的二进制
- 若提供 `releaseId`，产物上传到该 release（不创建新 release）
- 若提供 `tagName`（且未提供 `releaseId`），创建/更新 GitHub Release 并上传产物
- 多个 job 共用同一个 `tagName` 时，action 会对 tag ref 加锁、等待 release 列表稳定，并清理掉
  没有独占资产的重复 release。不过对于大型矩阵，显式传入 `releaseId` 仍然是更可预期的做法。
- 支持通过 `owner` + `repo` 发布到其他仓库（token 需要有对应权限）
- 支持通过 `githubBaseUrl` 使用 GitHub Enterprise / 自建 API 地址
- 上传时会按 platform/arch/mode 对产物分组，如果某组里出现了推荐格式，就丢弃该组其余产物。推荐格式为
  macOS `.dmg`/`.pkg`、Windows `.msi`/`.exe`、Linux `.deb`/`.appimage`/`.rpm`、Android `.apk`
  和 iOS `.ipa`。这也是为什么有了 `.ipa` 之后 iOS 的 `.app` 不会被上传。
- 若构建产物是目录（如 `.app`），会先压缩再上传
- 资产名默认采用唯一的 `app-version-platform-arch-mode.ext` 模式（除非自定义）。重名会自动编号，
  release 上已存在的同名资产会被替换。
- 当 `uploadUpdaterJson=true` 时，上传阶段会创建/更新 `latest.json` 资产（`version`, `notes`,
  `pub_date`, `platforms`）。release 上已有的 `latest.json` 会被合并而不是覆盖，所以矩阵中的各个
  job 会不断累加平台条目，而不会互相覆盖。
- 对于草稿 release，更新器 URL 会用 release tag 生成（`/releases/download/<tag>/<asset>`），
  在 release 发布之后即可公开下载
- `latest.json` 条目只会从 `.msi`、Windows `.exe`、`.appimage`、`.app`、`.apk`、`.ipa` 以及 macOS
  `.tar.gz` 映射而来。`.dmg`、`.pkg`、`.deb`、`.rpm` 这类格式没有更新器映射，所以只发布这些格式的
  macOS 或 Linux release 不会产生对应平台的更新器条目。
- 如果上传的产物旁边存在 `<artifact>.sig`，且 `uploadUpdaterSignatures=true`，它会以 `<asset>.sig`
  的名字上传，并作为 `latest.json` 中的 `signature`
- 桌面端条目在 `latest.json` 中必须带签名；移动端条目（`apk`/`ipa`）允许没有 `signature`
- 上传 release 需要 token 拥有 `contents: write` 权限

### 验证 `.deb` 依赖

`.deb` 会声明自己的运行时依赖，但这些依赖没办法完全靠静态分析推导出来：`dpkg-shlibdeps` 只看得到
链接进来的库，凡是通过 `dlopen` 加载的东西（OpenGL/EGL、D-Bus）或者作为程序调起来的东西
（`xdg-open`），它都看不见。结果就是包能装上，却起不来。

设置 `verify_deb: true` 会**在上传任何产物之前**对每个构建出的 `.deb` 运行
`robius-packaging-commands verify-deb`。它只按包自己声明的 `Depends` 把包安装进一个最小容器
（这同时也证明了可安装性），在 `strace` 下启动应用，如果应用加载了某个库或调起了某个程序，
而没有任何已声明的依赖提供它，验证就失败。失败时会打印出到底缺哪些包，以及补上它们的命令。

`robius-packaging-commands` 由桌面端构建负责安装，所以不需要额外步骤：

```yaml
- uses: project-robius/makepad-packaging-action@v1.8.1
  with:
    packager_formats: deb
    releaseId: ${{ needs.create_release.outputs.release_id }}
    verify_deb: true
```

在 Linux 上只要构建 `.deb`，action 都会先安装 `apt-file` 并刷新它的索引（大约 20 秒、300MB），
这样依赖解析就能从软件源的文件清单里找出 `dlopen` 的库属于哪个包，而不是只能看 runner 上恰好
装了什么。这一步是尽力而为，失败只会打印一条 warning。

容器模式需要 runner 上有容器引擎（GitHub 托管的 Linux runner 预装了 Docker）。通过
`verify_deb_args` 传 `--host` 可以改为直接在 runner 上检查，不需要容器，但检查强度更弱。

在推广落地阶段，`verify_strict: false` 会把问题降级为 warning，不阻塞上传：

```yaml
    verify_deb: true
    verify_strict: false
```

注意：验证只能观察到短暂启动过程实际走到的代码路径，所以通过验证只说明启动关键的依赖都在，
并不能证明依赖列表是完整的。

### iOS 参考 (cargo-makepad)

CI 构建时，action 会带上 `--device=iPhone` 执行 `cargo makepad apple ios ... run-device`
（模拟器构建则是 `run-sim`），然后定位构建出的 `.app` bundle。找不到 bundle 只会报 warning，
而不是直接失败，所以如果后续步骤没有东西可打包，记得检查产物列表。

如果想在本地复现构建，常用的 `cargo-makepad` 命令如下：

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

iOS 真机构建需要 provisioning profile。请在 Xcode 中创建一个空应用，组织名和产品名与计划使用的
一致（不要包含空格或特殊字符），并至少在真机上运行一次以生成 profile。随后将对应值用于
`MAKEPAD_IOS_ORG` 与 `MAKEPAD_IOS_APP`。

如果存在多个签名身份或 profile，可设置 `MAKEPAD_IOS_PROFILE` 和 `MAKEPAD_IOS_CERT`
（或提供 `APPLE_SIGNING_IDENTITY` 让 action 自动选择正确的证书）。

若要上传到 TestFlight，设置 `upload_to_testflight=true`（或 `MAKEPAD_IOS_UPLOAD_TESTFLIGHT=true`）并提供：
- `APP_STORE_CONNECT_API_KEY`（或 `APP_STORE_CONNECT_API_KEY_CONTENT`）
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`

启用 TestFlight 上传时，action 要求这是一次真机构建（`MAKEPAD_IOS_SIM=false`），并会自动强制
`MAKEPAD_IOS_CREATE_IPA=true`。

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

创建 DMG 失败时，action 会先卸载已挂载的卷、删掉残留的 `.dmg` 再重试，所以日志里出现 `hdiutil`
的 `resource busy` 之后紧跟一次重试，属于正常恢复而不是失败。

### 占位符替换

当 `tagName` 或 `releaseName` 包含 `__VERSION__` 时，会替换为解析后的应用版本号。

### 更新器签名

- 签名不是通过某个专门的 action 输入传进来的。
- 本 action 不做任何签名。`.sig` 文件需要你自己生成，通常用 `cargo packager signer sign`，
  然后把它们放到构建产物旁边。
- 签名文件与构建产物放在同一目录，命名遵循 `<artifact>.sig` 约定。
- 例如：如果上传的资产最终叫 `robrix-1.2.3-windows-x86_64-release.exe`，就为对应的产物源路径提供一个以 `.exe.sig` 结尾的文件。
- 当 `uploadUpdaterSignatures=true`（默认）时，action 会上传这些 `.sig` 文件，并把它们写进 `latest.json` 中匹配到的平台条目里。
- 没有对应 `.sig` 的桌面端条目会被 `latest.json` 跳过。

### Release 模式

根据 workflow 规模，选择下面其中一种模式：

- `Simple mode`（单个 job / 快速接入）：只调用一次本 action，传入 `tagName`（或 `releaseId`），构建加上传一步完成。适合希望 YAML 尽量少、快速跑通的场景。
- `Robust matrix mode`（多个并行 job 时推荐）：先创建一次 GitHub Release，把它的 `releaseId` 传给每个构建 job，各个 job 只往这个已有的 release 上传。这样可以避开创建 release 的竞争，也让多平台上传保持一致。
- `Build-only mode`：如果你只要构建产物，release 发布交给别处处理，那就 `tagName` 和 `releaseId` 都不要传。

### iOS 签名便捷用法

对于 iOS 真机构建，可通过环境变量提供证书和 provisioning profile。
当未设置 `MAKEPAD_IOS_PROFILE`/`MAKEPAD_IOS_CERT` 时，action 会自动安装并提取。

```yaml
- uses: project-robius/makepad-packaging-action@v1.8.1
  env:
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
    APPLE_PROVISIONING_PROFILE: ${{ secrets.APPLE_PROVISIONING_PROFILE }}
    APPLE_KEYCHAIN_PASSWORD: ${{ secrets.APPLE_KEYCHAIN_PASSWORD }}
  with:
    args: --target aarch64-apple-ios
```

### 矩阵发布示例

```yaml
- uses: project-robius/makepad-packaging-action@v1.8.1
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

### 上传到已有 Release 示例

先创建一次 release，再把它的 ID 传给每个构建 job，让所有资产落在同一个页面上。

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
      - uses: project-robius/makepad-packaging-action@v1.8.1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          releaseId: ${{ needs.create_release.outputs.release_id }}
          args: --target aarch64-linux-android
```

### 仅构建 Android 示例

```yaml
- uses: project-robius/makepad-packaging-action@v1.8.1
  with:
    args: --target aarch64-linux-android
```

更完整的 workflow，包括桌面端矩阵、debug + release 构建、自定义资产命名和 iOS TestFlight，
都在 [`examples/`](examples/) 里。

## 开发

`dist/index.js` 是提交进仓库、GitHub 实际执行的打包产物，所以**只改 `src/` 而不重新构建，
等于什么都没改**。任何源码改动之后：

```bash
bun install && bun run build   # 或者: npm install && npm run build
git add dist/
```

在同一个 commit 里更新 `package.json` 的 `version`，然后打 tag 发布。

### 当前实现状态

- 桌面端打包：已实现（cargo-packager）
- Android 打包：已实现（APK 构建）
- iOS 打包：已实现（.app bundle，可选 IPA）
- OpenHarmony 打包：未实现
- Web 打包：尚未实现
- Release 上传：已实现

### 路线图

- Web 打包
