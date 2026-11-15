# 02 · 模块职责与源码导读

## 1. 目录结构

```
dsh-search-path-guard/
├── package.json            @local 包清单：exports、files、dsh.bundle.patch 指针
├── cordis.yml              开发组合（--patch 直挂 ./dist/index.js，免打包）
├── cordis.patch.yml        安装补丁（insert 一行到 profile 组合）
├── src/
│   ├── index.ts            apply(ctx, config?)：注册 tools/pre-execute 监听器
│   └── preflight.ts        纯判定函数 searchPathDenial（45 行，无宿主 import）
├── tests/
│   ├── preflight.test.ts   纯函数 13 例（tmp 目录上做真实 existsSync 判定）
│   └── index.test.ts       接线 3 例（fake context 捕获监听器）
├── scripts/build.mjs       零安装构建垫片（从工作区共享骨架复制）
├── pack.ps1 / .cmd / .sh   一键打包（校验清单已改为本项目 dist 文件）
├── tsconfig{,.build,.typecheck}.json / vitest.config.ts
├── README.md               项目说明（行为、配置、安装）
├── LICENSE / icon.svg
└── wiki/                   本文档
```

## 2. 模块职责与依赖方向

```
tests/ ──直测──▶ src/preflight.ts        （纯，无 I/O 依赖之外的东西）
   │              ▲
   └─fake ctx──▶ src/index.ts ──调用──▶ preflight.ts
                     │ ctx.on('tools/pre-execute')
                     ▼
              宿主 workingDirectory 服务（ensure(agent, signal)）
```

- **`preflight.ts` 是全部领域逻辑**：给定 `{name, path, workdir}` 返回拒绝理由或 `undefined`。除 `node:fs` / `node:path` 外零依赖，因此可以直接在 tmp 目录上做真实文件系统判定来测试，不需要宿主运行时。
- **`index.ts` 是全部宿主接线**：从 `exec` 提取参数 → 解析 workdir → 调纯函数 → 把结果翻译成 `PreToolDecision`。宿主服务只按**结构化类型**读取（`{ensure(agent, signal): Promise<string>}`），不 import 整个服务面类型——这样构建垫片只需 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` 的类型。

## 3. src/index.ts 导读（逐段）

| 段 | 内容 |
|---|---|
| 类型 | `GuardConfig { disabled?: boolean }`；`WorkingDirectoryLike`（结构化最小面） |
| 导出 | `name = 'search-path-guard'`、`inject = ['workingDirectory']`、`apply` |
| `apply` 开头 | `config?.disabled === true` → 直接 return（bundle 可保持安装而守卫卸载） |
| workdir 获取 | `(ctx as unknown as {workingDirectory}).workingDirectory`——服务类型由其属主包声明，插件侧按需读取避免拖类型进垫片 |
| 监听器前四关 | 非 grep/glob → next()；arguments 非 object → next()；path 非字符串 → next()；`ensure` 抛错 → next()（各自归位：schema / 工具自身） |
| 终局 | `searchPathDenial(...)` 非 undefined → `{kind:'deny', reason}`，否则 `next()` |

## 4. src/preflight.ts 导读（逐段）

| 段 | 内容 |
|---|---|
| `guardedTools` | `['grep', 'glob'] as const`——守卫名单，唯一扩展点 |
| `searchPathDenial` | ① 名单外 → undefined；② 空白 path → undefined；③ `isAbsolute ? 原样 : resolve(workdir, path)`；④ `existsSync(workdir)` 为假 → undefined（虚拟 workdir 防御）；⑤ `existsSync(解析路径)` 为真 → undefined；⑥ 否则拼一行文案：`resolve(解析路径, '..')` 转正斜杠作为 glob 建议锚点 |

## 5. 测试职责

| 文件 | 覆盖点 |
|---|---|
| `tests/preflight.test.ts` | 相对/绝对坏路径的文案内容与单行性；存在路径与空白 path 放行；虚拟 workdir 与非守卫工具防御；`'.'` 存在性放行（唯一主张约束）；tmp scratch 清理 |
| `tests/index.test.ts` | fake ctx 捕获监听器：坏路径 deny、read 工具/存在路径/无 path 三类穿透、`disabled:true` 不注册 |

设计取向：**宁可测试冗余，不测实现细节**——断言文案包含 `does not exist` 与 `glob near`，而不是断言完整字符串，内核实现改动措辞时测试不碎。
