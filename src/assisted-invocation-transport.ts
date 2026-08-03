import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./canonical-json.ts";
import { sha256Hex } from "./sha256.ts";
import { assistedRunDirectory } from "./assisted-ledger.ts";
import type { AssistedInvocationTransportV1, NavigatorInvocationSettlementV1, RoleInvocationSettlementV1 } from "./assisted-runner.ts";
import type { AssistedCallConfigV1, AssistedTerminalClass } from "./assisted-contracts.ts";
import type { NavigatorReceiptV1 } from "./navigator-contracts.ts";
import { createGitCliTransportV1 } from "./assisted-acquisition.ts";
import { isAuditEscalationResult, type AuditEscalationResult } from "./audit-escalation.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.ts";
import {
  FIXER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  isTerminatingToolName,
  validateAcceptedDetails,
  validateAcceptedLifecycle,
} from "./package-contracts/terminating-tools.ts";

type LocalReceipt = {
  artifactKind: "acceptedReceipt" | "roleEscalation";
  details: unknown;
  toolCallId: string;
  toolName: string;
};
type ChildFact = { exitCode: number | null; signal: NodeJS.Signals | null };
type LocalInvocation = { receipt: LocalReceipt | null; evidenceRead: Array<{ evidenceId: string; fullyRead: boolean }>; reference: { id: string; sha256: string }; child: ChildFact };

function childFact(value: unknown): ChildFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("private invocation child fact malformed");
  const fact = value as Record<string, unknown>;
  if (Object.keys(fact).sort().join(",") !== "exitCode,signal" || !(fact.exitCode === null || Number.isInteger(fact.exitCode)) || !(fact.signal === null || typeof fact.signal === "string")) throw new Error("private invocation child fact malformed");
  return fact as ChildFact;
}

function childFailed(child: ChildFact) { return child.signal !== null || child.exitCode !== 0; }

function isAuditedRoleOutputTool(toolName: string): boolean {
  return toolName === JUDGE_OUTPUT_TOOL_NAME ||
    toolName === FIXER_OUTPUT_TOOL_NAME ||
    toolName === REVIEWER_OUTPUT_TOOL_NAME ||
    toolName === DOCTOR_OUTPUT_TOOL_NAME;
}

async function store(path: string, value: unknown) {
  const text = `${canonicalJson(value)}\n`;
  await writeFile(path, text, { flag: "wx", mode: 0o600 });
  return { text, sha256: sha256Hex(text) };
}

function modelArgs(argv: string[]) {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]!.split("=", 1)[0]!;
    if (["--provider", "--model", "--thinking"].includes(key)) {
      out.push(argv[i]!);
      if (argv[i] === key && argv[i + 1]) out.push(argv[++i]!);
    }
  }
  return out;
}

function effectiveEnv(config: AssistedCallConfigV1, base: NodeJS.ProcessEnv) {
  const policy = config.execution.environment;
  const env: NodeJS.ProcessEnv = policy.inherit ? { ...base } : {};
  for (const name of policy.unset) delete env[name];
  Object.assign(env, policy.overrides);
  return env;
}

type Interval = [number, number];
function mergeRange(ranges: Interval[], start: number, end: number) {
  let i = 0;
  while (i < ranges.length && ranges[i]![1] < start) i++;
  while (i < ranges.length && ranges[i]![0] <= end) {
    start = Math.min(start, ranges[i]![0]);
    end = Math.max(end, ranges[i]![1]);
    ranges.splice(i, 1);
  }
  ranges.splice(i, 0, [start, end]);
}

export function nativeSessionEvidenceReads(sessionText: string) {
  const coverage = new Map<string, { total: number; ranges: Interval[] }>();
  for (const line of sessionText.split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    const message = row?.message;
    if (message?.role !== "toolResult" || message.toolName !== "ak_navigator_evidence_read" || message.isError !== false) continue;
    const details = message.details;
    if (!details || typeof details.evidenceId !== "string" || !Number.isSafeInteger(details.offset) || !Number.isSafeInteger(details.byteLength) || !Number.isSafeInteger(details.totalByteLength) || details.offset < 0 || details.byteLength < 0 || details.offset + details.byteLength > details.totalByteLength) throw new Error("native-session evidence read malformed");
    const current = coverage.get(details.evidenceId) ?? { total: details.totalByteLength, ranges: [] };
    if (current.total !== details.totalByteLength) throw new Error("native-session evidence length conflict");
    mergeRange(current.ranges, details.offset, details.offset + details.byteLength);
    coverage.set(details.evidenceId, current);
  }
  return [...coverage].map(([evidenceId, current]) => ({ evidenceId, fullyRead: current.total === 0 || current.ranges.length === 1 && current.ranges[0]![0] === 0 && current.ranges[0]![1] === current.total }));
}

