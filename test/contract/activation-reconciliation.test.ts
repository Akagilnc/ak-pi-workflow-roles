import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test, { afterEach } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";

import {
  ACCEPTED_ACTIVATION_EVENT,
  buildAcceptedActivationFact,
  createRoleRuntimeExtension,
  type AcceptedActivationFact,
} from "../../src/role-runtime.ts";
import {
  DISPATCH_STUB_EVENT,
  DISPATCH_STUB_FACT_KEYS,
  buildDispatchStubFact,
  reconcileInvocation,
  type DispatchStubFact,
  type ProcessLivenessFact,
  type ReconciliationOutcome,
} from "../../src/activation-reconciliation.ts";
import {
  activationBookKeyFor,
  readAcceptedActivationFacts,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";

type ParkedChild = ChildProcess & { stdin: NonNullable<ChildProcess["stdin"]> };

const liveChildren = new Set<ParkedChild>();

afterEach(() => {
  for (const child of liveChildren) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      // best-effort test cleanup only — production reconciler never kills
    }
  }
  liveChildren.clear();
});

function dispatchStub(input: {
  correlationId: string;
  bookKey: string;
  observedAt?: string;
  pid?: number;
}): DispatchStubFact {
  return buildDispatchStubFact({
    correlation: { kind: "caller", id: input.correlationId },
    bookKey: input.bookKey,
    observedAt: input.observedAt ?? "2025-06-01T12:00:00.000Z",
    dispatch: { kind: "process", pid: input.pid ?? 1 },
  });
}

