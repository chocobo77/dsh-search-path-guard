# 03 · 关键类型与函数参考

## src/preflight.ts

### `guardedTools`

```ts
export const guardedTools = ['grep', 'glob'] as const
```

守卫名单。扩展方式：往数组加名字即可（判定逻辑按名单分派，无其他硬编码）。

### `searchPathDenial(params)`

```ts
export function searchPathDenial(params: {
  name: string      // 工具名，须在 guardedTools 内才参与判定
  path: string      // 模型提供的搜索根（原始字符串，未解析）
  workdir: string   // 该 agent 的工作目录（workingDirectory.ensure 的产物）
}): string | undefined
```

- **返回 `string`**：一行式拒绝文案，即 `PreToolDecision {kind:'deny'}` 的 `reason`。
- **返回 `undefined`**：放行。
- 判定顺序（短路）：名单 → 空白 path → 解析（绝对保留，相对拼 workdir）→ workdir 可 stat？→ 路径存在？
- 文案格式：`"${name} search failed: path "${path}" does not exist — glob near "${父目录正斜杠}" to list existing candidates, then retry with an existing path"`。父目录取 `resolve(解析路径, '..')` 并把 `\\` 归一为 `/`（与 DSH 其他模型可见文案的路径风格一致）。

## src/index.ts

### `GuardConfig`

```ts
export interface GuardConfig { disabled?: boolean }
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
// 1. name ∉ {grep, glob}                    → next()
// 2. arguments 非 object / path 非字符串     → next()
// 3. workdir = await ensure(agent, signal)；抛错 → next()
// 4. reason = searchPathDenial(...)；undefined → next()；否则 {kind:'deny', reason}
```

## 宿主契约（本插件依赖的外部类型，均 type-only）

| 类型 | 来源 | 用途 |
|---|---|---|
| `Context` | `@deepseek-ai/cordis` | apply 参数；`ctx.on` 注册 |
| `PreToolDecision` | `@deepseek-ai/dsh-tools`（events 增补） | 监听器返回值 |
| `ToolExecution` | `@deepseek-ai/dsh-tools` | 监听器入参（`name`/`arguments`/`agent`/`signal`） |

`tools/pre-execute` 事件由 `@deepseek-ai/dsh-tools` 的 events 模块对 cordis `Events` 接口做 declaration merging，import `@deepseek-ai/dsh-tools` 即可获得类型与事件通道。运行时唯一真实 import：无（全部 type-only + node 内建）——转译后的 `dist/index.js` 对宿主包零 require，这就是它能以 5.3 KB tarball 装进任何 profile 的原因。
