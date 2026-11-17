# dsh-search-path-guard

grep/glob 搜索路径预检守卫。当模型给出的搜索路径不存在时，在 ripgrep 启动**之前**拒绝该调用，返回一行式、自带修正建议的错误文案；替代 rg 原生的 exit 2 + 本地化 stderr（本部署上常为 GBK 乱码）进入模型上下文。

## 依据（数据）

74 个历史会话 287 条 `isError` 工具错误中 27 条是坏路径搜索，其中 15 条按官方 GitHub 仓库布局臆测 `deepseek-harness` 安装目录的 pnpm 布局。构成与治理思路见 [wiki/06-data-case.md](wiki/06-data-case.md)。

## 行为

- 监听 `tools/pre-execute`（monotonic listener，拒绝不可被监听器顺序翻盘），按工具检查目标主张：
  - **grep / glob**：`path` 不存在 → deny，一行式 glob-near 文案；
  - **read / read_image**：`file_path` 不存在 → deny，同一套定位建议（覆盖"上游步骤本应生成该文件但实际失败"的场景）；read_image 对存在的非图片文件（如 `.svg`）直接给出"use read"提示；
  - **edit**：目标文件 ≤2MB 时读取当前内容，`old_string` 不存在 → deny 并提示并发修改可能（要求重新 read 后再构造）；多次匹配 → deny 并报告匹配次数；
  - **grep 零结果升级**：同一目标路径连续 N 次（默认 5）返回 `No matches found` → deny 并强制换策略（直接读文件 / 换数据源 / 向用户报告阴性结果），防止"换花样再搜"的循环失控；任何非零结果清零计数；
  - 路径存在 → 放行（存在但不可读/被锁定等交给工具自己报，预检只做存在性与内容主张这两件事）；
  - 无路径参数、路径非字符串、workdir 不可 stat、workdir 解析失败：一律放行。
  - **deny 连续升级**：同一 Agent **连续**被守卫拒绝时计数（任何一次放行的调用清零）；第 3 次起，拒绝文案追加两段指引——"守卫不会向重试让步，换目标/换方法或停下告知用户" + "若调用在工具层反复失败（限流、上下文压力），**不要把调用写进正文文本**：文本形态调用永远不会被执行"（吸收 text-form tool call 诊断教训）。
  - 其他工具不经过本守卫。

## 与内核补丁的关系

内核 `packages/fs/tool-fs-search/src/search-core.ts` 里有一份等价实现（`preflightSearchPath()`）。本插件是**插件形态的同一防线**，两者可共存：插件先拒，内核逻辑兜底（例如 CLI 直连或未挂载本插件的 profile）。若只想留一处，内核补丁可随时摘除而不影响本插件。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `disabled` | `false` | 设为 `true` 即卸载守卫逻辑，bundle 保持安装。 |
| `maxEditBytes` | `2000000` | edit 内容预检的文件大小上限，超限跳过检查（避免大文件拖慢每次调用）。 |
| `zeroResultBlock` | `5` | 同一目标路径连续零结果 grep 的拒绝阈值（循环失控守卫）。 |

## 开发

```bash
node scripts/build.mjs            # 构建 dist（自动垫 node_modules 垫片）
npx vitest run --config vitest.config.ts
./pack.ps1                        # 打包 tgz 到 release/（或 pack.cmd / pack.sh）
dsh plugin --profile <profile> add release/dsh-search-path-guard-<版本>.tgz
```

目录结构对齐 `dsh-agent-session-tools` 与 `adaptive-effort-scheduler`：`cordis.yml` 开发组合、`cordis.patch.yml` 安装补丁、`scripts/build.mjs` 免安装构建、`pack.*` 一键打包、`vitest.config.ts` 测试。
