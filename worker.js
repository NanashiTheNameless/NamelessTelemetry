// SPDX-License-Identifier: LicenseRef-OQL-1.3
// NamelessTelemetry Cloudflare Worker
// - POST /census: accept minimal JSON payload from clients
//   { id: sha256, date: YYYY-MM-DD, projectname|project: string }
//   Deduplicate per (date, project, id) and increment a per-day counter.
// - GET /: serve a simple index HTML with recent counts per project.
// - GET /api/stats: return JSON summary for recent days.

const DAYS_TO_SHOW = 7 // default if no range provided
// Projects to ignore entirely (case-insensitive)
const PROJECT_DENYLIST = new Set(
  [
    'Project',
    'ExampleProject',
    '<PROJECT_NAME>'
  ].map((s) => String(s).toLowerCase())
)

function parseRangeDays (searchParams) {
  const range = (searchParams.get('range') || '').toLowerCase()
  const map = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365, '1y': 365 }
  if (map[range]) return map[range]
  const daysParam = parseInt(searchParams.get('days') || '', 10)
  if (Number.isFinite(daysParam) && daysParam >= 7 && daysParam <= 365) return daysParam
  return DAYS_TO_SHOW
}

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url)
    try {
      // Best-effort background cleanup of old count keys (runs at most once per day)
      if (env && env.TELEMETRY && ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(maybeCleanupOldCounts(env))
      }
      if (request.method === 'POST' && url.pathname === '/census') {
        return await handleCensus(request, env)
      }
      if (request.method === 'GET' && url.pathname === '/api/stats') {
        const projectFilter = url.searchParams.get('project') || undefined
        const days = parseRangeDays(url.searchParams)
        const json = await buildStats(env, projectFilter, days)
        return jsonResponse(json)
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const projectFilter = url.searchParams.get('project') || undefined
        const days = parseRangeDays(url.searchParams)
        const daysForData = days + 1 // fetch one extra UTC day to handle local-day boundaries
        const json = await buildStats(env, projectFilter, daysForData)
        return new Response(renderHtml(json, projectFilter, days), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() })
      }
      return new Response('Not found', { status: 404 })
    } catch (err) {
      return new Response('Server error', { status: 500 })
    }
  }
}

function corsHeaders () {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  }
}

function normalizeProject (p) {
  // Trim and clamp project name length to prevent abuse; allow common chars
  let s = (p || '').toString().trim()
  if (s.length > 100) s = s.slice(0, 100)
  // Avoid control characters and newlines
  s = s.replace(/[\r\n\t\0]/g, ' ').trim()
  // Return empty string if nothing usable remains; caller decides how to handle
  return s
}

