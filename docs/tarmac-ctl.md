# 外部控制接口（`tarmac ctl`）契约

`tarmac ctl` 让同一用户的本机程序（下称「调用方」，例如消息机器人、自动化脚本）查看和操控 Tarmac 会话。本文是调用方依赖的契约：命令行参数、JSON 字段、错误码和语义以本文为准。修改时先改本文，再改实现，并通知已知的调用方。

## 1. 背景

Tarmac 的会话是 node-pty 加 headless xterm。daemon 的 `input` 请求要求请求方是 attach 上的唯一 owner（`packages/daemon/src/session.ts` 的 `control()`）；外部进程一 attach，App 窗口就会收到 `resync` 并失去控制权，所以外部控制不能复用它。

`tarmac ctl` 提供一组**不改变 owner** 的外部控制能力，由 CLI 包成稳定的命令行接口。调用方只调用 CLI，不直接连接 socket，也不依赖 Tarmac 的内部分帧协议。

## 2. 范围

提供：

1. 列出会话及其前台进程。
2. 读取会话屏幕的纯文本。
3. 向指定会话写入文字和有限的几个按键，写入前校验前台进程。
4. 在指定目录新建会话，并打上来源标记。
5. 结束指定会话。

不提供：

- 任意字节写入或控制序列。
- 输出订阅流；屏幕只按需拉取。
- 改变 App 的 owner、attach、ack 和回放语义的能力。
- 跨用户访问或网络监听。
- 启动 daemon：daemon 没有运行时直接报 `unavailable`。

## 3. 通用约定

### 3.1 调用方式

```
<Tarmac 可执行文件> <cli.cjs> ctl <子命令> [--data-dir <目录>] [参数...]
```

- 调用时设置 `ELECTRON_RUN_AS_NODE=1`。Linux 上按 [使用指南](tarmac-guide.md) 安装后，可执行文件是 `~/.local/opt/tarmac/Tarmac`，CLI 是 `~/.local/opt/tarmac/resources/app/dist/cli.cjs`。
- `--data-dir` 可选，指 daemon 的数据目录，即 socket（Windows 下是 token）所在的目录，与 App 的 `TARMAC_DATA_DIR`、daemon 的 `--data-dir` 含义相同。默认为 App 默认使用的 `<Electron userData>/m0`，Linux 上是 `~/.config/tarmac-app/m0`（设置了 `XDG_CONFIG_HOME` 时以它代替 `~/.config`）。endpoint 和 token 按 `packages/protocol/src/platform.ts` 的规则从中读取。
- `ctl` 忽略继承来的 `TARMAC_*` hook 环境变量，只按数据目录定位 daemon，因为调用方可能是在某个 Tarmac 终端里启动的。

### 3.2 输出

- stdout **只输出一行 JSON**，以 `\n` 结尾。stderr 可以写诊断信息，但不包含写入的正文。
- 成功：`{"ok": true, ...}`，退出码 0。
- 失败：`{"ok": false, "code": "<错误码>", "message": "<简短说明>"}`，退出码 1。
- 参数错误同样按上述格式输出（`code: "invalid"`），不只打印 usage。

### 3.3 错误码

| code | 含义 | 建议的处理 |
|------|------|------------|
| `unavailable` | daemon 没运行、socket 不存在、拒绝连接或握手失败 | 视为 Tarmac 不在线 |
| `unsupported` | daemon 是旧版本，不认识 `remote-*` 请求 | 同上，并提示需要重启 App |
| `stale` | `sessionId` 或 `instanceId` 不存在、已经换成新实例，或会话已退出 | 目标失效，重新 `list` |
| `rejected` | `--expect-pid` 校验失败：该 PID 不是请求时刻的前台进程 | 同 `stale` |
| `invalid` | 参数不合法（按键名未知、行数越界、正文超长等） | 当作调用方的程序错误 |
| `failed` | 其他内部错误 | 记录日志 |

### 3.4 协议版本

