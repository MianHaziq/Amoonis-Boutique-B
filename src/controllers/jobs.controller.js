const queue = require('../jobs/queue');
const { listDefs } = require('../jobs');
const { QUEUES } = require('../jobs/queues');
const { success, error } = require('../utils/response');

// GET /admin/jobs — engine + per-queue status for the dashboard.
async function status(req, res, next) {
  try {
    const boss = queue.getBoss();
    const defs = listDefs();

    const queues = await Promise.all(
      defs.map(async (d) => {
        let pending = null;
        if (boss) {
          try {
            pending = await boss.getQueueSize(d.queue);
          } catch (_) {
            pending = null;
          }
        }
        return { ...d, pending };
      })
    );

    return success(
      res,
      {
        enabled: queue.isEnabled(),
        ready: queue.isReady(),
        engine: 'pg-boss',
        queues,
      },
      'Job status'
    );
  } catch (err) {
    next(err);
  }
}

// POST /admin/jobs/broadcast — send a promotion/announcement to users.
// Body: { kind: 'promotion'|'announcement', title, body, title_ar?, body_ar?, data?, regionId? }
// When title_ar + body_ar are supplied the push is localized per recipient (en/ar);
// otherwise the single title/body is sent to everyone.
async function broadcast(req, res, next) {
  try {
    const { kind = 'announcement', title, body, title_ar, body_ar, data, regionId } = req.body || {};
    if (!title || !body) return error(res, 'title and body are required', 400);
    if (!['promotion', 'announcement'].includes(kind)) {
      return error(res, "kind must be 'promotion' or 'announcement'", 400);
    }
    const localized =
      title_ar && body_ar
        ? { en: { title, body }, ar: { title: title_ar, body: body_ar } }
        : null;
    const id = await queue.enqueue(
      QUEUES.PUSH_BROADCAST,
      {
        kind,
        ...(localized ? { localized } : { title, body }),
        data: data || {},
        regionId: regionId || null,
      },
      { allowInlineFallback: false }
    );
    // Don't claim success the engine couldn't deliver — a null id means it wasn't queued.
    if (!id) return error(res, 'Job engine unavailable — broadcast not queued', 503);
    return success(res, { jobId: id }, 'Broadcast queued', 202);
  } catch (err) {
    next(err);
  }
}

// POST /admin/jobs/:queue/run — run a scheduled job immediately (manual trigger / testing).
async function runNow(req, res, next) {
  try {
    const target = req.params.queue;
    const known = listDefs().find((d) => d.queue === target && d.scheduled);
    if (!known) return error(res, 'Unknown or non-runnable queue', 404);
    // Never run a batch job inline inside this HTTP request (it could make many external
    // calls synchronously). Require the engine to be up.
    const id = await queue.enqueue(target, {}, { allowInlineFallback: false });
    if (!id) return error(res, 'Job engine unavailable — cannot trigger now', 503);
    return success(res, { jobId: id, queue: target }, 'Job triggered', 202);
  } catch (err) {
    next(err);
  }
}

// GET /admin/jobs/ui — self-contained dashboard. No data is embedded; it asks for an
// admin bearer token (kept in localStorage) and polls the protected JSON endpoint.
function ui(req, res) {
  res.type('html').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Amoon Bloom — Background Jobs</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; background: #0b0b0c; color: #e7e7ea; }
  header { padding: 20px 24px; border-bottom: 1px solid #2a2a2e; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .pill { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .ok { background: #052e1a; color: #34d399; } .bad { background: #3a0d0d; color: #f87171; }
  main { padding: 24px; max-width: 920px; margin: 0 auto; }
  input { background:#161618; border:1px solid #2a2a2e; color:#e7e7ea; padding:8px 10px; border-radius:8px; font-size:13px; }
  button { background:#2563eb; border:0; color:#fff; padding:8px 14px; border-radius:8px; font-size:13px; cursor:pointer; }
  button.secondary { background:#27272a; }
  table { width:100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid #1f1f23; }
  th { color:#9ca3af; font-weight:500; }
  code { background:#161618; padding:2px 6px; border-radius:5px; font-size:12px; }
  .muted { color:#9ca3af; } .num { font-variant-numeric: tabular-nums; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
</style></head><body>
<header>
  <h1>Background Jobs</h1>
  <span id="engine" class="pill bad">disconnected</span>
  <div class="row" style="margin-left:auto">
    <input id="token" type="password" placeholder="Admin bearer token" style="width:280px" />
    <button onclick="saveToken()">Connect</button>
    <button class="secondary" onclick="refresh()">Refresh</button>
  </div>
</header>
<main>
  <p class="muted" id="meta">Paste an admin JWT and click Connect. Auto-refreshes every 5s.</p>
  <table><thead><tr><th>Queue</th><th>Schedule</th><th class="num">Pending</th><th></th></tr></thead>
  <tbody id="rows"></tbody></table>
</main>
<script>
  const base = location.pathname.replace(/\\/ui$/, '');
  function token(){ return localStorage.getItem('jobsToken') || ''; }
  function saveToken(){ localStorage.setItem('jobsToken', document.getElementById('token').value.trim()); refresh(); }
  document.getElementById('token').value = token();
  async function api(path, opts={}){
    const r = await fetch(base+path, { ...opts, headers: { 'Authorization': 'Bearer '+token(), 'Content-Type':'application/json', ...(opts.headers||{}) }});
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }
  async function runNow(q){ try { await api('/'+encodeURIComponent(q)+'/run', { method:'POST' }); refresh(); } catch(e){ alert('Run failed: '+e.message); } }
  async function refresh(){
    const eng = document.getElementById('engine');
    try {
      const res = await api('');
      const d = res.data || res;
      eng.textContent = d.ready ? 'pg-boss · ready' : (d.enabled ? 'starting / inline' : 'disabled');
      eng.className = 'pill ' + (d.ready ? 'ok' : 'bad');
      document.getElementById('meta').textContent = 'Engine: '+d.engine+' · enabled: '+d.enabled+' · ready: '+d.ready;
      document.getElementById('rows').innerHTML = (d.queues||[]).map(function(q){
        return '<tr><td><code>'+q.queue+'</code></td><td class="muted">'+(q.cron||'on-demand')+'</td>'+
          '<td class="num">'+(q.pending==null?'—':q.pending)+'</td>'+
          '<td>'+(q.scheduled?'<button class="secondary" onclick="runNow(\\''+q.queue+'\\')">Run now</button>':'')+'</td></tr>';
      }).join('');
    } catch(e){
      eng.textContent = 'auth/connection error'; eng.className='pill bad';
      document.getElementById('meta').textContent = 'Could not load status: '+e.message+' — check the token.';
    }
  }
  refresh(); setInterval(refresh, 5000);
</script></body></html>`);
}

module.exports = { status, broadcast, runNow, ui };
