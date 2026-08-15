/**
 * Extension-side OAuth credential keepalive (#351).
 *
 * Periodically calls the public `ctx.modelRegistry.refresh` facade so expired
 * OAuth tokens (e.g. kimi-coding 900s TTL) are renewed during long sessions.
 * Does not read auth.json, touch pi-ai private APIs, or reuse the 183s idle gate.
 */

export const DEFAULT_OAUTH_KEEPALIVE_PROVIDERS = ["kimi-coding"] as const;

export const OAUTH_KEEPALIVE_INTERVAL_MS = 60_000;

/** Injected interval scheduler (same shape as TrajectoryScheduler). */
export type OAuthKeepaliveScheduler = {
  /** Schedule `tick` every `ms` milliseconds; return a cancel function. */
  every: (ms: number, tick: () => void) => () => void;
};

export type OAuthKeepaliveOptions = {
  /** Static provider id list; frozen at construction. Default: ["kimi-coding"]. */
  providers?: readonly string[];
  /** Interval between ticks in ms. Default: 60_000. First tick is after one interval. */
  intervalMs?: number;
  /** Injectable scheduler for tests. Default: setInterval + unref. */
  scheduler?: OAuthKeepaliveScheduler;
};

/** Minimal context surface used by keepalive (public extension facade only). */
export type OAuthKeepaliveContext = {
  modelRegistry: {
    refresh: (options?: {
      allowNetwork?: boolean;
      providers?: readonly string[];
      force?: boolean;
      signal?: AbortSignal;
    }) => Promise<{
      aborted: boolean;
      errors: ReadonlyMap<string, Error>;
    }>;
  };
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
};

export type OAuthKeepalive = {
  start(ctx: OAuthKeepaliveContext): void;
  stop(): void;
};

const defaultScheduler: OAuthKeepaliveScheduler = {
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    // Allow the process to exit if a caller forgets stop (same discipline as trajectory).
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

function errorClassName(error: unknown): string {
  if (error instanceof Error && error.name.trim() !== "") return error.name;
  if (error !== null && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return "Error";
}

function formatWarning(providerId: string, error: unknown): string {
  const cls = errorClassName(error);
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  return `oauth-keepalive: refresh failed for provider ${providerId} (${cls}): ${detail}`;
}

function emitWarning(ctx: OAuthKeepaliveContext, providerId: string, error: unknown): void {
  const text = formatWarning(providerId, error);
  // print/json modes: ui.notify is a no-op — console.warn is the visible surface.
  console.warn(text);
  try {
    ctx.ui?.notify?.(text, "warning");
  } catch {
    // Warning must not fault the keepalive lifecycle.
  }
}

/**
 * Session-lifecycle owner for periodic OAuth refresh via the public modelRegistry facade.
 * Single-flight: overlapping ticks are skipped. stop() cancels the interval and aborts in-flight work.
 */
export function createOAuthKeepalive(options: OAuthKeepaliveOptions = {}): OAuthKeepalive {
  const providers = Object.freeze(
    (options.providers ?? DEFAULT_OAUTH_KEEPALIVE_PROVIDERS).map((id) => id),
  ) as readonly string[];
  const intervalMs = options.intervalMs ?? OAUTH_KEEPALIVE_INTERVAL_MS;
  const scheduler = options.scheduler ?? defaultScheduler;

  let cancel: (() => void) | undefined;
  let abortController: AbortController | undefined;
  let inFlight = false;

  const stop = (): void => {
    cancel?.();
    cancel = undefined;
    abortController?.abort();
    abortController = undefined;
    inFlight = false;
  };

  const runTick = async (ctx: OAuthKeepaliveContext): Promise<void> => {
    if (inFlight) return;
    const ac = abortController;
    if (ac === undefined || ac.signal.aborted) return;
    inFlight = true;
    try {
      const result = await ctx.modelRegistry.refresh({
        providers: [...providers],
        allowNetwork: true,
        signal: ac.signal,
      });
      if (ac.signal.aborted || result.aborted) return;
      for (const [providerId, error] of result.errors) {
        emitWarning(ctx, providerId, error);
      }
    } catch (error) {
      if (ac.signal.aborted) return;
      // Whole-call failure: one warning per configured provider (ticket error surface).
      for (const providerId of providers) {
        emitWarning(ctx, providerId, error);
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    start(ctx) {
      // Reload / re-start: tear down any prior interval before hanging a new one.
      stop();
      abortController = new AbortController();
      cancel = scheduler.every(intervalMs, () => {
        void runTick(ctx);
      });
    },
    stop,
  };
}
