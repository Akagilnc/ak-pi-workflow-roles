import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { canonicalSnapshotDigestV1 } from "./navigator-contracts.js";
import { sha256Hex } from "./sha256.js";
import { assistedRunDirectory } from "./assisted-ledger.js";
const exec = promisify(execFile);
;
;
function createGitCliTransportV1() {
  return { async observeWorkspace(root) {
    const [{ stdout: head }, { stdout: common }] = await Promise.all([exec("git", ["rev-parse", "HEAD"], { cwd: root }), exec("git", ["rev-parse", "--git-common-dir"], { cwd: root })]);
    return { head: head.trim(), target: head.trim(), relation: common.trim() === ".git" ? "repository" : "worktree" };
  } };
}
function createGhJsonTransportV1(env = process.env) {
  async function api(path) {
    const { stdout } = await exec("gh", ["api", path], { env, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  return { async repository(owner, name) {
    const x = await api(`repos/${owner}/${name}`);
    if (typeof x.node_id !== "string") throw new Error("invalid GitHub repository response");
    return { id: x.node_id };
  }, async issue(owner, name, number) {
    const x = await api(`repos/${owner}/${name}/issues/${number}`);
    if (typeof x.node_id !== "string" || x.body !== null && typeof x.body !== "string" || !(x.state === "open" || x.state === "closed") || !Array.isArray(x.labels)) throw new Error("invalid GitHub issue response");
    return { id: x.node_id, state: x.state, body: x.body, labels: x.labels.map((l) => {
      if (typeof l.node_id !== "string" || typeof l.name !== "string") throw new Error("invalid GitHub label response");
      return { id: l.node_id, name: l.name };
    }), observedAt: (/* @__PURE__ */ new Date()).toISOString() };
  } };
}
const MAX_ASSISTED_EVIDENCE_BYTES = 8 * 1024 * 1024;
async function readBoundedRegular(path) {
  const descriptor = await open(path, constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0));
  try {
    const stat = await descriptor.stat();
    if (!stat.isFile()) throw new Error("evidence must be a regular file");
    if (stat.size > MAX_ASSISTED_EVIDENCE_BYTES) throw new Error("evidence exceeds size bound");
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await descriptor.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("evidence changed during admission");
      offset += bytesRead;
    }
    const after = await descriptor.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw new Error("evidence changed during admission");
    return bytes;
  } finally {
    await descriptor.close();
  }
}
async function acquireCurrentPositionV1(config, positionCursor, latestAttempt, deps) {
  const repo = await deps.github.repository(config.subject.github.owner, config.subject.github.name), parent = await deps.github.issue(config.subject.github.owner, config.subject.github.name, config.subject.parentIssue), childObs = await Promise.all(config.subject.children.map((c) => deps.github.issue(config.subject.github.owner, config.subject.github.name, c.number))), workObs = await Promise.all(config.acquisition.workspaces.map((w) => deps.git.observeWorkspace(w.root)));
  const handles = /* @__PURE__ */ new Map(), evidence = [];
  function admit(id, kind, source, reference, handle) {
    if (evidence.some((x) => x.id === id)) throw new Error("duplicate evidence id");
    if (source.byteLength > MAX_ASSISTED_EVIDENCE_BYTES) throw new Error("evidence exceeds size bound");
    const bytes = new Uint8Array(source);
    handles.set(handle, bytes);
    evidence.push({ id, kind, sha256: sha256Hex(bytes), provenance: { kind: "acquired", reference }, handle });
  }
  admit("parent-issue-body", "issue_body", new TextEncoder().encode(parent.body ?? ""), `github-issue:${config.subject.parentIssue}`, "memory:parent-body");
  for (let i = 0; i < childObs.length; i++) admit(`child-${config.subject.children[i].number}-issue-body`, "issue_body", new TextEncoder().encode(childObs[i].body ?? ""), `github-issue:${config.subject.children[i].number}`, `memory:child-${i}-body`);
  for (const d of config.acquisition.evidence) admit(d.id, d.kind, await readBoundedRegular(d.path), `${d.provenance.kind}:${d.provenance.reference}`, d.path);
  evidence.sort((a, b) => a.id.localeCompare(b.id));
  const evidenceRoot = join(assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  for (const item of evidence) {
    const bytes = handles.get(item.handle);
    const path = join(evidenceRoot, item.sha256);
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 384 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (sha256Hex(await readFile(path)) !== item.sha256) throw new Error("evidence content-address collision");
    }
    ;
    handles.delete(item.handle);
    item.handle = path;
    handles.set(path, bytes);
  }
  const common = { observedAt: parent.observedAt, query: { transport: "github_rest", operation: "issue" } };
  const base = { version: 1, capturedAt: (/* @__PURE__ */ new Date()).toISOString(), runId: config.runId, subject: { repositoryRoot: config.subject.repositoryRoot, github: { ...config.subject.github, id: repo.id }, parent: { number: config.subject.parentIssue, id: parent.id } }, children: config.subject.children.map((c, i) => ({ ...c, id: childObs[i].id, state: childObs[i].state, labels: childObs[i].labels, observedAt: childObs[i].observedAt, query: { transport: "github_rest", operation: "issue" } })), parentObservation: { state: parent.state, labels: parent.labels, ...common }, labelPolicy: config.acquisition.labelPolicy.map((x) => ({ ...x })), workspaces: config.acquisition.workspaces.map((w, i) => ({ id: w.id, root: w.root, relation: workObs[i].relation, head: workObs[i].head, target: workObs[i].target })), evidence, positionCursor, latestAttempt };
  return { snapshot: { ...base, digest: canonicalSnapshotDigestV1(base) }, handles };
}
export {
  MAX_ASSISTED_EVIDENCE_BYTES,
  acquireCurrentPositionV1,
  createGhJsonTransportV1,
  createGitCliTransportV1
};
