/**
 * Owning seam for scripts/run-test-all.mjs — Issue #160 scheduling contract
 * plus #549 HOME redirect negative tracers on the real entry seams.
 * Observes the real runner entry (discovery, child argv, exit honesty) under
 * an isolated cwd/PATH child seam; does not touch production, grace, or Navigator.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import { runTestSubprocess } from "../helpers/test-subprocess.ts";

const RUNNER = resolve(packageRoot, "scripts/run-test-all.mjs");
const PRELOAD = resolve(packageRoot, "scripts/test-process-env-preload.mjs");
const THIS_CONTRACT_REL = "test/integration/run-test-all.test.ts";
const HOST_HOME = userInfo().homedir;

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hostModelsPath(): string {
  return join(HOST_HOME, ".pi", "agent", "models.json");
}

function readHostModelsHash(): string | null {
  const path = hostModelsPath();
  if (!existsSync(path)) return null;
  return sha256(readFileSync(path));
}

/** Exact heavy set — independent expected literals, not runner import (#160; #319 Batch 4 R1 split). */
const TICKET_HEAVYWEIGHT = [
  "test/integration/audit-failure-subprocess.test.ts",
  "test/integration/public-cli-judge-run.test.ts",
  "test/integration/public-cli-judge-engine-detour.test.ts",
  "test/package/package-entrypoint-cold-help.integration.test.ts",
  "test/package/package-entrypoint-navigator.integration.test.ts",
  "test/package/package-entrypoint-observation.integration.test.ts",
  "test/package/package-entrypoint-packaged-workers.integration.test.ts",
  "test/package/doctor-package-lifecycle.test.ts",
  "test/package/public-cli-install.test.ts",
] as const;

type ChildRecord = {
  argv: string[];
  home?: string;
};

async function writePathNodeShim(
  binDir: string,
  options: { signalSelf?: NodeJS.Signals } = {},
): Promise<void> {
  await mkdir(binDir, { recursive: true });
  // Shebang pins the real interpreter so a PATH entry named `node` cannot recurse.
  const signalSelf = options.signalSelf
    ? `process.kill(process.pid, ${JSON.stringify(options.signalSelf)});
// Keep the event loop alive until the signal is delivered.
setInterval(() => {}, 1000);
`
    : `const exits = (process.env.AK_TEST_ALL_CHILD_EXITS ?? "0").split(",").map(Number);
const code = Number.isFinite(exits[n]) ? exits[n] : exits[exits.length - 1] ?? 0;
process.exit(code);
`;
  // Optional #549 AC3 probe: write models.json + sentinel only via $HOME.
  const homeProbe = `
if (process.env.AK_549_HOME_PROBE_SENTINEL && n === 0) {
  const { mkdirSync } = require("node:fs");
  const { dirname, join } = require("node:path");
  const home = process.env.HOME;
  const modelsPath = join(home, ".pi", "agent", "models.json");
  mkdirSync(dirname(modelsPath), { recursive: true });
  writeFileSync(modelsPath, JSON.stringify({ providers: { probe: true } }) + "\\n");
  writeFileSync(join(home, process.env.AK_549_HOME_PROBE_SENTINEL), "fixture-poison-sentinel");
}
`;
  const source = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const recordPath = process.env.AK_TEST_ALL_RECORD;
if (!recordPath) {
  console.error("AK_TEST_ALL_RECORD missing");
  process.exit(2);
}
const counterPath = recordPath + ".count";
const n = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(n + 1));
appendFileSync(
  recordPath,
  JSON.stringify({
    argv: process.argv.slice(1),
    index: n,
    home: process.env.HOME,
  }) + "\\n",
);
${homeProbe}${signalSelf}`;
  await writeFile(join(binDir, "node"), source, "utf8");
  await chmod(join(binDir, "node"), 0o755);
}

async function seedTierTree(root: string, files: string[]): Promise<void> {
  for (const rel of files) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, `// fixture ${rel}\n`, "utf8");
  }
}

