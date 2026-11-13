# 06 · 数据案例：27/287 错误的治理闭环

## 1. 原始数据

2026-11-13 的审计（解压 `~/.dsh/sessions` 全量 74 个会话日志，提取 `tool/result` 的 `isError` 记录）：

- 总计 **287 条**工具错误，跨 9 个工作区；
- **27 条** grep/glob 坏路径（`rg: …: IO error for operation on …（系统找不到指定的路径）`）；
- 其中 15 条指向 `deepseek-harness` 安装目录下按**官方 GitHub 仓库布局**臆测的路径（`packages/core/llm/lib`、`apps/cli/profiles`、`packages/api/session-controller/lib` 等——实际 pnpm 部署不存在这些目录）；
- 其余为版本迭代后拿旧文件名搜新目录（`predlib.py`、`radar3d.html` 旧版）。

stderr 里的中文系统消息在会话日志里以 GBK 乱码形态存在，既污染上下文又不可读——这决定了修复形态必须是**一行结构化文案**，而不是给 rg 换 locale。

## 2. 闭环时间线

| 时间 | 动作 |
|---|---|
| 2026-11-13 上午 | 全量审计 + 三类高频错误归因（本插件对应其中一类） |
| 2026-11-13 10:30 | 内核补丁 `preflightSearchPath()` 落地（`tool-fs-search/src/search-core.ts`）+ 3 个新测试 + tsdown 重建；LOCAL-CHANGES.txt 记录 |
| 2026-11-13 23:40 | Host 切换到含补丁的安装版 CLI |
| 2026-11-13 23:41 起 | 新实例实测：3 次拦截（其中 1 次真实命中），1 次 `os error 5` 正确穿透 |
| 2026-11-14 00:0x | 复盘发现"补丁不随 profile 走"，重做为插件形态（本项目）v1.0.0 安装 |

## 3. 复测口径

治理是否有效，用同一个口径量：

- 工具：`session_error_audit`（dsh-agent-session-tools v1.4.0，同一次审计的产品化）；
- 分类：`search-bad-path`（关键字 `IO error for operation`）；
- 预期：内核 + 插件双闸后，新会话该类别只应出现 `does not exist — glob near` 形态的一行文案（预检拦截本身**不会**计入 isError——deny 是正常策略结果，不产生错误记录）。

> 这也是本插件选择 pre-execute deny 而非"返回错误结果"的一个附带好处：拦截不污染错误统计，`session_error_audit` 里 `search-bad-path` 归零即可判定治理成功。

## 4. 2026-11-14 快照结论

重启后新实例的 6 条增量报错中：预检拦截 3（正常工作痕迹）、环境性 3（web_fetch redirect / 30s 超时 / rg os error 5）——三类历史复发模式（edit 三兄弟 / 超时 / 坏路径）**零复发**。坏路径类别从 27 条/周 → 0 条/周 的拐点在 2026-11-13 23:40（内核补丁上线）与本插件安装（双闸冗余）之间。
