# App hooks 与用量接入

本次扩展仅作用于独立 App，不改变现有 Go／tmux TUI。状态以 hooks 为准；例外只有两处：Kimi 的轮次结束补充来源（见下文 Kimi 条目），以及共享后台下 Codex 的 rollout 关联与等待授权屏幕识别（见「Codex 共享后台的 rollout 关联」）。实际用户 hooks 和 statusLine 的安装须逐项确认，不自动修改用户目录。

## 数据与隔离

- Claude：同步 hooks 更新活动状态。CLI 在读取 stdin 前记录 hook 启动时间；没有 turn ID 的 Stop 只有在该时间不早于当前已知活动时才结束当前轮。旧客户端缺少时间信息时继续保守降级。延迟 idle 通知不用于结束新轮次。
- Claude statusLine：新增转发入口，将原始快照按 Tarmac 实例、前台进程及 agent 会话归属上报。可转发已有状态栏命令并保留其 stdout；不把状态栏输出解析为数据。daemon 分会话保存额度快照，既有 token-tracker 单文件缓存仅作精确 ID／路径匹配的兼容来源。额度属于账户：同一 Claude 配置目录下各会话采纳的最新快照会共享给其他会话，规则见 [M0 规格](app-m0-spec.md) 的 Claude 配额条目。
- Codex：注册 PreModelRequest／PostModelRequest。日志中的累计值优先；仅有请求事件时显示「接入后统计」，不声称覆盖 resume 历史或漏掉的事件。两路计数不相加。保持共享后台，无法准确归属的事件拒收，不按 cwd、最近文件或相同 provider 猜测。
- Kimi：接入原生 hooks，按准确 session ID 读取 `<KIMI_CODE_HOME>/sessions/*/<sessionId>/agents/main/wire.jsonl` 中的 usage.record，累计非缓存输入、输出、缓存读取和写入。路径必须唯一；不使用最近会话回退。处理半行、截断、轮转与无效计数。CLI 成功时无 stdout，避免注入模型上下文。
- Kimi 轮次结束补充来源：本机 Kimi 2.6.1 实测，轮次正常结束后不调用 Stop hook（同一会话中 TurnStarted 正常送达，`hook-failures` 为空，模拟 Stop 投递可正常结束轮次），状态会停在工作中。daemon 读取上述同一份 `wire.jsonl` 时，同时识别主 agent 的 `turn.ended`。仅当其 `turnId` 等于 TurnStarted hook 的数字 `turn_id`、时间不早于该 hook 的启动时间、当前状态仍为工作中或等待授权时，才结束该轮：`completed` 改为等待输入，`cancelled` 按中断处理，`failed` 按失败处理，其他原因忽略。没有 TurnStarted 编号、会话 ID 不匹配或文件定位不唯一时不使用该来源；Stop hook 送达时照常处理，两者重复时结果相同。
- agy：接入原生 hooks（SessionStart、PreInvocation、PostInvocation、Stop、PreToolUse、PostToolUse），payload 为 camelCase，CLI 把 `conversationId`、`hookEventName`、`lastUserInput`、`toolCall` 换成通用字段。本机实测（2026-11-20，两轮 `agy -p`）：PreInvocation 在每次调用模型前触发，`invocationNum` 每轮从 0 开始；所有事件都带 `lastUserInput`。因此只有 `invocationNum` 为 0（或缺失）的 PreInvocation 算作提交并记入输入记录，后续调用只算工作中证据。`stepIdx` 是步骤序号，不当作轮次；Stop 不带轮次，按 hook 时间判断归属。Stop 的 `terminationReason` 为 `USER_CANCELED` 时按中断处理，为 `ERROR` 时按失败处理，`fullyIdle` 为 false 时视为可能继续，其他情况改为等待输入；`continuationActive` 只表示本轮已被 Stop hook 续跑过，不影响判断。agy 没有授权事件，不进入等待授权。hook 不输出 stdout 时 agy 照常执行工具。中断、失败和后台任务这三条路径只按官方文档实现，尚未实测。headless（`-p`）模式下工具权限被自动拒绝时，agy 直接退出，不触发 Stop。App 提供 hooks 一键安装卡片，写入 `~/.gemini/config/hooks.json` 的 `tarmac` 条目：已有同名条目时，只追加带标记的 handler；卸载只移除带标记的 handler。agy 二进制中存在未写进文档的 `ANTIGRAVITY_GEMINI_DIR`，其语义未知，因此不跟随该变量。token 用量：CLI 把 hook 的 `transcriptPath` 换成 `transcript_path`，daemon 只接受 `<brain>/<conversationId>/.system_generated/logs/transcript_full.jsonl`，且目录名必须与当前 `conversationId` 一致（记录行本身不带会话 ID），不按进程打开的文件或修改时间查找。每个 `source: MODEL`、`type: PLANNER_RESPONSE` 步骤对应一次模型调用，按 `step_index` 去重后累加；本机实测 `input_tokens` 不含 `cache_read_tokens`，所以输入（含缓存）为两者之和，记录中没有缓存写入字段，固定为 0。daemon 重启后，要等下一次 agy hook 带来路径才恢复显示。额度：agy 用 `~/.gemini/antigravity-cli/antigravity-oauth-token` 中的凭据，请求 Google 内部接口 `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`（未公开文档）。返回结果只留在进程内存中，本地文件、`agy models`、`-p --output-format json`（只有 `usage` 计数）都拿不到额度；hook 也不带额度：二进制内置的 hook 契约文档中，6 个事件都没有额度或复位时间字段，实测抓到的 payload 也是如此（2026-11-20 核实）。Google 曾封禁借用 Antigravity OAuth 凭据的第三方工具用户，2026-11-20 决定放弃 agy 额度：不读取该凭据，不显示额度窗口。
- 凭据：默认不读取 OAuth／API 凭据、不请求账号接口。唯一例外是 Kimi 额度（2026-11-19 决定，做法参照 stormzhang/token-tracker 0.5.7 的 Kimi 状态栏）。边界：
  - 只使用 `<KIMI_CODE_HOME>/credentials/kimi-code.json` 中的 `access_token` 与 `expires_at`。token 已过期或缺失时不请求，也不刷新、不写回凭证文件，等 Kimi CLI 自己刷新；其他字段（含 refresh_token）都不使用。
  - token 只在单次请求期间留在 daemon 内存中，不缓存、不写日志或磁盘，不经协议发给渲染端，只发往下面的接口。
  - 只请求 `GET <base>/usages`，`<base>` 只允许 `https://api.kimi.com/coding/v1` 或 `https://api.kimi.ai/coding/v1`：按 `config.toml` 里 `providers."managed:kimi-code"` 的 `base_url` 二选一，不是这两个地址时用前者，不向其他地址发送 token。
  - 只在有存活的 Kimi 前台会话时请求，同一 Kimi 数据目录最多每 2 分钟一次，超时 8 秒；结果由该数据目录下的会话共享，超过 15 分钟未刷新成功即不显示。
  - 字段按 Kimi 2.6 客户端的 `parseQuotaUsages` 解析：`usages.limit_5h`、`limit_7d`、`limit_month_total` 的 `used_ratio` 与 `reset_time`，分别显示为 5h、7d、月；比例截到 0–100%，缺少比例或复位时间的窗口不显示，不按窗口长度推算。加油包余额与当月 Code 分项不展示。

