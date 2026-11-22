# Tarmac App 方案

> 状态：M0 已获准实施（2026-11-13），完整重写尚未定案。现有 TUI 保留；App 原型独立开发，现有 Go 代码不作为复用前提。评审后的执行规格见 [M0 规格](app-m0-spec.md) ，与本文早期提案有差异时以该规格为准。
> 调研来源见文末，其中第三方资料未经官方文档逐项核实的已标注「待确认」。

## 1. 目标与范围

- 保留现有核心体验：左栏按目录分组管理会话，中栏与 agent 原生终端交互，右栏展示已发送消息历史；同目录可并行多个不同类型的 agent。
- 中栏必须是真终端：agent 的输出字节原样送达终端模拟器，键盘输入原样送达 agent，不截屏、不转发重绘。
- 关闭 App 后 agent 继续运行，重新打开可恢复画面。
- 目标平台：macOS 与 Ubuntu（22.04 / 24.04），中文输入法是一等公民。

## 2. 结论

采用 **Electron + TypeScript 全栈 + 独立会话守护进程（daemon）**：

- 界面：Electron（Chromium）+ React，中栏用 xterm.js（WebGL 渲染）。
- 进程托管：daemon 用 node-pty 持有每个 agent 的 PTY，与 App 进程分离；每个会话配一个 `@xterm/headless` 应答终端查询，并配一份字节回放日志用于重连恢复。
- 状态判断：以 Claude Code / Codex 官方 hooks 事件为主，进程探测确认生命周期；证据不足时显示运行中，不从普通输出或静默时间推定授权结束。不解析各家未公开的 transcript 格式，不靠截屏识别。
- 不使用 tmux。

同构先例：Superset（Electron + node-pty + xterm.js + 独立 daemon，daemon 内每会话一个 headless xterm），Wave Terminal（Electron + Go 后端）。

## 3. 关键选型

### 3.1 进程托管：自建 daemon，不用 tmux

在 App 形态下 tmux 只剩「进程常驻」一项价值，却带来两个问题：

1. **多一层终端模拟**：agent 实际面对的是 tmux 的模拟器，tmux 再重绘给前端。扩展按键（Shift+Enter）、kitty 键盘协议、OSC 52 剪贴板、超链接、图片、同步输出等能力受 tmux 版本与配置限制，3.2a 支持更少。
2. **稳定性与兼容成本**：现有 TUI 版本遇到的 tmux server 崩溃、`%output` 触发崩溃、3.2a 缺 `pane_start_path` 等问题会原样带入。

tmux 现有职责在 daemon 中的替代：

| 现在靠 tmux | daemon 中的替代 |
|---|---|
| 进程常驻 | daemon 独立运行，App 关闭不影响 |
| `capture-pane` 截屏 | 每会话 headless xterm 提供画面快照 |
| `pane_current_path` | Linux 读 `/proc/<pid>/cwd`；macOS 用 `proc_pidinfo` 或 `lsof` |
| 前台进程探测 | PTY 前台进程组（node-pty 提供前台进程名） |
| 退出码 | daemon 直接 `wait` 子进程 |
| 重连恢复画面 | 输出／尺寸字节日志回放给新连接的 xterm.js；日志过长时经探针验证后以 serialize 结果压缩基点 |

其他候选的取舍：

| 方案 | 结论 |
|---|---|
| tmux attach | 可用，但中间多一层模拟，坑一并带入 |
| zellij | 缺少 control mode 那样的编程接口 |
| dtach / abduco | 只常驻、不维护屏幕状态，无法快照与恢复 |
| shpool | 能常驻和恢复画面，但为外部 Rust 程序，控制接口不贴合 |

### 3.2 界面框架：Electron，不用 Tauri

