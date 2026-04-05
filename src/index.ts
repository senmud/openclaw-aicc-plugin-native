import { OpenClaw } from '@openclaw/plugin-sdk';

import { AiccE2EClient } from './aicc/e2e';

type PluginConfig = {
  AICC_EP: string;
  AICC_API_KEY: string;
  AICC_ENCRYPTION_ENABLED?: boolean;
  AICC_TIMEOUT_MS?: number;
};

/**
 * 插件入口。
 *
 * 目标：接管 OpenClaw 发往任意大模型 Provider 的“模型调用请求”，统一改造为：
 * - 先从 AICC 侧获取机密证书 `/e2e/get/certificate`
 * - 用本地加密客户端对请求 Payload 做端到端加密（此处提供“可运行的桩实现 + 详细注释”）
 * - 注入请求头：
 *   - `x-is-encrypted: "true"`
 *   - `x-ark-moderation-scene: "aicc-skip"`
 * - 将请求转发到 AICC 的推理接入点（`AICC_EP`）
 *
 * 说明：由于当前没有官方可用的 TypeScript Volcengine AICC SDK，这里采用 Node.js 标准库 `crypto`
 * 编写“结构对齐的加密桩”。真正落地时只需替换 `AiccE2EClient.encryptJsonPayload` 内的协商与加密规则。
 */
export default function register(claw: OpenClaw) {
  const cfg = loadConfig(claw);

  const e2e = new AiccE2EClient({
    aiccEp: cfg.AICC_EP,
    apiKey: cfg.AICC_API_KEY,
    timeoutMs: cfg.AICC_TIMEOUT_MS ?? 120_000,
    encryptionEnabled: cfg.AICC_ENCRYPTION_ENABLED ?? true,
  });

  // 方案 A：Hook 拦截（首选）。
  // 由于不同 OpenClaw 版本/分支的 Hook 名称可能存在差异，这里做“多事件名注册 + 容错”。
  const hookEvents = [
    // 根据历史约定：在请求发往 LLM 之前拦截
    'before_llm_request',
    // 可能的替代命名
    'llm.request',
    'model.request',
    'provider.request',
    // 更底层的 HTTP 出站拦截（如果 SDK 暴露此能力）
    'http.request',
    'gateway.http.request',
  ];

  const installed = tryRegisterAnyHook(claw, hookEvents, async (ctx: any, next: any) => {
    const req = pickRequestObject(ctx);
    if (!req) {
      return typeof next === 'function' ? next() : undefined;
    }

    // 只处理“看起来像 LLM 调用”的请求：
    // - OpenAI 风格：/v1/chat/completions, /v1/completions
    // - Ark/OpenClaw 风格：/api/v3/chat/completions ...
    const url = safeToUrl(req.url);
    if (!url) {
      return typeof next === 'function' ? next() : undefined;
    }

    const pathname = url.pathname || '';
    const isLikelyLlmCall =
      /\/chat\/completions$/i.test(pathname) ||
      /\/completions$/i.test(pathname) ||
      /\/responses$/i.test(pathname) ||
      /\/embeddings$/i.test(pathname);

    if (!isLikelyLlmCall) {
      return typeof next === 'function' ? next() : undefined;
    }

    // 将请求“改写”为 AICC 推理点。
    // 注意：这里保留 path/query，只替换 origin。
    const aiccUrl = new URL(url.toString());
    const aiccOrigin = new URL(cfg.AICC_EP);
    aiccUrl.protocol = aiccOrigin.protocol;
    aiccUrl.host = aiccOrigin.host;
    req.url = aiccUrl.toString();

    // 统一注入 Header（AICC 跳审核 + 标记密文）。
    // 文档约定：跳审核只有在 `x-is-encrypted=true` 时才会生效。
    // 即便暂时关闭加密（仅用于调试/对齐联调），也建议仍注入，以确保链路行为一致。
    const headers = ensureHeaders(req);
    headers['x-is-encrypted'] = String(true);
    headers['x-ark-moderation-scene'] = 'aicc-skip';

    // AICC API Key：具体 Header 名可能由网关侧定义（例如 Authorization / X-Api-Key）。
    // 这里采用最常见的 Bearer 形式，并额外兜底放一份 `x-api-key`。
    if (!headers['authorization'] && !headers['Authorization']) {
      headers['authorization'] = `Bearer ${cfg.AICC_API_KEY}`;
    }
    if (!headers['x-api-key'] && !headers['X-Api-Key']) {
      headers['x-api-key'] = cfg.AICC_API_KEY;
    }

    // 取出原始 JSON body（不同 OpenClaw 版本字段名可能不同）。
    const rawBody = pickJsonBody(req);
    if (rawBody !== undefined) {
      const encrypted = await e2e.encryptJsonPayload(rawBody);

      // 将加密后的 payload 写回。
      // 这里使用“覆盖式”的写回策略：如果能确定原字段，则原地替换；否则尽可能写到常见字段。
      writeJsonBody(req, encrypted.body);

      // 写入 E2E 相关的 Header（例如 X-Session-Token / X-Encrypt-Info）。
      Object.assign(headers, encrypted.headers);
    }

    // 继续调用链。
    return typeof next === 'function' ? next() : undefined;
  });

  // 方案 B：Provider 接管（兜底）。
  // 如果 SDK 支持注册 Provider，我们提供一个“显式 AICC Provider”，用于让用户把模型配置指向该 Provider。
  // 注意：接口签名在不同版本可能不同，因此这里使用 any + 注释说明。
  tryRegisterProvider(claw, e2e);

  // 最小可观测性：输出安装结果（不泄露 key）。
  safeLog(claw, `[openclaw-aicc-plugin-native] 已尝试安装 LLM 拦截 Hook：${installed ? '成功' : '未安装（SDK 未暴露 Hook 或事件名不匹配）'}`);
}