## Codex 共享后台的 rollout 关联

本机 Codex 0.169.0 实测：TUI 默认连接共享 `codex app-server` ，对话与 hooks 都在后台进程执行，后台没有 Tarmac 环境变量，hooks 静默返回；TUI 进程也不持有 rollout 文件句柄。此问题为上游已知问题（openai/codex #48500、#60625），同类项目的通行做法是 `--no-daemon` 。在上游提供客户端身份前，App 参照 TUI 读取 rollout，并收紧关联条件；`--no-daemon` 的会话仍走 hooks 与文件句柄的精确路径，不受影响。

- 适用范围：前台为 Codex、该进程未送达过任何 hook、也没有打开 rollout 文件时才启用。一旦收到该进程的 hook 或发现文件句柄，即改用精确路径并丢弃 rollout 关联。
- 候选文件：`<CODEX_HOME>/sessions` 下的 rollout，首行 `session_meta` 必须满足：`originator` 为 `codex-tui`；`source` 不是子会话（排除带 `subagent` 或 `parent_thread_id` 的审查、子 agent 线程）；`cwd` 与该 PTY 前台进程的 cwd 完全相同。已被其他 PTY 关联的文件不再作为候选。
- 关联证据（满足任一且结果唯一才关联）：
  - 启动证据：`session_meta.timestamp` 位于 Codex 进程启动前 2 秒至启动后 60 秒之间，且同一 cwd 内在该时间窗中只有这一个候选文件、只有这一个尚未关联的 Codex 进程。时间窗结束后才判定，避免外部终端的文件先出现、本会话文件稍后才出现时误关联；启动时间按 `/proc/<pid>/stat` 的 starttime 加开机时间计算（macOS 用 `ps -o lstart`），不使用 etimes。
  - 提交证据：PTY 收到回车输入后 5 秒内，候选文件新增用户触发（`turn_attribution.turn_trigger` 为 `user`）的 `task_started` ，且同一时间窗内没有其他 Tarmac Codex PTY 收到回车、也没有其他同 cwd 候选文件新增 `task_started`。用于 `resume` 、`/new` 和启动时存在歧义的情况；`/new` 后若新文件满足该条件，则切换到新文件。已关联文件的某一轮尚未结束时按下的回车（回答审批菜单、补充输入）不算提交证据，不能把关联切到其他文件；2026-11-16 全量回归中曾因审批回车与同目录外部线程的开始落在同一毫秒而误切换，已补回归测试。剩余风险：空闲时按下的回车没有开启新一轮（如空输入或斜杠菜单），而同目录外部终端的线程恰好在 5 秒内开始一轮，且本会话尚未关联或已无进行中的轮次时，仍可能误关联；概率低；误关联的线程这一轮结束后，再次提交时会按提交证据改回正确文件，在此之前状态可能跟随错误的线程。
