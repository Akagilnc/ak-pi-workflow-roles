import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { bindProductionGrokIsolation } from "../../src/grok/production-host.ts";
import { prepareGrokRoleEnvelope } from "../../src/grok/role-envelope.ts";
import { createGrokRoleTurnHost } from "../../src/grok/role-turn-host.ts";
import { createPiRoleTurnHost } from "../../src/pi/role-turn-host.ts";
import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import type { DurablePrincipalAuthority } from "../../src/host-contracts.ts";
import {
  issuePiDurablePrincipalCoordinates,
  piDurablePrincipalAuthority,
} from "../../src/pi/durable-principal.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { loadPublicCliConfig, publicCliConfigPath } from "../../src/public-cli/config.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot, withHermeticHome } from "../helpers/pi-test-harness.ts";
import {
  argvFlagValue,
  createMinimalHost,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

const execFileAsync = promisify(execFile);
const stoppedHost: RoleTurnHost = { executeTurn: async () => ({ code: 1, stderr: "stop", timedOut: false }) };
const io = { stdout() {}, stderr() {} };
const credentials = { "openai-codex": true, xai: true } as const;

function adapter(name: string, selected: string[], accepts = true): NamedRoleTurnHostAdapter {
  return {
    name,
    create() {
      if (!accepts) return { ok: false };
      selected.push(name);
      return { ok: true, host: stoppedHost };
    },
  };
}

async function homeTest(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "ak-host-axis-"));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

const base = (home: string, adapters: readonly NamedRoleTurnHostAdapter[]) => ({ packageRoot, home, credentials, io, hostAdapters: adapters });

async function configureJudge(home: string, host?: string) {
  await runAkRole(["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"], base(home, []));
  if (host !== undefined) await runAkRole(["config", "set-host", "judge", host], base(home, []));
}

test("host priority and pi equivalence run through the public call entry", async () => homeTest(async (home) => {
  const selected: string[] = [];
  const adapters = [adapter("pi", selected), adapter("grok-build", selected)];

  await configureJudge(home);
  await runAkRole(["judge", "default"], base(home, adapters));
  await runAkRole(["judge", "--host", "pi", "explicit"], base(home, adapters));
  await runAkRole(["config", "set-host", "judge", "grok-build"], base(home, adapters));
  await runAkRole(["judge", "persistent"], base(home, adapters));
  await runAkRole(["judge", "--host", "pi", "flag"], base(home, adapters));

  assert.deepEqual(selected, ["pi", "pi", "grok-build", "pi"]);
}));

test("host selection failures are canonical and stop before role turn", async () => homeTest(async (home) => {
  let turnCalls = 0;
  const countingHost: RoleTurnHost = {
    executeTurn: async () => {
      turnCalls++;
      throw new Error("host selection failure must stop before executeTurn");
    },
  };
  const pi: NamedRoleTurnHostAdapter = { name: "pi", create() { return { ok: true, host: countingHost }; } };
  const missing = await runAkRole(["judge", "--host", "missing", "x"], base(home, [pi]));
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(missing.hostFailure, {
    kind: "host-unregistered",
    host: "missing",
    seat: "judge",
    model: "openai-codex/gpt-5.6-sol",
    registeredHosts: ["pi"],
  });
  assert.equal(turnCalls, 0);

  const mismatch = await runAkRole(["judge", "--host", "grok-build", "x"], base(home, [pi, adapter("grok-build", [], false)]));
  assert.equal(mismatch.exitCode, 1);
  assert.deepEqual(mismatch.hostFailure, {
    kind: "host-model-mismatch",
    host: "grok-build",
    seat: "judge",
    model: "openai-codex/gpt-5.6-sol",
    registeredHosts: ["pi", "grok-build"],
  });
  assert.equal(turnCalls, 0);
}));

test("host flags and persistent config reject seats without a public call path", async () => homeTest(async (home) => {
  const flag = await runAkRole(["roles", "--host", "pi"], base(home, [adapter("pi", [])]));
  assert.equal(flag.exitCode, 2);

  const command = await runAkRole(["config", "set-host", "navigator", "pi"], base(home, []));
  assert.equal(command.exitCode, 2);

  await runAkRole(["config", "set", "navigator", "openai-codex/gpt-5.6-sol:high"], base(home, []));
  await writeFile(publicCliConfigPath(home), JSON.stringify({
    seats: { navigator: { provider: "openai-codex", model: "gpt-5.6-sol", host: "pi" } },
  }));
  const disk = await runAkRole(["config", "show"], base(home, []));
  assert.equal(disk.exitCode, 2);
}));

