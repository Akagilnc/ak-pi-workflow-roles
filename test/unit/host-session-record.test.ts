/**
 * #811: non-pi host turn events land under run session/host-session/records.jsonl
 * via the sitian sole entry. session.jsonl stays header-only.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  HOST_SESSION_RECORD_KIND,
  reportHostSessionEvent,
} from "../../src/host-session-record.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

test("reportHostSessionEvent writes raw host event under session/host-session", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-811-host-session-",
    runName: "run@countersign",
  });
  try {
    await writeFile(
      ledger.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "run@countersign" })}\n`,
      "utf8",
    );
    const event = {
      type: "assistant",
      uuid: "evt-1",
      timestamp: "2026-09-09T12:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "working" }] },
    };
    reportHostSessionEvent({
      host: "claude",
      cwd: ledger.home,
      sessionParent: ledger.sessionFile,
      source: "headless-host",
      event,
    });

    const recordFile = join(ledger.sessionDirectory, HOST_SESSION_RECORD_KIND, "records.jsonl");
    const body = await readFile(recordFile, "utf8");
    assert.ok(body.includes("evt-1"), body);
    const read = await readSitianRecords(recordFile);
    assert.equal(read.records.length, 1);
    assert.equal(read.records[0]?.kind, HOST_SESSION_RECORD_KIND);
    assert.equal(read.records[0]?.host, "claude");
    assert.equal(read.records[0]?.level, "event");
    assert.deepEqual(read.records[0]?.payload, event);
    // session.jsonl stays header-only
    const sessionBody = await readFile(ledger.sessionFile, "utf8");
    assert.equal(sessionBody.trim().split("\n").length, 1);
  } finally {
    ledger.dispose();
  }
});

test("reportHostSessionEvent is idempotent on host uuid identity", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-811-host-session-id-",
    runName: "run@judge",
  });
  try {
    await mkdir(ledger.sessionDirectory, { recursive: true });
    await writeFile(ledger.sessionFile, "{}\n", "utf8");
    const event = { type: "system", uuid: "same-uuid", subtype: "init" };
    reportHostSessionEvent({
      host: "grok-build",
      cwd: ledger.home,
      sessionParent: ledger.sessionFile,
      source: "acp-host",
      event,
    });
    reportHostSessionEvent({
      host: "grok-build",
      cwd: ledger.home,
      sessionParent: ledger.sessionFile,
      source: "acp-host",
      event,
    });
    const recordFile = join(ledger.sessionDirectory, HOST_SESSION_RECORD_KIND, "records.jsonl");
    const read = await readSitianRecords(recordFile);
    assert.equal(read.records.length, 1);
    assert.equal(read.records[0]?.identity, "same-uuid");
  } finally {
    ledger.dispose();
  }
});
