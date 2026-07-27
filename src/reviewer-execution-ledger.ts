import type { CanonicalSkillEvidence } from "./canonical-skill-binding.ts";

type ReviewerSkillEvidence = CanonicalSkillEvidence<"code-review">;

export type ReviewerUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type ReviewerTargetSnapshot = {
  repositoryRoot: string;
  targetHead: string;
  refs: Readonly<Record<string, string>>;
};

export type ReviewerWorkspaceDisposition =
  | "deleted"
  | { retained: string };

export type ReviewerAgentResult = {
  report: string;
  usage?: ReviewerUsage;
  targetSnapshot?: ReviewerTargetSnapshot;
  workspaceDisposition: ReviewerWorkspaceDisposition;
};

export type ReviewerAgentAttempt = {
  id: string;
  description: string;
  prompt: string;
  status: "running" | "successful" | "failed";
  targetSnapshot?: ReviewerTargetSnapshot;
  report?: string;
  usage?: ReviewerUsage;
  diagnostics?: string;
  workspaceDisposition?: ReviewerWorkspaceDisposition;
};

export type ReviewerAgentInvocationBatch = {
  assistantSessionEntryId: string;
  executionMode: "parallel";
  agentToolCallIds: readonly string[];
};

export type ReviewerBashEvidence = {
  toolCallId: string;
  command: string;
  result?: string;
  isError?: boolean;
};

export type ReviewerExecutionRecord = {
  skillEvidence?: ReviewerSkillEvidence;
  targetSnapshot?: ReviewerTargetSnapshot;
  bashEvidence: ReviewerBashEvidence[];
  agentAttempts: ReviewerAgentAttempt[];
  agentInvocationBatches: ReviewerAgentInvocationBatch[];
};

export type ReviewerAgentPersistedEvidence =
  | {
      kind: "assistant";
      entryId: string;
      calls: readonly { id: string; arguments: unknown }[];
    }
  | { kind: "unavailable" }
  | { kind: "non-assistant" };

export type ReviewerAgentFailure = Error & {
  reviewerAgentAttempt: ReviewerAgentAttempt;
};

export type ReviewerExecutionLedger = {
  recordSkillExpansion(evidence: ReviewerSkillEvidence): void;
  beginAgentCall(
    callId: string,
    rawArguments: unknown,
    persistedEvidence: ReviewerAgentPersistedEvidence,
  ): void;
  completeAgentCall(
    callId: string,
    result: ReviewerAgentResult,
  ): ReviewerAgentAttempt;
  failAgentCall(callId: string, error: unknown): ReviewerAgentFailure;
  rejectAgentCall(callId: string, toolResult: string): void;
  recordBashCall(toolCallId: string, command: string): void;
  recordBashResult(
    toolCallId: string,
    result: string,
    isError: boolean,
  ): void;
  recordInfrastructureFailure<T>(error: T): T;
  recordForAudit(status: "completed" | "refused"): ReviewerExecutionRecord;
};

type MutableAttempt = ReviewerAgentAttempt;

type CapturedCall = {
  id: string;
  description: string;
  prompt: string;
};

type CapturedBatch = {
  entryId: string;
  calls: CapturedCall[];
};

