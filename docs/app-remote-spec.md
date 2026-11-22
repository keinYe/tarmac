# Tarmac 远程主机规格

App 除了本机 daemon，还能连接局域网内其他机器上的 Tarmac daemon。agent、PTY、hooks、用量都留在 daemon 所在的机器上，App 只负责显示和输入。交互原型见 [app-remote.html](design/app-remote.html) 。只考虑局域网。

## 传输

- App 执行系统自带的 `ssh`（Windows 为 OpenSSH 客户端），参数固定为 `-T -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 [-p 端口] [用户@]地址 <远端命令>`，另加下节的 Tarmac 密钥与指纹文件参数。日常连接只用密钥或 ssh-agent；密码只在首次连接时用一次，App 不保存密码。
- 远端命令默认是 `env ELECTRON_RUN_AS_NODE=1 "$HOME/.local/opt/tarmac/Tarmac" "$HOME/.local/opt/tarmac/resources/app/dist/cli.cjs" bridge`，即 `pnpm desktop:entry install --package` 的安装位置。主机配置可以改写这条命令（其他安装位置，或测试）。
- `tarmac bridge`（`packages/cli/src/bridge.ts`）连接本机默认数据目录的 daemon socket；连不上时启动 daemon（与 App 相同的方式：同目录的 `daemon.cjs`，`detached`），最多等 5 秒。它启动的 daemon 不继承 `TARMAC_*` 和全部 `SSH_*` 变量：`SSH_CLIENT`、`SSH_CONNECTION` 含连接方的 IP，`SSH_AUTH_SOCK` 会把转发的 agent 交给 agent 进程，而 agent 继承 daemon 的环境。连接方 App 也不向远端传本机环境变量；agent 仍能从系统层面看到这条 SSH 连接（如 `ss -tn`、sshd 写入的认证日志），这不在 Tarmac 的控制范围内。随后在 stdout 写一行握手 JSON，再在 stdin/stdout 与 socket 之间原样转发字节，任一端关闭即退出。
- 握手：`{"tarmacBridge":1,"version":"<App 版本>","protocol":<协议版本>,"daemon":"running"|"started","shell":{"command":...,"args":[...]},"home":"<主目录>","hostname":"<主机名>"}`。App 版本或协议版本与本机不一致时，App 拒绝连接并显示两端版本；不做向下兼容。
- daemon 没有新增网络监听；SSH 之外不开放端口。POSIX daemon 仍不要求 token，访问控制靠 socket 目录权限和 SSH 登录。

## 首次连接（密码登录一次，之后用密钥）

- Tarmac 的 SSH 文件都放在本机 `~/.ssh/`，统一以 `tarmac_` 开头，不与系统默认的 `id_*`、`known_hosts` 重名：私钥 `tarmac_ed25519`、公钥 `tarmac_ed25519.pub`、主机指纹 `tarmac_known_hosts`。只新建这几个文件，不修改 `~/.ssh` 下已有的任何文件；`tarmac_ed25519` 已存在时直接复用，不覆盖。私钥权限只允许当前用户（POSIX `0600`；Windows 继承用户目录 ACL）。
- 日常连接在固定参数之外加 `-i ~/.ssh/tarmac_ed25519 -o UserKnownHostsFile=~/.ssh/tarmac_known_hosts -o StrictHostKeyChecking=yes`；ssh 仍会尝试用户自己的密钥和 ssh-agent，已经配好免密登录的主机不需要首次连接。
- 首次连接只在添加主机对话框中由用户触发，用 `ssh2` 库完成（系统 ssh 只从终端读密码）：
  1. 连接对方，取得主机公钥，弹出 SHA256 指纹，用户点「接受并保存」后写入 `tarmac_known_hosts`；拒绝则中止。
  2. 用填写的密码登录一次。密码只保存在主进程内存中，用完即丢，不落盘、不写日志、不发给渲染端以外的地方，失败提示不包含密码。
  3. 本机没有 `tarmac_ed25519` 时生成 ed25519 密钥对；把公钥追加到对方 `~/.ssh/authorized_keys`（目录和文件不存在时创建，权限 `0700`／`0600`），该行注释只写 `tarmac-app`，不含本机名称（agent 能读这个文件）；对方已有同一行时不重复追加，旧版本写入的 `tarmac-app@<本机名>` 行在部署时替换为新格式。
  4. 断开后按日常方式（系统 ssh、`BatchMode=yes`）重跑检查清单，全部通过才能添加。
