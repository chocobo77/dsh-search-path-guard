# 01 · 项目定位与整体架构

## 1. 这个项目是什么

`dsh-search-path-guard` 是一个 DeepSeek Harness（DSH）宿主插件：当模型的 `grep` / `glob` 调用携带**不存在的搜索路径**时，在 ripgrep 子进程启动之前拦截该调用，返回一行式、自带修正建议的拒绝文案。

它解决的不是假想问题——74 个历史会话 287 条 `isError` 工具错误中，27 条是坏路径搜索；其中 15 条按官方 GitHub 仓库布局臆测 `deepseek-harness` 安装目录的 pnpm 布局。rg 的 stderr 原样（含 GBK 乱码）进入模型上下文后，模型往往拿着坏路径继续重试，把一次失误放大成多次。

## 2. 宿主接入机制（为什么"预检"必须在插件层做）

DSH 用 cordis 做组合层。工具调用派发前会经过 `tools/pre-execute` waterfall，每个监听器拿到执行上下文（`exec.name`、`exec.arguments`、`exec.agent`、`exec.signal`）并返回一个决策：

```ts
type PreToolDecision =
  | { kind: 'allow' }                       // 放行
  | { kind: 'deny'; reason: string }        // 终局拒绝，reason 即模型看到的文案
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?; displayReason? }
```

关键性质：**monotonic**。监听器没有 allow 结果——不认识的一切必须 `return next()` 原样放行；一旦有监听器 deny，后续监听器无法翻盘。这保证了本守卫的拒绝是终局性的，也保证了它对宿主行为的侵入面最小：它只能"多拒绝"，永远不能"放行本该拒绝的调用"。

插件入口遵循 Cordis 契约：

```ts
export const name = 'search-path-guard'          // 组合层行标识
export const inject = ['workingDirectory']       // 声明依赖的宿主服务
export function apply(ctx: Context, config?: GuardConfig): void
```

`apply` 内的 `ctx.on(...)` 监听器在插件卸载时由 Cordis 自动回收。

## 3. 拦截决策流（完整）

```
tools/pre-execute (exec)
  ├─ exec.name ∉ {grep, glob, read, read_image, edit}   → next()  放行
  ├─ exec.arguments 非 object / 目标键非字符串           → next()  放行（schema 校验的职责）
  ├─ workdir.ensure() 抛错                              → next()  放行（工具自己的失败要自己报）
  ├─ workdir 本身不可 stat                              → next()  放行（见 §4 防御性设计）
  ├─ grep/glob/read/read_image：解析后目标存在           → next()  放行（§4：存在性是唯一主张；
  │                                                      read_image 额外做扩展名主张）
  ├─ read_image：存在的非图片文件（如 .svg）              → deny   "…is text: use read"
  ├─ grep/glob/read/read_image：解析后目标不存在          → deny   一行式 glob-near 文案
  ├─ edit：文件 >2MB 或 stat/读取失败                    → next()  放行（内容主张不适用于此）
  ├─ edit：old_string 在当前内容中不存在                 → deny   并发修改提示 + 重读要求
  ├─ edit：old_string 多次匹配且未 replace_all           → deny   报告匹配次数
  └─ 其余（唯一匹配 / replace_all=true）                 → next()  放行
```

拒绝文案（与内核兜底实现逐字一致）：

```
grep search failed: path "X" does not exist — glob near "<已解析父目录，正斜杠形式>" to list existing candidates, then retry with an existing path
```

文案设计目标：一行、含事实（路径不存在）、含动作（先 glob 父目录列出真实候选）、含重试条件（用存在的路径重试）——模型拿到的信息足以自愈，而不是再猜一次。

## 4. 防御性设计原则

每一条"放行"分支都是刻意的：

1. **存在性是唯一主张**——路径存在但被锁定、无权限（如 rg `os error 5`）仍归 rg 自己报。预检若吞掉这类错误，反而制造新的诊断盲区。
2. **虚拟 workdir 防御**——production 里 `ctx.workingDirectory.ensure()` 保证 workdir 存在；但脚本化测试 fixture 可能用 notional 目录。workdir 不可 stat 时整个预检跳过，宁可漏检不可误杀。
3. **schema 的事不抢**——path 缺失/类型错误是工具 schema 校验的错误域，守卫不重复报。
4. **解析前先放行相对路径的歧义**——相对路径基于 workdir 解析，workdir 缺失时无从谈起，直接放行。

## 5. 与内核补丁的关系

宿主 checkout 的 `packages/fs/tool-fs-search/src/search-core.ts` 里有一份等价实现 `preflightSearchPath()`——在 `runRipgrep` spawn 前检查 `--` 后的搜索根。两者：

- 文案逐字一致；
- 作用层不同：插件在**调用策略层**（pre-execute，连 rg 进程都不创建），内核在**执行层**（spawn 前）；
- 可共存，互为冗余：插件先拒；未挂载本插件的 profile 或 CLI 直连场景由内核兜底。
- 任选其一时：摘除内核补丁不影响本插件；`config.disabled: true` 可停用本插件。长期形态建议只保留插件层（随 profile 走、可配置停用、不依赖宿主发版）。
