/**
 * Typed user-dialogue stdin transport (#879 / #471).
 * Pi's piped-stdin reader trims the wrapper; the body field keeps original bytes.
 * No size cap and no path/pointer substitute — the whole dialogue rides the envelope.
 *
 * #1199: progress-line instruction is these same body bytes (what the seat
 * actually receives). No parallel 传召词 field on the envelope.
 */
import { isRecord } from "./unknown-value.ts";

export const USER_DIALOGUE_STDIN_KIND = "ak-user-dialogue" as const;

export type UserDialogueStdinEnvelope = {
  readonly kind: typeof USER_DIALOGUE_STDIN_KIND;
  readonly body: string;
};

export function encodeUserDialogueStdin(body: string): string {
  const envelope: UserDialogueStdinEnvelope = { kind: USER_DIALOGUE_STDIN_KIND, body };
  return JSON.stringify(envelope);
}

/** One parse for the model-facing body — callers must not re-implement. */
export function tryParseUserDialogueStdin(raw: string): UserDialogueStdinEnvelope | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return undefined;
    const record = parsed as { kind?: unknown; body?: unknown };
    if (record.kind !== USER_DIALOGUE_STDIN_KIND || typeof record.body !== "string") {
      return undefined;
    }
    return { kind: USER_DIALOGUE_STDIN_KIND, body: record.body };
  } catch {
    return undefined;
  }
}

/**
 * Host read: recover original dialogue after a trim-capable pipe.
 * Non-envelope text (interactive Pi, officer JSON, headless raw body) is unchanged.
 */
export function readUserDialogueStdin(raw: string): string {
  return tryParseUserDialogueStdin(raw)?.body ?? raw;
}
