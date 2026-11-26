# dsh-search-path-guard

四条一行式自愈防线的宿主插件：

1. **搜索路径预检**——模型给出的搜索/读写路径不存在时，在 ripgrep 启动**之前**拒绝该调用，返回一行式、自带修正建议的错误文案；替代 rg 原生的 exit 2 + 本地化 stderr（本部署上常为 GBK 乱码）进入模型上下文。
2. **循环守卫**——同一目标连续 N 次零结果 grep 直接拒，强制换策略。
3. **载荷守卫（payload guard）**——工具调用参数过大时执行前拒（防 `MALFORMED_RESPONSE` 断流）、成功后随下一请求附带拆小提醒、断流真实发生时有限重试并注入纠偏指引。
4. **标记守卫（markup guard）**——PTC 部署下模型把原生工具调用写成裸标记文本（`<tool_call>`/`<function=…>`，尤其与合法 run_code 并存的混合消息，落在宿主防线的豁免盲区）时，经 `agent/pre-step` 追加预算内纠偏消息，并在每步系统提示快照注入 PTC 调用约定声明。根因分析见 [docs/TEXT-TOOL-CALL-LEAK.md](docs/TEXT-TOOL-CALL-LEAK.md)。

## 依据（数据）

74 个历史会话 287 条 `isError` 工具错误中 27 条是坏路径搜索，其中 15 条按官方 GitHub 仓库布局臆测 `deepseek-harness` 安装目录的 pnpm 布局。构成与治理思路见 [wiki/06-data-case.md](wiki/06-data-case.md)。

载荷守卫的触发事件：某会话一个 `edit` 调用的参数 JSON 在 772 字符处断流（超长转义中文 `new_string`），宿主判 `MALFORMED_RESPONSE`，turn 直接以错误结束——无人重试、无人纠偏。全会话统计（57 会话 / 272 turn-end）显示活跃会话上下文占用中位数 122k、p90 244k：大 payload + 高上下文压力是常态，硬上限因此随占用率自适应收紧。

标记守卫的触发事件：session f2415117（2026-11-26 取证）单轮 31 step 出现 5 次原生工具调用写成的死标记（`skill`×2、`read`×2、`todo_write`），全部是"run_code 干活 + 标记直调"的混合消息——宿主防线"含调用块即豁免"的门控恰好放过，模型收不到任何"未执行"反馈，跨 20 step 重复同一错误；意图全部只在 `run_code` 内补做成功（如 seq 172→180 同参数补读），证明缺的只是反馈通道。

## 行为

- **载荷守卫先于一切路径判定**（`tools/pre-execute` 第一分支，不限守卫名单，任何带对象参数的调用都过）：
  - **硬上限**：CJK 感知的参数体积估算（汉字≈1 token、其他≈¼，与 dsh-infinite-context 口径一致）≥ 有效硬限 → deny，一行式拆小指引；上下文占用率 ≥ `pressureRatio` 时硬限自动乘 `pressureHardFactor`（高压下断流代价更大）；
  - **软提醒**（`tools/post-execute`）：调用**成功**且参数 ≥ `argsSoftTokens` → 提醒随**下一请求**附带（宿主 `additionalContexts` 通道），每 turn 最多 2 条，掰模型行为于断流之前；
  - **断流纠偏**（`agent/request-error` / `agent/error`）：`MALFORMED_RESPONSE` 按会话计数，`malformedRetry` 次内先向 inbox 追加"确认改动是否落盘、拆小重发"的纠偏消息再返回 `{kind:'retry'}`；重试通道关掉时走 `agent.inject` 每 turn 一次。turn 以 `completed` 收尾即视为进展、计数清零。
- 监听 `tools/pre-execute`（monotonic listener，拒绝不可被监听器顺序翻盘），按工具检查目标主张：
  - **grep / glob**：`path` 不存在 → deny，一行式 glob-near 文案；
  - **read / read_image**：`file_path` 不存在 → deny，同一套定位建议（覆盖"上游步骤本应生成该文件但实际失败"的场景）；read_image 对存在的非图片文件（如 `.svg`）直接给出"use read"提示；
  - **edit**：目标文件 ≤2MB 时读取当前内容，`old_string` 不存在 → deny 并提示并发修改可能（要求重新 read 后再构造）；多次匹配 → deny 并报告匹配次数；
  - **grep 零结果升级**：同一目标路径连续 N 次（默认 5）返回 `No matches found` → deny 并强制换策略（直接读文件 / 换数据源 / 向用户报告阴性结果），防止"换花样再搜"的循环失控；任何非零结果清零计数；
  - 路径存在 → 放行（存在但不可读/被锁定等交给工具自己报，预检只做存在性与内容主张这两件事）；
  - 无路径参数、路径非字符串、workdir 不可 stat、workdir 解析失败：一律放行。
  - **deny 连续升级**：同一 Agent **连续**被守卫拒绝时计数（任何一次放行的调用清零）；第 3 次起，拒绝文案追加两段指引——"守卫不会向重试让步，换目标/换方法或停下告知用户" + "若调用在工具层反复失败（限流、上下文压力），**不要把调用写进正文文本**：文本形态调用永远不会被执行"（吸收 text-form tool call 诊断教训）。
  - 其他工具不经过本守卫。
