/**
 * #648 Gatekeeper correction — identity claim uniqueness + recovery.
 * Medium/integration: real appendSitianRecord entry; live contention held at a
 * controlled real IO failure seam; dead claim/recovery via one shared poison
 * fixture (no forged SHA/path/claim encoding; assert typed fields only).
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
import {
  SitianInfrastructureError,
  type SitianInfrastructureFailureDisposition,
  type SitianRecordInput,
} from "../../src/sitian-contracts.ts";
import { readSitianRecords } from "../../src/sitian-reader.ts";
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

/** Race marker readiness against child exit/error — never poll forever. */
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

function volumeSurfaceNames(sessionDir: string, recordFile: string): string[] {
  const base = basename(recordFile);
  return readdirSync(sessionDir)
    .filter((name) => name === base || name.startsWith(`${base}.`))
    .sort();
}

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

function assertFailureDisposition(
  error: unknown,
  disposition: SitianInfrastructureFailureDisposition,
): asserts error is SitianInfrastructureError {
  assert.ok(error instanceof SitianInfrastructureError);
  assert.equal(error.knownCause, "session");
  assert.equal(error.failureDisposition, disposition);
}

function spawnAppendChild(args: {
  readonly home: string;
  readonly cwd: string;
  readonly identity: string;
  readonly kind: string;
  readonly marker: string;
  readonly expectFailure: boolean;
  readonly retryLiveContention?: boolean;
}): ChildProcess {
  const retryLiveContention = args.retryLiveContention === true;
  const script = `
    import { appendSitianRecord } from ${JSON.stringify(join(packageRoot, "src/sitian-appender.ts"))};
    const input = {
      level: "event",
      kind: ${JSON.stringify(args.kind)},
      identity: ${JSON.stringify(args.identity)},
      home: ${JSON.stringify(args.home)},
      cwd: ${JSON.stringify(args.cwd)},
      payload: { marker: ${JSON.stringify(args.marker)} },
    };
    for (;;) {
      try {
        const pointer = appendSitianRecord(input);
        process.stdout.write(JSON.stringify({ ok: true, pointer }) + "\\n");
        process.exit(${args.expectFailure ? 2 : 0});
      } catch (error) {
        const failureDisposition =
          error && typeof error === "object" && "failureDisposition" in error
            ? error.failureDisposition
            : undefined;
        if (${retryLiveContention ? "true" : "false"} && failureDisposition === "live-contention") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          continue;
        }
        process.stdout.write(JSON.stringify({
          ok: false,
          name: error instanceof Error ? error.name : typeof error,
          failureDisposition,
        }) + "\\n");
        process.exit(${args.expectFailure ? 0 : 1});
      }
    }
  `;
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
}


type PoisonedClaimCtx = {
  readonly home: string;
  readonly cwd: string;
  readonly identity: string;
  readonly input: SitianRecordInput;
  readonly sessionDir: string;
  readonly recordFile: string;
  readonly claimPath: string;
  readonly recoveryPath?: string;
};

/**
 * Shared real-IO poison/spawn/repair fixture for dead claim & recovery cases.
 * Cleanup owns every child and always restores writability.
 */
async function withPoisonedIdentityClaim(
  args: {
    readonly identity: string;
    readonly kind: string;
    readonly marker: string;
    readonly extraPoisonedAttempts?: number;
  },
  run: (ctx: PoisonedClaimCtx) => Promise<void>,
): Promise<void> {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const input: SitianRecordInput = {
      level: "event",
      kind: args.kind,
      identity: args.identity,
      home,
      cwd,
      payload: { marker: args.marker },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    poisonCanonicalAppend(recordFile);

    const children: ChildProcess[] = [];
    await withPrimaryAwareCleanup(
      async () => {
        const attempts = 1 + (args.extraPoisonedAttempts ?? 0);
        for (let i = 0; i < attempts; i += 1) {
          const child = spawnAppendChild({
            home,
            cwd,
            identity: args.identity,
            kind: args.kind,
            marker: args.marker,
            expectFailure: true,
          });
          children.push(child);
          let stderr = "";
          child.stderr!.setEncoding("utf8").on("data", (chunk) => {
            stderr += chunk;
          });
          const code = await waitChildExit(child);
          assert.equal(
            code,
            0,
            `poisoned append child ${i} failed unexpectedly: ${stderr}`,
          );
        }

        assert.equal(countIdentityRows(recordFile, args.identity), 0);
        const residues = claimResiduePaths(sessionDir, recordFile);
        assert.ok(residues.claimPath, "poisoned append must leave a claim residue");
        repairCanonicalAppend(recordFile);

        await run({
          home,
          cwd,
          identity: args.identity,
          input,
          sessionDir,
          recordFile,
          claimPath: residues.claimPath,
          ...(residues.recoveryPath !== undefined
            ? { recoveryPath: residues.recoveryPath }
            : {}),
        });
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
        await Promise.all(children.map((child) => settleSpawnedChild(child)));
      },
    );
  });
}