async function handleCensus (request, env) {
  if (!env.TELEMETRY || !env.TELEMETRY.list) {
    return new Response('KV not bound', { status: 500 })
  }
  const ct = request.headers.get('content-type') || ''
  if (!ct.toLowerCase().includes('application/json')) {
    return new Response('Unsupported Media Type', { status: 415, headers: corsHeaders() })
  }
  let body
  try {
    body = await request.json()
  } catch {
    return new Response('Bad Request', { status: 400, headers: corsHeaders() })
  }
  // Normalize id and project; enforce per-day (UTC) dedupe by ignoring client-provided date
  const id = ((body?.id || '').toString()).toLowerCase()
  // Allow header override for project to support clients that can't customize payload
  const headerProject = request.headers.get('x-project-name') || request.headers.get('X-Project-Name')
  let project = (headerProject || body?.projectname || body?.project || '').toString().trim()
  project = normalizeProject(project)
  if (!project) {
    // Abandon data when no valid project name is provided
    return new Response(null, { status: 204, headers: corsHeaders() })
  }
  // Ignore blocked projects
  if (PROJECT_DENYLIST.has(project.toLowerCase())) {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }
  // Always use current UTC day for counting/deduplication
  const date = new Date().toISOString().slice(0, 10)
  if (!/^[a-f0-9]{64}$/.test(id)) {
    // Require a SHA-256 hex id for deduping; accept but do not count otherwise
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  const seenKey = `seen:${date}:${project}:${id}`
  const countKey = `counts:${date}:${project}`
  // Set absolute expiration for the count key to auto-delete after ~1 year
  let countExpiration
  try {
    const [yy, mm, dd] = date.split('-').map((x) => parseInt(x, 10))
    // Expire the count a little over a year after the UTC day begins (366 days for leap-year safety)
    countExpiration = Math.floor(Date.UTC(yy, (mm || 1) - 1, dd || 1) / 1000) + 366 * 24 * 60 * 60
  } catch {
    countExpiration = undefined
  }

  try {
    const seen = await env.TELEMETRY.get(seenKey)
    if (!seen) {
      // Mark as seen with a TTL to prevent unbounded growth (keep ~10 days)
      await env.TELEMETRY.put(seenKey, '1', { expirationTtl: 10 * 24 * 60 * 60 })
      const current = parseInt((await env.TELEMETRY.get(countKey)) || '0', 10) || 0
      const putOpts = countExpiration ? { expiration: countExpiration } : undefined
      await env.TELEMETRY.put(countKey, String(current + 1), putOpts)
    }
  } catch (e) {
    // Ignore storage errors; keep endpoint resilient
  }

  return new Response(null, { status: 204, headers: corsHeaders() })
}

async function buildStats (env, projectFilter, daysToShow = DAYS_TO_SHOW) {
  const out = {
    projects: {}, // { [project]: { [date]: count } }
    totals: {}, // { [date]: totalAcrossProjects }
    days: []
  }
  const today = new Date()
  const days = []
  for (let i = 0; i < daysToShow; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
    d.setUTCDate(d.getUTCDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }
  days.reverse()
  out.days = days

  // List all counts and filter to the time window
  let cursor
  do {
    const listing = await env.TELEMETRY.list({ prefix: 'counts:', cursor })
    for (const key of listing.keys || []) {
      const parts = key.name.split(':') // ['counts', YYYY-MM-DD, project]
      if (parts.length < 3) continue
      const date = parts[1]
      const project = parts.slice(2).join(':')
      if (PROJECT_DENYLIST.has(project.toLowerCase())) continue
      if (!days.includes(date)) continue
      if (projectFilter && project !== projectFilter) continue
      const val = parseInt((await env.TELEMETRY.get(key.name)) || '0', 10) || 0
      if (!out.projects[project]) out.projects[project] = {}
      out.projects[project][date] = val
      out.totals[date] = (out.totals[date] || 0) + val
    }
    cursor = listing.cursor
  } while (cursor)

  return out
}

function jsonResponse (obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() }
  })
}

