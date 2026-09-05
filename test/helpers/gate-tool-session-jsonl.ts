/**
 * Shared JSONL volume builder for accepted/rejected/omitted gate tool receipts.
 *
 * Sole fixture shape for auditor-roles session volumes used by gate Terminal
 * tracers and analyst gate-cycle tracers — do not fork a second local copy.
 */
export type GateToolSessionReceipt = "accepted" | "rejected" | "omit";

export function gateToolSessionJsonl(input: {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** Session header cwd; readers do not key on it, but keep volumes realistic. */
  readonly cwd?: string;
  /** Default accepted receipt. `rejected` = isError toolResult; `omit` = no toolResult. */
  readonly receipt?: GateToolSessionReceipt;
  /**
   * Durable parent-attempt association (`ak_auditor_parent_attempt_binding`).
   * Historical dispatch↔officer pairs must share this typed key.
   */
  readonly attemptEntryId?: string;
  /** Optional parent session file on the binding (#636 multi-parent memory filter). */
  readonly parentSessionFile?: string;
  /**
   * When false, omit the session header — used to append a second summons onto an
   * existing continuous ticket-seat volume (#636 interval read).
   */
  readonly includeHeader?: boolean;
}): string {
  const receipt = input.receipt ?? "accepted";
  const header = {
    type: "session",
    version: 3,
    id: input.id,
    timestamp: input.startedAt,
    cwd: input.cwd ?? "/tmp/gate-tool-session",
  };
  const call = {
    type: "message",
    id: `${input.id}-call`,
    parentId: null,
    timestamp: input.endedAt,
    message: {
      role: "assistant",
      timestamp: input.endedAt,
      content: [
        {
          type: "toolCall",
          id: `call_${input.id}`,
          name: input.toolName,
          arguments: input.args,
        },
      ],
    },
  };
  const binding =
    input.attemptEntryId === undefined
      ? undefined
      : {
          type: "custom",
          customType: "ak_auditor_parent_attempt_binding",
          id: `${input.id}-binding`,
          parentId: null,
          timestamp: input.startedAt,
          data: {
            version: 1,
            parent: {
              attemptEntryId: input.attemptEntryId,
              ...(input.parentSessionFile === undefined
                ? {}
                : { sessionFile: input.parentSessionFile }),
            },
          },
        };
  const prefixRows: unknown[] = [];
  if (input.includeHeader !== false) prefixRows.push(header);
  if (binding !== undefined) prefixRows.push(binding);
  const prefix = prefixRows;
  if (receipt === "omit") {
    // Tail keeps span endedAt without a toolResult — unpaired call is not a receipt.
    const tail = {
      type: "message",
      id: `${input.id}-tail`,
      parentId: `${input.id}-call`,
      timestamp: input.endedAt,
      message: {
        role: "user",
        timestamp: input.endedAt,
        content: [{ type: "text", text: "no-result" }],
      },
    };
    return [...prefix, call, tail].map((row) => JSON.stringify(row)).join("\n") + "\n";
  }
  const tail = {
    type: "message",
    id: `${input.id}-tail`,
    parentId: `${input.id}-call`,
    timestamp: input.endedAt,
    message: {
      role: "toolResult",
      toolCallId: `call_${input.id}`,
      toolName: input.toolName,
      timestamp: input.endedAt,
      isError: receipt === "rejected",
      content: [{ type: "text", text: receipt === "rejected" ? "rejected" : "ok" }],
    },
  };
  return [...prefix, call, tail].map((row) => JSON.stringify(row)).join("\n") + "\n";
}
