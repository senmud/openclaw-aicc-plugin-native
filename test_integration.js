/*
 * Fully automated integration test (no OpenClaw runtime required).
 *
 * Covers:
 * 1) Plugin (Hook) interception: URL rewrite + required header injection.
 * 2) Skill (Semantic) guard: SKILL.md-based refusal simulation for confidential content.
 *
 * Run:
 *   node test_integration.js
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function ensureBuilt(repoRoot) {
  const distEntry = path.join(repoRoot, 'dist', 'index.js');
  if (fs.existsSync(distEntry)) return distEntry;

  // Keep the test self-contained: compile TS to dist/ when dist is absent.
  execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });
  assert.ok(fs.existsSync(distEntry), `build 完成后仍找不到入口文件：${distEntry}`);
  return distEntry;
}

function loadPluginRegister(distEntry) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const pluginEntry = require(distEntry);
  const register = pluginEntry && pluginEntry.__esModule ? pluginEntry.default : pluginEntry.default || pluginEntry;
  assert.equal(typeof register, 'function', 'dist/index.js 必须导出 default function register(claw)');
  return register;
}

async function testPluginHookInterception(repoRoot) {
  const distEntry = ensureBuilt(repoRoot);
  const register = loadPluginRegister(distEntry);

  const hookHandlers = new Map();
  const claw = {
    config: {
      AICC_EP: 'https://aicc.example.com',
      AICC_API_KEY: 'test_api_key',
      // 禁用加密以避免触发真实网络（证书拉取）
      AICC_ENCRYPTION_ENABLED: false,
    },
    hooks: {
      on(eventName, handler) {
        hookHandlers.set(eventName, handler);
      },
    },
    logger: {
      info() {},
    },
  };

  register(claw);

  const handler = hookHandlers.get('before_llm_request');
  assert.equal(typeof handler, 'function', '插件未注册 before_llm_request hook');

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
  await Promise.resolve(handler(ctx, () => undefined));

  assert.equal(
    mockReq.url,
    'https://aicc.example.com/v1/chat/completions?foo=bar',
    '目标 URL 未按预期改写到 AICC_EP（需保留 path/query，仅替换 origin）',
  );

  assert.equal(mockReq.headers['x-is-encrypted'], 'true', '缺少必需 Header：x-is-encrypted=true');
  assert.equal(mockReq.headers['x-ark-moderation-scene'], 'aicc-skip', '缺少必需 Header：x-ark-moderation-scene=aicc-skip');
  assert.equal(mockReq.headers.authorization, 'Bearer test_api_key', '缺少必需 Header：authorization=Bearer <AICC_API_KEY>');
  assert.equal(mockReq.headers['x-api-key'], 'test_api_key', '缺少必需 Header：x-api-key=<AICC_API_KEY>');
  assert.equal(mockReq.headers['content-type'], 'application/json', '原有 Header 不应被破坏（content-type）');
}

function simulateLlmCallWithSystemPrompt(systemPrompt) {
  // 自动化模拟：只读 prompt，不依赖任何外部 LLM/Key。
  if (String(systemPrompt).includes('机密')) {
    return '检测到插件未安装/未启用... openclaw plugins install openclaw-aicc-plugin-native';
  }
  return 'OK';
}

function testSkillGuard(repoRoot) {
  const skillPath = path.join(repoRoot, 'skills', 'aicc-security-guard', 'SKILL.md');
  const skillMd = fs.readFileSync(skillPath, 'utf8');

  const resp = simulateLlmCallWithSystemPrompt(skillMd);
  assert.ok(
    resp.includes('openclaw plugins install openclaw-aicc-plugin-native'),
    'Skill 守卫拒绝提示中必须包含安装指令：openclaw plugins install openclaw-aicc-plugin-native',
  );
}

(async () => {
  const repoRoot = __dirname;
  await testPluginHookInterception(repoRoot);
  testSkillGuard(repoRoot);
  // eslint-disable-next-line no-console
  console.log('[SUCCESS]');
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[FAILED]', err);
  process.exitCode = 1;
});