test("successful appendSitianRecord publishes one row and removes claim sidecars", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "success-cleans-sidecars";
    const input: SitianRecordInput = {
      level: "event",
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

test("healthy cross-process concurrent same-identity append yields one readable row without sidecars", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "healthy-concurrent-same-identity";
    const kind = "identity-claim-healthy-concurrent";
    const input: SitianRecordInput = {
      level: "event",
      kind,
      identity,
      home,
      cwd,
      payload: { marker: "parent-observe" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });

    const children = [
      spawnAppendChild({
        home,
        cwd,
        identity,
        kind,
        marker: "child-a",
        expectFailure: false,
        retryLiveContention: true,
      }),
      spawnAppendChild({
        home,
        cwd,
        identity,
        kind,
        marker: "child-b",
        expectFailure: false,
        retryLiveContention: true,
      }),
    ];

    await withPrimaryAwareCleanup(
      async () => {
        const codes = await Promise.all(children.map((child) => waitChildExit(child)));
        assert.deepEqual(codes, [0, 0]);
        assert.equal(countIdentityRows(recordFile, identity), 1);
        const read = await readSitianRecords(recordFile);
        const matching = read.records.filter((row) => row.identity === identity);
        assert.equal(matching.length, 1);
        assert.deepEqual(
          volumeSurfaceNames(sessionDir, recordFile),
          [basename(recordFile)],
          "healthy concurrent publish must not leave claim/recovery sidecars",
        );
      },
      async () => {
        await Promise.all(children.map((child) => settleSpawnedChild(child)));
      },
    );
  });
});

test("live claim at real IO failure seam yields typed live-contention then idempotent retry", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "live-contention-held-claim";
    const kind = "identity-claim-live-contention";
    const input: SitianRecordInput = {
      level: "event",
      kind,
      identity,
      home,
      cwd,
      payload: { marker: "live-holder-writeahead" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    poisonCanonicalAppend(recordFile);

    const readyMarker = join(home, "holder-ready.seam");
    const releaseMarker = join(home, "holder-release.seam");
    const holderScript = `
      import { existsSync, writeFileSync } from "node:fs";
      import { appendSitianRecord } from ${JSON.stringify(join(packageRoot, "src/sitian-appender.ts"))};
      const readyMarker = process.argv[1];
      const releaseMarker = process.argv[2];
      try {
        appendSitianRecord({
          level: "event",
          kind: ${JSON.stringify(kind)},
          identity: ${JSON.stringify(identity)},
          home: ${JSON.stringify(home)},
          cwd: ${JSON.stringify(cwd)},
          payload: { marker: "live-holder-writeahead" },
        });
        process.exit(2);
      } catch {
        writeFileSync(readyMarker, "ready\\n", "utf8");
        while (!existsSync(releaseMarker)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        process.exit(0);
      }
    `;
    const holder = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        holderScript,
        readyMarker,
        releaseMarker,
      ],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let holderStderr = "";
    holder.stderr!.setEncoding("utf8").on("data", (chunk) => {
      holderStderr += chunk;
    });
    const holderExit = waitChildExit(holder);
    holderExit.catch(() => undefined);

    await withPrimaryAwareCleanup(
      async () => {
        await waitReadyOrChildSettled(readyMarker, holder, holderExit);
        assert.equal(countIdentityRows(recordFile, identity), 0);

        assert.throws(
          () => appendSitianRecord(input),
          (error: unknown) => {
            assertFailureDisposition(error, "live-contention");
            return true;
          },
        );
        assert.equal(countIdentityRows(recordFile, identity), 0);

        writeFileSync(releaseMarker, "release\n", "utf8");
        const code = await holderExit;
        assert.equal(code, 0, `holder failed: ${holderStderr}`);

        repairCanonicalAppend(recordFile);
        const pointer = appendSitianRecord({
          ...input,
          payload: { marker: "idempotent-retry" },
        });
        assert.equal(pointer.identity, identity);
        assert.equal(countIdentityRows(recordFile, identity), 1);
        assert.deepEqual(payloadMarkersForIdentity(recordFile, identity), [
          "live-holder-writeahead",
        ]);
        assert.deepEqual(volumeSurfaceNames(sessionDir, recordFile), [
          basename(recordFile),
        ]);
      },
      async () => {
        try {
          writeFileSync(releaseMarker, "release\n", "utf8");
        } catch {
          // best-effort release
        }
        try {
          repairCanonicalAppend(recordFile);
        } catch {
          // already repaired or absent
        }
        await settleSpawnedChild(holder);
      },
    );
  });
});

