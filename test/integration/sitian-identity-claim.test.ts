/**
 * #648 Gatekeeper correction — identity claim uniqueness + recovery.
 * Medium/integration: real appendSitianRecord entry, cross-process concurrency,
 * and dead claim/recovery states produced through controlled real IO failure
 * (no forged SHA/path/claim encoding).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  appendSitianRecord,
  resolveSitianRecordPath,
} from "../../src/sitian-appender.ts";
import { SitianInfrastructureError } from "../../src/sitian-contracts.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

function waitChildExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code));
  });
}

async function settleSpawnedChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // already exiting
  }
  await waitChildExit(child).catch(() => undefined);
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

/** External volume surface: canonical records.jsonl plus any sidecars. */
function volumeSurfaceNames(sessionDir: string, recordFile: string): string[] {
  const base = basename(recordFile);
  return readdirSync(sessionDir)
    .filter((name) => name === base || name.startsWith(`${base}.`))
    .sort();
}

function poisonCanonicalAppend(recordFile: string): void {
  mkdirSync(dirname(recordFile), { recursive: true });
  writeFileSync(recordFile, "", "utf8");
  chmodSync(recordFile, 0o444);
}

function repairCanonicalAppend(recordFile: string): void {
  chmodSync(recordFile, 0o644);
}

function spawnAppendChild(args: {
  readonly home: string;
  readonly cwd: string;
  readonly identity: string;
  readonly kind: string;
  readonly marker: string;
  readonly expectFailure: boolean;
}): ReturnType<typeof spawn> {
  const script = `
    import { appendSitianRecord } from ${JSON.stringify(join(packageRoot, "src/sitian-appender.ts"))};
    try {
      const pointer = appendSitianRecord({
        level: "event",
        kind: ${JSON.stringify(args.kind)},
        identity: ${JSON.stringify(args.identity)},
        home: ${JSON.stringify(args.home)},
        cwd: ${JSON.stringify(args.cwd)},
        payload: { marker: ${JSON.stringify(args.marker)} },
      });
      process.stdout.write(JSON.stringify({ ok: true, pointer }) + "\\n");
      process.exit(${args.expectFailure ? 2 : 0});
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        name: error instanceof Error ? error.name : typeof error,
      }) + "\\n");
      process.exit(${args.expectFailure ? 0 : 1});
    }
  `;
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
}

test("successful appendSitianRecord publishes one row and removes claim sidecars", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "success-cleans-sidecars";
    const input = {
      level: "event" as const,
      kind: "identity-claim-success-cleanup",
      identity,
      home,
      cwd,
      payload: { marker: "published-clean" },
    };

    const pointer = appendSitianRecord(input);
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);

    assert.equal(pointer.identity, identity);
    assert.equal(pointer.recordFile, recordFile);
    assert.equal(countIdentityRows(recordFile, identity), 1);
    assert.deepEqual(
      volumeSurfaceNames(sessionDir, recordFile),
      [basename(recordFile)],
      "successful publish must not leave permanent claim/recovery sidecars",
    );
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
    childA.stderr!.setEncoding("utf8").on("data", (chunk) => {
      stderrA += chunk;
    });
    childB.stderr!.setEncoding("utf8").on("data", (chunk) => {
      stderrB += chunk;
    });

    const exitA = waitChildExit(childA);
    const exitB = waitChildExit(childB);
    exitA.catch(() => undefined);
    exitB.catch(() => undefined);

    await withPrimaryAwareCleanup(
      async () => {
        while (!existsSync(readyA) || !existsSync(readyB)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        writeFileSync(barrier, "go\n", "utf8");

        const [codeA, codeB] = await Promise.all([exitA, exitB]);
        assert.equal(codeA, 0, `child A failed: ${stderrA}`);
        assert.equal(codeB, 0, `child B failed: ${stderrB}`);

        const { sessionDir, recordFile } = resolveSitianRecordPath({
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
        assert.deepEqual(
          volumeSurfaceNames(sessionDir, recordFile),
          [basename(recordFile)],
        );
      },
      async () => {
        await Promise.all([settleSpawnedChild(childA), settleSpawnedChild(childB)]);
      },
    );
  });
});

