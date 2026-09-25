import { redactSecrets } from "./observability.js";

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;

function json(res, status, value, setCookie = false, token = "") {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (setCookie && token) res.setHeader("Set-Cookie", `tracker_access=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
  res.end(JSON.stringify(redactSecrets(value)));
}

function authorized(req, token) {
  if (!token) return true;
  const bearer = req.headers?.authorization === `Bearer ${token}`;
  const cookie = String(req.headers?.cookie || "").split(";").map(item => item.trim()).find(item => item.startsWith("tracker_access="));
  return bearer || cookie?.slice("tracker_access=".length) === encodeURIComponent(token);
}

function idFrom(pathname) {
  const match = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/events)?$/);
  return match?.[1] || null;
}

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FishCRM Orchestrator Tracker</title><style>body{font:14px system-ui;margin:0;background:#f5f7fb;color:#172033}main{display:grid;grid-template-columns:280px 1fr;gap:16px;padding:16px}section,article{background:white;border:1px solid #d9dfeb;border-radius:8px;padding:12px}.job{display:block;width:100%;text-align:left;border:0;background:#f7f9fc;padding:9px;margin:4px 0;border-radius:6px;cursor:pointer}.job:hover{background:#eaf0ff}.pill{padding:2px 6px;border-radius:9px;background:#e7edf8}.event{border-left:3px solid #789;padding:4px 8px;margin:5px 0}.muted{color:#63708a}pre{white-space:pre-wrap;word-break:break-word}</style></head><body><main><section><h2>Jobs</h2><div id="jobs" class="muted">Loading…</div></section><article><h1 id="title">Select a job</h1><div id="details" class="muted">Read-only tracker</div></article></main><script>
const jobsEl=document.querySelector('#jobs'),titleEl=document.querySelector('#title'),detailsEl=document.querySelector('#details');let source;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function loadJobs(){const r=await fetch('/api/jobs');if(!r.ok){jobsEl.textContent='Unauthorized or unavailable';return}const d=await r.json();jobsEl.innerHTML=d.jobs.map(j=>'<button class="job" data-id="'+esc(j.job_id)+'"><b>'+esc(j.status)+'</b> <span class="pill">'+esc(j.job_id.slice(0,8))+'</span><br><span class="muted">'+esc(j.task)+'</span></button>').join('');document.querySelectorAll('.job').forEach(b=>b.onclick=()=>selectJob(b.dataset.id));}
function render(j){titleEl.textContent='Job '+j.job_id;detailsEl.innerHTML='<p><b>Status:</b> '+esc(j.status)+' | <b>Duration:</b> '+esc(j.duration_ms)+' ms</p><h3>Subtasks</h3><ul>'+j.subtasks.map(s=>'<li><b>'+esc(s.role)+'</b>: '+esc(s.status)+' — attempts '+esc(s.attempts)+'</li>').join('')+'</ul><h3>Timeline</h3><div>'+j.events.map(e=>'<div class="event"><b>'+esc(e.type)+'</b> <span class="muted">'+esc(e.timestamp)+'</span><br><pre>'+esc(JSON.stringify(e))+'</pre></div>').join('')+'</div><h3>Test evidence</h3><pre>'+esc(JSON.stringify(j.test_evidence,null,2))+'</pre><h3>Warnings and limit violations</h3><pre>'+esc(JSON.stringify({warnings:j.result?.warnings||[],limit_violations:j.limit_violations},null,2))+'</pre><h3>Aggregate / reviewer</h3><pre>'+esc(JSON.stringify({aggregate:j.aggregate,result:j.result},null,2))+'</pre>';}
async function selectJob(id){if(source)source.close();const r=await fetch('/api/jobs/'+encodeURIComponent(id));if(!r.ok){detailsEl.textContent='Job unavailable';return}const d=await r.json();render(d.job);source=new EventSource('/api/jobs/'+encodeURIComponent(id)+'/events');source.onmessage=e=>{const p=JSON.parse(e.data);if(p.job)render(p.job);};}
loadJobs();setInterval(loadJobs,5000);
</script></body></html>`;
}

export class ReadOnlyTracker {
  constructor({ store, token = process.env.ORCHESTRATION_TRACKER_TOKEN || "", pollMs = 1000 } = {}) {
    if (!store) throw new Error("store is required");
    this.store = store;
    this.token = token;
    this.pollMs = Math.max(50, Number(pollMs));
  }

  async handle(req, res) {
    const rawUrl = String(req.url || "/");
    const rawPath = rawUrl.split("?")[0];
    if (!rawPath.startsWith("/tracker") && !rawPath.startsWith("/api/jobs")) return false;
    if (!authorized(req, this.token)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end("Unauthorized");
      return true;
    }
    if (rawPath.startsWith("/api/jobs") && rawPath.includes("..")) {
      json(res, 400, { error: "invalid job_id" });
      return true;
    }
    const url = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`);
    const cookie = Boolean(this.token && req.headers?.authorization);
    if (url.pathname === "/tracker" || url.pathname === "/tracker/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
      res.setHeader("Cache-Control", "no-store");
      if (cookie) res.setHeader("Set-Cookie", `tracker_access=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/`);
      res.end(html());
      return true;
    }
    const jobId = idFrom(url.pathname);
    try {
      if (url.pathname === "/api/jobs" && req.method === "GET") {
        json(res, 200, { jobs: await this.store.list() }, cookie, this.token);
        return true;
      }
      if (!jobId || !SAFE_JOB_ID.test(jobId)) {
        json(res, 400, { error: "invalid job_id" });
        return true;
      }
      const job = await this.store.get(jobId);
      if (url.pathname.endsWith("/events")) {
        if (req.headers?.accept?.includes("text/event-stream")) return this.stream(req, res, jobId);
        json(res, 200, { events: job.events || [] }, cookie, this.token);
      } else json(res, 200, { job }, cookie, this.token);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") json(res, 404, { error: "job not found" });
      else if (/Invalid job_id/.test(error?.message || "")) json(res, 400, { error: "invalid job_id" });
      else json(res, 500, { error: "tracker storage error" });
      return true;
    }
  }

  async stream(req, res, jobId) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    let last = "";
    const send = async () => {
      try {
        const job = await this.store.get(jobId);
        const snapshot = JSON.stringify(redactSecrets({ job }));
        if (snapshot !== last) {
          last = snapshot;
          res.write(`data: ${snapshot}\n\n`);
        } else res.write(": heartbeat\n\n");
      } catch { clearInterval(timer); res.end(); }
    };
    const timer = setInterval(send, this.pollMs);
    req.on?.("close", () => { clearInterval(timer); res.end(); });
    await send();
    return true;
  }
}
