/**
 * Stream idle backstop (#102 / #155 a): first-wait + between-event silence only.
 * Not a total wall-clock for long thinking turns.
 */

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;
export const STREAM_IDLE_TIMEOUT_CODE = "AK_STREAM_IDLE_TIMEOUT" as const;

export class StreamIdleTimeoutError extends Error {
  readonly code = STREAM_IDLE_TIMEOUT_CODE;
  readonly idleTimeoutMs: number;

  constructor(idleTimeoutMs: number, options?: ErrorOptions) {
    super(`stream idle timeout after ${idleTimeoutMs}ms`, options);
    this.name = "StreamIdleTimeoutError";
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

export function isStreamIdleTimeoutError(value: unknown): value is StreamIdleTimeoutError {
  return value instanceof StreamIdleTimeoutError
    || (
      typeof value === "object"
      && value !== null
      && (value as { name?: unknown }).name === "StreamIdleTimeoutError"
      && (value as { code?: unknown }).code === STREAM_IDLE_TIMEOUT_CODE
    );
}

export type StreamIdleGuardTimers = {
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
};

export type StreamIdleGuardOptions = {
  idleTimeoutMs?: number;
  parentSignal?: AbortSignal;
  timers?: StreamIdleGuardTimers;
};

export type StreamIdleGuard = {
  readonly signal: AbortSignal;
  poke(): void;
  dispose(): void;
};

export function createStreamIdleGuard(
  options: StreamIdleGuardOptions = {},
): StreamIdleGuard {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const setTimer = options.timers?.setTimer ?? setTimeout;
  const clearTimer = options.timers?.clearTimer ?? clearTimeout;
  const parentSignal = options.parentSignal;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const arm = (): void => {
    if (disposed || controller.signal.aborted || idleTimeoutMs <= 0) return;
    clear();
    timer = setTimer(() => {
      timer = undefined;
      if (disposed || controller.signal.aborted) return;
      controller.abort(new StreamIdleTimeoutError(idleTimeoutMs));
    }, idleTimeoutMs);
  };

  const onParentAbort = (): void => {
    if (controller.signal.aborted) return;
    clear();
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", onParentAbort);
    }
  }

  arm();

  return {
    signal: controller.signal,
    poke(): void {
      arm();
    },
    dispose(): void {
      disposed = true;
      clear();
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}
