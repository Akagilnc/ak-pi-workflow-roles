/**
 * #753 class: gate-officer same-parent resume materials + gate-round accounting.
 * - Multiple pointers to one officer session must not multiply rounds.
 * - Direct officer pointer booking upserts a stable leaf per officer.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { readAnalystGateCyclesFromAuditorRoles } from "../../src/analyst-gate-cycles-read.ts";
import { bookDirectOfficerRunPointer } from "../../src/archivist-record-entry.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

function iso(ms: number): string {
  return new Date(Date.parse("2026-09-08T00:00:00.000Z") + ms).toISOString();
}

async function writeThreeBounceOfficerSession(sessionFile: string): Promise<void> {
  await mkdir(join(sessionFile, ".."), { recursive: true });
  const chunks: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    chunks.push(
      gateToolSessionJsonl({
        id: `notary-bounce-${i + 1}`,
        startedAt: iso(i * 60_000),
        endedAt: iso(i * 60_000 + 10_000),
        toolName: "ak_notary_output",
        args: {
          status: "bounce",
          findings: [`finding-${i + 1}`],
        },
        includeHeader: i === 0,
      }),
    );
  }
  await writeFile(sessionFile, chunks.join(""), "utf8");
}

test("#753 multiple pointers to same officer session count seals once each", async () => {
  await withTempRoot("ak-gate-pointer-dedupe-", async (root) => {
    const officerSession = join(root, "officer", "session", "session.jsonl");
    await writeThreeBounceOfficerSession(officerSession);
    const auditorRoles = join(root, "parent", "session", "auditor-roles");
    await mkdir(auditorRoles, { recursive: true });
    // Historical multi-mint shape (pre-upsert): three pointers, one session.
    for (const name of ["notary-aaa.pointer.json", "notary-bbb.pointer.json", "notary-ccc.pointer.json"]) {
      await writeFile(
        join(auditorRoles, name),
        `${JSON.stringify({
          version: 1,
          kind: "direct-officer-run-pointer",
          officer: "notary",
          sessionFile: officerSession,
          runDirectory: join(root, "officer"),
        })}\n`,
        "utf8",
      );
    }

    const rounds = await readAnalystGateCyclesFromAuditorRoles(auditorRoles);
    assert.equal(rounds.length, 3, "3 seals via 3 pointers must stay 3 rounds, not 9");
    assert.deepEqual(
      rounds.map((r) => r.status),
      ["bounce", "bounce", "bounce"],
    );
    assert.deepEqual(
      rounds.map((r) => r.findingsCount),
      [1, 1, 1],
    );
  });
});

test("#753 bookDirectOfficerRunPointer upserts stable leaf per officer", async () => {
  await withTempRoot("ak-gate-pointer-upsert-", async (root) => {
    const parentSession = join(root, "parent", "session", "session.jsonl");
    await mkdir(join(parentSession, ".."), { recursive: true });
    await writeFile(parentSession, "", "utf8");
    const firstSession = join(root, "officer-a", "session", "session.jsonl");
    const secondSession = join(root, "officer-b", "session", "session.jsonl");

    bookDirectOfficerRunPointer({
      parentSessionFile: parentSession,
      officer: "notary",
      sessionFile: firstSession,
      runDirectory: join(root, "officer-a"),
    });
    bookDirectOfficerRunPointer({
      parentSessionFile: parentSession,
      officer: "notary",
      sessionFile: secondSession,
      runDirectory: join(root, "officer-b"),
    });

    const nest = join(root, "parent", "session", "auditor-roles");
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(nest)).sort();
    assert.deepEqual(names, ["notary.pointer.json"]);
    const body = JSON.parse(await readFile(join(nest, "notary.pointer.json"), "utf8")) as {
      sessionFile: string;
      runDirectory?: string;
    };
    assert.equal(body.sessionFile, secondSession);
    assert.equal(body.runDirectory, join(root, "officer-b"));
  });
});
