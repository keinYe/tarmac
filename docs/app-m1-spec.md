# App M1 实施规格：多会话并行管理

> 状态：检查点 1 实施前定稿。依据 [App 架构提案](app-architecture.md) 与 [M0 规格](app-m0-spec.md) 。与 M0 规格冲突处，多会话行为以本文为准；M0 的单会话限制仅适用于历史版本。

## 1. 范围

一个 Tarmac daemon 托管多个独立 PTY。每个运行实例独立持有 PTY、headless xterm、回放日志、状态机、进程探测、用量读取器和订阅控制状态。支持同目录或不同目录的多个会话并行运行、无重启切换、会话数据隔离，以及意外断线后重连存活 daemon；正常退出遵循第 3.2 节。

不纳入：系统通知、托盘、分屏、多窗口、远程服务、打包发布；daemon 退出或机器重启后不承诺 PTY 存活，仅保留持久化元数据与已确认输入记录，不伪装运行中、不自动 resume。

## 2. 协议 v3

多会话结构在 v2 引入；v3 增加 Kimi hooks、调用时间、部分用量标记和 App 注册／退出流程，拒绝连接旧版 daemon，防止旧服务静默忽略新行为。注册表读取仍兼容 v1／v2，不重启旧 agent。hooks 与用量规则见 [接入说明](app-hooks-usage.md) 。

`VERSION` 为 `3`。v1／v2 客户端连接时由版本握手显式拒绝（`protocol version mismatch`），不自动结束旧 daemon 或其 PTY。

### 2.1 请求路由

- `list`：返回 `SessionInfo[]`，包含 daemon 持有的全部会话（存活与已退出），顺序为创建先后。
- `create`：创建新会话并返回该会话 `SessionInfo`；不再限制存活会话数量。校验规则与 M0 相同（命令、参数、绝对路径且目录存在、尺寸合法）。
- `attach`／`detach`／`ack`／`input`／`resize`／`close`／`read`：均携带 `sessionId`＋`instanceId`，按目标实例路由，在修改订阅前验证完整身份。`detach` 仅释放该连接对目标会话的订阅与控制，不结束 PTY。`sessionId` 不存在或 `instanceId` 不匹配返回 `stale session instance`；对已退出会话的 `attach` 返回 `process ended with daemon; only persisted input records are available`。
- `hook`：事件内身份按会话路由，校验规则沿用 M0（运行实例＋前台 agent 身份）。
- `shutdown`：关闭整个 daemon 及其全部 PTY；`close` 只结束一个会话。两者语义分离。

### 2.2 事件

- `info` 事件改为单会话粒度：`{ v: 3, type: 'info', session: SessionInfo }`，会话字段变化时只推该会话。前端按 `sessionId` 合并；新连接先以 `list` 获取全量。
- `snapshot`／`output`／`resize` 事件携带目标会话身份，前端终端流按身份过滤；不同会话的事件互不进入对方终端。
- `resync` 同样携带 `sessionId`＋`instanceId`，表示对应会话的控制权或回放游标失效；前端忽略非当前实例的事件，不影响其他会话。

### 2.3 输入控制权

每个 PTY 同一时刻最多一个输入控制方，状态记录在会话上下文而非连接上：新 `attach` 接管时，旧控制方收到 `resync: control transferred to another connection` 并解除该会话的控制；同一连接可以同时是不同会话的控制方。输入、ack、resize 均校验控制方、就绪状态与实例身份，切换后的迟到请求不能作用于新会话。

## 3. daemon 会话模型

`Daemon` 持有 `Map<sessionId, SessionContext>`。`SessionContext` 封装 M0 中散落在 daemon 的单会话字段与逻辑：

- PTY（`node-pty`）与退出 Promise、`TerminalStream`（headless xterm＋回放日志）、`StateTracker`、`HistoryStore` 视图选择（`selectedHistory`）、`UsageReader`、hook transcript 指针、探测节流时间、启动环境与 provider／argv、hook 失败去重集合、输入控制方 peer 与该会话的探测串行 Promise。
- 会话自身的 `SessionInfo`，所有异步回调先校验实例身份再写回，身份失效即丢弃结果。

