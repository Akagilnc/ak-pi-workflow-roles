/**
 * #818 — shared envelope consumes RoleTurnRequest.engine for non-pi hosts.
 * Gate remains resolveEngineName / registerEngineDetourTool (one logic).
 * Engine signal is request-scoped on RoleHost flags — never process.env (#818 P1).
 * External face: tools/list tool-name presence; process.env must stay untouched.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AK_ROLE_ENGINE_ENV,
  ENGINE_DETOUR_TOOL_NAME,
} from "../../src/engine-detour.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
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
