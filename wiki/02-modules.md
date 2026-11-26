# 02 · 模块职责与源码导读

## 1. 目录结构

```
dsh-search-path-guard/
├── package.json            @local 包清单：exports、files、dsh.bundle.patch 指针
├── cordis.yml              开发组合（--patch 直挂 ./dist/index.js，免打包）
├── cordis.patch.yml        安装补丁（insert 一行到 profile 组合）
├── src/
│   ├── index.ts            apply(ctx, config?)：全部宿主接线（七个监听器 + systemPrompt 注入）
│   ├── preflight.ts        路径/内容主张纯判定（searchPathDenial、editDenial，无宿主 import）
│   ├── repeat-guard.ts     循环守卫：ZeroResultTracker + DenialEscalation + 文案（无宿主 import）
│   ├── args-guard.ts       载荷守卫：CJK 估算 + 文案 + MalformedStreak/NudgedTurns（无宿主 import）
│   └── markup-guard.ts     标记守卫：泄漏检测 + 纠偏文案 + MarkupTurnBudget/LeakStreak（无宿主 import）
├── tests/
│   ├── preflight.test.ts   19 例（tmp 目录上做真实文件系统判定）
│   ├── repeat-guard.test.ts 14 例（跟踪器语义、LRU、文案契约）
│   ├── args-guard.test.ts  14 例（估算比例、截断语义、文案契约、跟踪器）
│   ├── markup-guard.test.ts 19 例（宿主 fence 语义钉住、三形态命中、误报集、预算与升级）
│   └── index.test.ts       23 例（fake context 捕获七个监听器，接线级行为）
├── scripts/build.mjs       零安装构建垫片（从工作区共享骨架复制）
├── pack.ps1 / .cmd / .sh   一键打包（校验清单含全部五个 dist 模块）
├── tsconfig{,.build,.typecheck}.json / vitest.config.ts
├── README.md               项目说明（行为、配置、安装）
├── LICENSE / icon.svg
├── release-body.md         最近一次发布的 GitHub Release 正文
├── release/                pack 产物（tgz + SHA256SUMS.txt）
└── wiki/                   本文档
```

## 2. 模块职责与依赖方向

```
tests/ ──直测──▶ src/preflight.ts ◀──┐
   │             src/repeat-guard.ts ├──调用── src/index.ts
   │             src/args-guard.ts  ─┘             │ ctx.on(...)×7
   │             src/markup-guard.ts ─┘            │ + systemPrompt 注入（结构化面）
   └─fake ctx──────────────────────────────────────┤
                                                   ▼
                            宿主服务：workingDirectory（ensure）、
                            agent.session / agent.inbox / agent.inject、
                            session.requestContext()（结构化读取，全部"证明不了就放行/不缩放"）
```

- **四个纯模块是全部领域逻辑**（preflight / repeat-guard / args-guard / markup-guard）：只依赖 `node:` 内建，不 import 任何宿主包，因此可在 tmp 目录 / 纯内存上直测，不需要宿主运行时。
- **`index.ts` 是全部宿主接线**：从 `exec` / 事件负载提取参数 → 调纯函数 → 翻译成宿主决策（`PreToolDecision` / `PostToolDecision` / `RequestErrorAction` / `PreStepDecision`）。宿主服务只按**结构化类型**读取（`WorkingDirectoryLike`、`SessionLike`、`SystemPromptLike`），不 import 整个服务面类型——构建垫片只需类型垫片，运行时对宿主包零 require。

## 3. src/index.ts 导读（逐段）

| 段 | 内容 |
|---|---|
| 类型 | `GuardConfig`（十个键，见 wiki/04）；`WorkingDirectoryLike`、`SessionLike`、`SystemPromptLike`（结构化最小面） |
| 导出 | `name = 'search-path-guard'`、`inject = ['workingDirectory']`、`apply` |
| `apply` 开头 | `config?.disabled === true` → 直接 return（bundle 可保持安装而守卫卸载）；数值键全部 `numeric()` 告警回退，`argsSoftTokens` 夹到硬限内，比例键夹 `[0,1]` |
| 状态 | `ZeroResultTracker`、`DenialEscalation`、`MalformedStreak`、`NudgedTurns`、`MarkupTurnBudget`、`LeakStreak`、`workdirCache`/`lastContextTokens`/`openTurn`/`softBudget`/`lastAssistant`（WeakMap，session/agent 身份为键） |
| `deny`/`allow` 包装 | deny 走 `DenialEscalation`（连续第 3 次起追加升级段）；allow 清零计数 |
| `tools/pre-execute` | 六关：载荷硬限（最先，不限名单）→ pathKey 名单 → 参数类型 → workdir 解析 → grep 零结果锁 → 路径/内容主张（详见 wiki/01 §3） |
| `tools/result`（观察器） | grep 零结果计数（`No matches found` 标记）；忽略 `Error: loop-guard` / `Error: payload-guard` 开头的回灌——守卫自己的拒绝不是搜索结果 |
| `session/event`（观察器） | `assistant/message` 记 `usage.totalTokens`（压力信号）+ 缓存消息文本与 turn（标记守卫检测输入，turn 随行做时效门）；`turn/start` 记当前 turn（软提醒预算）；`turn/end completed` 清 MALFORMED streak |
| `tools/post-execute` | 成功 + 参数 ≥ `argsSoftTokens` → `accept.additionalContexts` 追加拆小提醒（每 turn ≤2） |
| `agent/request-error` | `MALFORMED_RESPONSE` 预算内 → inbox 追加纠偏 + `{kind:'retry'}`；否则 `next()` 交还宿主 |
| `agent/error` |  MALFORMED 且该 turn 未被 request-error 纠偏过 → `agent.inject` 一次 |
| `systemPrompt` 注入 | `ctx.inject(['systemPrompt'])` → `context({ name: 'search-path-guard:ptc-call-convention', order: 118 })`：每步快照的 PTC 调用约定（A2，wiki/01 §7）；无 session 的投影返回空串（sandbox-policy 同款门控） |
| `agent/pre-step` | 标记守卫纠偏（B）：本 turn 最新 assistant 消息文本命中泄漏 → `{...decision, messages: [...decision.messages, 纠偏]}` 追加（tool-skill 同款形状，追加在 decision 而非 args——waterfall 兜底 handler 闭包引用原始 claimed，改 args 无效）；reject 直接透传不花预算 |