- Tauri 在 Linux 上用 WebKitGTK。其底层 wry 在 Linux 上无条件关闭输入法内联预编辑，可选开启的 PR（tauri-apps/wry#1724）截至 2026-05 未合并；WebKitGTK 在 NVIDIA 上另有已知渲染问题。对中文用户、Ubuntu 为目标平台是硬伤。
- Electron 在 Linux 用 Chromium，xterm.js 的 WebGL 渲染与输入法经 VS Code 大规模验证。代价是包体与内存，开发工具可接受。
- 原生渲染（libghostty）暂不可行：2026-11-06 发布 1.0 的只是 libghostty-vt（序列解析与终端状态），渲染与 GTK / macOS 嵌入控件尚无稳定版。

### 3.3 语言：TypeScript，不用 Go，也不用 Rust

**不用 Go**：推翻重写后复用现有代码的理由消失；Go 侧只有实验阶段的 `charmbracelet/x/vt` 或经 cgo 接 libghostty-vt，与前端 xterm.js 是不同模拟器，重连恢复可能有差异。TypeScript daemon 可用与前端同一模拟器（`@xterm/headless` + serialize），且全栈一种语言、一套构建。

**不用 Rust**：

1. 决定成败的是 Linux 界面与中文输入，Rust 的两条路都不理想：Tauri 受 WebKitGTK 限制；原生 Rust GUI（GPUI、egui、iced、基于 winit 的方案）需自行处理字体回退、宽字符与输入法，winit 系在 Linux 上的输入法问题由来已久（如 Warp 在 Ubuntu 上中英切换失效）。Zed 在 Linux 中文输入上的情况未找到直接证据，待确认。
2. 界面定为 Electron 后，Rust daemon 收益有限：负载是十几个 PTY、每秒数 KB 的轻量 IO，用不上 Rust 的性能；反而失去同一模拟器的精确恢复（需自写 `alacritty_terminal` 状态到转义序列的导出），并多一种语言与工具链。
3. 决定可逆：daemon 是独立进程、只通过 socket 协议与界面通信。若实测会话多时 headless xterm 内存成瓶颈，可单独用 Rust + `alacritty_terminal` 重写 daemon，协议与界面不变。

值得选 Rust 的情形：要做不依赖网页内核的原生终端界面（待 libghostty 渲染与控件库稳定后重评）；daemon 需托管几十个会话且实测出现瓶颈；需要极小的单文件组件（如 hook 客户端、远端 agent），这类组件可单独用 Rust 或 Go。

### 3.4 状态判断：hooks 为主

| 来源 | Claude Code | Codex | 用途 |
|---|---|---|---|
| hooks 事件 | `UserPromptSubmit`、`Notification`、`PermissionRequest`、`Stop`、`SessionStart` 及适用的工具／失败事件 | `UserPromptSubmit`、`PermissionRequest`、`Stop`、`SessionStart`、`Interrupt` 及适用的工具事件；按安装版本实测 | 事件经关联后更新状态；用户提交作为右栏输入记录，不承诺模型已接受 |
| 进程探测 | PTY 前台进程组 | 同左 | Shell 内启动了哪个 agent、是否退出 |
| 进程存活但无可靠事件 | 运行中 | 运行中 | Kimi、Antigravity 等无 hooks 的 agent 不推断精细状态 |

该方案避开 transcript 解析及截屏误判，但 hooks 缺失、迟到、并发和信任状态仍需验证，不能承诺所有路径都可精确判断。

## 4. 架构

```
┌─ Electron 界面进程（React + xterm.js，WebGL）─────────────────┐
│ 左栏：项目 / 会话 / 状态 / 未读  中栏：xterm.js  右栏：消息历史 │
└───────────────┬──────────────────────────────────────────────┘
                │ Unix socket，逐行 JSON（订阅输出、输入、尺寸、命令）
┌───────────────▼─ daemon（Node，与界面分离，App 关闭仍运行）───┐
│ 会话管理：node-pty × N，每会话一个 headless xterm（画面快照） │
│ hooks 接收：`tarmac hook <event>` → 对应会话的状态机           │
│ 进程探测：前台进程、当前目录、退出码                          │
│ 存储：会话注册表、消息历史、最近项目（JSON 或 SQLite）        │
└───────────────┬──────────────────────────────────────────────┘
                ▼
     claude / codex / shell …（每个是一个 PTY 子进程）
```

