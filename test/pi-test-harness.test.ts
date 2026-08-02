import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  packageRoot,
  packIsolatedPackage,
  withHermeticHome,
} from "./helpers/pi-test-harness.ts";

test("hermetic HOME restores the exact prior value and recursively cleans up after a throw", async () => {
  const originalHome = process.env.HOME;
  const priorHome = "/preserved/home/value";
  const sentinel = { reason: "callback sentinel" };
  let allocatedHome: string | undefined;

  process.env.HOME = priorHome;
  try {
    await assert.rejects(
      withHermeticHome({ prefix: "ak-harness-cleanup-" }, async ({ home }) => {
        allocatedHome = home;
        assert.equal(process.env.HOME, home);
        await mkdir(resolve(home, "nested", "tree"), { recursive: true });
        await writeFile(
          resolve(home, "nested", "tree", "evidence.txt"),
          "evidence",
        );
        throw sentinel;
      }),
      (error) => {
        assert.equal(error, sentinel);
        return true;
      },
    );
    assert.equal(process.env.HOME, priorHome);
    assert.ok(allocatedHome);
    await assert.rejects(access(allocatedHome), { code: "ENOENT" });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

interface DistSnapshotEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

type DistSnapshot = Map<string, DistSnapshotEntry>;

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) stack.push(full);
      else if (name.isFile() || name.isSymbolicLink()) out.push(full);
    }
  }
  return out.sort();
}

async function snapshotDistTree(distRoot: string): Promise<DistSnapshot> {
  const snapshot: DistSnapshot = new Map();
  for (const full of walkFiles(distRoot)) {
    const rel = relative(distRoot, full).split("\\").join("/");
    const st = statSync(full);
    const body = await readFile(full);
    snapshot.set(rel, {
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  }
  return snapshot;
}

function assertDistSnapshotUnchanged(
  before: DistSnapshot,
  after: DistSnapshot,
): void {
  assert.deepEqual(
    [...after.keys()],
    [...before.keys()],
    "shared dist inventory must be unchanged by isolated packs",
  );
  for (const [rel, prior] of before) {
    const next = after.get(rel);
    assert.ok(next, `missing shared dist entry after packs: ${rel}`);
    assert.deepEqual(
      next,
      prior,
      `shared dist entry mutated during isolated packs: ${rel}`,
    );
  }
}

async function exerciseSharedPackageContracts(): Promise<void> {
  // Previously-failing chain: terminating-tools imports judge-output from shared dist.
  const terminatingUrl = pathToFileURL(
    resolve(packageRoot, "dist/package-contracts/terminating-tools.js"),
  ).href;
  // Cache-bust so each iteration re-reads from disk (race class is partial rewrite).
  const mod = await import(`${terminatingUrl}?t=${Date.now()}-${Math.random()}`);
  assert.equal(typeof mod.isTerminatingToolName, "function");
  assert.equal(typeof mod.acceptedTextFor, "function");
  assert.equal(typeof mod.validateAcceptedDetails, "function");
  assert.equal(mod.isTerminatingToolName(mod.JUDGE_OUTPUT_TOOL_NAME), true);
  assert.equal(
    mod.acceptedTextFor(mod.JUDGE_OUTPUT_TOOL_NAME),
    mod.JUDGE_ACCEPTED_TEXT,
  );
  // Touch judge-output leaf through the same graph.
  const judgeUrl = pathToFileURL(
    resolve(packageRoot, "dist/package-contracts/judge-output.js"),
  ).href;
  const judge = await import(`${judgeUrl}?t=${Date.now()}-${Math.random()}`);
  assert.equal(judge.JUDGE_OUTPUT_TOOL_NAME, mod.JUDGE_OUTPUT_TOOL_NAME);
  assert.equal(typeof judge.validateAcceptedJudgeDetails, "function");
}

test("isolated packs leave shared dist identity stable under concurrent contract imports", async () => {
  await withHermeticHome(
    { prefix: "ak-pack-isolation-stress-" },
    async ({ home }) => {
      const distRoot = resolve(packageRoot, "dist");
      const before = await snapshotDistTree(distRoot);
      assert.ok(
        before.has("package-contracts/terminating-tools.js"),
        "shared terminating-tools.js must exist before stress",
      );
      assert.ok(
        before.has("package-contracts/judge-output.js"),
        "shared judge-output.js must exist before stress",
      );

      const packCount = 3;
      const importRounds = 24;
      let stopImports = false;

      const packPromises = Array.from({ length: packCount }, async (_, i) => {
        const dest = resolve(home, `pack-${i}`);
        await mkdir(dest, { recursive: true });
        const packed = await packIsolatedPackage(dest);
        const paths = packed.files.map((file) => file.path);
        assert.ok(paths.includes("dist/package-contracts/terminating-tools.js"));
        assert.ok(paths.includes("dist/package-contracts/judge-output.js"));
        assert.ok(paths.includes("bin/ak-assisted-run.js"));
        assert.ok(!paths.some((path) => path.includes("recorder")));
        return packed;
      });

      const importPromise = (async () => {
        for (let i = 0; i < importRounds && !stopImports; i++) {
          await exerciseSharedPackageContracts();
        }
      })();

      const packs = await Promise.all(packPromises);
      stopImports = true;
      await importPromise;

      assert.equal(packs.length, packCount);
      for (const packed of packs) {
        assert.notEqual(
          packed.root,
          packageRoot,
          "pack materialization must not be packageRoot",
        );
        await access(packed.tarball);
      }

      // Keep reading the shared chain after packs complete.
      for (let i = 0; i < 8; i++) {
        await exerciseSharedPackageContracts();
      }

      const after = await snapshotDistTree(distRoot);
      assertDistSnapshotUnchanged(before, after);
    },
  );
});
