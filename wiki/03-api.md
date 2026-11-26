# 03 · 关键类型与函数参考

## src/preflight.ts

### `guardedTools` / `pathKeyFor(name)`

```ts
export const guardedTools = ['grep', 'glob', 'read', 'read_image', 'edit'] as const
export function pathKeyFor(name: string): 'path' | 'file_path' | undefined
```

守卫名单与目标参数键映射：grep/glob 用 `path`，read/read_image/edit 用 `file_path`。扩展方式：往数组与映射加名字即可。

### `searchPathDenial(params)`

```ts
export function searchPathDenial(params: {
  name: string      // 工具名，须在 guardedTools 内才参与判定
  path: string      // 模型提供的目标（原始字符串，未解析）
  workdir: string   // 该 agent 的工作目录（workingDirectory.ensure 的产物）
}): string | undefined
```

- **返回 `string`**：一行式拒绝文案，即 `PreToolDecision {kind:'deny'}` 的 `reason`；**返回 `undefined`**：放行。
- 判定顺序（短路）：名单 → 空白 path → 解析（绝对保留，相对拼 workdir）→ workdir 可 stat？→ 存在性？
- 文案分工具：
  - grep/glob：`"${name} search failed: path "${path}" does not exist — glob near "${父目录}" to list existing candidates, then retry with an existing path"`（父目录 `\\` 归一为 `/`）；
  - read/read_image：`"${name} failed: file "${path}" does not exist — glob near "…" to locate the correct path, or check whether the step that was supposed to create it actually succeeded"`；
  - read_image 目标**存在**但扩展名 ∉ `{png,jpg,jpeg,webp,gif}` → deny：`.svg` 专属文案 `…is SVG, which is text: use read`，其余给通用格式提示。

### `editDenial(params)`

```ts
export function editDenial(params: {
  path: string; workdir: string
  oldString: string; replaceAll: boolean
  maxBytes?: number   // 默认 EDIT_PREFLIGHT_MAX_BYTES = 2_000_000
}): string | undefined
```

目标 ≤`maxBytes` 时读当前内容统计 `old_string` 非重叠匹配：**0 次** → deny（并发修改提示 + 要求 `read` offset/limit 重读后重构）；**>1 次且未 replace_all** → deny（报告匹配次数）；stat/读失败、超限、恰好 1 次 → `undefined`。

### `DenialEscalation` / `escalatedReason(reason, count)`

连续拒绝计数（`note(agent)` 递增、`clear(agent)` 归零，`THRESHOLD = 3`）；`escalatedReason` 在达到阈值时把"守卫不会向重试让步 + 文本形态调用不会执行"追加到拒绝文案——吸收 text-form tool call 诊断教训，防止模型在限流/上下文压力下把调用写进正文。

### `countOccurrences(haystack, needle)` / `EDIT_PREFLIGHT_MAX_BYTES`

非重叠计数助手（空 needle 返回 0）；edit 预检字节预算常量。

## src/repeat-guard.ts（循环守卫，1.3.x）

### `ZERO_RESULT_MARKER`

`'No matches found'`——与 `dsh-tool-fs-search` src/grep.ts 的跨包文案耦合：上游改词则零结果计数静默失效，需同步此常量。守卫自身所有拒绝/提醒文案都断言不含该标记，防自己的 `tools/result` 观察器把拒绝误读成搜索输出。

### `ZeroResultTracker` / `streakKey(rawPath, workdir)`

按归一化目标（解析后绝对路径）计连续零结果：`observe` 计数/清零，`streakFor` 只读。LRU 有界（只在插入新键时驱逐，读取永不驱逐——1.3.1 修复点）。

### `zeroResultDenial(target, streak)`

一行式循环失控拒绝：报告连续 N 次零结果，强制"直接读文件 / 换数据源 / 向用户报告阴性结果"。

## src/args-guard.ts（载荷守卫，1.4.0）

### 估算

```ts
export function estimateTokens(text: string): number          // Han≈1、其他≈¼（infinite-context 同口径）
export function estimateArgsTokens(value: unknown, cap: number): number
```

`estimateArgsTokens` 递归求和字符串叶子；超过 `cap` 立即返回跨越值（pre-execute 成本 O(cap)），深度 64 封顶（超深处的载荷不计数）。

