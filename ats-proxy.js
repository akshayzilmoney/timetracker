// ATS Sync helper for the XP Time Tracker.
// The hr.zilmoney.com API only allows browser calls from its own origin (CORS),
// so this tiny local server forwards the two requests the tracker needs.
// Run it with:  node ats-proxy.js   (keep it running while the tracker is open)
// No dependencies, nothing is stored on disk.

const http = require('http');

const PORT = 5178;
const API = 'https://api.hr.zilmoney.com/api';

function cors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  // Chrome Private Network Access: https page -> localhost needs this on preflight
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (req.method === 'POST' && req.url === '/ats/login') {
      const body = await readBody(req);
      const r = await fetch(API + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body
      });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
      // The API returns the JWT only as an httponly cookie - extract it for the app.
      const cookies = (typeof r.headers.getSetCookie === 'function')
        ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
      for (const c of cookies) {
        const m = /jwt_token=([^;]+)/.exec(c || '');
        if (m) { json.token = m[1]; break; }
      }
      console.log(new Date().toLocaleTimeString(), 'login ->', r.status);
      return send(res, r.status, json);
    }

    if (req.method === 'GET' && req.url === '/ats/mytoday') {
      const headers = { 'Accept': 'application/json' };
      if (req.headers.authorization) {
        headers['Authorization'] = req.headers.authorization;
        headers['Cookie'] = 'jwt_token=' + req.headers.authorization.replace(/^Bearer\s+/i, '');
      }
      const r = await fetch(API + '/attendance/my-today', { headers });
      const text = await r.text();
      console.log(new Date().toLocaleTimeString(), 'my-today ->', r.status);
      return send(res, r.status, text);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e.message);
    send(res, 502, { error: 'proxy error: ' + e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('ATS Sync helper running at http://localhost:' + PORT);
  console.log('Keep this window open while using the time tracker.');
});