test("notary model clear preserves independent host and engine residual axes", async () => homeTest(async (home) => {
  const env = base(home, []);
  await runAkRole(["config", "set", "notary", "openai-codex/gpt-5.6-sol:high"], env);
  await runAkRole(["config", "set-host", "notary", "grok-build"], env);
  await runAkRole(["config", "set-engine", "notary", "cc"], env);
  await runAkRole(["config", "unset", "notary"], env);
  assert.deepEqual((await loadPublicCliConfig(home)).seats.notary, { host: "grok-build", engine: "cc" });

  await runAkRole(["config", "unset-engine", "notary"], env);
  assert.deepEqual((await loadPublicCliConfig(home)).seats.notary, { host: "grok-build" });
  await runAkRole(["config", "set-engine", "notary", "cc"], env);
  await runAkRole(["config", "unset-host", "notary"], env);
  assert.deepEqual((await loadPublicCliConfig(home)).seats.notary, { engine: "cc" });
  await runAkRole(["config", "unset-engine", "notary"], env);
  assert.equal((await loadPublicCliConfig(home)).seats.notary, undefined);
}));

// #522 host/engine independence + #568 public Inspector: same residual contract as notary.
test("inspector model clear preserves independent host and engine residual axes", async () => homeTest(async (home) => {
  const env = base(home, []);
  await runAkRole(["config", "set", "inspector", "xai/grok-4.5"], env);
  await runAkRole(["config", "set-host", "inspector", "grok-build"], env);
  await runAkRole(["config", "set-engine", "inspector", "cc"], env);
  await runAkRole(["config", "unset", "inspector"], env);
  assert.deepEqual((await loadPublicCliConfig(home)).seats.inspector, {
    host: "grok-build",
    engine: "cc",
  });

  await runAkRole(["config", "unset-engine", "inspector"], env);
  assert.deepEqual((await loadPublicCliConfig(home)).seats.inspector, { host: "grok-build" });
  await runAkRole(["config", "set-engine", "inspector", "cc"], env);
  await runAkRole(["config", "unset-host", "inspector"], env);
  assert.deepEqual((await loadPublicCliConfig(home)).seats.inspector, { engine: "cc" });
  await runAkRole(["config", "unset-engine", "inspector"], env);
  assert.equal((await loadPublicCliConfig(home)).seats.inspector, undefined);
}));

test("resume accepts --host and selects that host adapter", async () => {
  await withHermeticHome({ prefix: "ak-resume-host-flag-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-resume-host-flag";
    await seedResumableJudge({ home, project, runId });

    const selected: string[] = [];
    const { io } = captureIo();
    await runAkRole(["resume", "--host", "grok-build", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials,
      io,
      principalAuthority: piDurablePrincipalAuthority,
      hostAdapters: [adapter("pi", selected), adapter("grok-build", selected)],
    });
    assert.deepEqual(selected, ["grok-build"], "resume --host must select the flagged host");
  });
});

/** Production composition root (no hostAdapters injection) — #580 / #522 merge precondition. */
const productionBase = (home: string, roleTurnHost?: RoleTurnHost) => ({
  packageRoot,
  home,
  credentials,
  io,
  ...(roleTurnHost === undefined ? {} : { roleTurnHost }),
});

test("production adapter table registers grok-build and keeps pi selectable", async () => homeTest(async (home) => {
  let piTurns = 0;
  const countingPi: RoleTurnHost = {
    executeTurn: async () => {
      piTurns += 1;
      return { code: 1, stderr: "stop-after-selection", timedOut: false };
    },
  };

  await runAkRole(["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"], productionBase(home));

  // Default host remains pi (zero drift); injectable roleTurnHost still backs the pi adapter.
  const defaultPi = await runAkRole(["judge", "default"], productionBase(home, countingPi));
  assert.equal(defaultPi.hostFailure, undefined);
  assert.equal(piTurns, 1);
  assert.equal(defaultPi.exitCode, 1);

  // Explicit pi still selects the pi adapter.
  const explicitPi = await runAkRole(["judge", "--host", "pi", "explicit"], productionBase(home, countingPi));
  assert.equal(explicitPi.hostFailure, undefined);
  assert.equal(piTurns, 2);

  // Unregistered name still fails without fallback; production table lists both hosts as typed fields.
  const missing = await runAkRole(["judge", "--host", "missing", "x"], productionBase(home, countingPi));
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(missing.hostFailure, {
    kind: "host-unregistered",
    host: "missing",
    seat: "judge",
    model: "openai-codex/gpt-5.6-sol",
    registeredHosts: ["pi", "grok-build"],
  });
  assert.equal(piTurns, 2);
}));

