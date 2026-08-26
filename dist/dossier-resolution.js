/**
 * Unique dossier-resolution seam for 审刑院 (#233).
 * Machine pointers only: cwd + AK_ROLE_RUN_DIR. No latest-run / mtime / global scan.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { JUDGE_OUTPUT_TOOL_NAME as JUDGE_OUTPUT_TOOL } from "./package-contracts/judge-output.js";
export const JUDGE_OUTPUT_TOOL_NAME = JUDGE_OUTPUT_TOOL;
export const AUDIT_RUN_DIR_ENV = "AK_ROLE_RUN_DIR";
export const REVIEWER_CANDIDATE_ENTRY_TYPE = "ak_reviewer_audit_candidate";
export const DOCTOR_CANDIDATE_ENTRY_TYPE = "ak_doctor_audit_candidate";
/**
 * Resolve the per-run dossier pointer injected by the public CLI.
 *
 * Absent pointer = bare Pi internal seam (ADR 0052): audit proceeds; the model
 * self-locates the dossier from its own fall-volume position per soul. Public CLI
 * always injects the pointer — only then does the machine validate the path.
 * Concurrent runs stay isolated because a present pointer is per-process.
 */
export function resolveAuditDossier(env = process.env) {
    const raw = env[AUDIT_RUN_DIR_ENV];
    // Bare Pi activation seam: no machine gate when the pointer was never injected.
    if (typeof raw !== "string" || raw.trim() === "") {
        return { status: "ok" };
    }
    const runDirectory = resolve(raw);
    try {
        if (!existsSync(runDirectory) || !statSync(runDirectory).isDirectory()) {
            return { status: "incomplete", observation: { kind: "missing-dossier" } };
        }
    }
    catch {
        return { status: "incomplete", observation: { kind: "missing-dossier" } };
    }
    return { status: "ok", runDirectory };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Judge subjects must already be on the parent session books before audit starts:
 * assignment (user message) + candidate verdict (sole judge output tool call).
 */
export function readJudgeAuditSubjects(context) {
    const entries = context.sessionManager.getEntries?.() ?? [];
    let hasAssignment = false;
    let hasCandidate = false;
    for (const entry of entries) {
        if (entry.type !== "message")
            continue;
        const message = entry.message;
        if (message.role === "user") {
            const text = typeof message.content === "string"
                ? message.content
                : Array.isArray(message.content)
                    ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
                    : "";
            if (text.trim().length > 0)
                hasAssignment = true;
        }
        if (message.role === "assistant" && Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === "toolCall" && part.name === JUDGE_OUTPUT_TOOL_NAME && isRecord(part.arguments)) {
                    hasCandidate = true;
                }
            }
        }
    }
    if (!hasAssignment) {
        return { status: "incomplete", observation: { kind: "missing-subject", subject: "assignment" } };
    }
    if (!hasCandidate) {
        return { status: "incomplete", observation: { kind: "missing-subject", subject: "candidate-verdict" } };
    }
    return { status: "ok" };
}
/**
 * Reviewer candidate receipt must be recorded before audit (first-record-then-audit).
 */
export function readReviewerAuditSubjects(context) {
    const entries = context.sessionManager.getEntries?.() ?? [];
    for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === REVIEWER_CANDIDATE_ENTRY_TYPE) {
            return { status: "ok" };
        }
    }
    return { status: "incomplete", observation: { kind: "missing-subject", subject: "candidate-receipt" } };
}
/**
 * Doctor candidate testimony must be recorded before audit.
 */
export function readDoctorAuditSubjects(context) {
    const entries = context.sessionManager.getEntries?.() ?? [];
    for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === DOCTOR_CANDIDATE_ENTRY_TYPE) {
            return { status: "ok" };
        }
    }
    return { status: "incomplete", observation: { kind: "missing-subject", subject: "candidate-testimony" } };
}
/**
 * Missing dossier/subject is infrastructure failure, not a judgment status (#475).
 * Observation + empty candidate ride the existing failInfrastructure → error artifact path.
 */
export class AuditMaterialsUnavailableError extends Error {
    observation;
    candidate;
    constructor(observation) {
        const detail = observation.kind === "missing-subject"
            ? `${observation.kind}:${observation.subject}`
            : observation.kind;
        super(`Audit materials unavailable: ${detail}`);
        this.name = "AuditMaterialsUnavailableError";
        this.observation = observation;
        this.candidate = undefined;
    }
}
export function requireAuditMaterials(resolution) {
    if (resolution.status === "incomplete") {
        throw new AuditMaterialsUnavailableError(resolution.observation);
    }
}
