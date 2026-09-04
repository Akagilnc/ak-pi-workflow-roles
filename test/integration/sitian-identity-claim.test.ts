/**
 * #648 — same-identity concurrent writers must not duplicate canonical rows.
 * Cross-platform healthy two-process mainline always runs; optional FIFO
 * overlap forces deterministic claim contention where mkfifo is available.
 * A missing post-claim hold path proves claim cleanup on real IO failure.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  watch,
  writeSync,
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

/**
 * Create a FIFO for the optional contention proof.
 * Skip only Windows or missing mkfifo (spawn ENOENT); other failures throw.
 */
function createFifoOrSkip(
  path: string,
  t: { skip(reason?: string): void },
): boolean {
  if (process.platform === "win32") {
    t.skip("FIFO unsupported on Windows");
    return false;
  }
  try {
    unlinkSync(path);
  } catch {
    // absent is fine
  }
  const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  if (spawnError?.code === "ENOENT") {
    t.skip("mkfifo binary unavailable (ENOENT)");
    return false;
  }
  if (spawnError !== undefined) throw spawnError;
  if (result.status !== 0 || !existsSync(path)) {
    throw new Error(
      `mkfifo failed creating ${path}: status=${String(result.status)} stderr=${result.stderr ?? ""}`,
    );
  }
  return true;
}

/** One writer open/write/close so a blocked FIFO reader reaches EOF. */
function feedFifoEof(path: string): void {
  const fd = openSync(path, fsConstants.O_RDWR);
  try {
    writeSync(fd, "\n");
  } finally {
    closeSync(fd);
  }
}

/** Event-driven claim appearance; races holder exit — no polling. */
function waitForClaimAppearance(args: {
  readonly sessionDir: string;
  readonly recordFile: string;
  readonly holderExit: Promise<number | null>;
}): Promise<"claim" | "holder-exit"> {
  const { sessionDir, recordFile, holderExit } = args;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: "claim" | "holder-exit") => {
      if (settled) return;
      settled = true;
      watcher.close();
      resolve(outcome);
    };
    const hasClaim = () => claimSidecarNames(sessionDir, recordFile).length > 0;
    const watcher = watch(sessionDir, () => {
      if (hasClaim()) finish("claim");
    });
    watcher.on("error", reject);
    holderExit.then(
      () => finish(hasClaim() ? "claim" : "holder-exit"),
      reject,
    );
    if (hasClaim()) finish("claim");
  });
}

type ChildAppendResult =
  | { readonly ok: true; readonly identity: string }
  | {
      readonly ok: false;
      readonly name: "SitianInfrastructureError";
      readonly knownCause: "session";
      readonly code: string;
    };

function spawnAppendChild(args: {
  readonly home: string;
  readonly cwd: string;
  readonly identity: string;
  readonly kind: string;
  readonly marker: string;
  readonly holdPath?: string;
}): ChildProcess {
  const script = `
    import { appendSitianRecord } from ${JSON.stringify(join(packageRoot, "src/sitian-appender.ts"))};
    import { SitianInfrastructureError } from ${JSON.stringify(join(packageRoot, "src/sitian-contracts.ts"))};
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
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (
        error instanceof SitianInfrastructureError &&
        error.knownCause === "session" &&
        typeof code === "string"
      ) {
        process.stdout.write(JSON.stringify({
          ok: false,
          name: "SitianInfrastructureError",
          knownCause: error.knownCause,
          code,
        }) + "\\n");
        process.exit(0);
      }
      process.exit(1);
    }
  `;
  const env =
    args.holdPath === undefined
      ? process.env
      : {
          ...process.env,
          AK_ROLES_TEST_SITIAN_IDENTITY_CLAIM_HOLD: args.holdPath,
        };
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"], env },
  );
}

function parseRecognizedChildResult(raw: string): ChildAppendResult {
  const parsed: unknown = JSON.parse(raw);
  assert.ok(parsed !== null && typeof parsed === "object");
  const record = parsed as Record<string, unknown>;
  if (record.ok === true) {
    assert.equal(typeof record.identity, "string");
    return { ok: true, identity: record.identity as string };
  }
  assert.equal(record.ok, false);
  assert.equal(record.name, "SitianInfrastructureError");
  assert.equal(record.knownCause, "session");
  assert.equal(typeof record.code, "string");
  return {
    ok: false,
    name: "SitianInfrastructureError",
    knownCause: "session",
    code: record.code as string,
  };
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
  assert.equal(
    code,
    0,
    `child must exit normally only with a recognized result; got ${String(code)}: ${stderr}`,
  );
  const line = stdout.trim().split("\n").at(-1);
  assert.ok(line, `child produced no parseable stdout: ${stderr}`);
  return parseRecognizedChildResult(line);
}

