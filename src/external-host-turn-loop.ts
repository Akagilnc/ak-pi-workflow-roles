/**
 * Middle external-host role-turn loop (#820 / ADR 0082).
 * One copy: serial, abort merge/race, closeRound re-ask rounds,
 * host-aborted, round-limit. Last hop = ExternalHostTurnDriver (four verbs).
 */
import type {
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
} from "./host-contracts.ts";
import type { PreparedRoleTurn } from "./prepared-role-turn.ts";
import { projectThrownFailureLeaf, retainPackageFault } from "./public-cli/settlement.ts";
import { describeErrorIdentity } from "./public-cli/run-lifecycle.ts";
import { deliveryLimitFromConfig } from "./receipt-delivery-policy.ts";
import { isOneShotWorkerReminderCode } from "./submission-errors.ts";

export type ExternalPreparedTurn = Pick<PreparedRoleTurn, "prompt" | "abortSignal" | "closeRound">;

export type ExternalHostRoundOutcome =
  | {
      readonly status: "delivered";
      readonly stderr?: string;
      /** Child exit when this driver has one. Omitted when the protocol has no process exit (ACP). */
      readonly code?: number | null;
      readonly signal?: string;
      readonly timedOut?: boolean;
    }
  | { readonly status: "terminal"; readonly result: RoleTurnResult };

export type ExternalHostTurnDriver = Readonly<{
  readonly roundLimitName: string;
  currentSessionId(): string | undefined;
  runRound(input: {
    readonly prompt: string;
    readonly abortSignal: AbortSignal | undefined;
    readonly attempt: number;
  }): Promise<ExternalHostRoundOutcome>;
  afterAccepted?(): Promise<void>;
  afterRetry?(): void;
}>;

export function mergeRoleTurnAbortSignals(
  prepared: AbortSignal | undefined,
  request: AbortSignal | undefined,
): AbortSignal | undefined {
  if (request === undefined) return prepared;
  if (prepared === undefined) return request;
  return AbortSignal.any([prepared, request]);
}

export function isHostAbortedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "host-aborted";
}

export function hostAbortedError(message = "host aborted"): Error & { readonly code: "host-aborted" } {
  return Object.assign(new Error(message), { code: "host-aborted" as const });
}

