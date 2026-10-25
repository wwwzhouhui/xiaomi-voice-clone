// 首页逻辑：不接触 Key，只调本站 /api/*。
// Vercel 线上版上限：Serverless 函数整个请求体不能超过 4.5MB。
// 参考音频要先转 Base64（约变大 1/3）再放进 JSON，所以原始文件必须
// 控制在 3MB 以内才安全；超过这个值，Vercel 会在函数运行前直接
// 返回 413 纯文本，根本到不了后端。
const MAX_REF_BYTES = 3 * 1024 * 1024;
// 自动分段：单次调用 55 秒超时是硬约束，长文本必须拆开。
// 每段按句打包，上限 300 字（300 字音频约 1 分钟多，单段推理
// 通常远不到 55 秒；1000 字一整段就很容易超时）。
const MAX_CHUNK_CHARS = 300;
let refDataUrl = '';
let refName = '';
let refSize = 0;
let lastResult = null;
let lastAudioBlob = null;

function clearRefSelection() {
  refDataUrl = '';
  refName = '';
  refSize = 0;
  document.getElementById('dropText').textContent = '点击选择，或把音频文件拖到这里';
  document.getElementById('refInfo').textContent = '';
  const player = document.getElementById('refPlayer');
  player.removeAttribute('src');
  player.style.display = 'none';
}

// 把 /api/clone 的响应转成人话：
//  - 413 / FUNCTION_PAYLOAD_TOO_LARGE / Request Entity Too Large
//    都是“请求体太大”，绝不能原样抛给用户一个 JSON 解析报错。
//  - 其他非 JSON 响应也先显示状态码和纯文本摘要，而不是解析异常。
function humanizeCloneError(msg) {
  // 服务端 55 秒超时 abort 后，Node fetch 的原文就是
  // "This operation was aborted"，绝不能原样显示给用户。
  if (/aborted/i.test(String(msg || ''))) {
    return '生成超时：小米在 55 秒内没有返回结果，请把文本拆得更短再试（自动分段已按约 300 字一段切分，单段仍超时请再拆短该段）。';
  }
  return String(msg || '');
}

