// ATS Sync proxy - Cloudflare Worker edition.
// Same job as ats-proxy.js but always-on: forwards the two HR API calls the
// tracker needs and adds CORS headers so the GitHub Pages site can call it.
// Deploy with:  npx wrangler deploy

const API = 'https://api.hr.zilmoney.com/api';

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json'
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === 'POST' && url.pathname === '/ats/login') {
      const r = await fetch(API + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: await request.text()
      });
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
      // The API returns the JWT only as an httponly cookie - extract it for the app.
      const cookies = (typeof r.headers.getSetCookie === 'function')
        ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
      for (const c of cookies) {
        const m = /jwt_token=([^;]+)/.exec(c || '');
        if (m) { json.token = m[1]; break; }
      }
      return new Response(JSON.stringify(json), { status: r.status, headers: cors });
    }

    if (request.method === 'GET' && url.pathname === '/ats/mytoday') {
      const headers = { 'Accept': 'application/json' };
      const auth = request.headers.get('Authorization');
      if (auth) {
        headers['Authorization'] = auth;
        headers['Cookie'] = 'jwt_token=' + auth.replace(/^Bearer\s+/i, '');
      }
      const r = await fetch(API + '/attendance/my-today', { headers });
      return new Response(await r.text(), { status: r.status, headers: cors });
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: cors });
  }
};
