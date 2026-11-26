# TEXT-TOOL-CALL-LEAK — 工具调用标记泄漏进上下文：根因分析与根部解决方案

> 适用：DSH 部署在 **PTC（programmatic tool calling）模式**（API `tools` 数组只含 `run_code`）下，
> 模型把原生工具调用写成裸 `<tool_call>…` / `<function=…>` 标记文本、进入会话上下文但**永不执行**的故障。
> 依据：现场会话 `session-f2415117-d853-4cb8-8e3f-bd4e4fcf4c62`（2026-11-26 取证）+ 宿主 checkout
> `D:\Program files\deepseek-harness` 源码逐行核对。方案边界：**仅插件与配置可落地**，不改宿主源码。

## 1. 结论（TL;DR）

1. **这不是 bug，是 PTC 部署的结构性伴生故障**：PTC 执行器在协议层只暴露 `run_code` 一个工具
   （`tool-executor-ptc/src/index.ts:40-42`），原生工具（`read`、`todo_write`、`skill`…）从结构化调用
   通道**不存在**；模型一旦用预训练的原生调用语法发起调用，产物只能是纯文本。
2. **本会话 5 次泄漏零纠正的直接原因**是宿主唯一防线的**检测盲区**：`text-tool-call.ts:86` 在消息含
   任意 tool-call 块时直接豁免（"leftover markup … is narration around it"），而 PTC 混淆形态恰恰是
   "合法 run_code 块 + 泄漏标记"并存的混合块——5/5 全部落在盲区，且 nudge 每 turn 限一次。
3. **根部修复 = 三层组合**（全部插件/配置可落地）：
   - **A · 调用约定一致性**（提示层，治本）：消除"直调式工具清单"与 PTC 约定的矛盾；
   - **B · markup-guard 守卫**（插件层，本插件新增第四守卫，兜底）：补上宿主守卫的混合块盲区，
     检测到泄漏即注入一行式纠正，打断"重复 5 次"的循环；
   - **C · 模型档位**（配置层）：极限量化 + 低 effort 是泄漏率的放大器。

## 2. 现象

会话参数：cwd `D:\code\DSH`，模型 `strata/iq3_s`（GGUF 量化名，本地端点），`reasoningEffort=low`，
单轮 31 step、34 次工具调用、6 条用户消息。解码日志中 assistant 文本共出现 **5 段**裸标记：

| seq | 泄漏的调用 | 消息块形态 | 后果 |
|---|---|---|---|
| 19 | `skill(official-plugins)` | reasoning+text+tool-call | 从未执行；skill 未加载 |
| 28 | `skill(official-plugins)`（重试） | 同上 | 从未执行；模型自述 "The skill content didn't come back"，未意识到原因 |
| 163 | `read(dsh-purge/docs/INSTALLATION.md, offset 1)` | 同上 | 从未执行 |
| 172 | `read(同上, offset 5, limit 45)` | 同上 | 从未执行；seq 180 才经 `run_code` 内 `tools.read(...)` 以**完全相同的参数**补做成功 |
| 221 | `todo_write(...)`（771 字符） | 同上 | 从未执行；全文 34 次调用无任何 `tools.todo_write`，待办清单始终未写成 |

泄漏文本共 1592 字符，永久留在 assistant 消息里随上下文重放（本会话的两次 `compaction/prune`
只裁剪了大工具结果 seq 126/211，未触及这些文本）。**同一步里被解析执行的调用全部是 `run_code`**
（34/34），即模型不是完全失控，而是"想直调原生工具"时切换错了调用约定。

## 3. 证据链（日志事件 ↔ 宿主代码）

