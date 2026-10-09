/**
 * Middle external-host role-turn loop (#820 / ADR 0082).
 * One copy: serial, abort merge/race, closeRound re-ask rounds,
 * host-aborted, round-limit. Last hop = ExternalHostTurnDriver (four verbs).
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";

import type {
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
} from "./host-contracts.ts";
import type { PreparedRoleTurn } from "./prepared-role-turn.ts";
import { projectThrownFailureLeaf, retainPackageFault } from "./public-cli/settlement.ts";
import { describeErrorIdentity, resolveLiveRunDirectoryPath } from "./public-cli/run-lifecycle.ts";
export { resolveLiveRunDirectoryPath } from "./public-cli/run-lifecycle.ts";
import { deliveryLimitFromConfig } from "./receipt-delivery-policy.ts";
import { parseRunLeaf } from "./role-run-placement.ts";
import { projectTurnRequestLiveRunDirectory } from "./role-run-relocation.ts";
import { reportRunRecord } from "./sitian-facade.ts";
import { isOneShotWorkerReminderCode } from "./submission-errors.ts";

/**
 * Prefer the request path when it still exists; otherwise re-locate by run id
 * (resolveLiveRunDirectoryPath). Mutates the live request so later turn-record /
 * exit-copy / fault notes stay on the new leaf. Authority is required so opaque
 * principal wire is resealed — never shape-guessed in place (#1183).
 */
export async function syncTurnRequestLivePlacement(
  request: RoleTurnRequest,
  authority: DurablePrincipalAuthority,
): Promise<string> {
  const live = await resolveLiveRunDirectoryPath(request.runDirectory, request.home);
  if (live === undefined) {
    const parsed = parseRunLeaf(basename(request.runDirectory));
    throw new Error(
      `admitted run ${parsed?.runId ?? "(unparseable)"} missing after host turn; not found under ${request.home}`,
    );
  }
  if (live !== request.runDirectory) {
    projectTurnRequestLiveRunDirectory(request, live, authority);
  }
  return live;
}

/**
 * Soft live-path sync for cleanup / dossier work: lookup failure stays beside the
 * caller and never revives a vanished leaf. Same authority as syncTurnRequestLivePlacement.
 */
export async function trySyncTurnRequestLivePlacement(
  request: RoleTurnRequest,
  authority: DurablePrincipalAuthority,
): Promise<{ readonly runDirectory: string } | { readonly resolveError: unknown }> {
  try {
    return { runDirectory: await syncTurnRequestLivePlacement(request, authority) };
  } catch (resolveError) {
    return { resolveError };
  }
}

/**
 * Retain a package fault on the live leaf when locatable. Directory lookup only —
 * does not mutate live principal identity (#1183). Lookup failure must not replace
 * the original fault or block later cleanup.
 */
export async function retainPackageFaultBesideLivePlacement(
  request: RoleTurnRequest,
  input: { readonly diagnostic: string; readonly error?: unknown },
): Promise<void> {
  let runDirectory = request.runDirectory;
  if (!existsSync(runDirectory)) {
    try {
      const found = await resolveLiveRunDirectoryPath(request.runDirectory, request.home);
      if (found === undefined) {
        const resolveDiagnostic =
          `live run path resolve failed beside fault: admitted run missing under ${request.home}`;
        try {
          process.stderr.write(`${input.diagnostic}\n`);
          process.stderr.write(`${resolveDiagnostic}\n`);
        } catch {
          // Best-effort presentation beside an already-chosen terminal.
        }
        return;
      }
      runDirectory = found;
    } catch (resolveError) {
      const resolveDiagnostic =
        `live run path resolve failed beside fault: ${describeErrorIdentity(resolveError)}`;
      try {
        process.stderr.write(`${input.diagnostic}\n`);
        process.stderr.write(`${resolveDiagnostic}\n`);
      } catch {
        // Best-effort presentation beside an already-chosen terminal.
      }
      return;
    }
  }
  await retainPackageFault({
    runDirectory,
    diagnostic: input.diagnostic,
    ...(Object.hasOwn(input, "error") ? { error: input.error } : {}),
  });
}

/**
 * What one host start was given: one `turn-delivery` row of history.jsonl per start. History is
 * the volume whose write failure does not stop a run (#833), so a row that cannot be
 * written is noted and the host still starts.
 */
export async function recordTurnDelivery(
  runDirectory: string,
  delivered: { readonly systemPrompt: string; readonly outputSchema?: unknown },
  source: string,
): Promise<void> {
  try {
    reportRunRecord(runDirectory, "turn-delivery", {
      systemPrompt: delivered.systemPrompt,
      ...(delivered.outputSchema === undefined ? {} : { outputSchema: delivered.outputSchema }),
    }, source);
  } catch (error) {
    await retainPackageFault({
      runDirectory,
      diagnostic: `turn delivery record failed beside host start: ${describeErrorIdentity(error)}`,
      error,
    });
  }
}

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
      await retainPackageFaultBesideLivePlacement(request, {
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
        await retainPackageFaultBesideLivePlacement(request, {
          diagnostic: `post-acceptance close failed beside host terminal: ${describeErrorIdentity(error)}`,
          error,
        });
      }
      return result;
    }
    if ("failure" in closure) {
      await retainPackageFaultBesideLivePlacement(request, {
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
        await retainPackageFaultBesideLivePlacement(request, {
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
  request: RoleTurnRequest,
  outcome: RoleTurnResult,
): Promise<RoleTurnResult> {
  try {
    await prepared.dispose?.();
  } catch (error) {
    await retainPackageFaultBesideLivePlacement(request, {
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
