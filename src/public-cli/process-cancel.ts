/**
 * #855: catchable process signals for ak-role public entry.
 * SIGTERM / SIGINT / SIGHUP abort the shared controller so hosts can gracefully
 * terminate children (SIGTERM only, never SIGKILL). Uncatchable death (SIGKILL,
 * crash, power loss) is reported via run-state + writer lease on analyst.
 */

const CATCHABLE_PROCESS_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export type CatchableProcessSignal = (typeof CATCHABLE_PROCESS_SIGNALS)[number];

export type ProcessCancelHandle = {
  readonly signal: AbortSignal;
  /** Signal name once a catchable signal has been received; else undefined. */
  readonly receivedSignal: () => CatchableProcessSignal | undefined;
  dispose(): void;
};

/**
 * Install once per process entry. First catchable signal wins; later signals
 * are ignored so settlement can finish without re-entry storms.
 */
export function installProcessCancelHandlers(
  processRef: NodeJS.Process = process,
): ProcessCancelHandle {
  const controller = new AbortController();
  let received: CatchableProcessSignal | undefined;
  const listeners = new Map<CatchableProcessSignal, () => void>();

  for (const sig of CATCHABLE_PROCESS_SIGNALS) {
    const onSignal = (): void => {
      if (received !== undefined) return;
      received = sig;
      try {
        controller.abort(sig);
      } catch {
        // already aborted
      }
    };
    listeners.set(sig, onSignal);
    processRef.on(sig, onSignal);
  }

  return {
    signal: controller.signal,
    receivedSignal: () => received,
    dispose(): void {
      for (const [sig, onSignal] of listeners) {
        processRef.off(sig, onSignal);
      }
      listeners.clear();
    },
  };
}

/** Signal name when this AbortSignal was aborted by installProcessCancelHandlers. */
export function processCancelSignalName(
  signal: AbortSignal | undefined,
): CatchableProcessSignal | undefined {
  if (signal === undefined || signal.aborted !== true) return undefined;
  const reason = signal.reason;
  if (
    reason === "SIGTERM" ||
    reason === "SIGINT" ||
    reason === "SIGHUP"
  ) {
    return reason;
  }
  return undefined;
}

/** Diagnostic line for a catchable process-signal termination (failure honesty). */
export function processCancelDiagnostic(signalName: CatchableProcessSignal): string {
  return `ak-role terminated by ${signalName}`;
}