- 歧义处理：同一时间窗内有多个候选文件或多个 PTY 都可能对应时不关联，状态显示「运行中」，不显示 token，等下一次提交证据再判定。普通终端中的 Codex 在同一目录产生的 rollout 也计入候选，因此不会被误认成 App 会话。
- 状态：`task_started` 为工作中，`task_complete`／`turn_aborted` 按 `turn_id` 结束对应轮次，分别为等待输入、中断（运行中）。关联前已有的历史轮次不改变状态。
- 等待授权（屏幕识别，2026-11-16 确定）：rollout 不记录审批事件。仅在已关联且处于工作中时，读取 daemon 无头终端当前画面底部 20 行非空行，同时出现 Codex 0.169 的审批提问（如 `Would you like to run the following command?` 、`…make the following edits?` 、`…grant these permissions?` 、`…send input to the existing terminal?`）和以 `Yes,`／`No,` 开头的选项行时，显示等待授权；画面消失后回到工作中。只引用了提问文字的模型输出不会触发。Codex 改动界面文字后该识别会失效，需同步更新。
- 扫描范围：`sessions` 下最近 7 天的日期目录，只处理 90 秒内有写入或已关联的文件；暂时不活跃的文件也记下首次扫描到时的大小，之后被 `resume` 重新写入时从这个位置开始读，避免漏掉 resume 后写入的第一行（2026-11-19 实测：`thread_settings_applied` 与用户的 `task_started` 只隔 8 毫秒，旧实现从发现时的文件末尾开始读，跳过了这一轮的开始，导致一直没能关联、不显示 token）；仅在存在共享后台 Codex 会话时扫描。超过 7 天的旧对话被 `resume` 时无法关联。
- 用量：关联后用现有读取器按 `session_meta.id` 读取该文件的 token 与配额；解除关联时清空。
- 解除：Codex 进程退出、前台换成其他进程，或文件被切换到新对话时解除，文件重新成为候选。
- 输入记录（2026-11-20 确定）：共享后台下没有 UserPromptSubmit，改从已关联的 rollout 补输入记录。只采纳 `response_item` 中 `role` 为 `user`、`metadata.retained_source.id.message_id` 存在且 `complete` 不为 false 的消息（Codex 0.170 实测，用户真实输入带这一字段，自动注入的 AGENTS.md 与环境上下文不带），取其中 `input_text`／`text` 文本，按换行拼接，空白或超过 hook 大小上限的不记录。只读当前 PTY 已关联的文件，时间不早于关联起点；以 message_id 去重，压缩重写或 daemon 重启后重复读到同一条不会重复记录。记录写入同一份输入日志，归属该 rollout 的 `session_meta.id` 与当前 PTY，右栏与左栏副行照常显示。resume 的旧文件只读启动后新追加的内容，与状态一致；Codex 改动该字段后补录会失效，需同步更新。

## 配置及回退

Claude／Codex 沿用 plan → 审阅 → apply 流程，配置 hash 改变时拒绝应用，只移除带 ` # tarmac-app` 标记的条目。hook 进程靠 PTY 注入的 `TARMAC_SOCKET`／`TARMAC_SESSION_ID`／`TARMAC_INSTANCE_ID` 归属会话，缺少时直接返回。Codex 新增事件定义后需重新在 `/hooks` 审阅信任。Kimi 先提供显式 hooks 配置样例，保留用户 TOML 的所有其他内容。

App 的一键安装（`apps/desktop/src/hooks.ts`）沿用同一套规则：Claude 复用上面的 JSON plan／apply；Kimi 由 `packages/cli/src/kimi-config.ts` 在块级别编辑 `config.toml`，只删除 command 以标记结尾的完整 `[[hooks]]` 块、在文件末尾追加新块，其他字节保持原样（保留 CRLF，紧挨下一个表头的注释归下一个表）。遇到多行字符串，或带标记的块里有注释和非键值行（说明被手工改过）时，拒绝处理并要求手动修改。安装前备份原文件；撤销时只有在文件自安装后未被改动的情况下才恢复备份，否则报错并给出备份位置。安装状态的判断方法：如果按当前命令生成的安装方案只是移除并重新添加相同的条目，即为已安装；只有新增为未安装；其余情况为旧路径。statusLine 转发单独审阅配置，不自动接管已有命令。