type InfrastructureFailureEvidence = {
  diagnostics: string;
  targetSnapshot?: ReviewerTargetSnapshot;
  workspaceDisposition?: ReviewerWorkspaceDisposition;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argument(value: unknown, key: "description" | "prompt"): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function captureCall(id: string, rawArguments: unknown): CapturedCall {
  return {
    id,
    description: argument(rawArguments, "description"),
    prompt: argument(rawArguments, "prompt"),
  };
}

function sameCalls(left: readonly CapturedCall[], right: readonly CapturedCall[]): boolean {
  return left.length === right.length && left.every((call, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      call.id === candidate.id &&
      call.description === candidate.description &&
      call.prompt === candidate.prompt;
  });
}

function cloneSkill(evidence: ReviewerSkillEvidence): ReviewerSkillEvidence {
  return {
    name: "code-review",
    location: evidence.location,
    content: evidence.content,
    userMessage: evidence.userMessage,
  };
}

function sameSkill(left: ReviewerSkillEvidence, right: ReviewerSkillEvidence): boolean {
  return left.name === right.name &&
    left.location === right.location &&
    left.content === right.content &&
    left.userMessage === right.userMessage;
}

function cloneUsage(usage: ReviewerUsage): ReviewerUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

function cloneSnapshot(snapshot: ReviewerTargetSnapshot): ReviewerTargetSnapshot {
  return {
    repositoryRoot: snapshot.repositoryRoot,
    targetHead: snapshot.targetHead,
    refs: { ...snapshot.refs },
  };
}

function cloneDisposition(
  disposition: ReviewerWorkspaceDisposition,
): ReviewerWorkspaceDisposition {
  return disposition === "deleted"
    ? "deleted"
    : { retained: disposition.retained };
}

function errorSnapshot(error: unknown): ReviewerTargetSnapshot | undefined {
  if (!isRecord(error) || !isRecord(error["targetSnapshot"])) return undefined;
  const snapshot = error["targetSnapshot"];
  if (
    typeof snapshot["repositoryRoot"] !== "string" ||
    typeof snapshot["targetHead"] !== "string" ||
    !isRecord(snapshot["refs"]) ||
    !Object.values(snapshot["refs"]).every((value) => typeof value === "string")
  ) {
    return undefined;
  }
  return cloneSnapshot({
    repositoryRoot: snapshot["repositoryRoot"],
    targetHead: snapshot["targetHead"],
    refs: snapshot["refs"] as Record<string, string>,
  });
}

function errorDisposition(
  error: unknown,
): ReviewerWorkspaceDisposition | undefined {
  if (!isRecord(error)) return undefined;
  const disposition = error["workspaceDisposition"];
  if (disposition === "deleted") return "deleted";
  if (isRecord(disposition) && typeof disposition["retained"] === "string") {
    return { retained: disposition["retained"] };
  }
  return undefined;
}

function freezeSkill(evidence: ReviewerSkillEvidence): ReviewerSkillEvidence {
  return Object.freeze(cloneSkill(evidence));
}

function freezeUsage(usage: ReviewerUsage): ReviewerUsage {
  const copy = cloneUsage(usage);
  Object.freeze(copy.cost);
  return Object.freeze(copy);
}

function freezeSnapshot(snapshot: ReviewerTargetSnapshot): ReviewerTargetSnapshot {
  const copy = cloneSnapshot(snapshot);
  Object.freeze(copy.refs);
  return Object.freeze(copy);
}

function freezeDisposition(
  disposition: ReviewerWorkspaceDisposition,
): ReviewerWorkspaceDisposition {
  return disposition === "deleted"
    ? "deleted"
    : Object.freeze({ retained: disposition.retained });
}

function freezeAttempt(attempt: ReviewerAgentAttempt): ReviewerAgentAttempt {
  const copy: ReviewerAgentAttempt = {
    id: attempt.id,
    description: attempt.description,
    prompt: attempt.prompt,
    status: attempt.status,
    ...(attempt.targetSnapshot === undefined
      ? {}
      : { targetSnapshot: freezeSnapshot(attempt.targetSnapshot) }),
    ...(attempt.report === undefined ? {} : { report: attempt.report }),
    ...(attempt.usage === undefined ? {} : { usage: freezeUsage(attempt.usage) }),
    ...(attempt.diagnostics === undefined
      ? {}
      : { diagnostics: attempt.diagnostics }),
    ...(attempt.workspaceDisposition === undefined
      ? {}
      : {
          workspaceDisposition: freezeDisposition(
            attempt.workspaceDisposition,
          ),
        }),
  };
  return Object.freeze(copy);
}

function captureError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createReviewerExecutionLedger(): ReviewerExecutionLedger {
  let skillEvidence: ReviewerSkillEvidence | undefined;
  const attempts = new Map<string, MutableAttempt>();
  const attemptOrder: string[] = [];
  const batches = new Map<string, CapturedBatch>();
  const batchOrder: string[] = [];
  const persistedEntryByCallId = new Map<string, string>();
  const bashEvidence: ReviewerBashEvidence[] = [];
  let infrastructureFailure: InfrastructureFailureEvidence | undefined;

  const captureInfrastructureFailure = (
    diagnostics: string,
    error: unknown,
  ): void => {
    if (infrastructureFailure !== undefined) return;
    const targetSnapshot = errorSnapshot(error);
    const workspaceDisposition = errorDisposition(error);
    infrastructureFailure = {
      diagnostics,
      ...(targetSnapshot === undefined ? {} : { targetSnapshot }),
      ...(workspaceDisposition === undefined
        ? {}
        : { workspaceDisposition }),
    };
  };

  const createAttempt = (call: CapturedCall): MutableAttempt => {
    const attempt: MutableAttempt = {
      id: call.id,
      description: call.description,
      prompt: call.prompt,
      status: "running",
    };
    attempts.set(call.id, attempt);
    attemptOrder.push(call.id);
    return attempt;
  };

  const requireAttempt = (id: string): MutableAttempt => {
    const attempt = attempts.get(id);
    if (attempt === undefined) {
      throw new Error(`Reviewer Agent attempt ${id} was not started`);
    }
    return attempt;
  };

  const requireRunning = (id: string): MutableAttempt => {
    const attempt = requireAttempt(id);
    if (attempt.status !== "running") {
      throw new Error(
        `Reviewer Agent attempt ${id} must be running but is already ${attempt.status}`,
      );
    }
    return attempt;
  };

  const settleFailed = (
    attempt: MutableAttempt,
    diagnostic: string,
    error: unknown,
  ): void => {
    attempt.status = "failed";
    attempt.diagnostics = diagnostic;
    const snapshot = errorSnapshot(error);
    if (snapshot !== undefined) attempt.targetSnapshot = snapshot;
    const disposition = errorDisposition(error);
    if (disposition !== undefined) {
      attempt.workspaceDisposition = disposition;
    }
  };

  const provenanceFailure = (
    callId: string,
    rawArguments: unknown,
    message: string,
  ): never => {
    const failure = new Error(message) as Error & {
      reviewerAgentAttempt?: ReviewerAgentAttempt;
    };
    captureInfrastructureFailure(message, failure);
    let attempt = attempts.get(callId);
    if (attempt === undefined) {
      attempt = createAttempt(captureCall(callId, rawArguments));
    }
    if (attempt.status === "running") {
      settleFailed(attempt, message, failure);
      failure.reviewerAgentAttempt = freezeAttempt(attempt);
    }
    throw failure;
  };

  const recordSkillExpansion = (evidence: ReviewerSkillEvidence): void => {
    const captured = cloneSkill(evidence);
    if (skillEvidence === undefined) {
      skillEvidence = captured;
      return;
    }
    if (!sameSkill(skillEvidence, captured)) {
      throw new Error(
        "Reviewer canonical Skill expansion evidence was already recorded with conflicting evidence",
      );
    }
  };

  const beginAgentCall = (
    callId: string,
    rawArguments: unknown,
    persistedEvidence: ReviewerAgentPersistedEvidence,
  ): void => {
    if (persistedEvidence.kind !== "assistant") {
      return provenanceFailure(
        callId,
        rawArguments,
        "Reviewer Agent invocation provenance failed: the persisted session leaf is not an assistant message",
      );
    }

    const capturedCalls = persistedEvidence.calls.map((call) =>
      captureCall(call.id, call.arguments)
    );
    const ids = capturedCalls.map((call) => call.id);
    if (ids.filter((id) => id === callId).length !== 1) {
      provenanceFailure(
        callId,
        rawArguments,
        `Reviewer Agent invocation provenance failed: current call ${callId} does not occur exactly once in the persisted assistant message`,
      );
    }
    if (new Set(ids).size !== ids.length) {
      provenanceFailure(
        callId,
        rawArguments,
        "Reviewer Agent invocation provenance failed: persisted sibling Agent call IDs are not unique",
      );
    }

    const existingBatch = batches.get(persistedEvidence.entryId);
    if (
      existingBatch !== undefined &&
      !sameCalls(existingBatch.calls, capturedCalls)
    ) {
      provenanceFailure(
        callId,
        rawArguments,
        `Reviewer Agent invocation provenance failed: conflicting batch evidence for assistant session entry ${persistedEvidence.entryId}`,
      );
    }

    for (const id of ids) {
      const owner = persistedEntryByCallId.get(id);
      if (owner !== undefined && owner !== persistedEvidence.entryId) {
        provenanceFailure(
          callId,
          rawArguments,
          `Reviewer Agent invocation provenance failed: Agent attempt ID ${id} is not unique across persisted assistant entries`,
        );
      }
    }

    const persistedCurrent = capturedCalls.find((call) => call.id === callId)!;
    const runtimeCurrent = captureCall(callId, rawArguments);
    if (
      runtimeCurrent.description !== persistedCurrent.description ||
      runtimeCurrent.prompt !== persistedCurrent.prompt
    ) {
      provenanceFailure(
        callId,
        rawArguments,
        `Reviewer Agent invocation provenance failed: runtime arguments for current call ${callId} disagree with the persisted assistant message`,
      );
    }

    const existingAttempt = attempts.get(callId);
    if (existingAttempt !== undefined && existingAttempt.status !== "running") {
      provenanceFailure(
        callId,
        rawArguments,
        `Reviewer Agent invocation lifecycle failed: attempt ${callId} is already ${existingAttempt.status}`,
      );
    }

    if (existingBatch === undefined) {
      const batch: CapturedBatch = {
        entryId: persistedEvidence.entryId,
        calls: capturedCalls.map((call) => ({ ...call })),
      };
      batches.set(batch.entryId, batch);
      batchOrder.push(batch.entryId);
      for (const call of batch.calls) {
        persistedEntryByCallId.set(call.id, batch.entryId);
        if (!attempts.has(call.id)) {
          createAttempt(call);
        }
      }
    }

    requireRunning(callId);
  };

  const completeAgentCall = (
    callId: string,
    result: ReviewerAgentResult,
  ): ReviewerAgentAttempt => {
    const attempt = requireRunning(callId);
    if (result.report.trim().length === 0) {
      throw new Error("Reviewer Agent returned a blank child report");
    }
    attempt.status = "successful";
    attempt.report = result.report;
    attempt.workspaceDisposition = cloneDisposition(result.workspaceDisposition);
    if (result.usage !== undefined) attempt.usage = cloneUsage(result.usage);
    if (result.targetSnapshot !== undefined) {
      attempt.targetSnapshot = cloneSnapshot(result.targetSnapshot);
    }
    return freezeAttempt(attempt);
  };

  const failAgentCall = (
    callId: string,
    error: unknown,
  ): ReviewerAgentFailure => {
    const attempt = requireRunning(callId);
    const failure = captureError(error) as ReviewerAgentFailure;
    const diagnostic = failure.message;
    settleFailed(attempt, diagnostic, error);
    captureInfrastructureFailure(diagnostic, error);
    Object.assign(failure, { reviewerAgentAttempt: freezeAttempt(attempt) });
    return failure;
  };

  const rejectAgentCall = (callId: string, toolResult: string): void => {
    let attempt = attempts.get(callId);
    if (attempt === undefined) {
      attempt = createAttempt(captureCall(callId, undefined));
    }
    if (attempt.status === "running") {
      settleFailed(attempt, toolResult, undefined);
      return;
    }
    if (attempt.status === "failed" && attempt.diagnostics === toolResult) {
      return;
    }
    throw new Error(
      `Reviewer Agent attempt ${callId} cannot be rejected after it settled ${attempt.status}`,
    );
  };

  const recordBashCall = (toolCallId: string, command: string): void => {
    bashEvidence.push({ toolCallId, command });
  };

  const recordBashResult = (
    toolCallId: string,
    result: string,
    isError: boolean,
  ): void => {
    const evidence = bashEvidence.find((item) => item.toolCallId === toolCallId);
    if (evidence === undefined) return;
    evidence.result = result;
    evidence.isError = isError;
  };

  const recordInfrastructureFailure = <T>(error: T): T => {
    const diagnostics = error instanceof Error ? error.message : String(error);
    captureInfrastructureFailure(diagnostics, error);
    return error;
  };

  const recordForAudit = (
    status: "completed" | "refused",
  ): ReviewerExecutionRecord => {
    if (infrastructureFailure !== undefined) {
      throw Object.assign(
        new Error(
          `Reviewer infrastructure previously failed: ${infrastructureFailure.diagnostics}`,
        ),
        { fatalReviewerInfrastructure: true as const },
      );
    }

    if (status === "completed") {
      if (skillEvidence === undefined) {
        throw new Error(
          "Reviewer completed requires exact native code-review Skill expansion evidence",
        );
      }
      const persistedIds = batchOrder.flatMap(
        (entryId) => batches.get(entryId)?.calls.map((call) => call.id) ?? [],
      );
      if (persistedIds.length === 0 && attemptOrder.length === 0) {
        throw new Error(
          "Reviewer completed requires at least one successful Agent call",
        );
      }
      const attemptIds = [...attemptOrder];
      const persistedUnique = new Set(persistedIds);
      const attemptUnique = new Set(attemptIds);
      const missing = [...persistedUnique].filter((id) => !attemptUnique.has(id));
      const extras = [...attemptUnique].filter((id) => !persistedUnique.has(id));
      const failed = attemptOrder
        .map((id) => attempts.get(id)!)
        .filter((attempt) => attempt.status === "failed");
      const running = attemptOrder
        .map((id) => attempts.get(id)!)
        .filter((attempt) => attempt.status === "running");
      if (
        persistedUnique.size !== persistedIds.length ||
        attemptUnique.size !== attemptIds.length ||
        persistedIds.length !== attemptIds.length ||
        missing.length > 0 ||
        extras.length > 0 ||
        failed.length > 0 ||
        running.length > 0 ||
        attemptOrder.some((id) => attempts.get(id)?.status !== "successful")
      ) {
        const failedDiagnostics = failed.map(
          (attempt) =>
            `${attempt.id}: ${attempt.diagnostics ?? "failed without diagnostics"}`,
        );
        throw new Error([
          "Reviewer completed requires persisted Agent call IDs and attempts to form a non-empty exact one-to-one match with every Agent call successful and settled",
          missing.length === 0 ? "" : `missing attempts: ${missing.join(", ")}`,
          extras.length === 0 ? "" : `extra attempts: ${extras.join(", ")}`,
          running.length === 0
            ? ""
            : `running attempts: ${running.map((attempt) => attempt.id).join(", ")}`,
          failedDiagnostics.length === 0
            ? ""
            : `failed attempts: ${failedDiagnostics.join("; ")}`,
        ].filter((part) => part.length > 0).join("; "));
      }
    }

    const frozenAttempts = attemptOrder.map((id) =>
      freezeAttempt(attempts.get(id)!)
    );
    const frozenBatches = batchOrder.map((entryId) => {
      const batch = batches.get(entryId)!;
      const ids = Object.freeze(batch.calls.map((call) => call.id));
      return Object.freeze({
        assistantSessionEntryId: batch.entryId,
        executionMode: "parallel" as const,
        agentToolCallIds: ids,
      });
    });
    const frozenBash = bashEvidence.map((evidence) => Object.freeze({
      toolCallId: evidence.toolCallId,
      command: evidence.command,
      ...(evidence.result === undefined ? {} : { result: evidence.result }),
      ...(evidence.isError === undefined ? {} : { isError: evidence.isError }),
    }));
    const targetSnapshot = attemptOrder
      .map((id) => attempts.get(id)?.targetSnapshot)
      .find((snapshot) => snapshot !== undefined);
    const record: ReviewerExecutionRecord = {
      ...(skillEvidence === undefined
        ? {}
        : { skillEvidence: freezeSkill(skillEvidence) }),
      ...(targetSnapshot === undefined
        ? {}
        : { targetSnapshot: freezeSnapshot(targetSnapshot) }),
      bashEvidence: Object.freeze(frozenBash) as unknown as ReviewerBashEvidence[],
      agentAttempts: Object.freeze(frozenAttempts) as unknown as ReviewerAgentAttempt[],
      agentInvocationBatches: Object.freeze(frozenBatches) as unknown as ReviewerAgentInvocationBatch[],
    };
    return Object.freeze(record);
  };

  return Object.freeze({
    recordSkillExpansion,
    beginAgentCall,
    completeAgentCall,
    failAgentCall,
    rejectAgentCall,
    recordBashCall,
    recordBashResult,
    recordInfrastructureFailure,
    recordForAudit,
  });
}
