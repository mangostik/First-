import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJob } from "../src/orchestration/schemas.js";
import { JsonJobStore } from "../src/orchestration/job-store.js";
import { ReadOnlyTracker } from "../src/orchestration/tracker.js";

function request(url, headers = {}) {
  const req = new EventEmitter();
  req.url = url;
  req.method = "GET";
  req.headers = { host: "localhost", ...headers };
  return req;
}

function response() {
  return { statusCode: 200, headers: {}, body: "", chunks: [], setHeader(k, v) { this.headers[k] = v; }, end(v = "") { this.body += v; this.ended = true; }, write(v) { this.chunks.push(v); } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fishcrm-tracker-"));
  const store = new JsonJobStore(root);
  const job = createJob("tracker task");
  job.events.push({ type: "agent_result", timestamp: new Date().toISOString(), token: "ghp_secret-token" });
  await store.create(job);
  return { root, store, job };
}

test("tracker lists jobs and returns job details read-only", async () => {
  const { root, store, job } = await fixture();
  try {
    const tracker = new ReadOnlyTracker({ store });
    const listRes = response();
    assert.equal(await tracker.handle(request("/api/jobs"), listRes), true);
    assert.equal(listRes.statusCode, 200);
    assert.equal(JSON.parse(listRes.body).jobs[0].job_id, job.job_id);
    const detailRes = response();
    await tracker.handle(request(`/api/jobs/${job.job_id}`), detailRes);
    assert.equal(JSON.parse(detailRes.body).job.job_id, job.job_id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tracker serves SSE snapshots when the existing job event model changes", async () => {
  const { root, store, job } = await fixture();
  try {
    const tracker = new ReadOnlyTracker({ store, pollMs: 10 });
    const req = request(`/api/jobs/${job.job_id}/events`, { accept: "text/event-stream" });
    const res = response();
    await tracker.handle(req, res);
    assert.match(res.headers["Content-Type"], /text\/event-stream/);
    await store.update(job.job_id, current => { current.status = "running"; current.events.push({ type: "job_state", status: "running", timestamp: new Date().toISOString() }); return current; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(res.chunks.some(chunk => chunk.includes("job_state") && chunk.includes("running")));
    req.emit("close");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tracker rejects unauthorized, invalid and unknown jobs without leaking tokens", async () => {
  const { root, store, job } = await fixture();
  try {
    const tracker = new ReadOnlyTracker({ store, token: "tracker-secret" });
    const unauthorized = response();
    await tracker.handle(request("/api/jobs"), unauthorized);
    assert.equal(unauthorized.statusCode, 401);
    const invalid = response();
    await tracker.handle(request("/api/jobs/bad.id", { authorization: "Bearer tracker-secret" }), invalid);
    assert.equal(invalid.statusCode, 400);
    const traversal = response();
    await tracker.handle(request("/api/jobs/../escape", { authorization: "Bearer tracker-secret" }), traversal);
    assert.equal(traversal.statusCode, 400);
    const unknown = response();
    await tracker.handle(request("/api/jobs/missing", { authorization: "Bearer tracker-secret" }), unknown);
    assert.equal(unknown.statusCode, 404);
    const detail = response();
    await tracker.handle(request(`/api/jobs/${job.job_id}`, { authorization: "Bearer tracker-secret" }), detail);
    assert.equal(detail.body.includes("ghp_secret-token"), false);
    assert.equal(detail.headers["Set-Cookie"].includes("tracker-secret"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
