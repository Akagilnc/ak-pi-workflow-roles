import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { runRecorder } from "./recorder/run.js";
import { buildChildEnv } from "./recorder/config.js";
import { assistedRunDirectory } from "./assisted-ledger.js";
import { createGitCliTransportV1 } from "./assisted-acquisition.js";
import { validatePublicManifest } from "./recorder/manifest.js";
import { validateAcceptedDetails } from "./package-contracts/terminating-tools.js";
function rel(root, path) {
  return relative(root, path).split("\\").join("/");
}
async function store(path, value) {
  const text = `${canonicalJson(value)}
`;
  await writeFile(path, text, { flag: "wx", mode: 384 });
  return sha256Hex(text);
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
async function loadVerifiedAssistedDocketV1(repositoryRoot, docket, invocationId) {
  if (resolve(docket) !== docket || relative(repositoryRoot, docket).startsWith("..")) throw new Error("docket escapes repository");
  const manifestBytes = await readFile(join(docket, "manifest.json")), value = JSON.parse(manifestBytes.toString());
  validatePublicManifest(value);
  const manifest = value, artifact = manifest.artifacts.find((x) => x.id === manifest.receipt.artifactId), rootReal = await realpath(repositoryRoot), docketReal = await realpath(docket);
  if (await realpath(join(manifest.archive.repositoryRoot, manifest.archive.root, manifest.archive.docketId)) !== docketReal || manifest.archive.docketId !== invocationId || manifest.invocation.id !== invocationId || manifest.session.id !== invocationId || !artifact?.stored) throw new Error("sealed docket identity join mismatch");
  const receiptPath = resolve(docket, artifact.stored.path);
  if (relative(docket, receiptPath).startsWith("..")) throw new Error("sealed artifact path escape");
  const receiptReal = await realpath(receiptPath);
  if (relative(docketReal, receiptReal).startsWith("..")) throw new Error("sealed artifact path escape");
  const receiptBytes = await readFile(receiptReal);
  if (receiptBytes.byteLength !== artifact.stored.byteLength || sha256Hex(receiptBytes) !== artifact.stored.sha256) throw new Error("sealed receipt authenticity mismatch");
  const receipt = JSON.parse(receiptBytes.toString());
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || Object.keys(receipt).sort().join(",") !== "artifactKind,details,toolCallId,toolName" || receipt.toolName !== manifest.receipt.toolName || receipt.toolCallId !== manifest.receipt.toolCallId || receipt.artifactKind !== manifest.receipt.artifactKind) throw new Error("sealed receipt join mismatch");
  validateAcceptedDetails(receipt.toolName, receipt.details);
  const sessionPath = resolve(rootReal, manifest.session.directory, manifest.session.basename);
  if (relative(rootReal, sessionPath).startsWith("..")) throw new Error("sealed session path escape");
  const sessionReal = await realpath(sessionPath);
  if (relative(rootReal, sessionReal).startsWith("..")) throw new Error("sealed session path escape");
  const sessionBytes = await readFile(sessionReal);
  if (sessionBytes.byteLength !== manifest.session.byteLength || sha256Hex(sessionBytes) !== manifest.session.sha256) throw new Error("sealed session authenticity mismatch");
  return { receipt, receiptBytes: new Uint8Array(receiptBytes), sessionText: sessionBytes.toString(), manifest, reference: { id: `receipt:${invocationId}`, sha256: artifact.stored.sha256 } };
}
async function invoke(config, invocationId, childArgv, authority, task, env) {
  const runDir = assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), inputDir = join(runDir, "invocation-inputs", invocationId);
  await mkdir(inputDir, { recursive: true });
  const authorityPath = join(inputDir, "authority.json"), taskPath = join(inputDir, "task.json"), authoritySha = await store(authorityPath, authority), taskSha = await store(taskPath, task);
  const rc = { version: 2, archive: { repositoryRoot: config.subject.repositoryRoot, root: rel(config.subject.repositoryRoot, join(runDir, "invocations")), docketId: invocationId }, session: { directory: rel(config.subject.repositoryRoot, join(runDir, "sessions", invocationId, "session")), id: invocationId }, execution: { cwd: config.execution.cwd, environment: { inherit: true, overrides: {}, unset: [] }, stdin: "inherit" }, declarations: { gitReferences: [], externalInputs: [{ id: "assisted-authority", sourcePath: authorityPath, sha256: authoritySha, kind: "authority" }, { id: "assisted-task", sourcePath: taskPath, sha256: taskSha, kind: "task" }], exhibits: [] }, provenance: { package: "@ak/pi-workflow-roles", model: null, target: `assisted:${config.runId}:${config.callId}:${invocationId}` } };
  const configPath = join(inputDir, "recorder-config.json");
  await writeFile(configPath, `${canonicalJson(rc)}
`, { flag: "wx", mode: 384 });
  await mkdir(join(runDir, "sessions", invocationId), { recursive: true });
  const result = await runRecorder({ argv: ["--config", configPath, "--", ...childArgv], env }), docket = join(runDir, "invocations", invocationId);
  if (result.failureJson) {
    const path = join(inputDir, "failure.json"), bytes = new TextEncoder().encode(`${result.failureJson}
`);
    await writeFile(path, bytes, { flag: "wx", mode: 384 });
    return { failure: result.failureJson, child: result, reference: { id: `failure:${invocationId}`, sha256: sha256Hex(bytes) } };
  }
  const verified = await loadVerifiedAssistedDocketV1(config.subject.repositoryRoot, docket, invocationId);
  return { receipt: verified.receipt, evidenceRead: sealedEvidenceReads(verified.sessionText), reference: verified.reference, child: result };
}
function effectiveEnv(config, base) {
  return buildChildEnv(base, config.execution.environment);
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
function sealedEvidenceReads(sessionText) {
  const coverage = /* @__PURE__ */ new Map();
  for (const line of sessionText.split("\n")) {
    if (!line) continue;
    let row;
    row = JSON.parse(line);
    const m = row?.message;
    if (m?.role !== "toolResult" || m.toolName !== "ak_navigator_evidence_read" || m.isError !== false) continue;
    const d = m.details;
    if (!d || typeof d.evidenceId !== "string" || !Number.isSafeInteger(d.offset) || !Number.isSafeInteger(d.byteLength) || !Number.isSafeInteger(d.totalByteLength) || d.offset < 0 || d.byteLength < 0 || d.offset + d.byteLength > d.totalByteLength) throw new Error("sealed Navigator evidence read malformed");
    const c = coverage.get(d.evidenceId) ?? { total: d.totalByteLength, ranges: [] };
    if (c.total !== d.totalByteLength) throw new Error("sealed Navigator evidence length conflict");
    mergeRange(c.ranges, d.offset, d.offset + d.byteLength);
    coverage.set(d.evidenceId, c);
  }
  return [...coverage].map(([evidenceId, c]) => ({ evidenceId, fullyRead: c.total === 0 || c.ranges.length === 1 && c.ranges[0][0] === 0 && c.ranges[0][1] === c.total }));
}
async function existing(config, invocationId) {
  const docket = join(assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), "invocations", invocationId);
  try {
    await stat(docket);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const verified = await loadVerifiedAssistedDocketV1(config.subject.repositoryRoot, docket, invocationId);
  return { receipt: verified.receipt, evidenceRead: sealedEvidenceReads(verified.sessionText), reference: verified.reference, child: { exitCode: verified.manifest.child.exitCode, signal: verified.manifest.child.signal } };
}
function classifyRole(config, x, beforeTarget, afterTarget) {
  if (x.child?.signal) return { terminalClass: "cancellation", reference: x.reference, beforeTarget, afterTarget };
  if (x.child && x.child.exitCode !== 0) return { terminalClass: "infrastructure_failure", reference: x.reference, beforeTarget, afterTarget };
  const expected = { coder: "ak_coder_output", fixer: "ak_fixer_output", judge: "ak_judge_output", reviewer: "ak_reviewer_output", collector: "ak_collector_output", doctor: "ak_doctor_output" }[config.execution.role];
  if (x.receipt.toolName !== expected) throw new Error("sealed selected-role tool mismatch");
  const details = x.receipt.details, status = details.status;
  if (config.execution.phase === "plan" && status === "completed" || config.execution.phase === "apply" && status === "planned") throw new Error("sealed selected-role phase mismatch");
  let terminalClass = "accepted_receipt";
  if (config.execution.role === "judge") {
    const verdict = details.judgeStatus;
    if (verdict === "escalate") terminalClass = "role_escalation";
    else if (verdict !== "converged" && verdict !== "continue") throw new Error("sealed Judge posture mismatch");
  } else if (status === "refused") terminalClass = "role_refusal";
  return { terminalClass, reference: x.reference, beforeTarget, afterTarget };
}
function createRecorderAssistedTransportV1(baseEnv = process.env) {
  return { async readSealed({ config, invocationId, kind, beforeTarget }) {
    const x = await existing(config, invocationId);
    if (!x) return null;
    if (kind === "navigator") {
      if (x.child.signal || x.child.exitCode !== 0) return { kind: "infrastructure_failure", reference: x.reference };
      if (x.receipt.toolName !== "ak_navigator_output") throw new Error("sealed Navigator tool mismatch");
      const receipt = x.receipt.details;
      return { kind: "accepted", receipt, evidenceRead: x.evidenceRead, reference: x.reference };
    }
    if (beforeTarget === null) throw new Error("missing role before target");
    const afterTarget = (await createGitCliTransportV1().observeWorkspace(config.execution.cwd)).target;
    return classifyRole(config, x, beforeTarget, afterTarget);
  }, async invokeNavigator({ config, position, invocationId, piArgv }) {
    const snapshotPath = join(assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), "invocation-inputs", invocationId, "authority.json");
    const navArgv = [piArgv[0], ...modelArgs(piArgv), "--ak-role", "navigator", "--ak-navigator-snapshot", snapshotPath, "--print", "Advise on this frozen current position and submit exactly one Navigator output."];
    const x = await invoke(config, invocationId, navArgv, position.snapshot, { kind: "navigator-consultation", snapshotDigest: position.snapshot.digest, positionCursor: position.snapshot.positionCursor }, effectiveEnv(config, baseEnv));
    if ("failure" in x) return { kind: "infrastructure_failure", reference: x.reference };
    if (x.child.signal || x.child.exitCode !== 0) return { kind: "infrastructure_failure", reference: x.reference };
    if (x.receipt.toolName !== "ak_navigator_output") throw new Error("sealed Navigator tool mismatch");
    return { kind: "accepted", receipt: x.receipt.details, evidenceRead: x.evidenceRead, reference: x.reference };
  }, async invokeRole({ config, invocationId, piArgv, beforeTarget }) {
    const x = await invoke(config, invocationId, piArgv, { runId: config.runId, callId: config.callId, subject: config.subject }, { selected: { role: config.execution.role, phase: config.execution.phase }, argv: piArgv }, effectiveEnv(config, baseEnv));
    const afterTarget = (await createGitCliTransportV1().observeWorkspace(config.execution.cwd)).target;
    if ("failure" in x) return { terminalClass: "infrastructure_failure", reference: x.reference, beforeTarget, afterTarget };
    if (x.child.signal) return { terminalClass: "cancellation", reference: x.reference, beforeTarget, afterTarget };
    if (x.child.exitCode !== 0) return { terminalClass: "infrastructure_failure", reference: x.reference, beforeTarget, afterTarget };
    return classifyRole(config, x, beforeTarget, afterTarget);
  } };
}
export {
  createRecorderAssistedTransportV1,
  loadVerifiedAssistedDocketV1,
  sealedEvidenceReads
};
