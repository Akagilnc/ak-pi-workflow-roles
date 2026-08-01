import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { runRecorder } from "./recorder/run.js";
import { buildChildEnv } from "./recorder/config.js";
import { assistedRunDirectory } from "./assisted-ledger.js";
import { createGitCliTransportV1 } from "./assisted-acquisition.js";
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
async function invoke(config, invocationId, childArgv, authority, task, env) {
  const runDir = assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), inputDir = join(runDir, "invocation-inputs", invocationId);
  await mkdir(inputDir, { recursive: true });
  const authorityPath = join(inputDir, "authority.json"), taskPath = join(inputDir, "task.json"), authoritySha = await store(authorityPath, authority), taskSha = await store(taskPath, task);
  const rc = { version: 2, archive: { repositoryRoot: config.subject.repositoryRoot, root: rel(config.subject.repositoryRoot, join(runDir, "invocations")), docketId: invocationId }, session: { directory: rel(config.subject.repositoryRoot, join(runDir, "sessions", invocationId, "session")), id: invocationId }, execution: { cwd: config.execution.cwd, environment: { inherit: true, overrides: {}, unset: [] }, stdin: "inherit" }, declarations: { gitReferences: [], externalInputs: [{ id: "assisted-authority", sourcePath: authorityPath, sha256: authoritySha, kind: "authority" }, { id: "assisted-task", sourcePath: taskPath, sha256: taskSha, kind: "task" }], exhibits: [] }, provenance: { package: "@ak/pi-workflow-roles", model: null, target: `assisted:${config.runId}:${config.callId}:${invocationId}` } };
  const configPath = join(inputDir, "recorder-config.json");
  await writeFile(configPath, `${canonicalJson(rc)}
`, { flag: "wx", mode: 384 });
  const result = await runRecorder({ argv: ["--config", configPath, "--", ...childArgv], env });
  const docket = join(runDir, "invocations", invocationId);
  if (result.failureJson) return { failure: result.failureJson };
  const receipt = JSON.parse(await readFile(join(docket, "receipt.json"), "utf8"));
  const manifest = await readFile(join(docket, "manifest.json")), parsed = JSON.parse(manifest.toString()), session = await readFile(join(config.subject.repositoryRoot, parsed.session.directory, parsed.session.basename), "utf8");
  return { receipt, readEvidenceIds: sealedEvidenceReads(session), reference: { id: `invocation:${invocationId}`, sha256: sha256Hex(manifest) } };
}
function effectiveEnv(config, base) {
  return buildChildEnv(base, config.execution.environment);
}
function sealedEvidenceReads(sessionText) {
  const coverage = /* @__PURE__ */ new Map();
  for (const line of sessionText.split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const m = row?.message;
    if (m?.role !== "toolResult" || m.toolName !== "ak_navigator_evidence_read" || m.isError !== false) continue;
    const d = m.details;
    if (!d || typeof d.evidenceId !== "string" || !Number.isSafeInteger(d.offset) || !Number.isSafeInteger(d.byteLength) || !Number.isSafeInteger(d.totalByteLength) || d.offset < 0 || d.byteLength < 0 || d.offset + d.byteLength > d.totalByteLength) throw new Error("sealed Navigator evidence read malformed");
    const c = coverage.get(d.evidenceId) ?? { total: d.totalByteLength, bytes: /* @__PURE__ */ new Set() };
    if (c.total !== d.totalByteLength) throw new Error("sealed Navigator evidence length conflict");
    for (let i = d.offset; i < d.offset + d.byteLength; i++) c.bytes.add(i);
    coverage.set(d.evidenceId, c);
  }
  return [...coverage].filter(([, c]) => c.bytes.size === c.total).map(([id]) => id);
}
async function existing(config, invocationId) {
  const docket = join(assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), "invocations", invocationId);
  try {
    const receipt = JSON.parse(await readFile(join(docket, "receipt.json"), "utf8")), manifest = await readFile(join(docket, "manifest.json")), parsed = JSON.parse(manifest.toString()), session = await readFile(join(config.subject.repositoryRoot, parsed.session.directory, parsed.session.basename), "utf8");
    return { receipt, readEvidenceIds: sealedEvidenceReads(session), reference: { id: `invocation:${invocationId}`, sha256: sha256Hex(manifest) } };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function classifyRole(config, x, beforeTarget, afterTarget) {
  const expected = { coder: "ak_coder_output", fixer: "ak_fixer_output", judge: "ak_judge_output", reviewer: "ak_reviewer_output", collector: "ak_collector_output", doctor: "ak_doctor_output" }[config.execution.role];
  if (x.receipt.toolName !== expected) throw new Error("sealed selected-role tool mismatch");
  const details = x.receipt.details, status = details.status;
  if (config.execution.phase === "plan" && status === "completed" || config.execution.phase === "apply" && status === "planned") throw new Error("sealed selected-role phase mismatch");
  let terminalClass = "accepted_receipt";
  if (status === "refused") terminalClass = "role_refusal";
  else if (status === "escalated") terminalClass = "role_escalation";
  return { terminalClass, reference: x.reference, beforeTarget, afterTarget };
}
function createRecorderAssistedTransportV1(baseEnv = process.env) {
  return { async readSealed({ config, invocationId, kind, beforeTarget }) {
    const x = await existing(config, invocationId);
    if (!x) return null;
    if (kind === "navigator") {
      if (x.receipt.toolName !== "ak_navigator_output") throw new Error("sealed Navigator tool mismatch");
      const receipt = x.receipt.details;
      return { kind: "accepted", receipt, readEvidenceIds: x.readEvidenceIds, reference: x.reference };
    }
    if (beforeTarget === null) throw new Error("missing role before target");
    const afterTarget = (await createGitCliTransportV1().observeWorkspace(config.execution.cwd)).target;
    return classifyRole(config, x, beforeTarget, afterTarget);
  }, async invokeNavigator({ config, position, invocationId, piArgv }) {
    const snapshotPath = join(assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), "invocation-inputs", invocationId, "authority.json");
    const navArgv = [piArgv[0], ...modelArgs(piArgv), "--ak-role", "navigator", "--ak-navigator-snapshot", snapshotPath, "--print", "Advise on this frozen current position and submit exactly one Navigator output."];
    const x = await invoke(config, invocationId, navArgv, position.snapshot, { kind: "navigator-consultation", snapshotDigest: position.snapshot.digest, positionCursor: position.snapshot.positionCursor }, effectiveEnv(config, baseEnv));
    if ("failure" in x) return { kind: "infrastructure_failure", reference: { id: `recorder-failure:${invocationId}`, sha256: sha256Hex(x.failure) } };
    if (x.receipt.toolName !== "ak_navigator_output") throw new Error("sealed Navigator tool mismatch");
    return { kind: "accepted", receipt: x.receipt.details, readEvidenceIds: x.readEvidenceIds, reference: x.reference };
  }, async invokeRole({ config, invocationId, piArgv, beforeTarget }) {
    const x = await invoke(config, invocationId, piArgv, { runId: config.runId, callId: config.callId, subject: config.subject }, { selected: { role: config.execution.role, phase: config.execution.phase }, argv: piArgv }, effectiveEnv(config, baseEnv));
    const afterTarget = (await createGitCliTransportV1().observeWorkspace(config.execution.cwd)).target;
    if ("failure" in x) return { terminalClass: "infrastructure_failure", reference: { id: `recorder-failure:${invocationId}`, sha256: sha256Hex(x.failure) }, beforeTarget, afterTarget };
    return classifyRole(config, x, beforeTarget, afterTarget);
  } };
}
export {
  createRecorderAssistedTransportV1
};
