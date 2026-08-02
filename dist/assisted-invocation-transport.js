import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { assistedRunDirectory } from "./assisted-ledger.js";
import { createGitCliTransportV1 } from "./assisted-acquisition.js";
import { isTerminatingToolName, validateAcceptedDetails } from "./package-contracts/terminating-tools.js";
async function store(path, value) {
  const text = `${canonicalJson(value)}
`;
  await writeFile(path, text, { flag: "wx", mode: 384 });
  return { text, sha256: sha256Hex(text) };
}
function modelArgs(argv) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i].split("=", 1)[0];
    if (["--provider", "--model", "--thinking"].includes(key)) {
      out.push(argv[i]);
      if (argv[i] === key && argv[i + 1]) out.push(argv[++i]);
    }
  }
  return out;
}
function effectiveEnv(config, base) {
  const policy = config.execution.environment;
  const env = policy.inherit ? { ...base } : {};
  for (const name of policy.unset) delete env[name];
  Object.assign(env, policy.overrides);
  return env;
}
function mergeRange(ranges, start, end) {
  let i = 0;
  while (i < ranges.length && ranges[i][1] < start) i++;
  while (i < ranges.length && ranges[i][0] <= end) {
    start = Math.min(start, ranges[i][0]);
    end = Math.max(end, ranges[i][1]);
    ranges.splice(i, 1);
  }
  ranges.splice(i, 0, [start, end]);
}
function nativeSessionEvidenceReads(sessionText2) {
  const coverage = /* @__PURE__ */ new Map();
  for (const line of sessionText2.split("\n")) {
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
  return [...coverage].map(([evidenceId, current]) => ({ evidenceId, fullyRead: current.total === 0 || current.ranges.length === 1 && current.ranges[0][0] === 0 && current.ranges[0][1] === current.total }));
}
function acceptedReceipt(sessionText2) {
  let accepted = null;
  for (const line of sessionText2.split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    const message = row?.message;
    if (message?.role !== "toolResult" || message.isError !== false || typeof message.toolName !== "string" || !isTerminatingToolName(message.toolName) || typeof message.toolCallId !== "string") continue;
    const details = validateAcceptedDetails(message.toolName, message.details);
    if (accepted) throw new Error("multiple accepted role outcomes in native session");
    accepted = { artifactKind: "acceptedReceipt", details, toolCallId: message.toolCallId, toolName: message.toolName };
  }
  if (!accepted) throw new Error("accepted role outcome missing from native session");
  return accepted;
}
async function sessionText(sessionDirectory, invocationId) {
  const names = (await readdir(sessionDirectory)).filter((name) => name.endsWith(`_${invocationId}.jsonl`));
  if (names.length !== 1) throw new Error("private native session is missing or ambiguous");
  return readFile(join(sessionDirectory, names[0]), "utf8");
}
async function launch(argv, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}
async function invoke(config, invocationId, childArgv, authority, task, baseEnv) {
  const runDirectory = assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId);
  const inputDirectory = join(runDirectory, "invocation-inputs", invocationId);
  const invocationDirectory = join(runDirectory, "invocations", invocationId);
  const sessionDirectory = join(runDirectory, "sessions", invocationId, "session");
  await mkdir(inputDirectory, { recursive: true });
  await store(join(inputDirectory, "authority.json"), authority);
  await store(join(inputDirectory, "task.json"), task);
  await mkdir(sessionDirectory, { recursive: true, mode: 448 });
  const argv = [childArgv[0], "--session-dir", sessionDirectory, "--session-id", invocationId, ...childArgv.slice(1)];
  const child = await launch(argv, config.execution.cwd, effectiveEnv(config, baseEnv));
  const text = await sessionText(sessionDirectory, invocationId);
  const receipt = acceptedReceipt(text);
  const evidenceRead = nativeSessionEvidenceReads(text);
  await mkdir(join(runDirectory, "invocations"), { recursive: true });
  await mkdir(invocationDirectory, { recursive: false });
  await store(join(invocationDirectory, "child.json"), child);
  const receiptStored = await store(join(invocationDirectory, "receipt.json"), receipt);
  return { receipt, child, evidenceRead, reference: { id: `receipt:${invocationId}`, sha256: receiptStored.sha256 } };
}
async function existing(config, invocationId) {
  const runDirectory = assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId);
  const invocationDirectory = join(runDirectory, "invocations", invocationId);
  try {
    await stat(invocationDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let receiptText;
  try {
    receiptText = await readFile(join(invocationDirectory, "receipt.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const receipt = JSON.parse(receiptText);
  if (!isTerminatingToolName(receipt.toolName)) throw new Error("private invocation tool mismatch");
  validateAcceptedDetails(receipt.toolName, receipt.details);
  const child = JSON.parse(await readFile(join(invocationDirectory, "child.json"), "utf8"));
  const text = await sessionText(join(runDirectory, "sessions", invocationId, "session"), invocationId);
  return { receipt, child, evidenceRead: nativeSessionEvidenceReads(text), reference: { id: `receipt:${invocationId}`, sha256: sha256Hex(receiptText) } };
}
function classifyRole(config, value, beforeTarget, afterTarget) {
  if (value.child.signal) return { terminalClass: "cancellation", reference: value.reference, beforeTarget, afterTarget };
  if (value.child.exitCode !== 0) return { terminalClass: "infrastructure_failure", reference: value.reference, beforeTarget, afterTarget };
  const expected = { coder: "ak_coder_output", fixer: "ak_fixer_output", judge: "ak_judge_output", reviewer: "ak_reviewer_output", collector: "ak_collector_output", doctor: "ak_doctor_output" }[config.execution.role];
  if (value.receipt.toolName !== expected) throw new Error("selected-role tool mismatch");
  const details = value.receipt.details;
  const status = details.status;
  if (config.execution.phase === "plan" && status === "completed" || config.execution.phase === "apply" && status === "planned") throw new Error("selected-role phase mismatch");
  let terminalClass = "accepted_receipt";
  if (config.execution.role === "judge") {
    const verdict = details.judgeStatus;
    if (verdict === "escalate") terminalClass = "role_escalation";
    else if (verdict !== "converged" && verdict !== "continue") throw new Error("Judge posture mismatch");
  } else if (status === "refused") terminalClass = "role_refusal";
  return { terminalClass, reference: value.reference, beforeTarget, afterTarget };
}
function createAssistedInvocationTransportV1(baseEnv = process.env) {
  return {
    async readCompleted({ config, invocationId, kind, beforeTarget }) {
      const value = await existing(config, invocationId);
      if (!value) return null;
      if (kind === "navigator") {
        if (value.child.signal || value.child.exitCode !== 0) return { kind: "infrastructure_failure", reference: value.reference };
        if (value.receipt.toolName !== "ak_navigator_output") throw new Error("Navigator tool mismatch");
        return { kind: "accepted", receipt: value.receipt.details, evidenceRead: value.evidenceRead, reference: value.reference };
      }
      if (beforeTarget === null) throw new Error("missing role before target");
      const afterTarget = (await createGitCliTransportV1().observeWorkspace(config.execution.cwd)).target;
      return classifyRole(config, value, beforeTarget, afterTarget);
    },
    async invokeNavigator({ config, position, invocationId, piArgv }) {
      const snapshotPath = join(assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), "invocation-inputs", invocationId, "authority.json");
      const argv = [piArgv[0], ...modelArgs(piArgv), "--ak-role", "navigator", "--ak-navigator-snapshot", snapshotPath, "--print", "Advise on this frozen current position and submit exactly one Navigator output."];
      const value = await invoke(config, invocationId, argv, position.snapshot, { kind: "navigator-consultation", snapshotDigest: position.snapshot.digest, positionCursor: position.snapshot.positionCursor }, baseEnv);
      if (value.child.signal || value.child.exitCode !== 0) return { kind: "infrastructure_failure", reference: value.reference };
      if (value.receipt.toolName !== "ak_navigator_output") throw new Error("Navigator tool mismatch");
      return { kind: "accepted", receipt: value.receipt.details, evidenceRead: value.evidenceRead, reference: value.reference };
    },
    async invokeRole({ config, invocationId, piArgv, beforeTarget }) {
      const value = await invoke(config, invocationId, piArgv, { runId: config.runId, callId: config.callId, subject: config.subject }, { selected: { role: config.execution.role, phase: config.execution.phase }, argv: piArgv }, baseEnv);
      const afterTarget = (await createGitCliTransportV1().observeWorkspace(config.execution.cwd)).target;
      return classifyRole(config, value, beforeTarget, afterTarget);
    }
  };
}
export {
  createAssistedInvocationTransportV1,
  nativeSessionEvidenceReads
};
