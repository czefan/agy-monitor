# 贡献指南（Contributing Guide）

本文档说明 **AGY Monitor** 的代码结构、本地构建与验证步骤，以及提交约定。本项目源码采用严格模式 TypeScript（`strict: true`）编写，通过 `tsc` 编译为原生 ESM JS 运行，无第三方运行时依赖。

## 目录结构

```text
agy-monitor/
├── package.json                             # 工程脚本与 TypeScript 开发依赖
├── tsconfig.json                            # TypeScript 严格模式编译配置
├── plugin.json                              # Antigravity 插件清单
├── assets/logo.svg                          # 插件图标
├── scripts/
│   ├── build.mjs                            # 清理并组装 dist/ 插件产物目录
│   └── sync.mjs                             # 跨平台同步 dist/ 到本地插件目录
├── src/
│   ├── shared/types.ts                      # 前后端共享接口与遥测类型定义
│   ├── sidecar/
│   │   ├── sidecar.json                     # Sidecar 配置（AUX_PANE 入口）
│   │   ├── sidecar_sdk.d.ts                 # Antigravity sidecar_sdk 类型声明
│   │   ├── main.ts                          # SidecarApp HTTP 服务与轮询缓存
│   │   ├── telemetry.ts                     # Language Server RPC 与指标计算
│   │   ├── pricing.ts                       # models.dev 费率同步与 6 小时磁盘缓存
│   │   └── cdp.ts                           # 可选 CDP 输入框胶囊内存注入
│   └── web/
│       ├── index.html                       # 右侧辅助面板 HTML
│       ├── styles.css                       # 右侧辅助面板样式
│       ├── preload.d.ts                     # window.sidecar 全局类型声明
│       └── app.ts                           # 右侧辅助面板前端逻辑
├── tests/telemetry.test.mjs                 # Node 原生单元测试
└── dist/                                    # 构建输出的完整插件目录（不入库）
```

## 环境要求

- **Node.js 22+**
- **pnpm**（`packageManager` 指定）
- **Google Antigravity 2.0 桌面端**

## 调试与测试

1. 安装开发依赖：

   ```bash
   pnpm install
   ```

2. 修改源码后，运行以下命令即可自动构建并跨平台同步到本地插件目录（`~/.gemini/config/plugins/agy-monitor`）：

   ```bash
   pnpm sync
   ```

3. 仅修改前端页面或逻辑（`src/web/*`）时，编译同步后切换或重新打开右侧面板即可加载；修改后端代码（`src/sidecar/*.ts`）时，需在 **Customizations → Installed** 中关闭再开启一次 **AGY Monitor** 以重启 Sidecar 进程。
4. 提交 PR 前请确保类型检查、构建与单元测试全部通过：

   ```bash
   pnpm check
   # 等价于: pnpm typecheck && pnpm test
   ```

## 开发约定

1. **无第三方运行时依赖**：仅保留构建期 `devDependencies`，运行时产物保持纯 Node 内置模块，发布包解压即用。
2. **兼容 Trusted Types / CSP**：[cdp.ts](./src/sidecar/cdp.ts) 与 [app.ts](./src/web/app.ts) 仅使用原生 DOM API（`createElement` / `textContent`），不使用 `innerHTML`。
3. **只读本地探测**：不修改 Antigravity 安装目录或 `app.asar`。
4. **补充单元测试**：新增或调整计算逻辑时，在 [tests/telemetry.test.mjs](./tests/telemetry.test.mjs) 补充对应测试。
5. **单一版本源**：插件版本号统一维护在根目录 [package.json](./package.json)，执行 `pnpm build` 时会自动注入到 `dist/plugin.json`。

## 自动化工作流

- `.github/workflows/ci.yml`：Push 与 PR 触发 Ubuntu / Windows（Node 22 / 24）类型检查、构建与单元测试。
- `.github/workflows/release.yml`：推送 `v*` 标签或手动触发时，运行完整校验与构建，并将 `dist/` 打包为 `agy-monitor-<tag>.zip` 发布到 GitHub Releases。