- **标记守卫走另一条通道**（不在 `tools/pre-execute` 上——泄漏不是调用，拦不到 pre-execute）：
  - **常驻约定**（提示层，治本）：经 `systemPrompt.context()` 在每步刷新的系统提示快照注入 `[ptc-call-convention]`——`run_code` 是唯一直调工具，清单里的其余工具只能在 run_code 内 `await tools.name(args)`，写成文本标记的调用永远不会执行；
  - **泄漏纠偏**（`agent/pre-step`，兜底）：每步开始检查**本 turn** 最新 assistant 消息的文本块，命中泄漏标记（检测语义逐字复用宿主防线并**去掉**"含调用块即豁免"的门控——混合块正是目标；fenced code / inline code 内的标记是文档，不触发）→ 在 step 消息尾部追加一条纠偏 user 消息：指名调用从未执行、给出 `await tools.name(…)` 补做路径；第 2 条起带重复计数升级文案（"把清单里的工具名当成可直调"是重复原因）；
  - **预算与时效**：每 turn 最多 `markupBlock` 条（默认 2，`0` 关闭），防纠偏自身成为噪音；已结束 turn 的旧泄漏视为过期意图，不再追纠；本 turn 看到干净消息即清零升级计数。

## 与内核补丁的关系

内核 `packages/fs/tool-fs-search/src/search-core.ts` 里有一份等价实现（`preflightSearchPath()`）。本插件是**插件形态的同一防线**，两者可共存：插件先拒，内核逻辑兜底（例如 CLI 直连或未挂载本插件的 profile）。若只想留一处，内核补丁可随时摘除而不影响本插件。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `disabled` | `false` | 设为 `true` 即卸载守卫逻辑，bundle 保持安装。 |
| `maxEditBytes` | `2000000` | edit 内容预检的文件大小上限，超限跳过检查（避免大文件拖慢每次调用）。 |
| `zeroResultBlock` | `5` | 同一目标路径连续零结果 grep 的拒绝阈值（循环失控守卫），配置值小于 1 时按 1 处理。 |
| `argsHardTokens` | `8000` | 工具调用参数的硬上限（估算 token），达到即 deny；`0` 关闭本层。 |
| `argsSoftTokens` | `2500` | 成功调用后软提醒的触发阈值；`0` 关闭；大于 `argsHardTokens` 时自动夹到硬限。 |
| `pressureRatio` | `0.75` | 上下文占用率（最近 usage ÷ 窗口）超过此值时收紧硬限；`0` 关闭自适应。 |
| `pressureHardFactor` | `0.5` | 收紧系数：高压下有效硬限 = `argsHardTokens × 系数`；配 `0` 或 `>1` 同样关闭收紧。 |
| `malformedRetry` | `1` | `MALFORMED_RESPONSE` 的有限重试次数（按会话，completed turn 清零）；`0` 只纠偏不重试。若同时安装 dsh-llm-retry，勿把该码加进其 `retryableCodes`（会双重重试）。 |
| `markupBlock` | `2` | 每 turn 最多注入的泄漏纠偏消息条数；`0` 关闭标记守卫。 |
| `markupMinChars` | `40` | 泄漏标记段的最短长度（对齐宿主防线 `MIN_MARKUP_CHARS`），低于此视为叙述残片不触发。 |

## 开发

```bash
node scripts/build.mjs            # 构建 dist（自动垫 node_modules 垫片）
npx vitest run --config vitest.config.ts
./pack.ps1                        # 打包 tgz 到 release/（或 pack.cmd / pack.sh）
dsh plugin --profile <profile> add release/dsh-search-path-guard-<版本>.tgz
```

目录结构对齐 `dsh-agent-session-tools` 与 `adaptive-effort-scheduler`：`cordis.yml` 开发组合、`cordis.patch.yml` 安装补丁、`scripts/build.mjs` 免安装构建、`pack.*` 一键打包、`vitest.config.ts` 测试。