| # | 证据 | 位置 |
|---|---|---|
| 1 | `request/header`（seq 14/138/220）的 `header.tools` 数组**只有一项** `{name:"run_code"}` | 日志事件；构链见证据 2 |
| 2 | `describe()` 丢弃全部注册定义、只投影 run_code：`return { schemas: [projectToolSchema(this.requirePtcTransport(), false)], knownNames: [RUN_CODE_NAME] }` | `packages/core/tool-executor-ptc/src/index.ts:40-42`（保留名定义 `packages/core/tools/src/contracts.ts:13`） |
| 3 | 协议层只消费结构化增量：`if (choice?.delta?.tool_calls) …`，text delta 一律进文本块；pi-ai 与宿主各层**均无**对文本中 `<tool_call>` 标记的解析器 | `node_modules/.pnpm/@earendil-works+pi-ai@1.3.0_…/dist/api/openai-completions.js:441-470`（dsh 侧映射 `packages/llm/llm-pi-ai/src/stream.ts:190-221`） |
| 4 | 防线门控（盲区本体）：`if (content.some(block => block.type === 'tool-call')) return undefined` ——注释原话 "leftover markup in the same message is narration around it" | `packages/core/agent-loop/src/text-tool-call.ts:83-86` |
| 5 | 防线限频：nudge 只在 assistant 消息**无 tool-call 块**时检测一次，每 turn 一次（`phase.textToolCallNudged` 复位） | `packages/core/agent-loop/src/agent.ts:583-592`、`:338` |
| 6 | 泄漏消息全部是混合块（reasoning+text+tool-call），`detectTextToolCall` 在 `:86` 被豁免——**5 次泄漏 nudge 一次都没触发** | 日志 `assistant/message` 事件的 content kinds |
| 7 | assistant 消息（含泄漏文本）整条落盘：`live.settle('assistant/message', … session.append(...))` | `packages/core/agent-loop/src/agent.ts:558-576` |
| 8 | 该会话的 `<available_tools>` 直调式清单提醒（seq 13，样式 `- \`read({...})\`: …`）**不来自本 checkout**：`"The following tools are available"`、`<available_tools>` 全仓（含 docs/lib）零命中；本 checkout 的 PTC 提示只有 `tools:ptc-only` 段 + TS SDK 声明段 | 宿主 checkout 全文搜索；对照 `tool-executor-ptc/src/index.ts:28-31`、`packages/skill/tool-skill/src/index.ts:267-296`（`<available_skills>` 是唯一同构帧） |
| 9 | 宿主对直调非 run_code 名的兜底拒绝存在，但只在**结构化调用**到达执行层时才可能触发——纯文本泄漏到不了这一层 | `tool-executor-ptc/src/index.ts:14,32-37`（`PTC_ONLY_INSTRUCTION` + `reject` → `ToolNotFoundError`） |
| 10 | 宿主防线本身是本地补丁，曾随官方 checkout 更新丢失、2026-11-17 从 lib 构建产物反推恢复 | `packages/core/agent-loop/src/text-tool-call.ts` 头注释、`LOCAL-CHANGES.txt:29-99` |

## 4. 根因分层归因

### 4.1 结构层（必然性）

PTC 模式的价值主张是"工具调用走代码通道、子调用不出上下文"，为此 `describe()` 把 API 面压缩到
`run_code` 一个 schema 是**有意的设计**，不是缺陷。推论：只要部署选择 PTC，"原生工具不存在于
结构化通道"就恒成立，模型的原生调用语法**必然**退化为纯文本。宿主的 TS SDK 声明段
（`declare const tools: { [K in ToolName]: … }`）与 `PTC_ONLY_INSTRUCTION` 正是为对冲这一点而存在。

### 4.2 协议层（表现形态）

模型输出的 `<tool_call>` 标记走 text delta；pi-ai 只认 `delta.tool_calls`。于是"调用"与"文本"的
分流完全取决于**服务端**是否把标记解析进结构化字段——而 API `tools` 数组里只有 `run_code`，
本地服务的 grammar/解析器不会为其它名字产出 `tool_calls`。泄漏文本因此在宿主侧不可与真调用区分
（直到人来看），也没有任何机制把它从上下文剥离。

### 4.3 诱导层（为什么这个模型会混淆）

矛盾点：该会话的上下文里**同时存在两种工具呈现**——
- `<available_tools>` 提醒以**直调清单**样式列出原生工具（证据 8；注入方在 checkout 之外，
  样式与 Claude Code mods 同族，候选 `packages/experimental/claude-code-mods` 一类的外部注入）；
- 系统提示的 PTC 约定（"唯一直调 run_code，其余在代码内 `await tools.name(args)`"）。

量化模型（`iq3_s`）+ `effort=low` 时，"清单里写了 `read({...})` 就直接调用"的预训练惯性压过
PTC 约定。泄漏目标（`skill`、`read`、`todo_write`）全部是清单里列出的原生工具名，34/34 的成功
调用则是清单里**没有**的 `run_code`——两组数字互为印证。

### 4.4 防线层（为什么零纠正——本会话的成洞机制）

