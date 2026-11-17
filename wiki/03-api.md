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

## src/index.ts

### `GuardConfig`

```ts
export interface GuardConfig {
  disabled?: boolean
  maxEditBytes?: number   // edit 内容预检上限，默认 2_000_000
}
```

`disabled: true` → `apply` 立即返回，不注册任何监听器。bundle 保持安装、组合行保持存在，仅守卫逻辑卸载——用于 A/B 对比或排障。

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

注册唯一一个 `tools/pre-execute` 监听器（Cordis 在插件卸载时自动回收）。监听器签名与流程：

```ts
async (exec, next): Promise<PreToolDecision>
// exec: { name, arguments, agent?, signal }（宿主 ToolExecution 的相关子集）
// 1. pathKeyFor(name) === undefined            → next()
// 2. arguments 非 object / 目标键非字符串        → next()
// 3. workdir = await ensure(agent, signal)；抛错 → next()
// 4. edit → editDenial({path, workdir, old_string, replace_all})
//    其余 → searchPathDenial({name, path, workdir})
//    undefined → next()；否则 {kind:'deny', reason}
```

## 宿主契约（本插件依赖的外部类型，均 type-only）

| 类型 | 来源 | 用途 |
|---|---|---|
| `Context` | `@deepseek-ai/cordis` | apply 参数；`ctx.on` 注册 |
| `PreToolDecision` | `@deepseek-ai/dsh-tools`（events 增补） | 监听器返回值 |
| `ToolExecution` | `@deepseek-ai/dsh-tools` | 监听器入参（`name`/`arguments`/`agent`/`signal`） |

`tools/pre-execute` 事件由 `@deepseek-ai/dsh-tools` 的 events 模块对 cordis `Events` 接口做 declaration merging，import `@deepseek-ai/dsh-tools` 即可获得类型与事件通道。运行时唯一真实 import：无（全部 type-only + node 内建）——转译后的 `dist/index.js` 对宿主包零 require，这就是它能以 5.3 KB tarball 装进任何 profile 的原因。