test("dead unpublished claim from real append IO failure recovers one row", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "dead-claim-via-io-failure";
    const kind = "identity-claim-dead-via-io";
    const input = {
      level: "event" as const,
      kind,
      identity,
      home,
      cwd,
      payload: { marker: "recovered-after-io-repair" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    poisonCanonicalAppend(recordFile);

    const child = spawnAppendChild({
      home,
      cwd,
      identity,
      kind,
      marker: "recovered-after-io-repair",
      expectFailure: true,
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });

    await withPrimaryAwareCleanup(
      async () => {
        const code = await waitChildExit(child);
        assert.equal(code, 0, `poisoned append child failed unexpectedly: ${stderr}`);
        assert.equal(countIdentityRows(recordFile, identity), 0);

        repairCanonicalAppend(recordFile);
        const pointer = appendSitianRecord(input);

        assert.equal(pointer.identity, identity);
        assert.equal(countIdentityRows(recordFile, identity), 1);
        assert.match(readFileSync(recordFile, "utf8"), /recovered-after-io-repair/);
        assert.deepEqual(
          volumeSurfaceNames(sessionDir, recordFile),
          [basename(recordFile)],
          "recovery success must clear claim/recovery sidecars",
        );
      },
      async () => {
        try {
          repairCanonicalAppend(recordFile);
        } catch {
          // already repaired or absent
        }
        await settleSpawnedChild(child);
      },
    );
  });
});

test("dead claim with dead recovery from real IO failures fails closed", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "dead-claim-dead-recovery-via-io";
    const kind = "identity-claim-dead-recovery-via-io";
    const input = {
      level: "event" as const,
      kind,
      identity,
      home,
      cwd,
      payload: { marker: "should-not-publish" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    poisonCanonicalAppend(recordFile);

    const claimChild = spawnAppendChild({
      home,
      cwd,
      identity,
      kind,
      marker: "should-not-publish",
      expectFailure: true,
    });
    let claimStderr = "";
    claimChild.stderr!.setEncoding("utf8").on("data", (chunk) => {
      claimStderr += chunk;
    });

    await withPrimaryAwareCleanup(
      async () => {
        const claimCode = await waitChildExit(claimChild);
        assert.equal(claimCode, 0, `claim child failed unexpectedly: ${claimStderr}`);
        assert.equal(countIdentityRows(recordFile, identity), 0);

        const recoveryChild = spawnAppendChild({
          home,
          cwd,
          identity,
          kind,
          marker: "should-not-publish",
          expectFailure: true,
        });
        let recoveryStderr = "";
        recoveryChild.stderr!.setEncoding("utf8").on("data", (chunk) => {
          recoveryStderr += chunk;
        });

        await withPrimaryAwareCleanup(
          async () => {
            const recoveryCode = await waitChildExit(recoveryChild);
            assert.equal(
              recoveryCode,
              0,
              `recovery child failed unexpectedly: ${recoveryStderr}`,
            );
            assert.equal(countIdentityRows(recordFile, identity), 0);

            repairCanonicalAppend(recordFile);
            assert.throws(
              () => appendSitianRecord(input),
              (error: unknown) => {
                assert.ok(error instanceof SitianInfrastructureError);
                return true;
              },
            );
            assert.equal(
              countIdentityRows(recordFile, identity),
              0,
              "fail-closed residue must not append a JSONL row",
            );
          },
          async () => {
            await settleSpawnedChild(recoveryChild);
          },
        );
      },
      async () => {
        try {
          repairCanonicalAppend(recordFile);
        } catch {
          // already repaired or absent
        }
        await settleSpawnedChild(claimChild);
      },
    );
  });
});
