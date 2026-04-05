export type AiccServerCertificate = {
  /** AICC 证书 Ring 标识（示例中叫 RingID） */
  ringId: string;
  /** AICC 证书 Key 标识（示例中叫 KeyID） */
  keyId: string;
  /** 服务端公钥（常见形态：PEM / base64 DER / JWK）。这里以字符串兜底承接。 */
  publicKey: string;
  /** 可选：服务端声明的算法信息 */
  algorithm?: string;
  /** 可选：过期时间（ISO8601） */
  expiresAt?: string;
};

export type EncryptResult = {
  /** 要替换进原始请求的 body（密文 payload）。 */
  body: any;
  /** 需要注入/覆盖的请求头（含会话 token、加密 info 等）。 */
  headers: Record<string, string>;
};

