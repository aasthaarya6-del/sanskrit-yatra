/**
 * Sarvam proxy — the API key stays in a Cloudflare secret, never in the website.
 * Deploy: npx wrangler secret put SARVAM_API_KEY
 *         npx wrangler deploy
 */
const ALLOWED_PATHS = new Set([
  '/text-to-speech',
  '/translate',
  '/transliterate',
  '/speech-to-text'
]);

const ALLOWED_ORIGINS = [
  'https://aasthaarya6-del.github.io',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

async function tooMany(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '0';
  const bucket = Math.floor(Date.now() / 60000);
  const key = new Request(new URL('/__rl/' + encodeURIComponent(ip) + '/' + bucket, request.url));
  const cache = caches.default;
  const prev = await cache.match(key);
  const n = prev ? parseInt(await prev.text(), 10) || 0 : 0;
  if (n >= 40) return true;
  await cache.put(
    key,
    new Response(String(n + 1), { headers: { 'Cache-Control': 'max-age=90' } })
  );
  return false;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin)) {
        return new Response('origin not allowed', { status: 403, headers });
      }
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response('Sanskrit Yatra voice proxy', { status: 200, headers });
    }

    if (!isAllowedOrigin(origin)) {
      return new Response(JSON.stringify({ error: 'origin not allowed' }), {
        status: 403,
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    if (!env.SARVAM_API_KEY) {
      return new Response(JSON.stringify({ error: 'proxy not configured' }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);
    if (!ALLOWED_PATHS.has(url.pathname)) {
      return new Response(JSON.stringify({ error: 'path not allowed' }), {
        status: 404,
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    if (await tooMany(request)) {
      return new Response(JSON.stringify({ error: 'slow down' }), {
        status: 429,
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    const len = parseInt(request.headers.get('Content-Length') || '0', 10);
    const max = url.pathname === '/speech-to-text' ? 3_000_000 : 60_000;
    if (len > max) {
      return new Response(JSON.stringify({ error: 'too large' }), {
        status: 413,
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    const incomingType = request.headers.get('Content-Type') || '';
    const outbound = {
      method: 'POST',
      headers: { 'api-subscription-key': env.SARVAM_API_KEY }
    };

    if (url.pathname === '/speech-to-text') {
      outbound.body = request.body;
      if (incomingType) outbound.headers['Content-Type'] = incomingType;
    } else {
      if (!incomingType.toLowerCase().includes('application/json')) {
        return new Response(JSON.stringify({ error: 'json only' }), {
          status: 415,
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return new Response(JSON.stringify({ error: 'bad json' }), {
          status: 400,
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
      delete body.dict_id;
      if (url.pathname === '/text-to-speech' && env.SARVAM_DICT_ID) {
        body.dict_id = env.SARVAM_DICT_ID;
      }
      outbound.headers['Content-Type'] = 'application/json';
      outbound.body = JSON.stringify(body);
    }

    const res = await fetch('https://api.sarvam.ai' + url.pathname, outbound);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        ...headers,
        'Content-Type': res.headers.get('Content-Type') || 'application/json'
      }
    });
  }
};
