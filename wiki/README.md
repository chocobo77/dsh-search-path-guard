# dsh-search-path-guard — Code Wiki

对 `grep` / `glob` 搜索路径做预检的 DSH 宿主插件：模型给出的搜索路径不存在时，在 ripgrep 启动**之前**拒绝调用，返回一行式、自带修正建议的错误文案。

## 文档导航

| 文件 | 内容 |
|---|---|
| [01-overview.md](01-overview.md) | 项目定位、数据依据、整体架构与拦截机制 |
| [02-modules.md](02-modules.md) | 目录结构、模块职责与源码导读 |
| [03-api.md](03-api.md) | 关键类型与函数参考（逐个导出） |
| [04-config.md](04-config.md) | 配置系统与部署形态（含与内核补丁的关系） |
| [05-dev-workflow.md](05-dev-workflow.md) | 构建、测试、打包、安装与验证 |
| [06-data-case.md](06-data-case.md) | 数据驱动案例：27/287 条错误的治理闭环 |

## 一分钟理解这个项目

- **问题**：74 个历史会话 287 条工具错误中 27 条是 grep/glob 拿着不存在的路径去搜索，rg 的 exit 2 + 本地化 stderr（常为 GBK 乱码）原样进入模型上下文，模型还会拿着坏路径反复重试。
- **方案**：一个 `tools/pre-execute` monotonic 监听器。只做一件事——`existsSync` 判断搜索根是否存在；不存在 → `{kind:'deny', reason}`，reason 是一行式自愈文案；其余一切（无 path、非字符串、虚拟 workdir、存在但无权限）全部放行，"存在性"是本守卫唯一的主张。
- **形态**：纯插件，不改内核。内核 `search-core.ts` 有一份等价实现作为兜底，两者文案完全一致、可共存。
