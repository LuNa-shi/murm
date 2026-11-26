import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  link,
  mkdtemp,
  writeFile,
  appendFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTraceReader } from "../reader.mjs";

test("historical Core Run preserves Agent identity, evidence and separate status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "run"));
  await writeFile(
    join(root, "run/runtime.json"),
    JSON.stringify({
      runtimeId: "r",
      status: "closed",
      cleanup: "pending",
      bots: [{ botId: "a", execution: "stopped", cleanup: "pending" }],
      config: { schemaVersion: 1 },
    }),
  );
  await writeFile(
    join(root, "run/evidence.jsonl"),
    JSON.stringify({
      type: "input",
      botId: "a",
      state: "accepted",
      seq: 1,
      at: "2026-01-01T00:00:00Z",
      runtimeId: "r",
    }) + "\n",
  );
  const reader = await createTraceReader({ root });
  assert.equal((await reader.listRuns()).length, 1);
  const summary = await reader.summary("run");
  assert.equal(summary.cleanup, "pending");
  assert.equal(summary.agents[0].id, "a");
  assert.equal(summary.agents[0].execution, "stopped");
  assert.equal(summary.agents[0].inputs, "accepted");
  const page = await reader.events("run");
  assert.equal(page.events[0].status, "accepted");
  const detail = await reader.detail("run", page.events[0].id);
  assert.equal(detail.record.botId, "a");
  assert.equal(detail.event.source.path, "evidence.jsonl");
});

test("append, partial lines and cursor survive a fresh reader without skipping records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({ runtimeId: "r", config: { schemaVersion: 1 } }),
  );
  const first =
    JSON.stringify({ type: "input", agentId: "a", state: "accepted", seq: 1 }) +
    "\n";
  await writeFile(join(root, "evidence.jsonl"), first);
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  const page = await reader.events(id);
  const second = JSON.stringify({
    type: "native",
    agentId: "a",
    eventType: "agent_start",
    seq: 3,
  });
  await appendFile(join(root, "evidence.jsonl"), second.slice(0, 15));
  assert.equal(
    (await reader.events(id, { cursor: page.cursor })).events.length,
    0,
  );
  await appendFile(join(root, "evidence.jsonl"), second.slice(15) + "\n");
  const restarted = await createTraceReader({ root });
  const next = await restarted.events(id, { cursor: page.cursor });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].type, "native");
  assert.equal(
    (await restarted.events(id, { cursor: next.cursor })).events.length,
    0,
  );
  assert.ok(
    (await restarted.summary(id)).gaps.some(
      (gap) => gap.kind === "sequence-gap",
    ),
  );
});

test("file reads reject traversal and symlinks without changing source files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({ runtimeId: "r" }),
  );
  await symlink("/etc/passwd", join(root, "escape"));
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  await assert.rejects(reader.file(id, "../secret"), /escapes/);
  await assert.rejects(reader.file(id, "escape"), /Symbolic/);
});

test("100,000 event Run is paginated to 1,000 and refresh only reads appended JSONL bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({ runtimeId: "large" }),
  );
  const lines = Array.from(
    { length: 100000 },
    (_, i) =>
      JSON.stringify({
        type: "input",
        agentId: "a",
        state: "accepted",
        seq: i + 1,
      }) + "\n",
  ).join("");
  await writeFile(join(root, "evidence.jsonl"), lines);
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  assert.equal((await reader.events(id, { limit: 90000 })).events.length, 1000);
  const before = await reader.summary(id);
  const line =
    JSON.stringify({
      type: "input",
      agentId: "a",
      state: "unknown",
      seq: 100001,
    }) + "\n";
  await appendFile(join(root, "evidence.jsonl"), line);
  const next = await reader.events(id, { cursor: before.cursor });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].status, "unknown");
  assert.equal(
    (await reader.summary(id)).index.bytesRead - before.index.bytesRead,
    Buffer.byteLength(line),
  );
});