共享部分保持单例：Unix socket server 与 peer 集合、`HistoryStore`（内部串行队列保证单写者与写入顺序）、注册表写入队列、租约、一个 500 ms 轮询定时器。轮询遍历全部存活会话，各会话探测互相独立且单会话内串行；一个会话探测失败或耗时不阻塞其他会话。

peer 的订阅状态由单连接单游标改为 `Map<sessionId, SubState>`，`SubState` 含 attached／ready／lastSent／lastAck／pending／bytes／target。连接关闭时清理其全部订阅；会话退出时清理全部 peer 对该会话的订阅。

### 3.1 失败隔离

- 单会话终端解析失败：错误写入该会话 `SessionInfo.error` 并结束该 PTY，其他会话的 PID、输出、输入能力不受影响。
- 会话退出：标记 `alive:false` 与退出码，清空用量与读取器，待回放日志空闲并完成持久化后释放 `TerminalStream`（headless 解析器）与 PTY 句柄；`SessionInfo` 元数据与输入记录保留，仍出现在 `list` 中。
- 创建失败：不创建部分可用的会话上下文，不影响已有会话。
- 重复 `close`：对已退出会话返回当前 `SessionInfo`，不报错、不影响其他会话。

### 3.2 App 与 daemon 生命周期

- 正常关闭窗口与退出 App 共用退出流程。最小化不触发退出。
- 每个 App 主进程在连接后注册 desktop 身份，重连后重新注册。普通协议客户端、hooks 和 statusLine 连接不计作窗口。
- daemon 原子处理 desktop 退出：仍有其他已注册窗口时，只解除本窗口身份，保留全部会话；最后一个窗口存在存活或正在创建的会话时，先要求确认。取消不改变注册及会话；确认后才关闭 daemon。确认期间若有新窗口连接，重新判断后仅解除本窗口身份。
- 最后一个窗口且没有会话时直接关闭 daemon。退出一旦提交，拒绝新的注册和创建，等待在途创建完成清理，再结束本 daemon 持有的 PTY、保存状态并释放租约。App 等待服务断开后退出，下次启动新 daemon，不自动恢复原进程。
- 正常退出只影响当前数据目录的 daemon 及其托管会话，不按进程名扫描或结束独立终端、TUI 或其他数据目录的进程。
- App 崩溃、强制结束或意外断线只清理连接身份，不触发自动 shutdown；下次打开可重连保留的 daemon。连接故障导致无法确认退出时明确提示，可取消或仅退出 App 并保留后台，不通过杀进程猜测处理。
- 生命周期操作仅供 Electron 主进程，不通过 renderer preload 暴露。自动化使用隔离目录，覆盖取消／确认、多个窗口同时退出、确认期间新窗口加入、崩溃保留、在途创建及外部进程不受影响。

## 4. 持久化与迁移

### 4.1 注册表 v3

`registry.json` 原子写入（tmp＋rename，0600），结构：

```json
{ "v": 3, "sessions": [{ "session": { "...SessionInfo（history 字段清空）": "..." }, "selectedHistory": { "provider": "claude", "id": "agent-session" } }] }
```

- 输入记录正文仍在共享的 `events.jsonl`，按 provider＋agent 会话 ID 归档，新记录额外保存 Tarmac 会话来源。界面按 Tarmac 会话来源过滤，阅读位置在 `read.json` 中按 provider＋agent 会话 ID＋Tarmac 会话 ID 分开保存。同一 PTY 中 resume 继续该视图；不同 PTY 的输入和已读互不影响。旧无来源记录及阅读位置保留，仅由旧注册表关联的历史视图读取，不猜测归属到新 PTY。
- 同一 agent 会话被多个存活 PTY 使用时，各自的 hooks 输入按来源保存；无法拆分的 transcript 用量在冲突期间隐藏，退出或切换解除冲突后可重新采集。
- 启动时全部会话以 `alive:false`、`agent:null`、用量清空、hooks 重置为未验证加载，绝不把旧运行标记当作存活进程。
- 未知 `v` 或结构不合法：显式报错并拒绝启动，保留原文件不覆盖；JSON 损坏同样保留文件并报错，由人工处理。
- 单写者：同一批并发持久化请求合并，在实际写入前生成一次最新注册表快照；写入期间又有变更则继续写入下一版，全部已请求版本落盘后才确认该批请求。禁止并发覆盖，避免每次创建／退出都提前保留整张注册表字符串。

