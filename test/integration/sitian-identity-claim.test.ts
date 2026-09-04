/**
 * #648 Gatekeeper correction — identity claim uniqueness + recovery.
 * Medium/integration: real appendSitianRecord entry, cross-process concurrency,
 * and dead claim/recovery states produced through controlled real IO failure
 * (no forged SHA/path/claim encoding).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
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

function waitChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code));
  });
}

async function settleSpawnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // already exiting
  }
  await waitChildExit(child).catch(() => undefined);
}

/**
 * Race marker readiness against child exit/error — never poll forever.
 * Always returns so callers can enter cleanup.
 */
async function waitReadyOrChildSettled(
  readyMarker: string,
  child: ChildProcess,
  exitPromise: Promise<number | null>,
): Promise<void> {
  let settledCode: number | null | undefined;
  let settledError: unknown;
  const settled = exitPromise.then(
    (code) => {
      settledCode = code;
      return code;
    },
    (error: unknown) => {
      settledError = error;
      throw error;
    },
  );
  settled.catch(() => undefined);

  while (!existsSync(readyMarker)) {
    if (settledError !== undefined) throw settledError;
    if (
      settledCode !== undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      throw new Error(
        `child settled before ready marker ${readyMarker}: code=${String(
          settledCode ?? child.exitCode,
        )} signal=${String(child.signalCode)}`,
      );
    }
    await Promise.race([
      settled.then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2)),
    ]);
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

function payloadMarkersForIdentity(
  recordFile: string,
  identity: string,
): unknown[] {
  if (!existsSync(recordFile)) return [];
  const markers: unknown[] = [];
  for (const line of readFileSync(recordFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        identity?: unknown;
        payload?: { marker?: unknown };
      };
      if (parsed.identity === identity) markers.push(parsed.payload?.marker);
    } catch {
      // ignore malformed for this counter
    }
  }
  return markers;
}

/** External volume surface: canonical records.jsonl plus any sidecars. */
function volumeSurfaceNames(sessionDir: string, recordFile: string): string[] {
  const base = basename(recordFile);
  return readdirSync(sessionDir)
    .filter((name) => name === base || name.startsWith(`${base}.`))
    .sort();
}

/** Locate claim/recovery residues left by a real failed append (no forged paths). */
function claimResiduePaths(
  sessionDir: string,
  recordFile: string,
): { claimPath?: string; recoveryPath?: string } {
  const base = basename(recordFile);
  const result: { claimPath?: string; recoveryPath?: string } = {};
  for (const name of readdirSync(sessionDir)) {
    if (!name.startsWith(`${base}.`)) continue;
    if (name.endsWith(".recovery")) result.recoveryPath = join(sessionDir, name);
    else result.claimPath = join(sessionDir, name);
  }
  return result;
}

function poisonCanonicalAppend(recordFile: string): void {
  mkdirSync(dirname(recordFile), { recursive: true });
  writeFileSync(recordFile, "", "utf8");
  chmodSync(recordFile, 0o444);
}

function repairCanonicalAppend(recordFile: string): void {
  chmodSync(recordFile, 0o644);
}

type ChildAppendResult =
  | { readonly ok: true; readonly pointer: { identity: string } }
  | { readonly ok: false; readonly name: string; readonly message: string };

function spawnAppendChild(args: {
  readonly home: string;
  readonly cwd: string;
  readonly identity: string;
  readonly kind: string;
  readonly marker: string;
  readonly expectFailure: boolean;
}): ChildProcess {
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
        message: error instanceof Error ? error.message : String(error),
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
    assert.deepEqual(payloadMarkersForIdentity(recordFile, identity), [
      "published-clean",
    ]);
    assert.deepEqual(
      volumeSurfaceNames(sessionDir, recordFile),
      [basename(recordFile)],
      "successful publish must not leave permanent claim/recovery sidecars",
    );
  });
});

