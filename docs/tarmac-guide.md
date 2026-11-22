# Tarmac 使用指南

本文是 Tarmac 桌面 App 的完整使用说明。概览和快速开始见 [README](../README.md) 。

## 安装与升级

### Linux

先退出 Tarmac，然后在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm package:local
pnpm desktop:entry install --package
```

`pnpm package:local` 生成 `dist/package/Tarmac-linux-x64/`；`pnpm desktop:entry install --package` 把它复制到 `~/.local/opt/tarmac/`，并安装启动项 `~/.local/share/applications/tarmac.desktop` 与图标 `~/.local/share/icons/tarmac.svg`。之后重建或移动仓库都不影响已安装的 App。升级时重复这三步。

- GNOME 的 Dock 只为匹配到桌面启动项的窗口显示图标；Tarmac 窗口的 `WM_CLASS` 为 `tarmac`，与启动项的 `StartupWMClass` 对应。
- 安装脚本会输出 hook 命令前缀：`env ELECTRON_RUN_AS_NODE=1 '<安装目录>/Tarmac' '<安装目录>/resources/app/dist/cli.cjs'`，即用 App 自带的 Electron 以 Node 模式运行包内 CLI，不依赖系统 Node。
- 在 xrdp 等没有 GPU 的远程桌面下，启动项会设置 `LP_NUM_THREADS=2`，限制软件渲染占用的 CPU。
- 卸载：`pnpm desktop:entry uninstall --package` 会同时删除安装目录。执行前先卸载指向这个目录的 hooks（见「一键安装 hooks」）。
- 打包时即使 Electron 压缩包已经缓存，仍要联网下载 `SHASUMS256.txt` 做校验。没有网络时设置 `TARMAC_ELECTRON_ZIP_DIR=<含 electron-v版本-平台-架构.zip 的目录>`（例如 `~/.cache/electron/` 下的哈希目录），改用本地压缩包并跳过校验。

只安装开发版启动项（指向仓库构建产物，带 `--no-sandbox`，仅用于本机开发）：`pnpm desktop:entry install`，删除用 `pnpm desktop:entry uninstall`。

### Windows 11 x64

Windows 包目前在 Linux 上交叉打包：

```bash
node scripts/app-m0.mjs package --platform win32
```

需要 Go 1.25 或更新版本，用于编译 Windows 进程辅助程序 `tarmac-native.exe`；Go 不在 PATH 中时用 `TARMAC_GO=<go 路径>` 指定。产物为 `dist/package/Tarmac-win32-x64/` 与 `dist/package/Tarmac-win32-x64.zip`，复制到 Windows 解压后运行 `Tarmac.exe`。默认 Shell 为 PowerShell。

## 会话与界面

一个 daemon 同时托管多个独立的 PTY。左栏按会话的实时目录分组，显示全部存活会话，同一目录可以同时运行多个相同或不同的 agent。

- 点击会话切换终端，进程不重启。每个存活会话在后台常驻一个终端并持续接收输出，切换只换显示，不会从头回放。
- `Ctrl+Shift+N` 在当前会话的目录新建 Shell，在 Shell 里启动 `claude`、`codex`、`kimi` 或 `agy`。
- `Ctrl+Shift+H` 显示或隐藏右栏的输入记录与会话诊断。
- 每个项目可以单独折叠。「历史项目」列出打开过、当前没有会话的目录，单击在该目录新建 Shell；标题右侧的「清除」在 3 秒内点两次，清空该主机的历史项目，正在打开的目录保留。
- App 重开后优先恢复仍存活的选中项。

每个会话独立维护终端、控制权、状态、输入记录、未读与用量。在 Shell 中启动的 agent 退出后，左栏恢复显示 Shell；Shell 自身退出后，会话从当前任务移除。同一 agent 会话被多个 PTY 同时打开、用量无法拆分时，暂时隐藏用量。

### 关闭与后台

- 最小化 App 会继续运行。
- 关闭最后一个窗口或退出 App 时，如果还有运行中或正在创建的会话，会提示「结束会话并退出」：确认后结束当前 daemon 及其托管的全部 Shell 和 agent，取消则继续运行。
- 多个窗口共享同一 daemon 时，关闭其中一个只断开该窗口。外部终端和其他数据目录的会话不受影响。
- App 崩溃或意外断线时保留 daemon，再次打开即可重连。服务无法连接时，可以选择仅退出 App、保留后台。
- daemon 退出或机器重启后不保留原进程，只保留已持久化的记录与元数据，不会自动 resume。

## agent 识别、状态与用量

| agent | 识别 | 状态 | 输入记录 | token | 额度 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 进程 | hooks | hooks | 会话日志 | token-tracker 状态缓存或 statusLine 转发 |
| Codex | 进程，含 `-p`／`--profile` | 共享后台下按 rollout 关联；`--no-daemon` 时用 hooks | rollout 补录或 hooks | rollout | rollout 中的配额快照 |
| Kimi | 进程（`kimi-code`、Node 入口、旧 Python CLI） | hooks，`wire.jsonl` 补充轮次结束 | hooks | `wire.jsonl` | 账户接口 `/usages`（5h／7d／月） |
| Antigravity（`agy`） | 进程 | hooks（工作中／等待输入／中断／失败） | hooks | hook 给出的会话记录 | 不显示 |

- 没有接入 hooks 或无法准确关联时，状态降级为「运行中」，不显示推测的数据。
- 状态有：工作中、等待输入、空闲（等待输入持续 2 分钟没有新活动）、等待授权、运行中、已退出。agy 不提供授权事件，不显示「等待授权」。
- Codex 会显示 profile 名，例如 `codex -p deepseek` 显示为 `Codex · deepseek`。Tarmac 不新增或改写 shell 别名，不读取 profile 中的凭据。
- Codex 默认连接共享后台，hooks 不会送达。Tarmac 不自动添加 `--no-daemon`，而是按唯一证据（启动时间窗，或回车后 5 秒内开始的轮次）关联同目录的 rollout，并识别屏幕上的审批菜单显示「等待授权」；有歧义时不关联。
- Claude 未保持日志句柄时，通过其只读的 `agents --json` 按 PID 取得当前会话 ID。同一配置目录下的 Claude 会话共享账户额度快照，标注为共享。
- Claude 还可以用 `statusline claude --forward <已有命令>` 接入 statusLine：保留原有状态栏输出，同时向对应会话上报额度。

顶部显示当前会话的累计 token，悬停查看输入、输出和缓存的精确计数；额度显示使用比例和复位倒计时（`2d3h`、`4h18m`），悬停查看复位时间和快照时间。没有快照时显示「暂无数据」，到时后等待新快照，不推算已恢复的额度。配色沿用 token-tracker：token 橙色、窗口标签粉色、倒计时蓝色，额度比例在 50%／80% 处由绿变黄／红。

接入方式、隔离规则和每家的数据范围见 [hooks 与用量接入](app-hooks-usage.md) 。

## 标题栏系统信息

标题栏右侧显示当前会话所在机器的 CPU 占用、内存（已用／总量）、网络收发速率和本地时间（`HH:mm`），用「｜」分隔，例如 `2% ｜ 5.0/31.3G ｜ ↓ 18K ↑105K ｜ 07:26`。

- 本机会话显示本机，远程会话显示那台主机，没有选中会话时显示本机。数据由该机器的 daemon 提供，每 2 秒取一次，窗口隐藏时暂停。
- 悬停查看核数、内存比例、网速单位和时区。CPU 和内存在 70%／90% 处变黄／红。
- 网速只统计物理网卡，不含回环、容器、网桥和 VPN 隧道。Windows 暂不显示网速。
- 远程主机断开或对方 daemon 版本过旧时，数据和时间都不显示；本机 daemon 未连上时，本机时间照常显示。
- 窗口变窄时依次隐藏网速、内存和 CPU，时间始终保留。

## 一键安装 hooks

打包安装的 App 发现当前会话的前台是 Claude 或 Kimi，而配置里没有 Tarmac hooks（或 hooks 仍指向 App 移动前的旧路径）时，终端右下角会弹出卡片：

- 「查看安装方案」列出要修改的文件和条目，点「授权安装」后才会写入。
- 写入前先把原文件备份到数据目录下的 `hook-config-backups/`，只增删带 ` # tarmac-app` 标记的条目，卡片上可以撤销。
- Claude 写入 `~/.claude/settings.json`（或 `CLAUDE_CONFIG_DIR`），Kimi 写入 `~/.kimi-code/config.toml`（或 `KIMI_CODE_HOME`）。Kimi 配置文件不存在时不提供安装。
- hook 命令按 App 的安装位置生成；Windows 上为 `"<安装目录>/resources/app/dist/native/tarmac-native.exe" cli hook <agent>`。
- Codex 不提示，原因见上一节。statusLine 需要单独配置。
- 从仓库运行的 App 不提供安装。忽略后本次启动内不再提示；已在运行的 agent 要新开会话才会生效。

