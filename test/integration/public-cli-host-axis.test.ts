import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

import type { DurablePrincipalAuthority, RoleTurnHost } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { loadPublicCliConfig, publicCliConfigPath } from "../../src/public-cli/config.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot, withHermeticHome } from "../helpers/pi-test-harness.ts";
import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { payloadStatus, payloadStatusSequence } from "../helpers/terminal-payload.ts";
import type { TerminalRoleOutcome } from "../../src/public-cli/terminal.ts";

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
  await withTempRoot("ak-host-axis-", fn);
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

test("host flags reject non-role commands; navigator is a callable seat (#639)", async () => homeTest(async (home) => {
  const flag = await runAkRole(["roles", "--host", "pi"], base(home, [adapter("pi", [])]));
  assert.equal(flag.exitCode, 2);

  // #639: navigator has a public call path — persistent host axis is legal.
  await runAkRole(["config", "set", "navigator", "openai-codex/gpt-5.6-sol:high"], base(home, []));
  const command = await runAkRole(["config", "set-host", "navigator", "pi"], base(home, []));
  assert.equal(command.exitCode, 0);

  await writeFile(publicCliConfigPath(home), JSON.stringify({
    seats: { navigator: { provider: "openai-codex", model: "gpt-5.6-sol", host: "pi" } },
  }));
  const disk = await runAkRole(["config", "show"], base(home, []));
  assert.equal(disk.exitCode, 0);
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

test("production adapter table registers grok-build and hermes and keeps pi selectable", async () => homeTest(async (home) => {
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
    registeredHosts: ["pi", "grok-build", "hermes", "claude", "codex"],
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

// #788: table > unique host-directory > fail on the public entry; pi unaffected.
// Host must be registered before any provider projection (expectation 2).
test("host provider resolution prefers table, then unique directory, else fails loud", async () => homeTest(async (home) => {
  const seen: Array<{ host: string; provider: string | undefined }> = [];
  const probe = (name: string): NamedRoleTurnHostAdapter => ({
    name,
    create: () => ({
      ok: true as const,
      host: {
        executeTurn: async (request) => {
          seen.push({ host: name, provider: request.model?.provider });
          return { code: 1, stderr: "probe-stop", timedOut: false };
        },
      },
    }),
  });
  const adapters = [probe("pi"), probe("hermes")];

  await runAkRole(["config", "set", "judge", "xai/grok-4.5:high"], base(home, []));

  // Owner table wins even when the host directory would be ambiguous.
  await mkdir(join(home, ".ak-roles"), { recursive: true });
  await writeFile(
    join(home, ".ak-roles", "host-providers.json"),
    `${JSON.stringify({ hermes: { xai: "xai-oauth" } }, null, 2)}\n`,
    "utf8",
  );
  await mkdir(join(home, ".hermes"), { recursive: true });
  await writeFile(
    join(home, ".hermes", "provider_models_cache.json"),
    JSON.stringify({
      "xai-oauth": { models: ["grok-4.5"] },
      nous: { models: ["x-ai/grok-4.5"] },
      openrouter: { models: ["x-ai/grok-4.5"] },
    }),
    "utf8",
  );

  // Unregistered host fails as host-unregistered — never as a model/provider error.
  // Production adapter table on this build has no hermes; use pi-only adapters.
  const unregistered = await runAkRole(
    ["judge", "--host", "hermes", "host-first"],
    base(home, [probe("pi")]),
  );
  assert.equal(unregistered.exitCode, 1);
  assert.deepEqual(unregistered.hostFailure, {
    kind: "host-unregistered",
    host: "hermes",
    seat: "judge",
    model: "xai/grok-4.5",
    registeredHosts: ["pi"],
  });
  assert.equal(seen.length, 0);

  const tableHit = await runAkRole(["judge", "--host", "hermes", "table-probe"], base(home, adapters));
  assert.equal(tableHit.hostFailure, undefined);
  assert.equal(tableHit.exitCode, 1);

  const pi = await runAkRole(["judge", "--host", "pi", "pi-probe"], base(home, adapters));
  assert.equal(pi.hostFailure, undefined);
  assert.equal(pi.exitCode, 1);
  assert.deepEqual(seen, [
    { host: "hermes", provider: "xai-oauth" },
    { host: "pi", provider: "xai" },
  ]);

  // Drop the table entry → directory is ambiguous → leg does not start.
  await writeFile(
    join(home, ".ak-roles", "host-providers.json"),
    `${JSON.stringify({}, null, 2)}\n`,
    "utf8",
  );
  seen.length = 0;
  const ambiguous = await runAkRole(["judge", "--host", "hermes", "ambiguous"], base(home, adapters));
  assert.equal(ambiguous.exitCode, 1);
  assert.equal(ambiguous.hostFailure, undefined);
  assert.equal(seen.length, 0);

  // Unique directory match replaces without a table row.
  await writeFile(
    join(home, ".hermes", "provider_models_cache.json"),
    JSON.stringify({ "xai-oauth": { models: ["grok-4.5"] } }),
    "utf8",
  );
  seen.length = 0;
  const unique = await runAkRole(["judge", "--host", "hermes", "unique"], base(home, adapters));
  assert.equal(unique.hostFailure, undefined);
  assert.deepEqual(seen, [{ host: "hermes", provider: "xai-oauth" }]);

  // Seat rows themselves stay as written.
  assert.deepEqual((await loadPublicCliConfig(home)).seats.judge, {
    provider: "xai",
    model: "grok-4.5",
    thinking: "high",
  });
}));

test("public grok-build turn inherits operator HOME and leaves sitian-only run records", async () => homeTest(async (home) => {
  const envDump = join(home, "child-env.json");
  await mkdir(join(home, ".grok", "bin"), { recursive: true });
  const binary = join(home, ".grok", "bin", "grok");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));
if (process.argv.includes("inspect")) {
  process.stdout.write(JSON.stringify({
    skills: [], plugins: [], agents: [], hooks: [], mcpServers: [], projectInstructions: [],
  }));
}
process.exit(0);
`,
    { encoding: "utf8" },
  );
  await chmod(binary, 0o755);
  await configureJudge(home, "grok-build");
  const result = await runAkRole(["judge", "public-grok-sitian"], productionBase(home));
  assert.equal(result.hostFailure, undefined);

  const booksRoot = join(home, ".ak-roles", "books");
  const books = await readdir(booksRoot);
  assert.ok(books.length >= 1);
  const runsRoot = join(booksRoot, books[0]!, "runs");
  const runs = await readdir(runsRoot);
  // #717: this turn is sitian-only (no run-scoped grok-home). #675 nested public
  // navigator attendance may mint sibling role runs; the grok isolation contract
  // is on the judge run, not on book-wide run count.
  const judgeRuns = runs.filter((name) => name.endsWith("@judge"));
  assert.equal(judgeRuns.length, 1);
  const children = await readdir(join(runsRoot, judgeRuns[0]!));
  assert.equal(children.some((name) => name.endsWith("-home")), false);
  const dumped = JSON.parse(await readFile(envDump, "utf8")) as NodeJS.Dict<string>;
  assert.equal(dumped.HOME, process.env.HOME);
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

/**
 * #822 — method Skill stays host-neutral on non-pi production path (graduated from
 * deleted unit helper probe). Real entry: config set-host coder + fake host binary.
 * Assert only external structured results: host prompt free of Pi `/skill:`, and
 * typed method provenance on the public Terminal evidence artifact after a lawful
 * planned receipt (same shape as lawful reviewer methodProvenance tracer).
 */
test("#822 coder apply non-pi hosts: prompt free of /skill:; method provenance on receipt", async () => {
  await homeTest(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const assignment = "#822 implement the approved slice without slash transport";
    // One initial turn only — auto-resume would overwrite host dumps with the resume envelope.
    await runAkRole(["config", "set-auto-resume-limit", "0"], productionBase(home));

    async function assertMethodProvenanceReceipt(result: {
      hostFailure?: unknown;
      terminal?: {
        roleOutcome?: TerminalRoleOutcome;
        artifacts?: ReadonlyArray<{ kind: string; path: string }>;
      };
    }, label: string): Promise<void> {
      assert.equal(result.hostFailure, undefined, `${label}: host selection must succeed`);
      assert.equal(result.terminal?.roleOutcome?.kind, "accepted", label);
      // #836: the role's own status field, read off its original payload —
      // not a runtime-selected top-level status.
      assert.deepEqual(
        result.terminal?.roleOutcome === undefined ? [] : payloadStatusSequence(result.terminal.roleOutcome),
        ["planned"],
        label,
      );
      const evidenceRef = result.terminal?.artifacts?.find((a) => a.kind === "evidence");
      assert.ok(evidenceRef, `${label}: evidence artifact`);
      const evidence = JSON.parse(await readFile(evidenceRef.path, "utf8")) as {
        methodProvenance?: { name?: string; kind?: string };
      };
      assert.equal(evidence.methodProvenance?.name, "tdd", label);
      assert.equal(evidence.methodProvenance?.kind, "role-method-skill", label);
    }

    // --- ACP family: grok-build fake agent seals planned via MCP, answers session/close ---
    {
      const framesPath = join(home, "grok-frames.jsonl");
      await mkdir(join(home, ".grok", "bin"), { recursive: true });
      const binary = join(home, ".grok", "bin", "grok");
      await writeFile(
        binary,
        `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
const framesPath = ${JSON.stringify(framesPath)};
let mcpInfo = null;
function callPlanned(socketPath, token) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    let nextId = 1;
    const waiters = new Map();
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      for (;;) {
        const i = buf.indexOf("\\n"); if (i < 0) break;
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const w = waiters.get(msg.id); if (!w) continue;
        waiters.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    });
    sock.on("error", reject);
    function req(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        waiters.set(id, { resolve: res, reject: rej });
        sock.write(JSON.stringify({ id, token, method, params }) + "\\n");
      });
    }
    sock.on("connect", async () => {
      try {
        await req("tools/call", {
          name: "ak_coder_output",
          arguments: { status: "planned", report: "Plan only; no edits." },
        });
        sock.destroy();
        resolve();
      } catch (e) { sock.destroy(); reject(e); }
    });
  });
}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  appendFileSync(framesPath, line + "\\n");
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.method !== "string" || typeof msg.id !== "number") return;
  void (async () => {
    try {
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
        return;
      }
      if (msg.method === "session/new" || msg.method === "session/load") {
        const servers = msg.params?.mcpServers ?? [];
        const envRows = servers[0]?.env ?? [];
        mcpInfo = {
          socketPath: envRows.find((e) => e.name === "AK_ACP_MCP_SOCKET")?.value,
          token: envRows.find((e) => e.name === "AK_ACP_MCP_TOKEN")?.value,
        };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-822-grok" } }) + "\\n");
        return;
      }
      if (msg.method === "session/prompt") {
        if (mcpInfo?.socketPath && mcpInfo?.token) {
          await callPlanned(mcpInfo.socketPath, mcpInfo.token);
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
        return;
      }
      // Accepted path awaits session/close before teardown (role-turn-host).
      if (msg.method === "session/close") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
      }
    } catch (e) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: String(e) } }) + "\\n");
    }
  })();
});
`,
        { encoding: "utf8" },
      );
      await chmod(binary, 0o755);

      await runAkRole(["config", "set", "coder", "xai/grok-4.5:high"], productionBase(home));
      await runAkRole(["config", "set-host", "coder", "grok-build"], productionBase(home));
      const result = await runAkRole(
        ["coder", "--project", project, assignment],
        { ...productionBase(home), cwd: project, createRunId: () => "run-822-coder-grok" },
      );

      const frames = (await readFile(framesPath, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as {
          method?: string;
          params?: { prompt?: Array<{ type?: string; text?: string }> };
        });
      const promptFrame = frames.find((f) => f.method === "session/prompt");
      assert.ok(promptFrame, "ACP session/prompt must reach the host");
      const hostPrompt = (promptFrame.params?.prompt ?? [])
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
      assert.equal(hostPrompt.startsWith("/skill:"), false, hostPrompt.slice(0, 80));
      assert.equal(hostPrompt.includes(assignment), true);
      await assertMethodProvenanceReceipt(result, "grok-build");
    }

    // --- headless family: claude fake returns planned structured_output ---
    {
      const argvDump = join(home, "claude-argv.json");
      await mkdir(join(home, ".local", "bin"), { recursive: true });
      const binary = join(home, ".local", "bin", "claude");
      const plannedEnvelope = {
        type: "result",
        session_id: "sess-822-claude",
        structured_output: { status: "planned", report: "Plan only; no edits." },
      };
      await writeFile(
        binary,
        `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const dump = ${JSON.stringify(argvDump)};
if (!existsSync(dump)) writeFileSync(dump, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(JSON.stringify(plannedEnvelope))} + "\\n");
process.exit(0);
`,
        { encoding: "utf8" },
      );
      await chmod(binary, 0o755);

      await runAkRole(["config", "set", "coder", "openai-codex/gpt-5.6-sol:high"], productionBase(home));
      await runAkRole(["config", "set-host", "coder", "claude"], productionBase(home));
      const result = await runAkRole(
        ["coder", "--project", project, assignment],
        { ...productionBase(home), cwd: project, createRunId: () => "run-822-coder-claude" },
      );

      const argv = JSON.parse(await readFile(argvDump, "utf8")) as string[];
      const promptAt = argv.indexOf("-p");
      assert.equal(promptAt >= 0, true, "headless prompt flag -p must be present");
      const hostPrompt = argv[promptAt + 1]!;
      assert.equal(hostPrompt.startsWith("/skill:"), false, hostPrompt.slice(0, 80));
      assert.equal(hostPrompt.includes(assignment), true);
      // Provider-visible systemPrompt channel is a path flag (structure), not free text.
      assert.equal(argv.includes("--system-prompt-file"), true);
      await assertMethodProvenanceReceipt(result, "claude");
    }
  });
});