function activationFact(input: {
  correlationId: string | "absent";
  bookKey: string;
  role?: string;
  sessionPath?: string;
  observedAt?: string;
}): AcceptedActivationFact {
  return buildAcceptedActivationFact({
    role: input.role ?? "judge",
    observedAt: input.observedAt ?? "2025-06-01T12:00:01.000Z",
    bookKey: input.bookKey,
    session: { kind: "session-file", path: input.sessionPath ?? "/tmp/session.jsonl" },
    correlation: input.correlationId === "absent"
      ? { kind: "absent" }
      : { kind: "caller", id: input.correlationId },
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnStdinParkedChild(): Promise<ParkedChild> {
  // Parks until stdin closes — mirrors the stdin-stall leg shape without role runtime.
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  assert.ok(child.stdin, "stdin pipe required to release the parked leg");
  const parked = child as ParkedChild;
  liveChildren.add(parked);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (typeof parked.pid === "number" && parked.pid > 0 && isProcessAlive(parked.pid)) {
      return parked;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for stdin-parked child pid");
}

async function waitForExit(child: ParkedChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for child exit")), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function livenessOf(child: ParkedChild): ProcessLivenessFact {
  assert.ok(typeof child.pid === "number" && child.pid > 0);
  return isProcessAlive(child.pid) ? { state: "alive" } : { state: "terminated" };
}

test("dispatch stub fact is closed at the typed API and omits injected content keys", () => {
  const closed: DispatchStubFact = {
    event: DISPATCH_STUB_EVENT,
    observedAt: "2025-06-01T12:00:00.000Z",
    bookKey: "book-a",
    dispatch: { kind: "process", pid: 42 },
    correlation: { kind: "caller", id: "c-keys" },
  };
  const injectedExtraKeys = ["prompt", "transcript", "argv", "excerpt", "content"] as const;
  const smuggled = {
    ...closed,
    prompt: "PROMPT_SECRET_BYTES",
    transcript: "transcript-body",
    argv: ["pi", "--ak-role", "judge"],
    excerpt: "excerpt-text",
    content: "nope",
  } as DispatchStubFact & Record<string, unknown>;
  assert.deepEqual(buildDispatchStubFact(smuggled), closed);
  const projected = buildDispatchStubFact(smuggled) as Record<string, unknown>;
  for (const key of injectedExtraKeys) {
    assert.equal(Object.hasOwn(projected, key), false, `descriptor projection must omit injected ${key}`);
  }
  // Descriptor is the sole top-level emission contract (compile-time keys match + runtime pick).
  for (const key of DISPATCH_STUB_FACT_KEYS) {
    assert.equal(Object.hasOwn(projected, key), true, `descriptor key ${key} must be present`);
  }
});

test("normal dispatch + accepted activation reconciles as matched", () => {
  const bookKey = "ak-roles-128";
  const correlationId = "corr-matched-1";
  const outcome = reconcileInvocation({
    dispatch: dispatchStub({ correlationId, bookKey }),
    activation: activationFact({ correlationId, bookKey }),
    process: { state: "alive" },
  });
  assert.deepEqual(outcome, {
    kind: "matched",
    correlationId,
    bookKey,
  } satisfies ReconciliationOutcome);
});

test("stdin-parked leg is pending while alive and ghost after the same child terminates", async () => {
  const bookKey = "ak-roles-128";
  const correlationId = "corr-stdin-park-1";
  const child = await spawnStdinParkedChild();
  assert.ok(typeof child.pid === "number");
  const dispatch = dispatchStub({ correlationId, bookKey, pid: child.pid });

  // Live unmatched → pending. Reconciler must not kill the child.
  const whileAlive = reconcileInvocation({
    dispatch,
    process: livenessOf(child),
  });
  assert.deepEqual(whileAlive, {
    kind: "pending",
    correlationId,
    bookKey,
  } satisfies ReconciliationOutcome);
  assert.equal(isProcessAlive(child.pid), true, "reconciler must leave the live child running");

  // Consumer (not reconciler) ends the parked leg by closing stdin — natural exit.
  child.stdin.end();
  await waitForExit(child);
  liveChildren.delete(child);
  assert.equal(isProcessAlive(child.pid), false);

  const afterExit = reconcileInvocation({
    dispatch,
    process: livenessOf(child),
  });
  assert.deepEqual(afterExit, {
    kind: "ghost",
    correlationId,
    bookKey,
  } satisfies ReconciliationOutcome);
});

test("activation without a matching dispatch stub is activation-without-dispatch", () => {
  const bookKey = "ak-roles-128";

  // Caller correlation present but no stub at all.
  assert.deepEqual(
    reconcileInvocation({
      activation: activationFact({ correlationId: "orphan-1", bookKey }),
    }),
    {
      kind: "activation-without-dispatch",
      correlationId: "orphan-1",
      bookKey,
    } satisfies ReconciliationOutcome,
  );

  // Typed absent identity (no pre-assigned correlation) — mechanical anomaly.
  assert.deepEqual(
    reconcileInvocation({
      activation: activationFact({ correlationId: "absent", bookKey }),
    }),
    {
      kind: "activation-without-dispatch",
      correlationId: undefined,
      bookKey,
    } satisfies ReconciliationOutcome,
  );

  // Stub exists but book/correlation do not join — still no matching stub.
  assert.deepEqual(
    reconcileInvocation({
      dispatch: dispatchStub({ correlationId: "other", bookKey: "other-book" }),
      activation: activationFact({ correlationId: "orphan-2", bookKey }),
      process: { state: "alive" },
    }),
    {
      kind: "activation-without-dispatch",
      correlationId: "orphan-2",
      bookKey,
    } satisfies ReconciliationOutcome,
  );
});

test("real admitted leg + matching dispatch stub reconciles as matched", async () => {
  await withActivationHome({ prefix: "ak-recon-admit-" }, async ({ home, agentDir }) => {
    const bookKey = activationBookKeyFor(home);
    const correlationId = "corr-real-leg-1";
    const previousCorr = process.env.AK_CORRELATION_ID;
    const faux = fauxProvider({ api: "ak-recon-admit", provider: "ak-recon-admit" });
    process.env.AK_CORRELATION_ID = correlationId;
    process.exitCode = undefined;
    try {
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "RECON ADMIT",
        mode: "print",
        flags: { "ak-role": "judge" },
        extensionFactories: [
          createRoleRuntimeExtension({
            loadJudgeSoul: async () => "LAW",
            transcriptFromContext: () => "",
            auditSoulCompliance: async () => ({ status: "pass" as const }),
            activationClock: () => "2025-06-01T12:00:00.000Z",
            activationTraceWriter: () => {},
          }),
        ],
      }, async ({ sessionManager }) => {
        const sessionFile = sessionManager.getSessionFile();
        assert.ok(typeof sessionFile === "string" && sessionFile.length > 0);
        const facts = readAcceptedActivationFacts(home, bookKey);
        assert.equal(facts.length, 1);
        assert.equal(facts[0]?.event, ACCEPTED_ACTIVATION_EVENT);
        assert.deepEqual(facts[0]?.correlation, { kind: "caller", id: correlationId });

        // #11-shaped dispatch stub joined by the same correlation + book.
        const outcome = reconcileInvocation({
          dispatch: dispatchStub({
            correlationId,
            bookKey,
            observedAt: "2025-06-01T11:59:59.000Z",
          }),
          activation: facts[0],
          process: { state: "alive" },
        });
        assert.deepEqual(outcome, {
          kind: "matched",
          correlationId,
          bookKey,
        } satisfies ReconciliationOutcome);
      });
    } finally {
      if (previousCorr === undefined) delete process.env.AK_CORRELATION_ID;
      else process.env.AK_CORRELATION_ID = previousCorr;
    }
  });
});
