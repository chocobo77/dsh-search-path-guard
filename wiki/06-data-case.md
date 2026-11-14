# 06 · 数据构成与治理思路

## 1. 问题规模

对 `~/.dsh/sessions` 全量会话日志（74 个会话）提取 `tool/result` 的 `isError` 记录，共 287 条。其中 **27 条**是 grep/glob 坏路径搜索：

- 15 条按**官方 GitHub 仓库布局**臆测 `deepseek-harness` 安装目录的 pnpm 布局（`packages/core/llm/lib`、`apps/cli/profiles`、`packages/api/session-controller/lib` 等——部署产物中不存在这些目录）；
- 其余为版本迭代后拿旧文件名搜新目录（如旧版 `radar3d.html`）。

rg 失败的 stderr 是本地化系统消息（中文 Windows 上为 GBK 乱码形态），既污染上下文又不可读——这决定了修复形态必须是**一行结构化文案**，而不是给 rg 换 locale。

## 2. 治理思路

两类防线，文案逐字一致、互为冗余：

1. **插件层**（本仓库）：`tools/pre-execute` deny，rg 进程都不创建；
2. **内核层**：`tool-fs-search` 的 `preflightSearchPath()` spawn 前检查，覆盖未挂载插件的部署。

配套的**提示层**纪律（用户级技能 `edit-and-run-discipline`）：搜索路径只来自本会话见过的清单、对 `deepseek-harness` 目录先 glob 确认 pnpm 布局。

## 3. 效果度量口径

- 工具：`session_error_audit`（dsh-agent-session-tools 提供，同一份会话日志上的有界审计）；
- 判据：`search-bad-path` 分类计数归零，且新出现的搜索错误均为 `does not exist — glob near` 形态（预检拦截本身**不产生** `isError` 记录——deny 是正常策略结果，因此不会污染错误统计）；
- 反向保护：`rg os error 5`（存在但不可读）必须仍能到达 rg——守卫只断言"存在性"，不吞权限/占用类错误。

## 4. 保留的边界

- 预检不做路径合法性推断（是否目录、是否在沙箱内），那些是工具与沙箱层的职责；
- 对"官方仓库布局 vs 安装布局"的根因，治本手段是提示层纪律与宿主布局文档，预检只是把失败代价从"乱码 + 多次重试"降到"一行可自愈文案"。
