# 04 · 配置与部署形态

## 1. 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `disabled` | boolean | `false` | `true` 时不注册监听器；bundle 与组合行保持安装 |
| `maxEditBytes` | number | `2000000` | edit 内容预检的文件大小上限，超限跳过内容检查 |
| `zeroResultBlock` | number | `5` | 同一目标路径连续零结果 grep 的拒绝阈值（循环失控守卫），配置值小于 1 时按 1 处理 |
| `argsHardTokens` | number | `8000` | 工具调用参数硬上限（估算 token），达到即 deny；`0` 关闭载荷守卫的事前层 |
| `argsSoftTokens` | number | `2500` | 成功大调用的软提醒阈值；`0` 关闭事中层；大于 `argsHardTokens` 时自动夹到硬限 |
| `pressureRatio` | number | `0.75` | 上下文占用率超过此值时收紧硬限；`0` 关闭自适应 |
| `pressureHardFactor` | number | `0.5` | 收紧系数（高压下有效硬限 = `argsHardTokens × 系数`）；`0` 或 `≥1` 均不收紧 |
| `malformedRetry` | number | `1` | `MALFORMED_RESPONSE` 按会话的有限重试次数（completed turn 清零）；`0` 只纠偏不重试。与 dsh-llm-retry 共存时勿把该码加进其 `retryableCodes` |
| `markupBlock` | number | `2` | 每 turn 最多注入的泄漏纠偏消息条数（标记守卫）；`0` 关闭标记守卫 |
| `markupMinChars` | number | `40` | 泄漏标记段的最短长度（宿主防线同值），低于此视为叙述残片不触发 |

数值键全部走 `numeric()` 告警回退：非数值/NaN 记 warn 并用默认值；比例类键夹到 `[0,1]`。除上表外没有更多配置——守卫名单与文案当前是编译期常量。理由：这是针对一类高频错误提炼的窄规则，配置面越宽越容易变成没人记得含义的开关；需要扩展时先扩 `guardedTools` 再谈配置。

## 2. 两份组合文件

**`cordis.yml`（开发组合）**——`dsh --profile <p> --patch ./cordis.yml` 直挂，条目 `name: ./dist/index.js` 指向本目录构建产物，改完 build 后 apply 重跑即生效，不经过打包。

**`cordis.patch.yml`（安装补丁）**——被 `package.json` 的 `dsh.bundle.patch` 字段指向，安装时由 plugin_manager / `dsh plugin add` 应用：

```yaml
- insert:
    - id: search-path-guard
      name: dsh-search-path-guard
```

`name` 是裸包名，经 profile node_modules 的 exports map 解析到 `dist/index.js`。

## 3. 部署位置

| 位置 | 内容 |
|---|---|
| `<profile>/node_modules/dsh-search-path-guard` | tarball 安装的运行副本（`dist/index.js` + `dist/preflight.js` + `dist/repeat-guard.js` + `dist/args-guard.js`） |
| 宿主内核 `tool-fs-search` | 等价预检（若宿主构建携带该补丁），与本插件双闸冗余 |

安装与验证步骤见 [05-dev-workflow.md](05-dev-workflow.md)。

## 4. 与内核补丁的取舍

| 场景 | 插件 | 内核补丁 |
|---|---|---|
| 挂载了本插件的 profile 会话 | 先拒（连 rg 进程都不创建） | 不会到达 |
| 未挂载插件的 profile / CLI 直连 | 缺席 | 兜底 |
| `rg os error 5`（存在但不可读） | 正确放行 | 正确放行 |

摘除任一方都不影响另一方；建议长期只保留插件层（随 profile 走、可配置停用、不依赖宿主发版）。