test("two concurrent single-call attempts preserve uniqueness: one row, no sidecars", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "concurrent-same-identity-uniqueness";
    const kind = "identity-claim-concurrent-uniqueness";
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
        assert.ok(
          results.some((result) => result.ok),
          "at least one concurrent attempt must succeed",
        );
        for (const result of results) {
          if (result.ok) {
            assert.equal(result.identity, identity);
          } else {
            assert.equal(result.name, "SitianInfrastructureError");
            assert.equal(result.knownCause, "session");
            assert.equal(result.code, "EEXIST");
          }
        }
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

test("FIFO post-claim hold forces deterministic same-identity contention overlap", async (t) => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "fifo-claim-contention-overlap";
    const kind = "identity-claim-fifo-contention";
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

    const holdPath = join(home, "identity-claim-hold.fifo");
    if (!createFifoOrSkip(holdPath, t)) return;

    const holder = spawnAppendChild({
      home,
      cwd,
      identity,
      kind,
      marker: "holder",
      holdPath,
    });
    const holderExit = waitChildExit(holder);
    holderExit.catch(() => undefined);
    const holderResultPromise = readChildResult(holder);

    let contender: ChildProcess | undefined;
    await withPrimaryAwareCleanup(
      async () => {
        const appearance = await waitForClaimAppearance({
          sessionDir,
          recordFile,
          holderExit,
        });
        assert.equal(
          appearance,
          "claim",
          "holder must acquire a real identity claim before the contender runs",
        );
        assert.ok(
          claimSidecarNames(sessionDir, recordFile).length > 0,
          "claim sidecar must be visible on the volume surface while held",
        );

        contender = spawnAppendChild({
          home,
          cwd,
          identity,
          kind,
          marker: "contender",
        });
        const contenderResult = await readChildResult(contender);
        assert.equal(contenderResult.ok, false);
        if (!contenderResult.ok) {
          assert.equal(contenderResult.name, "SitianInfrastructureError");
          assert.equal(contenderResult.knownCause, "session");
          assert.equal(contenderResult.code, "EEXIST");
        }

        feedFifoEof(holdPath);

        const holderResult = await holderResultPromise;
        assert.equal(holderResult.ok, true);
        if (holderResult.ok) {
          assert.equal(holderResult.identity, identity);
        }

        const read = await readSitianRecords(recordFile);
        assert.equal(read.records.filter((row) => row.identity === identity).length, 1);
        assert.deepEqual(volumeSurfaceNames(sessionDir, recordFile), [
          basename(recordFile),
        ]);
      },
      async () => {
        try {
          feedFifoEof(holdPath);
        } catch {
          // hold already drained or absent
        }
        await Promise.all(
          [holder, contender]
            .filter((child): child is ChildProcess => child !== undefined)
            .map((child) => settleSpawnedChild(child)),
        );
        try {
          unlinkSync(holdPath);
        } catch {
          // absent is fine
        }
      },
    );
  });
});

test("missing post-claim hold path cleans identity claim via real IO seam", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "missing-hold-cleans-claim";
    const input: SitianRecordInput = {
      level: "event",
      kind: "identity-claim-missing-hold-cleanup",
      identity,
      home,
      cwd,
      payload: { marker: "should-not-publish" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });

    const holdPath = join(home, "absent-identity-claim-hold");
    const previousHold = process.env.AK_ROLES_TEST_SITIAN_IDENTITY_CLAIM_HOLD;
    process.env.AK_ROLES_TEST_SITIAN_IDENTITY_CLAIM_HOLD = holdPath;
    try {
      assert.throws(
        () => appendSitianRecord(input),
        (error: unknown) => {
          assert.ok(error instanceof SitianInfrastructureError);
          assert.equal(error.knownCause, "session");
          assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
          assert.ok(error.cause instanceof Error);
          assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
          return true;
        },
      );
    } finally {
      if (previousHold === undefined) {
        delete process.env.AK_ROLES_TEST_SITIAN_IDENTITY_CLAIM_HOLD;
      } else {
        process.env.AK_ROLES_TEST_SITIAN_IDENTITY_CLAIM_HOLD = previousHold;
      }
    }

    const read = await readSitianRecords(recordFile);
    assert.equal(read.records.filter((row) => row.identity === identity).length, 0);
    assert.deepEqual(claimSidecarNames(sessionDir, recordFile), []);
  });
});
