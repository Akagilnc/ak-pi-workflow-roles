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
import { deliveryLimitFromConfig } from "./receipt-delivery-policy.ts";

/**
 * #1132: the closeRound re-ask loop is one of the counts that read the single
 * configured `autoResumeLimit` value. The first round is the initial delivery
 * and never a re-ask, so the loop spends at most the configured number of
 * re-ask rounds beyond it. Absent on the request = package default.
 */
export function externalRoleTurnRoundLimit(
  request: Pick<RoleTurnRequest, "deliveryRequestLimit">,
): number {
  return 1 + deliveryLimitFromConfig(request.deliveryRequestLimit);
}

export type ExternalPreparedTurn = Pick<PreparedRoleTurn, "prompt" | "abortSignal" | "closeRound">;

export type ExternalHostRoundOutcome =
  | { readonly status: "delivered"; readonly stderr?: string }
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

/** A dispose failure replaces success; a primary failure retains its cause. */
export function withExternalHostCleanupFailure(
  outcome: RoleTurnResult,
  cleanupError: unknown,
  name: string,
): RoleTurnResult {
  const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  if (outcome.knownFailure === undefined) {
    return externalHostFailure("session", name, "dispose-failed", { cleanupError: message }, message);
  }
  return {
    ...outcome,
    knownFailure: {
      ...outcome.knownFailure,
      details: { ...(outcome.knownFailure.details ?? {}), cleanupError: message },
    },
  };
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
  let stderr = "";
  // #1132: first round is the initial delivery; every later round is one re-ask
  // charged against the single configured ceiling.
  const roundLimit = externalRoleTurnRoundLimit(request);

  for (let attempt = 0; attempt < roundLimit; attempt += 1) {
    if (abortSignal?.aborted) return settleHostAborted(prepared, driver.currentSessionId());

    let round: ExternalHostRoundOutcome;
    try {
      round = await driver.runRound({ prompt, abortSignal, attempt });
    } catch (error) {
      if (isHostAbortedError(error)) return settleHostAborted(prepared, driver.currentSessionId());
      throw error;
    }
    if (round.status === "terminal") {
      const result = round.result;
      const combined = `${stderr}${result.stderr}`;
      return combined === result.stderr ? result : { ...result, stderr: combined };
    }
    if (round.stderr !== undefined && round.stderr.length > 0) stderr += round.stderr;

    const closure = await prepared.closeRound();
    if (closure.accepted) {
      await driver.afterAccepted?.();
      return { code: 0, stderr, timedOut: false };
    }
    if ("failure" in closure) return asFailure(closure.failure, stderr);
    prompt = closure.retry.message;
    driver.afterRetry?.();
  }

  return asFailure({
    cause: "output",
    identity: { name: driver.roundLimitName, code: "round-retry-limit" },
    ...(driver.currentSessionId() === undefined ? {} : { details: { sessionId: driver.currentSessionId() } }),
  });
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
