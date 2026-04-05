/*
 * 轻量 Mock：模拟 OpenClaw 插件加载与 Hook 执行。
 * 运行方式：node test_plugin_hook.js
 */

const path = require('node:path');

// 1) 加载编译后的插件入口（dist/index.js）
const pluginEntry = require(path.join(__dirname, 'dist', 'index.js'));
const register = pluginEntry && pluginEntry.__esModule ? pluginEntry.default : pluginEntry.default || pluginEntry;

if (typeof register !== 'function') {
  throw new Error('dist/index.js 未导出 default function（无法执行 register）');
}

// 2) Mock OpenClaw：实现 hooks.on 注册 + config 提供必要配置
const hookHandlers = new Map();

const claw = {
  config: {
    // 仅用于演示：提供一个“假的” AICC 入口与 Key
    AICC_EP: 'https://aicc.example.com',
    AICC_API_KEY: 'test_api_key',
    // 关闭加密，避免触发真实网络请求（证书拉取）
    AICC_ENCRYPTION_ENABLED: false,
  },
  hooks: {
    on(eventName, handler) {
      hookHandlers.set(eventName, handler);
    },
  },
  logger: {
    info(msg) {
      // eslint-disable-next-line no-console
      console.log(String(msg));
    },
  },
};

// 3) 调用插件 default export，完成 Hook 注册
register(claw);

// 4) 手动触发 before_llm_request
const handler = hookHandlers.get('before_llm_request');
if (typeof handler !== 'function') {
  const registered = Array.from(hookHandlers.keys()).join(', ') || '(none)';
  throw new Error(`未注册 before_llm_request；已注册事件：${registered}`);
}

const mockReq = {
  method: 'POST',
  url: 'https://api.openai.com/v1/chat/completions?foo=bar',
  headers: {
    'content-type': 'application/json',
    'user-agent': 'mock-agent/1.0',
  },
  body: {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
  },
};

const ctx = { request: mockReq };

Promise.resolve(handler(ctx, () => undefined))
  .then(() => {
    // 5) 输出改写后的请求，验证：URL 改写到 AICC_EP + Header 注入
    // eslint-disable-next-line no-console
    console.log('[test_plugin_hook] modified request =', JSON.stringify(mockReq, null, 2));
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[test_plugin_hook] failed:', err);
    process.exitCode = 1;
  });