async function parseCloneResponse(r) {
  const text = await r.text();
  if (r.status === 413 || text.includes('FUNCTION_PAYLOAD_TOO_LARGE') || text.includes('Request Entity Too Large')) {
    throw new Error('请求体太大了：Vercel 线上版单次请求不能超过 4.5MB，参考音频转成 Base64 后会变大，请把参考音频剪到 3MB 以内（建议 10-30 秒片段）再试。');
  }
  if (/aborted/i.test(text)) {
    throw new Error(humanizeCloneError(text));
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (_) {
    throw new Error('服务器没有返回正常结果（HTTP ' + r.status + '）：' + text.slice(0, 200));
  }
  if (!r.ok || !j.ok) throw new Error(humanizeCloneError(j.error || ('生成失败（HTTP ' + r.status + '）')));
  return j;
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideError() {
  document.getElementById('error').style.display = 'none';
}
function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ---- 自动分段（纯函数，不依赖 DOM，方便单测）----
// 先按句切（句末标点 + 换行都算句界，句末的右引号/右括号跟上句），
// 再把句子打包成每段不超过 MAX_CHUNK_CHARS；单句本身超长时先按
// 逗号、分号等切，仍超长才硬切。切分不改句子原文，只去掉首尾空白。
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', ';', '；', '\n']);
const SENTENCE_CLOSERS = new Set(['”', '’', '"', "'", '）', ')', '】', ']', '》', '」', '』']);
function splitIntoSentences(text) {
  const sentences = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    if (SENTENCE_END.has(ch)) {
      while (i + 1 < text.length && SENTENCE_CLOSERS.has(text[i + 1])) {
        i++;
        cur += text[i];
      }
      if (cur.trim()) sentences.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) sentences.push(cur.trim());
  return sentences;
}
function splitLongSentence(sentence) {
  if (sentence.length <= MAX_CHUNK_CHARS) return [sentence];
  // 先按逗号/顿号/冒号/分号切，再打包；仍超长的部分硬切。
  const parts = sentence.split(/([，、,、：:；;])/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const part of parts) {
    if (cur.length + part.length > MAX_CHUNK_CHARS && cur) {
      out.push(cur);
      cur = '';
    }
    if (part.length > MAX_CHUNK_CHARS) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < part.length; i += MAX_CHUNK_CHARS) {
        out.push(part.slice(i, i + MAX_CHUNK_CHARS));
      }
    } else {
      cur += part;
    }
  }
  if (cur) out.push(cur);
  return out;
}
function splitTextIntoChunks(text) {
  const chunks = [];
  let cur = '';
  for (const sentence of splitIntoSentences(text)) {
    const pieces = splitLongSentence(sentence);
    for (let pi = 0; pi < pieces.length; pi++) {
      const piece = pieces[pi];
      // 新句子开头且当前段已有内容时补一个空格：中文多一个空格无害，
      // 英文没有它会把 "world.How" 连在一起。
      const sep = (pi === 0 && cur) ? ' ' : '';
      if (cur.length + sep.length + piece.length > MAX_CHUNK_CHARS && cur) {
        chunks.push(cur);
        cur = '';
      }
      cur += sep + piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

// ---- 合并（纯函数，mp3 直接拼帧，wav 重建头）----
// mp3：帧与帧相互独立，字节拼接是 TTS 分段的常规做法。
// wav：不能直接拼文件（每段都有头，头里的数据长度也不对），
// 这里解析 fmt/data 块，拼 PCM 后重建一个头。
function wavChunkString(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}
function parseWav(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44) return null;
  if (wavChunkString(view, 0, 4) !== 'RIFF' || wavChunkString(view, 8, 4) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.byteLength) {
    const id = wavChunkString(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        byteRate: view.getUint32(offset + 16, true),
        blockAlign: view.getUint16(offset + 20, true),
        bitsPerSample: view.getUint16(offset + 22, true),
        bytes: new Uint8Array(buffer.slice(offset + 8, offset + 8 + size)),
      };
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) return null;
  return { fmt, dataOffset, dataLength };
}
async function mergeAudio(results) {
  const formats = results.map((r) => r.audioFormat);
  const blobs = results.map((r) => b64ToBlob(r.audioBase64, r.audioMime));
  if (formats.every((f) => f === 'mp3')) {
    return { blob: new Blob(blobs, { type: 'audio/mpeg' }), format: 'mp3' };
  }
  if (formats.every((f) => f === 'wav')) {
    const parsed = [];
    for (const blob of blobs) {
      const buf = await blob.arrayBuffer();
      const p = parseWav(buf);
      if (!p) throw new Error('无法合并 wav：某段音频格式无法解析，请改用 mp3 输出或逐段下载。');
      parsed.push(p);
    }
    const first = parsed[0];
    for (const p of parsed.slice(1)) {
      if (p.fmt.audioFormat !== first.fmt.audioFormat || p.fmt.channels !== first.fmt.channels ||
          p.fmt.sampleRate !== first.fmt.sampleRate || p.fmt.bitsPerSample !== first.fmt.bitsPerSample) {
        throw new Error('无法合并 wav：各段采样参数不一致，请重试一次。');
      }
    }
    let totalPcm = 0;
    for (const p of parsed) totalPcm += p.dataLength;
    const fmtSize = first.fmt.bytes.length;
    const out = new ArrayBuffer(12 + 8 + fmtSize + 8 + totalPcm);
    const view = new DataView(out);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 4 + 8 + fmtSize + 8 + totalPcm, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, fmtSize, true);
    new Uint8Array(out, 20, fmtSize).set(first.fmt.bytes);
    const dataHeaderAt = 20 + fmtSize;
    writeStr(dataHeaderAt, 'data');
    view.setUint32(dataHeaderAt + 4, totalPcm, true);
    let dst = dataHeaderAt + 8;
    // PCM 数据从每段原始 buffer 按解析出的偏移复制。
    for (let i = 0; i < blobs.length; i++) {
      const buf = await blobs[i].arrayBuffer();
      const p = parsed[i];
      new Uint8Array(out, dst, p.dataLength).set(new Uint8Array(buf, p.dataOffset, p.dataLength));
      dst += p.dataLength;
    }
    return { blob: new Blob([out], { type: 'audio/wav' }), format: 'wav' };
  }
  throw new Error('各段返回格式不一致（有 mp3 也有 wav），无法合并成一个文件，请重试一次；如果反复出现，请在管理后台把输出格式固定为 mp3 或 wav 再试。');
}

async function loadStatus() {
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    const el = document.getElementById('status');
    if (!j.configured) {
      el.innerHTML = '尚未配置小米 API Key，请先到<a href="admin.html">管理后台</a>配置模型 URL 与 Key，再回来生成。';
    } else {
      el.textContent = '服务已就绪 · 模型：' + j.model + ' · 默认输出：' + j.outputFormat +
        (j.mock ? ' · 本地 Mock 模式（非真实小米调用）' : '');
    }
    document.getElementById('clonePwWrap').style.display = j.clonePasswordRequired ? 'block' : 'none';
  } catch (e) {
    document.getElementById('status').textContent = '读取服务状态失败：' + e.message;
  }
}

