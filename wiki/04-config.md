# 04 · 配置与部署形态

## 1. 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `disabled` | boolean | `false` | `true` 时不注册监听器；bundle 与组合行保持安装 |

没有更多配置——守卫名单（grep/glob）与文案当前是编译期常量。理由：这是从 27 条实测错误提炼的窄规则，配置面越宽越容易变成没人记得含义的开关；需要扩展时先扩 `guardedTools` 再谈配置。

## 2. 两份组合文件

**`cordis.yml`（开发组合）**——`dsh --profile <p> --patch ./cordis.yml` 直挂，条目 `name: ./dist/index.js` 指向本目录构建产物，改完 build 后 apply 重跑即生效，不经过打包。

**`cordis.patch.yml`（安装补丁）**——被 `package.json` 的 `dsh.bundle.patch` 字段指向，安装时由 plugin_manager / `dsh plugin add` 应用：

```yaml
- insert:
    - id: search-path-guard
      name: dsh-search-path-guard
```

`name` 是裸包名，经 profile node_modules 的 exports map 解析到 `dist/index.js`。

## 3. 部署位置与状态（2026-11-14）

| 位置 | 状态 |
|---|---|
| `~/.dsh/profiles/web/node_modules/dsh-search-path-guard` | v1.0.0 已安装（plugin_manager install_bundle 应用于 web profile） |
| 宿主内核 `tool-fs-search` | 等价预检已随安装版 CLI 生效（`AppData\Local\DSH\cli` 的 node_modules 副本含同文案） |
| 生效范围 | 插件对新会话生效；内核预检对本会话即生效（已在真实调用中验证 3 次拦截 + 1 次正确放行 os error 5） |

## 4. 与内核补丁的取舍

| 场景 | 插件 | 内核补丁 |
|---|---|---|
| 挂载了本插件的 profile 会话 | 先拒（连 rg 进程都不创建） | 不会到达 |
| 未挂载插件的 profile / CLI 直连 | 缺席 | 兜底 |
| `rg os error 5`（存在但不可读） | 正确放行 | 正确放行 |

摘除任一方都不影响另一方；建议长期只保留插件层（随 profile 走、可配置停用、不依赖宿主发版），内核补丁作为历史改动保留在 `LOCAL-CHANGES.txt`。