- 使用协议 v3。客户端和 daemon 严格比对版本号。
- `remote-*` 请求是新增的请求类型；旧 daemon 返回 `unknown request type` 时，CLI 映射为 `unsupported`。

## 4. 子命令

以下示例中的 `S`、`I` 分别是 `sessionId`、`instanceId`，由 `ctl list` 返回。两者都不包含冒号，调用方可以用冒号把它们拼成自己的内部标识。

### 4.1 `ctl list`

```
ctl list
```

```json
{"ok": true, "sessions": [
  {
    "sessionId": "S", "instanceId": "I",
    "pid": 1234, "alive": true, "cwd": "/home/u/proj",
    "origin": "my-bot",
    "foreground": {"pid": 1240, "name": "claude", "cwd": "/home/u/proj"}
  }
]}
```

- 只返回当前数据目录 daemon 托管的会话，包括已退出的会话（`alive: false`）。
- `pid`：PTY 的根进程。
- `origin`：创建时 `ctl create --origin` 传入的值，没有时省略或为 `null`。随会话持久化，daemon 重启恢复会话后保留。
- `foreground`：请求时刻的前台进程，语义与 `SessionInfo.foreground` 相同；没有时为 `null`。返回中可能还有其他字段，调用方应忽略不认识的字段。
- 调用方可以用 `foreground.pid` 精确匹配自己扫描到的 agent 进程。

### 4.2 `ctl screen`

```
ctl screen --session S --instance I [--lines N] [--no-join]
```

```json
{"ok": true, "text": "…", "alternate": false}
```

- 读取 headless 终端的纯文本，不带 SGR 等控制序列。在解析队列排空之后读取，内容与已写入 PTY 的输出一致。
- `--lines N`：1–2000，默认 30。
  - 普通缓冲区：返回最多 N 行回滚区，再加上整个视口，与 `tmux capture-pane -p -S -N` 的行为一致。视口不会被截掉，即使它的下半部分是空行。
  - 备用屏（全屏 TUI）：只返回视口，忽略 N。回滚区里是进入 TUI 之前的内容，与当前画面无关。
- 默认把软换行续接的行拼回一行（xterm 的 `isWrapped`），相当于 `-J`。传 `--no-join` 时按屏幕行原样返回，适合识别菜单。
- 每行去掉行尾空格，行之间用 `\n` 连接；末尾的空行可能保留。
- 已退出的会话返回 `stale`。

### 4.3 `ctl text`

```
ctl text --session S --instance I --expect-pid P      # 正文从 stdin 读取，UTF-8
```

```json
{"ok": true}
```

- 正文**只从 stdin 读**，不出现在 argv 中，因为同一用户的任何进程都能读到 `/proc/*/cmdline`。
- 不追加回车，提交由 `ctl key --key Enter` 单独完成（见第 6 节）。
- 终端开启了 bracketed paste（DECSET 2004）时，用 `\e[200~…\e[201~` 包裹；没开启时原样写入。正文自身包含的 `\e[201~` 会被去掉，防止提前结束粘贴。
- 空正文和超过 1 MiB 的正文都返回 `invalid`。
- 写入前按第 5 节校验。

### 4.4 `ctl key`

```
ctl key --session S --instance I --expect-pid P --key Down [--key Down ...] --key Enter
```

```json
{"ok": true}
```

- 只接受 `Enter`、`Up`、`Down`、`Escape`，其他键名返回 `invalid`，且一个键都不写。
- 多个 `--key` 按顺序在同一次请求里写入。
- `Enter` 写 `\r`。`Up`、`Down` 按 headless 终端当前的光标键模式（DECCKM）生成：普通模式为 `\e[A`／`\e[B`，应用模式为 `\eOA`／`\eOB`。`Escape` 写 `\e`。
- 写入前按第 5 节校验一次。

### 4.5 `ctl create`

```
ctl create --cwd D [--origin my-bot] -- <argv0> [args...]
```

```json
{"ok": true, "session": {"sessionId": "S", "instanceId": "I", "pid": 1234}}
```

