/**
 * #924 Secretariat (中书省) — envelope-assembled tools + nested countersign summon.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";

import { SECRETARIAT_OUTPUT_TOOL_NAME } from "../../src/secretariat-role.ts";
import { createSecretariatRoleRuntime } from "../../src/role-runtime.ts";
import {
  createSubmissionLedgerHost,
  readRecordedSubmissionRows,
} from "../../src/submission-ledger.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

type HostHarness = {
  readonly tools: Map<string, { name: string; execute: Function }>;
  readonly activeTools: () => readonly string[];
};

async function activateSecretariat(options?: {
  /** Optional pre-existing host-surface tool names (no Pi-name hardcode in role). */
  readonly hostSurfaceTools?: readonly string[];
  readonly activationCount?: number;
}): Promise<HostHarness> {
  const tools = new Map<string, { name: string; execute: Function }>();
  let active: string[] = [...(options?.hostSurfaceTools ?? [])];
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getAllTools() {
      const packageNames = [...tools.values()].map((t) => ({ name: t.name }));
      const hostOnly = (options?.hostSurfaceTools ?? [])
        .filter((name) => !tools.has(name))
        .map((name) => ({ name }));
      return [...hostOnly, ...packageNames];
    },
    setActiveTools(names: string[]) {
      active = [...names];
    },
    getActiveTools() {
      return [...active];
    },
    getFlag() {
      return undefined;
    },
  };
  const runtime = createSecretariatRoleRuntime(roleHost as never, {
    loadSoul: async () => "中书省法",
  });
  for (let i = 0; i < (options?.activationCount ?? 1); i += 1) {
    await runtime.activate();
  }
  return { tools, activeTools: () => active };
}

const ctx = {
  cwd: "/work",
  mode: "json",
  model: undefined,
  sessionManager: {} as never,
  runDirectory: "/home/books/x/runs/01parent@secretariat",
  abort() {},
};

test("secretariat activation exposes only the terminating package tool (G6)", async () => {
  const { activeTools } = await activateSecretariat({
    hostSurfaceTools: ["host_read", "host_shell"],
    activationCount: 2,
  });
  const active = activeTools();
  assert.ok(active.includes(SECRETARIAT_OUTPUT_TOOL_NAME));
  assert.equal(active.some((name) => name.startsWith("ak_secretariat_summon_")), false);
  assert.equal([...active].filter((name) => name === SECRETARIAT_OUTPUT_TOOL_NAME).length, 1);
  // Host surface preserved without role hardcoding builtin names.
  assert.ok(active.includes("host_read"));
  assert.ok(active.includes("host_shell"));
});

