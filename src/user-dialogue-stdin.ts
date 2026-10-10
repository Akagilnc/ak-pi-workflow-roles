/**
 * Typed user-dialogue stdin transport (#879 / #471).
 * Pi's piped-stdin reader trims the wrapper; the body field keeps original bytes.
 * No size cap and no path/pointer substitute — the whole dialogue rides the envelope.
 *
 * #1199: optional summonsInstruction carries the progress 传召词 when it differs
 * from the model-facing body (file-flag transport wrapper). Still stdin — never
 * env/argv body transport.
 */
import { isRecord } from "./unknown-value.ts";

export const USER_DIALOGUE_STDIN_KIND = "ak-user-dialogue" as const;

export type UserDialogueStdinEnvelope = {
  readonly kind: typeof USER_DIALOGUE_STDIN_KIND;
  readonly body: string;
  /** Progress-line 传召词 when distinct from model-facing body. */
  readonly summonsInstruction?: string;
};

export function encodeUserDialogueStdin(
  body: string,
  summonsInstruction?: string,
): string {
  const envelope: UserDialogueStdinEnvelope =
    summonsInstruction !== undefined && summonsInstruction !== body
      ? { kind: USER_DIALOGUE_STDIN_KIND, body, summonsInstruction }
      : { kind: USER_DIALOGUE_STDIN_KIND, body };
  return JSON.stringify(envelope);
}

/** One parse for body + optional progress 传召词 — callers must not re-implement. */
export function tryParseUserDialogueStdin(raw: string): UserDialogueStdinEnvelope | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return undefined;
    const record = parsed as { kind?: unknown; body?: unknown; summonsInstruction?: unknown };
    if (record.kind !== USER_DIALOGUE_STDIN_KIND || typeof record.body !== "string") {
      return undefined;
    }
    if (
      record.summonsInstruction !== undefined
      && typeof record.summonsInstruction !== "string"
    ) {
      return undefined;
    }
    return record.summonsInstruction === undefined
      ? { kind: USER_DIALOGUE_STDIN_KIND, body: record.body }
      : {
        kind: USER_DIALOGUE_STDIN_KIND,
        body: record.body,
        summonsInstruction: record.summonsInstruction,
      };
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

/**
 * #1199 progress 传召词 from the typed stdin envelope when present; otherwise
 * the same bytes as {@link readUserDialogueStdin}.
 */
export function readUserDialogueSummonsInstruction(raw: string): string {
  const parsed = tryParseUserDialogueStdin(raw);
  if (parsed === undefined) return raw;
  return parsed.summonsInstruction ?? parsed.body;
}
