// 管理后台逻辑：口令只存在 sessionStorage，关闭标签页即失效。
function pw() { return sessionStorage.getItem('xiaomi-admin-pw') || ''; }
function showMsg(text, isError) {
  const el = document.getElementById('adminMsg');
  el.textContent = text;
  el.className = isError ? 'error' : 'notice';
  el.style.display = 'block';
}
function hideMsg() { document.getElementById('adminMsg').style.display = 'none'; }

async function loadConfig() {
  const r = await fetch('/api/config', { headers: { 'x-admin-password': pw() } });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    document.getElementById('loginCard').style.display = 'block';
    document.getElementById('configCard').style.display = 'none';
    if (pw()) {
      const el = document.getElementById('loginError');
      el.textContent = j.error || '登录失败';
      el.style.display = 'block';
    }
    return false;
  }
  document.getElementById('loginCard').style.display = 'none';
  document.getElementById('configCard').style.display = 'block';
  document.getElementById('baseUrl').value = j.config.baseUrl;
  document.getElementById('model').value = j.config.model;
  document.getElementById('outputFormat').value = j.config.outputFormat;
  document.getElementById('current').textContent =
    '当前生效：' + j.config.baseUrl + ' / ' + j.config.model +
    '\nAPI Key：' + (j.config.hasApiKey ? j.config.maskedApiKey : '未配置') +
    '\n生成密码：' + (j.config.clonePasswordSet ? '已设置' : '未设置（公开）') +
    '\n运行时覆盖：' + (j.config.hasRuntimeOverride ? '有（冷启动/重新部署后恢复为环境变量）' : '无（当前全部来自环境变量）');
  return true;
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const v = document.getElementById('adminPw').value;
  if (!v) return;
  sessionStorage.setItem('xiaomi-admin-pw', v);
  document.getElementById('adminPw').value = '';
  await loadConfig();
});
document.getElementById('adminPw').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('xiaomi-admin-pw');
  location.reload();
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  hideMsg();
  const body = {
    baseUrl: document.getElementById('baseUrl').value.trim(),
    model: document.getElementById('model').value.trim(),
    outputFormat: document.getElementById('outputFormat').value,
    clearApiKey: document.getElementById('clearKey').checked,
  };
  const key = document.getElementById('apiKey').value;
  if (key) body.apiKey = key;
  // 生成密码：框里填了 = 设为该值；勾选清除 = 恢复公开；两者都空 = 保持原有。
  const clonePw = document.getElementById('clonePw').value;
  if (clonePw) body.clonePassword = clonePw;
  else if (document.getElementById('clearClonePw').checked) body.clonePassword = '';
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': pw() },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || '保存失败');
    document.getElementById('apiKey').value = '';
    document.getElementById('clonePw').value = '';
    document.getElementById('clearKey').checked = false;
    document.getElementById('clearClonePw').checked = false;
    showMsg('保存成功。注意：这是内存运行时覆盖，冷启动/重新部署后会恢复为环境变量，如需长期固定请导出环境变量并粘贴到 Vercel。');
    await loadConfig();
  } catch (e) {
    showMsg(e.message, true);
  }
});

document.getElementById('testBtn').addEventListener('click', async () => {
  hideMsg();
  try {
    const r = await fetch('/api/test', {
      method: 'POST',
      headers: { 'x-admin-password': pw() },
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || '测试失败');
    showMsg('连接成功：' + j.baseUrl + '，/models 返回 ' + j.modelCount + ' 个模型' +
      (j.models && j.models.length ? '（例如：' + j.models.slice(0, 5).join('、') + '）' : '') + (j.note || ''));
  } catch (e) {
    showMsg(e.message, true);
  }
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const model = document.getElementById('model').value.trim();
  const format = document.getElementById('outputFormat').value;
  const key = document.getElementById('apiKey').value.trim();
  const lines = [
    'XIAOMI_BASE_URL=' + baseUrl,
    'XIAOMI_MODEL=' + model,
    'XIAOMI_OUTPUT_FORMAT=' + format,
  ];
  if (key) lines.push('XIAOMI_API_KEY=' + key);
  else lines.push('# XIAOMI_API_KEY=（上面 Key 框留空时，这里不导出 Key；如需换 Key 请先在 Key 框填入再点导出）');
  lines.push('# ADMIN_PASSWORD=（请在 Vercel 单独设置一个强口令，不要写进代码仓库）');
  document.getElementById('exportText').value = lines.join('\n');
});

if (pw()) loadConfig();
