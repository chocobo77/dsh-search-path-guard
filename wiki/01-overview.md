# 01 · 项目定位与整体架构

## 1. 这个项目是什么

`dsh-search-path-guard` 是一个 DeepSeek Harness（DSH）宿主插件：当模型的 `grep` / `glob` 调用携带**不存在的搜索路径**时，在 ripgrep 子进程启动之前拦截该调用，返回一行式、自带修正建议的拒绝文案。1.3.x 起并入**循环守卫**（同一目标连续零结果 grep 拒绝），1.4.0 起并入**载荷守卫**（超大工具参数与 `MALFORMED_RESPONSE` 断流的三层防线，见 §6）与**标记守卫**（文本形态工具调用标记泄漏的检测纠偏 + PTC 调用约定常驻声明，见 §7）。

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
  ├─ 载荷守卫：arguments 是对象且估算体积 ≥ 有效硬限    → deny   payload-guard 拆小指引（不限工具名单，最先跑）
  ├─ exec.name ∉ {grep, glob, read, read_image, edit}   → next()  放行
  ├─ exec.arguments 非 object / 目标键非字符串           → next()  放行（schema 校验的职责）
  ├─ workdir.ensure() 抛错                              → next()  放行（工具自己的失败要自己报）
  ├─ workdir 本身不可 stat                              → next()  放行（见 §4 防御性设计）
  ├─ grep：同一目标连续零结果 ≥ zeroResultBlock           → deny   循环失控指引（任何非零结果清零）
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

## 6. 载荷守卫（MALFORMED_RESPONSE 防线）

触发事件：某会话一个 `edit` 调用的参数 JSON 在 772 字符处断流（超长转义中文 `new_string`），宿主判 `MALFORMED_RESPONSE`，turn 以错误结束——零重试、零纠偏。物理解释：该错误发生在**响应流组装期**，参数从未进入工具管道，宿主也明确禁止 pre-dispatch 参数改写（`PreToolDecision` 注释 "Input rewriting is excluded"）。所以载荷守卫不"修形"，它掰三个时刻：

| 时刻 | 通道 | 行为 |
|---|---|---|
| 下一颗子弹（事前） | `tools/pre-execute` 第一分支 | CJK 感知估算参数体积（汉字≈1 token、其他≈¼，与 dsh-infinite-context token-budget 同口径），≥ 有效硬限 → deny + 拆小指引。上下文占用率（最近 `assistant/message` 的 `usage.totalTokens` ÷ `requestContext().contextWindow`）≥ `pressureRatio` 时硬限乘 `pressureHardFactor`；证明不了占用（无 usage/无窗口）就不缩放 |
| 掰下一次生成（事中） | `tools/post-execute` → `accept.additionalContexts`（宿主注释明示"attach context for the next request"） | **成功**且参数 ≥ `argsSoftTokens` 的调用，随下一请求附带一行拆小提醒；每 turn ≤2 条（随 `turn/start` 复位），失败结果与 deny 结果不带 |
| 断流真发生（事后） | `agent/request-error` waterfall → `{kind:'retry'}`；`agent/error` → `agent.inject` | 按码消费 `MALFORMED_RESPONSE`（宿主内置码，此前零消费）：按会话计数，`malformedRetry` 次内先 `agent.inbox.append('next-step', 纠偏文案)` 再请求重试；重试通道关掉（`0`）则 `agent/error` 每 turn 一次 inject。纠偏文案自带防误伤措辞（改动已落盘就忽略）——nudge 同样会到达重试**成功**后的下一步 |

两个跟踪器（`MalformedStreak` / `NudgedTurns`，LRU 有界，`ZeroResultTracker` 同款姿势）保证：重试有限、每 turn 只纠偏一次、turn 以 `completed` 收尾即清零（可见进展）。估算器走参数树时对 cap 提前截断——pre-execute 在每次调用上跑，成本恒为 O(cap)。

注意：若同时安装 `dsh-llm-retry`，**不要**把 `MALFORMED_RESPONSE` 加进它的 `retryableCodes`——本守卫已按码有限重试，叠加会双重重试。

## 7. 标记守卫（文本形态工具调用泄漏）

依据 `docs/TEXT-TOOL-CALL-LEAK.md`（session f2415117，2026-11-26 取证）：PTC 部署的 API 面只有 `run_code` 一个工具（`tool-executor-ptc` 的 `describe()` 有意压缩），模型的原生调用语法一旦发出就**必然**是纯文本——泄漏文本永久留在上下文里，且永不执行。现场单轮 31 step 泄漏 5 次（`skill`×2、`read`×2、`todo_write`），全部是"合法 run_code 块 + 泄漏标记"的**混合消息**：宿主防线 `text-tool-call.ts:86` 的门控"消息含任一调用块即豁免"恰好把这 5 次全放过（其设计假设"标记只是调用周围的叙述"被 PTC 混合形态证伪），模型跨 20 step 重复同一错误，零纠正。泄漏目标全部是 `<available_tools>` 直调式清单里列出的原生工具名，34/34 成功调用则是清单里没有的 `run_code`——两组数字互为印证："清单里写了就直调"的预训练惯性压过了 PTC 约定。

守卫掰两个层面（提示层治本 + 检测层兜底，均在插件可落地边界内）：

| 层 | 通道 | 行为 |
|---|---|---|
| A2 · 常驻约定（治本） | `systemPrompt.context()` → 每步刷新的系统提示快照（order 118，SANDBOX_POLICY 与 SUBAGENT_DELEGATION 之间的策略簇） | `[ptc-call-convention]`：`run_code` 是唯一直调工具，清单里的其余工具只能在 run_code 内 `await tools.name(args)`；与宿主静态 `tools:ptc-only` 段语义一致，但位置离泄漏发生点更近，对抗长上下文中的指令衰减 |
| B · 泄漏纠偏（兜底） | `session/event(assistant/message)` 缓存最新消息 → `agent/pre-step` 检测本 turn 消息 | 文本块命中泄漏标记 → 在 step 消息**尾部**追加纠偏 user 消息（指名未执行 + `await tools.name(…)` 补做路径）；第 2 条起带 `markup-leak #N` 升级文案；每 turn ≤ `markupBlock` 条 |

检测语义逐字复用宿主 `text-tool-call.ts` 的已踩坑结论（`MARKUP_START`/`MARKUP_BODY`/`NAME_PATTERNS`/`MIN_MARKUP_CHARS`/剥代码块），但**去掉 `:86` 的调用块豁免**——混合块正是目标；fenced code / inline code 内的标记是文档不是尝试，剥除后才搜索（宿主语义逐字节保留：fence 一旦打开吞到消息尾，宁可漏检不错纠）。两个状态量：`MarkupTurnBudget`（每 agent 每 turn 的注入预算，`turn` 号自带复位）与 `LeakStreak`（连续泄漏升级计数，本 turn 见到干净消息即清零）。

已考虑的误报源与取舍：fenced/inline code 内标记（剥除后不触发）、叙述性提及（无 body 不触发）、<`markupMinChars` 残片（不触发）、已结束 turn 的旧泄漏（turn 匹配门——过期意图追纠会让守卫自身成为噪音）、诊断报告引用他处故障标记（若与真实调用块同消息**仍会触发**——与宿主门控相反的取舍，用每 turn 预算控制代价，本部署"报告+泄漏并存"远少于真实泄漏）。
