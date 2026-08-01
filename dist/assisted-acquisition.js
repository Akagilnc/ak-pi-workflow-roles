import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalSnapshotDigestV1 } from "./navigator-contracts.js";
import { sha256Hex } from "./sha256.js";
import { assistedRunDirectory } from "./assisted-ledger.js";
const exec = promisify(execFile);
;
;
function createGitCliTransportV1() {
  return { async observeWorkspace(root) {
    const [{ stdout: head }, { stdout: gitDir }, { stdout: common }] = await Promise.all([exec("git", ["rev-parse", "HEAD"], { cwd: root }), exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: root }), exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root })]);
    return { head: head.trim(), target: head.trim(), relation: resolve(root, gitDir.trim()) === resolve(root, common.trim()) ? "repository" : "worktree" };
  } };
}
const GH_API_TIMEOUT_MS = 6e4;
function githubComponent(value) {
  if (!value || value.startsWith("-") || value.includes("..") || /[\/?#\x00-\x1f\x7f]/.test(value)) throw new Error("invalid GitHub repository identity");
  return value;
}
function createGhJsonTransportV1(env = process.env) {
  async function api(path) {
    const { stdout } = await exec("gh", ["api", path], { env, maxBuffer: 8 * 1024 * 1024, timeout: GH_API_TIMEOUT_MS });
    return JSON.parse(stdout);
  }
  return { async repository(owner, name) {
    const x = await api(`repos/${githubComponent(owner)}/${githubComponent(name)}`);
    if (typeof x.node_id !== "string") throw new Error("invalid GitHub repository response");
    return { id: x.node_id };
  }, async issue(owner, name, number) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("invalid GitHub issue number");
    const x = await api(`repos/${githubComponent(owner)}/${githubComponent(name)}/issues/${number}`);
    if (typeof x.node_id !== "string" || x.body !== null && typeof x.body !== "string" || !(x.state === "open" || x.state === "closed") || !Array.isArray(x.labels)) throw new Error("invalid GitHub issue response");
    return { id: x.node_id, state: x.state, body: x.body, labels: x.labels.map((l) => {
      if (typeof l.node_id !== "string" || typeof l.name !== "string") throw new Error("invalid GitHub label response");
      return { id: l.node_id, name: l.name };
    }), observedAt: (/* @__PURE__ */ new Date()).toISOString() };
  } };
}
class EvidenceAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
  name = "EvidenceAdmissionError";
}
function admissionFailure(code, message) {
  throw new EvidenceAdmissionError(code, message);
}
const MAX_ASSISTED_EVIDENCE_BYTES = 8 * 1024 * 1024;
async function readBoundedRegular(path) {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0));
  try {
    const stat = await descriptor.stat();
    if (!stat.isFile()) admissionFailure("AK_EVIDENCE_NOT_REGULAR", "evidence must be a regular file");
    if (stat.size > MAX_ASSISTED_EVIDENCE_BYTES) admissionFailure("AK_EVIDENCE_TOO_LARGE", "evidence exceeds size bound");
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await descriptor.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) admissionFailure("AK_EVIDENCE_CHANGED", "evidence changed during admission");
      offset += bytesRead;
    }
    const after = await descriptor.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) admissionFailure("AK_EVIDENCE_CHANGED", "evidence changed during admission");
    return bytes;
  } finally {
    await descriptor.close();
  }
}
async function acquireCurrentPositionV1(config, positionCursor, latestAttempt, deps) {
  const repo = await deps.github.repository(config.subject.github.owner, config.subject.github.name), parent = await deps.github.issue(config.subject.github.owner, config.subject.github.name, config.subject.parentIssue), childObs = await Promise.all(config.subject.children.map((c) => deps.github.issue(config.subject.github.owner, config.subject.github.name, c.number))), workObs = await Promise.all(config.acquisition.workspaces.map((w) => deps.git.observeWorkspace(w.root)));
  const handles = /* @__PURE__ */ new Map(), evidence = [];
  function admit(id, kind, source, reference, handle) {
    if (evidence.some((x) => x.id === id)) admissionFailure("AK_EVIDENCE_DUPLICATE_ID", "duplicate evidence id");
    if (source.byteLength > MAX_ASSISTED_EVIDENCE_BYTES) admissionFailure("AK_EVIDENCE_TOO_LARGE", "evidence exceeds size bound");
    const bytes = new Uint8Array(source);
    handles.set(id, bytes);
    evidence.push({ id, kind, sha256: sha256Hex(bytes), provenance: { kind: "acquired", reference }, handle });
  }
  admit("parent-issue-body", "issue_body", new TextEncoder().encode(parent.body ?? ""), `github-issue:${config.subject.parentIssue}`, "memory:parent-body");
  for (let i = 0; i < childObs.length; i++) admit(`child-${config.subject.children[i].number}-issue-body`, "issue_body", new TextEncoder().encode(childObs[i].body ?? ""), `github-issue:${config.subject.children[i].number}`, `memory:child-${i}-body`);
  for (const d of config.acquisition.evidence) admit(d.id, d.kind, await readBoundedRegular(d.path), `${d.provenance.kind}:${d.provenance.reference}`, d.path);
  if (latestAttempt && (latestAttempt.reference.id.startsWith("receipt:") || latestAttempt.reference.id.startsWith("failure:"))) {
    const [artifactKind, artifactInvocation] = latestAttempt.reference.id.split(":");
    if (artifactInvocation !== latestAttempt.invocationId) throw new Error("settlement artifact identity mismatch");
    const runDir = assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), path = artifactKind === "receipt" ? join(runDir, "invocations", artifactInvocation, "receipt.json") : join(runDir, "invocation-inputs", artifactInvocation, "failure.json"), bytes = await readBoundedRegular(path);
    if (sha256Hex(bytes) !== latestAttempt.reference.sha256) admissionFailure("AK_EVIDENCE_DIGEST_MISMATCH", "settlement artifact digest mismatch");
    admit(`settlement:${artifactInvocation}`, artifactKind === "receipt" ? "acceptance" : "failure", bytes, latestAttempt.reference.id, path);
  }
  evidence.sort((a, b) => a.id.localeCompare(b.id));
  const evidenceRoot = join(assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  for (const item of evidence) {
    const bytes = handles.get(item.id);
    if (!bytes) admissionFailure("AK_EVIDENCE_BYTES_UNAVAILABLE", "admitted evidence bytes unavailable");
    const path = join(evidenceRoot, item.sha256);
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 384 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (sha256Hex(await readFile(path)) !== item.sha256) admissionFailure("AK_EVIDENCE_CONTENT_COLLISION", "evidence content-address collision");
    }
    ;
    handles.delete(item.id);
    item.handle = path;
    handles.set(path, bytes);
  }
  const common = { observedAt: parent.observedAt, query: { transport: "github_rest", operation: "issue" } };
  const base = { version: 1, capturedAt: (/* @__PURE__ */ new Date()).toISOString(), runId: config.runId, subject: { repositoryRoot: config.subject.repositoryRoot, github: { ...config.subject.github, id: repo.id }, parent: { number: config.subject.parentIssue, id: parent.id } }, children: config.subject.children.map((c, i) => ({ ...c, id: childObs[i].id, state: childObs[i].state, labels: childObs[i].labels, observedAt: childObs[i].observedAt, query: { transport: "github_rest", operation: "issue" } })), parentObservation: { state: parent.state, labels: parent.labels, ...common }, labelPolicy: config.acquisition.labelPolicy.map((x) => ({ ...x })), workspaces: config.acquisition.workspaces.map((w, i) => ({ id: w.id, root: w.root, relation: workObs[i].relation, head: workObs[i].head, target: workObs[i].target })), evidence, positionCursor, latestAttempt };
  return { snapshot: { ...base, digest: canonicalSnapshotDigestV1(base) }, handles };
}
export {
  EvidenceAdmissionError,
  GH_API_TIMEOUT_MS,
  MAX_ASSISTED_EVIDENCE_BYTES,
  acquireCurrentPositionV1,
  createGhJsonTransportV1,
  createGitCliTransportV1
};
