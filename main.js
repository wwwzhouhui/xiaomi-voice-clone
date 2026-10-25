// 首页逻辑：不接触 Key，只调本站 /api/*。
// Vercel 线上版上限：Serverless 函数整个请求体不能超过 4.5MB。
// 参考音频要先转 Base64（约变大 1/3）再放进 JSON，所以原始文件必须
// 控制在 3MB 以内才安全；超过这个值，Vercel 会在函数运行前直接
// 返回 413 纯文本，根本到不了后端。
const MAX_REF_BYTES = 3 * 1024 * 1024;
let refDataUrl = '';
let refName = '';
let refSize = 0;
let lastResult = null;

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
async function parseCloneResponse(r) {
  const text = await r.text();
  if (r.status === 413 || text.includes('FUNCTION_PAYLOAD_TOO_LARGE') || text.includes('Request Entity Too Large')) {
    throw new Error('请求体太大了：Vercel 线上版单次请求不能超过 4.5MB，参考音频转成 Base64 后会变大，请把参考音频剪到 3MB 以内（建议 10-30 秒片段）再试。');
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (_) {
    throw new Error('服务器没有返回正常结果（HTTP ' + r.status + '）：' + text.slice(0, 200));
  }
  if (!r.ok || !j.ok) throw new Error(j.error || ('生成失败（HTTP ' + r.status + '）'));
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
  document.getElementById('charCount').textContent = textEl.value.length + ' / 1000 字';
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
    const r = await fetch('/api/clone', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, style, referenceAudio: refDataUrl, referenceName: refName }),
    });
    const j = await parseCloneResponse(r);

    lastResult = j;
    const blob = b64ToBlob(j.audioBase64, j.audioMime);
    const url = URL.createObjectURL(blob);
    document.getElementById('player').src = url;
    document.getElementById('resultMeta').textContent =
      '文件名：' + j.fileName +
      '\n实际输出格式：' + j.audioFormat + (j.fallbackUsed ? '（mp3 不被接受，已自动回落 wav）' : '') +
      (j.mock ? '\n模式：本地 Mock（非真实小米调用）' : '') +
      '\n大小：' + formatBytes(j.sizeBytes) +
      '\n模型：' + j.model +
      '\n参考音频：' + j.referenceName + '（' + formatBytes(j.referenceSizeBytes) + '）' +
      '\n生成时间：' + new Date(j.createdAt).toLocaleString();
    document.getElementById('result').style.display = 'block';
    document.getElementById('result').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    progress.style.display = 'none';
  }
});

document.getElementById('dlAudio').addEventListener('click', () => {
  if (!lastResult) return;
  downloadBlob(b64ToBlob(lastResult.audioBase64, lastResult.audioMime), lastResult.fileName);
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
  };
  downloadBlob(new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }),
    lastResult.fileName.replace(/\.(mp3|wav)$/i, '') + '-info.json');
});

loadStatus();
