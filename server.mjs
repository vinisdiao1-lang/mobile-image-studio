import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generationRequest, imageUrl, isTaskId, maxReferenceBytes, maxReferences } from './site/models.js';

const port = Number(process.env.PORT || 4317);
const pagesOrigin = process.env.PAGES_ORIGIN || 'https://vinisdiao1-lang.github.io';
const upstream = 'https://async.xinbao-ai.com';
const prefix = '/mobile-image-api/';
const publicApi = 'https://new.linlangai88.cn' + prefix;
const referenceLifetime = 60 * 60 * 1000;
const referenceStorageLimit = 96 * 1024 * 1024;
const temporaryReferences = new Map();
let referenceBytes = 0;
setInterval(() => {
  const now = Date.now();
  for (const [token, image] of temporaryReferences) {
    if (image.expires <= now) {
      temporaryReferences.delete(token);
      referenceBytes -= image.bytes.length;
    }
  }
}, 60_000).unref();

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/models.js', ['models.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

function send(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new Error('请求内容过长。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function decodeReference(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxReferenceBytes / 3) * 4 + 32) {
    throw new Error('参考图文件无效或过大。');
  }
  const match = value.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 !== 0) throw new Error('参考图文件格式无效。');
  const format = match[1];
  const bytes = Buffer.from(match[2], 'base64');
  const signature = bytes.subarray(0, format === 'png' ? 8 : 3).toString('hex');
  if (bytes.length > maxReferenceBytes || signature !== (format === 'png' ? '89504e470d0a1a0a' : 'ffd8ff')) {
    throw new Error('参考图文件无效或过大。');
  }
  return { format, bytes };
}

function generationWithReferences(input) {
  const request = generationRequest(input);
  const files = input.referenceFiles ?? [];
  if (!Array.isArray(files) || files.length + (input.references?.length ?? 0) > maxReferences) {
    throw new Error('参考图最多 6 张，含图片链接。');
  }
  if (!files.length) return request;
  const images = files.map(decodeReference);
  const size = images.reduce((sum, image) => sum + image.bytes.length, 0);
  if (referenceBytes + size > referenceStorageLimit) throw new Error('参考图服务暂时繁忙，请稍后再试。');

  const expires = Date.now() + referenceLifetime;
  const entries = images.map((image) => [randomBytes(24).toString('hex') + '.' + image.format, { ...image, expires }]);
  const urls = entries.map(([token]) => publicApi + 'reference/' + token);
  const outbound = generationRequest({ ...input, references: [...(input.references ?? []), ...urls] });
  for (const [token, image] of entries) temporaryReferences.set(token, image);
  referenceBytes += size;
  return outbound;
}

function serveReference(request, response, token) {
  const image = temporaryReferences.get(token);
  if (!['GET', 'HEAD'].includes(request.method) || !image || image.expires <= Date.now()) {
    return send(response, 404, { error: '参考图不存在或已过期。' });
  }
  response.writeHead(200, {
    'Content-Type': 'image/' + image.format,
    'Content-Length': image.bytes.length,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
  });
  response.end(request.method === 'HEAD' ? undefined : image.bytes);
}

function resultImages(data) {
  const urls = new Set();
  function add(value) {
    const url = imageUrl(value);
    if (url) urls.add(url);
  }
  for (const value of [data, data?.result, data?.response, data?.result?.response, data?.data]) {
    add(value?.content_url);
    add(value?.image_url);
    add(value?.url);
    for (const list of [value, value?.data, value?.images, value?.image_urls, value?.output]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) add(typeof item === 'string' ? item : item?.url ?? item?.image_url);
    }
    if (!Array.isArray(value?.candidates)) continue;
    for (const candidate of value.candidates) {
      if (!Array.isArray(candidate?.content?.parts)) continue;
      for (const part of candidate.content.parts) add(part?.inlineData?.data ?? part?.fileData?.fileUri);
    }
  }
  return [...urls].slice(0, 12);
}