## Shell 启动时自动进入 tmux

如果 shell 启动文件里写了 `exec tmux` 一类的自动启动，Tarmac 终端一打开就会变成 tmux 客户端，agent 实际运行在 tmux 里，Tarmac 无法识别它的状态、用量和 hooks，左栏一律显示 Shell。daemon 检测到「终端启动的进程本身变成了 tmux 客户端」时，终端右下角会弹出提示卡片；手动在 shell 里启动 tmux 不算。

- **查看修复方案**：列出要改的文件和行，以及改动前后的内容。
- **授权修改**：在自动启动的条件里加上 `[[ -z "$TARMAC_SESSION_ID" ]]`，只在 Tarmac 的终端里跳过自动启动。
  - 修改前把原文件备份到数据目录下的 `shell-rc-backups/`，改动行带 `# tarmac-app` 标记。
  - 软链接的启动文件会修改链接实际指向的文件，链接本身保留。
  - 支持 zsh 和 bash。能自动处理的写法有：`if` 判断 `$TMUX` 的代码块、单行的 `[ -z "$TMUX" ] && exec tmux`、oh-my-zsh 的 `ZSH_TMUX_AUTOSTART=true`。其他写法只列出可疑行，由用户手动处理。
- **撤销修改**：卡片里可以撤销；之后也可以用 CLI：先执行 `shell-rc plan --operation uninstall` 生成计划，再执行 `shell-rc uninstall --plan <文件> --backup-dir <目录>`。

