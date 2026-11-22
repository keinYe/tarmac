# App M1 资源预算与测量门槛

> 状态：原门槛保留，修正审查发现的 CPU 单位错误后重测。检查点 5 按本文门槛判定，失败后不得放宽；如环境变化需重新测量并保留旧数据。
> 测量脚本：`scripts/app-m1-baseline.mjs`，数据与报告目录 `.tmp/app-m1-validation/baseline/`。

## 测量环境

- Ubuntu 24.04 x64，48 核，内存 32 GiB；Node v24.16.0，依赖以当前锁文件为准。
- RSS 取 `/proc/<pid>/statm` 5 秒窗口内最大值；CPU 取窗口内 utime＋stime，使用 `getconf CLK_TCK` 转为秒，再除以采样时间计算单核百分比。页大小由 `getconf PAGESIZE` 获取。
- 负载模型：假 agent（`packages/daemon/test/fake-agent.mjs`）每 250 ms 执行一次 `flood 200`，每会话约 800 行／秒、约 20 KiB／秒持续输出；与检查点 5 的 10 MiB 确定性输出同一夹具。
- 复测时该夹具作为 Shell 运行，隔离 PTY、进程探测与转发成本，不启动真实 provider 采集或模型；四种 provider 身份的并发交互另由桌面烟测验证。

## 基线（M0 单会话代码，提交 `2c89faa` 之后、M1 改动之前）

| 场景 | RSS 峰值 | CPU |
|---|---|---|
| 空闲 daemon（无会话） | 94,132 KiB（约 92 MiB） | 0% |
| 1 会话持续洪泛 | 100,872 KiB（约 99 MiB） | 78.28% |
| 参考进程托管 8 组 node-pty＋headless xterm（含脚本自身基线 80,944 KiB） | 121,952 KiB（约 119 MiB） | 106.61% |

上表保留原始记录。审查确认旧 CPU 公式在本机 CLK_TCK=100 时放大 10 倍，因此 CPU 栏作废，不能当作有效测量；按单位换算对应约 0%、7.828%、10.661%，该换算不是重新实测。修正后脚本测量当前真实多会话 daemon 的 0／1／8 会话场景，保存带时间的 JSON 报告，不再以参考进程替代 8 会话 daemon。

长周期复测发现默认 V8 参数下 RSS 超出 220 MiB，而诊断性 GC 后实际对象占用显著下降。daemon 启动固定使用 `--max-semi-space-size=8`，仅调整其年轻代半空间，减少短期分配带来的内存高水位；不限制 agent 进程或改写用户环境，也不设置老生代硬上限。该参数的内存／吞吐权衡见 [Node 24 CLI 文档](https://nodejs.org/download/release/v24.22.1/docs/api/cli.html#--max-semi-space-sizesize-in-mib) 。必须用相同启动参数复测 CPU、RSS 与桌面恢复门槛，资源验收不调用人工 GC。

M0 daemon 只能托管 1 个 PTY，8 会话成本以同一台机器上、由相同 per-session 组件（node-pty＋`@xterm/headless`）构成的参考进程估算：实测每会话边际 RSS 5,126 KiB。该参考不是 daemon 实测，检查点 5 必须以真实 8 会话 daemon 复测。

## 冻结门槛（检查点 5 判定用）

沿用单会话既有上限：2000 行 scrollback、单会话回放日志 32 MiB 硬上限、现有背压参数不变；8 会话回放日志逻辑总上限 256 MiB（8×32 MiB），这是日志容量而非进程 RSS 预算。

| 指标 | 门槛 | 依据 |
|---|---|---|
| 空闲 daemon RSS | ≤ 120 MiB | 基线 92 MiB 加约 30% 余量 |
| 1 会话洪泛 RSS | ≤ 140 MiB | 基线 99 MiB 加余量 |
| 8 会话 daemon RSS | ≤ 220 MiB | 92 MiB 基线 ＋ 8×5.1 MiB 实测边际 ×1.5 ＋ 协议／注册表余量 |
| 8 会话平均每会话边际 RSS | ≤ 8 MiB | 实测 5.1 MiB，预留结构开销 |
| 1 会话洪泛 CPU | ≤ 12% 单核 | 原错误单位门槛 120 除以 10，保持等效限制 |
| 8 会话洪泛 daemon CPU | ≤ 20% 单核 | 原错误单位门槛 200 除以 10，保持等效限制；不含假 agent 子进程 |
| 慢消费会话内存 | 不无限增长；背压生效后其他会话输出不阻塞 | 现有 `subscriberBytes` 与 parse 高低水位机制 |
| 切换耗时（attach 请求发出到前端 `acceptsInput()`） | p95 ≤ 500 ms | 预冻结值，检查点 2 落地后按同一主机实测填证，不在失败后放宽 |
| 10 MiB 输出后重连回放耗时 | ≤ 10 s 且画面字节一致 | 预冻结值，检查点 4／5 实测填证 |

前端回放与切换门槛在检查点 1 阶段尚无多会话界面可测，先冻结数值与测量方法；检查点 5 报告必须给出同环境实测值，未达标即 fail，不允许以「界面后续再做」为由跳过。

## 资源释放检查（检查点 5）

关闭测试会话后，该会话对应的 headless 解析器、peer 订阅状态、探测任务与 PTY 句柄必须释放；daemon 级共享定时器与 `HistoryStore` 不属于单会话资源。验证方式：关闭前后对比 daemon RSS 与 `/proc/<pid>/fd` 数量，连续创建／关闭 8 轮后 RSS 不持续单调增长。

## 修复后复测

2026-11-15：Ubuntu 24.04 x64、Node 24.16.0。`node scripts/app-m1-baseline.mjs` 使用与 App 相同的 daemon 参数，未启用人工 GC，退出码 0。报告：`.tmp/app-m1-validation/baseline/baseline-1794743030139.json`。

| 场景 | RSS 峰值 | 单核 CPU | 结果 |
|---|---|---|---|
| 空闲 daemon | 91,544 KiB | 0.20% | pass |
| 1 会话洪泛 | 101,848 KiB | 6.20% | pass |
| 8 会话洪泛 | 139,108 KiB | 18.98% | pass |
| 每会话边际 RSS | 5,945.5 KiB | — | pass，低于 8 MiB |
| 64 轮各创建／关闭 8 个 PTY | 最高 152,472 KiB | — | pass，未持续单调增长；每轮文件句柄均回到 20 |

失败证据保留：默认年轻代参数下，即使已合并注册表写入，第 47 轮仍达到 228,524 KiB，超过 220 MiB；报告 `.tmp/app-m1-validation/baseline/baseline-1794742759035.json` 为 fail。没有扩大 RSS 门槛或删除该断言。以上是固定负载窗口与 64 轮的结果，不代表任意会话数及无限运行时长的保证。