宿主 `text-tool-call.ts` 的两条规则叠加出一个精确盲区：
1. `:86` 门控：消息含任一 tool-call 块即豁免（设计假设：标记只是"调用周围的叙述"）；
2. 每 turn 一次：即便触发，同 turn 后续泄漏不再纠正。

PTC 混淆形态恰好反第一条：模型**同一条消息里**先写合法 run_code（真实工作），再用标记直调
原生工具（死文本）。5/5 落盲区 → 模型收不到任何"标记未执行"的反馈 → 从 seq 19 到 seq 221
横贯 20 个 step 重复同一错误。`README` 已吸收的教训（"不要把调用写进正文文本"）说明该故障
形态此前已出现过；宿主防线的门控假设在 PTC 混合块场景下被证伪。

### 4.5 模型层（放大器）

`iq3_s` 是激进量化档，`effort=low` 进一步压低格式遵从性。泄漏率与档位负相关——这不是根因，
但决定了同一宿主配置下泄漏出现的频率。

## 5. 根部解决方案（仅插件与配置可落地）

### 方案 A · 调用约定一致性（提示层，治本）

目标：让上下文里**不存在**与 PTC 约定矛盾的直调式工具呈现，或在其旁补一条不可忽略的约定声明。

**A1 · 关闭/改写直调清单的注入源（profile patch，配置层）**：定位注入 `<available_tools>` 提醒的
插件/构建（本 checkout 零命中，需在**实际部署**的构建中定位；样式同族的候选是 claude-code-mods
一类 mods）。处理二选一：
- profile patch 不挂载该插件（若它只服务直调模式）；
- 或保留其功能、但确认其清单文案明确标注"仅限 run_code 内部使用"（若注入方支持配置）。

**A2 · 插件注入常驻约定声明（插件层，不依赖定位成功）**：用
`ctx.systemPrompt.context({ name, order, text })`（`packages/core/system-prompt/src/index.ts:590-599`，
现有同构用法：`sandbox-policy` `packages/sandbox/sandbox-policy/src/index.ts:185-192`）注册一段
动态 context。它经 `RuntimeContextProjection` 汇入每步的 `<system-reminder>` 快照
（`agent-loop/src/runtime-context.ts:76-92`），常驻且随 step 刷新。文案草稿（英文，对齐系统提示语域）：

```text
[ptc-call-convention]
`run_code` is the ONLY tool you can call directly on the tool-call channel.
Every other tool in any list you see is declared for use INSIDE a run_code
program: call it as `await tools.name(args)` in the program body. A tool call
written as text markup (`<tool_call>`, `<function=…>`, `<invoke name="…">`) is
never executed — it is prose, no result is pending, and the intent is lost.
```

这段声明与宿主已有的 `tools:ptc-only` 段（`tool-executor-ptc/src/index.ts:14,29`）语义一致，
但位置在每步刷新的快照提醒里——离泄漏发生的位置（assistant 文本之后、下一步之前）更近，
对抗长上下文中的指令衰减。

### 方案 B · markup-guard 守卫（插件层兜底，推荐落地于本插件）

定位：本插件的第四条守卫（路径预检 / 循环守卫 / 载荷守卫 / **标记守卫**）。宿主守卫只管
"整条消息纯文本死调用"（`:86` 门控的原始场景），本守卫专管它豁免的**混合块泄漏**——分工互补，
不重复触发（宿主 nudge 每 turn 一次且只覆盖无调用块形态）。此外宿主防线是**本地补丁**而非官方
实现：2026-11-17 曾随 checkout 更新整文件丢失，当天 6 个会话 9 次文本形态调用全部无拦截
（`LOCAL-CHANGES.txt:54-58`）——宿主侧补丁的存续不可依赖，插件侧守卫必须能独立存在。

**检测点**：`agent/pre-step` waterfall（`packages/core/agent-loop/src/agent.ts:300-310`）。
每步开始时检查**上一条** assistant 消息：若有 text 块命中泄漏标记、则返回
`{ kind:'enter', messages: [...原消息, 纠正消息] }` 追加一条 user 纠正（同 hook 的既有用法：
`packages/context/agent-instructions`、`packages/skill/tool-skill` 等 15+ 处）。
选择这个点而非 `agent.inject` 的原因：注入发生在下一步请求组装**之前**，纠正与泄漏消息相邻，
模型无需跨 step 关联；`agent.inject`（`agent.ts:186-188`）作为 turn 收尾场景的备选通道保留。

