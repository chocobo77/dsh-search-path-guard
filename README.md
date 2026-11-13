# dsh-search-path-guard

grep/glob 搜索路径预检守卫。当模型给出的搜索路径不存在时，在 ripgrep 启动**之前**拒绝该调用，返回一行式、自带修正建议的错误文案；替代 rg 原生的 exit 2 + 本地化 stderr（本部署上常为 GBK 乱码）进入模型上下文。

## 依据（数据）

74 个历史会话 287 条 `isError` 工具错误中 27 条是坏路径搜索，其中 15 条按官方 GitHub 仓库布局臆测 `deepseek-harness` 安装目录的 pnpm 布局。详细分析见会话「DSH 工具调用错误汇总」（2026-11-13）。

## 行为

- 监听 `tools/pre-execute`（monotonic listener，拒绝不可被监听器顺序翻盘），只检查 `grep` / `glob` 的 `path` 参数：
  - 路径存在 → 放行（存在但不可读/被锁定等交给 rg 自己报，预检只做存在性这一件事）；
  - 路径不存在 → `{ kind: 'deny' }`，文案与内核补丁完全一致：
    `grep search failed: path "X" does not exist — glob near "<父目录>" to list existing candidates, then retry with an existing path`
- 无 `path` 参数、路径非字符串、workdir 本身不可 stat、workdir 解析失败：一律放行，交给工具自身处理。
- 其他工具不经过本守卫。

## 与内核补丁的关系

内核 `packages/fs/tool-fs-search/src/search-core.ts` 里有一份等价实现（`preflightSearchPath()`，见 LOCAL-CHANGES.txt 2026-11-13 条目）。本插件是**插件形态的同一防线**，两者可共存：插件先拒，内核逻辑兜底（例如 CLI 直连或未挂载本插件的 profile）。若只想留一处，内核补丁可随时摘除而不影响本插件。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `disabled` | `false` | 设为 `true` 即卸载守卫逻辑，bundle 保持安装。 |

## 开发

```bash
node scripts/build.mjs            # 构建 dist（自动垫 node_modules 垫片）
npx vitest run --config vitest.config.ts
./pack.ps1                        # 打包 tgz 到 release/（或 pack.cmd / pack.sh）
dsh plugin --profile <profile> add release/dsh-search-path-guard-1.0.0.tgz
```

目录结构对齐 `dsh-agent-session-tools` 与 `adaptive-effort-scheduler`：`cordis.yml` 开发组合、`cordis.patch.yml` 安装补丁、`scripts/build.mjs` 免安装构建、`pack.*` 一键打包、`vitest.config.ts` 测试。