- 主机指纹与 `tarmac_known_hosts` 中的记录不一致时拒绝连接，提示「主机指纹已变化」并显示新旧指纹；只有用户在对话框中重新接受后才替换该主机的记录。
- 移除主机时可勾选「同时删除对方 authorized_keys 中的 Tarmac 公钥」，需要主机在线，只删除与本机公钥一致、注释为 `tarmac-app`（含旧格式 `tarmac-app@<本机名>`）的行。
- 不提供记住密码。

## 主进程

- 主机配置存于 App 的 userData `hosts.json`：`id`（App 生成）、`name`、`address`、`user?`、`port?`、`command?`。本机固定 id `local`，不入配置。
- 每台主机一条独立连接，互不影响。远程连接成功后发 `desktop-register`：本机另一个 App 退出时，daemon 看到还有桌面连接，就只分离而不结束会话。App 退出时远程连接直接关闭，不发 `desktop-exit`，远程会话一律继续运行。
- 远程连接断开后自动重连，间隔 1、2、4、8、16、30 秒，之后每 30 秒；用户「断开连接」后不重连，「立即重连」清零间隔。握手版本不一致时不自动重连，只能手动重试。
- 会话标识：本机会话 ID 不变；远程会话 ID 在主进程加前缀 `<主机 id>:`，渲染端把它当作不透明字符串。请求按前缀路由并去掉前缀，事件（含 `info.session`）加上前缀；`list`、`create` 带 `host` 字段指定主机。渲染端看到的会话附带 `host`。
- 项目历史按主机分开存：本机仍是 `projects.json`，远程为 `projects-<主机 id>.json`。远程目录是否存在和 git 分支通过 daemon 新增的只读请求 `workspace` 查询（`{type:'workspace', paths}` → `[{path, exists, branch}]`）。
- Shell 授权卡片、hooks 安装卡片只对本机会话出现；远程主机的 hooks 在那台机器上用 CLI 安装。

## 界面

- 左栏先按主机分组，再按目录分组。有远程主机时，远程主机在前、本机在后；只有本机时不显示主机标题，与现在一致。主机标题行显示名称、地址和连接状态（已连接 / 连接中 / 重连倒计时 / 版本不一致 / 已断开）。
- 主机菜单：立即重连、断开连接、编辑主机、从列表移除。移除只删除配置，不结束远端会话。「本机」标题行的菜单只有「新建 Shell」（在 App 启动目录新建），选中远程会话时也能在本机新建；已连接的远程主机没有会话和历史项目时，分组下显示「暂无会话 · 新建 Shell」，本机不显示。`Ctrl+Shift+N` 仍跟随当前会话所在主机。
- 添加主机：填写地址、用户名、端口、显示名称、远端命令（可留空）；「连接并检查」依次显示 SSH 登录、找到 Tarmac、版本一致、daemon 运行或已启动，全部通过才能添加。失败时说明原因和修复办法。密钥登录失败或主机指纹未知时，对话框转入首次连接：显示密码框和「用密码登录并部署密钥」，先确认指纹，再部署密钥并重跑检查清单。
- 新建（`Ctrl+Shift+N`）在当前会话所在的主机和目录新建 Shell，用该主机握手给出的默认 Shell；点击某台主机下的历史项目，就在那台主机上新建。
- 远程连接断开时：会话保留断开前的信息，状态显示「状态未知」并变暗；中栏提示 agent 仍在远程运行，不能输入；不能在这台主机上新建。重连后按现有 resync 流程恢复画面。
- 标题栏和右栏诊断显示当前会话所在的主机。标题栏右侧的 CPU、内存和网速来自当前会话所在主机的 daemon（只读 `system` 请求，返回累计计数，速率由 App 用相邻两次采样计算）；时间也用该主机返回的时间戳和 UTC 偏移显示对方的本地时间；断开或旧版 daemon 不支持时，数据和时间都不显示。
- 多个 App 连同一个 daemon（例如 Windows 与 Linux 本机各开一个）时，同一会话同一时刻只由一个连接控制。App 加载会话（后台预加载和点选都算）时用 `attach` 的 `ifFree`：另一个仍在线的连接正控制该会话时，daemon 返回 `SESSION_BUSY`，不转移控制权。App 把这类会话标记为让出，点到它时在中栏显示「这个会话正在另一个 Tarmac 窗口中操作」，点「在这里继续」才强制接管；被接管的一方也显示同样的说明，不再显示英文报错。每个 App 启动时生成实例 ID，在 `desktop-register` 中带上；同一实例的旧连接（远程链路尚未超时）不算另一个窗口。旧版 daemon 不认识 `ifFree`，会照旧直接接管。
- 退出确认只针对本机会话；有已连接的远程主机时，在说明里写明远程会话继续运行。
- 贴图：远程主机上的 agent 读的是那台机器的剪贴板，读不到 App 所在机器的。远程会话里按 `Ctrl+V` 时，主进程读本机剪贴板（`clipboard.read()`，优先 `image/png`）：有图片就经该主机的连接用 `upload` 请求分片发过去（每片 1 MiB，单张最多 20 MiB，只接受 PNG／JPEG／GIF／WebP，按文件头判断），对方 daemon 存到 `<数据目录>/uploads/<会话 ID>/<时间>-<上传 ID 前 8 位>.<扩展名>`（目录 0700、文件 0600），渲染端把返回的绝对路径粘贴进终端（程序开启 bracketed paste 时按粘贴包裹），不自动回车；剪贴板里没有图片时照常把 `Ctrl+V` 发给 agent。上传期间敲的键先暂存，等路径或 `Ctrl+V` 写入后再按顺序发出。拖入图片文件到远程会话的终端同样上传并粘贴路径，多张以空格分隔。会话进程退出时删除它的上传目录，daemon 启动时清空整个 `uploads/`。本机会话不接管，`Ctrl+V` 仍由 agent 自己读剪贴板。对方 daemon 不认识 `upload` 时提示对方版本过旧。