function parseRecords(raw: string): ChildRecord[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as {
        argv: string[];
        index: number;
        home?: string;
      };
      const record: ChildRecord = { argv: parsed.argv };
      if (typeof parsed.home === "string") record.home = parsed.home;
      return record;
    });
}

function filesFromArgv(argv: string[]): string[] {
  const files: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) continue;
    const normalized = arg.replaceAll("\\", "/");
    // Shebang launch may put the shim path in argv; only real test files count.
    if (!normalized.endsWith(".test.ts")) continue;
    files.push(normalized);
  }
  return files;
}

function hasConcurrencyTwo(argv: string[]): boolean {
  if (argv.some((arg) => arg === "--test-concurrency=2")) return true;
  const idx = argv.indexOf("--test-concurrency");
  return idx >= 0 && argv[idx + 1] === "2";
}

async function runRunner(options: {
  cwd: string;
  binDir: string;
  recordPath: string;
  childExits?: string;
  extraEnv?: NodeJS.ProcessEnv;
}) {
  await writeFile(options.recordPath, "", "utf8");
  await writeFile(`${options.recordPath}.count`, "0", "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.extraEnv,
    PATH: `${options.binDir}${delimiter}${process.env.PATH ?? ""}`,
    AK_TEST_ALL_RECORD: options.recordPath,
    AK_TEST_ALL_CHILD_EXITS: options.childExits ?? "0",
  };
  // Prevent nested real test execution noise from inheriting flags.
  delete env.NODE_OPTIONS;
  // Ensure no stale test-only hook can influence the runner under test.
  delete env.AK_TEST_ALL_NODE;

  // Host the real runner with the real interpreter; only children resolve `node` via PATH.
  const result = await runTestSubprocess(process.execPath, [RUNNER], {
    cwd: options.cwd,
    env,
    owner: "runRunner",
  });

  const raw = await readFile(options.recordPath, "utf8");
  return { ...result, records: parseRecords(raw) };
}

test("package.json test entries wire HOME redirect preload or run-test-all owner", async () => {
  const pkg = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(
    pkg.scripts["test:all"],
    "node scripts/run-test-all.mjs",
    "test:all must delegate only to the scheduling owner",
  );
  const preload = "--import ./scripts/test-process-env-preload.mjs";
  const bareUnitContract =
    `node --import tsx ${preload} --test test/unit/**/*.test.ts test/contract/**/*.test.ts`;
  assert.equal(pkg.scripts["test"], bareUnitContract);
  assert.equal(pkg.scripts["test:fast"], bareUnitContract);
  assert.equal(
    pkg.scripts["test:integration"],
    `node --import tsx ${preload} --test test/unit/**/*.test.ts test/contract/**/*.test.ts test/integration/**/*.test.ts`,
  );
  assert.equal(
    pkg.scripts["test:adjudication"],
    `node --import tsx ${preload} --test test/adjudication/**/*.test.ts`,
  );
});

/**
 * AC3 (#549): real test:all child seam — fixture writes only via $HOME;
 * host models.json hash unchanged; host sentinel absolute path must not exist.
 */
