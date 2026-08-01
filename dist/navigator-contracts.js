import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { isUuidV7 } from "./uuidv7.js";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "./package-contracts/navigator-output.js";
const PACKAGED_ROLES = ["judge", "fixer", "coder", "reviewer", "collector", "doctor", "navigator"];
const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40,64}$/;
function record(v, keys, where) {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k))) throw new Error(`${where} must be a closed object`);
  return v;
}
function text(v, w) {
  if (typeof v !== "string" || !v) return fail(w);
  return v;
}
function fail(w) {
  throw new Error(`invalid ${w}`);
}
function iso(v, w) {
  const s = text(v, w);
  if (new Date(s).toISOString() !== s) fail(w);
  return s;
}
function issue(v, w) {
  const r = record(v, ["number", "id"], w);
  if (!Number.isSafeInteger(r.number) || r.number <= 0) fail(w);
  return { number: r.number, id: text(r.id, `${w}.id`) };
}
function labels(v, w) {
  if (!Array.isArray(v)) fail(w);
  return v.map((x, i) => {
    const r = record(x, ["id", "name"], `${w}/${i}`);
    return { id: text(r.id, w), name: text(r.name, w) };
  });
}
function query(v, w) {
  const r = record(v, ["transport", "operation"], w);
  if (r.transport !== "github_graphql" && r.transport !== "github_rest") fail(w);
  return { transport: r.transport, operation: text(r.operation, w) };
}
function obsFields(r, w) {
  if (r.state !== "open" && r.state !== "closed") fail(w);
  return { state: r.state, labels: labels(r.labels, w), observedAt: iso(r.observedAt, w), query: query(r.query, w) };
}
function validateSettledAttempt(v) {
  if (v === null) return null;
  const a = record(v, ["invocationId", "role", "phase", "beforeTarget", "afterTarget", "terminalClass", "reference"], "latestAttempt"), ref = record(a.reference, ["id", "sha256"], "latestAttempt reference");
  if (!isUuidV7(a.invocationId) || !PACKAGED_ROLES.includes(a.role) || a.role === "navigator" || (a.role === "coder" || a.role === "fixer" ? a.phase !== "plan" && a.phase !== "apply" : a.phase !== null) || !OID.test(String(a.beforeTarget)) || !OID.test(String(a.afterTarget)) || !["accepted_receipt", "role_refusal", "role_escalation", "infrastructure_failure", "cancellation", "outcome_unavailable_after_runner_loss"].includes(String(a.terminalClass)) || !SHA256.test(String(ref.sha256))) fail("latestAttempt");
  return { invocationId: a.invocationId, role: a.role, phase: a.phase, beforeTarget: String(a.beforeTarget), afterTarget: String(a.afterTarget), terminalClass: a.terminalClass, reference: { id: text(ref.id, "reference id"), sha256: String(ref.sha256) } };
}
function subject(v) {
  const r = record(v, ["repositoryRoot", "github", "parent"], "subject"), g = record(r.github, ["owner", "name", "id"], "github");
  return { repositoryRoot: text(r.repositoryRoot, "repositoryRoot"), github: { owner: text(g.owner, "owner"), name: text(g.name, "name"), id: text(g.id, "repository id") }, parent: issue(r.parent, "parent") };
}
function canonicalSnapshotDigestV1(value) {
  const stable = { ...value, capturedAt: "<capture-time>", parentObservation: { ...value.parentObservation, observedAt: "<observation-time>" }, children: value.children.map((child) => ({ ...child, observedAt: "<observation-time>" })) };
  return sha256Hex(canonicalJson(stable));
}
function validateCurrentPositionSnapshotV1(value) {
  const r = record(value, ["version", "capturedAt", "runId", "subject", "children", "parentObservation", "workspaces", "evidence", "positionCursor", "latestAttempt", "digest"], "snapshot");
  if (r.version !== 1 || !isUuidV7(r.runId) || !Number.isSafeInteger(r.positionCursor) || r.positionCursor < 0) fail("snapshot identity");
  const sub = subject(r.subject);
  if (!Array.isArray(r.children) || !Array.isArray(r.workspaces) || !Array.isArray(r.evidence)) fail("snapshot collections");
  const children = r.children.map((x, i) => {
    const c = record(x, ["number", "id", "relation", "provenance", "state", "labels", "observedAt", "query"], `child/${i}`), id = issue({ number: c.number, id: c.id }, "child"), p = record(c.provenance, ["kind", "reference"], "provenance");
    if (c.relation !== "sub_issue" || p.kind !== "caller" && p.kind !== "tracker") fail("child");
    return { ...id, relation: "sub_issue", provenance: { kind: p.kind, reference: text(p.reference, "reference") }, ...obsFields(c, "child") };
  });
  if (children.some((c, i) => i > 0 && c.number <= children[i - 1].number) || new Set(children.map((c) => c.id)).size !== children.length) fail("sorted exact child universe");
  const po = record(r.parentObservation, ["state", "labels", "observedAt", "query"], "parent observation"), parentObservation = obsFields(po, "parent observation");
  const workspaces = r.workspaces.map((x, i) => {
    const w = record(x, ["id", "root", "relation", "head", "target"], `workspace/${i}`);
    if (w.relation !== "repository" && w.relation !== "worktree" || !OID.test(String(w.head)) || !OID.test(String(w.target))) fail("workspace");
    return { id: text(w.id, "workspace id"), root: text(w.root, "workspace root"), relation: w.relation, head: String(w.head), target: String(w.target) };
  });
  const evidence = r.evidence.map((x, i) => {
    const e = record(x, ["id", "kind", "sha256", "provenance", "handle"], `evidence/${i}`), p = record(e.provenance, ["kind", "reference"], "evidence provenance");
    if (!["authority", "acceptance", "issue_body", "task", "input", "failure"].includes(String(e.kind)) || !SHA256.test(String(e.sha256))) fail("evidence");
    return { id: text(e.id, "evidence id"), kind: e.kind, sha256: String(e.sha256), provenance: { kind: text(p.kind, "kind"), reference: text(p.reference, "reference") }, handle: text(e.handle, "handle") };
  });
  const result = { version: 1, capturedAt: iso(r.capturedAt, "capturedAt"), runId: String(r.runId), subject: sub, children, parentObservation, workspaces, evidence, positionCursor: r.positionCursor, latestAttempt: validateSettledAttempt(r.latestAttempt), digest: String(r.digest) };
  const { digest, ...digestInput } = result;
  if (!SHA256.test(result.digest) || canonicalSnapshotDigestV1(digestInput) !== result.digest) fail("snapshot digest");
  return result;
}
function expectedPrimary(status) {
  return status === "ordinary" ? ["package_role", "caller_action", "stop"] : status === "insufficient" ? ["obtain_evidence_and_reconsult"] : status === "refused" ? ["return_scope_or_authority_defect"] : ["seek_owner_decision"];
}
function stringArray(v, w) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) fail(w);
  return v;
}
function validatePrimaryShape(v, status) {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("primary");
  const kind = String(v.kind);
  if (!expectedPrimary(status).includes(kind)) fail("status primary shape");
  let keys;
  if (kind === "package_role") {
    keys = ["kind", "role", "phase", "evidenceIds", "conditions", "hazards"];
    const p2 = record(v, keys, "primary");
    if (!PACKAGED_ROLES.includes(String(p2.role)) || p2.role === "navigator" || (p2.role === "coder" || p2.role === "fixer" ? p2.phase !== "plan" && p2.phase !== "apply" : p2.phase !== null)) fail("primary role");
    stringArray(p2.conditions, "conditions");
    stringArray(p2.hazards, "hazards");
  } else if (kind === "caller_action") {
    keys = ["kind", "actionCategory", "evidenceIds", "conditions", "hazards"];
    const p2 = record(v, keys, "primary");
    if (!["obtain_evidence", "design_authority", "review_batch", "repository_action"].includes(String(p2.actionCategory))) fail("action category");
    stringArray(p2.conditions, "conditions");
    stringArray(p2.hazards, "hazards");
  } else if (kind === "stop") {
    keys = ["kind", "reasonCategory", "evidenceIds", "conditions", "hazards"];
    const p2 = record(v, keys, "primary");
    if (!["complete", "unsafe", "not_cost_effective"].includes(String(p2.reasonCategory))) fail("stop category");
    stringArray(p2.conditions, "conditions");
    stringArray(p2.hazards, "hazards");
  } else if (kind === "obtain_evidence_and_reconsult") {
    keys = ["kind", "missing", "evidenceIds"];
    const p2 = record(v, keys, "primary");
    if (!Array.isArray(p2.missing) || p2.missing.length === 0) p2.missing = fail("missing evidence");
    for (const x of p2.missing) {
      const m = record(x, ["kind", "identity"], "missing evidence");
      text(m.kind, "missing kind");
      text(m.identity, "missing identity");
    }
  } else if (kind === "return_scope_or_authority_defect") {
    keys = ["kind", "defect", "evidenceIds"];
    const p2 = record(v, keys, "primary"), d = record(p2.defect, ["category", "evidenceId"], "defect");
    if (!["contradictory_subject", "out_of_scope", "authority_conflict"].includes(String(d.category))) fail("defect category");
    text(d.evidenceId, "defect evidence");
  } else {
    keys = ["kind", "decision", "evidenceIds"];
    const p2 = record(v, keys, "primary"), d = record(p2.decision, ["category", "question"], "decision");
    text(d.category, "decision category");
    text(d.question, "decision question");
  }
  const p = v;
  return stringArray(p.evidenceIds, "primary evidence ids");
}
function validateNavigatorReceiptV1(value, snapshot, actualReads) {
  const r = record(value, ["version", "status", "runId", "subject", "snapshotDigest", "positionCursor", "invocationId", "latestAttempt", "evidenceRead", "primary", "explanation"], "Navigator receipt");
  if (r.version !== 1 || !["ordinary", "insufficient", "refused", "escalated"].includes(String(r.status)) || !isUuidV7(r.invocationId)) fail("Navigator receipt");
  const cited = validatePrimaryShape(r.primary, r.status);
  if (!Array.isArray(r.evidenceRead)) fail("evidence read record");
  const reads = r.evidenceRead.map((x) => {
    const q = record(x, ["evidenceId", "fullyRead"], "evidence read");
    if (typeof q.evidenceId !== "string" || typeof q.fullyRead !== "boolean") fail("evidence read record");
    return { evidenceId: q.evidenceId, fullyRead: q.fullyRead };
  });
  if (new Set(reads.map((x) => x.evidenceId)).size !== reads.length || canonicalJson(reads) !== canonicalJson(actualReads)) fail("evidence read record");
  const receipt = r;
  if (!navigatorBindingMatchesV1(snapshot, receipt) || canonicalJson(subject(r.subject)) !== canonicalJson(snapshot.subject) || canonicalJson(receipt.latestAttempt) !== canonicalJson(snapshot.latestAttempt)) fail("receipt binding");
  if (cited.some((x) => !snapshot.evidence.some((e) => e.id === x) || !actualReads.some((read) => read.evidenceId === x))) fail("evidence citation");
  return receipt;
}
function navigatorBindingMatchesV1(snapshot, receipt) {
  return receipt.runId === snapshot.runId && receipt.snapshotDigest === snapshot.digest && receipt.positionCursor === snapshot.positionCursor;
}
const currentPositionSnapshotV1Schema = { type: "object", additionalProperties: false, required: ["version", "runId", "subject", "children", "positionCursor", "digest"] };
const navigatorReceiptV1Schema = { type: "object", additionalProperties: false, required: ["version", "status", "runId", "subject", "snapshotDigest", "positionCursor", "invocationId", "latestAttempt", "evidenceRead", "primary", "explanation"], properties: { version: { type: "integer", const: 1 }, status: { type: "string", enum: ["ordinary", "insufficient", "refused", "escalated"] }, runId: { type: "string" }, subject: { type: "object" }, snapshotDigest: { type: "string" }, positionCursor: { type: "integer", minimum: 0 }, invocationId: { type: "string" }, latestAttempt: { anyOf: [{ type: "object" }, { type: "null" }] }, evidenceRead: { type: "array", items: { type: "object", additionalProperties: false, required: ["evidenceId", "fullyRead"], properties: { evidenceId: { type: "string" }, fullyRead: { type: "boolean" } } } }, primary: { type: "object" }, explanation: { type: "string", minLength: 1 } } };
export {
  NAVIGATOR_OUTPUT_TOOL_NAME,
  PACKAGED_ROLES,
  canonicalSnapshotDigestV1,
  currentPositionSnapshotV1Schema,
  navigatorBindingMatchesV1,
  navigatorReceiptV1Schema,
  validateCurrentPositionSnapshotV1,
  validateNavigatorReceiptV1
};
