<p align="center">
  <img src="apps/desktop/assets/tarmac.svg" width="96" alt="Tarmac logo">
</p>

<h1 align="center">Tarmac</h1>

<p align="center">在一个窗口里同时运行、切换和看管多个 AI coding agent 的桌面终端。</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.0-blue" alt="version 0.2.0">
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows-lightgrey" alt="platform Linux | Windows">
  <img src="https://img.shields.io/badge/status-preview-orange" alt="status preview">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license MIT">
</p>

同时开着好几个 Claude Code、Codex 窗口时，很难看出哪个在干活、哪个在等你回答、哪个已经结束。Tarmac 把它们放进同一个窗口：左栏按项目目录列出所有会话和状态，中间是真正的终端，agent 的交互方式和单独运行时完全一样。

## 功能

- **真终端，多会话**：每个会话是独立的 PTY，键盘、颜色、粘贴和鼠标原样交给 agent。切换会话不重启进程，也不从头回放；同一目录可以并行运行多个 agent。
- **状态一眼可见**：左栏按目录分组，显示工作中、等待输入、空闲、等待授权等状态，以及最后一条输入；后台会话有新内容时显示未读。
- **用量与额度**：标题栏显示当前会话的 token 用量和账户额度（各家支持范围见下表），悬停查看明细。
- **关掉窗口，agent 照常运行**：会话由独立的 daemon 托管；窗口崩溃或断线后重新打开即可接回。
- **远程主机**：经 SSH 连接局域网内其他机器上的 Tarmac，agent 留在那台机器上运行，本机只负责显示和输入。首次连接用一次密码部署专用密钥，不开放新端口。在远程会话里按 `Ctrl+V` 或拖入图片，Tarmac 会把图片传到那台机器并粘贴路径，agent 就能看到。
- **系统信息**：标题栏显示当前会话所在机器的 CPU、内存、网速和本地时间。
- **一键接入 hooks**：发现 Claude、Kimi 尚未接入时提示安装，先展示方案、授权后才写入，写入前备份，可以撤销。
- **外部控制**：`tarmac ctl` 让本机其他程序以一行 JSON 的方式查看和操控会话。

### 支持的 agent

| agent | 状态 | 输入记录 | token | 额度 |
| --- | --- | --- | --- | --- |
| Claude Code | ✓ | ✓ | ✓ | ✓（需配置 statusLine 转发或安装 token-tracker） |
| Codex（含 `--profile`） | ✓ | ✓ | ✓ | ✓ |
| Kimi | ✓ | ✓ | ✓ | ✓ |
| Google Antigravity（`agy`） | ✓（无「等待授权」） | ✓ | ✓ | — |