test("native boundaries, unknown service calls and exact Subagents identities have evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      runtimeId: "relations",
      agents: [{ agentId: "a" }, { agentId: "b" }],
    }),
  );
  const rows = [
    {
      type: "native",
      agentId: "a",
      eventType: "agent_start",
      workerAt: "2026-01-01T00:00:00Z",
      seq: 1,
    },
    {
      type: "native",
      agentId: "a",
      eventType: "agent_settled",
      workerAt: "2026-01-01T00:00:01Z",
      seq: 2,
    },
    {
      type: "input",
      agentId: "b",
      state: "accepted",
      requestId: "child-initial",
      inputId: "child-input",
      source: "/root",
      seq: 3,
    },
  ];
  await writeFile(
    join(root, "evidence.jsonl"),
    rows.map((x) => JSON.stringify(x) + "\n").join(""),
  );
  const calls = [
    {
      caller: { agentId: "a" },
      service: "collaboration",
      operation: "spawn_agent",
      operation_id: "1",
      phase: "started",
      seq: 1,
    },
    {
      caller: { agentId: "a" },
      service: "collaboration",
      operation: "spawn_agent",
      operation_id: "1",
      phase: "settled",
      seq: 2,
      output: {
        agentId: "b",
        task_name: "/root/child",
        inputId: "child-input",
      },
    },
    {
      caller: { agentId: "b" },
      service: "custom",
      operation: "new_operation",
      phase: "settled",
      seq: 3,
    },
  ];
  await writeFile(
    join(root, "service-calls.jsonl"),
    calls.map((x) => JSON.stringify(x) + "\n").join(""),
  );
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  const summary = await reader.summary(id);
  assert.equal(summary.spans[0].startedAt, "2026-01-01T00:00:00Z");
  assert.equal(summary.relations[0].fromAgentId, "a");
  assert.equal(summary.relations[0].toAgentId, "b");
  assert.equal(summary.relations[0].evidenceIds.length, 3);
  assert.ok(
    (await reader.events(id)).events.some(
      (event) => event.label === "new_operation",
    ),
  );
});

test("model results create a new cursor record after requests have been consumed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({ runtimeId: "r" }),
  );
  await mkdir(join(root, "model-trace/request"), { recursive: true });
  await writeFile(
    join(root, "model-trace/request/request.json"),
    JSON.stringify({
      agentId: "a",
      requestId: "q",
      startedAt: "2026-01-01T00:00:00Z",
      before: { input: [] },
    }),
  );
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  const first = await reader.events(id);
  await writeFile(
    join(root, "model-trace/request/result.json"),
    JSON.stringify({ endedAt: "2026-01-01T00:00:01Z", state: "completed" }),
  );
  const next = await reader.events(id, { cursor: first.cursor });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].status, "completed");
});

test("Run files endpoint admits recorded evidence and rejects unrelated private files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({ runtimeId: "r" }),
  );
  await writeFile(join(root, ".env"), "SECRET=private");
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  assert.match((await reader.file(id, "runtime.json")).text, /runtimeId/);
  await assert.rejects(reader.file(id, ".env"), /recorded evidence/);
});

test("message handoff links to the target actual model input by immutable message identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      runtimeId: "r",
      agents: [{ agentId: "a" }, { agentId: "b" }],
    }),
  );
  await writeFile(
    join(root, "harness-report.json"),
    JSON.stringify({
      runtimeId: "r",
      collaboration: {
        members: [
          { agentId: "a", path: "/root" },
          { agentId: "b", path: "/root/child" },
        ],
      },
      result: { done: true },
    }),
  );
  await jsonLines(root, "evidence.jsonl", [
    {
      type: "input",
      agentId: "a",
      state: "accepted",
      requestId: "message-42",
      source: "/root/child",
      seq: 1,
    },
  ]);
  const calls = [
    {
      caller: { agentId: "b" },
      service: "collaboration",
      operation: "send_message",
      phase: "started",
      operation_id: "q",
      seq: 1,
      input: { target: "/root", message: "verified answer" },
    },
    {
      caller: { agentId: "b" },
      service: "collaboration",
      operation: "send_message",
      phase: "settled",
      operation_id: "q",
      seq: 2,
      output: { messageId: "message-42", status: "queued" },
    },
  ];
  await writeFile(
    join(root, "service-calls.jsonl"),
    calls.map((x) => JSON.stringify(x) + "\n").join(""),
  );
  await mkdir(join(root, "model-trace/request"), { recursive: true });
  await writeFile(
    join(root, "model-trace/request/request.json"),
    JSON.stringify({
      agentId: "a",
      requestId: "rq",
      startedAt: "2026-01-01T00:00:01Z",
      before: { input: [] },
      after: {
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  id: "message-42",
                  kind: "message",
                  from: "/root/child",
                  text: "verified answer",
                }),
              },
            ],
          },
        ],
      },
    }),
  );
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  const summary = await reader.summary(id);
  assert.ok(summary.files.some((file) => file.path === "harness-report.json"));
  assert.equal(summary.outcome.status, "recorded");
  assert.equal(summary.outcome.report, "harness-report.json");
  const detail = await reader.detail(id, summary.relations[0].id);
  assert.equal(detail.contextMatches.length, 1);
  assert.equal(detail.contextMatches[0].requestId, "rq");
  assert.equal(detail.contextMatches[0].agentId, "a");
});