### 4.1 关键设计

- **daemon 运行方式**：Electron 可执行文件以 `ELECTRON_RUN_AS_NODE=1` 当普通 Node 运行 daemon（Superset 同做法），无需另装 Node。
- **会话归属**：daemon 启动 PTY 时注入 `TARMAC_SESSION_ID`；hook 命令据此把事件归入会话，变量不存在时直接退出，普通终端中的 agent 不受影响。
- **hooks 安装**：写入用户级 `~/.claude/settings.json`、`~/.codex/config.toml`，Shell 内手动启动的 agent 也能上报；按项目红线须用户逐项确认且可卸载。备选为启动时以 `claude --settings` 注入（只叠加不覆盖），但覆盖不了 Shell 内手动启动的 agent。
- **画面恢复**：M0 实测 serialize 快照会丢失滚动区、保存光标、字符集等状态，改为字节日志回放：前端从基点按序重放输出和尺寸变化，追到 attach 时的日志末尾后才允许输入；慢连接按 ack 节流、落后于基点时重新 attach。日志超阈值时只在探针验证一致后压缩基点，无法验证且达到上限时标记恢复降级。细节与预算见 `docs/app-m0-spec.md`。
- **输入记录**：daemon 追加日志保存接入后提交，独立保存阅读位置；旧会话不自动补齐，resume 继续同一 agent 会话记录。hooks 配置存在不等于已启用，必须显示当前运行实例的接入验证状态。
- **重启后恢复**：`SessionStart` 事件携带 agent 自身 `session_id`；daemon 退出或机器重启后，左栏可一键 `claude --resume <id>` / `codex resume <id>`。
- **快捷键与通知**：快捷键由 App 管理，不再与 tmux 根表冲突；后台会话需要授权或结束时发系统通知并在托盘显示角标。

### 4.2 仓库结构（pnpm monorepo）

```
apps/desktop/        Electron 主进程 + 界面（React）
packages/daemon/     daemon：PTY、hooks、状态机、存储
packages/protocol/   界面与 daemon 共享的消息类型
packages/cli/        tarmac hook / tarmac ctl
```

## 5. 风险与验证关卡

| 风险 | 验证方式 |
|---|---|
| xterm.js 中文输入法：长期 CJK 问题（xtermjs#4486）；6.x 组字结束延迟提交，快速输入可能乱序 | Ubuntu 上 fcitx5 / ibus、macOS 系统拼音，在真实 Claude 中快速输入中英混排 |
| Linux 输入法普遍问题（Electron 系的 Cursor 也有报告） | 同上，并对照 VS Code 终端表现 |
| Shift+Enter 等扩展按键 | 应用层拦截并发送对应序列，真实 Claude / Codex 验证换行 |
| hooks 行为：Claude `--settings` 合并而非覆盖；Codex `PermissionRequest` 实际是否触发、`UserPromptSubmit` 载荷是否含输入原文（待确认） | 真实 agent 逐个触发事件，记录载荷 |
| node-pty 原生模块与 Electron ABI 匹配 | macOS 与 Ubuntu 打包后实测 |
| hook 命令启动耗时（Electron 当 Node 运行约一两百毫秒，待实测） | 实测；过慢则改用极小的 socket 客户端 |
| 重连恢复保真度 | 关闭并重开 App，对比 Claude / Codex 画面 |

## 6. 分阶段

