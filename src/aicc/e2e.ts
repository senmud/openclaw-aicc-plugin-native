import crypto from 'node:crypto';

import type { AiccServerCertificate, EncryptResult } from './types';

type AiccE2EClientOptions = {
  aiccEp: string;
  apiKey: string;
  timeoutMs: number;
  encryptionEnabled: boolean;
};

/**
 * AICC 端到端加密客户端（TypeScript 版“骨架 + 桩实现”）。
 *
 * 设计目标：复刻 Java SDK/文档中的关键步骤（但不依赖任何专用 SDK）：
 * 1) 拉取服务端机密证书：`GET {AICC_EP}/e2e/get/certificate`
 * 2) 本地生成一次性密钥材料，与服务端公钥做密钥协商（ECIES/ECDH 等）
 * 3) 使用协商得到的对称密钥对请求体加密（例如 AES-GCM）
 * 4) 以 Header 形式透传会话信息（例如 `X-Session-Token`、`X-Encrypt-Info`）
 *
 * 重要说明（务必读）：
 * - AICC 实际链路的加密格式、KeyAgreement、Nonce 计算、Payload 结构，都需要与服务端严格对齐。
 * - 目前该项目没有官方 TS SDK，因此这里提供“可运行的占位实现”，确保插件结构、拦截点、Header 注入逻辑
 *   都是正确的；联调时只需替换 `encryptJsonPayload` 内部实现即可。
 */
export class AiccE2EClient {
  private readonly aiccEp: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly encryptionEnabled: boolean;

  private certCache: { value: AiccServerCertificate; fetchedAt: number } | null = null;

  constructor(opts: AiccE2EClientOptions) {
    this.aiccEp = opts.aiccEp;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.encryptionEnabled = opts.encryptionEnabled;
  }

  /**
   * 拉取并缓存服务端机密证书。
   *
   * 证书接口（根据需求）：`/e2e/get/certificate`
   * 返回字段在不同环境可能存在大小写差异，本方法做“宽松解析”。
   */
  async getServerCertificate(): Promise<AiccServerCertificate> {
    // 默认 10 分钟刷新一次（仅做示例；真实可按 expiresAt/Cache-Control 调整）。
    const now = Date.now();
    if (this.certCache && now - this.certCache.fetchedAt < 10 * 60 * 1000) {
      return this.certCache.value;
    }

    const url = new URL('/e2e/get/certificate', this.aiccEp).toString();
    const resp = await this.fetchJson(url, {
      method: 'GET',
      headers: {
        // 认证头具体怎么传取决于 AICC 网关配置。
        // 这里同时带两份兜底：Bearer + x-api-key。
        authorization: `Bearer ${this.apiKey}`,
        'x-api-key': this.apiKey,
      },
    });

    const parsed = parseCertificate(resp);
    this.certCache = { value: parsed, fetchedAt: now };
    return parsed;
  }

  /**
   * 加密 JSON 请求体，并返回：
   * - 新的 body（密文结构）
   * - 需要注入的 Header
   */
  async encryptJsonPayload(body: any): Promise<EncryptResult> {
    // 允许关闭加密，用于联调“仅转发/仅注入 Header”的场景。
    if (!this.encryptionEnabled) {
      return { body, headers: {} };
    }

    const cert = await this.getServerCertificate();

    // === 下面开始：加密桩实现 ===
    // Java SDK 文档中，大致流程是：
    // 1) 使用服务端证书中的 publicKey 做密钥协商，得到 e2eKey/e2eNonce/sessionToken
    // 2) body 内的敏感字段（或整包 JSON）用 e2eKey + e2eNonce 做对称加密
    // 3) Header 携带 sessionToken + encryptInfo（含 ringId/keyId/version 等）
    //
    // 由于我们无法获知 AICC 服务端要求的精确协议：
    // - 使用哪种椭圆曲线？
    // - server publicKey 的编码是什么？
    // - Nonce 生成规则是什么？
    // - Payload 是逐字段加密还是整包加密？
    //
    // 这里提供“结构一致”的占位实现：
    // - 直接随机生成 32 字节对称密钥 + 12 字节 IV
    // - 使用 AES-256-GCM 加密整个 JSON 字符串
    // - 返回一个包含 ciphertext/iv/tag 的对象作为 body
    //
    // 联调落地时：
    // - 将 `deriveSessionKeysStub` 替换成真实的 ECDH/ECIES key agreement
    // - 将 `encryptWholeJsonStub` 替换成服务端要求的密文格式（可能是 Base64 字符串或字段级加密）
    const { sessionToken, key, iv } = deriveSessionKeysStub(cert);
    const encryptedBody = encryptWholeJsonStub(body, key, iv);

    const encryptInfo = {
      Version: 'AICCv0.1',
      RingID: cert.ringId,
      KeyID: cert.keyId,
      // 真实实现中可能还需要携带客户端临时公钥、协商参数等
      Algorithm: cert.algorithm || 'AES-256-GCM(STUB)',
    };

    return {
      body: encryptedBody,
      headers: {
        // 与 Java SDK 示例保持一致的 Header 命名（大小写在多数网关中不敏感）。
        'X-Session-Token': sessionToken,
        'X-Encrypt-Info': JSON.stringify(encryptInfo),
        // 某些实现会额外要求标记密文，此处由上层统一注入：x-is-encrypted=true。
      },
    };
  }

