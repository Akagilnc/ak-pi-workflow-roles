/**
 * `ak-role dialogue <session>`: the speaker lines a diary range would project,
 * one JSON object per line, so the diarist searches the dialogue instead of
 * re-deriving the session format (owner 2026-10-21). Same read and adapter as
 * the ticket-provenance projection — no second speaker rule.
 */
import { readLedgerSessionJsonlLines } from "../ledger-session-read.ts";
import { adaptSessionDialogue, type DialogueSpeaker } from "../session-dialogue.ts";

export type SessionDialogueLine = {
  /** 1-based file line, the same `line` a diary range endpoint names. */
  readonly line: number;
  /** Native id, the same `id` a diary range endpoint names; absent when the row has none. */
  readonly id?: string;
  readonly speaker: DialogueSpeaker;
  readonly text: string;
};

export async function readSessionDialogue(path: string): Promise<SessionDialogueLine[]> {
  const sessionLines = await readLedgerSessionJsonlLines(path);
  const dialogue = adaptSessionDialogue(sessionLines.map((entry) => entry.row));
  const out: SessionDialogueLine[] = [];
  sessionLines.forEach((entry, index) => {
    for (const event of dialogue[index] ?? []) {
      out.push({
        line: entry.line,
        ...(event.id === undefined ? {} : { id: event.id }),
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
