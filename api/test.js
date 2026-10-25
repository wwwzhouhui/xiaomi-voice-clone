// POST /api/test：管理后台“测试连接”。
// 用 OpenAI 兼容的 GET /models 校验 Base URL + Key 是否通，不花合成费用。
const { getConfig, checkAdmin, sendJson, sanitizeUpstreamMessage } = require('./_config');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
  if (!checkAdmin(req)) return sendJson(res, 401, { ok: false, error: '管理口令不正确' });

  const cfg = getConfig();
  if (!cfg.apiKey) return sendJson(res, 400, { ok: false, error: '尚未配置 API Key' });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const upstream = await fetch(cfg.baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + cfg.apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await upstream.text();
    if (!upstream.ok) {
      return sendJson(res, 502, {
        ok: false,
        error: '上游返回 ' + upstream.status + '：' + sanitizeUpstreamMessage(text),
      });
    }
    let models = [];
    try {
      const parsed = JSON.parse(text);
      models = (parsed.data || []).map((m) => m.id).filter(Boolean).slice(0, 20);
    } catch (_) { /* 有些服务返回非 JSON，忽略 */ }
    return sendJson(res, 200, {
      ok: true,
      baseUrl: cfg.baseUrl,
      modelCount: models.length,
      models,
      note: models.length === 0 ? '连接成功，但 /models 未返回模型列表，仍可直接尝试一次克隆生成' : '',
    });
  } catch (e) {
    return sendJson(res, 502, {
      ok: false,
      error: '连接失败：' + sanitizeUpstreamMessage(e && e.message ? e.message : e),
    });
  }
};
