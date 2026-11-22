# Windows 支持评估

日期：2026-11-18

本文记录 Tarmac 桌面 App 的 Windows 支持路线、改造范围和实施现状。2026-11-18 起 Tarmac 的 Windows 适配已按本文方案写入代码（见「实施现状」），但还没有在 Windows 或 WSL 实机上运行过，因此 **Windows 目前仍不算受支持平台**。

## 结论

- 改造前 Tarmac 不能直接在原生 Windows 上运行。
- 向 Windows 用户交付原生产品时，Electron、React、xterm.js 和 node-pty 可保留，不需要重写界面和终端协议。
- Tarmac 的适配应分为 Shell MVP、agent 完整支持和正式发布三个阶段。主要难点是 Windows 进程、目录和会话归属识别，而不是 Electron UI。

## 改造前状态与依据

以下是 2026-11-18 实施前的源码检查结果，用来说明各项改造的原因。

| 产品 | 原生 Windows 状态 | 主要依据 |
| --- | --- | --- |
| Tarmac | 不可直接运行 | UI 和 PTY 有跨平台基础，但 daemon 启动、IPC、租约、进程识别和 hooks 仍有 Unix 假设 |

Tarmac 的可复用部分：

- Electron 主进程、受限 preload、React renderer 和 xterm.js 不因 Windows 而需要重写。
- `packages/daemon/src/session.ts:107` 已通过 node-pty 创建 PTY，可在此基础上增加 Windows ConPTY 参数和生命周期验证。
- `app.getPath('userData')` 已用于桌面数据目录，可继续作为 Windows 数据目录来源。

Tarmac 的直接阻塞包括：

- `apps/desktop/src/main.ts:182` 默认 Shell 为 `/bin/sh`，`apps/desktop/src/renderer.tsx:312` 固定传入登录 Shell 参数 `-l`。
- `packages/daemon/src/server.ts:41` 使用 Unix socket 路径，`packages/daemon/src/server.ts:51` 使用 UID 和 `chmod` 检查目录所有权与权限。
- `packages/daemon/src/lease.ts:19` 调用 `ps`，租约还依赖 UID、权限位和符号链接。
- `packages/daemon/src/process.ts` 使用 `ps`、`/proc`、`lsof` 和 Unix 前台进程组。
- `packages/cli/src/hook.ts:99` 的 hook 进程祖先识别只有 Linux 和 macOS 实现。
- `scripts/app-m0-runtime.mjs` 的默认产物路径、可执行文件路径和 PTY 烟测命令仍按 Linux／macOS 编写。

## 路线选择

### 原生 Windows：Tarmac 产品化路线

建议首版目标限定为 **Windows 11 x64＋PowerShell**，完成后再决定是否扩展 Windows 10、ARM64、cmd 和原生 WSL 会话。这里的目标只是实施建议，尚未成为项目已确认的平台承诺。

## 原生 Windows 改造清单

### 1. Shell、ConPTY 与进程生命周期

- Windows 默认使用 `powershell.exe`，可选择优先探测 `pwsh.exe`，必要时回退到 `%COMSPEC%`。
- 将 Shell 路径和启动参数一起按平台生成，Windows 不传 `-l`。
- 验证 node-pty ConPTY 的创建、输入输出、resize、UTF-8、中文输入法、粘贴、颜色和特殊按键。
- 验证 `.exe`、`.cmd`、Node 启动器以及 PATH 查找行为。
- 验证关闭会话和退出 App 时整个进程树都能结束，不能只关闭 PowerShell 而遗留 agent。
- 保持现有限定：只操作当前 Tarmac 数据目录托管的会话，不按进程名结束外部终端或其他程序。

阶段结果：支持 PowerShell、会话创建、切换、重连、窗口缩放和退出管理的 Shell MVP。

### 2. IPC、权限和 daemon 单实例租约

