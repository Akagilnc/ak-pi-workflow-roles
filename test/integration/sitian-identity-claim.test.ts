/**
 * #648 — same-identity concurrent writers must not duplicate canonical rows.
 * One healthy two-process, one-call-each real-entry mainline; one real-IO
 * failure path that proves the thrower releases its own identity claim.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  appendSitianRecord,
  resolveSitianRecordPath,
} from "../../src/sitian-appender.ts";
import {
  SitianInfrastructureError,
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

function volumeSurfaceNames(sessionDir: string, recordFile: string): string[] {
  const base = basename(recordFile);
  return readdirSync(sessionDir)
    .filter((name) => name === base || name.startsWith(`${base}.`))
    .sort();
}

function claimSidecarNames(sessionDir: string, recordFile: string): string[] {
  const base = basename(recordFile);
  return readdirSync(sessionDir)
    .filter((name) => name.startsWith(`${base}.`))
    .sort();
}

function spawnAppendChild(args: {
  readonly home: string;
  readonly cwd: string;
  readonly identity: string;
  readonly kind: string;
  readonly marker: string;
}): ChildProcess {
  const script = `
    import { appendSitianRecord } from ${JSON.stringify(join(packageRoot, "src/sitian-appender.ts"))};
    try {
      appendSitianRecord({
        level: "event",
        kind: ${JSON.stringify(args.kind)},
        identity: ${JSON.stringify(args.identity)},
        home: ${JSON.stringify(args.home)},
        cwd: ${JSON.stringify(args.cwd)},
        payload: { marker: ${JSON.stringify(args.marker)} },
      });
      process.exit(0);
    } catch {
      process.exit(0);
    }
  `;
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] },
  );
}

test("healthy cross-process concurrent same-identity append: one call each, one row, no sidecars", async () => {
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
      spawnAppendChild({ home, cwd, identity, kind, marker: "child-a" }),
      spawnAppendChild({ home, cwd, identity, kind, marker: "child-b" }),
    ];

    await withPrimaryAwareCleanup(
      async () => {
        await Promise.all(children.map((child) => waitChildExit(child)));
        const read = await readSitianRecords(recordFile);
        assert.equal(read.records.filter((row) => row.identity === identity).length, 1);
        assert.deepEqual(volumeSurfaceNames(sessionDir, recordFile), [
          basename(recordFile),
        ]);
      },
      async () => {
        await Promise.all(children.map((child) => settleSpawnedChild(child)));
      },
    );
  });
});

test("throwing append cleans its own identity claim via real IO seam", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "throwing-append-cleans-claim";
    const input: SitianRecordInput = {
      level: "event",
      kind: "identity-claim-throw-cleanup",
      identity,
      home,
      cwd,
      payload: { marker: "should-not-publish" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(recordFile, "", "utf8");
    chmodSync(recordFile, 0o444);

    try {
      assert.throws(
        () => appendSitianRecord(input),
        (error: unknown) => {
          assert.ok(error instanceof SitianInfrastructureError);
          assert.equal(error.knownCause, "session");
          return true;
        },
      );
    } finally {
      chmodSync(recordFile, 0o644);
    }

    const read = await readSitianRecords(recordFile);
    assert.equal(read.records.filter((row) => row.identity === identity).length, 0);
    assert.deepEqual(claimSidecarNames(sessionDir, recordFile), []);
  });
});
