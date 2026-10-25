// 管理后台配置接口：GET 读取（掩码）、POST 保存。均需管理口令。
const {
  getConfig, setConfig, maskKey, checkAdmin,
  sendJson, readJsonBody, getAdminPassword, normalizeBaseUrl,
} = require('./_config');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      if (!checkAdmin(req)) {
        return sendJson(res, 401, {
          ok: false,
          error: getAdminPassword()
            ? '管理口令不正确'
            : '尚未设置 ADMIN_PASSWORD，请先在 Vercel 环境变量里设置后再登录管理后台',
        });
      }
      const cfg = getConfig();
      return sendJson(res, 200, {
        ok: true,
        config: {
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          outputFormat: cfg.outputFormat,
          hasApiKey: Boolean(cfg.apiKey),
          maskedApiKey: maskKey(cfg.apiKey),
          clonePasswordSet: Boolean(cfg.clonePassword),
          hasRuntimeOverride: cfg.hasRuntimeOverride,
          storageNote: '运行时覆盖只保存在当前函数实例内存里；长期固定请把配置写进 Vercel 环境变量。',
        },
      });
    }

    if (req.method === 'POST') {
      if (!checkAdmin(req)) {
        return sendJson(res, 401, {
          ok: false,
          error: getAdminPassword()
            ? '管理口令不正确'
            : '尚未设置 ADMIN_PASSWORD，请先在 Vercel 环境变量里设置后再保存',
        });
      }
      const body = await readJsonBody(req);
      const patch = {};

      if (body.baseUrl !== undefined) {
        const url = normalizeBaseUrl(body.baseUrl);
        if (!/^https?:\/\/.+/.test(url)) {
          return sendJson(res, 400, { ok: false, error: '模型 URL 必须是 http(s) 地址，例如 https://api.xiaomimimo.com/v1' });
        }
        patch.baseUrl = url;
      }
      if (body.model !== undefined) {
        if (!String(body.model).trim()) {
          return sendJson(res, 400, { ok: false, error: '模型名不能为空，例如 mimo-v2.5-tts-voiceclone' });
        }
        patch.model = String(body.model).trim();
      }
      if (body.outputFormat !== undefined) {
        if (!['mp3', 'wav'].includes(body.outputFormat)) {
          return sendJson(res, 400, { ok: false, error: '输出格式只支持 mp3 或 wav' });
        }
        patch.outputFormat = body.outputFormat;
      }
      // apiKey 留空 = 保持原有；传 clearApiKey=true = 清除。
      if (body.apiKey) patch.apiKey = String(body.apiKey).trim();
      else if (body.clearApiKey === true) patch.apiKey = '';
      // 生成访问密码：传了该字段就按传的值覆盖（空字符串 = 取消密码保护）。
      if (body.clonePassword !== undefined) patch.clonePassword = String(body.clonePassword || '');

      const cfg = setConfig(patch);
      return sendJson(res, 200, {
        ok: true,
        config: {
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          outputFormat: cfg.outputFormat,
          hasApiKey: Boolean(cfg.apiKey),
          maskedApiKey: maskKey(cfg.apiKey),
          clonePasswordSet: Boolean(cfg.clonePassword),
          hasRuntimeOverride: cfg.hasRuntimeOverride,
        },
      });
    }

    return sendJson(res, 405, { ok: false, error: '仅支持 GET / POST' });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求解析失败：' + String(e && e.message ? e.message : e) });
  }
};
