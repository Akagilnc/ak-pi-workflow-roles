/**
 * #1192 attendance: the parent's start looks its rows up; its settlement picks
 * the row by the actual status. Oracles are the structured report, never wording.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { createNavigatorAttendance, type NavigatorEvent, type NavigatorSettlement } from "../../src/navigator-attendance.ts";
import { createNavigatorLookup, NavigatorUnavailableError, type NavigatorLookup } from "../../src/navigator-lookup.ts";
import type { PreparedNavigatorAdvice } from "../../src/package-contracts/navigator-output.ts";

const context = { cwd: "/repo", sessionManager: {} } as never;

function rows(byStatus: Record<string, string>): PreparedNavigatorAdvice {
  return { byStatus: new Map(Object.entries(byStatus)) };
}

function attend(lookup: NavigatorLookup) {
  const events: NavigatorEvent[] = [];
  const nav = createNavigatorAttendance({
    context, role: "coder", phase: "apply", subjectKey: "/repo/.ak/work/issues/1192",
    lookup,
    onEvent: (event) => { events.push(event); },
  });
  return { nav, events };
}

const accepted = (status?: string): NavigatorSettlement =>
  ({ kind: "accepted", role: "coder", phase: "apply", ...(status === undefined ? {} : { status }) });

test("a host infrastructure failure settles without a status: no-advice", async () => {
  const { nav, events } = attend(async () => rows({ completed: "C" }));
  nav.prepare();
  await nav.settle({ kind: "role_infrastructure_failure", role: "coder", phase: "apply" });
  assert.deepEqual(events.map((e) => [e.disposition, e.prose]), [["no-advice", undefined]]);
});

test("a role with no rows and a cold settle are affirmative no-advice, never invented", async () => {
  const empty = attend(async () => undefined);
  empty.nav.prepare();
  await empty.nav.settle(accepted("completed"));
  const cold = attend(async () => rows({ completed: "C" }));
  await cold.nav.settle(accepted("completed"));
  assert.deepEqual(
    [...empty.events, ...cold.events].map((e) => e.disposition),
    ["no-advice", "no-advice"],
  );
});

test("arrival is presentation-only and does not wait for the lookup", async () => {
  const { nav, events } = attend(() => new Promise<never>(() => {}));
  nav.prepare();
  await nav.settle({ kind: "arrival", role: "lander", phase: null, message: "到场" });
  assert.deepEqual(events.map((e) => [e.disposition, e.arrivalMessage]), [["arrival", "到场"]]);
});

test("dispose aborts the in-flight lookup and drops its late completion", async () => {
  let seen: AbortSignal | undefined;
  let release!: () => void;
  const { nav, events } = attend(async ({ context: lookupContext }) => {
    seen = lookupContext.signal;
    await new Promise<void>((resolve) => { release = resolve; });
    return rows({ completed: "late" });
  });
  nav.prepare();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(seen?.aborted, false);
  nav.dispose();
  assert.equal(seen?.aborted, true);
  release();
  await nav.settle(accepted("completed"));
  assert.deepEqual(events, []);
});

test("a navigator run that fails or leaves no terminal is unavailable with the real cause", async () => {
  const failed = createNavigatorLookup({
    summonPublicRole: async () => ({
      exitCode: 1,
      terminal: { roleOutcome: { kind: "failure", role: "navigator", diagnostic: "ledger unwritable", decisiveFacts: {} } } as never,
    }),
  });
  await assert.rejects(failed({ context, role: "coder" }), (error: unknown) =>
    error instanceof NavigatorUnavailableError && error.message === "ledger unwritable");
  const silent = createNavigatorLookup({ summonPublicRole: async () => ({ exitCode: 2, stderr: "usage" }) });
  await assert.rejects(silent({ context, role: "coder" }), (error: unknown) =>
    error instanceof NavigatorUnavailableError && error.unavailableSource === "session");
});