Tarmac 终端里设置了 `TERM_PROGRAM=Tarmac`，可以在自己的配置里据此识别 Tarmac。

## 远程主机

App 可以同时连接局域网内其他 Linux 机器上的 Tarmac（当前不支持 macOS 主机）。agent 留在那台机器上运行，App 只负责显示和输入。

### 添加

左栏点「＋ 添加远程主机」，填写地址、用户名和端口（或 `~/.ssh/config` 里的 Host 名）。「连接并检查」会依次检查 SSH 登录、对方是否装有 Tarmac、两端版本是否一致、daemon 是否在运行，全部通过才能添加。对方需要用 `pnpm desktop:entry install --package` 安装同一版本的 Tarmac；装在别处时填写「远端命令」。

### 首次连接

还不能免密登录的主机走首次连接：

1. 对话框显示对方的主机指纹，确认后保存。
2. 输入一次密码。Tarmac 在本机生成专用密钥，并把公钥追加到对方的 `~/.ssh/authorized_keys`（那一行只带 `tarmac-app` 标记，不含本机名称）。
3. 之后都用密钥登录，密码不保存。

首次连接需要填写 IP 或主机名，不支持 `~/.ssh/config` 里的别名。Tarmac 的 SSH 文件放在本机 `~/.ssh/`，统一以 `tarmac_` 开头：`tarmac_ed25519`、`tarmac_ed25519.pub`、`tarmac_known_hosts`，不改动已有的 `id_*` 和 `known_hosts`。已经配好免密登录（自己的密钥或 ssh-agent）的主机照常可用。主机指纹变化时拒绝连接并显示新旧指纹，重新确认后才替换。

### 工作方式

