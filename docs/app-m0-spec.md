# App M0 实施规格

状态：2026-11-13 开始实施。

## 范围与版本

保留现有 Go／tmux 程序，新增独立 Electron 原型；每个 daemon 仅托管一个 PTY，支持关闭界面后重连，不实现完整多会话产品。

依赖查询基线：Node 24.16.0、pnpm 11.9.0；Electron 45.3.1、node-pty 1.1.0、xterm 与 headless 6.0.0、serialize 0.14.0、fit 0.11.0、WebGL 0.19.0、React 19.3.1、TypeScript 7.0.2、esbuild 0.28.2。最终安装版本以锁文件为准。当前 CLI：Claude 2.1.322、Codex 0.167.2；事件能力仍需逐项实测。

只新增使用：Electron 提供跨平台 Chromium 与独立 Node 运行时；node-pty 创建真实 PTY；xterm 提供前后端同一终端引擎；serialize 导出画面；React 渲染诊断界面；esbuild 编译浏览器和 Electron 入口，TypeScript 检查类型。现有 Go 依赖不能提供这些桌面运行能力。

## 界面对齐

2026-11-13 评审认为诊断式界面不合格（左栏与当前 TUI 完全不同，中栏不像原生终端）。随后又明确：左栏要求与 TUI **内容**一致，不要求照搬终端背景和字符画。界面按评审通过的 [App 界面原型](design/app-ui.html) 实现；多会话管理仍属 M1。