Shell 和其他命令行程序也可以在 Tarmac 中运行，只是不显示 agent 状态。数据来源和接入方式见 [使用指南](docs/tarmac-guide.md#agent-识别状态与用量) 。

## 平台支持

| 平台 | 状态 |
| --- | --- |
| Linux x64 | 支持，在 Ubuntu 24.04 上日常使用 |
| Windows 11 x64 | 支持，在实机上可用；部分底层行为仍在验证，标题栏暂不显示网速 |
| macOS | **当前不支持**：不提供 macOS 包，也不支持把 macOS 机器添加为远程主机 |

## 安装

目前不提供预编译的发布包，需要从源码构建。

依赖：Node.js 24 或更新版本、pnpm 11.9.0；Linux 上编译原生依赖还需要 C++ 编译工具和 Python。

### Linux

```bash
git clone https://github.com/keinye/tarmac.git
cd tarmac
pnpm install --frozen-lockfile
pnpm package:local
pnpm desktop:entry install --package
```

App 会安装到 `~/.local/opt/tarmac/`，并在应用菜单中添加 Tarmac。升级时拉取新代码后重复后三步；卸载用 `pnpm desktop:entry uninstall --package`。

### Windows

目前在 Linux 上交叉打包，需要额外安装 Go 1.25 或更新版本：

```bash
node scripts/app-m0.mjs package --platform win32
```

把生成的 `dist/package/Tarmac-win32-x64.zip` 复制到 Windows，解压后运行 `Tarmac.exe`。

## 快速开始

1. 打开 Tarmac，按 `Ctrl+Shift+N` 新建一个 Shell。
2. 在 Shell 里 `cd` 到项目目录，运行 `claude`、`codex`、`kimi` 或 `agy`。
3. 再开几个会话，在左栏点击切换；左栏会显示每个 agent 的状态。
4. 按 `Ctrl+Shift+H` 显示右栏的输入记录与会话诊断。
5. 关掉的项目会留在「历史项目」中，单击即可在原目录重新打开 Shell。

完整说明见 [Tarmac 使用指南](docs/tarmac-guide.md) ，包括关闭行为、远程主机、hooks 安装、`tarmac ctl` 和排错。

## Tarmac 会改动什么

Tarmac 只在你明确授权后改动自身数据目录以外的文件：

| 位置 | 时机 | 说明 |
| --- | --- | --- |
| `~/.config/tarmac-app/` | 始终 | 会话注册表、输入记录、项目历史、日志与备份；作为远程主机时还有贴进来的图片（会话结束即删除） |
| Claude、Kimi 的配置文件 | 在卡片中点「授权安装」后 | 只增删带 ` # tarmac-app` 标记的 hooks 条目，写入前备份，可以撤销 |
| shell 启动文件（`~/.zshrc` 等） | 在卡片中点「授权修改」后 | 仅在 shell 启动时自动进入 tmux 的情况下提示，改动行带标记，可以撤销 |
| `~/.ssh/tarmac_*` | 添加远程主机时 | Tarmac 专用的密钥和主机指纹文件，不改动已有的 `id_*`、`known_hosts` |
| 远程主机的 `~/.ssh/authorized_keys` | 首次连接时 | 追加一行带 `tarmac-app` 标记的公钥，移除主机时可以勾选删除 |

Tarmac 不读取 agent 的凭据，唯一的例外是 Kimi 额度：读取 Kimi 未过期的 access token，向 Kimi 官方接口请求 `/usages`，不刷新 token，也不写回凭据文件。代码中主动发起的网络连接只有这个请求和连接远程主机用的系统 `ssh`。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test        # 完整报告写入 .tmp/app-m0-validation/tests.tap
pnpm build
pnpm desktop     # 从仓库启动开发版
```

- `pnpm smoke:runtime`：检查打包产物中的 Electron Node 运行时、原生 PTY 和输入输出。
- `pnpm smoke:desktop`：检查真实桌面窗口、键盘和重连，需要可用的桌面环境。

### 目录结构

| 目录 | 内容 |
| --- | --- |
| `apps/desktop/` | Electron 主进程、受限 preload 与 React 界面 |
| `packages/daemon/` | 会话 daemon：PTY 托管、回放日志、状态与用量 |
| `packages/protocol/` | App、daemon 与 CLI 共用的协议、客户端和平台差异 |
| `packages/cli/` | hook 上报、配置安装、`tarmac bridge` 与 `tarmac ctl` |
| `cmd/tarmac-native/` | Windows 进程辅助程序与 hooks 启动器（Go） |
| `docs/` | 使用指南、规格与设计 |

技术栈：Electron、React、TypeScript、xterm.js、node-pty、ssh2。

## 文档

- [Tarmac 使用指南](docs/tarmac-guide.md)
- [hooks 与用量接入](docs/app-hooks-usage.md)
- [远程主机规格](docs/app-remote-spec.md)
- [Windows 支持评估](docs/windows-support-assessment.md)
- 架构与规格：[App 方案](docs/app-architecture.md) 、[M0 规格](docs/app-m0-spec.md) 、[M1 多会话规格](docs/app-m1-spec.md) 、[M1 资源预算](docs/app-m1-resource-budget.md)
- [`tarmac ctl` 外部控制契约](docs/tarmac-ctl.md)
- [字体说明](docs/design/fonts.md)

## 已知限制

- 没有安装器、代码签名和自动更新；Linux 上只是复制到用户目录安装。
- 当前不支持 macOS。代码里保留了部分 macOS 分支，但没有在真机上验证过，也不打 macOS 包。
- Linux 只在 Ubuntu 24.04 上验证过，Ubuntu 22.04 等其他发行版尚未验证。
- Codex 默认连接共享后台，Tarmac 只在能唯一确定对应关系时才显示它的状态和用量，否则显示「运行中」。

## 许可证

Tarmac 的代码以 [MIT 许可证](LICENSE) 发布。

打包分发的字体不在 MIT 许可范围内，各自遵循原有许可，许可文件随字体放在 `apps/desktop/assets/fonts/`：

- Ubuntu Sans Mono 与 Ubuntu：Ubuntu Font Licence 1.0（`ubuntu-font-licence.txt`）。
- MiSans：[MiSans 字体知识产权许可协议](https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf)（`misans-license.pdf`）。Tarmac 使用了 MiSans 字体，标题栏 Tarmac 名称的悬停提示中注明了这一点。

## 致谢

Tarmac 基于 [Electron](https://www.electronjs.org/) 、[xterm.js](https://xtermjs.org/) 、[node-pty](https://github.com/microsoft/node-pty) 、[React](https://react.dev/) 与 [ssh2](https://github.com/mscdex/ssh2) 构建。