  /**
   * 将请求转发到 AICC（用于 Provider 模式的显式调用）。
   *
   * 注意：Hook 模式下我们直接“改写 ctx.request”，让 OpenClaw 自己继续走原有的网络栈。
   * Provider 模式下则需要我们手动发请求。
   */
  async forward(url: string, init: { method: string; headers: Record<string, string>; body: any }): Promise<any> {
    const finalUrl = new URL(url || '/', this.aiccEp).toString();

    const res = await this.fetchRaw(finalUrl, {
      method: init.method,
      headers: {
        ...init.headers,
        authorization: init.headers.authorization || `Bearer ${this.apiKey}`,
        'x-api-key': init.headers['x-api-key'] || this.apiKey,
        'content-type': init.headers['content-type'] || 'application/json',
      },
      body: JSON.stringify(init.body ?? {}),
    });

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private async fetchJson(url: string, init: { method: string; headers?: Record<string, string> }): Promise<any> {
    const res = await this.fetchRaw(url, init);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`证书接口返回非 JSON：${text.slice(0, 256)}`);
    }
  }

  private async fetchRaw(url: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Node.js >= 18 支持全局 fetch。
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}：${msg.slice(0, 512)}`);
      }
      return res;
    } finally {
      clearTimeout(t);
    }
  }
}

function parseCertificate(resp: any): AiccServerCertificate {
  if (!resp || typeof resp !== 'object') {
    throw new Error('证书响应为空或格式非法');
  }
  // 兼容：RingID/ringId, KeyID/keyId, PublicKey/publicKey/public_key
  const ringId = String((resp as any).RingID ?? (resp as any).ringId ?? (resp as any).ring_id ?? '').trim();
  const keyId = String((resp as any).KeyID ?? (resp as any).keyId ?? (resp as any).key_id ?? '').trim();
  const publicKey = String((resp as any).PublicKey ?? (resp as any).publicKey ?? (resp as any).public_key ?? (resp as any).publicKeyPem ?? '').trim();
  const algorithm = ((resp as any).Algorithm ?? (resp as any).algorithm) as string | undefined;
  const expiresAt = ((resp as any).ExpiresAt ?? (resp as any).expiresAt) as string | undefined;

  if (!ringId || !keyId || !publicKey) {
    // 在某些环境里证书字段可能嵌在 data 字段中
    const data = (resp as any).data;
    if (data && typeof data === 'object') {
      return parseCertificate(data);
    }
    throw new Error(`证书响应缺少字段：ringId/keyId/publicKey。原始响应：${JSON.stringify(resp).slice(0, 512)}`);
  }
  return { ringId, keyId, publicKey, algorithm, expiresAt };
}

function deriveSessionKeysStub(_cert: AiccServerCertificate): { sessionToken: string; key: Buffer; iv: Buffer } {
  // 真实实现：
  // - 解析 cert.publicKey
  // - 与本地临时私钥做 ECDH 得到 shared secret
  // - 对 shared secret 做 HKDF 派生出 { e2eKey, e2eNonce }
  // - sessionToken 可能由服务端返回或由协商过程生成

  const sessionToken = crypto.randomBytes(24).toString('base64url');
  const key = crypto.randomBytes(32); // AES-256
  const iv = crypto.randomBytes(12); // GCM 推荐 96-bit IV
  return { sessionToken, key, iv };
}

function encryptWholeJsonStub(body: any, key: Buffer, iv: Buffer) {
  const plaintext = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 真实 AICC 可能要求 body 仍然是 OpenAI 结构但 content 字段被替换为密文；
  // 这里用一个明确的 envelope，便于服务端识别（联调时按协议替换）。
  return {
    __aicc_e2e__: true,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