function acceptedReceipt(sessionText: string): LocalReceipt {
  const calls = new Map<string, { name: string; arguments: unknown }>();
  const settled = new Set<string>();
  let accepted: LocalReceipt | null = null;
  for (const line of sessionText.split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    const message = row?.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall" || typeof part.id !== "string" || !part.id || typeof part.name !== "string") continue;
        if (calls.has(part.id)) throw new Error("duplicate tool call identity in native session");
        calls.set(part.id, { name: part.name, arguments: part.arguments });
      }
      continue;
    }
    if (message?.role !== "toolResult" || message.isError !== false || typeof message.toolName !== "string" || !isTerminatingToolName(message.toolName)) continue;
    if (typeof message.toolCallId !== "string" || !message.toolCallId) throw new Error("accepted tool result call identity missing from native session");
    const call = calls.get(message.toolCallId);
    if (!call) throw new Error("accepted tool result is orphaned or precedes its call in native session");
    if (settled.has(message.toolCallId)) throw new Error("duplicate accepted tool result in native session");
    if (call.name !== message.toolName) throw new Error("accepted tool lifecycle name mismatch in native session");
    const details = isAuditedRoleOutputTool(message.toolName) && isAuditEscalationResult(message.details)
      ? message.details
      : validateAcceptedLifecycle(message.toolName, call.arguments, message.details);
    if (accepted) throw new Error("multiple accepted role outcomes in native session");
    settled.add(message.toolCallId);
    accepted = {
      artifactKind: isAuditEscalationResult(details) ? "roleEscalation" : "acceptedReceipt",
      details,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
    };
  }
  if (!accepted) throw new Error("accepted role outcome missing from native session");
  return accepted;
}

async function sessionText(sessionDirectory: string, invocationId: string) {
  const names = (await readdir(sessionDirectory)).filter(name => name.endsWith(`_${invocationId}.jsonl`));
  if (names.length !== 1) throw new Error("private native session is missing or ambiguous");
  return readFile(join(sessionDirectory, names[0]!), "utf8");
}

async function launch(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ChildFact> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function invoke(config: AssistedCallConfigV1, invocationId: string, childArgv: string[], authority: unknown, task: unknown, baseEnv: NodeJS.ProcessEnv): Promise<LocalInvocation> {
  const runDirectory = assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId);
  const inputDirectory = join(runDirectory, "invocation-inputs", invocationId);
  const invocationDirectory = join(runDirectory, "invocations", invocationId);
  const sessionDirectory = join(runDirectory, "sessions", invocationId, "session");
  await mkdir(inputDirectory, { recursive: true });
  await store(join(inputDirectory, "authority.json"), authority);
  await store(join(inputDirectory, "task.json"), task);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const argv = [childArgv[0]!, "--session-dir", sessionDirectory, "--session-id", invocationId, ...childArgv.slice(1)];
  const child = childFact(await launch(argv, config.execution.cwd, effectiveEnv(config, baseEnv)));
  await mkdir(join(runDirectory, "invocations"), { recursive: true });
  await mkdir(invocationDirectory, { recursive: false });
  await store(join(invocationDirectory, "child.json"), child);
  if (childFailed(child)) {
    const failureStored = await store(join(inputDirectory, "failure.json"), child);
    return { receipt: null, child, evidenceRead: [], reference: { id: `failure:${invocationId}`, sha256: failureStored.sha256 } };
  }
  const text = await sessionText(sessionDirectory, invocationId);
  const receipt = acceptedReceipt(text);
  const evidenceRead = nativeSessionEvidenceReads(text);
  const receiptStored = await store(join(invocationDirectory, "receipt.json"), receipt);
  return { receipt, child, evidenceRead, reference: { id: `receipt:${invocationId}`, sha256: receiptStored.sha256 } };
}