test("secretariat output records any status without shape reject (第 0 条)", async () => {
  const { tools } = await activateSecretariat();
  const converged = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c1",
    { secretariatStatus: "converged", ticketNumber: 924 },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(converged.terminate, true);
  assert.equal(
    (converged.details as { secretariatStatus: string }).secretariatStatus,
    "converged",
  );

  const escalated = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c2",
    {
      secretariatStatus: "escalate",
      decisionGate: { question: "拆不拆席？", options: ["暂不", "拆"] },
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(escalated.terminate, true);
  assert.equal(
    (escalated.details as { secretariatStatus: string }).secretariatStatus,
    "escalate",
  );

  // 第 0 条 / #924: tool only records; non-canonical status is not code-rejected.
  const other = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c3",
    { secretariatStatus: "unexpected" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(other.terminate, true);
  assert.equal(
    (other.details as { secretariatStatus: string }).secretariatStatus,
    "unexpected",
  );
});

test("secretariat tool finishes before audit on every host",
  async () => {
    async function arm(host: string | undefined, statusOnly = false) {
      const gateCalls: string[] = [];
      const tools = new Map<string, { execute: Function }>();
      const roleHost = {
        registerTool(tool: { name: string; execute: Function }) {
          tools.set(tool.name, tool);
        },
        on() {},
        getAllTools: () => [...tools.keys()].map((name) => ({ name })),
        setActiveTools() {},
        getActiveTools: () => [...tools.keys()],
        getFlag() { return undefined; },
        async requireSubmissionGate(options: { subject: { kind: string } }) {
          gateCalls.push(options.subject.kind);
          return { officer: "countersign", receipt: statusOnly ? undefined : { status: "converged", note: "署原话" } };
        },
      };
      await createSecretariatRoleRuntime(
        roleHost as never,
        { loadSoul: async () => "中书省" },
        {
          failInfrastructure(): never { throw new Error("fail"); },
          bindSubmissionNonPass() {},
        },
      ).activate();
      const hostCtx = {
        cwd: "/tmp",
        mode: "json",
        model: undefined,
        sessionManager: {} as never,
        runDirectory: "/tmp/run",
        ...(host === undefined ? {} : { host }),
        abort() {},
      };
      const result = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
        "c",
        { secretariatStatus: "converged", ticketNumber: 969 },
        undefined,
        undefined,
        hostCtx,
      );
      assert.equal(result.content.length, 0);
      assert.equal(result.terminate, true);
      assert.deepEqual(result.details, { secretariatStatus: "converged", ticketNumber: 969 });
      return gateCalls;
    }

    for (const host of ["codex", "claude", "grok-build", "pi"] as const) {
      assert.deepEqual(await arm(host), [], host);
    }
    assert.deepEqual(await arm(undefined), []);
    assert.deepEqual(await arm(undefined, true), []);

    await withTempRoot("ak-sec-gate-", async (root) => {
      const ungated = new Map<string, { execute: Function }>();
      const rawHost = {
        registerTool(tool: { name: string; execute: Function }) {
          ungated.set(tool.name, tool);
        },
        on() {},
        getAllTools: () => [...ungated.keys()].map((name) => ({ name })),
        setActiveTools() {},
        getActiveTools: () => [...ungated.keys()],
        getFlag() { return undefined; },
      };
      const ledgerHost = createSubmissionLedgerHost(
        rawHost as never,
        new Map([[SECRETARIAT_OUTPUT_TOOL_NAME, "secretariat"]]),
        (error) => { throw error; },
        undefined,
        { home: root },
      );
      await createSecretariatRoleRuntime(
        ledgerHost,
        { loadSoul: async () => "中书省" },
        {
          failInfrastructure(error): never { throw error; },
          bindSubmissionNonPass() {},
        },
      ).activate();
      const params = { secretariatStatus: "converged", ticketNumber: 969 };
      const runDirectory = `${root}/.ak-roles/books/fixture/unbound/runs/run-ledger@secretariat`;
      mkdirSync(`${runDirectory}/session`, { recursive: true });
      writeFileSync(`${runDirectory}/session/session.jsonl`, "");
      const context = {
        cwd: root,
        mode: "json",
        model: undefined,
        runDirectory,
      host: "pi",
        sessionManager: {
          getHeader: () => ({ type: "session", id: "run-ledger:attempt" }),
          getLeafEntry: () => undefined,
          getLeafId: () => null,
          getEntries: () => [],
          getSessionDir: () => `${runDirectory}/session`,
          getSessionFile: () => `${runDirectory}/session/session.jsonl`,
        },
        abort() {},
      };
      const filed = await ungated.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute("c", params, undefined, undefined, context);
      assert.equal(filed.terminate, true);
      assert.deepEqual(await readRecordedSubmissionRows(root, "run-ledger", root), [
        {
          role: "secretariat",
          kind: "accepted",
          accepted: params,
          toolCallId: "c",
        },
      ]);
    });

    // Unknown status still files; the public queue reasks after this tool returns.
    const tools = new Map<string, { execute: Function }>();
    const roleHost = {
      registerTool(tool: { name: string; execute: Function }) {
        tools.set(tool.name, tool);
      },
      on() {},
      getAllTools: () => [...tools.keys()].map((name) => ({ name })),
      setActiveTools() {},
      getActiveTools: () => [...tools.keys()],
      getFlag() { return undefined; },
      async requireSubmissionGate() {
        throw new Error("gate must not run");
      },
    };
    await createSecretariatRoleRuntime(
      roleHost as never,
      { loadSoul: async () => "中书省" },
      {
        failInfrastructure(): never { throw new Error("fail"); },
        bindSubmissionNonPass() {},
      },
    ).activate();
    const unknown = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
          "bad",
          { secretariatStatus: "unexpected" },
          undefined,
          undefined,
          {
            cwd: "/tmp",
            mode: "json",
            model: undefined,
            sessionManager: {} as never,
            host: "codex",
            abort() {},
          },
        );
    assert.equal(unknown.terminate, true);
    assert.deepEqual(unknown.details, { secretariatStatus: "unexpected" });
  },
);