test("test:all child $HOME writes miss host models.json and host sentinel", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-549-test-all-home-"));
  await withPrimaryAwareCleanup(
    async () => {
      const ordinary = ["test/unit/one.test.ts"];
      const files = [...ordinary, ...TICKET_HEAVYWEIGHT];
      await seedTierTree(workspace, files);

      const binDir = join(workspace, "bin");
      await writePathNodeShim(binDir);
      const recordPath = join(workspace, "records.jsonl");
      const sentinelName = `.ak-549-test-all-sentinel-${process.pid}-${Date.now()}`;
      const beforeHash = readHostModelsHash();
      const hostSentinel = join(HOST_HOME, sentinelName);

      const result = await runRunner({
        cwd: workspace,
        binDir,
        recordPath,
        extraEnv: { AK_549_HOME_PROBE_SENTINEL: sentinelName },
      });

      assert.equal(
        result.code,
        0,
        `stderr=${result.stderr}\nstdout=${result.stdout}`,
      );
      assert.ok(result.records[0]?.home, "child must receive HOME");
      const childHome = result.records[0]!.home!;
      assert.notEqual(childHome, HOST_HOME);

      try {
        assert.equal(
          readHostModelsHash(),
          beforeHash,
          "host ~/.pi/agent/models.json hash must be unchanged",
        );
        assert.equal(
          existsSync(hostSentinel),
          false,
          "host sentinel absolute path must not exist",
        );
        assert.equal(
          readFileSync(join(childHome, sentinelName), "utf8"),
          "fixture-poison-sentinel",
        );
        assert.equal(
          existsSync(join(childHome, ".pi", "agent", "models.json")),
          true,
        );
      } finally {
        // One-shot write residue under the runner child HOME — always rm.
        await rm(join(childHome, sentinelName), { force: true });
        await rm(join(childHome, ".pi"), { recursive: true, force: true });
      }
    },
    async () => {
      await rm(workspace, { recursive: true, force: true });
    },
  );
});

/**
 * AC4 (#549): bare preload entry write proof via process.env.HOME (not run-test-all).
 * Independent of AC3; package.json wiring locked above as exact strings.
 */
test("bare preload entry: $HOME writes miss host models.json and host sentinel", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-549-bare-preload-"));
  await withPrimaryAwareCleanup(
    async () => {
      const beforeHash = readHostModelsHash();
      const sentinelName = `.ak-549-bare-sentinel-${process.pid}-${Date.now()}`;
      const hostSentinel = join(HOST_HOME, sentinelName);
      const probe = join(workspace, "home-redirect-probe.mjs");
      await writeFile(
        probe,
        `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

const hostHome = userInfo().homedir;
const home = process.env.HOME;
assert.ok(home && home !== hostHome, "HOME must be redirected by preload");
assert.equal(process.env.XDG_CONFIG_HOME, join(home, ".config"));
assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);

const sentinelName = process.env.AK_549_SENTINEL_NAME;
const hostSentinel = join(hostHome, sentinelName);
const beforeHash = process.env.AK_549_BEFORE_HASH === "" ? null : process.env.AK_549_BEFORE_HASH;
const hostModels = join(hostHome, ".pi", "agent", "models.json");

const modelsPath = join(home, ".pi", "agent", "models.json");
try {
  mkdirSync(dirname(modelsPath), { recursive: true });
  writeFileSync(modelsPath, JSON.stringify({ providers: { poison: true } }) + "\\n");
  writeFileSync(join(home, sentinelName), "bare-fixture-poison");

  assert.equal(existsSync(hostSentinel), false, "host sentinel must not exist");
  const afterHash = existsSync(hostModels)
    ? createHash("sha256").update(readFileSync(hostModels)).digest("hex")
    : null;
  assert.equal(afterHash, beforeHash);
  assert.equal(readFileSync(join(home, sentinelName), "utf8"), "bare-fixture-poison");
  console.log(JSON.stringify({ ok: true, home, hostHome }));
} finally {
  rmSync(join(home, sentinelName), { force: true });
  rmSync(join(home, ".pi"), { recursive: true, force: true });
}
`,
        "utf8",
      );

      const result = await runTestSubprocess(
        process.execPath,
        ["--import", PRELOAD, probe],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            // Start from host HOME so the preload must do the redirect.
            HOME: HOST_HOME,
            AK_549_SENTINEL_NAME: sentinelName,
            AK_549_BEFORE_HASH: beforeHash ?? "",
          },
          owner: "bare-preload-home-redirect",
          timeoutMs: 15_000,
        },
      );
      assert.equal(
        result.code,
        0,
        `preload probe failed: stderr=${result.stderr}\nstdout=${result.stdout}`,
      );
      assert.equal(
        existsSync(hostSentinel),
        false,
        "host sentinel absolute path must not exist",
      );
      assert.equal(readHostModelsHash(), beforeHash);
    },
    async () => {
      await rm(workspace, { recursive: true, force: true });
    },
  );
});