### 文案（三段，模型可见，全部单行/无 marker）

```ts
export function argsHardDenial(name, estimated, limit): string  // payload-guard: … (limit …) — split …
export function argsSoftReminder(name, estimated, soft): string // payload-guard note: …
export function malformedNudge(soft: number): string            // 断流纠偏；"已落盘则忽略"自防护措辞
export const MALFORMED_CODE = 'MALFORMED_RESPONSE'              // 宿主内置失败码
```

### `MalformedStreak` / `NudgedTurns`

两个 LRU 跟踪器（键 `String(session.id)`）：`MalformedStreak.note/streakFor/clear` 封顶重试次数（completed turn 清零）；`NudgedTurns.claim(sessionId, turn)` 保证每 turn 只纠偏一次（request-error 与 agent/error 两通道互斥去重）。

### 默认常量

`DEFAULT_ARGS_HARD_TOKENS = 8_000`、`DEFAULT_ARGS_SOFT_TOKENS = 2_500`、`DEFAULT_PRESSURE_RATIO = 0.75`、`DEFAULT_PRESSURE_HARD_FACTOR = 0.5`、`DEFAULT_MALFORMED_RETRY = 1`（同时是 `numeric()` 告警回退值）。

## src/index.ts

### `GuardConfig`

```ts
export interface GuardConfig {
  disabled?: boolean
  maxEditBytes?: number       // edit 内容预检上限，默认 2_000_000
  zeroResultBlock?: number    // 零结果循环阈值，默认 5（钳 ≥1）
  argsHardTokens?: number     // 载荷硬限，默认 8000（0 关闭）
  argsSoftTokens?: number     // 软提醒阈值，默认 2500（>硬限时夹到硬限）
  pressureRatio?: number      // 压力收紧触发占用率，默认 0.75（0 关闭自适应）
  pressureHardFactor?: number // 收紧系数，默认 0.5（夹 [0,1]）
  malformedRetry?: number     // MALFORMED 有限重试，默认 1（0 = 只纠偏不重试）
}
```

`disabled: true` → `apply` 立即返回，不注册任何监听器。bundle 保持安装、组合行保持存在，仅守卫逻辑卸载——用于 A/B 对比或排障。数值键全部走 `numeric()` 告警回退（见 wiki/04）。

### `WorkingDirectoryLike`（内部）

```ts
interface WorkingDirectoryLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}
```

宿主 `workingDirectory` 服务的结构化最小面。插件按 `inject` 声明装载顺序，运行时用 `(ctx as unknown as {workingDirectory}).workingDirectory` 读取——因为该服务的 Context 增补类型属其属主包，直接 import 会把整个服务面拖进构建垫片。

### `apply(ctx, config?)`

```ts
export function apply(ctx: Context, config?: GuardConfig): void
```

注册六个监听器（Cordis 在插件卸载时自动回收）。`tools/pre-execute`（waterfall）签名与流程：

```ts
async (exec, next): Promise<PreToolDecision>
// exec: { name, arguments, agent?, signal }（宿主 ToolExecution 的相关子集）
// 0. argsHardTokens>0 且 arguments 是对象：估算 ≥ 有效硬限 → deny（payload-guard，不限名单、最先）
//    有效硬限 = argsHardTokens，会话占用率≥pressureRatio 时乘 pressureHardFactor（证明不了就不缩放）
// 1. pathKeyFor(name) === undefined            → next()
// 2. arguments 非 object / 目标键非字符串        → next()
// 3. workdir = await ensure(agent, signal)；抛错 → next()
// 4. grep 且 streakFor(目标) ≥ zeroResultBlock   → deny（循环守卫，先于存在性主张）
// 5. edit → editDenial({path, workdir, old_string, replace_all})
//    其余 → searchPathDenial({name, path, workdir})
//    undefined → next()；否则 {kind:'deny', reason}
```

其余五个监听器：

