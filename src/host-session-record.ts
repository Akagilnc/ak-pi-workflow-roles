/**
 * Non-pi host turn events → sitian sole entry (ADR 0065 / 0077 / #811).
 * Adapters capture host-native structured events; this helper only packages
 * the common sitianReport call. session.jsonl stays header-only (#617 DK-4).
 * Write failures propagate (SitianInfrastructureError) — not best-effort.
 */
import { sitianReport } from "./sitian-facade.ts";

/** Volume category under `<run>/session/<kind>/records.jsonl`. */
export const HOST_SESSION_RECORD_KIND = "host-session" as const;

function eventField(event: unknown, key: string): string | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return undefined;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Live write of one host-emitted structured event. Throws on sitian persistence failure. */
export function reportHostSessionEvent(input: {
  readonly host: string;
  readonly cwd: string;
  readonly sessionParent: string;
  readonly source: string;
  readonly event: unknown;
  readonly identity?: string;
  readonly timestamp?: string;
}): void {
  const identity = input.identity ?? eventField(input.event, "uuid");
  const timestamp = input.timestamp ?? eventField(input.event, "timestamp");
  sitianReport({
    level: "event",
    kind: HOST_SESSION_RECORD_KIND,
    host: input.host,
    cwd: input.cwd,
    sessionParent: input.sessionParent,
    source: input.source,
    payload: input.event,
    ...(identity === undefined ? {} : { identity }),
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}
