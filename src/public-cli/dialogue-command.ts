/**
 * `ak-role dialogue <session>`: the speaker lines a diary range would project,
 * one JSON object per line, so the diarist searches the dialogue instead of
 * re-deriving the session format (owner 2026-10-21). Same read and adapter as
 * the ticket-provenance projection — no second speaker rule.
 */
import { readLedgerSessionJsonlLines } from "../ledger-session-read.ts";
import { adaptSessionDialogue, type DialogueSpeaker } from "../session-dialogue.ts";
import { assertDialogueSessionSourcePath } from "../ticket-provenance.ts";

export type SessionDialogueLine =
  | {
      /** 1-based file line, the same `line` a diary range endpoint names. */
      readonly line: number;
      /** Native id a range endpoint can name; only on its first line, since an id resolves there. */
      readonly id?: string;
      readonly speaker: DialogueSpeaker;
      readonly text: string;
    }
  | {
      /** Unparsable source line; a range covering it keeps these bytes in the record. */
      readonly line: number;
      readonly raw: string;
    };

export async function readSessionDialogue(path: string, home?: string): Promise<SessionDialogueLine[]> {
  assertDialogueSessionSourcePath(path, home);
  const sessionLines = await readLedgerSessionJsonlLines(path);
  const dialogue = adaptSessionDialogue(sessionLines.map((entry) => entry.row));
  const seenIds = new Set<string>();
  const out: SessionDialogueLine[] = [];
  sessionLines.forEach((entry, index) => {
    if (entry.row === undefined) {
      out.push({ line: entry.line, raw: entry.raw });
      return;
    }
    for (const event of dialogue[index] ?? []) {
      const firstId = event.id !== undefined && !seenIds.has(event.id);
      if (event.id !== undefined) seenIds.add(event.id);
      out.push({
        line: entry.line,
        ...(firstId ? { id: event.id } : {}),
        speaker: event.speaker,
        text: event.text,
      });
    }
  });
  return out;
}

export function renderSessionDialogue(lines: readonly SessionDialogueLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}