test("runner partitions discovered universe into ordinary default-parallel then heavy concurrency-2 children", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-run-test-all-partition-"));
  await withPrimaryAwareCleanup(
    async () => {
      const ordinary = [
        "test/unit/one.test.ts",
        "test/contract/two.test.ts",
        "test/integration/light.test.ts",
        "test/package/light.test.ts",
      ];
      const files = [...ordinary, ...TICKET_HEAVYWEIGHT];
      await seedTierTree(workspace, files);

      const binDir = join(workspace, "bin");
      await writePathNodeShim(binDir);
      const recordPath = join(workspace, "records.jsonl");
      const result = await runRunner({
        cwd: workspace,
        binDir,
        recordPath,
      });

      assert.equal(result.code, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
      assert.equal(result.records.length, 2, "exactly two child invocations");

      const [ordinaryChild, heavyChild] = result.records;
      assert.ok(ordinaryChild && heavyChild);

      assert.ok(
        ordinaryChild.argv.includes("--test"),
        "ordinary child is a node --test invocation",
      );
      assert.equal(
        hasConcurrencyTwo(ordinaryChild.argv),
        false,
        "ordinary child must retain default parallelism (no --test-concurrency=2)",
      );
      assert.equal(
        hasConcurrencyTwo(heavyChild.argv),
        true,
        "heavy child must pass --test-concurrency=2",
      );

      const ordinaryFiles = filesFromArgv(ordinaryChild.argv).sort();
      const heavyFiles = filesFromArgv(heavyChild.argv).sort();
      const expectedHeavy = [...TICKET_HEAVYWEIGHT].sort();
      const expectedOrdinary = [...ordinary].sort();

      assert.deepEqual(heavyFiles, expectedHeavy);
      assert.deepEqual(ordinaryFiles, expectedOrdinary);

      const union = new Set([...ordinaryFiles, ...heavyFiles]);
      assert.equal(union.size, files.length, "union covers every discovered file");
      for (const f of ordinaryFiles) {
        assert.equal(
          expectedHeavy.some((h) => h === f),
          false,
          `ordinary ${f} must not reappear in heavy`,
        );
      }
    },
    async () => {
      await rm(workspace, { recursive: true, force: true });
    },
  );
});

test("runner discovers the live package tree as ordinary ⊎ exact heavy manifest, including this contract once", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-run-test-all-live-"));
  await withPrimaryAwareCleanup(
    async () => {
      const binDir = join(workspace, "bin");
      await writePathNodeShim(binDir);
      const recordPath = join(workspace, "records.jsonl");
      const result = await runRunner({
        cwd: packageRoot,
        binDir,
        recordPath,
      });

      assert.equal(result.code, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
      assert.equal(result.records.length, 2);

      const ordinaryFiles = filesFromArgv(result.records[0]!.argv);
      const heavyFiles = filesFromArgv(result.records[1]!.argv);

      assert.equal(hasConcurrencyTwo(result.records[0]!.argv), false);
      assert.equal(hasConcurrencyTwo(result.records[1]!.argv), true);
      assert.deepEqual([...heavyFiles].sort(), [...TICKET_HEAVYWEIGHT].sort());

      const all = [...ordinaryFiles, ...heavyFiles];
      assert.equal(new Set(all).size, all.length, "no file runs twice");
      for (const heavy of TICKET_HEAVYWEIGHT) {
        assert.equal(ordinaryFiles.includes(heavy), false, `${heavy} must leave ordinary`);
        assert.equal(all.filter((f) => f === heavy).length, 1);
      }

      // Owning contract lives in the ordinary tier and executes exactly once via test:all.
      assert.equal(
        ordinaryFiles.filter((f) => f.replaceAll("\\", "/") === THIS_CONTRACT_REL).length,
        1,
        "owning contract must be discovered once in ordinary",
      );

      // Every scheduled path stays inside the ticket's four-tier universe shape.
      for (const file of all) {
        assert.match(
          file.replaceAll("\\", "/"),
          /^test\/(unit|contract|integration|package)\/.+\.test\.ts$/,
        );
      }
      assert.ok(ordinaryFiles.length > 0, "ordinary tier must be non-empty on the live tree");
    },
    async () => {
      await rm(workspace, { recursive: true, force: true });
    },
  );
});

