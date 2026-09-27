/**
 * Shared terminal classification and infrastructure failure identity for role output tools.
 */
import { LEGACY_REVIEW_OUTPUT_ROLES, PACKAGED_ROLE_REGISTRY } from "./packaged-role-registry.ts";

/** Typed durable infrastructure-failure fact on a packaged role output toolResult. */
export const ROLE_INFRASTRUCTURE_FAILURE_KIND = "role_infrastructure_failure" as const;

/** Required base identity keys for infrastructure-failure recognition. */
const INFRASTRUCTURE_FAILURE_KEYS = [
  "kind",
  "source",
  "reasonCode",
] as const;

/**
 * Known typed failure evidence keys projected onto durable infrastructure details (#475).
 * Extraction whitelist only — classification does not reject unknown extras (ADR 0040).
 */
export const ROLE_INFRASTRUCTURE_FAILURE_EVIDENCE_KEYS = [
  "observation",
  "candidate",
  "submission",
  "stage",
  "reason",
] as const;

export type RoleInfrastructureFailureFact = {
  kind: typeof ROLE_INFRASTRUCTURE_FAILURE_KIND;
  source: "shared-role-lifecycle";
  reasonCode: "host_failure";
};

export function buildRoleInfrastructureFailureFact(): RoleInfrastructureFailureFact {
  return {
    kind: ROLE_INFRASTRUCTURE_FAILURE_KIND,
    source: "shared-role-lifecycle",
    reasonCode: "host_failure",
  };
}

/**
 * Pull known typed evidence keys off a thrown infrastructure error onto durable
 * details (#475 / #593). Single owner for envelope catch and role-runtime pending.
 */
export function extractInfrastructureFailureEvidence(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  const evidence: Record<string, unknown> = {};
  for (const key of ROLE_INFRASTRUCTURE_FAILURE_EVIDENCE_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    // undefined → null so JSON durable details retain the empty-candidate key.
    evidence[key] = record[key] === undefined ? null : record[key];
  }
  return evidence;
}

/**
 * Base infrastructure-failure identity on durable details.
 * Only kind/source/reasonCode discriminate; extra fields are allowed and retained
 * (ADR 0040 — discriminators select the branch, they do not ban extras).
 */
export function hasRoleInfrastructureFailureBase(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of INFRASTRUCTURE_FAILURE_KEYS) {
    if (!Object.hasOwn(record, key)) return false;
  }
  return (
    record.kind === ROLE_INFRASTRUCTURE_FAILURE_KIND &&
    record.source === "shared-role-lifecycle" &&
    record.reasonCode === "host_failure"
  );
}

/**
 * Exact closed infrastructure-failure fact (no evidence extensions).
 * Classifier uses {@link hasRoleInfrastructureFailureBase} so enriched
 * durable details still complete as infrastructure (#475).
 */
export function isRoleInfrastructureFailureFact(
  value: unknown,
): value is RoleInfrastructureFailureFact {
  if (!hasRoleInfrastructureFailureBase(value)) return false;
  return Object.keys(value as object).length === INFRASTRUCTURE_FAILURE_KEYS.length;
}

const PACKAGED_ROLE_OUTPUT_TOOLS: ReadonlyMap<string, string> = new Map(
  [...PACKAGED_ROLE_REGISTRY.filter((entry) => entry.outputTool !== "ak_submission_output")
    .map((entry) => [entry.outputTool, entry.role] as const), ...LEGACY_REVIEW_OUTPUT_ROLES],
);

/** Shared terminal discriminant owned by one classifier. */
export type PackagedRoleTerminalClassification =
  | { readonly kind: "accepted" }
  | {
      readonly kind: "infrastructure";
      readonly fact: RoleInfrastructureFailureFact;
    }
  | { readonly kind: "nonterminal" };

export type PackagedRoleTerminalMessage = {
  readonly toolName?: unknown;
  readonly isError?: unknown;
  readonly details?: unknown;
};

/**
 * One shared typed terminal classifier for packaged role output toolResults.
 * Consumed by lifecycle principal completion and every public CLI role Receipt extractor.
 */
export function classifyPackagedRoleTerminalResult(
  message: PackagedRoleTerminalMessage,
): PackagedRoleTerminalClassification {
  if (typeof message.toolName !== "string") return { kind: "nonterminal" };
  if (!PACKAGED_ROLE_OUTPUT_TOOLS.has(message.toolName) && message.toolName !== "ak_submission_output") return { kind: "nonterminal" };

  // Base identity is enough; durable details may carry typed failure evidence (#475).
  const hasInfraBase = hasRoleInfrastructureFailureBase(message.details);
  const infraFact = hasInfraBase ? buildRoleInfrastructureFailureFact() : undefined;

  // Infrastructure completion: exact isError === true + infra base identity.
  if (message.isError === true) {
    if (infraFact === undefined) return { kind: "nonterminal" };
    return { kind: "infrastructure", fact: infraFact };
  }
  // Accepted/human completion: exact isError === false and must not carry infra fact.
  if (message.isError === false) {
    if (infraFact !== undefined) return { kind: "nonterminal" };
    return { kind: "accepted" };
  }
  // Missing, non-boolean, contradictory, or malformed shapes fail closed.
  return { kind: "nonterminal" };
}

/**
 * Durable-completion boolean over the shared classifier
 * (accepted/human or infrastructure terminal).
 */
export function isDurablePackagedRoleTerminalResult(
  message: PackagedRoleTerminalMessage,
): boolean {
  const classification = classifyPackagedRoleTerminalResult(message);
  return classification.kind === "accepted" || classification.kind === "infrastructure";
}

/** Receipt extractors admit only exact accepted/human terminals. */
export function isAcceptedPackagedRoleTerminalResult(
  message: PackagedRoleTerminalMessage,
): boolean {
  return classifyPackagedRoleTerminalResult(message).kind === "accepted";
}
