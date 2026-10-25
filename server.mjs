// 本地开发服务器（零依赖）：node server.mjs
// 用法：
//   node server.mjs
//   XIAOMI_MOCK=1 node server.mjs   # 不调真小米，返回 1 秒测试音，用于验证整条链路
// 本地默认管理口令见下方警告；生产（Vercel）必须用环境变量 ADMIN_PASSWORD。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = 'admin123';
  console.log('[警告] 本地开发默认管理口令为 admin123，仅限本机测试，生产环境请务必用环境变量设置强口令。');
}
if (process.env.XIAOMI_MOCK === '1') {
  console.log('[Mock] XIAOMI_MOCK=1：生成接口不会调用小米，返回测试音频。');
}

const apiModules = {
  '/api/health': require('./api/health.js'),
  '/api/config': require('./api/config.js'),
  '/api/clone': require('./api/clone.js'),
  '/api/test': require('./api/test.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const handler = apiModules[url.pathname];
    if (handler) {
      await handler(req, res);
      return;
    }
    let filePath = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    if (url.pathname === '/admin') filePath = path.join(root, 'admin.html');
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`本地服务已启动：http://localhost:${port}  管理后台：http://localhost:${port}/admin.html`);
});