用户配置里的 hook 命令指向已安装打包版里的 CLI（安装方法见 README「本机安装打包版」），由 App 自带的 Electron 以 Node 模式运行，不依赖系统 Node，也不受仓库重建影响。以下用 `$CLI` 表示 `env ELECTRON_RUN_AS_NODE=1 '<安装目录>/Tarmac' '<安装目录>/resources/app/dist/cli.cjs'`，本机安装目录为 `~/.local/opt/tarmac`：

```sh
$CLI hook claude
$CLI hook codex
$CLI hook kimi
$CLI statusline claude --forward '<原有 statusLine.command 原文>'
$CLI config snippet --provider kimi --command "$CLI hook kimi"
```

statusLine 转发原命令时会去掉 `ELECTRON_RUN_AS_NODE`，避免原命令继承 Electron 的 Node 模式。仓库里的 `dist/cli.cjs` 只用于开发和测试，用系统 Node 运行。每次 hook 调用的启动开销实测：Electron 约 90ms，系统 Node 约 68ms。

`config snippet` 只向 stdout 输出 12 个 Kimi TOML hook 条目，不写入文件；所有命令带 ` # tarmac-app` 标记。安装时审阅这些新增条目，卸载时只移除完全匹配该标记的条目。Kimi TOML 仍需在新会话验证实际生效，不把生成样例视为已接入。

Claude statusLine 转发命令必须显式指定已有命令；原始 stdin 字节及命令输出保持不变，转发子进程限时 2 秒。快照只存在于对应会话的内存中，不写入输入日志、不把 statusLine 当作生命周期 hooks 验证成功。外部 Claude 会话缺少 Tarmac 环境时仍正常转发原命令。卸载时还原审阅时保存的原命令；若用户后来改过 statusLine，先重新核对，不能覆盖。

协议升级为 v3，防止旧 daemon 静默忽略新增 hooks。当前仍存活的旧 daemon 不会被本次构建替换；旧版 daemon 需在用户结束其会话后显式停止，再启动新版本，或使用独立数据目录试用。新版正常退出按 [M1 生命周期](app-m1-spec.md) 关闭最后一个窗口对应的 daemon，崩溃或意外断线则保留后台。

## 验证

先验证协议、状态机、日志读取、配置生成及 UI 纯函数，再用隔离的真实 PTY 验证生命周期、重复／迟到事件、并行会话串数据防护及错误路径。Ubuntu 自动化与构建完成后记录结果；macOS、真实 agent hooks、Codex 共享后台的实际归属及用户配置安装仍须各自验收。

2026-11-15 22:04（北京时间）：Ubuntu 24.04 上类型检查、181 项测试（0 失败／0 跳过）、构建和 diff 检查通过。隔离 PTY 回归验证 Claude 并行快照、过期快照、Codex 部分计数替换、Kimi 状态／历史／用量隔离及 v2 注册表迁入 v3 后不复活进程；CLI 测试验证原状态栏输入／输出透传和 Kimi 静默响应。读取器只读解析本机两份 Kimi 主 agent 日志，累计分别为 230,307 与 1,812,328 tokens，没有发送模型请求。

隐藏 Electron 窗口使用独立目录 `.tmp/hooks-usage-desktop/` 验证 Kimi hooks 后的「等待输入」及顶部 `Token 1.2K`，既有 token／配额／复位、ANSI 配色、快捷键、多会话切换及重连回归通过。该烟测使用假 agent 和本地日志夹具，临时带 `--no-sandbox`，不计入正式 Chromium 沙箱或真实 agent 验收。本轮未重新打包、未验证 macOS、未安装用户 hooks，也未替换已存活的旧 daemon。

## 参考

实现思路参考 [token-tracker 990ef70](https://github.com/stormzhang/token-tracker/tree/990ef700451ae57308e8d214789c05ee013af5d0) 。Claude 的 statusLine／transcript、Codex 的 Stop／token_count、Kimi 的 wire usage.record 分别采集；不采用其最近文件回退或跨会话共享最新值。

- [Claude hooks](https://code.claude.com/docs/en/hooks) 与 [statusLine](https://code.claude.com/docs/en/statusline) 。
- [Codex hooks](https://learn.chatgpt.com/docs/hooks) 。
- [Kimi hooks](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md) 。
