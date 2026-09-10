/**
 * Middle external-host role-turn loop (#820 / ADR 0082).
 * One copy: serial, prior-native, abort merge/race, 8-round closeRound retry,
 * host-aborted, round-limit. Last hop = ExternalHostTurnDriver (four verbs).
 */
import type {
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
} from "./host-contracts.ts";

export const EXTERNAL_ROLE_TURN_ROUND_LIMIT = 8 as const;

export type ExternalPreparedTurn = Readonly<{
  readonly prompt: string;
  readonly abortSignal?: AbortSignal;
  closeRound(): Promise<
    | { readonly accepted: true }
    | {
      readonly accepted: false;
      readonly retry: {
        readonly code: string;
        readonly toolCallIds: readonly string[];
        readonly message: string;
      };
    }
    | { readonly accepted: false; readonly failure: RoleTurnKnownFailure }
  >;
}>;

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

export function promptWithPriorNativePaths(basePrompt: string, request: RoleTurnRequest): string {
  if (request.continuation.kind !== "resume") return basePrompt;
  const paths = request.hostTransition?.priorNativePaths;
  if (paths === undefined || paths.length === 0) return basePrompt;
  return `${basePrompt}\n${paths.join("\n")}`;
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
  let prompt = promptWithPriorNativePaths(prepared.prompt, request);
  const abortSignal = mergeRoleTurnAbortSignals(prepared.abortSignal, request.signal);
  let stderr = "";

  for (let attempt = 0; attempt < EXTERNAL_ROLE_TURN_ROUND_LIMIT; attempt += 1) {
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
