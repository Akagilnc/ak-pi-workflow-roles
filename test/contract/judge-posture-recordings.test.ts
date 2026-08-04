import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";

/**
 * Synthetic JSONL acceptance-parser suite.
 *
 * Recorded r-block / r-ready corpora and soul byte-pins (soulDigest,
 * sessionContainsSoul, packageSha packaging oracles) were removed under
 * issue #97. Standing CI must stay immune to soul wording changes.
 * Anti-forge lives in src/judge-recording-anti-forge.ts and is exercised
 * only by a synthetic unit tracer.
 */

type JudgeDetails = {
  judgeStatus: string;
  fix?: { summary?: string };
  note?: string;
  decisionGate?: unknown;
};

type AcceptedOutput = {
  details: JudgeDetails;
  contentText: string;
  isError: false;
  toolCallId: string;
};

function contentTextFromUnknown(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type?: string }).type === "text" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("\n");
}

function extractAcceptedJudgeOutputs(rows: unknown[]): AcceptedOutput[] {
  // Accept only an unambiguous ordered lifecycle per non-empty toolCallId:
  // exactly one assistant-issued toolCall → exactly one matching start →
  // ≥1 agreeing terminal(s), with strict row order call < start < terminals.
  // Same-id replay/conflict (multiple calls or starts) rejects; no last-write.
  type IssuedEvent = { index: number; args: unknown };
  type StartEvent = { index: number; args: unknown };
  type TerminalEvent = {
    index: number;
    contentText: string;
    details: JudgeDetails;
  };
  type IdLifecycle = {
    issued: IssuedEvent[];
    starts: StartEvent[];
    terminals: TerminalEvent[];
  };

  const byId = new Map<string, IdLifecycle>();
  const lifecycleFor = (toolCallId: string): IdLifecycle => {
    const existing = byId.get(toolCallId);
    if (existing) return existing;
    const created: IdLifecycle = { issued: [], starts: [], terminals: [] };
    byId.set(toolCallId, created);
    return created;
  };

  const pushTerminal = (
    index: number,
    toolCallId: unknown,
    isError: unknown,
    content: unknown,
    details: unknown,
  ): void => {
    // Explicit success only — missing/undefined isError does not count.
    if (isError !== false) return;
    if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) return;
    const text = contentTextFromUnknown(content);
    if (!text.includes("Judge verdict accepted")) return;
    if (!details || typeof details !== "object" || Array.isArray(details)) return;
    lifecycleFor(toolCallId).terminals.push({
      index,
      contentText: text,
      details: details as JudgeDetails,
    });
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;

    if (
      record.type === "message_end" &&
      record.message &&
      typeof record.message === "object"
    ) {
      const message = record.message as Record<string, unknown>;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (
            !part ||
            typeof part !== "object" ||
            (part as { type?: string }).type !== "toolCall" ||
            (part as { name?: string }).name !== "ak_judge_output"
          ) {
            continue;
          }
          const id = (part as { id?: unknown }).id;
          const args = (part as { arguments?: unknown }).arguments;
          if (typeof id !== "string" || id.trim().length === 0) continue;
          if (!args || typeof args !== "object" || Array.isArray(args)) continue;
          lifecycleFor(id).issued.push({ index: i, args });
        }
      }
    }

    if (
      record.type === "tool_execution_start" &&
      record.toolName === "ak_judge_output" &&
      typeof record.toolCallId === "string" &&
      record.toolCallId.trim().length > 0 &&
      record.args &&
      typeof record.args === "object" &&
      !Array.isArray(record.args)
    ) {
      lifecycleFor(record.toolCallId).starts.push({
        index: i,
        args: record.args,
      });
      continue;
    }

    if (
      record.type === "tool_execution_end" &&
      record.toolName === "ak_judge_output"
    ) {
      const result = record.result;
      if (!result || typeof result !== "object") continue;
      const resultRecord = result as Record<string, unknown>;
      pushTerminal(
        i,
        record.toolCallId,
        record.isError,
        resultRecord.content,
        resultRecord.details,
      );
      continue;
    }

    if (
      (record.type === "message" || record.type === "message_end") &&
      record.message &&
      typeof record.message === "object"
    ) {
      const message = record.message as Record<string, unknown>;
      if (
        message.role === "toolResult" &&
        message.toolName === "ak_judge_output"
      ) {
        pushTerminal(
          i,
          message.toolCallId,
          message.isError,
          message.content,
          message.details,
        );
      }
    }
  }

  const accepted: AcceptedOutput[] = [];
  for (const [toolCallId, lifecycle] of byId) {
    const { issued, starts, terminals } = lifecycle;
    // Exactly one issuance and one start; reject same-id replay/conflict.
    if (issued.length !== 1 || starts.length !== 1 || terminals.length === 0) {
      continue;
    }

    const soleIssued = issued[0]!;
    const soleStart = starts[0]!;
    if (!(soleIssued.index < soleStart.index)) continue;
    if (!terminals.every((terminal) => terminal.index > soleStart.index)) {
      continue;
    }

    if (!isDeepStrictEqual(soleIssued.args, soleStart.args)) continue;

    // All terminal representations for one id must agree; disagreement rejects.
    const [first, ...rest] = terminals;
    if (
      rest.some(
        (terminal) =>
          !isDeepStrictEqual(terminal.details, first!.details) ||
          terminal.contentText !== first!.contentText,
      )
    ) {
      continue;
    }

    if (!isDeepStrictEqual(first!.details, soleIssued.args)) continue;

    accepted.push({
      toolCallId,
      isError: false,
      contentText: first!.contentText,
      details: first!.details,
    });
  }

  return accepted;
}