1. **M0 技术原型（准入关卡）**：Electron + daemon + 一个连接真实 Claude / Codex 的中栏；逐项验证第 5 节风险及关闭重开后的画面恢复。不通过则回到选型。
2. **M1**：多会话、左栏按目录分组、新建会话、注册表持久化。
3. **M2**：hooks 驱动状态、未读数、右栏消息历史、系统通知。
4. **M3**：重启后恢复会话；打包（macOS .dmg，Ubuntu .deb / AppImage）。macOS 对外分发需 Apple 开发者账号签名与公证。

## 7. 立项前须确认的差异化

同类产品已不少：Superset（Electron，开源）、Conductor（仅 macOS）、Traycer、CodeAgentSwarm，Claude Code 桌面端也支持并行会话。Tarmac 自研的理由应是：原生终端优先、同目录并行多 agent 且不强制 worktree、轻量、Linux 与中文输入法一等公民。若这些不是核心诉求，直接使用 Superset 更划算。

## 8. 调研来源

- [wry PR #1724：Linux IME preedit 可配置](https://github.com/tauri-apps/wry/pull/1724)
- [Tauri Linux Graphics Issues](https://v2.tauri.app/develop/debug/linux-graphics/)
- [xterm.js CJK IME issue #4486](https://github.com/xtermjs/xterm.js/issues/4486)
- [Wave Terminal PR #2938（xterm.js v6 组字时序）](https://github.com/wavetermdev/waveterm/pull/2938)
- [Superset terminal daemon deep dive](https://superset.sh/blog/terminal-daemon-deep-dive)
- [Superset 架构评述（第三方）](https://rywalker.com/research/superset)
- [Introducing Wave Terminal](https://blog.waveterm.dev/introducing-wave-terminal)
- [Evaluate libghostty-vt 1.0 · wietty #79](https://github.com/kloostermanw/wietty/issues/79)
- [libghostty 官方 API 文档](https://libghostty.tip.ghostty.org/)
- [libghostty-gtk](https://github.com/arsfeld/libghostty-gtk)
- [charmbracelet/x（含 vt 包）](https://github.com/charmbracelet/x)
- [unixshells/vt-go（指出上游缺少 IRM）](https://pkg.go.dev/github.com/unixshells/vt-go)
- [Zed terminal crate README（alacritty_terminal + GPUI）](https://git.secluded.site/zed/blob/v0.52.0/crates/terminal/README.md)
- [winit IME issue #1497](https://github.com/rust-windowing/winit/issues/1497)
- [Warp：Ubuntu 上 Left Shift 切换输入法失效 #11524](https://upd.dev/warpdotdev/warp/issues/11524)
- [Cursor Linux 中文输入问题](https://forum.cursor.com/t/unable-to-input-chinese-characters-directly-in-cursor-input-fields/153426)
- [Claude Code Hooks 官方文档](https://code.claude.com/docs/en/hooks)
- [Claude Code settings reference（--settings 优先级）](https://code.claude.com/docs/en/settings-reference)
- [--settings 合并而非覆盖 hooks（anthropics/claude-code#11392）](https://github.com/anthropics/claude-code/issues/11392)
- [Codex Hooks 官方文档](https://developers.openai.com/codex/hooks)
- [Codex Advanced Configuration](https://developers.openai.com/codex/config-advanced)
- [Codex CLI Hooks Graduate to Stable v0.124（第三方）](https://codex.danielvaughan.com/2026/04/23/codex-cli-hooks-graduate-stable-v0124-mcp-observation-inline-config/)
- [Codex CLI v0.150/v0.151 生命周期事件（第三方）](https://codex.danielvaughan.com/2026/09/02/codex-cli-v0150-v0151-interrupt-hooks-mcp-tool-result-extension-architecture/)
- [Tauri 2.0 Stable Release](https://v2.tauri.app/blog/tauri-20/)
- [Wails v3 Beta 公告](https://docs-preview.wails.io/blog/wails-v3-beta/)
- [并行 agent 工具对比（第三方）](https://traycer.ai/compare/best-parallel-coding-agent-tools)