| 事件 | 形态 | 职责 |
|---|---|---|
| `tools/result` | 观察器 | grep 零结果计数（`tools/result` 负载文本 ==/含 marker 判定）；忽略 `Error: loop-guard` / `Error: payload-guard` 前缀的回灌结果 |
| `session/event` | 观察器 | `(session, event)`：`assistant/message`→`data.usage.totalTokens` 压力缓存；`turn/start`→当前 turn 号；`turn/end completed`→清 MALFORMED streak |
| `tools/post-execute` | waterfall | `next()` 后判定：`accept` + `isError!==true` + 参数估算 ≥ `argsSoftTokens`（且未越硬限）→ `{...decision, additionalContexts:[提醒]}`；每 turn ≤2 条 |
| `agent/request-error` | waterfall | `payload.failure.code === 'MALFORMED_RESPONSE'` 且 streak ≤ `malformedRetry` → `agent.inbox.append('next-step', 纠偏)` + `{kind:'retry'}`；否则 `next()` |
| `agent/error` | 观察器 | 同码且该 (session,turn) 未被 claim → `agent.inject(纠偏)`（`inject` 存在才调） |

`agent.inbox` / `agent.inject` / `session.requestContext()` 全部按结构化类型探测读取，缺位即静默降级——插件对宿主服务面零硬依赖。

## 宿主契约（本插件依赖的外部类型，均 type-only）

| 类型 | 来源 | 用途 |
|---|---|---|
| `Context` | `@deepseek-ai/cordis` | apply 参数；`ctx.on` 注册 |
| `PreToolDecision` | `@deepseek-ai/dsh-tools`（events 增补） | pre-execute 监听器返回值 |
| `PostToolDecision` | `@deepseek-ai/dsh-tools`（events 增补） | post-execute 监听器返回值（`accept.additionalContexts` 软提醒通道） |
| `ToolExecution` | `@deepseek-ai/dsh-tools` | 监听器入参（`name`/`arguments`/`agent`/`signal`） |
| `RequestErrorAction` | `@deepseek-ai/dsh-agent`（runtime-types） | request-error waterfall 返回值（`{kind:'retry'}`） |
| `UserMessage` | `@deepseek-ai/dsh-llm` | inbox/inject 纠偏与提醒消息的形状（本地按 `createUserMessage` 姿势构造，`source.kind = 'plugin:dsh-search-path-guard'`） |

`tools/pre-execute` 等事件由 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-agent` 的 events 模块对 cordis `Events` 接口做 declaration merging，import 即得类型与事件通道。运行时真实 import 只有 node 内建（`node:crypto` 的 randomUUID——构造纠偏消息 id、`node:path`）与本包纯模块——对宿主包零 require，转译后的 `dist/index.js` 因此能装进任何 profile。

## src/markup-guard.ts（标记守卫，1.4.0）

### 常驻声明与检测

```ts
export const PTC_CALL_CONVENTION: string                        // [ptc-call-convention] 每步快照声明（A2）
export function withoutCodeFormatting(text: string): string     // 剥 fenced/inline code（宿主 text-tool-call 逐字节同款）
export function detectMarkupLeak(text: string, minChars?): MarkupLeakAttempt | undefined
```

`detectMarkupLeak` 只吃**文本块拼接结果**（工具调用块是否同消息不影响判定——混合块正是目标，与宿主 `:86` 门控相反）；命中要求 `MARKUP_START` 开头 + body 校验（嵌套标签或 `"name":`/`"arguments":` 载荷）+ 长度 ≥ `minChars`；`MarkupLeakAttempt.name` 从 `<function=x>` / `<invoke name="x">` / JSON `<tool_call>{"name":…}` 三形态提取，上限 64 字符。

### 纠偏文案与状态

```ts
export function markupNudge(attempt, repeat): string  // "never ran" + run_code 补做；repeat ≥2 追加 markup-leak #N 升级段
export class MarkupTurnBudget                         // count/note：每 agent 每 turn 注入预算（turn 号自带复位）
export class LeakStreak                               // note/clear：连续泄漏升级计数（干净消息清零）
export const DEFAULT_MARKUP_BLOCK = 2
export const DEFAULT_MARKUP_MIN_CHARS = 40            // 宿主 MIN_MARKUP_CHARS 同值
```

## src/index.ts（标记守卫接线，1.4.0）

| 接线点 | 语义 |
|---|---|
| `systemPrompt.context` 注入 | `ctx.inject(['systemPrompt'])` → `search-path-guard:ptc-call-convention`（order 118）；无 session 投影空串 |
| `agent/pre-step` | 本 turn 最新 assistant 消息文本命中 → 追加纠偏消息；预算/spent/reject 透传规则见 wiki/02 §3 |