function providerMessage(data, fallback, key) {
  const message = data?.error?.message ?? data?.error?.detail ?? data?.message ?? data?.error;
  if (typeof message !== 'string' || !message) return fallback;
  return message.replaceAll(key, '••••')
    .replace(/(?:https?:\/\/)?(?:[\w-]+\.)*xinbao-ai\.com\b[^\s"'<>]*/gi, '生图服务')
    .replace(/新宝(?:\s*AI)?|xinbao(?:[\s-]*ai)?/gi, '生图服务')
    .slice(0, 350);
}

async function api(request, response, path) {
  if (path.startsWith('reference/')) return serveReference(request, response, path.slice('reference/'.length));
  const origin = request.headers.origin;
  const selfOrigin = 'http://127.0.0.1:' + port;
  const productionOrigin = 'https://new.linlangai88.cn';
  response.setHeader('Vary', 'Origin');
  if (origin && ![pagesOrigin, selfOrigin, productionOrigin].includes(origin)) {
    return send(response, 403, { error: '此来源无法调用生图接口。' });
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (request.method === 'GET' && path === 'health') return send(response, 200, { status: 'ok' });
  if (!['generate', 'task'].includes(path)) return send(response, 404, { error: '接口不存在。' });
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    return response.end();
  }
  if (request.method !== 'POST') return send(response, 405, { error: '此接口只接受 POST 请求。' });

  const match = request.headers.authorization?.match(/^Bearer ([!-~]{1,512})$/);
  if (!match) return send(response, 401, { error: '请先设置有效的 API Key。' });
  const key = match[1];
  let outbound;
  try {
    const input = await readJson(request, path === 'generate' ? 9 * 1024 * 1024 : 64 * 1024);
    if (path === 'generate') {
      outbound = generationWithReferences(input);
    } else {
      if (!isTaskId(input?.id)) throw new Error('请检查任务 ID。');
      outbound = { path: '/v1/tasks/batch-get', body: { ids: [input.id] } };
    }
  } catch (error) {
    return send(response, 400, { error: error instanceof SyntaxError ? '请求格式无效。' : error.message });
  }

  try {
    const upstreamResponse = await fetch(upstream + outbound.path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(outbound.body),
      signal: AbortSignal.timeout(22000),
      redirect: 'error',
    });
    const data = await upstreamResponse.json().catch(() => null);
    if (!upstreamResponse.ok) {
      const status = upstreamResponse.status;
      return send(response, status, { error: providerMessage(data, '生图服务返回 HTTP ' + status + '。', key) });
    }
    if (data?.error) return send(response, 502, { error: providerMessage(data, '生图服务返回了接口错误。', key) });

    if (path === 'generate') {
      const id = data?.id ?? data?.task_id ?? data?.data?.id ?? data?.data?.task_id;
      const status = data?.status ?? data?.data?.status;
      if (isTaskId(id) && !['succeeded', 'completed', 'success'].includes(status)) {
        return send(response, 200, { id, status: 'pending' });
      }
      const images = resultImages(data);
      if (images.length) return send(response, 200, { status: 'succeeded', images });
      if (!isTaskId(id)) return send(response, 502, { error: '未收到可识别的任务 ID。请先核对任务记录，避免重复生成。' });
      return send(response, 200, { id, status: 'pending' });
    }

    const id = outbound.body.ids[0];
    const task = data?.items?.find((item) => item.id === id);
    if (!task) return send(response, 502, { error: '暂时无法读取这条任务的状态。' });
    return send(response, 200, {
      id,
      status: task.status,
      images: resultImages(task),
      nextPoll: data.next_poll_after_ms,
      error: task.error ? providerMessage(task, '服务未返回任务失败原因。', key) : undefined,
    });
  } catch {
    return send(response, 502, { error: path === 'generate'
      ? '提交结果暂时无法确认。请先核对任务记录，避免重复生成。'
      : '暂时无法连接生图服务。可以继续查询这条任务。' });
  }
}

createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path.startsWith(prefix)) return api(request, response, path.slice(prefix.length));
  const asset = assets.get(path);
  if (process.env.API_ONLY === '1' || !asset || request.method !== 'GET') return send(response, 404, { error: '页面不存在。' });
  try {
    const data = await readFile(new URL('./site/' + asset[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': asset[1] });
    response.end(data);
  } catch {
    send(response, 404, { error: '页面不存在。' });
  }
}).listen(port, '127.0.0.1', () => console.log('Image Studio listening on http://127.0.0.1:' + port));
