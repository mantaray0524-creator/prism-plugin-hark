const test = require("node:test");
const assert = require("node:assert");
process.env.PRISM_HARK_HOME = require("fs").mkdtempSync(require("os").tmpdir() + "/hh-");
const { toHistoryTurn, detailSnapshot } = require("../index.js");

test("assistant row sorts after user row", () => {
  const t = { id: "hark-run-x", user: "hi", assistant: "yo", status: "completed", createdAt: "2026-11-02T01:00:00.000Z", updatedAt: "2026-11-02T01:00:05.000Z" };
  const [u, a] = toHistoryTurn(t).messages;
  assert.ok(Date.parse(a.CreatedAt) > Date.parse(u.CreatedAt));
});

test("detail snapshot carries run status", () => {
  const run = { id: "r1", turn: { assistant: "ok", createdAt: new Date().toISOString() }, finalEvent: null };
  assert.equal(detailSnapshot(run, "running").run.status, "running");
  const d = detailSnapshot(run, "completed");
  assert.equal(d.run.status, "completed");
  assert.ok(d.run.completed_at > 0);
  assert.equal(d.desktop_foreground, undefined);
});
