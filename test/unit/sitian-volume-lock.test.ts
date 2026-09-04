/**
 * #648 correctness — identity uniqueness without unsafe volume-lock reclaim.
 * Seam: appendSitianRecord (real entry). Concurrent same-identity converges on
 * one JSONL row via exclusive identity claim (linkSync). Dead unpublished claims
 * recover from the claim's write-ahead row or fail closed — never wait forever.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendSitianRecord,
  resolveSitianRecordPath,
} from "../../src/sitian-appender.ts";
import { SitianInfrastructureError } from "../../src/sitian-contracts.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

function identityClaimPath(recordFile: string, identity: string): string {
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return `${recordFile}.id-${digest}`;
}

async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  const code = await childExit(child);
  assert.equal(code, 0);
  assert.ok(typeof child.pid === "number" && child.pid > 0);
  return child.pid;
}

function sleepBriefly(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function waitUntil(
  predicate: () => boolean,
): Promise<void> {
  while (!predicate()) {
    sleepBriefly(2);
  }
}

function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function settleChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // already exiting
  }
  while (child.exitCode === null && child.signalCode === null) {
    sleepBriefly(2);
  }
}

async function withHermeticLedgerRoot<T>(
  run: (ctx: { home: string; cwd: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "sitian-identity-claim-"));
  return withPrimaryAwareCleanup(
    async () => {
      const home = join(root, "home");
      const cwd = join(root, "cwd");
      mkdirSync(cwd, { recursive: true });
      return await run({ home, cwd });
    },
    async () => {
      await rm(root, { recursive: true, force: true });
    },
  );
}

function countIdentityRows(recordFile: string, identity: string): number {
  if (!existsSync(recordFile)) return 0;
  let count = 0;
  for (const line of readFileSync(recordFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { identity?: unknown };
      if (parsed.identity === identity) count += 1;
    } catch {
      // ignore malformed for this counter
    }
  }
  return count;
}

test("stale volume .lock residue does not block appendSitianRecord", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const input = {
      level: "event" as const,
      kind: "identity-claim-stale-lock",
      identity: "stale-lock-ignored",
      home,
      cwd,
      payload: { marker: "after-stale-lock" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    const lockFile = `${recordFile}.lock`;
    writeFileSync(lockFile, "1\n", "utf8");

    const pointer = appendSitianRecord(input);

    assert.equal(pointer.recordFile, recordFile);
    assert.equal(pointer.identity, "stale-lock-ignored");
    assert.match(readFileSync(recordFile, "utf8"), /after-stale-lock/);
    assert.equal(
      countIdentityRows(recordFile, "stale-lock-ignored"),
      1,
      "identity claim must publish exactly one row",
    );
    // Lock reclaim is gone: residue may remain; uniqueness must not depend on it.
    assert.equal(existsSync(lockFile), true);
  });
});

test("concurrent same-identity appendSitianRecord commits one volume row", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "concurrent-identity-claim";
    const kind = "identity-claim-concurrent";
    const barrier = join(home, "start.barrier");
    mkdirSync(home, { recursive: true });

    const childScript = `
      import { existsSync, writeFileSync } from "node:fs";
      import { appendSitianRecord } from ${JSON.stringify(join(packageRoot, "src/sitian-appender.ts"))};
      const barrier = ${JSON.stringify(barrier)};
      const readyMarker = process.argv[1];
      writeFileSync(readyMarker, "ready\\n", "utf8");
      while (!existsSync(barrier)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      const pointer = appendSitianRecord({
        level: "event",
        kind: ${JSON.stringify(kind)},
        identity: ${JSON.stringify(identity)},
        home: ${JSON.stringify(home)},
        cwd: ${JSON.stringify(cwd)},
        payload: { marker: "concurrent-claim", pid: process.pid },
      });
      process.stdout.write(JSON.stringify(pointer) + "\\n");
    `;

    const readyA = join(home, "ready-a.seam");
    const readyB = join(home, "ready-b.seam");
    const childA = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript, readyA],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const childB = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript, readyB],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderrA = "";
    let stderrB = "";
    childA.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderrA += chunk;
    });
    childB.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderrB += chunk;
    });

    const exitA = childExit(childA);
    const exitB = childExit(childB);
    exitA.catch(() => undefined);
    exitB.catch(() => undefined);

    await withPrimaryAwareCleanup(
      async () => {
        await waitUntil(() => existsSync(readyA) && existsSync(readyB));
        writeFileSync(barrier, "go\n", "utf8");

        const [codeA, codeB] = await Promise.all([exitA, exitB]);
        assert.equal(codeA, 0, `child A failed: ${stderrA}`);
        assert.equal(codeB, 0, `child B failed: ${stderrB}`);

        const { recordFile } = resolveSitianRecordPath({
          level: "event",
          kind,
          identity,
          home,
          cwd,
        });
        assert.equal(
          countIdentityRows(recordFile, identity),
          1,
          "concurrent same-identity appends must converge on one JSONL row",
        );
      },
      async () => {
        await Promise.all([settleChild(childA), settleChild(childB)]);
      },
    );
  });
});

test("dead unpublished identity claim recovers one JSONL row from claim write-ahead", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "dead-claim-recovery";
    const input = {
      level: "event" as const,
      kind: "identity-claim-dead-recovery",
      identity,
      home,
      cwd,
      payload: { marker: "recovered-from-claim" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });

    const deadPid = await exitedChildPid();
    const row = `${JSON.stringify({
      level: "event",
      kind: input.kind,
      identity,
      timestamp: "2026-01-01T00:00:00.000Z",
      host: "pi",
      payload: { marker: "recovered-from-claim" },
    })}\n`;
    writeFileSync(identityClaimPath(recordFile, identity), `${deadPid}\n${row}`, "utf8");

    const pointer = appendSitianRecord(input);

    assert.equal(pointer.identity, identity);
    assert.equal(pointer.recordFile, recordFile);
    assert.equal(
      countIdentityRows(recordFile, identity),
      1,
      "dead claim recovery must publish exactly one JSONL row",
    );
    assert.match(readFileSync(recordFile, "utf8"), /recovered-from-claim/);
  });
});

test("dead claim with dead recovery residue fails closed without waiting", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "dead-claim-dead-recovery";
    const input = {
      level: "event" as const,
      kind: "identity-claim-dead-recovery-residue",
      identity,
      home,
      cwd,
      payload: { marker: "should-not-publish" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });

    const deadClaimPid = await exitedChildPid();
    const deadRecoveryPid = await exitedChildPid();
    const claimPath = identityClaimPath(recordFile, identity);
    const row = `${JSON.stringify({
      level: "event",
      kind: input.kind,
      identity,
      timestamp: "2026-01-01T00:00:00.000Z",
      host: "pi",
      payload: { marker: "should-not-publish" },
    })}\n`;
    writeFileSync(claimPath, `${deadClaimPid}\n${row}`, "utf8");
    writeFileSync(`${claimPath}.recovery`, `${deadRecoveryPid}\n`, "utf8");

    assert.throws(
      () => appendSitianRecord(input),
      (error: unknown) => {
        assert.ok(error instanceof SitianInfrastructureError);
        assert.match(error.message, /stayed unpublished|not safely reclaimable/);
        return true;
      },
    );
    assert.equal(
      countIdentityRows(recordFile, identity),
      0,
      "fail-closed residue must not append a JSONL row",
    );
  });
});