- Windows 使用命名管道，例如 `\\.\pipe\tarmac-<用户>-<数据目录哈希>`。
- 客户端、daemon 和 hooks 共用同一个平台地址生成函数，避免各处分别拼接。
- 使用 Windows ACL 限制为当前用户，不能照搬 `chmod 0600`。
- 重新实现单实例租约、进程身份校验和崩溃恢复，使用 Windows 可用的原子锁与进程创建时间，防止 PID 重用误判。
- 不依赖管理员权限或开发者模式创建符号链接。
- 分别处理命名管道不存在、已有活跃 daemon、旧 daemon 无响应和异常残留等状态。

### 3. Windows 进程与 agent 识别

- 通过 Windows API、CIM／WMI 或原生辅助程序获取 PID、父 PID、命令行、可执行文件和进程创建时间。
- 识别原生 `.exe`、Node／Python 入口、npm 启动器及 Claude／Codex／Kimi／agy 子进程。
- 保留进程创建时间作为身份的一部分，避免 PID 重用后误绑 transcript 或租约。
- 重新设计“当前前台 agent”的判定，不能直接套用 Unix 的 `tpgid／pgid` 语义。
- 单独解决实时工作目录跟踪。Windows 没有与 `/proc/<pid>/cwd` 等价的稳定通用接口，优先考虑 Shell 集成上报目录，进程树只能作为辅助证据。
- 无法可靠识别时明确降级为「运行中／已退出」，不能猜测 agent、目录或会话归属。

### 4. Hooks、transcript 与用量

- 当前安装命令中的 `env ELECTRON_RUN_AS_NODE=1 ...` 是 Unix 写法；Windows 优先随包提供 `.cmd` 启动器，统一处理 Electron Node 模式和参数 quoting。
- hooks 中的 socket 地址改为平台 IPC 地址，并验证环境变量能传入各 agent 的 hook 进程。
- 为 `packages/cli/src/hook.ts` 增加 Windows agent 祖先识别。
- Claude 优先验证 `agents --json` 与 hooks 的精确会话 ID 关联。
- Codex 优先验证 hooks 和 rollout 关联，不依赖 `/proc/<pid>/fd` 或 `lsof`。
- Kimi 继续以精确 hook session ID 关联 `wire.jsonl`。
- token-tracker 的 XDG 缓存路径按实际 Windows 支持情况适配；不可用时显示「暂无数据」，不伪造配额。
- 原生 Windows 不显示 Unix `shell-rc` 的 tmux 自动接管修复卡片；若以后支持 WSL 会话，应在 WSL 内独立处理。
- 各 agent 的 Windows 版本、hooks 事件、配置格式和共享后台行为必须分别实测，不能由 Linux 结果推断。

### 5. 路径与数据兼容

