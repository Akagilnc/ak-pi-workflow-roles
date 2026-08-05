/**
 * Stream idle backstop (#102 / #155 a): first-wait + between-event silence only.
 * Not a total wall-clock for long thinking turns.
 *
 * Default silence budget is owner-final 183s (#102 2026-08-04),
 * same numeric value as header timeoutMs but a distinct body-idle clock.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 183_000;
export const STREAM_IDLE_TIMEOUT_CODE = "AK_STREAM_IDLE_TIMEOUT";
export class StreamIdleTimeoutError extends Error {
    code = STREAM_IDLE_TIMEOUT_CODE;
    idleTimeoutMs;
    constructor(idleTimeoutMs, options) {
        super(`stream idle timeout after ${idleTimeoutMs}ms`, options);
        this.name = "StreamIdleTimeoutError";
        this.idleTimeoutMs = idleTimeoutMs;
    }
}
export function isStreamIdleTimeoutError(value) {
    return value instanceof StreamIdleTimeoutError
        || (typeof value === "object"
            && value !== null
            && value.name === "StreamIdleTimeoutError"
            && value.code === STREAM_IDLE_TIMEOUT_CODE);
}
export function createStreamIdleGuard(options = {}) {
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    const parentSignal = options.parentSignal;
    const controller = new AbortController();
    let timer;
    let disposed = false;
    const clear = () => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    const arm = () => {
        if (disposed || controller.signal.aborted || idleTimeoutMs <= 0)
            return;
        clear();
        timer = setTimeout(() => {
            timer = undefined;
            if (disposed || controller.signal.aborted)
                return;
            controller.abort(new StreamIdleTimeoutError(idleTimeoutMs));
        }, idleTimeoutMs);
    };
    const onParentAbort = () => {
        if (controller.signal.aborted)
            return;
        clear();
        controller.abort(parentSignal?.reason);
    };
    if (parentSignal !== undefined) {
        if (parentSignal.aborted) {
            controller.abort(parentSignal.reason);
        }
        else {
            parentSignal.addEventListener("abort", onParentAbort);
        }
    }
    arm();
    return {
        signal: controller.signal,
        poke() {
            arm();
        },
        dispose() {
            disposed = true;
            clear();
            parentSignal?.removeEventListener("abort", onParentAbort);
        },
    };
}
