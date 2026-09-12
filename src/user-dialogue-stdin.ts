/**
 * Typed user-dialogue stdin transport (#879 / #471).
 * Pi's piped-stdin reader trims the wrapper; the body field keeps original bytes.
 * No size cap and no path/pointer substitute — the whole dialogue rides the envelope.
 */
export const USER_DIALOGUE_STDIN_KIND = "ak-user-dialogue" as const;

export type UserDialogueStdinEnvelope = {
  readonly kind: typeof USER_DIALOGUE_STDIN_KIND;
  readonly body: string;
};

export function encodeUserDialogueStdin(body: string): string {
  return JSON.stringify({ kind: USER_DIALOGUE_STDIN_KIND, body } satisfies UserDialogueStdinEnvelope);
}

function isUserDialogueEnvelope(value: unknown): value is UserDialogueStdinEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { kind?: unknown; body?: unknown };
  return record.kind === USER_DIALOGUE_STDIN_KIND && typeof record.body === "string";
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