**检测逻辑**（伪代码，语义对齐宿主 `text-tool-call.ts` 以复用其已踩坑结论）：

```
detectMarkupLeak(content: ContentBlock[]): Attempt | undefined
  text   := content 中全部 text 块拼接            // 与宿主不同：不检查 tool-call 块是否存在——混合块正是目标
  text   := stripCodeFences(text)                 // 复用宿主 withoutCodeFormatting 语义（text-tool-call.ts:60-76）：
                                                  //   fenced code / inline code 内的标记是文档不是尝试
  start  := text.search(MARKUP_START)             // /<(?:tool_call[\s>]|function=|invoke\s+name=|antml:)/
  if start < 0: return undefined
  markup := text.slice(start)
  if !MARKUP_BODY.test(markup) || len(markup) < 40: return undefined   // 排除叙述性提及（"use <tool_call> syntax"）
  name   := NAME_PATTERNS 依次尝试                // <function=x> / <invoke name="x"> / JSON 形态，上限 64 字符
  return { name }

onPreStep(args, next):
  last := args.messages 中最后一条 assistant/message
  attempt := last 存在 ? detectMarkupLeak(last.textBlocks) : undefined
  if attempt === undefined 或 本 turn 已注入 ≥ markupBlock(默认 2) 次: return next()
  记账；return next({ kind:'enter', messages:[...args.messages, nudge(attempt, escalation.step())] })
```

**纠正文案草稿**（参考宿主 `textToolCallNudge` `text-tool-call.ts:108-126`，补 PTC 语义）：

```text
[Guard check — the tool call in your previous message never ran]
Your previous message contained a tool call written as text markup
(<function="{name}">…). Markup inside an answer is never executed: nothing
ran, no result is pending, and the intent was lost.
"{name}" is not directly callable in this session — the only directly
callable tool is `run_code`. Re-issue the intent from inside a run_code
program: `const x = await tools.{name}({ … })`.
```

按 `repeat-guard.ts` 的 `DenialEscalation` 模式升级：第 2 次起点名"你已在本次会话重复此错误 N 次，
原因是把直调清单当成了可调用工具"，并在 turn 内达到预算后静默（对齐 args-guard 的
`softBudget` WeakMap 每 agent 每 turn 计数模式，`src/index.ts:192-194`）。

**配置键**（沿用 `numeric()` 卫生检查模式，`src/index.ts:161-167`——typo 不得静默禁用守卫）：

| 键 | 默认 | 语义 |
|---|---|---|
| `markupBlock` | `2` | 每 turn 最多注入的纠正条数；`0` 关闭本守卫 |
| `markupMinChars` | `40` | 标记段最短长度（对齐宿主 `MIN_MARKUP_CHARS`，防误报） |

**边界与已考虑的误报源**：fenced code 内的标记（strip 后不触发）、叙述性提及（无 body 不触发）、
报告型文本引用其他会话的故障标记（body 完整但出现在含 tool-call 块的消息里时**仍会触发**——
这是与宿主门控相反的取舍；用每 turn 预算 + 升级文案控制代价，且本插件面向的用户场景中
"诊断报告 + 泄漏并存"远少于真实泄漏）。`disabled: true` 沿用插件级总开关。

### 方案 C · 配置层（部署执行）

- 该部署换更高量化档（≥ `iq4_xs`）或 `reasoningEffort: medium`：直接降低泄漏率；
- **provider 层不是根因也非修复面**，但有一个反直觉的备选值得知晓：若本地服务的 chat template
  能把 `<tool_call>` 解析进 `delta.tool_calls`（pi-ai 对 name 无白名单、透传），这些调用会抵达
  宿主执行层并被 `PTC_ONLY` reject 为 `ToolNotFoundError`（证据 9）——**那个错误会作为 tool result
  回给模型，形成自纠**，好过纯文本死寂。这不是推荐路线（依赖服务端解析器行为，且错误轮次更长），
  但说明"标记变文本"的静默性才是最坏性质。

### 方案 D · 观测层（可选，联动 dsh-agent-session-tools）

`session_error_audit` 的 `classifyErrorText` 词表新增 `leaked-tool-call` 类别——审计扫日志时对
assistant 文本含 `<tool_call>` 标记的会话计数（现行词表只看 `tool/result` 的 isError，看不见本类
故障）。成本极低，让修复效果可度量（见 §6 验证指标）。