- 审核 transcript 匹配、项目分组、目录去重和路径比较中的 `/`、`\`、盘符与 UNC 路径。
- Windows 路径比较按平台处理大小写，但保存和展示保留原始路径。
- 覆盖路径空格、中文目录、OneDrive、长路径和不同盘符。
- 保留配置 plan → apply、备份和卸载语义，不能为了 Windows 简化成静默修改用户配置。

### 6. 打包与发布

- 在 Windows 上安装和构建 Windows x64 的 Electron 与 node-pty 原生模块，并验证打包产物而非只验证开发环境。
- 调整运行时和桌面烟测中的 Linux 默认产物路径、可执行文件名、Shell 命令与信号处理。
- 增加 Windows 可执行文件图标； unpacked 目录可用于首版验证。
- 安装器、签名、卸载和自动更新属于正式发布阶段，不作为 Shell MVP 的前置条件。

## 分阶段验收

### 阶段一：Shell MVP

必须跑通：

- `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm build`。
- Windows 打包产物的 Electron Node 运行时和原生 PTY 烟测。
- PowerShell 创建、输入、中文、粘贴、resize、多会话切换、断线重连和选中项恢复。
- 取消退出保留会话，确认退出只结束本 daemon 托管的进程树。
- App 崩溃或意外断线后 daemon 保留并可重连。

本阶段可以明确不包含 agent 状态、token、配额和完整目录跟踪，但必须在界面和文档中说明降级范围。

### 阶段二：agent 完整支持

- Windows 进程树与 agent 身份识别。
- 实时目录分组、Git 分支和历史项目。
- Claude／Codex／Kimi 的真实 hooks、输入记录、状态、transcript 和 token。
- 同目录多个相同或不同 agent 的归属隔离。
- 快速切换、重连和 `/clear`／resume 后不错绑会话。
- agy 按其 Windows 实际能力提供原生终端交互或明确降级。

### 阶段三：正式发布

- 安装、升级、卸载、图标、签名和 Chromium 正常沙箱。
- 真实 Windows 桌面上的完整回归与资源复测。
- README、安装说明、平台范围和故障排查同步更新。

## 测试改造要求

现有测试包含大量 POSIX Shell、shebang、Unix socket、UID、权限位和信号假设，不能仅以现有 Linux 测试通过作为 Windows 验证结果。需要：

- 把纯解析和状态机测试保持为跨平台测试。
- 将 Unix 专属测试明确隔离，并为 Windows 增加对应实现测试。
- 用平台无关 fixture 替换不必要的 `/bin/sh` 和 shebang 依赖。
- 在 Windows 真实桌面运行打包产物烟测，不能用 WSL 结果代替原生 Windows 结果。
- 沿用现有多会话压力、重连、退出保护和资源预算场景。

## 采用的默认决策

以下各项先按推荐方案实施，之后可以调整：

- 首版只支持 Windows 11 x64，打包脚本拒绝 `--arch` 不是 x64 的 Windows 包。
- 默认 Shell 优先 PowerShell 7（PATH 中的 `pwsh.exe`），其次是系统自带的 Windows PowerShell，最后回退到 `%ComSpec%`。
- 首版不支持在 Tarmac 中直接创建 WSL 会话。
- 实时目录跟踪由原生辅助程序读取进程 PEB 完成，不依赖 Shell 集成。
- 发布形式先用 unpacked 目录（或手工压缩成 zip），安装器、签名和自动更新后续再定。

## 实施现状

已完成（只经过 Linux 上的类型检查、单测和交叉打包，Windows 上未运行）：

| 检查点 | 内容 | 位置 |
| --- | --- | --- |
| W1 平台层 | IPC 地址、token、文件归属判断集中在一处；POSIX 行为保持不变 | `packages/protocol/src/platform.ts` |
| W2 IPC 与租约 | Windows 用 `\\.\pipe\tarmac-<用户和数据目录的哈希>`；独占绑定管道即为单实例租约，绑定成功后才读取 journal 和注册表；daemon 每次启动生成 token 写入 `daemon.token`，客户端第一个请求必须是 `auth`，通过前收不到任何帧（包括 `info` 广播）。PTY 内通过 `TARMAC_TOKEN` 把 token 传给 hooks | `packages/daemon/src/server.ts`、`packages/protocol/src/client.ts` |
| W3 Shell 与打包 | 默认 Shell 与参数一起生成，PowerShell 启动时把控制台编码设为 UTF-8；daemon 以 `windowsHide` 启动；`node scripts/app-m0.mjs package --platform win32` 可以在 Linux 上交叉打包（node-pty 自带 Node-API 的 win32-x64 prebuild，并剔除宿主平台的 `build/`）；打包后的运行时烟测 `smoke:runtime` 在 Windows 上改用 PowerShell 用例 | `packages/protocol/src/shell.ts`、`scripts/app-m0.mjs`、`scripts/app-m0-runtime.mjs` |
| W4 进程识别 | `tarmac-native proc` 常驻进程，通过 JSON 行提供进程快照（Toolhelp32，含创建时间）以及命令行（`ProcessCommandLineInformation`）、可执行文件路径和 PEB 中的工作目录（仅限同一用户的 64 位进程）。daemon 断开启动时间晚于子进程的父进程链接（PID 重用），前台按广度优先选 agent，同级多个 agent 时退回 Shell，没有 agent 时沿单链取最深的程序，忽略 `conhost` 和 `OpenConsole` | `cmd/tarmac-native/`、`packages/daemon/src/winproc.ts`、`packages/daemon/src/process.ts` |
| W5 hooks | hook 在 Windows 上上报自己的 PID，由 daemon 反查最近的同类 agent 祖先；hooks 命令为 `"<安装目录>\resources\app\dist\native\tarmac-native.exe" cli hook <provider>`，在 Git Bash、PowerShell 和 cmd 下都是同一个 exe；`desktop-entry.mjs install --package` 在 Windows 上安装到 `%LOCALAPPDATA%\Programs\Tarmac` 并创建开始菜单快捷方式；会话强制结束改用 `taskkill /T /F` | `packages/cli/src/hook.ts`、`packages/daemon/src/session.ts`、`scripts/desktop-entry.mjs` |

Windows 上会降级的部分：

- 打开文件句柄查找 transcript 的方式（`openTranscript`）在 Windows 上不可用；Claude、Kimi 依赖 hook 中的精确会话 ID，Codex 依赖 rollout 关联。
- 读不到工作目录的进程（其他用户、提权进程或 32 位进程）沿用启动目录。
- `shell-rc` 的 tmux 接管修复卡片在 Windows 上不会出现。
- 桌面烟测（`renderer.tsx` 中的 M0 用例）仍使用 `/bin/sh`，只在 POSIX 上运行。

未开始：W6 正式发布（exe 图标需要 Windows 上的 rcedit 或 wine，以及安装器、签名、自动更新）。

## W0 实机检查清单

每一项都需要在真实的 Windows 11 x64 上记录结果；不通过时退回对应检查点修改，不能用 WSL 的结果代替。

1. 打包与启动：在 Linux 上执行 `node scripts/app-m0.mjs package --platform win32`（需要 Go，可以通过 `TARMAC_GO` 指定），把 `dist/package/Tarmac-win32-x64` 复制到 Windows；在 Windows 上执行 `node scripts/app-m0-runtime.mjs <包目录>`，确认 Electron Node 模式、ConPTY、输入和关闭都正常。
2. 单实例：同一数据目录先后启动两个 daemon，第二个应报 `another live daemon owns this data directory`；强制结束第一个后，新的 daemon 能立即启动。
3. 管道权限：用另一个 Windows 账户以只读方式连接管道，应收不到任何数据；token 不正确时连接被断开。
4. Shell：PowerShell 7 和 Windows PowerShell 下分别检查中文输出、中文输入法、粘贴、resize、颜色和特殊按键；native 程序（git、node）输出的中文没有乱码。
5. 进程识别：在 Shell 中运行 `claude`（npm 安装的 `.cmd` 和原生 exe 各一次）、`codex`（核对原生子进程名是否为 `codex.exe`）和 `kimi`，左栏品牌、cwd 跟随 `cd` 变化、Git 分支都正确；同目录开两个 agent 时归属互不串扰。
6. hooks：确认 Claude、Codex、Kimi 的 Windows 版各自用哪个 Shell 执行 hook 命令、`TARMAC_*` 环境变量能否传进去、`tarmac-native.exe cli` 的 stdout 能否回到 agent；hook 状态显示为 verified，`hook-failures` 为空。
7. 退出：关闭会话、确认退出和取消退出时，确认进程树全部结束、没有残留 agent，也没有误杀 Tarmac 以外的进程；App 崩溃后 daemon 存活并能重连。
8. 窗口：daemon 和辅助程序启动时不弹出控制台窗口；`titleBarOverlay` 的窗口按钮可用。
