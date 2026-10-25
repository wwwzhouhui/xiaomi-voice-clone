// 小米语音克隆：服务端配置（零依赖，可直接跑在 Vercel Serverless 上）
//
// 配置优先级：管理后台运行时覆盖 > Vercel 环境变量 > 默认值。
// 重要说明（请如实告诉使用者）：
//   - 运行时覆盖只存在于当前函数实例的内存里，冷启动 / 重新部署后会
//     恢复为环境变量的值。想长期固定，请把配置写进 Vercel 的环境变量
//     （管理后台有“一键导出环境变量”按钮，复制后粘贴到 Vercel Dashboard）。
//   - API Key 永远不返回给前端明文，只返回掩码和“是否已配置”。

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MODEL = 'mimo-v2.5-tts-voiceclone';

function getStore() {
  if (!globalThis.__xiaomiVoiceCloneConfig) {
    globalThis.__xiaomiVoiceCloneConfig = {};
  }
  return globalThis.__xiaomiVoiceCloneConfig;
}

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
}

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function getConfig() {
  const store = getStore();
  const baseUrl = normalizeBaseUrl(store.baseUrl || env('XIAOMI_BASE_URL') || DEFAULT_BASE_URL);
  const model = String(store.model || env('XIAOMI_MODEL') || DEFAULT_MODEL).trim();
  const apiKey = store.apiKey !== undefined ? store.apiKey : env('XIAOMI_API_KEY');
  const outputFormat = store.outputFormat || env('XIAOMI_OUTPUT_FORMAT') || 'mp3';
  const clonePassword = store.clonePassword !== undefined ? store.clonePassword : env('CLONE_PASSWORD');
  return {
    baseUrl,
    model,
    apiKey,
    outputFormat: outputFormat === 'wav' ? 'wav' : 'mp3',
    clonePassword,
    // 管理后台是否设置过运行时覆盖（用于在页面上提示存储方式）
    hasRuntimeOverride: Object.keys(store).length > 0,
  };
}

function setConfig(patch) {
  const store = getStore();
  if (patch.baseUrl !== undefined) store.baseUrl = normalizeBaseUrl(patch.baseUrl);
  if (patch.model !== undefined) store.model = String(patch.model).trim();
  if (patch.apiKey !== undefined) store.apiKey = patch.apiKey;
  if (patch.outputFormat !== undefined) store.outputFormat = patch.outputFormat;
  if (patch.clonePassword !== undefined) store.clonePassword = patch.clonePassword;
  return getConfig();
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

function getAdminPassword() {
  // 本地开发：server.mjs 会在非生产环境给一个默认口令并在终端打印警告。
  // Vercel 生产环境：必须在环境变量里设置 ADMIN_PASSWORD，否则管理后台拒绝登录。
  return env('ADMIN_PASSWORD') || getStore().adminPassword || '';
}

function checkAdmin(req) {
  const expected = getAdminPassword();
  if (!expected) return false;
  const given = req.headers['x-admin-password'] || req.headers['X-Admin-Password'] || '';
  return given === expected;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string' && req.body.trim() !== '') {
      return JSON.parse(req.body);
    }
    return {};
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function sanitizeUpstreamMessage(text) {
  // 上游报错里万一带回请求回显，把疑似 Key 片段抹掉再返回给前端。
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-****')
    .replace(/Bearer\s+\S+/gi, 'Bearer ****')
    .slice(0, 500);
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  getConfig,
  setConfig,
  maskKey,
  getAdminPassword,
  checkAdmin,
  sendJson,
  readJsonBody,
  normalizeBaseUrl,
  sanitizeUpstreamMessage,
};
