/**
 * Mechanical bundle materialization was removed under issue #236 / ADR 0031.
 * Task, canonical Skill, and fixed range facts are delivered as direct prompt text.
 * This module remains only so historical import paths fail closed with a clear error.
 */

export type MaterializedBundleEvidenceV1 = never;

export async function materializeMechanicalBundle(): Promise<never> {
  throw new Error("Mechanical bundle materialization was removed; deliver task, Skill, and range as direct text");
}
