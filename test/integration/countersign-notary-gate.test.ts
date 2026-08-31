/**
 * #582 / ADR 0075 — Notary gate material from projected countersign ticket flag.
 * Admission→turn is proven in public-cli-countersign-run; Grok/Pi flag projection
 * in grok-role-envelope / buildPiTurnExtraArgs consumers. This file only proves
 * the gate consumes a real adapter flag map into typed material (and corrupt
 * invocation fails before gate).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { withHermeticHome } from "../helpers/pi-test-harness.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { projectGrokActivationFlags } from "../../src/grok/role-envelope.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import {
  CountersignInvocationBindingError,
  createCountersignRoleRuntime,
} from "../../src/role-runtime.ts";

type GateCall = { readonly kind: string; readonly material: string };

async function submitThroughGate(input: {
  readonly flags: ReadonlyMap<string, string | boolean>;
  readonly runDir?: string;
}): Promise<{ readonly gateCalls: GateCall[]; readonly error?: unknown }> {
  const tools = new Map<string, { name: string; execute: Function }>();
  const gateCalls: GateCall[] = [];
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getAllTools() {
      return [{ name: COUNTERSIGN_OUTPUT_TOOL_NAME }];
    },
    getFlag(name: string) {
      return input.flags.get(name);
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
  await createCountersignRoleRuntime(
    roleHost as never,
    { loadSoul: async () => "LAW" },
    {
      failInfrastructure(): never {
        throw new Error("fail");
      },
      bindSubmissionNonPass() {},
    },
  ).activate();

  const prior = process.env.AK_ROLE_RUN_DIR;
  if (input.runDir !== undefined) process.env.AK_ROLE_RUN_DIR = input.runDir;
  else delete process.env.AK_ROLE_RUN_DIR;
  try {
    try {
      await tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!.execute(
        "call-1",
        { countersignStatus: "converged" },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          mode: "json",
          model: undefined,
          sessionManager: {} as never,
          abort() {},
        },
      );
      return { gateCalls };
    } catch (error) {
      return { gateCalls, error };
    }
  } finally {
    if (prior === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = prior;
  }
}

test("notary gate material carries ticketNumber from real Grok activation flags", async () => {
  // Adapter output is the sole flag source — same function production Grok host uses.
  const flags = projectGrokActivationFlags({
    activation: { role: "countersign", ticketNumber: 582 },
  } as RoleTurnRequest);
  assert.equal(flags.get("ak-countersign-ticket-number"), "582");

  const { gateCalls, error } = await submitThroughGate({ flags });
  assert.equal(error, undefined);
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0]!.kind, "countersign_verdict");
  const material = JSON.parse(gateCalls[0]!.material) as {
    ticketNumber?: number;
    verdict?: { countersignStatus?: string };
  };
  assert.equal(material.ticketNumber, 582);
  assert.equal(material.verdict?.countersignStatus, "converged");
});

test("notary gate omits ticketNumber when activation flag map has none", async () => {
  const flags = projectGrokActivationFlags({
    activation: { role: "countersign" },
  } as RoleTurnRequest);
  assert.equal(flags.has("ak-countersign-ticket-number"), false);

  const { gateCalls, error } = await submitThroughGate({ flags });
  assert.equal(error, undefined);
  const material = JSON.parse(gateCalls[0]!.material) as {
    ticketNumber?: number;
  };
  assert.equal(material.ticketNumber, undefined);
});

const BINDING_FAILURES: readonly {
  readonly name: string;
  readonly reason: CountersignInvocationBindingError["reason"];
  readonly flags: ReadonlyMap<string, string | boolean>;
  readonly runDir?: "corrupt-invocation";
}[] = [
  {
    name: "flag empty string",
    reason: "flag-invalid",
    flags: new Map([["ak-countersign-ticket-number", ""]]),
  },
  {
    name: "flag zero",
    reason: "flag-invalid",
    flags: new Map([["ak-countersign-ticket-number", "0"]]),
  },
  {
    name: "flag negative",
    reason: "flag-invalid",
    flags: new Map([["ak-countersign-ticket-number", "-1"]]),
  },
  {
    name: "flag non-numeric",
    reason: "flag-invalid",
    flags: new Map([["ak-countersign-ticket-number", "nope"]]),
  },
  {
    name: "flag boolean true",
    reason: "flag-invalid",
    flags: new Map([["ak-countersign-ticket-number", true]]),
  },
  {
    name: "flag above MAX_SAFE_INTEGER",
    reason: "flag-invalid",
    flags: new Map([["ak-countersign-ticket-number", "9007199254740993"]]),
  },
  {
    name: "corrupt invocation.json",
    reason: "unparseable",
    flags: new Map(),
    runDir: "corrupt-invocation",
  },
];

for (const failure of BINDING_FAILURES) {
  test(`notary gate binding failure: ${failure.name}`, async () => {
    await withHermeticHome({ prefix: "ak-cs-bind-fail-" }, async ({ home }) => {
      let runDir: string | undefined;
      if (failure.runDir === "corrupt-invocation") {
        runDir = join(home, "run");
        await mkdir(runDir, { recursive: true });
        await writeFile(join(runDir, "invocation.json"), "{not-json\n", "utf8");
      }
      const { gateCalls, error } = await submitThroughGate({
        flags: failure.flags,
        ...(runDir === undefined ? {} : { runDir }),
      });
      assert.ok(error instanceof CountersignInvocationBindingError);
      assert.equal(error.code, "countersign-invocation-binding");
      assert.equal(error.reason, failure.reason);
      assert.equal(gateCalls.length, 0);
    });
  });
}
