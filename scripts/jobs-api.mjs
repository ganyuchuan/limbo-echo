import { randomBytes, timingSafeEqual } from 'node:crypto';

async function bodyJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('清单请求超过 2 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createJobApi(store) {
  const token = randomBytes(32).toString('hex');
  return async (request, response, next) => {
    if (!request.url?.startsWith('/api/import/')) return next();
    const send = (code, data) => {
      if (response.destroyed) return;
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(data));
    };
    const host = request.headers.host || '';
    const origin = `http://${host}`;
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host) || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '仅允许本机同源请求' });
    if (request.method !== 'GET') {
      const supplied = Buffer.from(String(request.headers['x-limbo-token'] || ''));
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: '请求令牌已失效，请刷新页面' });
    }
    try {
      const url = new URL(request.url, origin);
      const parts = url.pathname.slice('/api/import/'.length).split('/').map(decodeURIComponent);
      if (request.method === 'GET' && parts[0] === 'status') return send(200, { available: true, token });
      if (request.method === 'GET' && parts[0] === 'jobs' && parts.length === 1) return send(200, { jobs: store.list() });
      if (request.method === 'POST' && parts[0] === 'jobs' && parts.length === 1) {
        const body = await bodyJson(request);
        return send(201, { job: await store.create(body.task, body.consent) });
      }
      if (parts[0] === 'jobs' && /^job-[a-f0-9-]{36}$/.test(parts[1] || '')) {
        const id = parts[1];
        if (request.method === 'PUT' && parts[2] === 'files' && parts.length === 4) return send(200, { job: await store.upload(id, parts[3], request) });
        if (request.method === 'POST' && parts.length === 3) {
          if (parts[2] === 'start') return send(200, { job: await store.start(id, (await bodyJson(request)).consent) });
          if (parts[2] === 'cancel') return send(200, { job: await store.cancel(id) });
        }
      }
      send(404, { error: '接口不存在' });
    } catch (error) { send(400, { error: error.message }); }
  };
}