test("grok-build selection and execution have no provider restriction", async () => homeTest(async (home) => {
  // Lowest real public-call adapter seam: injected grok-build host actually runs.
  // Live production Grok is #590 acceptance, not this regression.
  for (const spec of ["openai-codex/gpt-5.6-sol:high", "xai/grok-4.6:high"] as const) {
    let piTurns = 0;
    let grokTurns = 0;
    const grokProviders: Array<string | undefined> = [];
    const grokHost: RoleTurnHost = {
      executeTurn: async (request) => {
        grokTurns += 1;
        grokProviders.push(request.model?.provider);
        return { code: 1, stderr: "grok-stub-stop", timedOut: false };
      },
    };
    const adapters: NamedRoleTurnHostAdapter[] = [
      {
        name: "pi",
        create() {
          return {
            ok: true,
            host: {
              executeTurn: async () => {
                piTurns += 1;
                throw new Error("pi adapter must not run when grok-build is selected");
              },
            },
          };
        },
      },
      { name: "grok-build", create: () => ({ ok: true, host: grokHost }) },
    ];
    await configureJudge(home);
    await runAkRole(["config", "set", "judge", spec], base(home, []));
    const result = await runAkRole(["judge", "--host", "grok-build", "x"], base(home, adapters));
    assert.equal(result.hostFailure, undefined, spec);
    assert.equal(result.exitCode, 1, spec);
    assert.equal(piTurns, 0, spec);
    assert.equal(grokTurns, 1, spec);
    assert.equal(grokProviders[0], spec.split("/")[0], spec);
  }
}));

/** #595: birth host is a typed invocation field at admission. */
test("admission writes typed birth host onto invocation.json", async () => homeTest(async (home) => {
  const selected: string[] = [];
  await configureJudge(home, "grok-build");
  await runAkRole(
    ["judge", "record-birth-host"],
    base(home, [adapter("pi", selected), adapter("grok-build", selected)]),
  );
  assert.deepEqual(selected, ["grok-build"]);

  const booksRoot = join(home, ".ak-roles", "books");
  const books = await readdir(booksRoot);
  assert.ok(books.length >= 1);
  const runsRoot = join(booksRoot, books[0]!, "runs");
  const runs = await readdir(runsRoot);
  assert.equal(runs.length, 1);
  const invocation = JSON.parse(
    await readFile(join(runsRoot, runs[0]!, "invocation.json"), "utf8"),
  ) as { host?: unknown };
  assert.equal(invocation.host, "grok-build");
}));

/** Seed a resumable judge run; optional post-write mutates the durable pages. */
async function seedResumableJudge(input: {
  home: string;
  project: string;
  runId: string;
  hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  principalAuthority?: DurablePrincipalAuthority;
  afterTurn?: (runDirectory: string, sessionDirectory: string) => Promise<void>;
}): Promise<void> {
  const { io } = captureIo();
  const principalAuthority = input.principalAuthority ?? piDurablePrincipalAuthority;
  await runAkRole(["judge", `seed-${input.runId}`], {
    packageRoot,
    home: input.home,
    cwd: input.project,
    credentials,
    createRunId: () => input.runId,
    io,
    principalAuthority,
    hostAdapters: input.hostAdapters ?? [
      {
        name: "pi",
        create: () => ({
          ok: true as const,
          host: createMinimalHost(async (request) => {
            const { sessionDirectory, sessionFile } =
              piDurablePrincipalAuthority.decode(request.principal);
            await mkdir(sessionDirectory, { recursive: true });
            await writeFile(sessionFile, "", "utf8");
            await observeTyped429ViaProductionHandler({
              runDirectory: request.runDirectory,
              provider: "openai-codex",
            });
            if (input.afterTurn !== undefined) {
              await input.afterTurn(request.runDirectory, sessionDirectory);
            }
            return { code: 1, stderr: "quota", timedOut: false };
          }),
        }),
      },
    ],
  });
}