### 推荐组合

**A2 + B 必做**（A 治本、B 兜住提示层覆盖不到的模型侧漂移——本次 5 连漏证明模型不会自愈）；
**A1** 在部署构建中定位注入源后执行；**C** 按部署预算执行；**D** 低成本可选。

## 6. 验证方案

1. **守卫单元测试**（fixture 直接驱动 `detectMarkupLeak` 与 pre-step 装配）：
   - 命中集：本会话 5 种真实泄漏形状（seq 19/28/163/172/221 原文截取）、`<invoke name=…>` 变体、
     JSON `<tool_call>{"name":…}` 变体；
   - 误报集：fenced code 内标记、inline code 提及（`use <tool_call> syntax`）、<40 字符残片、
     纯 tool-call 消息（无 text 块）；
   - 限频：同 turn 第 3 次泄漏不再注入；`markupBlock: 0` 完全关闭；typo 配置告警回退默认。
2. **现场复现**：同部署（同模型档位）发起"加载 skill + 读文档 + 写 todo"类任务（正是本次泄漏的
   三个意图），对比守卫关闭/开启两轮：开启后泄漏应被纠正注入打断、意图以 run_code 形式补做
   （本会话中 `read` 的 seq 172→180 补做路径证明模型具备正确重发能力，缺的只是反馈）。
3. **审计指标**：守卫上线前后各扫一轮历史会话（方案 D 的 `leaked-tool-call` 类别），泄漏计数
   应收敛到 0；同时确认 `session_error_audit` 现有 10 类词表无回归。

## 7. 附录 · 证据索引

| 对象 | 位置 |
|---|---|
| 现场日志（zstd） | `C:\Users\Administrator\.dsh\sessions\--D-code-DSH--\session-f2415117-d853-4cb8-8e3f-bd4e4fcf4c62\session.v4.jsonl.zstd`（285 事件；解码件在 `%TEMP%\dsh-sess-analysis\session.jsonl`） |
| PTC 结构决定 | `packages/core/tool-executor-ptc/src/index.ts:14`（PTC_ONLY_INSTRUCTION）、`:28-31`（sections）、`:32-37`（reject）、`:40-42`（describe）、`:95-97`（name/inject）；`packages/core/tools/src/contracts.ts:13`（RUN_CODE_NAME） |
| run_code 工具定义与描述 | `packages/core/tool-executor-ptc/src/ptc.ts:53-67`、`:263-296`；TS SDK 渲染 `ts-types.ts:308-335` |
| 协议层分流 | `node_modules/.pnpm/@earendil-works+pi-ai@1.3.0_…/dist/api/openai-completions.js:441-470`；dsh 侧 `packages/llm/llm-pi-ai/src/stream.ts:190-221` |
| 宿主防线（本地补丁） | `packages/core/agent-loop/src/text-tool-call.ts`（`:34` MARKUP_START、`:40` MARKUP_BODY、`:43` MIN_MARKUP_CHARS、`:60-76` 剥代码块、`:83-99` 检测+`:86` 门控、`:108-126` nudge）；接线 `agent.ts:583-592`、限频复位 `:338`；补丁史 `LOCAL-CHANGES.txt:29-99`（2026-11-12 生产事故 session c1b51248、2026-11-17 反推恢复） |
| 落盘路径 | `packages/core/agent-loop/src/agent.ts:558-576`（assistant/message settle）；`packages/core/tools/src/batch.ts:243-282`（tool/call、tool/result 配对） |
| 注入扩展点 | pre-step waterfall `agent.ts:300-310`；`systemPrompt.context()` `packages/core/system-prompt/src/index.ts:590-599`（同构用法 `sandbox-policy/src/index.ts:185-192`）；快照投影 `agent-loop/src/runtime-context.ts:76-92`；`agent.inject` `agent.ts:186-188` |
| 本插件既有资产 | `README.md`（"不要把调用写进正文文本"教训）、`src/index.ts:143-194`（钩子与 `numeric()` 配置卫生）、`src/repeat-guard.ts`（DenialEscalation）、`src/args-guard.ts`（agent.inject / softBudget 先例）、`docs/release-notes/v1.4.0.md`（同族故障案例的文档先例） |
