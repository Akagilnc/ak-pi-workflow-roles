/**
 * Durable Reviewer-rejection child→parent page under AK_ROLE_RUN_DIR.
 * Stays in public-cli (AK artifact owner); role-runtime imports this neighbor.
 */
import { writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { RoleTurnKnownFailure } from "../host-contracts.ts";
import {
  REVIEWER_PREFLIGHT_VIOLATIONS,
  type ReviewerPreflightViolation,
} from "../reviewer-dispatch.ts";

const REVIEWER_DISPATCH_REJECTION_FILE = "typed-known-failure.json";

function isReviewerPreflightViolation(value: unknown): value is ReviewerPreflightViolation {
  return (
    typeof value === "string" &&
    (REVIEWER_PREFLIGHT_VIOLATIONS as readonly string[]).includes(value)
  );
}

function reviewerDispatchRejectionPath(runDirectory: string): string {
  return join(runDirectory, REVIEWER_DISPATCH_REJECTION_FILE);
}

/**
 * Clear any prior attempt's Reviewer rejection page so resume/retry cannot
 * inherit a stale knownFailure.details.
 */
export async function clearReviewerDispatchRejection(runDirectory: string): Promise<void> {
  try {
    await unlink(reviewerDispatchRejectionPath(runDirectory));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Synchronous durable write for Reviewer dispatch rejection (child process exit is sync).
 * Parent public CLI recovers via readReviewerDispatchRejection into knownFailure.
 */
export function recordReviewerDispatchRejectionSync(
  runDirectory: string,
  rejection: Readonly<{
    diagnostic: string;
    violations: readonly ReviewerPreflightViolation[];
  }>,
): void {
  writeFileSync(
    reviewerDispatchRejectionPath(runDirectory),
    `${JSON.stringify(rejection)}\n`,
    "utf8",
  );
}

/** Recover a child-written Reviewer dispatch rejection through a fixed mapping. */
export async function readReviewerDispatchRejection(
  runDirectory: string,
): Promise<RoleTurnKnownFailure | undefined> {
  let raw: string;
  try {
    raw = await readFile(reviewerDispatchRejectionPath(runDirectory), "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const error = new Error("Reviewer dispatch rejection page must be a JSON object");
    error.name = "ReviewerDispatchRejectionContractError";
    throw error;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.diagnostic !== "string" ||
    record.diagnostic.trim() === "" ||
    !Array.isArray(record.violations) ||
    record.violations.length === 0 ||
    record.violations.some((value) => !isReviewerPreflightViolation(value))
  ) {
    const error = new Error("Reviewer dispatch rejection page has unusable required fields");
    error.name = "ReviewerDispatchRejectionContractError";
    throw error;
  }
  return {
    cause: "activation",
    diagnostic: record.diagnostic,
    identity: { name: "ReviewerDispatchRejectionError" },
    details: { violations: Object.freeze([...record.violations]) },
  };
}
