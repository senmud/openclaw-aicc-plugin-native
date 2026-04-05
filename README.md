# OpenClaw AICC 原生插件（Native Plugin）

本项目是 `openclaw-aicc-plugin`（Python / MCP stdio Server）的 **TypeScript/Node.js 原生插件重构版**。

它通过 `@openclaw/plugin-sdk` 与 OpenClaw 网关同进程运行，能够在“模型调用请求”发往外部 Provider 之前进行拦截：

1. 拉取 AICC 端到端机密证书：`GET {AICC_EP}/e2e/get/certificate`
2. 本地维护一个加密客户端（E2E Client），对请求 Payload 执行端到端加密（当前为“可运行的桩实现”，并提供对齐说明）
3. 注入关键 Header（确保所有 LLM 请求均走 AICC 机密链路）：
   - `x-is-encrypted: "true"`
   - `x-ark-moderation-scene: "aicc-skip"`
4. 将请求转发/改写到 AICC 推理接入点（`AICC_EP`），实现“所有 LLM 请求经 AICC”。

> 为什么要做原生插件？
> - MCP 插件是“外挂进程”，更适合扩展 Tools/Resources/Prompts。
> - 原生插件能在 OpenClaw 的底层生命周期中插入拦截逻辑，属于 **管控层/数据面** 能力，可实现真正的“全链路可信”。

---

## 目录结构

- `openclaw.plugin.json`：插件元数据与配置声明（插件“身份证”）
- `src/index.ts`：插件入口与拦截逻辑（Hook + Provider 双通路）
- `src/aicc/e2e.ts`：AICC 证书拉取 + E2E 加密客户端（含详细注释与桩实现）

---

## 安装与启用（本地）

### 1）编译

在插件目录下执行：

```bash
npm install
npm run build
```

> 说明：OpenClaw 运行时加载的是 `openclaw.plugin.json` 里声明的 `entry`（默认指向 `./dist/index.js`）。

### 2）安装插件

使用 OpenClaw CLI 从本地目录安装（`-l` 表示本地安装）：

```bash
openclaw plugins install -l /path/to/openclaw-aicc-plugin-native
openclaw plugins list
```

安装后重启网关使其生效：

```bash
openclaw gateway restart
```

---

## 配置说明

插件在 `openclaw.plugin.json` 里声明了必填配置：

- `AICC_EP`：AICC 机密推理接入点（网关地址）
- `AICC_API_KEY`：推理点 API Key

可选配置：

- `AICC_ENCRYPTION_ENABLED`：是否启用 E2E 加密封装（默认 `true`）
- `AICC_TIMEOUT_MS`：请求超时时间（默认 `120000` 毫秒）

> 配置的具体注入方式（CLI / 配置文件 / 环境变量）取决于你的 OpenClaw 部署方式。
> 为了便于本地联调，本插件也支持读取同名环境变量：`AICC_EP` / `AICC_API_KEY` 等。

---

## 工作原理（全链路可信 / Clawsentry 视角）

在 Clawsentry 的“全链路可信（Full-link Trusted）”架构中，**最关键的是把信任边界前移到模型调用的数据面**：

- 传统链路：OpenClaw → 外部 Provider → LLM
- 机密链路：OpenClaw →（本插件拦截 + 加密）→ AICC Confidential Router / Inference Node → LLM

本插件的价值在于：

- **同进程接管**：与 OpenClaw 网关同进程运行，不需要额外的 stdio 子进程与 IPC，降低了逃逸面。
- **统一拦截点**：在请求发出前对 Payload 做安全处理（加密/脱敏/审计/策略检查），确保“所有 LLM 请求经 AICC”。
- **端到端机密性**：通过 `/e2e/get/certificate` 取得机密证书并进行会话密钥协商，使请求体以密文进入机密推理节点。
- **跳审核约定**：按 AICC/Ark 约定注入 `x-is-encrypted=true` + `x-ark-moderation-scene=aicc-skip`，在密文链路下开启跳审核模式。

---

## 重要说明：关于“加密实现”

当前 `src/aicc/e2e.ts` 里的 `encryptJsonPayload()` 提供的是 **可运行的桩实现**：

- 使用 Node.js `crypto` 随机生成对称密钥 + AES-256-GCM 加密整包 JSON
- 返回一个带 `ciphertext/iv/tag` 的 envelope 作为请求体

它的目的不是直接“对接成功”，而是：

1. 固化插件的工程结构、拦截点、Header 注入与转发路径
2. 为联调提供一个明确的替换点：将 `deriveSessionKeysStub` 与 `encryptWholeJsonStub` 替换为与 AICC 服务端协议一致的实现

如果你已经拿到了服务端协议（或内部的 TS/JS SDK），推荐直接替换该模块即可，无需改动拦截主流程。

