/**
 * #818 — shared envelope consumes RoleTurnRequest.engine for non-pi hosts.
 * Gate remains resolveEngineName / registerEngineDetourTool (one logic).
 * Engine signal is request-scoped on RoleHost flags — never process.env (#818 P1).
 * External face: tools/list tool-name presence; process.env must stay untouched.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AK_ROLE_ENGINE_ENV,
  ENGINE_DETOUR_TOOL_NAME,
} from "../../src/engine-detour.ts";
import {
  courtAttemptIdFromHostContext,
  runDirectoryFromHostContext,
  type HostContext,
  type RoleTurnActivation,
  type RoleTurnRequest,
} from "../../src/host-contracts.ts";
import { resolveEngineMaterialPath } from "../../src/package-resources/engine-material.ts";
import type { AdmittedInspectorInvocation } from "../../src/public-cli/invocation.ts";
import { buildInspectorTurnRequest } from "../../src/public-cli/inspector-run.ts";
import { projectActivationFlags } from "../../src/role-activation-flags.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

function mcpRelayToken(prepared: {
  readonly mcpServers: readonly Readonly<Record<string, unknown>>[];
}): string {
  const server = prepared.mcpServers[0];
  assert.ok(server !== undefined, "prepared turn must expose MCP server");
  const env = server.env;
  assert.ok(Array.isArray(env), "mcp server env must be an array");
  for (const entry of env) {
    if (
      typeof entry === "object"
      && entry !== null
      && (entry as { name?: unknown }).name === "AK_ACP_MCP_TOKEN"
      && typeof (entry as { value?: unknown }).value === "string"
    ) {
      return (entry as { value: string }).value;
    }
  }
  assert.fail("AK_ACP_MCP_TOKEN missing from prepared MCP env");
}

async function listMcpToolNames(
  socketPath: string,
  token: string,
): Promise<string[]> {
  const result = await new Promise<{ tools?: Array<{ name?: string }> }>((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("error", reject);
    conn.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end)) as {
          result?: { tools?: Array<{ name?: string }> };
          error?: unknown;
        };
        if (message.error !== undefined) {
          reject(new Error(JSON.stringify(message.error)));
          return;
        }
        resolve(message.result ?? {});
      } catch (error) {
        reject(error);
      } finally {
        conn.end();
      }
    });
    conn.write(`${JSON.stringify({ id: 1, token, method: "tools/list" })}\n`);
  });
  return (result.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string");
}

async function withEnvelopeHome<T>(
  run: (input: {
    home: string;
    runDirectory: string;
    socketPath: string;
    request: (engine?: string) => RoleTurnRequest;
  }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-818-envelope-engine-"));
  try {
    const runDirectory = join(home, ".ak-roles", "books", "probe", "runs", "run-818@judge");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const socketPath = join(home, "mcp.sock");
    const request = (engine?: string): RoleTurnRequest => ({
      principal: fixturePrincipal(join(runDirectory, "session")),
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "engine-axis probe" },
      cwd: packageRoot,
      home,
      agentDir: join(home, "agent"),
      runDirectory,
      ...(engine === undefined ? {} : { engine }),
    });
    return await run({ home, runDirectory, socketPath, request });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("shared envelope registers engine detour when request.engine is set", async () => {
  await withEnvelopeHome(async ({ socketPath, request }) => {
    const previous = process.env[AK_ROLE_ENGINE_ENV];
    delete process.env[AK_ROLE_ENGINE_ENV];
    try {
      const prepared = await prepareRoleEnvelope({
        request: request("agy"),
        dependencies: createRoleRuntimeDependencies(packageRoot),
        socketPath,
      });
      try {
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
          false,
          "ordinary judge must not fold engine readingMaterial (transport prompt already has it)",
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
      });
      try {
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
  const home = await mkdtemp(join(tmpdir(), "ak-818-envelope-concurrent-"));
  try {
    const mkRequest = async (
      label: string,
      engine?: string,
    ): Promise<{ socketPath: string; request: RoleTurnRequest }> => {
      const runDirectory = join(home, label, "run");
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
          ...(engine === undefined ? {} : { engine }),
        },
      };
    };
    const a = await mkRequest("a", "agy");
    const b = await mkRequest("b", "cursor");
    const free = await mkRequest("free");
    const deps = createRoleRuntimeDependencies(packageRoot);
    const [preparedA, preparedB, preparedFree] = await Promise.all([
      prepareRoleEnvelope({ request: a.request, dependencies: deps, socketPath: a.socketPath }),
      prepareRoleEnvelope({ request: b.request, dependencies: deps, socketPath: b.socketPath }),
      prepareRoleEnvelope({ request: free.request, dependencies: deps, socketPath: free.socketPath }),
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
  } finally {
    await rm(home, { recursive: true, force: true });
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

test("#879 concurrent envelopes keep case-dossier identity on HostContext, not process.env", async () => {
  const previousRun = process.env.AK_ROLE_RUN_DIR;
  const previousCourt = process.env.AK_ROLE_COURT_ATTEMPT;
  delete process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_COURT_ATTEMPT;
  const home = await mkdtemp(join(tmpdir(), "ak-879-envelope-dossier-"));
  try {
    const mkFrozen = async (label: string, courtAttemptId: string) => {
      const runDirectory = join(home, label, "run");
      const freezeDir = join(runDirectory, "attachments", "case-dossier");
      await mkdir(freezeDir, { recursive: true });
      await mkdir(join(runDirectory, "session"), { recursive: true });
      const frozenPath = join(freezeDir, "00-case-dossier-pointer.md");
      await writeFile(frozenPath, `dossier-for-${label}\n`, "utf8");
      return {
        socketPath: join(home, `${label}.sock`),
        frozenPath,
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
    const a = await mkFrozen("a", "court-a");
    const b = await mkFrozen("b", "court-b");
    const deps = createRoleRuntimeDependencies(packageRoot);
    const [preparedA, preparedB] = await Promise.all([
      prepareRoleEnvelope({ request: a.request, dependencies: deps, socketPath: a.socketPath }),
      prepareRoleEnvelope({ request: b.request, dependencies: deps, socketPath: b.socketPath }),
    ]);
    try {
      assert.equal(process.env.AK_ROLE_RUN_DIR, undefined);
      assert.equal(process.env.AK_ROLE_COURT_ATTEMPT, undefined);
      const dossierOf = (prepared: typeof preparedA, frozenPath: string) => {
        const rows = prepared.systemPrompt.materials.filter(
          (material) =>
            typeof material === "object"
            && material !== null
            && (material as { kind?: unknown }).kind === "case-dossier-pointer",
        );
        assert.equal(rows.length, 1, "each envelope must load exactly its own dossier");
        const row = rows[0] as { frozenPath?: unknown; section?: unknown };
        assert.equal(row.frozenPath, frozenPath);
        return row;
      };
      const dossierA = dossierOf(preparedA, a.frozenPath);
      const dossierB = dossierOf(preparedB, b.frozenPath);
      assert.equal(dossierA.section, "dossier-for-a\n");
      assert.equal(dossierB.section, "dossier-for-b\n");
      assert.equal(preparedA.prompt, "peer-a");
      assert.equal(preparedB.prompt, "peer-b");
    } finally {
      await Promise.all([preparedA.dispose?.(), preparedB.dispose?.()]);
    }
    assert.equal(process.env.AK_ROLE_RUN_DIR, undefined);
    assert.equal(process.env.AK_ROLE_COURT_ATTEMPT, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
    if (previousRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRun;
    if (previousCourt === undefined) delete process.env.AK_ROLE_COURT_ATTEMPT;
    else process.env.AK_ROLE_COURT_ATTEMPT = previousCourt;
  }
});

const INSPECTOR_PARENT = "/tmp/ak-879-parent-run";
const OFFICER_PAYLOAD = { status: "completed", report: "officer-peer-body" };
const ENGINE = "cursor";
const ENGINE_MODEL = "cursor-grok-4.6-high-fast";

function admittedInspector(instruction: string, runDirectory: string): AdmittedInspectorInvocation {
  return {
    role: "inspector",
    runId: "run-inspector",
    bookKey: "book",
    projectRoot: "/tmp/proj",
    instruction,
    instructionEmpty: false,
    attachments: [],
    runDirectory,
    principal: fixturePrincipal(join(runDirectory, "session")),
    admittedRequestPath: join(runDirectory, "admitted-request.json"),
  };
}

test("#879 inspector first mint: parent path on activation, payload stays dialogue", () => {
  const request = buildInspectorTurnRequest(
    admittedInspector(`卷宗指针：${INSPECTOR_PARENT}`, "/tmp/ak-879-inspector-run"),
    {
      packageRoot,
      home: "/tmp/home",
      agentDir: "/tmp/agent",
      continuation: { kind: "initial", prompt: JSON.stringify(OFFICER_PAYLOAD) },
    },
  );
  assert.equal(request.activation.role, "inspector");
  assert.equal(
    request.activation.role === "inspector" ? request.activation.sourceRun : undefined,
    INSPECTOR_PARENT,
  );
  assert.equal(request.continuation.prompt, JSON.stringify(OFFICER_PAYLOAD));
  assert.equal(request.continuation.prompt.includes(INSPECTOR_PARENT), false);
  assert.equal(projectActivationFlags(request).get("ak-inspector-source-run"), INSPECTOR_PARENT);
});

test("#879 inspector parent binding rides readingMaterial, not prompt", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-879-inspector-bind-"));
  const runDirectory = join(home, "run");
  await mkdir(join(runDirectory, "session"), { recursive: true });
  const request = buildInspectorTurnRequest(
    {
      ...admittedInspector(`卷宗指针：${INSPECTOR_PARENT}`, runDirectory),
      projectRoot: packageRoot,
      principal: fixturePrincipal(join(runDirectory, "session")),
    },
    {
      packageRoot,
      home,
      agentDir: join(home, "agent"),
      continuation: { kind: "initial", prompt: JSON.stringify(OFFICER_PAYLOAD) },
    },
  );
  const prepared = await prepareRoleEnvelope({
    request,
    dependencies: createRoleRuntimeDependencies(packageRoot),
    socketPath: join(home, "mcp.sock"),
  });
  try {
    assert.equal(prepared.prompt, JSON.stringify(OFFICER_PAYLOAD));
    const bindings = prepared.systemPrompt.materials.filter(
      (material) =>
        typeof material === "object"
        && material !== null
        && (material as { kind?: unknown }).kind === "inspector-parent-binding",
    );
    assert.equal(bindings.length, 1);
    assert.deepEqual(bindings[0], {
      kind: "inspector-parent-binding",
      sourceRunPath: INSPECTOR_PARENT,
    });
  } finally {
    await prepared.dispose?.();
    await rm(home, { recursive: true, force: true });
  }
});

test("#879 station-child officer engine material stays off dialogue", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-879-officer-engine-"));
  const notesPath = resolveEngineMaterialPath(packageRoot, ENGINE);
  const parentRun = await seedCanonicalSourceRun(home, packageRoot);
  const seats: readonly RoleTurnActivation[] = [
    { role: "notary", sourceRun: parentRun },
    { role: "inspector", sourceRun: parentRun },
    { role: "auditor" },
  ];
  try {
    for (const activation of seats) {
      const runDirectory = join(home, activation.role, "run");
      await mkdir(join(runDirectory, "session"), { recursive: true });
      const priorSubject = process.env.AK_ROLE_AUDITOR_SUBJECT;
      if (activation.role === "auditor") {
        process.env.AK_ROLE_AUDITOR_SUBJECT = "judge";
      }
      let prepared;
      try {
        prepared = await prepareRoleEnvelope({
          request: {
            principal: fixturePrincipal(join(runDirectory, "session")),
            activation,
            methods: [],
            continuation: { kind: "initial", prompt: JSON.stringify(OFFICER_PAYLOAD) },
            engine: ENGINE,
            engineModel: ENGINE_MODEL,
            cwd: packageRoot,
            home,
            agentDir: join(runDirectory, "agent"),
            runDirectory,
            stationChild: true,
          },
          dependencies: createRoleRuntimeDependencies(packageRoot),
          socketPath: join(home, `${activation.role}.sock`),
        });
      } finally {
        if (activation.role === "auditor") {
          if (priorSubject === undefined) delete process.env.AK_ROLE_AUDITOR_SUBJECT;
          else process.env.AK_ROLE_AUDITOR_SUBJECT = priorSubject;
        }
      }
      try {
        assert.equal(prepared.prompt, JSON.stringify(OFFICER_PAYLOAD));
        assert.equal(prepared.prompt.includes(ENGINE), false);
        assert.equal(prepared.prompt.includes(ENGINE_MODEL), false);
        const engines = prepared.systemPrompt.materials.filter(
          (material) =>
            typeof material === "object"
            && material !== null
            && (material as { kind?: unknown }).kind === "engine-session-material",
        );
        assert.equal(engines.length, 1, `${activation.role} must keep engine material`);
        assert.deepEqual(engines[0], {
          kind: "engine-session-material",
          name: ENGINE,
          model: ENGINE_MODEL,
          materialPath: notesPath,
        });
      } finally {
        await prepared.dispose?.();
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
