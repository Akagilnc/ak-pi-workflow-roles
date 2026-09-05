/**
 * Owning seam for scripts/run-test-all.mjs — Issue #160 scheduling contract
 * plus #549 HOME redirect negative tracers on the real entry seams.
 * Observes the real runner entry (discovery, child argv, exit honesty) under
 * an isolated cwd/PATH child seam; does not touch production, grace, or Navigator.
 * #685: heavy partition removed — single default-parallel child only.
 * #685: fixtures only under os.tmpdir(); this file does not delete directories.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";
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

type ChildRecord = {
  argv: string[];
  home?: string;
  /** #549 AC3 probe proof recorded before owning process deletes default HOME (#612). */
  homeProbe?: {
    sentinel: string;
    modelsWritten: boolean;
  };
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
  // Optional #549 AC3 probe: write models.json + sentinel only via $HOME,
  // then carry proof on the record channel. Parent must not read the child
  // HOME after run-test-all exits — #612 deletes that process-owned root.
  const homeProbe = `
let homeProbe;
if (process.env.AK_549_HOME_PROBE_SENTINEL && n === 0) {
  const { mkdirSync } = require("node:fs");
  const { dirname, join } = require("node:path");
  const home = process.env.HOME;
  const modelsPath = join(home, ".pi", "agent", "models.json");
  const sentinelPath = join(home, process.env.AK_549_HOME_PROBE_SENTINEL);
  mkdirSync(dirname(modelsPath), { recursive: true });
  writeFileSync(modelsPath, JSON.stringify({ providers: { probe: true } }) + "\\n");
  writeFileSync(sentinelPath, "fixture-poison-sentinel");
  homeProbe = {
    sentinel: readFileSync(sentinelPath, "utf8"),
    modelsWritten: existsSync(modelsPath),
  };
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
${homeProbe}appendFileSync(
  recordPath,
  JSON.stringify({
    argv: process.argv.slice(1),
    index: n,
    home: process.env.HOME,
    ...(homeProbe ? { homeProbe } : {}),
  }) + "\\n",
);
${signalSelf}`;
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
        homeProbe?: { sentinel: string; modelsWritten: boolean };
      };
      const record: ChildRecord = { argv: parsed.argv };
      if (typeof parsed.home === "string") record.home = parsed.home;
      if (
        parsed.homeProbe &&
        typeof parsed.homeProbe.sentinel === "string" &&
        typeof parsed.homeProbe.modelsWritten === "boolean"
      ) {
        record.homeProbe = parsed.homeProbe;
      }
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
 * Write proof rides the child record channel. #612: run-test-all process-owned
 * default HOME is gone after exit — observed only; this test never rm's paths.
 * Workspace stays under os.tmpdir() (#685 no test directory deletes).
 */
test("test:all child $HOME writes miss host models.json and host sentinel", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-549-test-all-home-"));
  const files = ["test/unit/one.test.ts"];
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

  assert.equal(result.code, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
  assert.equal(result.records.length, 1, "single default-parallel child");
  const child = result.records[0]!;
  assert.ok(child.homeProbe, "child must report HOME probe proof on the record channel");
  assert.equal(child.homeProbe.sentinel, "fixture-poison-sentinel");
  assert.equal(child.homeProbe.modelsWritten, true);
  assert.ok(
    typeof child.home === "string" && child.home.length > 0,
    "child HOME must be set by runner isolation",
  );
  const childHome = child.home!;
  assert.notEqual(childHome, HOST_HOME, "child HOME must not be the host home");
  assert.equal(
    readHostModelsHash(),
    beforeHash,
    "host models.json hash must be unchanged after test:all",
  );
  assert.equal(
    existsSync(hostSentinel),
    false,
    "host sentinel absolute path must not exist",
  );
  // #612: runner default HOME is process-owned — gone after exit.
  // Observe only; this file never deletes directories (tmpdir residue stays).
  assert.equal(
    existsSync(childHome),
    false,
    "run-test-all default test home must be deleted on exit",
  );
});

/**
 * AC4 (#549): bare preload entry write proof via process.env.HOME (not run-test-all).
 * Independent of AC3; package.json wiring locked above as exact strings.
 * Workspace and probe live under os.tmpdir() and are left in place (#685: tests
 * must not delete directories). Preload process-owned HOME exit cleanup is #612
 * runner/preload contract, not this test deleting paths.
 */
test("bare preload entry: $HOME writes miss host models.json and host sentinel", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-549-bare-preload-"));
  const beforeHash = readHostModelsHash();
  const sentinelName = `.ak-549-bare-sentinel-${process.pid}-${Date.now()}`;
  const hostSentinel = join(HOST_HOME, sentinelName);
  const probe = join(workspace, "home-redirect-probe.mjs");
  await writeFile(
    probe,
    `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
});

test("runner discovers seeded tree into one default-parallel child", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-run-test-all-partition-"));
  const files = [
    "test/unit/one.test.ts",
    "test/contract/two.test.ts",
    "test/integration/light.test.ts",
    "test/package/light.test.ts",
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

  assert.equal(result.code, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
  assert.equal(result.records.length, 1, "no heavy partition child");

  const [child] = result.records;
  assert.ok(child);
  assert.ok(child.argv.includes("--test"), "child is a node --test invocation");
  assert.equal(
    hasConcurrencyTwo(child.argv),
    false,
    "child must retain default parallelism (no --test-concurrency=2)",
  );

  const scheduled = filesFromArgv(child.argv).sort();
  assert.deepEqual(scheduled, [...files].sort());
});

test("runner discovers the live package tree once under default parallelism, including this contract", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-run-test-all-live-"));
  const binDir = join(workspace, "bin");
  await writePathNodeShim(binDir);
  const recordPath = join(workspace, "records.jsonl");
  const result = await runRunner({
    cwd: packageRoot,
    binDir,
    recordPath,
  });

  assert.equal(result.code, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
  assert.equal(result.records.length, 1, "single child on live tree");

  const scheduled = filesFromArgv(result.records[0]!.argv);
  assert.equal(hasConcurrencyTwo(result.records[0]!.argv), false);
  assert.equal(new Set(scheduled).size, scheduled.length, "no file runs twice");

  // Owning contract lives in discovery and executes exactly once via test:all.
  assert.equal(
    scheduled.filter((f) => f.replaceAll("\\", "/") === THIS_CONTRACT_REL).length,
    1,
    "owning contract must be discovered once",
  );

  // Every scheduled path stays inside the ticket's four-tier universe shape.
  for (const file of scheduled) {
    assert.match(
      file.replaceAll("\\", "/"),
      /^test\/(unit|contract|integration|package)\/.+\.test\.ts$/,
    );
  }
  assert.ok(scheduled.length > 0, "discovery must be non-empty on the live tree");
});

test("runner propagates child non-zero exits honestly", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-run-test-all-exit-"));
  const files = ["test/unit/one.test.ts", "test/integration/light.test.ts"];
  await seedTierTree(workspace, files);
  const binDir = join(workspace, "bin");
  await writePathNodeShim(binDir);

  const recordPath = join(workspace, "ord-fail.jsonl");
  const result = await runRunner({
    cwd: workspace,
    binDir,
    recordPath,
    childExits: "7",
  });
  assert.equal(result.code, 7, `child failure must surface; stderr=${result.stderr}`);
  assert.equal(result.records.length, 1);
  assert.equal(hasConcurrencyTwo(result.records[0]!.argv), false);
});

test("runner preserves child SIGTERM as exit 143 via real PATH-shim seam", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ak-run-test-all-sigterm-"));
  const files = ["test/unit/one.test.ts"];
  await seedTierTree(workspace, files);
  const binDir = join(workspace, "bin");
  // Child self-terminates with SIGTERM; runner must surface 128+15=143.
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
  assert.equal(result.records.length, 1);
  assert.equal(hasConcurrencyTwo(result.records[0]!.argv), false);
});