function handleFile(file) {
  hideError();
  if (!file) return;
  const okType = /\.(mp3|wav)$/i.test(file.name) || /^audio\/(mpeg|mp3|wav|x-wav|wave)$/.test(file.type);
  if (!okType) {
    clearRefSelection();
    showError('参考音频只支持 mp3 / wav，请重新选择。');
    return;
  }
  // 在发送前就拦截，避免发一个 Vercel 一定会 413 拒绝的请求。
  if (file.size > MAX_REF_BYTES) {
    clearRefSelection();
    showError('参考音频太大了：当前文件 ' + formatBytes(file.size) + '，Vercel 线上版单次请求不能超过 4.5MB，Base64 后还会变大，原始文件请控制在 3MB 以内（建议剪 10-30 秒片段）。小米文档本身的 Base64 上限是 10MB，但在 Vercel 上部署时，Vercel 的上限更先触发。');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    refDataUrl = reader.result;
    refName = file.name;
    refSize = file.size;
    document.getElementById('dropText').textContent = '已选择：' + file.name;
    document.getElementById('refInfo').textContent =
      '文件名：' + file.name + '\n大小：' + formatBytes(file.size) + ' · 类型：' + (file.type || '未知');
    const player = document.getElementById('refPlayer');
    player.src = refDataUrl;
    player.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

document.getElementById('refFile').addEventListener('change', (e) => handleFile(e.target.files[0]));
const drop = document.getElementById('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('dragover');
  handleFile(e.dataTransfer.files[0]);
});

const textEl = document.getElementById('text');
function updateCount() {
  document.getElementById('charCount').textContent = textEl.value.length + ' / 5000 字';
}
textEl.addEventListener('input', updateCount);
updateCount();

document.getElementById('genBtn').addEventListener('click', async () => {
  hideError();
  const text = textEl.value.trim();
  const style = document.getElementById('style').value.trim();
  if (!refDataUrl) { showError('请先上传参考音频。'); return; }
  if (refSize > MAX_REF_BYTES) { showError('参考音频太大了：请把参考音频剪到 3MB 以内再试（Vercel 线上版单次请求不能超过 4.5MB）。'); return; }
  if (!text) { showError('请输入要合成的文本。'); return; }

  const btn = document.getElementById('genBtn');
  const progress = document.getElementById('progress');
  btn.disabled = true;
  progress.style.display = 'block';
  document.getElementById('result').style.display = 'none';
  try {
    const headers = { 'Content-Type': 'application/json' };
    const pw = document.getElementById('clonePw').value;
    if (pw) headers['x-clone-password'] = pw;

    // 长文本自动分段：超过 300 字就按句切段，逐段调用（每段都在
    // 55 秒超时内），最后合并成一个文件。短文本走原来的一次调用。
    const chunks = text.length > MAX_CHUNK_CHARS ? splitTextIntoChunks(text) : [text];
    const isChunked = chunks.length > 1;
    const segmentResults = [];
    for (let i = 0; i < chunks.length; i++) {
      // 超时段自动重试一次：小米偶发超过 55 秒（实测 3 次里有 1 次），
      // 只对超时重试，其他错误（如参数错误）重试也没有意义。
      let segment = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        progress.textContent = isChunked
          ? '正在生成第 ' + (i + 1) + ' / ' + chunks.length + ' 段' + (attempt > 0 ? '（上次超时，正在重试）' : '') + '…（每段约 300 字，逐段生成后合并）'
          : '正在生成，请稍候…（克隆模型目前是非流式，生成完才一次返回）';
        try {
          const r = await fetch('/api/clone', {
            method: 'POST',
            headers,
            body: JSON.stringify({ text: chunks[i], style, referenceAudio: refDataUrl, referenceName: refName }),
          });
          segment = await parseCloneResponse(r);
          break;
        } catch (e) {
          lastErr = e;
          if (/aborted/i.test(String(e.message || '')) || /超时/.test(String(e.message || ''))) {
            continue;
          }
          break;
        }
      }
      if (!segment) {
        if (isChunked) {
          throw new Error('第 ' + (i + 1) + ' / ' + chunks.length + ' 段生成失败：' + humanizeCloneError(lastErr.message) + '（前面 ' + i + ' 段未合并，请重试或把该段再拆短）');
        }
        throw lastErr;
      }
      segmentResults.push(segment);
    }

    let resultMetaText;
    if (isChunked) {
      const merged = await mergeAudio(segmentResults);
      const fileName = 'voiceclone-' + Date.now() + '.' + merged.format;
      lastAudioBlob = merged.blob;
      lastResult = {
        fileName,
        audioFormat: merged.format,
        requestedFormat: segmentResults[0].requestedFormat,
        fallbackUsed: segmentResults.some((s) => s.fallbackUsed),
        sizeBytes: merged.blob.size,
        model: segmentResults[0].model,
        baseUrl: segmentResults[0].baseUrl,
        text, style,
        referenceName: refName,
        referenceSizeBytes: segmentResults[0].referenceSizeBytes,
        createdAt: new Date().toISOString(),
        mock: segmentResults.some((s) => s.mock),
        segmentCount: chunks.length,
        segments: chunks.map((t, idx) => ({ index: idx + 1, text: t, sizeBytes: segmentResults[idx].sizeBytes, audioFormat: segmentResults[idx].audioFormat })),
      };
      resultMetaText =
        '文件名：' + fileName +
        '\n实际输出格式：' + merged.format + '（已合并）' +
        '\n分段：共 ' + chunks.length + ' 段，每段约 300 字，逐段生成后合并' +
        (lastResult.fallbackUsed ? '\n注：有段落 mp3 不被接受，已自动回落 wav' : '') +
        (lastResult.mock ? '\n模式：本地 Mock（非真实小米调用）' : '') +
        '\n大小：' + formatBytes(merged.blob.size) +
        '\n模型：' + lastResult.model +
        '\n参考音频：' + refName + '（' + formatBytes(segmentResults[0].referenceSizeBytes) + '）' +
        '\n生成时间：' + new Date(lastResult.createdAt).toLocaleString();
    } else {
      const j = segmentResults[0];
      lastResult = j;
      lastAudioBlob = b64ToBlob(j.audioBase64, j.audioMime);
      resultMetaText =
        '文件名：' + j.fileName +
        '\n实际输出格式：' + j.audioFormat + (j.fallbackUsed ? '（mp3 不被接受，已自动回落 wav）' : '') +
        (j.mock ? '\n模式：本地 Mock（非真实小米调用）' : '') +
        '\n大小：' + formatBytes(j.sizeBytes) +
        '\n模型：' + j.model +
        '\n参考音频：' + j.referenceName + '（' + formatBytes(j.referenceSizeBytes) + '）' +
        '\n生成时间：' + new Date(j.createdAt).toLocaleString();
    }
    document.getElementById('player').src = URL.createObjectURL(lastAudioBlob);
    document.getElementById('resultMeta').textContent = resultMetaText;
    document.getElementById('result').style.display = 'block';
    document.getElementById('result').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    showError(humanizeCloneError(e.message));
  } finally {
    btn.disabled = false;
    progress.style.display = 'none';
  }
});

document.getElementById('dlAudio').addEventListener('click', () => {
  if (!lastResult || !lastAudioBlob) return;
  downloadBlob(lastAudioBlob, lastResult.fileName);
});
document.getElementById('dlInfo').addEventListener('click', () => {
  if (!lastResult) return;
  const info = {
    fileName: lastResult.fileName,
    audioFormat: lastResult.audioFormat,
    requestedFormat: lastResult.requestedFormat,
    fallbackUsed: lastResult.fallbackUsed || false,
    sizeBytes: lastResult.sizeBytes,
    model: lastResult.model,
    baseUrl: lastResult.baseUrl,
    text: lastResult.text,
    style: lastResult.style,
    referenceName: lastResult.referenceName,
    referenceSizeBytes: lastResult.referenceSizeBytes,
    createdAt: lastResult.createdAt,
    mock: lastResult.mock || false,
    segmentCount: lastResult.segmentCount || 1,
    segments: lastResult.segments || undefined,
  };
  downloadBlob(new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }),
    lastResult.fileName.replace(/\.(mp3|wav)$/i, '') + '-info.json');
});

loadStatus();
