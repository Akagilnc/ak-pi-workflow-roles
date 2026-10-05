/**
 * #818 — shared envelope consumes RoleTurnRequest.engine for non-pi hosts.
 * Gate remains resolveEngineName / registerEngineDetourTool (one logic).
 * Engine signal is request-scoped on RoleHost flags — never process.env (#818 P1).
 * External face: tools/list tool-name presence; process.env must stay untouched.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPiRoleRuntimeDependencies } from "../../extensions/role-runtime.ts";
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
import { listMcpToolNames, mcpRelayToken } from "../helpers/mcp-relay-list-tools.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

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
  const home = await mkdtemp(join(tmpdir(), "ak-818-envelope-engine-"));
  try {
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
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function packagedMaterials(paths: readonly string[]): Promise<string> {
  return (await Promise.all(paths.map((path) => readFile(join(packageRoot, path), "utf8"))))
    .join("\n\n");
}

test("shared envelope keeps seat identity separate from typed reference materials", async () => {
  await withEnvelopeHome(async ({ home, socketPath, request }) => {
    const judge = await prepareRoleEnvelope({
      request: request(),
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath,
    });
    try {
      const soul = await packagedMaterials(["souls/judge.md"]);
      // Soul bytes reach the prompt verbatim; the wrapping envelope is presentation.
      assert.ok(judge.systemPrompt.body.includes(soul));
      assert.deepEqual(judge.systemPrompt.materials, [{
        kind: "role-reference-materials",
        content: await packagedMaterials([
          "CLAUDE.md",
          "souls/audit-law.md",
          "souls/quality-law.md",
          "souls/judge-output-guide.md",
          "docs/adr/0057-schema-narrowing-cuts-the-required-set-not-the-declared-set.md",
        ]),
      }]);
    } finally {
      await judge.dispose?.();
    }

    const priorSubject = process.env.AK_ROLE_AUDITOR_SUBJECT;
    process.env.AK_ROLE_AUDITOR_SUBJECT = "judge";
    const auditorRun = ledgerProbeRun(home, "auditor-materials@auditor");
    await mkdir(join(auditorRun, "session"), { recursive: true });
    let auditor;
    try {
      auditor = await prepareRoleEnvelope({
        request: {
          ...request(),
          principal: fixturePrincipal(join(auditorRun, "session")),
          activation: { role: "auditor" },
          runDirectory: auditorRun,
        },
        dependencies: createRoleRuntimeDependencies(packageRoot),
        socketPath: join(home, "auditor.sock"),
      });
    } finally {
      if (priorSubject === undefined) delete process.env.AK_ROLE_AUDITOR_SUBJECT;
      else process.env.AK_ROLE_AUDITOR_SUBJECT = priorSubject;
    }
    try {
      const soul = await packagedMaterials(["souls/judge-auditor.md"]);
      assert.ok(auditor.systemPrompt.body.includes(soul));
      assert.deepEqual(auditor.systemPrompt.materials, [{
        kind: "role-reference-materials",
        content: await packagedMaterials([
          "CLAUDE.md",
          "souls/audit-law.md",
          "souls/quality-law.md",
          "docs/adr/0057-schema-narrowing-cuts-the-required-set-not-the-declared-set.md",
        ]),
      }]);
    } finally {
      await auditor.dispose?.();
    }
  });
});

test("Pi production root supplies typed main and auditor reference materials", async () => {
  await withEnvelopeHome(async ({ home, socketPath, request }) => {
    const dependencies = createPiRoleRuntimeDependencies({
      getFlag: () => undefined,
    } as unknown as ExtensionAPI);
    const judge = await prepareRoleEnvelope({
      request: request(),
      dependencies,
      socketPath,
    });
    try {
      assert.deepEqual(judge.systemPrompt.materials, [{
        kind: "role-reference-materials",
        content: await packagedMaterials([
          "CLAUDE.md",
          "souls/audit-law.md",
          "souls/quality-law.md",
          "souls/judge-output-guide.md",
          "docs/adr/0057-schema-narrowing-cuts-the-required-set-not-the-declared-set.md",
        ]),
      }]);
    } finally {
      await judge.dispose?.();
    }

    const priorSubject = process.env.AK_ROLE_AUDITOR_SUBJECT;
    process.env.AK_ROLE_AUDITOR_SUBJECT = "judge";
    const auditorRun = ledgerProbeRun(home, "pi-auditor-materials@auditor");
    await mkdir(join(auditorRun, "session"), { recursive: true });
    let auditor;
    try {
      auditor = await prepareRoleEnvelope({
        request: {
          ...request(),
          principal: fixturePrincipal(join(auditorRun, "session")),
          activation: { role: "auditor" },
          runDirectory: auditorRun,
        },
        dependencies,
        socketPath: join(home, "pi-auditor.sock"),
      });
    } finally {
      if (priorSubject === undefined) delete process.env.AK_ROLE_AUDITOR_SUBJECT;
      else process.env.AK_ROLE_AUDITOR_SUBJECT = priorSubject;
    }
    try {
      assert.deepEqual(auditor.systemPrompt.materials, [{
        kind: "role-reference-materials",
        content: await packagedMaterials([
          "CLAUDE.md",
          "souls/audit-law.md",
          "souls/quality-law.md",
          "docs/adr/0057-schema-narrowing-cuts-the-required-set-not-the-declared-set.md",
        ]),
      }]);
    } finally {
      await auditor.dispose?.();
    }
  });
});

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

test("#1092 concurrent envelopes do not fold case-dossier pointer materials", async () => {
  const previousRun = process.env.AK_ROLE_RUN_DIR;
  const previousCourt = process.env.AK_ROLE_COURT_ATTEMPT;
  delete process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_COURT_ATTEMPT;
  const home = await mkdtemp(join(tmpdir(), "ak-1092-envelope-no-dossier-"));
  try {
    const mkRun = async (label: string, courtAttemptId: string) => {
      const runDirectory = ledgerProbeRun(home, `${label}@judge`);
      // Legacy freeze leaf may still exist on disk; runtime must not load it (#1092).
      const freezeDir = join(runDirectory, "attachments", "case-dossier");
      await mkdir(freezeDir, { recursive: true });
      await mkdir(join(runDirectory, "session"), { recursive: true });
      await writeFile(join(freezeDir, "00-case-dossier-pointer.md"), `stale-${label}\n`, "utf8");
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
      prepareRoleEnvelope({ request: a.request, dependencies: deps, socketPath: a.socketPath }),
      prepareRoleEnvelope({ request: b.request, dependencies: deps, socketPath: b.socketPath }),
    ]);
    try {
      assert.equal(process.env.AK_ROLE_RUN_DIR, undefined);
      assert.equal(process.env.AK_ROLE_COURT_ATTEMPT, undefined);
      const dossierCount = (prepared: typeof preparedA) =>
        prepared.systemPrompt.materials.filter(
          (material) =>
            typeof material === "object"
            && material !== null
            && (material as { kind?: unknown }).kind === "case-dossier-pointer",
        ).length;
      assert.equal(dossierCount(preparedA), 0);
      assert.equal(dossierCount(preparedB), 0);
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
