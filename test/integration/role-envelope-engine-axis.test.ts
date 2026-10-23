/**
 * #818 — shared envelope consumes RoleTurnRequest.engine for non-pi hosts.
 * Gate remains resolveEngineName / registerEngineDetourTool (one logic).
 * Engine signal is request-scoped on RoleHost flags — never process.env (#818 P1).
 * External face: tools/list tool-name presence; process.env must stay untouched.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import {
  AK_ROLE_ENGINE_ENV,
  ENGINE_DETOUR_TOOL_NAME,
} from "../../src/engine-detour.ts";
import {
  courtAttemptIdFromHostContext,
  runDirectoryFromHostContext,
  type HostContext,
  type RoleTurnRequest,
} from "../../src/host-contracts.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { withOutsideTempRoot } from "../helpers/environment-fixtures.ts";
import { listMcpToolNames, mcpRelayToken } from "../helpers/mcp-relay-list-tools.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";

/** Same ledger-local run leaf as createTempPackageHomeLedger / #818 withEnvelopeHome. */
function ledgerProbeRun(home: string, leaf: string): string {
  return join(home, ".ak-roles", "books", "probe", "runs", leaf);
}

async function withEnvelopeHome<T>(
  run: (input: {
    home: string;
    runDirectory: string;
    socketPath: string;
    request: (engine?: string) => RoleTurnRequest;
  }) => Promise<T>,
): Promise<T> {
  return withOutsideTempRoot("ak-818-envelope-engine-", async (home) => {
    const runDirectory = ledgerProbeRun(home, "run-818@judge");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const socketPath = join(home, "mcp.sock");
    // stationChild: real envelope without automatic Navigator attendance.
    // Top-level attendance may finish session create after dispose returns;
    // this fixture would then rm the home under that late writer (CI ENOTEMPTY).
    const request = (engine?: string): RoleTurnRequest => ({
      principal: fixturePrincipal(join(runDirectory, "session")),
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "engine-axis probe" },
      cwd: packageRoot,
      home,
      agentDir: join(home, "agent"),
      runDirectory,
      stationChild: true,
      ...(engine === undefined ? {} : { engine }),
    });
    return await run({ home, runDirectory, socketPath, request });
  });
}

test("shared envelope registers engine detour when request.engine is set", async () => {
  await withEnvelopeHome(async ({ socketPath, request }) => {
    const previous = process.env[AK_ROLE_ENGINE_ENV];
    delete process.env[AK_ROLE_ENGINE_ENV];
    try {
      const soul = randomUUID();
      const prepared = await prepareRoleEnvelope({
        request: request("agy"),
        dependencies: { ...createRoleRuntimeDependencies(packageRoot), loadRoleSoul: async () => soul },
        socketPath,
        principalAuthority: piDurablePrincipalAuthority,
    });
      try {
        assert.ok(prepared.systemPrompt.body.includes(soul));
        assert.equal(
          process.env[AK_ROLE_ENGINE_ENV],
          undefined,
          "envelope must not write AK_ROLE_ENGINE onto process.env",
        );
        const names = await listMcpToolNames(socketPath, mcpRelayToken(prepared));
        assert.equal(
          names.includes(ENGINE_DETOUR_TOOL_NAME),
          true,
          `expected ${ENGINE_DETOUR_TOOL_NAME} in ${JSON.stringify(names)}`,
        );
        assert.equal(
          prepared.systemPrompt.materials.some(
            (material) =>
              typeof material === "object"
              && material !== null
              && (material as { kind?: unknown }).kind === "engine-session-material",
          ),
          true,
          "ordinary judge folds engine readingMaterial (#1167 startup delivery)",
        );
      } finally {
        await prepared.dispose?.();
      }
      assert.equal(process.env[AK_ROLE_ENGINE_ENV], undefined);
    } finally {
      if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
      else process.env[AK_ROLE_ENGINE_ENV] = previous;
    }
  });
});

test("shared envelope ignores ambient AK_ROLE_ENGINE when request has no engine", async () => {
  await withEnvelopeHome(async ({ socketPath, request }) => {
    const previous = process.env[AK_ROLE_ENGINE_ENV];
    process.env[AK_ROLE_ENGINE_ENV] = "ambient-should-not-arm";
    try {
      const prepared = await prepareRoleEnvelope({
        request: request(),
        dependencies: createRoleRuntimeDependencies(packageRoot),
        socketPath,
        principalAuthority: piDurablePrincipalAuthority,
    });
      try {
        // Production loader: the packaged Judge Soul bytes reach the system prompt.
        assert.ok(prepared.systemPrompt.body.includes(
          (await readFile(join(packageRoot, "souls", "judge.md"), "utf8")).trim(),
        ));
        assert.equal(process.env[AK_ROLE_ENGINE_ENV], "ambient-should-not-arm");
        const names = await listMcpToolNames(socketPath, mcpRelayToken(prepared));
        assert.equal(
          names.includes(ENGINE_DETOUR_TOOL_NAME),
          false,
          `ambient must not arm detour; tools=${JSON.stringify(names)}`,
        );
      } finally {
        await prepared.dispose?.();
      }
      assert.equal(process.env[AK_ROLE_ENGINE_ENV], "ambient-should-not-arm");
    } finally {
      if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
      else process.env[AK_ROLE_ENGINE_ENV] = previous;
    }
  });
});