- 连接方式是执行系统 `ssh`，在对方运行 `tarmac bridge`：它把 stdio 与那台机器的 daemon socket 对接，daemon 没运行时先启动它，不开放任何新端口。
- bridge 启动的 daemon 不继承 SSH 会话的 `SSH_*` 变量，那台机器上的 agent 看不到本机 IP，本机的环境变量也不会传过去。
- 有远程主机时，左栏按主机分组（远程在前、本机在后），标题栏显示当前会话所在的主机。
- `Ctrl+Shift+N` 和点击历史项目都在对应主机上新建 Shell；选中远程会话时要在本机新建，用「本机」标题行 `⋯` 菜单的「新建 Shell」。
- 连接断开时，那台主机的会话显示「状态未知」、不能输入；App 自动重连，连上后恢复画面。
- 主机菜单可以新建 Shell、立即重连、断开、编辑或移除。移除不会结束对方的会话，可以勾选同时删除对方 `authorized_keys` 中 Tarmac 的那一行公钥。
- 退出 App 只结束本机会话，远程会话继续运行。
- 两个 App 同时连着同一台机器时，同一会话只由一边控制：另一边点到它时显示「这个会话正在另一个 Tarmac 窗口中操作」，点「在这里继续」才接管；后台加载不会抢走对方正在用的会话。
- hooks 和 Shell 启动文件的卡片只对本机会话出现，远程主机的 hooks 需要在那台机器上安装。

### 贴图

远程主机上的 agent 读不到本机的剪贴板，所以 Tarmac 替你把图片传过去：

- 在远程会话里截图后按 `Ctrl+V`：图片经已有的 SSH 连接传到那台机器，保存在它的 Tarmac 数据目录下，输入框里出现这张图片的路径。可以在路径前后补几句话，再自己回车发送。Claude Code 会按路径读取图片；其他 agent 至少能拿到路径，用自己的读文件工具查看。
- 剪贴板里是文字时，`Ctrl+V` 照常发给 agent。
- 也可以把图片文件拖进远程会话的终端，多张图片的路径以空格分隔。
- 支持 PNG、JPEG、GIF、WebP，单张不超过 20 MB。图片只保留到会话结束：会话的进程退出后删除，那台机器的 daemon 重启时也会清空。
- 本机会话不受影响，仍由 agent 自己读剪贴板。
- 两端都需要支持贴图的 Tarmac 版本；对方版本过旧时会提示升级。

传输、路由与界面规格见 [远程主机规格](app-remote-spec.md) 。

## 外部控制（`tarmac ctl`）

供同一用户的本机程序（例如消息机器人）查看和操控 Tarmac 会话，不会抢 App 的控制权：App 不会收到 resync，回放也不受影响。

```bash
env ELECTRON_RUN_AS_NODE=1 ~/.local/opt/tarmac/Tarmac ~/.local/opt/tarmac/resources/app/dist/cli.cjs ctl <子命令>
```

- 子命令：`list`、`screen`、`text`（正文从 stdin 读）、`key`（只接受 `Enter`／`Up`／`Down`／`Escape`）、`create`、`close`。
- stdout 只输出一行 JSON；失败时退出码为 1，并带错误码。
- 写入前，daemon 在处理请求时重新核对 `--expect-pid` 是否为前台进程。
- `--data-dir` 默认为 `~/.config/tarmac-app/m0`，继承来的 `TARMAC_*` 变量一律忽略。
- daemon 没运行时返回 `unavailable`，不会去启动它；旧版 daemon 返回 `unsupported`，需要重启 App。

## 数据目录与排错

- 数据目录为 `~/.config/tarmac-app`。PTY 环境变量使用 `TARMAC_*`，hook 与启动文件的改动标记为 `# tarmac-app`。
- daemon 主动断开连接时（帧超限、积压超限、请求无效），原因记在数据目录下的 `daemon.log`；hook 被拒收的原因也记在这里，只记错误信息，不记内容。排查「连接不上会话服务」时先看这里。
- 某个会话连续 3 次恢复失败时，App 停止自动连接它并给出提示，点击该会话可以重试。
- App 新终端不继承启动它的程序的 `NO_COLOR` 禁色设置；为会话显式传入的禁色设置仍保留。
- 从 agent 的执行沙箱里启动 App 时，Shell 会继承沙箱限制，可能无法写入用户缓存和历史文件；人工试用请从桌面正常启动。
- 升级不会自动结束正在运行的旧 daemon，旧会话何时结束由用户决定；协议 v3 拒绝更旧的 daemon，可以读取 v1／v2 注册表。