/** Race host work against envelope/parent abort (#593). */
export function raceAgainstHostAbort<T>(
  work: Promise<T>,
  abortSignal: AbortSignal | undefined,
  message = "host aborted",
): Promise<T> {
  if (abortSignal?.aborted) return Promise.reject(hostAbortedError(message));
  if (abortSignal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      work.catch(() => {});
      reject(hostAbortedError(message));
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        abortSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        abortSignal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function externalHostFailure(
  cause: NonNullable<RoleTurnKnownFailure["cause"]>,
  name: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
  diagnostic?: string,
): RoleTurnResult {
  return asFailure({
    cause,
    identity: { name, code },
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(details === undefined ? {} : { details }),
  });
}

function asFailure(knownFailure: RoleTurnKnownFailure, stderr = ""): RoleTurnResult {
  return { code: null, stderr, timedOut: false, knownFailure };
}

async function settleHostAborted(
  prepared: ExternalPreparedTurn,
  sessionId: string | undefined,
): Promise<RoleTurnResult> {
  const closure = await prepared.closeRound();
  if ("failure" in closure) return asFailure(closure.failure);
  return asFailure({
    cause: "session",
    identity: { name: "HostAborted", code: "host-aborted" },
    ...(sessionId === undefined ? {} : { details: { sessionId } }),
  });
}

/** Shared external-host retry/resume loop. Caller owns session open + teardown. */
export async function driveExternalRoleTurnRounds(
  prepared: ExternalPreparedTurn,
  request: RoleTurnRequest,
  driver: ExternalHostTurnDriver,
): Promise<RoleTurnResult> {
  let prompt = prepared.prompt;
  const abortSignal = mergeRoleTurnAbortSignals(prepared.abortSignal, request.signal);
  let result: RoleTurnResult = { code: 0, stderr: "", timedOut: false };
  // #1132: the first round is the initial delivery. Each later counted re-ask
  // spends the configured ceiling. The one commit reminder and the one prefix
  // reminder are not counted re-asks (ADR 0066/0070).
  const countedReaskLimit = deliveryLimitFromConfig(request.deliveryRequestLimit);
  const exemptReminders = new Set<string>();
  let countedReasks = 0;

  for (let attempt = 0; ; attempt += 1) {
    if (abortSignal?.aborted) return settleHostAborted(prepared, driver.currentSessionId());

    let round: ExternalHostRoundOutcome;
    try {
      round = await driver.runRound({ prompt, abortSignal, attempt });
    } catch (error) {
      if (isHostAbortedError(error)) return settleHostAborted(prepared, driver.currentSessionId());
      throw error;
    }
    if (round.status === "terminal") return round.result;
    // Only this round's exit and stderr belong to this round's terminal.
    // ACP has no child exit; its successful protocol completion carries code 0.
    result = {
      code: round.code !== undefined ? round.code : 0,
      stderr: round.stderr ?? "",
      timedOut: round.timedOut === true,
      ...(round.signal === undefined ? {} : { signal: round.signal }),
    };
    let closure: Awaited<ReturnType<ExternalPreparedTurn["closeRound"]>>;
    try {
      closure = await prepared.closeRound();
    } catch (error) {
      await retainPackageFault({
        runDirectory: request.runDirectory,
        diagnostic: `round closure failed beside host terminal: ${describeErrorIdentity(error)}`,
        error,
      });
      return result.code === 0 && !result.timedOut && result.signal === undefined
        ? { ...result, knownFailure: projectThrownFailureLeaf(error) }
        : result;
    }
    if (closure.accepted) {
      try { await driver.afterAccepted?.(); }
      catch (error) {
        await retainPackageFault({
          runDirectory: request.runDirectory,
          diagnostic: `post-acceptance close failed beside host terminal: ${describeErrorIdentity(error)}`,
          error,
        });
      }
      return result;
    }
    if ("failure" in closure) {
      await retainPackageFault({
        runDirectory: request.runDirectory,
        diagnostic: `round closure failed beside host terminal: ${JSON.stringify(closure.failure)}`,
      });
      // This is an explicit envelope failure (e.g. required audit/ledger failure),
      // not an inferred host cause. Preserve the process facts alongside it.
      return result.code === 0 && !result.timedOut && result.signal === undefined
        ? { ...result, knownFailure: closure.failure }
        : result;
    }
    if (result.code !== 0 || result.signal !== undefined || result.timedOut) return result;
    const reminderCode = closure.retry.code;
    const exempt = isOneShotWorkerReminderCode(reminderCode) && !exemptReminders.has(reminderCode);
    if (exempt) exemptReminders.add(reminderCode);
    else {
      countedReasks += 1;
      if (countedReasks > countedReaskLimit) {
        await retainPackageFault({
          runDirectory: request.runDirectory,
          diagnostic: `${driver.roundLimitName}: round-retry-limit`,
        });
        return result;
      }
    }
    prompt = closure.retry.message;
    driver.afterRetry?.();
  }

}

/** Required envelope shutdown fails a clean host result; an existing host
 * failure stays primary. Ordinary cleanup is handled at its owning seam. */
export async function disposeExternalRoleTurn(
  prepared: Pick<PreparedRoleTurn, "dispose">,
  request: Pick<RoleTurnRequest, "runDirectory">,
  outcome: RoleTurnResult,
): Promise<RoleTurnResult> {
  try {
    await prepared.dispose?.();
  } catch (error) {
    await retainPackageFault({
      runDirectory: request.runDirectory,
      diagnostic: `required envelope shutdown failed beside host terminal: ${describeErrorIdentity(error)}`,
      error,
    });
    if (outcome.code === 0 && !outcome.timedOut && outcome.signal === undefined
      && outcome.knownFailure === undefined) {
      return { ...outcome, knownFailure: projectThrownFailureLeaf(error) };
    }
  }
  return outcome;
}

export function createSerializedRoleTurnHost(
  execute: (request: RoleTurnRequest) => Promise<RoleTurnResult>,
): RoleTurnHost {
  let serial = Promise.resolve();
  return {
    executeTurn(request) {
      const execution = serial.then(() => execute(request));
      serial = execution.then(() => undefined, () => undefined);
      return execution;
    },
  };
}
