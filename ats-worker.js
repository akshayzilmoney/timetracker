// ATS Sync proxy - Cloudflare Worker edition.
// Forwards the HR API calls the tracker needs (with CORS headers for the
// GitHub Pages site) and keeps nightly snapshots: the tracker registers its
// 24h token here, and a cron trigger at 23:00 IST fetches everyone's
// my-today so the final punch-out of the day is recorded even when no
// browser tab is open. Snapshots are served back so the site can back-fill
// history with real punch-outs instead of estimates.
// Deploy with:  npx wrangler deploy

const API = 'https://api.hr.zilmoney.com/api';
const SNAP_TTL = 7 * 86400; // keep snapshots for a week

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json'
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status: status, headers: cors });
}

// Decode the JWT payload (no signature check - only used to derive a KV key;
// all real authorization is done by comparing against the stored token).
function jwtStaff(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(p));
    return payload.staff_id || payload.sub || null;
  } catch (e) { return null; }
}

function atsHeaders(token) {
  return {
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + token,
    'Cookie': 'jwt_token=' + token
  };
}

// my-sync-status kicks off / reports the ATS-side refresh from the punch
// devices: {"status":"running","message":"Connecting to ..."} while it works.
// my-today serves stale data until that refresh completes.
function fetchSyncStatus(token) {
  return fetch(API + '/attendance/my-sync-status', { headers: atsHeaders(token) });
}

function fetchMyToday(token) {
  return fetch(API + '/attendance/my-today', { headers: atsHeaders(token) });
}

// Poll my-sync-status until the refresh is done (first call triggers it).
// Gives up after ~4 minutes so the cron never hangs.
async function waitForAtsSync(token) {
  for (let i = 0; i < 24; i++) {
    try {
      const r = await fetchSyncStatus(token);
      const j = await r.json();
      if (j.status !== 'running') return;
    } catch (e) { return; }
    await new Promise(res => setTimeout(res, 10000));
  }
}

// Fetch my-today with a stored token and save it under snap:<staff>:<day>.
// The day key comes from the punch_in timestamps (they carry the IST offset).
async function takeSnapshot(env, staff, token) {
  const r = await fetchMyToday(token);
  if (r.status === 401) { await env.ATS_KV.delete('tok:' + staff); return null; }
  if (!r.ok) return null;
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { return null; }
  const first = Array.isArray(data.sessions_today) && data.sessions_today[0];
  if (first && first.punch_in) {
    const day = String(first.punch_in).slice(0, 10);
    await env.ATS_KV.put('snap:' + staff + ':' + day, text, { expirationTtl: SNAP_TTL });
  }
  return data;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');

    if (request.method === 'POST' && url.pathname === '/ats/login') {
      const r = await fetch(API + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: await request.text()
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
      // The API returns the JWT only as an httponly cookie - extract it for the app.
      const cookies = (typeof r.headers.getSetCookie === 'function')
        ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
      for (const c of cookies) {
        const m = /jwt_token=([^;]+)/.exec(c || '');
        if (m) { body.token = m[1]; break; }
      }
      return json(body, r.status, cors);
    }

    if (request.method === 'GET' && url.pathname === '/ats/mytoday') {
      const r = await fetchMyToday(token);
      return new Response(await r.text(), { status: r.status, headers: cors });
    }

    // Kick off / report the ATS-side refresh. The client polls this on a
    // manual sync (showing the live message) until status != "running",
    // then re-fetches my-today for the refreshed punches.
    if (request.method === 'GET' && url.pathname === '/ats/syncstatus') {
      const r = await fetchSyncStatus(token);
      return new Response(await r.text(), { status: r.status, headers: cors });
    }

    // Keep this token for the nightly cron (validated by using it right away,
    // which also snapshots the current day).
    if (request.method === 'POST' && url.pathname === '/ats/register') {
      const staff = jwtStaff(token);
      if (!staff) return json({ error: 'bad token' }, 400, cors);
      const data = await takeSnapshot(env, staff, token);
      if (!data) return json({ error: 'token rejected' }, 401, cors);
      await env.ATS_KV.put('tok:' + staff, token, { expirationTtl: 86400 });
      return json({ ok: true }, 200, cors);
    }

    // Return the stored snapshots (last 7 days) for the requesting user.
    // Only the exact token that was registered may read them.
    if (request.method === 'GET' && url.pathname === '/ats/snapshots') {
      const staff = jwtStaff(token);
      const stored = staff && await env.ATS_KV.get('tok:' + staff);
      if (!stored || stored !== token) return json({ error: 'unauthorized' }, 401, cors);
      const list = await env.ATS_KV.list({ prefix: 'snap:' + staff + ':' });
      const out = {};
      for (const k of list.keys) {
        const v = await env.ATS_KV.get(k.name);
        if (!v) continue;
        try { out[k.name.slice(('snap:' + staff + ':').length)] = JSON.parse(v); } catch (e) { }
      }
      return json(out, 200, cors);
    }

    // Cloud copy of the tracker's profile data (history, achievements, ...)
    // so the same user sees their data on any device. Same auth rule as
    // snapshots: only the exact registered token may read or write.
    if (url.pathname === '/ats/state' && (request.method === 'GET' || request.method === 'PUT')) {
      const staff = jwtStaff(token);
      const stored = staff && await env.ATS_KV.get('tok:' + staff);
      if (!stored || stored !== token) return json({ error: 'unauthorized' }, 401, cors);
      if (request.method === 'GET') {
        const v = await env.ATS_KV.get('state:' + staff);
        return new Response(v || 'null', { status: 200, headers: cors });
      }
      const body = await request.text();
      if (body.length > 2000000) return json({ error: 'too large' }, 413, cors);
      await env.ATS_KV.put('state:' + staff, body);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },

  // Cron trigger (23:00 IST): snapshot the day for every registered token.
  // Trigger the ATS-side refresh and wait for it to finish first, so the
  // stored punch-outs are the refreshed ones.
  async scheduled(event, env) {
    const list = await env.ATS_KV.list({ prefix: 'tok:' });
    for (const k of list.keys) {
      const token = await env.ATS_KV.get(k.name);
      if (!token) continue;
      await waitForAtsSync(token);
      await takeSnapshot(env, k.name.slice(4), token);
    }
  }
};