test("dead unpublished claim from real append IO failure recovers one row", async () => {
  await withPoisonedIdentityClaim(
    {
      identity: "dead-claim-via-io-failure",
      kind: "identity-claim-dead-via-io",
      marker: "recovered-after-io-repair",
    },
    async ({ input, sessionDir, recordFile, identity }) => {
      const pointer = appendSitianRecord(input);
      assert.equal(pointer.identity, identity);
      assert.equal(countIdentityRows(recordFile, identity), 1);
      assert.deepEqual(payloadMarkersForIdentity(recordFile, identity), [
        "recovered-after-io-repair",
      ]);
      assert.deepEqual(volumeSurfaceNames(sessionDir, recordFile), [
        basename(recordFile),
      ]);
    },
  );
});

test("malformed claim is typed malformed-claim, never disappeared", async () => {
  await withPoisonedIdentityClaim(
    {
      identity: "malformed-claim-not-disappeared",
      kind: "identity-claim-malformed",
      marker: "should-not-publish-malformed",
    },
    async ({ input, recordFile, identity, claimPath }) => {
      writeFileSync(claimPath, "not-a-claim-body\n", "utf8");
      assert.throws(
        () => appendSitianRecord(input),
        (error: unknown) => {
          assertFailureDisposition(error, "malformed-claim");
          return true;
        },
      );
      assert.equal(countIdentityRows(recordFile, identity), 0);
      assert.ok(existsSync(claimPath), "malformed claim must remain in place");
    },
  );
});

test("sidecar cleanup failure after commit throws post-commit-cleanup while preserving row", async () => {
  await withPoisonedIdentityClaim(
    {
      identity: "cleanup-failure-keeps-row",
      kind: "identity-claim-cleanup-failure",
      marker: "committed-before-cleanup-failure",
    },
    async ({ input, sessionDir, recordFile, identity, claimPath }) => {
      const claimBody = readFileSync(claimPath, "utf8");
      const nl = claimBody.indexOf("\n");
      assert.ok(nl > 0, "claim residue must carry write-ahead row");
      writeFileSync(recordFile, claimBody.slice(nl + 1), "utf8");
      assert.equal(countIdentityRows(recordFile, identity), 1);

      chmodSync(sessionDir, 0o555);
      try {
        assert.throws(
          () => appendSitianRecord(input),
          (error: unknown) => {
            assertFailureDisposition(error, "post-commit-cleanup");
            return true;
          },
        );
      } finally {
        chmodSync(sessionDir, 0o755);
      }

      assert.equal(countIdentityRows(recordFile, identity), 1);
      assert.deepEqual(payloadMarkersForIdentity(recordFile, identity), [
        "committed-before-cleanup-failure",
      ]);
      assert.ok(existsSync(claimPath), "failed cleanup must leave claim residue");
      try {
        unlinkSync(claimPath);
        const { recoveryPath } = claimResiduePaths(sessionDir, recordFile);
        if (recoveryPath !== undefined) unlinkSync(recoveryPath);
      } catch {
        // best-effort fixture close
      }
    },
  );
});

test("dead claim with dead recovery from real IO failures fails closed as dead-recovery", async () => {
  await withPoisonedIdentityClaim(
    {
      identity: "dead-claim-dead-recovery-via-io",
      kind: "identity-claim-dead-recovery-via-io",
      marker: "should-not-publish",
      extraPoisonedAttempts: 1,
    },
    async ({ input, recordFile, identity }) => {
      assert.throws(
        () => appendSitianRecord(input),
        (error: unknown) => {
          assertFailureDisposition(error, "dead-recovery");
          return true;
        },
      );
      assert.equal(countIdentityRows(recordFile, identity), 0);
    },
  );
});
