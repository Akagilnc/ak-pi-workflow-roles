/**
 * current.json has one writer — the public call's own seams — while the role
 * runtime, the host adapters and the gates only append records. Two real
 * processes, one appending ledger rows and one writing carried sections,
 * interleave; the carried writes must never drop what the other appended
 * (the derived sections are recomputed from the rows on every write; #1161).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeSectionSync } from "../../src/run-dossier.ts";
import { readCurrentJson, readHistoryRows } from "../helpers/run-dossier-fixture.ts";

const WRITER = new URL("../fixtures/run-dossier-writer.mjs", import.meta.url).pathname;

function runWriter(mode: "append" | "carry", runDirectory: string, count: number, doneFile: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WRITER, mode, runDirectory, String(count), doneFile], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", resolve);
  });
}

test("two processes writing different sections of one current.json lose neither", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-dossier-race-"));
  const run = join(root, ".ak-roles", "books", "dossier-race", "runs", "01a0race-0000-7000-8000-000000000001@judge");
  const doneFile = join(root, "append-done");
  const appended = 150;
  try {
    await mkdir(run, { recursive: true });
    writeSectionSync(run, "invocation", { argv: ["race"] });
    writeSectionSync(run, "admitted", { seat: "judge" });

    const codes = await Promise.all([
      runWriter("append", run, appended, doneFile),
      runWriter("carry", run, 40, doneFile),
    ]);
    assert.deepEqual(codes, [0, 0]);

    const sealed = readHistoryRows(run).filter((row) => row.kind === "sealed");
    assert.equal(sealed.length, appended, "every appended row is in history.jsonl");
    const last = sealed.at(-1)!;

    const current = readCurrentJson(run);
    assert.deepEqual(current.invocation, { argv: ["race"] });
    assert.deepEqual(current.admitted, { seat: "judge" });
    assert.equal((current.runState as { writes: number }).writes >= 40, true);
    assert.equal((current.terminal as { face: string }).face, "report");
    assert.deepEqual(current.submission, {
      latest: { toolCallId: `call-${appended - 1}`, role: "judge", accepted: true, at: last.timestamp },
    });
    // The write leaves no lock or temp entry behind.
    assert.deepEqual((await readdir(run)).sort(), ["current.json", "history.jsonl"]);
    JSON.parse(await readFile(join(run, "current.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
