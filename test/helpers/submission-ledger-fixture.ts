/**
 * Drive the production submission ledger producer from fixtures that already
 * materialize an accepted packaged output (session JSONL or direct settle).
 * One seam for all public-cli tracers — no parallel JSONL→ledger rebuild.
 */
import { readFile } from "node:fs/promises";
import type { HostContext, HostToolDefinition, RoleHost } from "../../src/host-contracts.ts";
import { validateRecordedDoctorOutput } from "../../src/doctor-contracts.ts";
import { validateMergerOutput } from "../../src/merger-contracts.ts";
import { validateRecordedNotaryOutput } from "../../src/notary-contracts.ts";
import { validateAcceptedCollectorReceipt } from "../../src/package-contracts/collector-output.ts";
import { validateFixerOutput } from "../../src/package-contracts/fixer-output.ts";
import { validateAcceptedJudgeDetails } from "../../src/package-contracts/judge-output.ts";
import { validateRuntimeReviewerReceipt } from "../../src/package-contracts/reviewer-output.ts";
import { validateAcceptedCoderDetails } from "../../src/package-contracts/worker-output.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { createSubmissionLedgerHost, readSealedSubmission } from "../../src/submission-ledger.ts";
import { Type } from "typebox";

function isLawfulAcceptedDetails(role: TerminalRoleName, details: unknown): boolean {
  try {
    switch (role) {
      case "judge":
        validateAcceptedJudgeDetails(details);
        return true;
      case "coder":
        validateAcceptedCoderDetails(details);
        return true;
      case "fixer":
        validateFixerOutput(details);
        return true;
      case "reviewer":
        validateRuntimeReviewerReceipt(details);
        return true;
      case "collector":
        validateAcceptedCollectorReceipt(details);
        return true;
      case "doctor":
        validateRecordedDoctorOutput(details);
        return true;
      case "merger":
        validateMergerOutput(details);
        return true;
      case "notary":
        validateRecordedNotaryOutput(details);
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

const OUTPUT_BY_TOOL: ReadonlyMap<string, TerminalRoleName> = new Map(
  PACKAGED_ROLE_REGISTRY.map(({ role, outputTool }) => [outputTool, role as TerminalRoleName]),
);

export async function sealAcceptedSubmission(input: {
  readonly cwd: string;
  readonly runDirectory: string;
  readonly role: TerminalRoleName;
  readonly toolName: string;
  readonly details: unknown;
  readonly toolCallId?: string;
  readonly home?: string;
}): Promise<void> {
  const toolCallId = input.toolCallId ?? "seal-1";
  const runId = input.runDirectory.split("/").pop()?.split("@")[0] ?? "unbound";
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorHome = process.env.HOME;
  process.env.AK_ROLE_RUN_DIR = input.runDirectory;
  if (input.home !== undefined) process.env.HOME = input.home;
  try {
    if (await readSealedSubmission(input.cwd, runId) !== undefined) return;
    let registered: HostToolDefinition | undefined;
    const host = {
      registerTool(tool: HostToolDefinition) {
        registered = tool;
      },
    } as RoleHost;
    createSubmissionLedgerHost(host, new Map([[input.toolName, input.role]])).registerTool({
      name: input.toolName,
      label: input.toolName,
      description: "",
      parameters: Type.Object({}),
      async execute() {
        return { content: [], details: input.details, terminate: true };
      },
    });
    const context = {
      cwd: input.cwd,
      mode: "json",
      model: undefined,
      sessionManager: {},
      abort() {},
      terminationBatch: {
        batchClosed: true as const,
        calls: [{ id: toolCallId, name: input.toolName }],
      },
    } as unknown as HostContext;
    await registered!.execute(toolCallId, {}, undefined, undefined, context);
  } finally {
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = priorRun;
    if (input.home !== undefined) {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  }
}

/** Seal the latest accepted packaged output already present on a session file. */
export async function sealAcceptedSubmissionFromSession(input: {
  readonly cwd: string;
  readonly runDirectory: string;
  readonly sessionFile: string;
  readonly home?: string;
}): Promise<void> {
  let text: string;
  try {
    text = await readFile(input.sessionFile, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const message = (parsed as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) continue;
    const record = message as {
      role?: unknown;
      toolName?: unknown;
      toolCallId?: unknown;
      isError?: unknown;
      details?: unknown;
    };
    if (record.role !== "toolResult" || record.isError === true) continue;
    if (typeof record.toolName !== "string") continue;
    const role = OUTPUT_BY_TOOL.get(record.toolName);
    if (role === undefined) continue;
    if (!isLawfulAcceptedDetails(role, record.details)) continue;
    await sealAcceptedSubmission({
      cwd: input.cwd,
      runDirectory: input.runDirectory,
      role,
      toolName: record.toolName,
      details: record.details,
      ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
      ...(input.home === undefined ? {} : { home: input.home }),
    });
    return;
  }
}