- 布局：左栏 272px，中栏铺满，右栏 300px 且默认隐藏（Ctrl+Shift+H 显隐）；栏间 1px 分隔线。移除应用菜单栏和系统标题栏，顶部为 36px 的同色拖拽区，保留原生窗口控制按钮；macOS 为左侧交通灯预留位置。颜色用 CSS 变量定义，顶部、终端与 App 背景同为 `#121417`，不显示底部状态栏。
- 左栏内容与 TUI 一致：「Agents」标题与会话数；「当前任务」只列存活会话，按项目分组（文件夹图标、项目名、分支标签，可折叠）；会话行为品牌 logo、品牌名、状态圆点与文字、未读 `+N`；其下一行显示最后一条输入，放不下时以省略号截断，等待授权时改为红色「需要你选择，切过去处理」；当前会话加浅青底色和左侧竖条。「历史项目 N」按最近打开排序，最多 10 个，不含存活会话的目录。底部为 Ctrl+Shift+H 历史、Ctrl+Shift+N 新建的按键提示，错误以红色提示条显示在其上方。
- 品牌与状态：前台 agent 为 Claude／Codex／Kimi／Google Antigravity（agy）时显示设计稿 SVG 和品牌名，否则显示 Shell 且不显示状态。Kimi 兼容原生 kimi／kimi-code／kimi-cli、Node 包 @moonshot-ai/kimi-code 的 dist/main.mjs 和旧 Python kimi_cli 入口；agy 按原生命令识别。Kimi 在接入自身 hooks 后提供输入记录、活动状态及主 agent wire 用量；未接入时与 agy 一样显示「运行中」，不借用其他 provider 的数据。agent 在 Shell 中退出后恢复 Shell 身份，PTY 退出后不列在当前任务。hooks Provider 为 Claude／Codex／Kimi，agy 仅作前台身份识别。扩展细节见 [hooks 与用量接入](app-hooks-usage.md) 。
- Codex 多配置：按当前进程 argv 中 -p／--profile／--profile= 识别 profile，侧栏显示 Codex · <profile> 并保留 Codex logo；支持 codex-ds／codex-ark 的本机别名（实际为 codex -p deepseek／codex -p ark）及其他 profile 名。npm 启动器可向原生子进程补充 profile 信息，名称过长时省略并在悬停展示全名。不解析任意 Shell 配置、不改变别名、用户配置或共享后台模式；不同 profile 仍遵循精确关联用量的限制。
- 新建与历史：没有新建表单。Ctrl+Shift+N 在当前会话目录（没有会话时为启动目录）新建登录 Shell，单击历史项目在该目录新建 Shell；agent 由用户在 Shell 里启动。M0 只支持一个运行中的会话，已有存活会话时明确报错。项目历史由 App 主进程保存在 Electron 用户数据目录的 `projects.json`，不读取 TUI 注册表；目录不存在时报错，不回退。
- App 快捷键仅在窗口内生效，先于终端编码处理；输入法组字期间不触发，按住产生的重复事件不重复执行。普通 Ctrl+N、Ctrl+H 与 Alt 组合键继续交给终端。
- 顶部显示当前 agent 会话的累计 token 数，悬停查看输入（含缓存）、输出、缓存读取与写入的精确计数。Claude 按主会话 assistant 消息 ID 去重，累计输入、输出与两类缓存；Codex 使用最新的会话累计快照，缓存与推理 token 不重复相加。resume 包含该会话已有记录，不包含独立子 agent 文件。只读当前进程实际打开的会话文件，或当前已验证 hooks 提供的 `transcript_path`；npm Codex 启动器仅在有唯一直接原生 Codex 子进程时关联该子进程，工具与嵌套 agent 不替代主会话。不能精确关联、读取失败或计数无效时，Claude 显示「暂无数据」，Codex 隐藏用量，不扫描最近会话猜测归属。读取失败时，悬停提示写明原因（只有错误类别或文件系统错误码，不含会话内容和路径），同一会话的原因每变化一次在 `daemon.log` 记一行；10 秒后丢弃失败的读取器，从头重新读取，避免一次偶发错误让用量一直缺失到会话结束。文件增量读取，终端流与状态判断不依赖 token 采集；退出或切换进程／会话立即清除旧用量。Claude 未保持日志句柄且没有 hooks 路径时，每 2 秒调用只读 `claude agents --json`，按当前 PID 获取唯一会话 ID，再读取该 UUID 的主日志；支持 `/clear`、`/resume` 切换，不使用 PID 缓存文件或最近日志猜测。旧版 Claude 不支持该命令时仍降级为「暂无数据」，不自动安装 hooks。 Codex 保留用户的共享后台模式，不注入 --no-daemon；该模式日志由共享服务持有，无法从 TUI PID 可靠映射当前线程，缺少精确关联时不显示数据。背景与上游限制见 [Codex issue #60625](https://github.com/openai/codex/issues/60625) 。
- Codex 顶部同时展示该会话 `token_count.rate_limits` 中 `limit_id=codex` 的账户配额快照：按实际 `window_minutes` 标注窗口，显示已用比例与复位倒计时，悬停显示具体时间及快照时间。其他独立额度池不覆盖标准配额；配额专用事件不覆盖 token 累计值；无效配额不影响有效 token。倒计时使用 2d3h／4h18m／25m，每 30 秒刷新，到时标记「待更新」，不推算额度恢复，无快照时显示「配额 · 暂无数据」。Claude 复用用户已有 token-tracker 状态栏写入的 `~/.config/token-tracker/tt-status.json`（设置 `XDG_CONFIG_HOME` 时从该目录读取）：仅在 session_id 与 transcript_path 都精确匹配当前会话时采纳 rate_limits，保留最后一次已验证快照以避免被其他终端覆盖后闪烁；切换会话时清除。配额属于账户而不属于会话（2026-11-20 确定）：同一 Claude 配置目录（`CLAUDE_CONFIG_DIR`，默认 `~/.claude`）下，任一 App 会话按上述规则采纳的快照都记为该目录的账户快照；本会话没有自己的快照，或者账户快照比自己的更新时，改用账户快照，悬停注明来自同一账户的其他会话。这样刚恢复、还没发过请求的会话也能显示配额。不同配置目录视为不同账户，互不共享。没有该缓存时仅有 token，不自动安装或修改状态栏与 hooks。Claude 和 Codex 都不读取凭据、不请求账户接口。Kimi 是唯一例外：用 Kimi 自己的 access_token 请求官方 `/usages` 接口，在顶部显示 5h、7d、月三个窗口，悬停标注数据来自账户接口及获取时间；边界见 [hooks 与用量接入](app-hooks-usage.md) 的「凭据」条目。Claude 官方字段见 [状态栏数据](https://code.claude.com/docs/en/statusline) 。 顶部配色参考本机 token-tracker 状态栏：累计 token #fab387、窗口标签 #f5c2e7、倒计时 #89b4fa，配额比例 <50% 为 #a6e3a1、50%–<80% 为 #f9e2af、≥80% 为 #f38ba8；未知数据保持中性色。
- App 品牌与分支图标复用 [精修设计稿](design/app-ui-refined.html) 的 SVG 路径和图标尺寸，分支标签可收缩，避免遮挡项目名。终端保留字体、字号、行距与现有色板；创建 PTY 时去除从自动化启动工具继承的 NO_COLOR，恢复 agent 原生 ANSI 配色，CreateOptions.env 显式传入的 NO_COLOR 仍生效，旧进程需重启。
- 右栏：按时间列出输入记录，每条最多 3 行；底部固定显示状态、hooks、画面恢复方式及错误。
- 中栏：没有存活会话时显示「暂无 agent」和按键提示，不连接已结束的会话。终端铺满无边框、无滚动条：Ubuntu Sans Mono 加 MiSans 回退，16px，前景 `#e4e7ea`，背景 `#121417`，16 色沿用 GNOME 调色板，粗体不提亮，块状光标。格子与本机 GNOME Terminal 同为 9×22 CSS 像素（2 倍缩放下 18×44 物理像素），通过 `letterSpacing` 0.5 与 `lineHeight` 1.16 对齐。Linux 下忽略 GPU 禁用名单以启用 WebGL 渲染，方块和边框字符由 xterm 自绘，失败时回退到 DOM 渲染。`@xterm/addon-webgl` 0.19.0 拼出的 Canvas 字体串以空格开头，会被 Electron 45 的 Chromium 拒绝，文字退回 `10px sans-serif`；用 `patches/@xterm__addon-webgl@0.19.0.patch` 去掉该空格，升级插件时需复核是否仍需要。
- 验证：侧栏与右栏的数据模型为纯函数并有单测；隐藏窗口截图与原型对照，确认布局、状态和终端渲染。
- 人工试用从正常桌面权限启动，避免 Shell 继承 agent 执行沙箱后无法写入用户补全缓存和历史文件；Electron renderer 自身仍启用 sandbox、隔离与关闭 Node 集成。

## 协议与进程

- Electron renderer 关闭 Node 集成并启用隔离，通过白名单 preload 调主进程；主进程连接 Unix socket，不向 renderer 暴露任意文件或 socket 能力。
- daemon 独立启动并持有 PTY；Electron 以 `ELECTRON_RUN_AS_NODE=1` 启动构建后的 daemon。正常关闭最后一个 App 窗口时按 [M1 生命周期](app-m1-spec.md) 确认并结束本 daemon 及其 PTY；仍有其他窗口、App 崩溃或意外断线时保留后台。最小化不退出，不操作外部终端或 TUI 会话。
- daemon 数据目录权限为 `0700`，socket 为 `0600`；使用独立 App 数据，不接管 TUI 及其他 tmux server。连接先校验协议版本；每条请求有 `id`，错误返回结构化响应。
- daemon 在读写历史前取得数据目录内的单写者租约；顺序票据以原子创建分配，存活的早序号持有者阻止第二个 daemon。退出标记释放，崩溃后只忽略已确认退出的持有进程。回收残留 socket 还须确认本目录的 Tarmac 标记、socket 所有者及无监听者；未知文件、活跃连接和不明确的进程状态均保留并报错。
- 单个 PTY 用 `sessionId` 和每次启动不同的 `instanceId` 标识；输入、resize、ack 必须带两者。一个连接持有输入控制权，新连接接管时旧连接失效。
- 输出使用 base64 编码原始字节，不把各 chunk 单独解码成 UTF-8。输入区分 UTF-8 文本与 xterm binary 事件。

## 重连时序与预算

2026-11-13 起，重连恢复由 serialize 快照改为**字节日志回放**：serialize 不导出滚动区、origin mode、Tab 停靠点、DEC／SCO 保存光标及字符集等状态，画面相同也不能保证后续输出一致（失败证据见验证记录）。

- 输出与 resize 共用单调递增序号，按序写入 daemon 内存中的回放日志。日志由「基点」加其后的记录组成：会话启动时基点为空终端及启动尺寸，属于精确基点。
- 订阅者先收到基点帧（基点序号、基点尺寸、基点数据、`target` 与 `exact`），以基点尺寸新建终端写入基点数据，再按序接收其后的输出和 resize，直到确认到 `target`（attach 时的日志末尾）才允许输入。之后同一游标继续接收实时增量。
- 基点数据超过一帧时分片发送（2026-11-18 起）：压缩后的基点是 2000 行滚动区加全部颜色的 serialize 结果，颜色密集时可达十几 MiB，整帧发送会超过帧上限，导致每次 attach 都断开连接。基点帧携带第 0 片和总片数 `parts`，其余片用 `snapshot-part` 帧按序发送，每片对应 256 KiB 原始数据（base64 按 3 字节对齐，可独立解码）。分片和输出记录共用未确认额度，客户端写完一片就用带 `part` 的 ack 确认；全部分片确认后才发送其后的输出记录。客户端收到分片就直接写入，xterm 会跨写入保持 UTF-8 和控制序列的解析状态。不超过一帧的基点仍整帧发送，旧版本 daemon 不会发送分片。
- daemon 按游标从日志推送，单连接未确认字节达到上限即暂停，收到 ack 再继续；慢连接只是落后，不再因超限断开。每次从日志读取的总字节数不超过剩余额度（2026-11-18 修复：之前只限制单帧大小，落后很多的订阅者会一次收到全部积压，写入超过 8 MiB 时被断开）。daemon 因帧超限、积压超限或请求无效断开连接时，原因写入数据目录下的 `daemon.log`（1 MiB 轮转一次，不记录终端内容、hook 内容或输入）。游标早于当前基点时发送 `resync`，由客户端重新 attach。连续输出记录合并成一帧，帧内 `first` 至 `seq` 为覆盖的序号范围。
- 日志超过压缩阈值时尝试**验证压缩**：在解析屏障处取 headless 的 serialize 结果作为候选基点；另以旧基点回放到同一位置作为参考终端，对比两端两套缓冲区、光标与模式，再依次写入探针（画笔与字符集、DEC 保存光标、SCO 保存光标、Tab 停靠点、origin mode 与滚动区、备用屏幕）逐段比对。全部一致才以候选替换基点并丢弃之前的记录；不一致记录首个差异段，日志继续增长并稍后重试。
- 探针只覆盖上述已知的隐藏状态；验证通过的基点仍标为精确，但只代表探针覆盖范围内一致。
- 日志达到硬上限仍未能验证时，强制以 serialize 结果作基点并把该运行实例标为「恢复降级」（`exact: false`），界面明确显示原因；降级不可逆，之后的压缩不再验证。
- 只允许 daemon 的 headless 响应终端查询。参考终端不连接任何应答出口；前端解析（包括回放）产生的自动应答不得写回 PTY，回放完成前 daemon 也拒绝该连接的输入。
- 日志只存内存、不落盘：daemon 退出时 PTY 一并结束，日志没有恢复价值。多会话的内存占用在 M1 另行评估。

framer 仍保证只把完整的 UTF-8 字符和控制序列交给 headless 与日志，跨记录边界不会留下半截序列。

在测试前固定以下预算：单请求最大 8 MiB；保留滚动历史 2000 行；单连接未确认输出最多 2 MiB；PTY 等待 headless 解析的数据高水位 1 MiB、低水位 256 KiB；headless 积压则暂停读取 PTY。回放日志：基点之后达到 8 MiB 时尝试验证压缩，失败后每多 4 MiB 重试一次，硬上限 32 MiB；单帧合并输出最多 256 KiB。恢复耗时：本机 headless 解析实测约 25 MiB/s（TUI 重绘型输出），硬上限日志在 Node headless 中回放不超过 3 秒；Electron 渲染端耗时待 GUI 环境实测。接收、回放、ack 均受有界缓存约束。

hook 客户端自身上报总预算 500 毫秒（包含重试，不含运行时启动）；stdin 最大 4 MiB；统计真实启动与端到端耗时，不把预算当测量值。不得因 Tarmac 故障更改 agent 权限决策或向模型添加文本。

客户端最多 8 个在途请求、1024 个排队请求，累计编码帧缓存最多 16 MiB；在途请求超时关闭连接并拒绝剩余请求，尚未发送的超时请求仅从队列移除。

## 状态转换与关联

进程存活、agent 身份、活动状态和 hooks 接入分别记录。归属键至少为 PTY 运行实例、agent 进程身份、provider 与 agent 会话 ID。存在 turn／tool ID 时参与关联。daemon 接收序号只保证到达顺序，不假定等于 agent 的真实发生顺序。

| 观察事实 | 结果 | 限制 |
|---|---|---|
| SessionStart | 关联会话，运行中 | 不能据此认定正在工作 |
| UserPromptSubmit | 工作中，记录提交 | 不承诺模型已接受；真实新轮次可清除旧等待 |
| PermissionRequest／permission_prompt | 等待授权 | 保存可用的 turn／tool 标识；请求事件不保证最终一定弹出菜单 |
| 可关联的工具执行结果／后续活动 | 工作中，清除对应授权 | 无关工具、子 agent 或旧轮次不能清除 |
| Stop／idle_prompt | 等待输入 | 区分继续执行的 Stop hooks 与子 agent；后续明确活动覆盖。没有 turn ID 时，Claude／Kimi 按 hook 开始时间判断归属：晚于最近一次提交才算结束本轮。Claude 2.1.328 在一轮结束约 60 秒后发出的 idle_prompt 就没有 turn ID；其他 provider 没有 turn ID 的这类事件会降为运行中 |
| 等待输入持续 2 分钟 | 空闲（与 TUI 的 `DefaultIdleAfter` 一致） | 只能由等待输入转入，其他状态多久都不转空闲；状态机本身不记录空闲，daemon 对外输出会话信息时按时长换算，并由 500 ms 探测主动广播；离开等待输入，或轮次、会话、agent 进程变化都会重新计时；后续活动按原规则覆盖 |
| Interrupt／StopFailure 等明确中断或失败 | 运行中，注明原因 | 仅按该 provider 的实测事件语义映射 |
| agent 退出而 Shell 存活 | Shell，无 agent 活动状态 | 旧 agent 事件不得重新绑定 |
| PTY 退出 | 已退出及退出码 | 最高优先级 |
| 未知事件、缺字段或能力不全 | 保留可确认事实，必要时运行中 | 不依据静默时间或普通输出推定授权已处理 |

Claude 手动拒绝与 Esc 中断未必都有可用事件。无法观测且不能可靠降级的路径必须记录 unresolved，不用统一超时把仍在等待的授权抹掉。完整事件表需用目标版本真实样本补齐。

## hooks 接入与输入记录

配置未找到为「未配置」；配置存在但未收到当前运行实例事件为「待验证」；真实收过事件为「已验证」，附最近成功时间。长期静默不单独判失败。Codex hooks 需用户审阅信任；禁止通过绕过参数自动启用。

hook 只上报，不授权，不输出模型上下文；按对应事件返回合法的无决策响应。接收链路校验范围及载荷，写入追加日志并同步后才确认。重试复用事件 ID；相同文本的独立提交保留为不同记录。写失败不确认，已知采集失败必须可见；未曾上报的事件无法承诺检测。

v1 输入记录只保留接入后的内容，不导入 transcript 历史消息；顶部累计用量单独只读已精确关联的会话记录。日志按 provider 和 agent 自身会话归档，resume 继续追加，更换 agent 切换视图。JSON 保存阅读位置，加载历史不产生新未读。仅断开一个窗口时后台继续采集；正常关闭最后一个窗口并确认后随 daemon 结束采集。daemon 重启恢复持久化记录，不承诺原 agent 进程存活。

配置工具先生成可审阅变更，安装和卸载只处理 Tarmac 条目。真实用户配置逐项确认；自动化只在 `.tmp/app-m0-validation/` 隔离目录操作。

## 验证入口与实测矩阵

- `pnpm typecheck`：全部 TypeScript 检查。
- `pnpm test`：协议、状态、存储、hook 客户端、真实 PTY 与重连自动化。
- `pnpm build`：构建主进程、preload、renderer、daemon 与 CLI。
- `pnpm desktop`：启动 App M0，默认使用独立 App 数据目录。
- `pnpm package:local`：生成未公开分发的本地测试目录，原生模块与 daemon 必须在产物中复验。
- `pnpm smoke:runtime`：验证 Linux x64 本地目录产物中的 Electron Node 运行时与真实 PTY；其他平台产物路径可传给 `node scripts/app-m0-runtime.mjs <产物目录>`。
- `pnpm smoke:desktop`：隔离桌面窗口验收，独立数据目录，使用假 agent 并在结束时关闭自身 daemon。

C2 至少处理 10 MiB 输出及 30 次重连，比较缓冲内容、单元格属性、光标、终端模式、保留历史；补慢消费、resize 和跨边界序列。另需覆盖：七项隐藏状态恢复后继续输出一致；验证压缩成功与失败两条路径；硬上限降级可见；游标落后于基点时 resync；回放期间查询不产生应答。其余逐项步骤及证据以施工清单为准。

| 平台 | 自动化 | 真实 Claude／Codex | 输入法 | 本地打包 |
|---|---|---|---|---|
| Ubuntu 24.04 x64 | 151 项全部通过 | 未验证 | GUI 正常权限启动受沙箱环境阻塞，fcitx5／ibus 未验证 | 既有目录产物与无窗口运行时通过，本轮未重新打包，GUI 未验证 |
| Ubuntu 22.04 | 未验证 | 未验证 | fcitx5／ibus 未验证 | 未验证 |
| macOS | 未验证 | 未验证 | 系统拼音未验证 | 未验证 |

实际操作记录版本、桌面会话类型及架构。无环境或无法触发的路径保持 unresolved，交叉编译不能代替真机验收。

M0 尚未通过，不进入完整重写。
