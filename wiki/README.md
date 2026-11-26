# dsh-search-path-guard — Code Wiki

对工具调用做执行前拦截的 DSH 宿主插件，三条一行式自愈防线：搜索/读写路径不存在时预检拒绝（1.0.x）、同一目标连续零结果 grep 的循环守卫（1.3.x）、超大工具参数与 `MALFORMED_RESPONSE` 断流的载荷守卫（1.4.0）。

## 文档导航

| 文件 | 内容 |
|---|---|
| [01-overview.md](01-overview.md) | 项目定位、数据依据、整体架构、拦截决策流与载荷守卫机制 |
| [02-modules.md](02-modules.md) | 目录结构、模块职责与源码导读 |
| [03-api.md](03-api.md) | 关键类型与函数参考（逐个导出） |
| [04-config.md](04-config.md) | 配置系统与部署形态（含与内核补丁的关系） |
| [05-dev-workflow.md](05-dev-workflow.md) | 构建、测试、打包、安装与验证 |
| [06-data-case.md](06-data-case.md) | 数据驱动案例：27/287 条错误的治理闭环 |

## 一分钟理解这个项目

- **问题**：74 个历史会话 287 条工具错误中 27 条是 grep/glob 拿着不存在的路径去搜索，rg 的 exit 2 + 本地化 stderr（常为 GBK 乱码）原样进入模型上下文，模型还会拿着坏路径反复重试；另有超大工具参数在流组装期断流（`MALFORMED_RESPONSE`）、零结果换花样再搜的循环失控两类高损形态。
- **方案**：`tools/pre-execute` monotonic 监听器（载荷硬上限 → 路径存在性 → 零结果锁，三层都在工具执行**之前**）+ `tools/post-execute`/`agent/request-error`/`agent/error` 三个事后通道（拆小提醒随下一请求附带、MALFORMED 有限重试并注入纠偏）。每一层都"证明不了就放行/不干预"；deny 文案一行式、自带修正动作。
- **形态**：纯插件，不改内核。内核 `search-core.ts` 有一份等价路径预检作为兜底，两者文案完全一致、可共存。