test("FIFO and hard links cannot make evidence reads block or leave the Run boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({ runtimeId: "r" }),
  );
  await writeFile(join(root, "private"), "outside evidence");
  await link(join(root, "private"), join(root, "linked"));
  execFileSync("mkfifo", [join(root, "fifo")]);
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  await assert.rejects(reader.file(id, "fifo"), /regular file/);
  await assert.rejects(reader.file(id, "linked"), /Hard links/);
});

async function fixture(t, runtime = { runtimeId: "r" }) {
  const root = await mkdtemp(join(tmpdir(), "murm-reader-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "runtime.json"), JSON.stringify(runtime));
  return root;
}

async function jsonLines(root, path, rows) {
  await writeFile(
    join(root, path),
    rows.map((row) => JSON.stringify(row) + "\n").join(""),
  );
}

test("native failed and aborted outcomes survive execution settlement", async (t) => {
  const root = await fixture(t);
  await jsonLines(root, "evidence.jsonl", [
    { type: "native", agentId: "a", eventType: "agent_start", seq: 1 },
    {
      type: "native",
      agentId: "a",
      eventType: "agent_settled",
      outcome: "failed",
      seq: 2,
    },
    { type: "native", agentId: "b", eventType: "agent_start", seq: 3 },
    {
      type: "native",
      agentId: "b",
      eventType: "agent_settled",
      outcome: "aborted",
      seq: 4,
    },
  ]);
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  const summary = await reader.summary(id);
  assert.equal(
    summary.agents.find((agent) => agent.id === "a").outcome,
    "failed",
  );
  assert.equal(
    summary.agents.find((agent) => agent.id === "b").outcome,
    "aborted",
  );
  assert.deepEqual(
    summary.spans.map((span) => span.status),
    ["failed", "aborted"],
  );
});

test("empty and partially written model requests recover when the final record arrives", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "model-trace/q"), { recursive: true });
  const path = join(root, "model-trace/q/request.json");
  await writeFile(path, "");
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  assert.equal((await reader.events(id)).events.length, 0);
  const request = JSON.stringify({
    agentId: "a",
    requestId: "q",
    startedAt: "2026-01-01T00:00:00Z",
    before: { input: [] },
  });
  await writeFile(path, request.slice(0, -5));
  assert.equal((await reader.events(id)).events.length, 0);
  await writeFile(path, request + "\n");
  const events = (await reader.events(id)).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].requestId, "q");
});

test("record detail rejects overwritten, replaced and truncated source files", async (t) => {
  const root = await fixture(t);
  const path = join(root, "evidence.jsonl");
  const rows = [
    { type: "input", agentId: "a", state: "accepted", seq: 1 },
    { type: "input", agentId: "a", state: "accepted", seq: 2 },
  ];
  await jsonLines(root, "evidence.jsonl", rows);
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  const event = (await reader.events(id)).events[0];
  // The inode and byte count survive an in-place overwrite.
  await jsonLines(
    root,
    "evidence.jsonl",
    rows.map((row) => ({ ...row, agentId: "b" })),
  );
  await assert.rejects(
    reader.detail(id, event.id),
    /source.*changed|source.*replaced/i,
  );
  // Retaining the first record while truncating the suffix still invalidates its original source identity.
  await jsonLines(root, "evidence.jsonl", [rows[0]]);
  assert.equal((await reader.events(id)).events.length, 0);
  await assert.rejects(
    reader.detail(id, event.id),
    /source.*changed|source.*replaced/i,
  );
  await rm(path);
  await jsonLines(root, "evidence.jsonl", rows);
  await assert.rejects(
    reader.detail(id, event.id),
    /source.*changed|source.*replaced/i,
  );
});