### 4.2 v1 读取迁移

识别 M0 的 `{ v: 1, session, selectedHistory }`：

- 迁移为 v3 的单元素 `sessions` 数组，会话强制 `alive:false`、`agent:null`、清空用量与 hooks 验证状态，保留 `sessionId`／`instanceId`、命令、参数、目录、尺寸、退出信息。v2 数组结构同样可读取。
- `selectedHistory` 随会话保留；`events.jsonl` 与 `read.json` 不改动，输入记录、未读与项目目录可继续读取。
- 迁移只在读取时发生，首次成功持久化后写为 v3；迁移有专门测试覆盖，不把旧运行标记为存活。

## 5. 界面选择与重连

- 左栏按全部存活会话的实时目录分组，每组独立折叠；分支按该组目录读取，历史项目排除所有存活目录。
- 当前会话 ID 保存在该 App 数据目录的 renderer 本地存储中；重开时优先恢复仍存活的选中项，否则选择首个存活会话。
- 2026-11-18 起，renderer 为每个存活会话常驻一个终端：会话出现后即在后台 attach 并持续接收输出，切换只是切换显示，不再 detach 旧会话、也不重新回放。当前会话优先 attach。隐藏的终端用 `display: none`，xterm 暂停绘制、只解析，重新显示时整屏刷新；同一时刻只有显示中的终端持有 WebGL 渲染器（Chromium 限制 WebGL 上下文数量），其余使用 DOM 渲染器。
- 只有显示中的终端接受键盘输入，并在就绪后同步窗口尺寸；后台 PTY 保留最后尺寸，选中后才同步。会话退出或从列表消失时释放其终端并 detach。
- 后台会话收到 `control transferred` 时让出控制、不自动抢回，避免多个窗口互相抢占；只有用户选中它时才重新 attach。其他原因的 resync 自动重新 attach。
- 连接中断后清除全部 attach 标记；连接恢复后重新 attach 全部存活会话，这时显示中的会话会重新回放一次。当前会话先恢复，就绪后再逐个恢复后台会话，任何时候最多一个后台会话在回放，这样连接中断可以归到唯一正在回放的会话上。
- 同一会话在回放期间连续 3 次遇到连接中断，或终端流连续 3 次出错，就停止自动 attach 它并在界面上报错，其他会话照常使用；点击该会话是显式重试，会清零计数后再试一次。这条规则防止某个会话的数据问题让整个 App 无限重连。
- 输入记录面板打开时只标记当前会话已展示的记录为已读，后台记录不受影响。
- 桌面压力测试的切换门槛从 renderer 切换显示开始计时，到目标终端 `acceptsInput()` 成立为止；目标已在后台就绪时接近 0，尚未就绪时包含其回放及 ack。只在烟测模式采样。完整的点击到可输入耗时另列，包含 IPC 与测试轮询，不与该门槛混用。

## 6. 验证入口

- `pnpm typecheck`、`pnpm test`、`pnpm build` 必须通过；历史单会话回归继续通过。
- 新增后端回归：至少 3 个真实 PTY 并行（含同目录与不同目录），独有输入产生独有输出；并发创建、失败创建、重复关闭、旧实例请求、断线控制权转移、独立尺寸与终端查询回包；单会话失败隔离；v1 迁移与损坏文件保护。
- 资源基线与冻结门槛见 [M1 资源预算](app-m1-resource-budget.md)。