## 验证

- 首次连接：`apps/desktop/src/first-connect.test.ts` 用 `ssh2` 在本机起 SSH 服务端（`ssh-test-server.ts`），覆盖指纹读取与保存（`ssh-keygen -F` 能读出）、指纹变化、未确认主机不发送密码、密码错误、部署密钥（保留原有行、末尾无换行、不重复追加）、私钥能被 `ssh-keygen -y` 读取、真实系统 `ssh` 用 `-i` 与 `tarmac_known_hosts` 登录并经 bridge 连接 daemon、撤销只删 Tarmac 的那一行。桌面回归的远程部分也改为真实系统 `ssh` 登录这个服务端，在对话框里走完指纹确认、输入密码、部署密钥、添加，最后勾选删除公钥移除主机；Tarmac SSH 文件放在回归数据目录，不碰用户的 `~/.ssh`。
- 自动化：`packages/cli/src/bridge.test.ts`（握手、启动 daemon、字节转发、`workspace` 请求）；`packages/daemon/src/server.test.ts` 的 `upload` 用例（分片保存、权限、进程退出与 daemon 启动时清理、乱序／格式／大小／实例校验）；`apps/desktop/src/image-upload.test.ts`（按文件头识别格式、分片顺序、超限与非图片在发送前拒绝）；`apps/desktop/src/remote.test.ts`（参数校验、SSH 失败分类、用假 `ssh` 跑完整链路、版本不一致、检查清单、ID 前缀、daemon 重启后重连、主机配置）；`panels.test.ts`（按主机分组与断线状态）。桌面回归（`runRemoteSmoke`）经上述 SSH 服务端执行打包后的 bridge 连接第二个 daemon，覆盖检查、添加、远程会话键盘输入、贴图（剪贴板图片上传并粘贴路径、纯文字剪贴板时 `Ctrl+V` 照常发出、拖入图片，使用真实系统剪贴板，结束后恢复原内容）、`Ctrl+Shift+N` 在远程新建、断开后「状态未知」与禁止输入、重连恢复、移除后对方会话保留、公钥被删除。
- 人工：Windows 实机通过真实 SSH 连接 Linux 主机，验证真实 Claude／Kimi 的输入、状态、断线与重连、关闭窗口后远程会话保留。