test("concurrent envelopes arm detour per request without process.env writes", async () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  delete process.env[AK_ROLE_ENGINE_ENV];
  try {
    await withOutsideTempRoot("ak-818-envelope-concurrent-", async (home) => {
      const mkRequest = async (
        label: string,
        engine?: string,
      ): Promise<{ socketPath: string; request: RoleTurnRequest }> => {
        const runDirectory = ledgerProbeRun(home, `${label}@judge`);
        await mkdir(join(runDirectory, "session"), { recursive: true });
        return {
          socketPath: join(home, `${label}.sock`),
          request: {
            principal: fixturePrincipal(join(runDirectory, "session")),
            activation: { role: "judge" },
            methods: [],
            continuation: { kind: "initial", prompt: `concurrent ${label}` },
            cwd: packageRoot,
            home,
            agentDir: join(home, label, "agent"),
            runDirectory,
            stationChild: true,
            ...(engine === undefined ? {} : { engine }),
          },
        };
      };
      const a = await mkRequest("a", "agy");
      const b = await mkRequest("b", "cursor");
      const free = await mkRequest("free");
      const deps = createRoleRuntimeDependencies(packageRoot);
      const [preparedA, preparedB, preparedFree] = await Promise.all([
        prepareRoleEnvelope({ request: a.request, dependencies: deps, socketPath: a.socketPath,
   principalAuthority: piDurablePrincipalAuthority,
        }),
        prepareRoleEnvelope({ request: b.request, dependencies: deps, socketPath: b.socketPath,
   principalAuthority: piDurablePrincipalAuthority,
        }),
        prepareRoleEnvelope({ request: free.request, dependencies: deps, socketPath: free.socketPath,
   principalAuthority: piDurablePrincipalAuthority,
        }),
      ]);
      try {
        assert.equal(process.env[AK_ROLE_ENGINE_ENV], undefined);
        const [namesA, namesB, namesFree] = await Promise.all([
          listMcpToolNames(a.socketPath, mcpRelayToken(preparedA)),
          listMcpToolNames(b.socketPath, mcpRelayToken(preparedB)),
          listMcpToolNames(free.socketPath, mcpRelayToken(preparedFree)),
        ]);
        assert.equal(
          namesA.includes(ENGINE_DETOUR_TOOL_NAME),
          true,
          `host A expected detour; tools=${JSON.stringify(namesA)}`,
        );
        assert.equal(
          namesB.includes(ENGINE_DETOUR_TOOL_NAME),
          true,
          `host B expected detour; tools=${JSON.stringify(namesB)}`,
        );
        assert.equal(
          namesFree.includes(ENGINE_DETOUR_TOOL_NAME),
          false,
          `engine-free host must not arm detour; tools=${JSON.stringify(namesFree)}`,
        );
      } finally {
        await Promise.all([
          preparedA.dispose?.(),
          preparedB.dispose?.(),
          preparedFree.dispose?.(),
        ]);
      }
    });
  } finally {
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

test("#879 absent HostContext identity never inherits ambient run or court", () => {
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorCourt = process.env.AK_ROLE_COURT_ATTEMPT;
  process.env.AK_ROLE_RUN_DIR = "/ambient/other-run";
  process.env.AK_ROLE_COURT_ATTEMPT = "ambient-other-court";
  try {
    const context = { runDirectory: undefined, courtAttemptId: undefined } as unknown as HostContext;
    assert.equal(runDirectoryFromHostContext(context), undefined);
    assert.equal(courtAttemptIdFromHostContext(context), undefined);
  } finally {
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = priorRun;
    if (priorCourt === undefined) delete process.env.AK_ROLE_COURT_ATTEMPT;
    else process.env.AK_ROLE_COURT_ATTEMPT = priorCourt;
  }
});

test("#1092 concurrent envelopes keep per-request prompts without writing ambient run or court env", async () => {
  const previousRun = process.env.AK_ROLE_RUN_DIR;
  const previousCourt = process.env.AK_ROLE_COURT_ATTEMPT;
  delete process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_COURT_ATTEMPT;
  try {
    await withOutsideTempRoot("ak-1092-envelope-no-dossier-", async (home) => {
      const mkRun = async (label: string, courtAttemptId: string) => {
        const runDirectory = ledgerProbeRun(home, `${label}@judge`);
        await mkdir(join(runDirectory, "session"), { recursive: true });
        return {
          socketPath: join(home, `${label}.sock`),
          request: {
            principal: fixturePrincipal(join(runDirectory, "session")),
            activation: { role: "judge" as const },
            methods: [],
            continuation: { kind: "initial" as const, prompt: `peer-${label}` },
            cwd: packageRoot,
            home,
            agentDir: join(home, label, "agent"),
            runDirectory,
            courtAttemptId,
          },
        };
      };
      const a = await mkRun("a", "court-a");
      const b = await mkRun("b", "court-b");
      const deps = createRoleRuntimeDependencies(packageRoot);
      const [preparedA, preparedB] = await Promise.all([
        prepareRoleEnvelope({ request: a.request, dependencies: deps, socketPath: a.socketPath,
   principalAuthority: piDurablePrincipalAuthority,
        }),
        prepareRoleEnvelope({ request: b.request, dependencies: deps, socketPath: b.socketPath,
   principalAuthority: piDurablePrincipalAuthority,
        }),
      ]);
      try {
        assert.equal(process.env.AK_ROLE_RUN_DIR, undefined);
        assert.equal(process.env.AK_ROLE_COURT_ATTEMPT, undefined);
        assert.equal(preparedA.prompt, "peer-a");
        assert.equal(preparedB.prompt, "peer-b");
      } finally {
        await Promise.all([preparedA.dispose?.(), preparedB.dispose?.()]);
      }
      assert.equal(process.env.AK_ROLE_RUN_DIR, undefined);
      assert.equal(process.env.AK_ROLE_COURT_ATTEMPT, undefined);
    });
  } finally {
    if (previousRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRun;
    if (previousCourt === undefined) delete process.env.AK_ROLE_COURT_ATTEMPT;
    else process.env.AK_ROLE_COURT_ATTEMPT = previousCourt;
  }
});
