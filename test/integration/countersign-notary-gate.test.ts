/**
 * #582 / ADR 0075 — countersign Notary inner-gate ticket binding (medium: env/fs).
 * One harness; bound/unbound parameterized; corrupt is the failure boundary.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { withHermeticHome } from "../helpers/pi-test-harness.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import {
  CountersignInvocationBindingError,
  createCountersignRoleRuntime,
} from "../../src/role-runtime.ts";

type GateCall = { readonly kind: string; readonly material: string };

async function withCountersignGateHarness(input: {
  readonly flagTicket?: number;
  readonly run: (ctx: {
    readonly submit: (verdict?: Record<string, unknown>) => Promise<unknown>;
    readonly gateCalls: GateCall[];
  }) => Promise<void>;
}): Promise<void> {
  const tools = new Map<string, { name: string; execute: Function }>();
  const gateCalls: GateCall[] = [];
  const flagValue =
    input.flagTicket === undefined ? undefined : String(input.flagTicket);
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getAllTools() {
      return [{ name: COUNTERSIGN_OUTPUT_TOOL_NAME }];
    },
    getFlag(name: string) {
      return name === "ak-countersign-ticket-number" ? flagValue : undefined;
    },
    async requireGatekeeperPass(options: {
      subject: { kind: string; material: string };
    }) {
      gateCalls.push({
        kind: options.subject.kind,
        material: options.subject.material,
      });
    },
  };
  const runtime = createCountersignRoleRuntime(
    roleHost as never,
    { loadSoul: async () => "LAW" },
    {
      failInfrastructure(): never {
        throw new Error("fail");
      },
      bindSubmissionNonPass() {},
    },
  );
  await runtime.activate();
  const tool = tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  await input.run({
    gateCalls,
    submit: (verdict = { countersignStatus: "converged" }) =>
      tool!.execute(
        "call-1",
        verdict,
        undefined,
        undefined,
        {
          cwd: "/tmp",
          mode: "json",
          model: undefined,
          sessionManager: {} as never,
          abort() {},
        },
      ),
  });
}

const BINDING_CASES: readonly {
  readonly name: string;
  readonly flagTicket?: number;
  readonly expectTicket: number | undefined;
}[] = [
  { name: "bound flag", flagTicket: 582, expectTicket: 582 },
  { name: "unbound", expectTicket: undefined },
];

for (const c of BINDING_CASES) {
  test(`countersign notary gate material: ${c.name}`, async () => {
    await withCountersignGateHarness({
      ...(c.flagTicket === undefined ? {} : { flagTicket: c.flagTicket }),
      run: async ({ submit, gateCalls }) => {
        await submit({ countersignStatus: "converged", note: "署" });
        assert.equal(gateCalls.length, 1);
        assert.equal(gateCalls[0]!.kind, "countersign_verdict");
        const parsed = JSON.parse(gateCalls[0]!.material) as {
          verdict?: { countersignStatus?: string };
          ticketNumber?: number;
        };
        assert.equal(parsed.verdict?.countersignStatus, "converged");
        assert.equal(parsed.ticketNumber, c.expectTicket);
      },
    });
  });
}

test("countersign notary gate: corrupt invocation fails before gate (typed reason)", async () => {
  await withHermeticHome({ prefix: "ak-cs-inv-bad-" }, async ({ home }) => {
    const runDir = join(home, "run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "invocation.json"), "{not-json\n", "utf8");

    const prior = process.env.AK_ROLE_RUN_DIR;
    process.env.AK_ROLE_RUN_DIR = runDir;
    try {
      await withCountersignGateHarness({
        run: async ({ submit, gateCalls }) => {
          await assert.rejects(
            () => submit(),
            (error: unknown) =>
              error instanceof CountersignInvocationBindingError &&
              error.code === "countersign-invocation-binding" &&
              error.reason === "unparseable",
          );
          assert.equal(gateCalls.length, 0);
        },
      });
    } finally {
      if (prior === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = prior;
    }
  });
});
