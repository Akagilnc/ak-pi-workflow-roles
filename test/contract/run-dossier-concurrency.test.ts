/**
 * Two writers of one leg's current.json (the live leg and a manual resume): the one that
 * began settling earlier writes after the other has recorded and rendered newer facts.
 * Facts are rows first and current.json is their rendering, so after both have exited it
 * equals a fresh rendering of the rows and carries the resumed model — nothing the later
 * writer recorded is erased by the earlier writer's stale write (#1161 / 给事中 fact 3).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderCurrentSync, writeSectionSync } from "../../src/run-dossier.ts";
import { reportRunRecord } from "../../src/sitian-facade.ts";
import { assertCurrentIsRenderingOfRows } from "../helpers/run-dossier-fixture.ts";

const WRITER = new URL("../fixtures/run-dossier-stale-writer.mjs", import.meta.url).pathname;

function runWriter(runDirectory: string, readyFile: string, goFile: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WRITER, runDirectory, readyFile, goFile], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", resolve);
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an earlier-settling writer's late write cannot erase the model a resume recorded meanwhile", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-dossier-race-"));
  try {
    const run = join(home, ".ak-roles", "books", "b", "unbound", "runs", "r1@judge");
    await mkdir(join(run, "session"), { recursive: true });
    // The leg as admitted: initial model.
    writeSectionSync(run, "invocation", { role: "judge", runId: "r1", provider: "test", model: "initial-model" });
    writeSectionSync(run, "admitted", { role: "judge", instruction: "x" });
    const readyFile = join(home, "ready");
    const goFile = join(home, "go");

    // The live leg begins settling: it has rendered from the rows it read and is about to write.
    const earlier = runWriter(run, readyFile, goFile);
    await until(() => existsSync(readyFile), "the earlier writer to reach its write");

    // Meanwhile the manual resume records the resumed model and a session binding, and renders.
    writeSectionSync(run, "invocation", { role: "judge", runId: "r1", provider: "test", model: "resumed-model" });
    reportRunRecord(run, "host-session-id", { host: "codex", sessionId: "sess-resumed" }, "test");
    renderCurrentSync(run);

    // The earlier writer's stale write now lands.
    await writeFile(goFile, "go");
    assert.equal(await earlier, 0);

    const current = JSON.parse(readFileSync(join(run, "current.json"), "utf8")) as Record<string, any>;
    assert.equal(current.invocation.model, "resumed-model");
    assert.equal(current.runState.by, "earlier-settling-writer");
    assertCurrentIsRenderingOfRows(run);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
