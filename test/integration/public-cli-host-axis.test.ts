import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createGrokRoleTurnHost,
  openGrokSessionAppendCursor,
  type GrokRebuildHistoryResource,
} from "../../src/grok/role-turn-host.ts";
import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { loadPublicCliConfig, publicCliConfigPath } from "../../src/public-cli/config.ts";
import {
  CROSS_HOST_BASH_CALL_ID,
  CROSS_HOST_BASH_MARKER,
  CROSS_HOST_GROK_USER_MARKER,
} from "../fixtures/cross-host-resume-provider.ts";
import {
  argvFlagValue,
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import {
  packageRoot,
  runPiSubprocess,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

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
  afterTurn?: (runDirectory: string, sessionDirectory: string) => Promise<void>;
}): Promise<void> {
  const { io } = captureIo();
  await runAkRole(["judge", `seed-${input.runId}`], {
    packageRoot,
    home: input.home,
    cwd: input.project,
    credentials,
    createRunId: () => input.runId,
    io,
    principalAuthority: piDurablePrincipalAuthority,
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

const CROSS_HOST_PROVIDER = resolve(
  packageRoot,
  "test/fixtures/cross-host-resume-provider.ts",
);
const CROSS_HOST_MODEL = "openai-codex/faux-1";

/** Real Pi child via existing runPiSubprocess + faux-provider seam. */
function realPiHost(leg: "birth" | "settle") {
  return roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    extraPiArgs: ["-e", CROSS_HOST_PROVIDER],
    timeoutMs: 90_000,
    piRunner: async (args, options) => {
      assert.ok(argvFlagValue(args, "--session"), `Pi ${leg} must pass --session`);
      const subprocess = await runPiSubprocess([...args], {
        cwd: options.cwd,
        env: {
          ...options.env,
          PI_OFFLINE: "1",
          AK_CROSS_HOST_LEG: leg,
        },
        timeoutMs: options.timeoutMs ?? 90_000,
      });
      return {
        code: subprocess.code,
        stdout: subprocess.stdout,
        stderr: subprocess.stderr,
        timedOut: subprocess.localTimeout,
        args: [...args],
      };
    },
  });
}

/**
 * #617 DK-1 / Scope 2: public-CLI Pi→Grok→Pi through real Pi `--session` restore.
 * Birth + final resume use runPiSubprocess/faux-provider; Grok keeps a minimal ACP
 * end for the production projector. No handwritten JSONL or synthetic sealedAcceptance.
 */
test(
  "cross-host resume rebuilds same runId Pi→Grok→Pi with tool history and settles",
  { timeout: 120_000 },
  async () => {
    await withHermeticHome({ prefix: "ak-cross-host-roundtrip-" }, async ({ home, agentDir }) => {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      await writeFile(
        join(agentDir, "navigator-model.json"),
        `${JSON.stringify({ model: CROSS_HOST_MODEL })}\n`,
      );
      const runId = "run-cross-host-roundtrip";
      const selected: string[] = [];

      {
        const { io, stderr } = captureIo();
        assert.equal(
          (await runAkRole(["config", "set-auto-resume-limit", "0"], { packageRoot, home, io })).exitCode,
          0,
          stderr.join(""),
        );
      }

      // 1. Birth on real Pi: bash tool history then typed 429 keeps the run resumable.
      {
        const { io, stderr } = captureIo();
        const birth = await runAkRole(
          ["judge", "--model", CROSS_HOST_MODEL, "--thinking", "off", `seed-${runId}`],
          {
            packageRoot,
            home,
            agentDir,
            cwd: project,
            credentials,
            createRunId: () => runId,
            io,
            principalAuthority: piDurablePrincipalAuthority,
            hostAdapters: [{
              name: "pi",
              create: () => ({ ok: true as const, host: realPiHost("birth") }),
            }],
          },
        );
        assert.equal(birth.exitCode, 1, stderr.join(""));
        assert.ok(birth.terminal?.resume, "birth must stay resumable");
      }

      const books = await readdir(join(home, ".ak-roles", "books"));
      const runDirectory = join(home, ".ak-roles", "books", books[0]!, "runs", `${runId}@judge`);
      const invPath = join(runDirectory, "invocation.json");
      const sessionPath = join(runDirectory, "session", "session.jsonl");

      {
        const { io, stderr } = captureIo();
        assert.equal(
          (await runAkRole(["config", "set", "judge", `${CROSS_HOST_MODEL}:high`], {
            packageRoot, home, io,
          })).exitCode,
          0,
          stderr.join(""),
        );
        assert.equal(
          (await runAkRole(["config", "set-host", "judge", "grok-build"], {
            packageRoot, home, io,
          })).exitCode,
          0,
          stderr.join(""),
        );
      }

      // 2. Grok resume: production projector → keyed application/json resource from sole JSONL.
      const grokPromptParams: unknown[] = [];
      const grokHost = createGrokRoleTurnHost({
        sessionIdentity: {
          async load() { return undefined; },
          async bind() {},
          resolveSessionFile(principal) {
            return piDurablePrincipalAuthority.decode(principal).sessionFile;
          },
        },
        recordCapabilities: async () => {},
        connect: async () => ({
          async request(method, params) {
            if (method === "initialize") return {};
            if (method === "session/new") return { sessionId: "grok-cross-host" };
            if (method === "session/load") {
              throw new Error("cross-host resume must not session/load");
            }
            if (method === "session/prompt") {
              grokPromptParams.push(params);
              return { stopReason: "end_turn" };
            }
            return {};
          },
          notify() {},
          async close() {},
        }),
        inspect: async () => ({ privateActive: [], akActive: [JUDGE_OUTPUT_TOOL_NAME] }),
        prepare: async (request) => {
          const sessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
          return {
            mcpServers: [{ name: "ak-role" }],
            systemPrompt: { body: "law", materials: [] },
            prompt: request.continuation.prompt,
            sessionAppend: openGrokSessionAppendCursor(sessionFile),
            closeRound: async () => {
              // Typed 429 observation keeps the run on the resume face after Grok.
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
      });

      {
        const { io, stderr } = captureIo();
        // Unique opaque message → Grok appends it to JSONL; settle resume stays bare.
        const grokResume = await runAkRole(["resume", runId, CROSS_HOST_GROK_USER_MARKER], {
          packageRoot,
          home,
          agentDir,
          cwd: project,
          credentials,
          io,
          principalAuthority: piDurablePrincipalAuthority,
          hostAdapters: [
            {
              name: "pi",
              create() { throw new Error("Pi adapter must not run on grok-build seat"); },
            },
            {
              name: "grok-build",
              create() {
                selected.push("grok-build");
                return { ok: true as const, host: grokHost };
              },
            },
          ],
        });
        assert.equal(grokResume.exitCode, 1, stderr.join(""));
        assert.equal(grokResume.terminal?.roleOutcome.kind, "failure");
        assert.ok(grokResume.terminal?.resume, "Grok leg must stay resumable");
        assert.equal(grokResume.terminal?.resume?.command.includes(runId), true);
      }
      assert.deepEqual(selected, ["grok-build"]);
      assert.equal(grokPromptParams.length, 1);

      const promptParts = (grokPromptParams[0] as { prompt?: unknown[] }).prompt ?? [];
      const resourcePart = promptParts.find(
        (part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "resource",
      ) as { resource?: { mimeType?: unknown; text?: unknown; uri?: unknown } } | undefined;
      assert.equal(resourcePart?.resource?.mimeType, "application/json");
      assert.equal(resourcePart?.resource?.uri, "context://ak-role/session-history");
      const history = JSON.parse(String(resourcePart?.resource?.text)) as GrokRebuildHistoryResource;
      assert.equal(history.version, 1);
      assert.ok(
        history.turns.some(
          (turn) =>
            turn.kind === "toolCall"
            && turn.id === CROSS_HOST_BASH_CALL_ID
            && turn.name === "bash"
            && typeof turn.arguments === "object"
            && turn.arguments !== null
            && String((turn.arguments as { command?: unknown }).command ?? "").includes(CROSS_HOST_BASH_MARKER),
        ),
        "Grok rebuild resource must carry keyed bash toolCall.arguments from real Pi birth",
      );
      assert.ok(
        history.turns.some(
          (turn) =>
            turn.kind === "toolResult"
            && turn.toolCallId === CROSS_HOST_BASH_CALL_ID
            && turn.toolName === "bash"
            && turn.content != null,
        ),
        "Grok rebuild resource must carry keyed bash toolResult content from real Pi birth",
      );

      {
        const { io, stderr } = captureIo();
        assert.equal(
          (await runAkRole(["config", "set-host", "judge", "pi"], { packageRoot, home, io })).exitCode,
          0,
          stderr.join(""),
        );
      }

      // 3. Pi resume: real Pi loads `--session`, consumes restored history, seals accepted.
      {
        const { io, stderr } = captureIo();
        const piResume = await runAkRole(["resume", runId], {
          packageRoot,
          home,
          agentDir,
          cwd: project,
          credentials,
          io,
          principalAuthority: piDurablePrincipalAuthority,
          hostAdapters: [
            {
              name: "pi",
              create() {
                selected.push("pi");
                return { ok: true as const, host: realPiHost("settle") };
              },
            },
            {
              name: "grok-build",
              create() { throw new Error("Grok adapter must not run on pi seat"); },
            },
          ],
        });
        assert.equal(piResume.exitCode, 0, stderr.join(""));
        assert.equal(piResume.terminal?.roleOutcome.kind, "accepted");
        assert.equal(piResume.terminal?.runId, runId);
        assert.equal(piResume.terminal?.resume, undefined);
      }
      assert.deepEqual(selected, ["grok-build", "pi"]);

      const inv = JSON.parse(await readFile(invPath, "utf8")) as { host?: unknown };
      assert.equal(inv.host, "pi");
      // Session file the real Pi legs shared must still exist for the same runId.
      assert.equal((await readFile(sessionPath, "utf8")).length > 0, true);
    });
  },
);
