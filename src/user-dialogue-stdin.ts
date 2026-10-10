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

function isUserDialogueEnvelope(value: unknown): value is UserDialogueStdinEnvelope {
  if (!isRecord(value)) return false;
  const record = value as { kind?: unknown; body?: unknown; summonsInstruction?: unknown };
  if (record.kind !== USER_DIALOGUE_STDIN_KIND || typeof record.body !== "string") return false;
  if (
    record.summonsInstruction !== undefined
    && typeof record.summonsInstruction !== "string"
  ) {
    return false;
  }
  return true;
}

/**
 * Host read: recover original dialogue after a trim-capable pipe.
 * Non-envelope text (interactive Pi, officer JSON, headless raw body) is unchanged.
 */
export function readUserDialogueStdin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isUserDialogueEnvelope(parsed)) return parsed.body;
  } catch {
    // Not our envelope — leave caller bytes intact.
  }
  return raw;
}

/**
 * #1199 progress 传召词 from the typed stdin envelope when present; otherwise
 * the same bytes as {@link readUserDialogueStdin}.
 */
export function readUserDialogueSummonsInstruction(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isUserDialogueEnvelope(parsed)) {
      return parsed.summonsInstruction ?? parsed.body;
    }
  } catch {
    // Not our envelope — leave caller bytes intact.
  }
  return raw;
}
