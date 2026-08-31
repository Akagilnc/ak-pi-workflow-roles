/**
 * #582 / ADR 0075 — countersign Notary gate ticket binding along real projection seams.
 * Medium: public admission → turn request → Pi/Grok flag projection → runtime gate material.
 * Does not hand-forge the ticket flag: getFlag only serves values decoded from real adapters.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  packageRoot,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import {
  admitCountersignInvocation,
} from "../../src/public-cli/invocation.ts";
import {
  buildCountersignTurnRequest,
} from "../../src/public-cli/countersign-run.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";
import { projectGrokActivationFlags } from "../../src/grok/role-envelope.ts";
import {
  CountersignInvocationBindingError,
  createCountersignRoleRuntime,
} from "../../src/role-runtime.ts";

/** Decode `--name value` pairs from Pi extra argv (adapter output). */
function flagsFromPiArgv(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i]!;
    if (!part.startsWith("--")) continue;
    const name = part.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, "true");
    }
  }
  return flags;
}

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
      const value = input.flags.get(name);
      return value === undefined ? undefined : value;
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
  const tool = tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!;

  const prior = process.env.AK_ROLE_RUN_DIR;
  if (input.runDir !== undefined) process.env.AK_ROLE_RUN_DIR = input.runDir;
  else delete process.env.AK_ROLE_RUN_DIR;
  try {
    try {
      await tool.execute(
        "call-1",
        { countersignStatus: "converged", note: "署" },
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

test("admitted --ticket reaches notary gate via Pi argv projection", async () => {
  await withHermeticHome({ prefix: "ak-cs-gate-pi-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    const ticketPath = join(project, "ticket.md");
    await writeFile(ticketPath, "---\nticketNumber: 100\n---\n\nbody\n", "utf8");

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [ticketPath],
      ticket: 582,
      createRunId: () => "01a0gate00-0000-7000-8000-000000000582",
    });
    assert.equal(admitted.ticketNumber, 582);

    const turn = buildCountersignTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "裁" },
    });
    assert.equal(turn.activation.role, "countersign");
    assert.equal(
      turn.activation.role === "countersign" ? turn.activation.ticketNumber : undefined,
      582,
    );

    // Real Pi adapter projection — not a hand-forged flag map.
    const piArgv = buildPiTurnExtraArgs(turn, piDurablePrincipalAuthority);
    const piFlags = flagsFromPiArgv(piArgv);
    assert.equal(piFlags.get("ak-countersign-ticket-number"), "582");

    const { gateCalls, error } = await submitThroughGate({ flags: piFlags });
    assert.equal(error, undefined);
    assert.equal(gateCalls.length, 1);
    assert.equal(gateCalls[0]!.kind, "countersign_verdict");
    const material = JSON.parse(gateCalls[0]!.material) as {
      ticketNumber?: number;
      verdict?: { countersignStatus?: string };
    };
    assert.equal(material.ticketNumber, 582);
    assert.equal(material.verdict?.countersignStatus, "converged");

    // Same admitted turn via Grok flag projection.
    const grokFlags = projectGrokActivationFlags(turn);
    assert.equal(grokFlags.get("ak-countersign-ticket-number"), "582");
    const grok = await submitThroughGate({ flags: grokFlags });
    assert.equal(grok.error, undefined);
    const grokMaterial = JSON.parse(grok.gateCalls[0]!.material) as {
      ticketNumber?: number;
    };
    assert.equal(grokMaterial.ticketNumber, 582);
  });
});

test("unbound countersign omits ticket on Pi projection and gate material", async () => {
  await withHermeticHome({ prefix: "ak-cs-gate-unbound-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [],
      createRunId: () => "01a0gate00-0000-7000-8000-000000000001",
    });
    assert.equal(admitted.ticketNumber, undefined);

    const turn = buildCountersignTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "裁" },
    });
    const piFlags = flagsFromPiArgv(
      buildPiTurnExtraArgs(turn, piDurablePrincipalAuthority),
    );
    assert.equal(piFlags.has("ak-countersign-ticket-number"), false);

    const { gateCalls, error } = await submitThroughGate({ flags: piFlags });
    assert.equal(error, undefined);
    const material = JSON.parse(gateCalls[0]!.material) as {
      ticketNumber?: number;
    };
    assert.equal(material.ticketNumber, undefined);
  });
});

test("corrupt invocation.json fails before gate with typed binding reason", async () => {
  await withHermeticHome({ prefix: "ak-cs-inv-bad-" }, async ({ home }) => {
    const runDir = join(home, "run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "invocation.json"), "{not-json\n", "utf8");

    // No activation flag — fallback must read invocation and fail honestly.
    const { gateCalls, error } = await submitThroughGate({
      flags: new Map(),
      runDir,
    });
    assert.ok(error instanceof CountersignInvocationBindingError);
    assert.equal(error.code, "countersign-invocation-binding");
    assert.equal(error.reason, "unparseable");
    assert.equal(gateCalls.length, 0);
  });
});
