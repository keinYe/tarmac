# Tarmac 项目规范

## 项目定位

Tarmac 是面向 AI coding agent 的桌面终端：一个窗口里运行和切换多个 agent 会话，左栏按目录分组显示会话与状态，中间是真终端，右栏显示输入记录与诊断。支持同目录并行运行多个不同类型的 agent（Claude Code、Codex、Kimi、Antigravity 等）。版本 0.2.0，包名 `tarmac-app`。

## 公开仓库约束

- 本仓库公开发布（MIT）。不得写入私人信息：本机用户名与路径、真名、私有项目或工作项目名、对用户的称呼、内部链接。测试数据和示例用中性值（如 `/home/me`、`my-bot`、`Jane Doe`）。
- 开发进度、施工清单、验证记录和内部设计放在被忽略的 `.private/`（单独的私有 Git 仓库）：进度见 `.private/ROADMAP.md`，施工清单在 `.private/goals/`。公开文档不链接 `.private/` 中的内容。
- 提交使用 `keinye.dev@gmail.com`。
- 提交检查：`git config core.hooksPath .githooks` 启用后，pre-commit 检查暂存的文件名和新增行，commit-msg 检查提交信息，规则来自 `.private/blocklist.txt`（没有该文件时跳过；二进制文件不检查）。命中时修改内容，不得用 `--no-verify` 绕过；发现新的私人词汇时先加入 blocklist。

## 目标平台

- Linux x64（Ubuntu 24.04 已验证）与 Windows 11 x64（PowerShell）。
- 当前不支持 macOS（包括作为远程主机）：代码中的 macOS 分支保留但未验证，对外文档不得声称支持 macOS。
- Windows 专属行为必须在真实 Windows 上验证，Linux 单测、交叉编译和 WSL 的结果都不能代替；改动共享代码时，Linux 行为保持不变。方案与检查点见 `docs/windows-support-assessment.md`。
- 平台差异集中放在 `packages/protocol/src/platform.ts`（IPC 地址、token、文件归属）和 `packages/protocol/src/shell.ts`（默认 Shell），业务代码不各自拼接 socket 路径或 Shell 参数。Windows 进程信息由 `cmd/tarmac-native/`（Go，只编译到 Windows）提供，并由它兼任 hooks 启动器。

## 技术栈与标识

- Electron、React、TypeScript、node-pty、xterm.js、ssh2；不使用 tmux。
- 内部标识统一用 tarmac：数据目录 `~/.config/tarmac-app`、PTY 环境变量 `TARMAC_*`、hook 标记 ` # tarmac-app`。用户已安装的 hooks 依赖这些标识，改动前须先按旧标记卸载再重装。
- 打包安装后，用户 hooks 与 statusLine 指向安装目录中的包内 CLI（由 `pnpm desktop:entry install --package` 安装），不指向仓库 `dist/cli.cjs`；改 CLI 后须重新打包并安装，才会对真实 agent 生效。
- App 不读取 agent 凭据、不请求账号接口，唯一例外是 Kimi 额度：只用未过期的 access_token 请求官方 `/usages`，从不刷新 token、不写回凭证文件；边界见 `docs/app-hooks-usage.md` 的「凭据」条目，不得扩展到其他 provider 或用途。
- 修改用户的 shell 启动文件（`packages/cli/src/shell-rc.ts`）必须由用户在 App 卡片中点击授权，或者通过 CLI 的 plan → install 流程完成；不得静默修改，只撤销带 `# tarmac-app` 标记的改动。
- Logo 源文件 `apps/desktop/assets/tarmac.svg`，改动后用 `scripts/render-icon.py` 重新生成 PNG 和 `tarmac.ico`。
- `apps/desktop/assets/fonts/` 中的字体必须保持原始文件：不裁剪、不转换格式；许可文件要随包分发；标题栏的 MiSans 使用声明不得删除。这些都是许可的要求，见 `docs/design/fonts.md`。
- `tarmac ctl`（`packages/cli/src/ctl.ts`、daemon 的 `remote-*` 请求）是本机其他程序依赖的外部接口，契约在 `docs/tarmac-ctl.md`：改参数、JSON 字段、错误码或取行语义前，先改契约，再改实现，并告知已知的调用方；`remote-*` 请求不得 attach，也不得改变 owner 或 ready。

## 核心目录及职责

- `apps/desktop/`：Electron 主进程、受限 preload 与 React 界面。
- `packages/daemon/`：独立的会话 daemon：PTY 托管、字节回放日志、状态与用量、存储。
- `packages/protocol/`：App、daemon 与 CLI 共用的协议、客户端和平台差异。
- `packages/cli/`：hook 上报、配置安装、`tarmac bridge`、`tarmac ctl`。
- `cmd/tarmac-native/`：Windows 进程辅助程序和 hooks 启动器（Go）。
- `patches/`：pnpm 依赖补丁，升级对应依赖时须复核（原因见 `docs/app-m0-spec.md`）。
- `scripts/`：构建、测试、打包（`app-m0.mjs`）、运行时冒烟、桌面启动项安装与图标生成。
- 规格：终端恢复基线 `docs/app-m0-spec.md`，多会话规格与预算 `docs/app-m1-spec.md`、`docs/app-m1-resource-budget.md`，远程主机 `docs/app-remote-spec.md`，hooks 与用量 `docs/app-hooks-usage.md`。
- 用户文档：`README.md` 按 GitHub 发布页维护，只放概览、安装和快速开始；完整使用说明在 `docs/tarmac-guide.md`，用户可见的行为变化时同步更新。

## 架构约束

- App 正常关闭最后一个窗口时，有会话须经界面确认后结束本 daemon 及其 PTY；最小化、其他共享窗口仍存活、崩溃或意外断线时保留后台。只操作当前 App 数据目录的会话，不按进程名结束外部终端或其他程序；升级不自动终止已存活的旧 daemon。生命周期见 `docs/app-m1-spec.md`。
- App 连接其他机器的 daemon 只经系统 `ssh` 执行对方的 `tarmac bridge`（`packages/cli/src/bridge.ts`），daemon 不新增网络监听；密码只在首次连接时由 `ssh2` 用一次（`apps/desktop/src/first-connect.ts`），不保存、不写日志，Tarmac 的 SSH 文件只新建 `~/.ssh/tarmac_*`，不改动用户已有的 SSH 文件；两端 App 版本与协议版本必须一致，不做向下兼容。远程会话 ID 在主进程加 `<主机 id>:` 前缀，渲染端视为不透明字符串；hooks 与 Shell 启动文件卡片只对本机会话出现。规格见 `docs/app-remote-spec.md`。
- agent 的 transcript、rollout 等记录是各家未公开的内部格式：解析必须容错，失败时降级为「运行中」，不推测数据，不刷屏报错。

## 验证入口

- `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm build`。测试运行数据统一放 `.tmp/app-m0-validation/`。
- `pnpm package:local` 后执行 `pnpm smoke:runtime`：Electron 原生模块在本地打包后另验，Node 环境单测不代表 Electron ABI 已验证。`pnpm smoke:desktop` 检查真实桌面窗口。
- `cmd/tarmac-native`：`go test ./cmd/tarmac-native`，Windows 构建用 `GOOS=windows go vet ./cmd/tarmac-native`。

## 项目红线

- 不自动 git commit / push；不自动发布。
- 修改 `~/.codex`、`~/.claude`、`~/.kimi-code`、`~/.gemini` 下的配置或安装 hooks，必须逐项单独确认并可卸载。