function acceptedDetails(status: string = "converged"): JudgeDetails {
  return {
    judgeStatus: status,
    note: "synthetic",
  };
}

function syntheticAssistantCall(
  toolCallId: string,
  details: JudgeDetails = acceptedDetails(),
): unknown {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: toolCallId,
          name: "ak_judge_output",
          arguments: details,
        },
      ],
    },
  };
}

function syntheticExecutionStart(
  toolCallId: string,
  details: JudgeDetails = acceptedDetails(),
): unknown {
  return {
    type: "tool_execution_start",
    toolName: "ak_judge_output",
    toolCallId,
    args: details,
  };
}

function syntheticAcceptedEnd(
  toolCallId: string,
  isError: unknown,
  details: JudgeDetails = acceptedDetails(),
): unknown {
  return {
    type: "tool_execution_end",
    toolName: "ak_judge_output",
    toolCallId,
    isError,
    result: {
      content: [{ type: "text", text: "Judge verdict accepted" }],
      details,
    },
  };
}

function syntheticAcceptedMessageEnd(
  toolCallId: string,
  details: JudgeDetails = acceptedDetails(),
): unknown {
  return {
    type: "message_end",
    message: {
      role: "toolResult",
      toolName: "ak_judge_output",
      toolCallId,
      isError: false,
      content: [{ type: "text", text: "Judge verdict accepted" }],
      details,
    },
  };
}

function syntheticBoundAcceptedChain(
  toolCallId: string,
  details: JudgeDetails = acceptedDetails(),
): unknown[] {
  return [
    syntheticAssistantCall(toolCallId, details),
    syntheticExecutionStart(toolCallId, details),
    syntheticAcceptedEnd(toolCallId, false, details),
    syntheticAcceptedMessageEnd(toolCallId, details),
  ];
}

test("acceptance parser rejects orphan terminal without assistant call and start", () => {
  const rows = [syntheticAcceptedEnd("orphan-end", false)];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects orphan toolResult message without call chain", () => {
  const rows = [syntheticAcceptedMessageEnd("orphan-message")];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects missing isError even with full bind chain", () => {
  const details = acceptedDetails();
  const rows = [
    syntheticAssistantCall("call-missing-flag", details),
    syntheticExecutionStart("call-missing-flag", details),
    syntheticAcceptedEnd("call-missing-flag", undefined, details),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects same-id terminals with conflicting details", () => {
  const early = acceptedDetails("continue");
  const late = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("call-conflict", early),
    syntheticExecutionStart("call-conflict", early),
    syntheticAcceptedEnd("call-conflict", false, early),
    syntheticAcceptedMessageEnd("call-conflict", late),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects call/start argument mismatch", () => {
  const issued = acceptedDetails("continue");
  const started = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("call-mismatch", issued),
    syntheticExecutionStart("call-mismatch", started),
    syntheticAcceptedEnd("call-mismatch", false, issued),
    syntheticAcceptedMessageEnd("call-mismatch", issued),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects terminal details that diverge from issued arguments", () => {
  const issued = acceptedDetails("continue");
  const terminal = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("call-details-drift", issued),
    syntheticExecutionStart("call-details-drift", issued),
    syntheticAcceptedEnd("call-details-drift", false, terminal),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects out-of-order terminal before call and start", () => {
  const details = acceptedDetails();
  const rows = [
    syntheticAcceptedEnd("call-order-terminal-first", false, details),
    syntheticAssistantCall("call-order-terminal-first", details),
    syntheticExecutionStart("call-order-terminal-first", details),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects out-of-order start before call", () => {
  const details = acceptedDetails();
  const rows = [
    syntheticExecutionStart("call-order-start-first", details),
    syntheticAssistantCall("call-order-start-first", details),
    syntheticAcceptedEnd("call-order-start-first", false, details),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects conflicting or replayed assistant calls for one id", () => {
  const first = acceptedDetails("continue");
  const second = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("call-replayed", first),
    syntheticAssistantCall("call-replayed", second),
    syntheticExecutionStart("call-replayed", second),
    syntheticAcceptedEnd("call-replayed", false, second),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects conflicting or replayed starts for one id", () => {
  const first = acceptedDetails("continue");
  const second = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("start-replayed", second),
    syntheticExecutionStart("start-replayed", first),
    syntheticExecutionStart("start-replayed", second),
    syntheticAcceptedEnd("start-replayed", false, second),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser keeps two distinct fully-bound ids with identical details", () => {
  const details = acceptedDetails();
  const rows = [
    ...syntheticBoundAcceptedChain("call-a", details),
    ...syntheticBoundAcceptedChain("call-b", details),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 2);
  // Bundle rule: exactly one distinct accepted id
  assert.notEqual(accepted.length, 1);
});

test("acceptance parser binds full chain and merges agreeing terminals for one id", () => {
  const details = acceptedDetails();
  const rows = syntheticBoundAcceptedChain("call-same", details);
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.toolCallId, "call-same");
  assert.deepEqual(accepted[0]!.details, details);
});
