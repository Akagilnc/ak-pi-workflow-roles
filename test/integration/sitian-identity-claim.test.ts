/**
 * #648 Gatekeeper correction — minimal exclusive identity claim.
 * Medium/integration: real appendSitianRecord entry. Healthy children call
 * append exactly once (no test-side retry/poll). Assert typed results, exactly
 * one parsed canonical row, and no normal claim sidecar residue. At most one
 * failure-path proof that a throwing append cleans its own identity claim.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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


type ChildAppendResult =
  | { readonly ok: true; readonly identity: string }
  | {
      readonly ok: false;
      readonly name: string;
      readonly failureDisposition?: string;
    };

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
      const pointer = appendSitianRecord({
        level: "event",
        kind: ${JSON.stringify(args.kind)},
        identity: ${JSON.stringify(args.identity)},
        home: ${JSON.stringify(args.home)},
        cwd: ${JSON.stringify(args.cwd)},
        payload: { marker: ${JSON.stringify(args.marker)} },
      });
      process.stdout.write(JSON.stringify({ ok: true, identity: pointer.identity }) + "\\n");
      process.exit(0);
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        name: error instanceof Error ? error.name : typeof error,
        failureDisposition:
          error && typeof error === "object" && "failureDisposition" in error
            ? error.failureDisposition
            : undefined,
      }) + "\\n");
      process.exit(0);
    }
  `;
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function readChildResult(child: ChildProcess): Promise<ChildAppendResult> {
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr!.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await waitChildExit(child);
  assert.equal(code, 0, `child exited ${String(code)}: ${stderr}`);
  const line = stdout.trim().split("\n").at(-1);
  assert.ok(line, `child produced no stdout: ${stderr}`);
  return JSON.parse(line) as ChildAppendResult;
}

test("successful appendSitianRecord publishes one row and removes claim sidecar", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "success-cleans-claim";
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
    const read = await readSitianRecords(recordFile);
    assert.equal(read.records.filter((row) => row.identity === identity).length, 1);
    assert.deepEqual(
      volumeSurfaceNames(sessionDir, recordFile),
      [basename(recordFile)],
      "successful publish must not leave claim sidecars",
    );
  });
});

test("healthy cross-process concurrent same-identity append: one call each, one row, typed results, no sidecars", async () => {
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
        const results = await Promise.all(children.map((child) => readChildResult(child)));
        for (const result of results) {
          if (result.ok) {
            assert.equal(result.identity, identity);
          } else {
            assert.equal(result.name, "SitianInfrastructureError");
            assert.equal(result.failureDisposition, "contention");
          }
        }
        assert.ok(
          results.some((result) => result.ok),
          "at least one healthy child must publish",
        );
        assert.equal(countIdentityRows(recordFile, identity), 1);
        const read = await readSitianRecords(recordFile);
        assert.equal(read.records.filter((row) => row.identity === identity).length, 1);
        assert.deepEqual(
          volumeSurfaceNames(sessionDir, recordFile),
          [basename(recordFile)],
          "healthy concurrent publish must not leave claim sidecars",
        );
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

    assert.equal(countIdentityRows(recordFile, identity), 0);
    assert.deepEqual(
      claimSidecarNames(sessionDir, recordFile),
      [],
      "throwing append must release its own identity claim",
    );
  });
});