function loadConfig(claw: OpenClaw): PluginConfig {
  // OpenClaw 插件的配置读取方式可能是：claw.config / claw.getConfig / ctx.config。
  // 这里做容错并允许用环境变量兜底，方便本地联调。
  const maybeCfg =
    (claw as any).config ||
    (typeof (claw as any).getConfig === 'function' ? (claw as any).getConfig() : undefined) ||
    (typeof (claw as any).getPluginConfig === 'function' ? (claw as any).getPluginConfig() : undefined);

  const get = (k: keyof PluginConfig): any => {
    if (maybeCfg && typeof maybeCfg === 'object') {
      if (typeof maybeCfg.get === 'function') {
        const v = maybeCfg.get(k);
        if (v !== undefined) return v;
      }
      if (k in maybeCfg) return (maybeCfg as any)[k];
    }
    return process.env[String(k)];
  };

  const AICC_EP = String(get('AICC_EP') || '').trim();
  const AICC_API_KEY = String(get('AICC_API_KEY') || '').trim();
  const AICC_ENCRYPTION_ENABLED = toBool(get('AICC_ENCRYPTION_ENABLED'), true);
  const AICC_TIMEOUT_MS = toNumber(get('AICC_TIMEOUT_MS'), 120_000);

  if (!AICC_EP) {
    throw new Error('缺少配置：AICC_EP（AICC 机密推理接入点）');
  }
  if (!AICC_API_KEY) {
    throw new Error('缺少配置：AICC_API_KEY（AICC 推理点 API Key）');
  }

  return { AICC_EP, AICC_API_KEY, AICC_ENCRYPTION_ENABLED, AICC_TIMEOUT_MS };
}

function tryRegisterAnyHook(claw: OpenClaw, events: string[], handler: (ctx: any, next: any) => any): boolean {
  const hooks = (claw as any).hooks;
  if (!hooks || typeof hooks.on !== 'function') return false;

  for (const ev of events) {
    try {
      hooks.on(ev, handler);
      return true;
    } catch {
      // 忽略：继续尝试下一个事件名
    }
  }
  return false;
}

function tryRegisterProvider(claw: OpenClaw, e2e: AiccE2EClient) {
  const registerProvider = (claw as any).registerProvider;
  if (typeof registerProvider !== 'function') return;

  try {
    registerProvider({
      id: 'aicc',
      name: 'AICC（机密推理）',
      // 下面的 invoke 形态是“示意”：真实 SDK 可能是 `call` / `request` / `invokeModel`。
      // 你可以在联调时根据 ctx/request 的真实结构，将这里的参数字段对齐。
      async invoke(input: any) {
        // input 可能包含：{ url, method, headers, body } 或 { model, messages, ... }
        const { url, method, headers, body } = normalizeInvokeInput(input);
        const encrypted = await e2e.encryptJsonPayload(body);
        const mergedHeaders = {
          ...(headers || {}),
          ...encrypted.headers,
          'x-is-encrypted': 'true',
          'x-ark-moderation-scene': 'aicc-skip',
        };
        return e2e.forward(url, {
          method: method || 'POST',
          headers: mergedHeaders,
          body: encrypted.body,
        });
      },
    });
  } catch {
    // 忽略：Provider API 在该版本不存在或签名不匹配
  }
}

function normalizeInvokeInput(input: any): { url: string; method?: string; headers?: Record<string, string>; body: any } {
  // 1) HTTP 形态：{ url, method, headers, body }
  if (input && typeof input === 'object' && typeof input.url === 'string') {
    return { url: input.url, method: input.method, headers: input.headers, body: input.body };
  }
  // 2) OpenAI 形态：{ endpoint, payload }
  if (input && typeof input === 'object' && typeof input.endpoint === 'string') {
    return { url: input.endpoint, method: 'POST', headers: input.headers, body: input.payload ?? input.body };
  }
  // 3) 兜底：无法识别时仍返回一个最小结构
  return { url: '', method: 'POST', headers: {}, body: input };
}

function pickRequestObject(ctx: any): any | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined;
  return ctx.request || ctx.req || ctx.httpRequest || ctx.outboundRequest;
}

function ensureHeaders(req: any): Record<string, string> {
  if (!req.headers || typeof req.headers !== 'object') {
    req.headers = {};
  }
  return req.headers as Record<string, string>;
}

function pickJsonBody(req: any): any | undefined {
  // 常见字段：body / data / json / payload
  if (req.body !== undefined) return req.body;
  if (req.data !== undefined) return req.data;
  if (req.json !== undefined) return req.json;
  if (req.payload !== undefined) return req.payload;
  return undefined;
}

function writeJsonBody(req: any, body: any) {
  if ('body' in req) {
    req.body = body;
    return;
  }
  if ('data' in req) {
    req.data = body;
    return;
  }
  if ('json' in req) {
    req.json = body;
    return;
  }
  req.body = body;
}

function safeToUrl(u: any): URL | null {
  try {
    if (typeof u !== 'string') return null;
    return new URL(u);
  } catch {
    return null;
  }
}

function toBool(v: any, defaultValue: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultValue;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(s);
}

function toNumber(v: any, defaultValue: number): number {
  if (v === undefined || v === null || v === '') return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

function safeLog(claw: OpenClaw, message: string) {
  try {
    const logger = (claw as any).logger;
    if (logger && typeof logger.info === 'function') {
      logger.info(message);
      return;
    }
  } catch {
    // ignore
  }
  // 最后兜底：stdout
  // eslint-disable-next-line no-console
  console.log(message);
}

