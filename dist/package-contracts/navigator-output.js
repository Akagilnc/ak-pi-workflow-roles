import { isUuidV7 } from "../uuidv7.js";
export const NAVIGATOR_OUTPUT_TOOL_NAME = "ak_navigator_output";
const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40,64}$/;
const ROLES = ["judge", "fixer", "coder", "reviewer", "collector", "doctor"];
function fail() { throw new Error("invalid Navigator receipt"); }
function rec(v, keys) { if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k)))
    fail(); return v; }
function text(v) { if (typeof v !== "string" || v.length === 0)
    fail(); return v; }
function strings(v) { if (!Array.isArray(v) || v.some(x => typeof x !== "string"))
    fail(); }
function subject(v) { const s = rec(v, ["repositoryRoot", "github", "parent"]), g = rec(s.github, ["owner", "name", "id"]), p = rec(s.parent, ["number", "id"]); text(s.repositoryRoot); text(g.owner); text(g.name); text(g.id); if (!Number.isSafeInteger(p.number) || p.number < 1)
    fail(); text(p.id); }
function attempt(v) { if (v === null)
    return; const a = rec(v, ["invocationId", "role", "phase", "beforeTarget", "afterTarget", "terminalClass", "reference"]), r = rec(a.reference, ["id", "sha256"]); if (!isUuidV7(a.invocationId) || !ROLES.includes(String(a.role)) || ((a.role === "coder" || a.role === "fixer") ? (a.phase !== "plan" && a.phase !== "apply") : a.phase !== null) || !OID.test(String(a.beforeTarget)) || !OID.test(String(a.afterTarget)) || !["accepted_receipt", "role_refusal", "role_escalation", "infrastructure_failure", "cancellation", "outcome_unavailable_after_runner_loss"].includes(String(a.terminalClass)) || !SHA256.test(String(r.sha256)))
    fail(); text(r.id); }
function primary(v, status) { const p = v; if (!p || typeof p !== "object" || Array.isArray(p))
    fail(); const kind = p.kind; if (status === "ordinary" && !['package_role', 'caller_action', 'stop'].includes(String(kind)))
    fail(); if (status === "insufficient" && kind !== "obtain_evidence_and_reconsult")
    fail(); if (status === "refused" && kind !== "return_scope_or_authority_defect")
    fail(); if (status === "escalated" && kind !== "seek_owner_decision")
    fail(); if (kind === "package_role") {
    rec(p, ["kind", "role", "phase", "evidenceIds", "conditions", "hazards"]);
    if (!ROLES.includes(String(p.role)) || ((p.role === "coder" || p.role === "fixer") ? (p.phase !== "plan" && p.phase !== "apply") : p.phase !== null))
        fail();
    strings(p.conditions);
    strings(p.hazards);
}
else if (kind === "caller_action") {
    rec(p, ["kind", "actionCategory", "evidenceIds", "conditions", "hazards"]);
    if (!["obtain_evidence", "design_authority", "review_batch", "repository_action"].includes(String(p.actionCategory)))
        fail();
    strings(p.conditions);
    strings(p.hazards);
}
else if (kind === "stop") {
    rec(p, ["kind", "reasonCategory", "evidenceIds", "conditions", "hazards"]);
    if (!["complete", "unsafe", "not_cost_effective"].includes(String(p.reasonCategory)))
        fail();
    strings(p.conditions);
    strings(p.hazards);
}
else if (kind === "obtain_evidence_and_reconsult") {
    rec(p, ["kind", "missing", "evidenceIds"]);
    if (!Array.isArray(p.missing) || p.missing.length === 0)
        fail();
    for (const m of p.missing) {
        const x = rec(m, ["kind", "identity"]);
        text(x.kind);
        text(x.identity);
    }
}
else if (kind === "return_scope_or_authority_defect") {
    rec(p, ["kind", "defect", "evidenceIds"]);
    const d = rec(p.defect, ["category", "evidenceId"]);
    if (!["contradictory_subject", "out_of_scope", "authority_conflict"].includes(String(d.category)))
        fail();
    text(d.evidenceId);
}
else if (kind === "seek_owner_decision") {
    rec(p, ["kind", "decision", "evidenceIds"]);
    const d = rec(p.decision, ["category", "question"]);
    text(d.category);
    text(d.question);
}
else
    fail(); strings(p.evidenceIds); }
export function validateRecordedNavigatorReceiptV1(value) { const r = rec(value, ["version", "status", "runId", "subject", "snapshotDigest", "positionCursor", "invocationId", "latestAttempt", "evidenceRead", "primary", "explanation"]); if (r.version !== 1 || !["ordinary", "insufficient", "refused", "escalated"].includes(String(r.status)) || !isUuidV7(r.runId) || !isUuidV7(r.invocationId) || !SHA256.test(String(r.snapshotDigest)) || !Number.isSafeInteger(r.positionCursor) || r.positionCursor < 0)
    fail(); subject(r.subject); attempt(r.latestAttempt); if (!Array.isArray(r.evidenceRead))
    fail(); for (const read of r.evidenceRead) {
    const x = rec(read, ["evidenceId", "fullyRead"]);
    text(x.evidenceId);
    if (typeof x.fullyRead !== "boolean")
        fail();
} if (new Set(r.evidenceRead.map(x => x.evidenceId)).size !== r.evidenceRead.length)
    fail(); primary(r.primary, String(r.status)); text(r.explanation); return r; }
