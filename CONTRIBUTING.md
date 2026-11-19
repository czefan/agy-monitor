# 贡献指南（Contributing Guide）

本文档说明 **AGY Monitor** 的代码结构、本地验证步骤与提交约定。本项目为适用于 Google Antigravity 2.0 桌面端的无依赖监控插件。

## 目录结构

```text
agy-monitor/
├── plugin.json                              # Antigravity 插件清单
├── assets/logo.svg                          # 插件图标
├── sidecars/agy-monitor/
│   ├── sidecar.json                         # Sidecar 配置（AUX_PANE 入口）
│   ├── package.json                         # ESM 模块声明
│   ├── main.mjs                             # SidecarApp HTTP 服务与轮询缓存
│   ├── telemetry.mjs                        # Language Server RPC 与指标计算
│   ├── pricing.mjs                          # models.dev 费率同步与 6 小时磁盘缓存
│   ├── cdp.mjs                              # 可选 CDP 输入框胶囊内存注入
│   └── index.html / styles.css / app.js     # 右侧辅助面板前端
├── tests/telemetry.test.mjs                 # Node 原生单元测试
└── sync.ps1                                 # Windows 本地开发同步脚本
```

## 环境要求

- **Node.js 22+**（仅使用 Node 内置模块，无需安装第三方依赖）
- **Google Antigravity 2.0 桌面端**

## 调试与测试

1. 在 Windows 下修改 `sidecars/agy-monitor/` 后，可运行同步脚本复制到本地插件目录：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\sync.ps1
   ```

   macOS / Linux 可直接将目录复制到 `~/.gemini/config/plugins/agy-monitor`。
2. 仅修改前端文件（`index.html`、`styles.css`、`app.js`）时，切换或重新打开右侧面板即可加载；修改后端文件（`*.mjs`）时，需在 **Customizations → Installed** 中关闭再开启一次 **AGY Monitor** 以重启 Sidecar 进程。
3. 提交 PR 前请确保语法检查与单元测试通过：

   ```bash
   node --check sidecars/agy-monitor/main.mjs
   node --check sidecars/agy-monitor/telemetry.mjs
   node --check sidecars/agy-monitor/pricing.mjs
   node --check sidecars/agy-monitor/cdp.mjs
   node --check sidecars/agy-monitor/app.js
   node --test tests/telemetry.test.mjs
   ```

## 开发约定

1. **无第三方运行时依赖**：不引入构建工具或 `node_modules` 运行时依赖，保持解压即用。
2. **兼容 Trusted Types / CSP**：[cdp.mjs](./sidecars/agy-monitor/cdp.mjs) 与 [app.js](./sidecars/agy-monitor/app.js) 仅使用原生 DOM API（`createElement` / `textContent`），不使用 `innerHTML`。
3. **只读本地探测**：不修改 Antigravity 安装目录或 `app.asar`。
4. **补充单元测试**：新增或调整计算逻辑时，在 [tests/telemetry.test.mjs](./tests/telemetry.test.mjs) 补充对应测试。

## 自动化工作流

- `.github/workflows/ci.yml`：Push 与 PR 触发 Ubuntu / Windows（Node 22 / 24）语法检查与单元测试。
- `.github/workflows/release.yml`：推送 `v*` 标签或手动触发时，运行校验并将插件运行所需文件打包为 `agy-monitor-<tag>.zip` 发布到 GitHub Releases。