test("runner fails closed on missing manifest entry and does not spawn children", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-run-test-all-missing-"));
  await withPrimaryAwareCleanup(
    async () => {
      // Omit one heavyweight file from the tree.
      const files = [
        "test/unit/one.test.ts",
        TICKET_HEAVYWEIGHT[0],
        TICKET_HEAVYWEIGHT[1],
        // missing TICKET_HEAVYWEIGHT[2]
      ];
      await seedTierTree(workspace, files);
      const binDir = join(workspace, "bin");
      await writePathNodeShim(binDir);
      const recordPath = join(workspace, "records.jsonl");
      const result = await runRunner({
        cwd: workspace,
        binDir,
        recordPath,
      });
      assert.notEqual(result.code, 0, "missing manifest entry must fail");
      assert.equal(result.records.length, 0, "must not spawn test children");
    },
    async () => {
      await rm(workspace, { recursive: true, force: true });
    },
  );
});

test("runner propagates ordinary and heavy child non-zero exits honestly", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-run-test-all-exit-"));
  await withPrimaryAwareCleanup(
    async () => {
      const files = [
        "test/unit/one.test.ts",
        ...TICKET_HEAVYWEIGHT,
      ];
      await seedTierTree(workspace, files);
      const binDir = join(workspace, "bin");
      await writePathNodeShim(binDir);

      // Ordinary fails: fail-fast, no heavy child, exit preserved.
      {
        const recordPath = join(workspace, "ord-fail.jsonl");
        const result = await runRunner({
          cwd: workspace,
          binDir,
          recordPath,
          childExits: "7,0",
        });
        assert.equal(result.code, 7, `ordinary failure must surface; stderr=${result.stderr}`);
        assert.equal(result.records.length, 1, "fail-fast after ordinary non-zero");
        assert.equal(hasConcurrencyTwo(result.records[0]!.argv), false);
      }

      // Ordinary ok, heavy fails: heavy exit preserved.
      {
        const recordPath = join(workspace, "heavy-fail.jsonl");
        const result = await runRunner({
          cwd: workspace,
          binDir,
          recordPath,
          childExits: "0,5",
        });
        assert.equal(result.code, 5, `heavy failure must surface; stderr=${result.stderr}`);
        assert.equal(result.records.length, 2);
        assert.equal(hasConcurrencyTwo(result.records[1]!.argv), true);
      }
    },
    async () => {
      await rm(workspace, { recursive: true, force: true });
    },
  );
});

test("runner preserves child SIGTERM as exit 143 via real PATH-shim seam", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-run-test-all-sigterm-"));
  await withPrimaryAwareCleanup(
    async () => {
      const files = [
        "test/unit/one.test.ts",
        ...TICKET_HEAVYWEIGHT,
      ];
      await seedTierTree(workspace, files);
      const binDir = join(workspace, "bin");
      // Ordinary child self-terminates with SIGTERM; runner must surface 128+15=143.
      await writePathNodeShim(binDir, { signalSelf: "SIGTERM" });
      const recordPath = join(workspace, "sigterm.jsonl");
      const result = await runRunner({
        cwd: workspace,
        binDir,
        recordPath,
      });
      assert.equal(
        result.code,
        143,
        `SIGTERM child must surface as 143, not generic 1; stderr=${result.stderr}`,
      );
      assert.equal(result.records.length, 1, "fail-fast after ordinary SIGTERM");
      assert.equal(hasConcurrencyTwo(result.records[0]!.argv), false);
    },
    async () => {
      await rm(workspace, { recursive: true, force: true });
    },
  );
});
