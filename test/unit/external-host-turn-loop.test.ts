/**
 * #820 middle-loop seam: isomorphic external-host steps live once.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createSerializedRoleTurnHost,
  driveExternalRoleTurnRounds,
  EXTERNAL_ROLE_TURN_ROUND_LIMIT,
  hostAbortedError,
  mergeRoleTurnAbortSignals,
  promptWithPriorNativePaths,
  type ExternalHostTurnDriver,
  type ExternalPreparedTurn,
} from "../../src/external-host-turn-loop.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

function baseRequest(overrides: Partial<RoleTurnRequest> = {}): RoleTurnRequest {
  return {
    principal: fixturePrincipal("/tmp/ak-820-session"),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "initial" },
    cwd: "/tmp",
    home: "/tmp",
    agentDir: "/tmp/agent",
    runDirectory: "/tmp/run",
    ...overrides,
  };
}

function prepared(
  closeRound: ExternalPreparedTurn["closeRound"],
  extras: Partial<ExternalPreparedTurn> = {},
): ExternalPreparedTurn {
  return { prompt: "prepared-prompt", closeRound, ...extras };
}

function driver(
  runRound: ExternalHostTurnDriver["runRound"],
  extras: Partial<ExternalHostTurnDriver> = {},
): ExternalHostTurnDriver {
  return {
    roundLimitName: "ProbeRoundLimit",
    currentSessionId: () => "sess-probe",
    runRound,
    ...extras,
  };
}

test("prior-native + abort merge helpers", () => {
  assert.equal(promptWithPriorNativePaths("body", baseRequest()), "body");
  assert.equal(
    promptWithPriorNativePaths("body", baseRequest({
      continuation: { kind: "resume", prompt: "x" },
      hostTransition: { priorNativeKind: "sitian", priorNativePaths: ["a", "b"] },
    })),
    "body\na\nb",
  );
  const a = new AbortController().signal;
  const b = new AbortController().signal;
  assert.equal(mergeRoleTurnAbortSignals(a, undefined), a);
  assert.notEqual(mergeRoleTurnAbortSignals(a, b), a);
});

test("retry.message is next-round prompt; prior-native folds once", async () => {
  const prompts: string[] = [];
  let closes = 0;
  const result = await driveExternalRoleTurnRounds(
    prepared(async () => {
      closes += 1;
      if (closes === 1) {
        return {
          accepted: false as const,
          retry: { code: "bounce", toolCallIds: ["c1"], message: "opaque-retry" },
        };
      }
      return { accepted: true as const };
    }),
    baseRequest({
      continuation: { kind: "resume", prompt: "x" },
      hostTransition: { priorNativeKind: "pi-native", priorNativePaths: ["prior.jsonl"] },
    }),
    driver(async ({ prompt }) => {
      prompts.push(prompt);
      return { status: "delivered" };
    }),
  );
  assert.equal(result.code, 0);
  assert.deepEqual(prompts, ["prepared-prompt\nprior.jsonl", "opaque-retry"]);
});

test("host-aborted and pre-abort settle through closeRound", async () => {
  const aborted = await driveExternalRoleTurnRounds(
    prepared(async () => ({
      accepted: false as const,
      failure: { cause: "session", identity: { name: "InfraDeclared", code: "infra" } },
    })),
    baseRequest(),
    driver(async () => { throw hostAbortedError("probe"); }),
  );
  assert.equal(aborted.knownFailure?.identity?.name, "InfraDeclared");

  const controller = new AbortController();
  controller.abort();
  const pre = await driveExternalRoleTurnRounds(
    prepared(async () => ({ accepted: true as const }), { abortSignal: controller.signal }),
    baseRequest(),
    driver(async () => {
      assert.fail("runRound must not run");
      return { status: "delivered" };
    }),
  );
  assert.equal(pre.knownFailure?.identity?.code, "host-aborted");
});

test("round limit and terminal short-circuit", async () => {
  let closes = 0;
  const limited = await driveExternalRoleTurnRounds(
    prepared(async () => {
      closes += 1;
      return {
        accepted: false as const,
        retry: { code: "bounce", toolCallIds: [], message: `r${closes}` },
      };
    }),
    baseRequest(),
    driver(async () => ({ status: "delivered" })),
  );
  assert.equal(closes, EXTERNAL_ROLE_TURN_ROUND_LIMIT);
  assert.equal(limited.knownFailure?.identity?.code, "round-retry-limit");

  closes = 0;
  const terminal = await driveExternalRoleTurnRounds(
    prepared(async () => {
      closes += 1;
      return { accepted: true as const };
    }),
    baseRequest(),
    driver(async () => ({
      status: "terminal",
      result: {
        code: null,
        stderr: "",
        timedOut: false,
        knownFailure: { cause: "output", identity: { name: "HostStop", code: "stop" } },
      },
    })),
  );
  assert.equal(closes, 0);
  assert.equal(terminal.knownFailure?.identity?.code, "stop");
});

test("serialized host runs one at a time", async () => {
  const events: string[] = [];
  const host = createSerializedRoleTurnHost(async (request) => {
    events.push(`start:${request.continuation.prompt}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end:${request.continuation.prompt}`);
    return { code: 0, stderr: "", timedOut: false };
  });
  await Promise.all([
    host.executeTurn(baseRequest({ continuation: { kind: "initial", prompt: "a" } })),
    host.executeTurn(baseRequest({ continuation: { kind: "initial", prompt: "b" } })),
  ]);
  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b"]);
});
