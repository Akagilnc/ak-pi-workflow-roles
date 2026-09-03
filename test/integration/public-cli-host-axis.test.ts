import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createPiRoleTurnHost } from "../../src/pi/role-turn-host.ts";
import { createProductionGrokRoleTurnHost } from "../../src/grok/production-host.ts";
import type { DurablePrincipalAuthority, RoleTurnHost } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
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

const FAUX_GROK_SCRIPT = `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "inspect" && args[1] === "--json") {
  process.stdout.write(JSON.stringify({}) + "\\n");
  process.exit(0);
}

if (args[0] === "agent" && args.includes("stdio")) {
  const rl = createInterface({ input: process.stdin });
  const grokHome = process.env.GROK_HOME;
  const runDir = process.env.AK_ROLE_RUN_DIR;

  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, _meta: {} } }) + "\\n");
    } else if (msg.method === "session/new" || msg.method === "session/load") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } }) + "\\n");
    } else if (msg.method === "session/prompt") {
      const promptParts = Array.isArray(msg.params?.prompt) ? msg.params.prompt : [];
      const priorResource = promptParts.find(
        (p) => p.type === "resource" && p.resource?.mimeType === "application/x-ak-prior-native",
      );
      if (priorResource) {
        const priorText = priorResource.resource?.text ?? "";
        const rows = priorText.trim().split("\\n").filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch { return {}; }
        });
        const priorRow = rows.find((r) => r.piStructuredId || r.message?.piStructuredId);
        const piId = priorRow?.piStructuredId ?? priorRow?.message?.piStructuredId;
        if (!piId) {
          process.stderr.write("Grok resume missing required piStructuredId in prior native records\\n");
          process.exit(1);
        }
        if (grokHome) {
          const sDir = join(grokHome, "sessions", "cwd", "s1");
          mkdirSync(sDir, { recursive: true });
          writeFileSync(
            join(sDir, "updates.jsonl"),
            JSON.stringify({
              sessionUpdate: "agent_message_chunk",
              priorConsumed: true,
              inheritedPiId: piId,
            }) + "\\n",
            "utf8",
          );
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "refusal" } }) + "\\n");
      } else {
        if (grokHome) {
          const sDir = join(grokHome, "sessions", "cwd", "s1");
          mkdirSync(sDir, { recursive: true });
          writeFileSync(
            join(sDir, "updates.jsonl"),
            JSON.stringify({
              sessionUpdate: "agent_message_chunk",
              grokStructuredId: "seed-grok-1",
            }) + "\\n",
            "utf8",
          );
        }
        const effectiveRunDir = runDir || (grokHome ? join(grokHome, "..") : undefined);
        if (effectiveRunDir) {
          writeFileSync(
            join(effectiveRunDir, "typed-provider-http.json"),
            JSON.stringify({ httpStatus: 429, provider: "openai-codex" }) + "\\n",
            "utf8",
          );
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "refusal" } }) + "\\n");
      }
    } else if (msg.method === "session/close") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    } else if (typeof msg.id === "number") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    }
  });
}
`;

async function installFauxGrok(home: string): Promise<string> {
  const binDir = join(home, ".grok", "bin");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "grok");
  await writeFile(join(home, ".grok", "auth.json"), "auth-token\n", "utf8");
  await writeFile(binPath, FAUX_GROK_SCRIPT, { mode: 0o755 });
  return binPath;
}

