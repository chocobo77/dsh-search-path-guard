# 05 · 构建、测试、打包与验证

## 1. 零安装构建（scripts/build.mjs）

项目内不 `npm install`。构建脚本探测依赖根（顺序：`$DSH_NODE_MODULES` → `$DSH_HOME` → 本目录 node_modules → 兄弟项目 → 工作区共享骨架 pin 的宿主 checkout），把 `typescript` 与 `@deepseek-ai/*` 类型 symlink 进本目录 gitignored 的 `node_modules`，然后调 tsc。

```bash
node scripts/build.mjs                # 构建 dist（默认 tsconfig.build.json）
node scripts/build.mjs tsconfig.typecheck.json   # 仅类型检查
npm run build / npm run typecheck     # 等价别名
```

本项目的类型依赖只有 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@types/node`——垫片很小，构建秒级。

## 2. 测试

```bash
npx vitest run --config vitest.config.ts
```

9 例（preflight 6 + 接线 3）。测试特点：纯函数用真实 tmp 目录做真实 `existsSync` 判定（不 mock fs）；接线测试用 fake context 捕获监听器并直接调用。

## 3. 打包

```bash
pwsh -NoProfile -File pack.ps1 -SkipTests   # 或 pack.cmd / bash pack.sh
```

流程：build → （可选 vitest）→ `npm pack` → 校验 tarball（必含 `package/dist/index.js`、`package/dist/preflight.js`、两份 yml、package.json；必不含 src/tests/scripts/node_modules）→ 写 `release/SHA256SUMS.txt`。产物：`release/dsh-search-path-guard-<ver>.tgz`。

> 维护提示：pack 脚本内的 dist 校验清单是**逐项目定制**的（从 adaptive-effort-scheduler 复制骨架时改过），新增 src 模块后记得同步。

## 4. 安装

```bash
# 方式一：宿主内 plugin_manager 工具（推荐，本部署实际采用）
#   install_bundle target=<本目录>/release/dsh-search-path-guard-1.0.0.tgz
# 方式二：CLI
dsh plugin --profile web add release/dsh-search-path-guard-1.0.0.tgz
```

- **必须用 tarball**：目录直装会落成 `link:` 导致运行时 `ERR_MODULE_NOT_FOUND`。
- 替换版本：先 remove 旧包再 add 新包；替换后重启 Host。
- 验证安装：`~/.dsh/profiles/web/node_modules/dsh-search-path-guard/dist/` 应含 `index.js` 与 `preflight.js`。

## 5. 端到端验证方法

挂载本插件的**新会话**中：

```
调用 glob，path 指向一个不存在的目录
预期：一行错误，含 "does not exist — glob near \"<父目录>\""，且没有 rg 的 os error / 乱码
调用 grep，path 指向存在的目录
预期：正常搜索（放行路径未变）
（可选）path 指向存在但无权限的文件：预期 rg 自己报 os error 5——守卫不应吞掉它
```