async function existing(config: AssistedCallConfigV1, invocationId: string): Promise<LocalInvocation | null> {
  const runDirectory = assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId);
  const invocationDirectory = join(runDirectory, "invocations", invocationId);
  try { await stat(invocationDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const child = childFact(JSON.parse(await readFile(join(invocationDirectory, "child.json"), "utf8")));
  if (childFailed(child)) {
    const failureText = await readFile(join(runDirectory, "invocation-inputs", invocationId, "failure.json"), "utf8");
    if (canonicalJson(JSON.parse(failureText)) !== canonicalJson(child)) throw new Error("private invocation child failure mismatch");
    return { receipt: null, child, evidenceRead: [], reference: { id: `failure:${invocationId}`, sha256: sha256Hex(failureText) } };
  }
  const text = await sessionText(join(runDirectory, "sessions", invocationId, "session"), invocationId);
  const extracted = acceptedReceipt(text);
  const evidenceRead = nativeSessionEvidenceReads(text);
  const receiptText = await readFile(join(invocationDirectory, "receipt.json"), "utf8");
  const receipt = JSON.parse(receiptText) as LocalReceipt;
  if (!isTerminatingToolName(receipt.toolName) || canonicalJson(receipt) !== canonicalJson(extracted)) throw new Error("private invocation receipt mismatch");
  if (receipt.artifactKind === "acceptedReceipt") {
    validateAcceptedDetails(receipt.toolName, receipt.details);
  } else if (
    !isAuditedRoleOutputTool(receipt.toolName) ||
    !isAuditEscalationResult(receipt.details)
  ) {
    throw new Error("private invocation role escalation artifact malformed");
  }
  return { receipt, child, evidenceRead, reference: { id: `receipt:${invocationId}`, sha256: sha256Hex(receiptText) } };
}

function classifyRole(config: AssistedCallConfigV1, value: LocalInvocation, beforeTarget: string, afterTarget: string): RoleInvocationSettlementV1 {
  if (value.child.signal) return { terminalClass: "cancellation", reference: value.reference, beforeTarget, afterTarget };
  if (value.child.exitCode !== 0) return { terminalClass: "infrastructure_failure", reference: value.reference, beforeTarget, afterTarget };
  if (!value.receipt) throw new Error("accepted role outcome missing from private invocation");
  const expected = { coder: "ak_coder_output", fixer: "ak_fixer_output", judge: "ak_judge_output", reviewer: "ak_reviewer_output", collector: "ak_collector_output", doctor: "ak_doctor_output" }[config.execution.role];
  if (value.receipt.toolName !== expected) throw new Error("selected-role tool mismatch");
  if (value.receipt.artifactKind === "roleEscalation") {
    const escalation = value.receipt.details as AuditEscalationResult;
    if (!isAuditEscalationResult(escalation)) throw new Error("role escalation artifact malformed");
    return { terminalClass: "role_escalation", reference: value.reference, beforeTarget, afterTarget };
  }
  const details = value.receipt.details as Record<string, unknown>;
  const status = details.status;
  if (config.execution.phase === "plan" && status === "completed" || config.execution.phase === "apply" && status === "planned") throw new Error("selected-role phase mismatch");
  let terminalClass: AssistedTerminalClass = "accepted_receipt";
  if (config.execution.role === "judge") {
    const verdict = details.judgeStatus;
    if (verdict === "escalate") terminalClass = "role_escalation";
    else if (verdict !== "converged" && verdict !== "continue") throw new Error("Judge posture mismatch");
  } else if (status === "refused") terminalClass = "role_refusal";
  return { terminalClass, reference: value.reference, beforeTarget, afterTarget };
}

export function createAssistedInvocationTransportV1(baseEnv: NodeJS.ProcessEnv = process.env): AssistedInvocationTransportV1 {
  return {
    async readCompleted({ config, invocationId, kind, beforeTarget }) {
      const value = await existing(config, invocationId);
      if (!value) return null;
      if (kind === "navigator") {
        if (value.child.signal || value.child.exitCode !== 0) return { kind: "infrastructure_failure", reference: value.reference };
        if (!value.receipt) throw new Error("accepted Navigator outcome missing from private invocation");
        if (value.receipt.artifactKind !== "acceptedReceipt") throw new Error("Navigator cannot settle audit escalation");
        if (value.receipt.toolName !== "ak_navigator_output") throw new Error("Navigator tool mismatch");
        return { kind: "accepted", receipt: value.receipt.details as NavigatorReceiptV1, evidenceRead: value.evidenceRead, reference: value.reference };
      }
      if (beforeTarget === null) throw new Error("missing role before target");
      const afterTarget = (await createGitCliTransportV1().observeWorkspace(config.execution.cwd)).target;
      return classifyRole(config, value, beforeTarget, afterTarget);
    },
    async invokeNavigator({ config, position, invocationId, piArgv }) {
      const snapshotPath = join(assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), "invocation-inputs", invocationId, "authority.json");
      const argv = [piArgv[0]!, ...modelArgs(piArgv), "--ak-role", "navigator", "--ak-navigator-snapshot", snapshotPath, "--print", "Advise on this frozen current position and submit exactly one Navigator output."];
      const value = await invoke(config, invocationId, argv, position.snapshot, { kind: "navigator-consultation", snapshotDigest: position.snapshot.digest, positionCursor: position.snapshot.positionCursor }, baseEnv);
      if (value.child.signal || value.child.exitCode !== 0) return { kind: "infrastructure_failure", reference: value.reference };
      if (!value.receipt) throw new Error("accepted Navigator outcome missing from private invocation");
      if (value.receipt.artifactKind !== "acceptedReceipt") throw new Error("Navigator cannot settle audit escalation");
      if (value.receipt.toolName !== "ak_navigator_output") throw new Error("Navigator tool mismatch");
      return { kind: "accepted", receipt: value.receipt.details as NavigatorReceiptV1, evidenceRead: value.evidenceRead, reference: value.reference };
    },
    async invokeRole({ config, invocationId, piArgv, beforeTarget }) {
      const value = await invoke(config, invocationId, piArgv, { runId: config.runId, callId: config.callId, subject: config.subject }, { selected: { role: config.execution.role, phase: config.execution.phase }, argv: piArgv }, baseEnv);
      const afterTarget = (await createGitCliTransportV1().observeWorkspace(config.execution.cwd)).target;
      return classifyRole(config, value, beforeTarget, afterTarget);
    },
  };
}
