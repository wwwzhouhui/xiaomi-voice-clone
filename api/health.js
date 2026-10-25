// GET /api/health：公开状态，只暴露“是否已配置”，不暴露 Key。
const { getConfig, sendJson } = require('./_config');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET' });
  const cfg = getConfig();
  return sendJson(res, 200, {
    ok: true,
    configured: Boolean(cfg.apiKey),
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    outputFormat: cfg.outputFormat,
    clonePasswordRequired: Boolean(cfg.clonePassword),
    storage: cfg.hasRuntimeOverride
      ? 'env + 内存运行时覆盖（冷启动/重新部署后恢复为环境变量）'
      : 'env 环境变量',
    mock: process.env.XIAOMI_MOCK === '1',
    timestamp: new Date().toISOString(),
  });
};