- 与 App 新建会话走同一条路径：PTY 环境、`TARMAC_*` 变量、hooks 和用量统计都相同，新会话会出现在 App 左栏。
- `cwd` 必须是已存在的绝对路径目录，否则返回 `invalid`。
- `--origin` 只接受 `[a-z0-9-]{1,32}`，写入会话记录，`ctl list` 原样返回。
- 尺寸默认 120×40，App 打开该会话时按窗口重新调整。
- daemon 没运行时返回 `unavailable`，不会为了创建会话而拉起 daemon。

### 4.6 `ctl close`

```
ctl close --session S --instance I --expect-pid P
```

```json
{"ok": true}
```

- 按第 5 节校验后结束该会话，清理方式与 App 里关闭会话相同。
- daemon 不按 `origin` 限制；调用方如果只应结束自己创建的会话，需要先用 `list` 核对 `origin`。

## 5. 写入校验（`text`、`key`、`close`）

daemon 在执行写入的同一个事件循环回合里依次检查，任何一项不满足都不写入：

1. `sessionId` 和 `instanceId` 匹配，会话存活，PTY 仍然打开，否则返回 `stale`。
2. 以**请求时刻**的状态为准，确认 `--expect-pid` 指定的进程是这个 PTY 的前台进程，否则返回 `rejected`。不使用 500 ms 探测循环缓存的 `foreground`，判定规则与 `foreground` 的计算一致。前台进程要异步读取，所以每个请求先重新计算一次；结果返回后，在同一个回合里复核第 1 项并写入，中间不再有异步步骤。
3. **不检查也不改变** `owner`、`attach` 和 `ready`：外部写入不发 `resync`，不影响 App 连接的 ack 和回放。

调用方如果需要防止 PID 复用，可以自己先用 `/proc` 校验该 PID 的进程名和启动时间；daemon 负责校验 PID 是否属于这个会话。

## 6. 时序与并发

- daemon 对同一会话的 `remote-*` 写入按到达顺序执行。用户在 App 里打字和外部写入同时发生时，输入可能交错，与 tmux 的行为相同。
- 提交一段输入的推荐顺序：`text`，等待 250 ms（Codex 的粘贴保护窗口为 120 ms），再发 `key Enter`，两次都带 `--expect-pid`。调用方对同一目标的写入应串行执行。
- 每次调用都会启动一次 CLI 进程；单次 `list`、`screen` 预期在 1 秒内返回。

## 7. 安全与日志

- 访问控制沿用 daemon 的 endpoint：POSIX 下 socket 在 0700 的数据目录里，Windows 下用 token。调用方须以同一用户运行。
- `daemon.log` 和 stderr 只记录请求类型、会话 ID、结果码和正文长度，**不记录正文**，也不记录屏幕内容。
- `ctl` 不读取 agent 凭据，也不请求任何网络接口。

## 8. 验收

自动化测试使用真实 PTY 和假 agent，覆盖以下各项：

1. `list` 返回存活会话、`foreground.pid` 和 `origin`；daemon 重启恢复会话后 `origin` 仍在。
2. App 连接正在 attach 时执行 `text`、`key`：App 连接不收到 `resync`，owner 不变，App 照常收到输出。
3. `instanceId` 不匹配返回 `stale`；`--expect-pid` 不是前台进程返回 `rejected`；两种情况都确认一个字节也没写入。
4. bracketed paste 开和关两种情况下 `text` 的实际写入内容；正文中的 `\e[201~` 被去掉。
5. 光标键模式开和关两种情况下 `Up`、`Down` 的实际序列；包含未知键名的请求一个键都不写。
6. `screen`：普通缓冲区与备用屏的取行范围，`--no-join` 与默认拼接的区别，输出不带控制序列。
7. daemon 没运行时，各子命令都返回 `unavailable`，并且没有拉起 daemon。
8. 用旧 daemon（只认 v3 原有请求）时返回 `unsupported`。
9. 写入的正文没有出现在 argv、`daemon.log` 和 stderr 中。