function renderHtml (stats, selectedProject, daysToShow) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const projects = Object.keys(stats.projects).sort()
  const rangeLabel = (d) => d >= 365 ? '1 year' : d >= 180 ? '6 months' : d >= 90 ? '3 months' : d >= 30 ? '30 days' : '7 days'
  const colorList = (n) => { const base = [210, 280, 150, 20, 330, 100, 260, 40, 0, 180]; const out = []; for (let i = 0; i < n; i++) { const hue = base[i % base.length] + (Math.floor(i / base.length) * 30); out.push('hsl(' + hue + ', 70%, 60%)') } return out }

  const head = `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="color-scheme" content="dark light"/>
  <meta name="theme-color" content="#0b0f14"/>
  <title>NamelessTelemetry</title>
  <style>
    :root{--bg:#0b0f14;--panel:#0f172a;--text:#e5e7eb;--muted:#9ca3af;--border:#1f2937;--accent:#60a5fa;--today:#1d4ed8;--row:#0b1220;--rowAlt:#0d1424}
    *{box-sizing:border-box}
    html,body{height:100%}
    body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
    a{color:var(--accent);text-decoration:none}
    a:hover{text-decoration:underline}
  .container{max-width:100%;margin:0 auto;padding:24px}
    header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
    h1{font-size:1.25rem;margin:0}
    .muted{color:var(--muted)}
    .panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px}
    .toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px}
    .select{background:#0b1220;border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:8px}
    .chart-wrap{position:relative;border-radius:10px;border:1px solid var(--border);background:linear-gradient(180deg,#0a1324,#0d1424)}
    .chart-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--border)}
  .chart-body{padding:8px}
  .chart-body canvas{width:100%;display:block}
    .legend{display:flex;flex-wrap:wrap;gap:8px}
    .legend-item{display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:.9rem}
    .swatch{width:10px;height:10px;border-radius:2px}
    .badge{display:inline-block;background:#13213b;border:1px solid var(--border);padding:2px 8px;border-radius:999px;font-size:.8rem;color:#cbd5e1}
    code{background:#111827;border:1px solid var(--border);padding:2px 6px;border-radius:6px}
    .visually-hidden{position:absolute!important;height:1px;width:1px;overflow:hidden;clip:rect(1px,1px,1px,1px);white-space:nowrap}
  </style>
  </head><body>`

  const toolbar = `
  <div class="toolbar">
    <div class="muted">Daily self-host census counts • <span class="badge">${rangeLabel(daysToShow)}</span></div>
    <div>
      <label for="project-filter" class="muted" style="margin-right:6px">Project</label>
      <select id="project-filter" class="select">
        <option value="" ${!selectedProject ? 'selected' : ''}>All projects</option>
        ${projects.map(p => `<option value="${esc(p)}" ${selectedProject === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select>
      <label for="range" class="muted" style="margin:0 6px 0 12px">Timeframe</label>
      <select id="range" class="select">
        ${[[7, '7d'], [30, '30d'], [90, '90d'], [180, '180d'], [365, '365d']].map(([d, k]) => `<option value="${k}" ${daysToShow === d ? 'selected' : ''}>${rangeLabel(d)}</option>`).join('')}
      </select>
    </div>
  </div>`

  const intro = `
  <header>
    <h1>NamelessTelemetry</h1>
    <nav class="muted">Endpoint: <code>/census</code> • JSON: <a href="/api/stats${(() => { const sp = new URLSearchParams(); if (selectedProject) sp.set('project', selectedProject); if (daysToShow !== undefined) sp.set('range', daysToShow >= 365 ? '365d' : daysToShow + 'd'); const q = sp.toString(); return q ? `?${q}` : '' })()}">/api/stats</a></nav>
  </header>
  <div class="panel">
    ${toolbar}
    <div class="chart-wrap">
      <div class="chart-head">
        <div class="legend">
          ${(() => {
            const colors = colorList(projects.length)
            return projects.map((p, i) => `<span class="legend-item"><span class="swatch" style="background:${colors[i]}"></span>${esc(p)}</span>`).join('')
          })()}
        </div>
  <div class="muted"><span id="range-dates"></span></div>
      </div>
      <div class="chart-body">
        <canvas id="chart" height="300"></canvas>
      </div>
    </div>
  </div>`

  const foot = `
  <div class="container">
    <p class="muted">Public dashboard: <a href="https://telemetry.namelessnanashi.dev/">telemetry.namelessnanashi.dev</a> or <a href="https://census.namelessnanashi.dev/">census.namelessnanashi.dev</a></p>
    <p class="muted">Source: <a href="https://github.com/NanashiTheNameless/NamelessTelemetry">NamelessTelemetry</a></p>
  </div>
  <script>
    (function(){
      const sel = document.getElementById('project-filter');
      if (!sel) return;
      sel.addEventListener('change', ()=>{
        const v = sel.value;
        const url = new URL(window.location.href);
        if (v) url.searchParams.set('project', v); else url.searchParams.delete('project');
        window.location.href = url.toString();
      });
    })();
    (function(){
      const sel = document.getElementById('range');
      if (!sel) return;
      sel.addEventListener('change', ()=>{
        const v = sel.value;
        const url = new URL(window.location.href);
        if (v) url.searchParams.set('range', v); else url.searchParams.delete('range');
        window.location.href = url.toString();
      });
    })();

    // Chart rendering without external libraries
    (function(){
      const canvas = document.getElementById('chart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const pxRatio = window.devicePixelRatio || 1;
      function sizeAndDraw(){
        const rect = canvas.getBoundingClientRect();
        const cssWidth = Math.max(320, Math.floor(rect.width));
        // Responsive height: scale with width, but cap by viewport height and enforce a minimum
        const desired = Math.round(cssWidth * 0.6); // 3:5 aspect ratio (taller than 16:9)
        const maxVH = Math.round((window.innerHeight || 700) * 0.7); // don't exceed 70% of viewport height
        const minPx = 220; // ensure readability for axes/labels
        const cssHeight = Math.max(minPx, Math.min(desired, maxVH));
        canvas.width = Math.floor(cssWidth * pxRatio);
        canvas.height = Math.floor(cssHeight * pxRatio);
        canvas.style.width = cssWidth + 'px';
        canvas.style.height = cssHeight + 'px';
        ctx.setTransform(pxRatio,0,0,pxRatio,0,0);

        const data = { daysUtc: ${JSON.stringify(stats.days)}, projects: ${JSON.stringify(stats.projects)} };
        const daysSelected = ${Number.isFinite(daysToShow) ? daysToShow : 7};

        // Build local calendar day labels (today back N-1 days)
        const now = new Date();
        const localDays = [];
        for (let i=daysSelected-1; i>=0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          d.setDate(d.getDate() - i);
          // en-CA => YYYY-MM-DD
          localDays.push(d.toLocaleDateString('en-CA'));
        }

        // Map each local day to a best UTC bucket (prefer exact match, else nearest prior available)
        const utcDays = data.daysUtc.slice();
        function bestUtcForLocal(local){
          if (utcDays.includes(local)) return local;
          // find nearest prior UTC day
          for (let i=utcDays.length-1; i>=0; i--) {
            if (utcDays[i] <= local) return utcDays[i];
          }
          return utcDays[0];
        }
        const selectedUtcDays = localDays.map(bestUtcForLocal);

        // Labels reflect the local calendar days; values come from mapped UTC buckets
        const labels = localDays;
        const rangeEl = document.getElementById('range-dates');
        if (rangeEl && labels.length){ rangeEl.textContent = labels[0] + (labels.length>1?(' → ' + labels[labels.length-1]):''); }

        const series = Object.keys(data.projects).sort().map(k=>({ name:k, values: selectedUtcDays.map(d=> data.projects[k][d]||0) }));

      // Determine resolution: day if <= 90, else week if <= 180, else month
        const dCount = labels.length;
        const resolution = dCount <= 90 ? 'day' : (dCount <= 180 ? 'week' : 'month');

      function bucket(labels, series, resolution){
        if (resolution==='day') return { labels, series };
        const outLabels = [];
        const outSeries = series.map(s=>({ name:s.name, values:[] }));
        if (resolution==='week'){
          let acc = series.map(()=>0), n=0, weekKey=null;
          for (let i=0;i<labels.length;i++){
            const d = new Date(labels[i]);
            const w = d.getUTCFullYear() + '-W' + weekNumber(d);
            if (weekKey===null) weekKey=w;
            if (w!==weekKey){
              outLabels.push(weekKey);
              outSeries.forEach((s,idx)=>{ s.values.push(acc[idx]); });
              acc = series.map(()=>0); n=0; weekKey=w;
            }
            series.forEach((s,idx)=>{ acc[idx]+=s.values[i]; }); n++;
          }
          if (weekKey!==null){ outLabels.push(weekKey); outSeries.forEach((s,idx)=>{ s.values.push(acc[idx]); }); }
        } else {
          // month
          let acc = series.map(()=>0), monthKey=null;
          for (let i=0;i<labels.length;i++){
            const d = new Date(labels[i]);
            const m = d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0');
            if (monthKey===null) monthKey=m;
            if (m!==monthKey){
              outLabels.push(monthKey);
              outSeries.forEach((s,idx)=>{ s.values.push(acc[idx]); });
              acc = series.map(()=>0); monthKey=m;
            }
            series.forEach((s,idx)=>{ acc[idx]+=s.values[i]; });
          }
          if (monthKey!==null){ outLabels.push(monthKey); outSeries.forEach((s,idx)=>{ s.values.push(acc[idx]); }); }
        }
        return { labels: outLabels, series: outSeries };
      }

      function weekNumber(d){
        // ISO week number
        const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const dayNum = date.getUTCDay() || 7;
        date.setUTCDate(date.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
        const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1)/7);
        return String(weekNo).padStart(2,'0');
      }

        const bucketed = bucket(labels, series, resolution);

    // Determine bounds
  const allVals = bucketed.series.flatMap(s=>s.values);
  const rawMax = Math.max(0, Math.max.apply(null, allVals));
  const padding = { l: 64, r: 24, t: 16, b: 36 };
        const W = cssWidth - padding.l - padding.r;
        const H = cssHeight - padding.t - padding.b;

      // Axes
        ctx.clearRect(0,0,cssWidth,cssHeight);
        ctx.save();
        ctx.translate(padding.l, padding.t);
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 1;

      // grid & y-axis labels
        ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
        ctx.fillStyle = '#9ca3af';
        // Dynamic tick count based on available height (aim ~60-80px per band)
        const targetBand = 70;
        const ticks = Math.max(3, Math.min(8, Math.round(H / targetBand)));

        function niceStep(max, count){
          if (!isFinite(max) || max <= 0) return 1;
          // headroom: add 10% so lines don't hug the top
          const maxWithHeadroom = max * 1.1;
          const raw = maxWithHeadroom / count;
          const pow = Math.pow(10, Math.floor(Math.log10(raw)));
          const base = raw / pow;
          // allow 1, 2, 2.5, 5, 10
          let niceBase;
          if (base <= 1) niceBase = 1;
          else if (base <= 2) niceBase = 2;
          else if (base <= 2.5) niceBase = 2.5;
          else if (base <= 5) niceBase = 5;
          else niceBase = 10;
          return niceBase * pow;
        }

        function formatNumber(n){
          if (n >= 1_000_000) {
            const v = n / 1_000_000;
            return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(v < 10 ? 1 : 0)) + 'M';
          }
          if (n >= 1_000) {
            const v = n / 1_000;
            return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(v < 10 ? 1 : 0)) + 'K';
          }
          return Math.round(n).toLocaleString('en-US');
        }

        const yStep = niceStep(rawMax, ticks);
        const yMax = Math.max(yStep, Math.ceil((rawMax * 1.1) / yStep) * yStep); // top of axis with headroom
        for (let i=0;i<=ticks;i++){
          const yv = yStep * i;
          const y = H - (yv / yMax) * H;
          ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
          const label = formatNumber(yv);
          ctx.textAlign = 'right';
          ctx.fillText(label, -8, y+4);
        }

      // x-axis labels (sparse)
        const xCount = bucketed.labels.length;
        const xStep = Math.max(1, Math.ceil(xCount / 10));
        function xPos(i){ return xCount<=1 ? W/2 : (i/(xCount-1))*W; }
        for (let i=0;i<xCount;i+=xStep){
          const x = xPos(i);
          const lbl = bucketed.labels[i];
          if (i===0) ctx.textAlign = 'left';
          else if (i>=xCount-1) ctx.textAlign = 'right';
          else ctx.textAlign = 'center';
          ctx.fillText(lbl, x, H+18);
        }

      // plot lines
        const colors = genColors(bucketed.series.length);
        bucketed.series.forEach((s,idx)=>{
          ctx.beginPath();
          ctx.lineWidth = 2;
          ctx.strokeStyle = colors[idx];
          s.values.forEach((v,i)=>{
            const x = (xCount<=1 ? W/2 : (i/(xCount-1))*W);
            const y = H - (v / yMax) * H;
            if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
          });
          ctx.stroke();
        });

        ctx.restore();
      }
      sizeAndDraw();
      window.addEventListener('resize', ()=>{ sizeAndDraw(); });

      function genColors(n){
        const base = [210, 280, 150, 20, 330, 100, 260, 40, 0, 180];
        const out = [];
        for (let i=0;i<n;i++){
          const hue = base[i % base.length] + (Math.floor(i/base.length)*30);
          out.push('hsl(' + hue + ', 70%, 60%)');
        }
        return out;
      }
    })();
  </script>
  </body></html>`

  const bodyOpen = '<div class="container">'
  const bodyClose = '</div>'
  return head + bodyOpen + intro + bodyClose + foot
}

// Background maintenance: delete any count keys older than 1 year
async function maybeCleanupOldCounts (env) {
  try {
    const markerKey = 'maintenance:lastCleanupAt'
    const today = new Date().toISOString().slice(0, 10) // UTC date string
    const last = await env.TELEMETRY.get(markerKey)
    if (last === today) return // already ran today
    await env.TELEMETRY.put(markerKey, today, { expirationTtl: 3 * 24 * 60 * 60 })

    const cutoff = new Date()
    cutoff.setUTCDate(cutoff.getUTCDate() - 365)
    const cutoffStr = cutoff.toISOString().slice(0, 10)

    let cursor
    do {
      const listing = await env.TELEMETRY.list({ prefix: 'counts:', cursor })
      const toDelete = []
      for (const key of (listing.keys || [])) {
        const parts = key.name.split(':') // ['counts', YYYY-MM-DD, project]
        if (parts.length < 3) continue
        const date = parts[1]
        if (date < cutoffStr) toDelete.push(key.name)
      }
      // Delete in parallel (best-effort)
      if (toDelete.length) await Promise.all(toDelete.map((k) => env.TELEMETRY.delete(k)))
      cursor = listing.cursor
    } while (cursor)
  } catch {
    // ignore maintenance errors
  }
}