test("concurrent same-identity append accepts one row plus typed live contention then idempotent retry", async () => {
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
      try {
        const pointer = appendSitianRecord({
          level: "event",
          kind: ${JSON.stringify(kind)},
          identity: ${JSON.stringify(identity)},
          home: ${JSON.stringify(home)},
          cwd: ${JSON.stringify(cwd)},
          payload: { marker: "concurrent-claim", pid: process.pid },
        });
        process.stdout.write(JSON.stringify({ ok: true, pointer }) + "\\n");
        process.exit(0);
      } catch (error) {
        process.stdout.write(JSON.stringify({
          ok: false,
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        }) + "\\n");
        process.exit(0);
      }
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

    let stdoutA = "";
    let stdoutB = "";
    let stderrA = "";
    let stderrB = "";
    childA.stdout!.setEncoding("utf8").on("data", (chunk) => {
      stdoutA += chunk;
    });
    childB.stdout!.setEncoding("utf8").on("data", (chunk) => {
      stdoutB += chunk;
    });
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
        await Promise.all([
          waitReadyOrChildSettled(readyA, childA, exitA),
          waitReadyOrChildSettled(readyB, childB, exitB),
        ]);
        writeFileSync(barrier, "go\n", "utf8");

        const [codeA, codeB] = await Promise.all([exitA, exitB]);
        assert.equal(codeA, 0, `child A failed: ${stderrA}`);
        assert.equal(codeB, 0, `child B failed: ${stderrB}`);

        const results: ChildAppendResult[] = [stdoutA, stdoutB].map((raw) => {
          const line = raw.trim().split("\n").at(-1);
          assert.ok(line, `missing child stdout JSON: ${raw}`);
          return JSON.parse(line) as ChildAppendResult;
        });

        const successes = results.filter((result) => result.ok);
        const failures = results.filter((result) => !result.ok);
        assert.ok(
          successes.length >= 1,
          `expected at least one committed success: ${JSON.stringify(results)}`,
        );
        for (const failure of failures) {
          assert.equal(failure.name, "SitianInfrastructureError");
          assert.match(
            failure.message,
            /typed live contention/i,
            `unexpected contention failure: ${failure.message}`,
          );
        }

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

        const retry = appendSitianRecord({
          level: "event",
          kind,
          identity,
          home,
          cwd,
          payload: { marker: "concurrent-claim-retry" },
        });
        assert.equal(retry.identity, identity);
        assert.equal(countIdentityRows(recordFile, identity), 1);
        assert.deepEqual(payloadMarkersForIdentity(recordFile, identity), [
          "concurrent-claim",
        ]);
        assert.deepEqual(volumeSurfaceNames(sessionDir, recordFile), [
          basename(recordFile),
        ]);
      },
      async () => {
        await Promise.all([
          settleSpawnedChild(childA),
          settleSpawnedChild(childB),
        ]);
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
        assert.equal(
          code,
          0,
          `poisoned append child failed unexpectedly: ${stderr}`,
        );
        assert.equal(countIdentityRows(recordFile, identity), 0);

        repairCanonicalAppend(recordFile);
        const pointer = appendSitianRecord(input);

        assert.equal(pointer.identity, identity);
        assert.equal(countIdentityRows(recordFile, identity), 1);
        assert.deepEqual(payloadMarkersForIdentity(recordFile, identity), [
          "recovered-after-io-repair",
        ]);
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

test("malformed claim is typed malformed, never labeled disappeared", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "malformed-claim-not-disappeared";
    const kind = "identity-claim-malformed";
    const input = {
      level: "event" as const,
      kind,
      identity,
      home,
      cwd,
      payload: { marker: "should-not-publish-malformed" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    poisonCanonicalAppend(recordFile);

    const child = spawnAppendChild({
      home,
      cwd,
      identity,
      kind,
      marker: "should-not-publish-malformed",
      expectFailure: true,
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });

    await withPrimaryAwareCleanup(
      async () => {
        const code = await waitChildExit(child);
        assert.equal(
          code,
          0,
          `poisoned append child failed unexpectedly: ${stderr}`,
        );
        const { claimPath } = claimResiduePaths(sessionDir, recordFile);
        assert.ok(claimPath, "poisoned append must leave a real claim residue");
        writeFileSync(claimPath, "not-a-claim-body\n", "utf8");

        repairCanonicalAppend(recordFile);
        assert.throws(
          () => appendSitianRecord(input),
          (error: unknown) => {
            assert.ok(error instanceof SitianInfrastructureError);
            assert.match(error.message, /is malformed/i);
            assert.match(error.message, /refusing to treat as disappeared/i);
            assert.doesNotMatch(
              error.message,
              /disappeared without a published canonical row/i,
            );
            return true;
          },
        );
        assert.equal(countIdentityRows(recordFile, identity), 0);
        assert.ok(existsSync(claimPath), "malformed claim must remain in place");
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

test("sidecar cleanup failure after commit throws while preserving the committed row", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "cleanup-failure-keeps-row";
    const kind = "identity-claim-cleanup-failure";
    const input = {
      level: "event" as const,
      kind,
      identity,
      home,
      cwd,
      payload: { marker: "committed-before-cleanup-failure" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    poisonCanonicalAppend(recordFile);

    const child = spawnAppendChild({
      home,
      cwd,
      identity,
      kind,
      marker: "committed-before-cleanup-failure",
      expectFailure: true,
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });

    await withPrimaryAwareCleanup(
      async () => {
        const code = await waitChildExit(child);
        assert.equal(
          code,
          0,
          `poisoned append child failed unexpectedly: ${stderr}`,
        );
        const { claimPath } = claimResiduePaths(sessionDir, recordFile);
        assert.ok(claimPath, "poisoned append must leave a real claim residue");

        const claimBody = readFileSync(claimPath, "utf8");
        const nl = claimBody.indexOf("\n");
        assert.ok(nl > 0, "claim residue must carry write-ahead row");
        const row = claimBody.slice(nl + 1);
        repairCanonicalAppend(recordFile);
        writeFileSync(recordFile, row, "utf8");
        assert.equal(countIdentityRows(recordFile, identity), 1);

        chmodSync(sessionDir, 0o555);
        try {
          assert.throws(
            () => appendSitianRecord(input),
            (error: unknown) => {
              assert.ok(error instanceof SitianInfrastructureError);
              assert.match(
                error.message,
                /could not be released after canonical row/i,
              );
              assert.match(error.message, /was committed/i);
              return true;
            },
          );
        } finally {
          chmodSync(sessionDir, 0o755);
        }

        assert.equal(
          countIdentityRows(recordFile, identity),
          1,
          "cleanup failure must not unwind the committed row",
        );
        assert.deepEqual(payloadMarkersForIdentity(recordFile, identity), [
          "committed-before-cleanup-failure",
        ]);
        assert.ok(
          existsSync(claimPath),
          "failed cleanup must leave visible claim residue",
        );
      },
      async () => {
        try {
          chmodSync(sessionDir, 0o755);
        } catch {
          // already restored
        }
        try {
          repairCanonicalAppend(recordFile);
        } catch {
          // already repaired or absent
        }
        try {
          const { claimPath, recoveryPath } = claimResiduePaths(
            sessionDir,
            recordFile,
          );
          if (claimPath !== undefined) unlinkSync(claimPath);
          if (recoveryPath !== undefined) unlinkSync(recoveryPath);
        } catch {
          // best-effort fixture close
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
        assert.equal(
          claimCode,
          0,
          `claim child failed unexpectedly: ${claimStderr}`,
        );
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