## 4. src/args-guard.ts 导读（逐段）

| 段 | 内容 |
|---|---|
| `estimateTokens` | CJK 感知估算：Han 系（含扩展 A、和字区、假名、谚文）≈1 token/字，其他 ≈¼；与 dsh-infinite-context token-budget 同口径（本地复制，保持零依赖） |
| `estimateArgsTokens(value, cap)` | 递归走参数树求和；超过 `cap` 提前停（pre-execute 每次调用都跑，成本 O(cap)）；深度 64 封顶，超深处的载荷不计数（防恶意嵌套） |
| `argsHardDenial` / `argsSoftReminder` / `malformedNudge` | 三段模型可见文案：一行式硬拒（含估算值、限额、拆小指令）、事后软提醒、断流纠偏指引（自带"已落盘则忽略"防误伤措辞）。全部不含 `No matches found`——防自己的 result 观察器误读 |
| `MalformedStreak` / `NudgedTurns` | 按 `String(session.id)` 键控的 LRU 跟踪器（`ZeroResultTracker` 同款：只在插入新键时驱逐，读不清零）；前者封顶重试次数，后者保证每 turn 只纠偏一次 |

## 5. src/preflight.ts / src/repeat-guard.ts / src/markup-guard.ts 导读

- `preflight.ts`：`guardedTools` + `pathKeyFor`（名单与目标键映射）、`searchPathDenial`（存在性主张 + glob-near 文案）、`editDenial`（`old_string` 内容主张：0 次/多次匹配拒绝）、`countOccurrences`、`EDIT_PREFLIGHT_MAX_BYTES`。
- `repeat-guard.ts`：`ZERO_RESULT_MARKER`（与 dsh-tool-fs-search 的跨包文案耦合，上游改词需同步）、`ZeroResultTracker`（目标归一键、LRU）、`zeroResultDenial`、`DenialEscalation`/`escalatedReason`（连续拒绝升级，含"文本形态调用不会被执行"教训）。
- `markup-guard.ts`：`PTC_CALL_CONVENTION`（A2 常驻声明文案）、`detectMarkupLeak(text, minChars)`（宿主检测语义逐字复用**去掉调用块豁免**；`withoutCodeFormatting` 与宿主逐字节一致——fence 闭合正则实际要求 ≥5 个反引号，fence 一旦打开吞到消息尾，宁可漏检不错纠）、`markupNudge(attempt, repeat)`（纠偏文案，第 2 次起带 `markup-leak #N` 升级）、`MarkupTurnBudget`（每 agent 每 turn 注入预算）、`LeakStreak`（连续泄漏计数，干净消息清零）。

## 6. 测试职责

| 文件 | 覆盖点 |
|---|---|
| `tests/preflight.test.ts` | 相对/绝对坏路径的文案内容与单行性；存在路径与空白 path 放行；虚拟 workdir 与非守卫工具防御；edit 内容主张（0/1/多次、超限、不可读） |
| `tests/repeat-guard.test.ts` | streak 计数与清零、LRU 满容量时活跃目标存活、读取不驱逐、升级文案、marker 契约 |
| `tests/args-guard.test.ts` | CJK/ASCII 估算比例与扩展区；嵌套求和、cap 提前截断、深度封顶；三段文案（单行、数字、防误伤措辞、不含 marker）；两个跟踪器的计数/LRU 语义 |
| `tests/markup-guard.test.ts` | 宿主 fence 语义钉住（打开即吞尾、unclosed 同款）；inline code 剥除；`<function=…>`/`<invoke name=…>`/JSON `<tool_call>` 三形态命中与名字提取；无名字、叙述提及、fenced 诊断报告、短残片误报集；纠偏文案（未执行 + run_code 补做 + #2 升级）；`PTC_CALL_CONVENTION` 契约；预算/升级两个跟踪器 |
| `tests/index.test.ts` | fake ctx 捕获七个监听器：坏路径/零结果/载荷三类 deny、压力缩放生效路径、软提醒预算与失败不带、MALFORMED 有限重试 + inbox 纠偏 + completed 清零、inject-only 模式去重、载荷拒绝不污染零结果 streak、配置告警回退、`disabled:true` 不注册；标记守卫接线（同 turn 注入/跨 turn 静默/干净清零/预算耗尽/`markupBlock:0` 关闭/reject 不花预算）与 systemPrompt 注册门控 |

设计取向：**宁可测试冗余，不测实现细节**——断言文案包含 `does not exist`、`glob near`、`payload-guard:`、`MALFORMED_RESPONSE`、`never ran` 这类行为锚点，而不是完整字符串；内核或文案微调时测试不碎。