/** #617 DK-3: bare resume follows the live seat table host, not birth host. */
test("bare resume follows live seat table host when it drifts from birth host", async () => {
  await withHermeticHome({ prefix: "ak-seat-host-resume-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-birth-host-pi";

    await seedResumableJudge({ home, project, runId });

    const books = await readdir(join(home, ".ak-roles", "books"));
    const invPath = join(
      home,
      ".ak-roles",
      "books",
      books[0]!,
      "runs",
      `${runId}@judge`,
      "invocation.json",
    );
    const inv = JSON.parse(await readFile(invPath, "utf8")) as { host?: unknown };
    assert.equal(inv.host, "pi");

    {
      const { io, stderr } = captureIo();
      // set-host requires a persistent model row first.
      const setModel = await runAkRole(
        ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
        { packageRoot, home, io },
      );
      assert.equal(setModel.exitCode, 0, stderr.join(""));
      const setHost = await runAkRole(
        ["config", "set-host", "judge", "grok-build"],
        { packageRoot, home, io },
      );
      assert.equal(setHost.exitCode, 0, stderr.join(""));
    }

    // Contract under test: which host adapter resume selects — not terminal success.
    const selected: string[] = [];
    const { io } = captureIo();
    await runAkRole(["resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials,
      io,
      principalAuthority: piDurablePrincipalAuthority,
      hostAdapters: [adapter("pi", selected), adapter("grok-build", selected)],
    });
    assert.deepEqual(
      selected,
      ["grok-build"],
      "bare resume must follow seat table grok-build despite birth host pi",
    );

    const after = JSON.parse(await readFile(invPath, "utf8")) as { host?: unknown };
    assert.equal(after.host, "grok-build", "resume must record the live seat host on invocation");
  });
});

function sessionRowsWithoutAttemptHistory(raw: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as { type?: unknown; customType?: unknown };
    if (entry.type === "custom" && entry.customType === "ak_run_attempt_history") continue;
    rows.push(entry);
  }
  return rows;
}