test("custom Services and unregistered identities cannot manufacture Subagents relations", async (t) => {
  const root = await fixture(t, {
    runtimeId: "r",
    agents: [{ agentId: "a" }, { agentId: "b" }],
  });
  await jsonLines(root, "evidence.jsonl", [
    {
      type: "input",
      runtimeId: "another",
      agentId: "ghost",
      state: "accepted",
      requestId: "spoofed",
      seq: 1,
    },
  ]);
  await jsonLines(root, "service-calls.jsonl", [
    {
      caller: { agentId: "a" },
      service: "custom",
      operation: "spawn_agent",
      phase: "settled",
      seq: 1,
      output: { agentId: "b" },
    },
    {
      caller: { agentId: "ghost" },
      service: "collaboration",
      operation: "spawn_agent",
      phase: "settled",
      seq: 2,
      output: { agentId: "b" },
    },
  ]);
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  const summary = await reader.summary(id);
  assert.equal(summary.relations.length, 0);
  assert.ok(summary.gaps.some((gap) => gap.kind === "runtime-mismatch"));
  assert.ok(
    !(await reader.events(id)).events.some((event) => event.type === "input"),
  );
  assert.equal((await reader.events(id)).events.length, 2);
});

test("result return requires the child event, accepted target input and exact archived envelope", async (t) => {
  const root = await fixture(t, {
    runtimeId: "r",
    agents: [{ agentId: "parent" }, { agentId: "child" }],
  });
  await writeFile(
    join(root, "harness-report.json"),
    JSON.stringify({
      collaboration: {
        members: [
          { agentId: "parent", path: "/root" },
          { agentId: "child", path: "/root/helper" },
        ],
      },
    }),
  );
  await jsonLines(root, "evidence.jsonl", [
    {
      type: "event",
      agentId: "child",
      seq: 1,
      event: { type: "settled", seq: 8, outcome: "completed" },
    },
    {
      type: "input",
      agentId: "parent",
      seq: 2,
      state: "accepted",
      requestId: "result-1",
      source: "/root/helper",
    },
  ]);
  await mkdir(join(root, "parent/session/files"), { recursive: true });
  await writeFile(
    join(root, "parent/session/manifest.json"),
    JSON.stringify({ files: [{ path: "session.jsonl" }] }),
  );
  const envelope = {
    id: "result-1",
    kind: "result",
    from: "/root/helper",
    eventSeq: 8,
    outcome: "completed",
  };
  await jsonLines(root, "parent/session/files/session.jsonl", [
    {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify({ ...envelope, eventSeq: 99 }) },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: JSON.stringify(envelope) }],
      },
    },
  ]);
  await mkdir(join(root, "model-trace/request"), { recursive: true });
  await writeFile(
    join(root, "model-trace/request/request.json"),
    JSON.stringify({
      agentId: "parent",
      requestId: "model-q",
      startedAt: "2026-01-01T00:00:00Z",
      before: {},
      after: {
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({ ...envelope, id: "result-1-extra" }),
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(envelope) }],
          },
        ],
      },
    }),
  );
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  const summary = await reader.summary(id);
  assert.equal(summary.relations.length, 1);
  assert.equal(summary.relations[0].kind, "result");
  assert.equal(summary.relations[0].eventSeq, 8);
  assert.equal(summary.relations[0].evidenceIds.length, 3);
  const detail = await reader.detail(id, summary.relations[0].id);
  assert.equal(detail.contextMatches.length, 1);
  assert.equal(detail.contextMatches[0].requestId, "model-q");
});

test("malformed artifact manifest paths cannot register unrelated files", async (t) => {
  const root = await fixture(t, { runtimeId: "r", agents: [{ agentId: "a" }] });
  await mkdir(join(root, "a/artifacts"), { recursive: true });
  await writeFile(
    join(root, "a/artifacts/manifest.json"),
    JSON.stringify({ files: [{ path: "../../../private.env" }] }),
  );
  await writeFile(join(root, "private.env"), "private");
  const reader = await createTraceReader({ root });
  const id = (await reader.listRuns())[0].id;
  const summary = await reader.summary(id);
  assert.ok(summary.gaps.some((gap) => gap.kind === "invalid-path"));
  await assert.rejects(
    reader.file(id, "a/artifacts/files/../../../private.env"),
    /recorded evidence/,
  );
});
