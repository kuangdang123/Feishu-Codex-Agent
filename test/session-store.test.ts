import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../src/session-store.js";

test("session settings survive thread reset", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-"));
  try {
    const store = new SessionStore(path.join(directory, "sessions.json"));
    await store.setModel("chat-1", "gpt-5.5");
    await store.setSandbox("chat-1", "read-only");
    await store.setThreadId("chat-1", "thread-1");
    await store.resetThread("chat-1");

    const record = await store.get("chat-1");
    assert.equal(record?.threadId, undefined);
    assert.equal(record?.model, "gpt-5.5");
    assert.equal(record?.sandbox, "read-only");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
