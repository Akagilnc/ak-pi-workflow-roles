/**
 * #648 — same-identity concurrent writers must not duplicate canonical rows.
 * One platform-neutral two-process mainline: real appendSitianRecord entry →
 * unique canonical volume row.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  resolveSitianRecordPath,
} from "../../src/sitian-appender.ts";
import {
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
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env },
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