async function presentGrokUpdates(grokHome: string): Promise<string[]> {
  const sessions = join(grokHome, "sessions");
  const found: string[] = [];
  let encoded;
  try {
    encoded = await readdir(sessions, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
    throw error;
  }
  for (const cwdEntry of encoded) {
    if (!cwdEntry.isDirectory()) continue;
    const sessionDirs = await readdir(join(sessions, cwdEntry.name), { withFileTypes: true });
    for (const sess of sessionDirs) {
      if (!sess.isDirectory()) continue;
      const file = join(sessions, cwdEntry.name, sess.name, "updates.jsonl");
      try {
        found.push(await readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return found;
}

const FAUX_GROK_WRITE = `import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const grokHome = process.env.GROK_HOME;
if (typeof grokHome !== "string" || grokHome === "") throw new Error("GROK_HOME missing");
const file = join(grokHome, "sessions", "cwd", "s1", "updates.jsonl");
await mkdir(join(file, ".."), { recursive: true });
await writeFile(file, JSON.stringify({ sessionUpdate: "agent_message_chunk" }) + "\\n");
`;

const FAUX_PI_APPEND = `import { appendFile } from "node:fs/promises";
const sessionFile = process.argv[2];
if (typeof sessionFile !== "string" || sessionFile === "") throw new Error("session file missing");
await appendFile(sessionFile, JSON.stringify({ type: "message" }) + "\\n");
`;

test("public resume Pi→Grok writes grok-home via isolation env; Pi volume unchanged", async () => {
  await withHermeticHome({ prefix: "ak-dk4-pi-to-grok-" }, async ({ home }) => {
    const priorExitCode = process.exitCode;
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const runId = "run-dk4-pi-to-grok";
      const PI_SESSION_SEED =
        `${JSON.stringify({ type: "session", id: runId })}\n`
        + `${JSON.stringify({ type: "message", id: "m1" })}\n`;
      const HOST_ISSUED_SESSION_LEAF = "host-issued-principal.jsonl";
      const hostIssuedPrincipalAuthority: DurablePrincipalAuthority = {
        issue(request) {
          const coords = issuePiDurablePrincipalCoordinates(request);
          return {
            sessionDirectory: coords.sessionDirectory,
            sessionFile: join(coords.sessionDirectory, HOST_ISSUED_SESSION_LEAF),
          };
        },
        decode: (value) => piDurablePrincipalAuthority.decode(value),
        isAvailable: (principal) => piDurablePrincipalAuthority.isAvailable(principal),
      };
      await seedResumableJudge({
        home,
        project,
        runId,
        principalAuthority: hostIssuedPrincipalAuthority,
        hostAdapters: [{
          name: "pi",
          create: () => ({
            ok: true as const,
            host: createMinimalHost(async (request) => {
              const { sessionDirectory, sessionFile } =
                hostIssuedPrincipalAuthority.decode(request.principal);
              await mkdir(sessionDirectory, { recursive: true });
              await writeFile(join(sessionDirectory, "session.jsonl"), "{\"type\":\"session\"}\n", "utf8");
              await writeFile(sessionFile, PI_SESSION_SEED, "utf8");
              await observeTyped429ViaProductionHandler({
                runDirectory: request.runDirectory,
                provider: "openai-codex",
              });
              return { code: 1, stderr: "quota", timedOut: false };
            }),
          }),
        }],
      });
      const books = await readdir(join(home, ".ak-roles", "books"));
      const runDirectory = join(home, ".ak-roles", "books", books[0]!, "runs", `${runId}@judge`);
      const admitted = JSON.parse(await readFile(join(runDirectory, "admitted-request.json"), "utf8")) as {
        sessionFile: string;
      };
      const piBefore = await readFile(admitted.sessionFile, "utf8");
      {
        const { io, stderr } = captureIo();
        assert.equal((await runAkRole(["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"], { packageRoot, home, io })).exitCode, 0, stderr.join(""));
        assert.equal((await runAkRole(["config", "set-host", "judge", "grok-build"], { packageRoot, home, io })).exitCode, 0, stderr.join(""));
      }
      await mkdir(join(home, ".grok"), { recursive: true });
      await writeFile(join(home, ".grok", "auth.json"), "test-auth\n", "utf8");
      const faux = join(home, "faux-grok-write.mjs");
      await writeFile(faux, FAUX_GROK_WRITE, "utf8");
      const grokHost: RoleTurnHost = {
        async executeTurn(request) {
          const binding = await bindProductionGrokIsolation(request.runDirectory, request.home, packageRoot);
          await execFileAsync(process.execPath, [faux], { env: binding.env });
          await sealAcceptedSubmission({
            cwd: project,
            runId,
            role: "judge",
            details: { judgeStatus: "converged" },
            runDirectory: request.runDirectory,
            home,
          });
          return { code: 0, stderr: "", timedOut: false };
        },
      };
      const { io, stderr } = captureIo();
      const resumed = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials,
        io,
        principalAuthority: hostIssuedPrincipalAuthority,
        hostAdapters: [
          { name: "pi", create() { throw new Error("pi must not run on grok-build seat"); } },
          { name: "grok-build", create() { return { ok: true as const, host: grokHost }; } },
        ],
      });
      assert.equal(resumed.exitCode, 0, stderr.join(""));
      assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
      const updates = await presentGrokUpdates(join(runDirectory, "grok-home"));
      assert.equal(updates.length, 1);
      assert.equal((JSON.parse(updates[0]!.trim()) as { sessionUpdate?: unknown }).sessionUpdate, "agent_message_chunk");
      assert.deepEqual(
        sessionRowsWithoutAttemptHistory(await readFile(admitted.sessionFile, "utf8")),
        sessionRowsWithoutAttemptHistory(piBefore),
      );
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});

test("public resume Grok→Pi writes Pi session via spawn --session; grok-home unchanged", async () => {
  await withHermeticHome({ prefix: "ak-dk4-grok-to-pi-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-dk4-grok-to-pi";
    const GROK_UPDATES = `${JSON.stringify({ sessionUpdate: "agent_message_chunk" })}\n`;
    {
      const { io, stderr } = captureIo();
      assert.equal((await runAkRole(["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"], { packageRoot, home, io })).exitCode, 0, stderr.join(""));
      assert.equal((await runAkRole(["config", "set-host", "judge", "grok-build"], { packageRoot, home, io })).exitCode, 0, stderr.join(""));
    }
    {
      const { io, stderr } = captureIo();
      const birth = await runAkRole(["judge", `seed-${runId}`], {
        packageRoot,
        home,
        cwd: project,
        credentials,
        createRunId: () => runId,
        io,
        principalAuthority: piDurablePrincipalAuthority,
        hostAdapters: [{
          name: "grok-build",
          create: () => ({
            ok: true as const,
            host: createGrokRoleTurnHost({
              sessionIdentity: {
                async load() { return undefined; },
                async bind() {},
                resolveSessionFile(principal) {
                  return piDurablePrincipalAuthority.decode(principal).sessionFile;
                },
              },
              recordCapabilities: async () => {},
              connect: async () => ({
                async request(method) {
                  if (method === "initialize") return {};
                  if (method === "session/new") return { sessionId: "grok-birth-s1" };
                  if (method === "session/prompt") return { stopReason: "end_turn" };
                  return {};
                },
                notify() {},
                async close() {},
              }),
              inspect: async () => ({ privateActive: [], akActive: [JUDGE_OUTPUT_TOOL_NAME] }),
              prepare: async (request) => {
                const sessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
                const prepared = await prepareGrokRoleEnvelope({
                  request,
                  sessionFile,
                  socketPath: join(request.runDirectory, "mcp-birth.sock"),
                  dependencies: {
                    loadJudgeSoul: async () => "JUDGE SOUL",
                    auditSoulCompliance: async () => ({ status: "pass" }),
                    activationTraceWriter: async () => {},
                  },
                });
                const grokDir = join(request.runDirectory, "grok-home", "sessions", "encoded-cwd", "s1");
                await mkdir(grokDir, { recursive: true });
                await writeFile(join(grokDir, "updates.jsonl"), GROK_UPDATES, "utf8");
                return {
                  ...prepared,
                  closeRound: async () => {
                    await prepared.closeRound();
                    await observeTyped429ViaProductionHandler({
                      runDirectory: request.runDirectory,
                      provider: "openai-codex",
                    });
                    return {
                      accepted: false as const,
                      failure: {
                        cause: "provider" as const,
                        identity: { name: "rate_limit", code: 429 },
                      },
                    };
                  },
                };
              },
            }),
          }),
        }],
      });
      assert.equal(birth.exitCode, 1, stderr.join(""));
      assert.ok(birth.terminal?.resume);
    }
    {
      const { io, stderr } = captureIo();
      assert.equal((await runAkRole(["config", "set-host", "judge", "pi"], { packageRoot, home, io })).exitCode, 0, stderr.join(""));
    }
    const books = await readdir(join(home, ".ak-roles", "books"));
    const runDirectory = join(home, ".ak-roles", "books", books[0]!, "runs", `${runId}@judge`);
    const grokUpdatesFile = join(runDirectory, "grok-home", "sessions", "encoded-cwd", "s1", "updates.jsonl");
    const grokBefore = await readFile(grokUpdatesFile, "utf8");
    const fauxPi = join(home, "faux-pi-write.mjs");
    await writeFile(fauxPi, FAUX_PI_APPEND, "utf8");
    let piSessionWritten: string | undefined;
    const wrappingPi: RoleTurnHost = {
      async executeTurn(request) {
        return createPiRoleTurnHost({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          spawnRunner: async (args) => {
            const sessionFile = argvFlagValue(args, "--session");
            assert.ok(sessionFile);
            piSessionWritten = sessionFile;
            await execFileAsync(process.execPath, [fauxPi, sessionFile]);
            await sealAcceptedSubmission({
              cwd: project,
              runId,
              role: "judge",
              details: { judgeStatus: "converged" },
              runDirectory,
              home,
            });
            return { code: 0, stderr: "", timedOut: false };
          },
        }).executeTurn(request);
      },
    };
    {
      const { io, stderr } = captureIo();
      const resumed = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials,
        io,
        principalAuthority: piDurablePrincipalAuthority,
        hostAdapters: [
          { name: "pi", create() { return { ok: true as const, host: wrappingPi }; } },
          { name: "grok-build", create() { throw new Error("grok must not run on pi seat"); } },
        ],
      });
      assert.equal(resumed.exitCode, 0, stderr.join(""));
      assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    }
    assert.ok(piSessionWritten);
    const piRows = sessionRowsWithoutAttemptHistory(await readFile(piSessionWritten, "utf8"));
    assert.equal(piRows.some((row) => (row as { type?: unknown }).type === "message"), true);
    assert.equal(await readFile(grokUpdatesFile, "utf8"), grokBefore);
  });
});
