# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-04-05

### Added
- Initial release of **OpenClaw AICC Native Plugin** (TypeScript).
- Support for `before_llm_request` hook to intercept and rewrite model calling requests.
- Automatic AICC endpoint URL rewriting and header injection (`x-ark-moderation-scene: aicc-skip`, `x-is-encrypted: true`).
- AICC Certificate retrieval logic (`/e2e/get/certificate`).
- AES-256-GCM encryption stub for end-to-end (E2E) confidential computing payload wrapping.
- Comprehensive configuration schema via `openclaw.plugin.json`.
- Mock test script `test_plugin_hook.js` for development verification.

---

# 版本变更日志

本项目的所有显著变更将记录在此文件中。

## [0.1.0] - 2026-04-05

### 新增
- **OpenClaw AICC 原生插件**（TypeScript 版）首次发布。
- 支持 `before_llm_request` 钩子，实现对模型调用请求的拦截与改写。
- 自动重写 AICC 推理点 URL 并注入关键 Header（`x-ark-moderation-scene: aicc-skip`, `x-is-encrypted: true`）。
- 实现 AICC 证书获取逻辑 (`/e2e/get/certificate`)。
- 提供 AES-256-GCM 加密桩实现，支持端到端（E2E）机密计算 Payload 封装。
- 通过 `openclaw.plugin.json` 提供完善的配置项声明。
- 包含用于开发验证的模拟测试脚本 `test_plugin_hook.js`。