const FAUX_PI_SCRIPT = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const sessionIdx = args.indexOf("--session");
if (sessionIdx === -1 || !args[sessionIdx + 1]) {
  process.stderr.write("Missing --session in Pi arguments\\n");
  process.exit(1);
}
const sessionFile = args[sessionIdx + 1];
const prompt = args.at(-1) ?? "";
let grokStructuredId;
for (const line of prompt.split("\\n")) {
  if (line.trim() === "") continue;
  try {
    const row = JSON.parse(line);
    if (typeof row.grokStructuredId === "string") {
      grokStructuredId = row.grokStructuredId;
      break;
    }
  } catch {
    break;
  }
}
if (typeof grokStructuredId !== "string") {
  process.stderr.write("Pi faux runner: prompt JSONL missing grokStructuredId field\\n");
  process.exit(1);
}
const continuationRow = {
  type: "message",
  priorConsumed: true,
  fromGrokId: grokStructuredId,
};
appendFileSync(sessionFile, JSON.stringify(continuationRow) + "\\n", "utf8");
`;

test("public resume Pi→Grok writes grok-home via isolation env; Pi volume unchanged", async () => {
  await withHermeticHome({ prefix: "ak-dk4-pi-to-grok-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-dk4-pi-to-grok";
    const PI_SESSION_SEED =
      `${JSON.stringify({ type: "session", id: runId })}\n`
      + `${JSON.stringify({ type: "message", id: "m1", piStructuredId: "seed-pi-1" })}\n`;
    await seedResumableJudge({
      home,
      project,
      runId,
      afterTurn: async (_runDirectory, sessionDirectory) => {
        await writeFile(join(sessionDirectory, "session.jsonl"), PI_SESSION_SEED, "utf8");
      },
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
    await installFauxGrok(home);

    const baseGrok = createProductionGrokRoleTurnHost({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
    });
    const grokHost: RoleTurnHost = {
      async executeTurn(request) {
        await baseGrok.executeTurn(request);
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
      principalAuthority: piDurablePrincipalAuthority,
      hostAdapters: [
        { name: "pi", create() { throw new Error("pi must not run on grok-build seat"); } },
        { name: "grok-build", create() { return { ok: true as const, host: grokHost }; } },
      ],
    });
    assert.equal(resumed.exitCode, 0, stderr.join(""));
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    const updatesFile = join(runDirectory, "grok-home", "sessions", "cwd", "s1", "updates.jsonl");
    const grokContent = await readFile(updatesFile, "utf8");
    const grokRow = JSON.parse(grokContent.trim()) as { priorConsumed?: unknown; inheritedPiId?: unknown };
    assert.equal(grokRow.priorConsumed, true);
    assert.equal(grokRow.inheritedPiId, "seed-pi-1");
    assert.deepEqual(
      sessionRowsWithoutAttemptHistory(await readFile(admitted.sessionFile, "utf8")),
      sessionRowsWithoutAttemptHistory(piBefore),
    );
  });
});

test("public resume Grok→Pi writes Pi session via spawn --session; grok-home unchanged", async () => {
  await withHermeticHome({ prefix: "ak-dk4-grok-to-pi-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-dk4-grok-to-pi";
    await installFauxGrok(home);
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
        hostAdapters: [
          {
            name: "grok-build",
            create() {
              return {
                ok: true as const,
                host: createProductionGrokRoleTurnHost({
                  packageRoot,
                  principalAuthority: piDurablePrincipalAuthority,
                }),
              };
            },
          },
        ],
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
    const grokUpdatesFile = join(runDirectory, "grok-home", "sessions", "cwd", "s1", "updates.jsonl");
    const grokBefore = await readFile(grokUpdatesFile, "utf8");
    assert.equal((JSON.parse(grokBefore.trim()) as { grokStructuredId?: unknown }).grokStructuredId, "seed-grok-1");

    const fauxPi = join(home, "faux-pi.mjs");
    await writeFile(fauxPi, FAUX_PI_SCRIPT, "utf8");
    let piSessionWritten: string | undefined;
    const wrappingPi: RoleTurnHost = {
      async executeTurn(request) {
        return createPiRoleTurnHost({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          spawnRunner: async (args, spawnOptions) => {
            const sessionFile = argvFlagValue(args, "--session");
            assert.ok(sessionFile);
            piSessionWritten = sessionFile;
            await execFileAsync(process.execPath, [fauxPi, ...args], {
              cwd: spawnOptions.cwd,
              env: spawnOptions.env,
            });
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
    const continuationRow = piRows.find(
      (row) => (row as { fromGrokId?: unknown }).fromGrokId === "seed-grok-1",
    ) as { priorConsumed?: unknown } | undefined;
    assert.equal(continuationRow?.priorConsumed, true);
    assert.equal(await readFile(grokUpdatesFile, "utf8"), grokBefore);
  });
});
