// POST /api/clone：上传参考音频 + 文本，调用小米克隆模型，返回合成音频。
//
// 小米文档要点（mimo-v2.5-tts-voiceclone）：
//  - OpenAI 兼容：POST {baseUrl}/chat/completions
//  - 目标文本放 role=assistant 的消息里；风格指令放 role=user 的消息里
//  - 参考音频：mp3 / wav，Base64 后不超过 10MB，放在 audio.voice，
//    格式为 data:audio/mpeg;base64,... 或 data:audio/wav;base64,...
//  - 输出音频在 choices[0].message.audio.data（Base64）
//  - 文档示例输出格式是 wav / pcm16；mp3 是 OpenAI 兼容格式的常见选项，
//    本接口先按配置请求的格式调，失败时自动回落到 wav，保证不白跑一次。
const { getConfig, sendJson, readJsonBody, sanitizeUpstreamMessage } = require('./_config');

const ALLOWED_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
]);

// 生成一个 1 秒 440Hz 正弦波 WAV，仅用于本地 mock 测试（XIAOMI_MOCK=1 时）。
// 生产环境不要设置 XIAOMI_MOCK，否则不会真的调小米。
function mockWavBase64() {
  const sampleRate = 24000;
  const samples = sampleRate;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    pcm.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

async function callXiaomi(cfg, { text, style, referenceDataUrl, format }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const upstream = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'user', content: style || '' },
          { role: 'assistant', content: text },
        ],
        audio: { format, voice: referenceDataUrl },
      }),
      signal: controller.signal,
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      return { ok: false, status: upstream.status, message: sanitizeUpstreamMessage(raw) };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return { ok: false, status: 502, message: '上游返回了非 JSON 响应' };
    }
    const audioData =
      parsed &&
      parsed.choices &&
      parsed.choices[0] &&
      parsed.choices[0].message &&
      parsed.choices[0].message.audio &&
      parsed.choices[0].message.audio.data;
    if (!audioData) {
      return { ok: false, status: 502, message: '上游响应里没有找到音频数据（message.audio.data 为空）' };
    }
    return { ok: true, audioBase64: audioData };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' });

    const cfg = getConfig();

    // 可选的生成访问密码（管理后台可设，留空 = 公开使用）。
    if (cfg.clonePassword) {
      const given = req.headers['x-clone-password'] || '';
      if (given !== cfg.clonePassword) {
        return sendJson(res, 401, { ok: false, error: '需要生成访问密码' });
      }
    }

    const body = await readJsonBody(req);
    const text = String(body.text || '').trim();
    const style = String(body.style || '').trim();
    const referenceDataUrl = String(body.referenceAudio || body.referenceDataUrl || '').trim();
    const referenceName = String(body.referenceName || '参考音频').slice(0, 200);

    if (!text) return sendJson(res, 400, { ok: false, error: '请输入要合成的文本' });
    if (text.length > 5000) {
      return sendJson(res, 400, { ok: false, error: '文本过长（上限 5000 字），请分段生成' });
    }
    if (style.length > 500) return sendJson(res, 400, { ok: false, error: '风格指令过长（上限 500 字）' });
    if (!referenceDataUrl) return sendJson(res, 400, { ok: false, error: '请先上传参考音频（mp3 / wav）' });

    const m = referenceDataUrl.match(/^data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!m || !ALLOWED_MIME.has(m[1].toLowerCase())) {
      return sendJson(res, 400, { ok: false, error: '参考音频格式不对：只支持 mp3 / wav 的 data URL' });
    }
    const referenceBytes = Buffer.from(m[2], 'base64');
    // 与前端一致的 3MB 上限：小米文档的 Base64 上限是 10MB，但在 Vercel
    // 上部署时，Vercel 单次请求 4.5MB 的上限更先触发（Base64 后约变大
    // 1/3，3MB 原文件 ≈ 4MB 请求体，留有余量）。绕过前端直接调接口时，
    // 这里返回一句人话，而不是让调用方去猜一个 413 纯文本。
    if (referenceBytes.length === 0 || referenceBytes.length > 3 * 1024 * 1024) {
      return sendJson(res, 400, { ok: false, error: '参考音频太大了：原始文件请控制在 3MB 以内（建议剪 10-30 秒片段）。Vercel 线上版单次请求不能超过 4.5MB，Base64 后会变大，超过会在函数运行前被直接拒绝。' });
    }

    if (!cfg.apiKey) {
      return sendJson(res, 503, { ok: false, error: '尚未配置小米 API Key，请到管理后台配置后再生成' });
    }

    // 本地 mock：只在明确设置 XIAOMI_MOCK=1 时生效，用于不花真 Key 验证整条链路。
    if (process.env.XIAOMI_MOCK === '1') {
      const audioBase64 = mockWavBase64();
      return sendJson(res, 200, {
        ok: true,
        mock: true,
        audioBase64,
        audioMime: 'audio/wav',
        audioFormat: 'wav',
        fileName: 'voiceclone-' + Date.now() + '.wav',
        sizeBytes: Buffer.from(audioBase64, 'base64').length,
        text, style, model: cfg.model, baseUrl: cfg.baseUrl,
        referenceName, referenceSizeBytes: referenceBytes.length,
        createdAt: new Date().toISOString(),
      });
    }

    const requested = body.outputFormat === 'wav' ? 'wav' : cfg.outputFormat;
    let result = await callXiaomi(cfg, { text, style, referenceDataUrl, format: requested });
    let actualFormat = requested;
    // mp3 不被接受时自动回落 wav（文档示例格式），并在返回里如实标注实际格式。
    if (!result.ok && requested === 'mp3') {
      const fallback = await callXiaomi(cfg, { text, style, referenceDataUrl, format: 'wav' });
      if (fallback.ok) {
        result = fallback;
        actualFormat = 'wav';
      }
    }
    if (!result.ok) {
      return sendJson(res, 502, {
        ok: false,
        error: '小米接口返回 ' + (result.status || '') + '：' + (result.message || '未知错误'),
      });
    }

    const audioBuffer = Buffer.from(result.audioBase64, 'base64');
    const ext = actualFormat === 'wav' ? 'wav' : 'mp3';
    return sendJson(res, 200, {
      ok: true,
      audioBase64: result.audioBase64,
      audioMime: actualFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
      audioFormat: actualFormat,
      requestedFormat: requested,
      fallbackUsed: actualFormat !== requested,
      fileName: 'voiceclone-' + Date.now() + '.' + ext,
      sizeBytes: audioBuffer.length,
      text, style, model: cfg.model, baseUrl: cfg.baseUrl,
      referenceName, referenceSizeBytes: referenceBytes.length,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    const raw = String(e && e.message ? e.message : e);
    // 55 秒超时 abort 的原文是 "This operation was aborted"，必须转成人话，
    // 否则前端会原样显示一句看不懂的英文。
    if (/aborted/i.test(raw) || (e && e.name === 'AbortError')) {
      return sendJson(res, 504, {
        ok: false,
        error: '生成超时：小米在 55 秒内没有返回结果，请把文本拆得更短再试（前端自动分段已按约 300 字一段切分，单段仍超时请再拆短该段）。',
      });
    }
    return sendJson(res, 500, {
      ok: false,
      error: '生成失败：' + sanitizeUpstreamMessage(raw),
    });
  }
};
