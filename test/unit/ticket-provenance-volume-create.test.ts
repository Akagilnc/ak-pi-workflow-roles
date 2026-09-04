/**
 * #648 — ensureTicketProvenanceVolume must not truncate concurrent first-writer JSONL.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  packageRoot,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import {
  ensureTicketProvenanceVolume,
  resolveTicketProvenanceVolume,
} from "../../src/ticket-provenance.ts";

async function withProject(
  run: (ctx: { project: string; home: string }) => Promise<void>,
): Promise<void> {
  await withHermeticHome({ prefix: "ensure-vol-create-" }, async ({ home }) => {
    const project = join(home, "proj");
    mkdirSync(project, { recursive: true });
    seedGitRepository(project);
    await run({ project, home });
  });
}

test("control: truncating create after a stale absence check erases a sibling row", async () => {
  const root = await mkdtemp(join(tmpdir(), "trunc-control-"));
  const recordFile = join(root, "records.jsonl");
  const barrier = join(root, "barrier");
  const committed = `${JSON.stringify({ identity: "sibling" })}\n`;

  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    const absent = !existsSync(${JSON.stringify(recordFile)});
    process.stdout.write("ready\\n");
    while (!existsSync(${JSON.stringify(barrier)})) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    if (absent) writeFileSync(${JSON.stringify(recordFile)}, "", "utf8");
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  await writeFile(barrier, "go\n", "utf8");
  writeFileSync(recordFile, committed, "utf8");
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  assert.equal(code, 0, stderr);
  assert.equal(readFileSync(recordFile, "utf8"), "", "control must demonstrate truncate hazard");
});

test("ensureTicketProvenanceVolume preserves an already-committed sibling row", async () => {
  await withProject(async ({ project, home }) => {
    const ticketNumber = 648;
    const volume = resolveTicketProvenanceVolume(ticketNumber, project, home);
    mkdirSync(volume.volumeDir, { recursive: true });
    const committed = `${JSON.stringify({ identity: "sibling-committed" })}\n`;
    writeFileSync(volume.recordFile, committed, "utf8");

    ensureTicketProvenanceVolume(ticketNumber, project, home);
    assert.equal(readFileSync(volume.recordFile, "utf8"), committed);

    // Same schedule as the control: delayed create against a live sibling row.
    const barrier = join(home, "ensure.barrier");
    const script = `
      import { existsSync } from "node:fs";
      import { ensureTicketProvenanceVolume } from ${JSON.stringify(join(packageRoot, "src/ticket-provenance.ts"))};
      process.stdout.write("ready\\n");
      while (!existsSync(${JSON.stringify(barrier)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      ensureTicketProvenanceVolume(${ticketNumber}, ${JSON.stringify(project)}, ${JSON.stringify(home)});
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    await writeFile(barrier, "go\n", "utf8");
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolve(exitCode));
    });
    assert.equal(code, 0, stderr);
    assert.equal(readFileSync(volume.recordFile, "utf8"), committed);
  });
});
