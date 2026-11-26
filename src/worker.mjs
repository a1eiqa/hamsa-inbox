import { handleApi } from './api.mjs';
import assets from './assets.mjs';

const siteHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env);
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Unknown request error');
        return Response.json({ error: 'حدث خطأ مؤقت. جرّب مرةً أخرى.' }, {
          status: 500,
          headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', ...siteHeaders } });
    }

    const route = pathname === '/index.html' ? '/' : pathname === '/favicon.ico' ? '/icon.svg' : pathname;
    if (!Object.hasOwn(assets, route)) {
      return new Response('الصفحة غير موجودة.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...siteHeaders },
      });
    }

    const { body, type } = assets[route];
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: { 'Content-Type': type, 'Cache-Control': 'no-cache', ...siteHeaders },
    });
  },
};
