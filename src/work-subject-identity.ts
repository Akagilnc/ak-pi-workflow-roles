/**
 * Single low-level work-subject identity owner.
 * Navigator lifecycle and Terminal settlement both import this module so subject
 * keys cannot drift across a duplicated helper. Depends only on path topology —
 * never the Navigator preparation graph or public-cli bundle surface.
 */
import { resolve } from "node:path";

import {
  physicalPathIdentity,
  physicallyContainedIn,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";

/**
 * Issue-root segment under `.ak/work/issues/<id>` (optional `#…` suffix stripped).
 * Single low-level owner — Navigator subject helpers must not reimplement this.
 */
export function issueRoot(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  const marker = ".ak/work/issues/";
  const index = normalized.indexOf(marker);
  if (index < 0) return undefined;
  const issue = normalized
    .slice(index + marker.length)
    .split("/")[0]
    ?.split("#")[0];
  return issue === undefined || issue === ""
    ? undefined
    : normalized.slice(0, index + marker.length) + issue;
}

function workIdentityFromCwd(cwd: string): string | undefined {
  const resolvedCwd = resolve(cwd, ".");
  const cwdIssue = issueRoot(resolvedCwd);
  if (cwdIssue !== undefined) return cwdIssue;
  if (resolvedCwd.includes("/.ak/work/")) return resolvedCwd;
  return undefined;
}

/** Machine-ledger session paths are not work identity (ADR 0048 session-in-home). */
function isMachineLedgerSessionPath(sessionPath: string): boolean {
  // Physical containment under the package ledger home — never directory spelling,
  // and stable across macOS /var ↔ /private/var realpath asymmetry. Path → ledger
  // home is topology-owned (passwd or explicit injection via `.ak-roles` path).
  return physicallyContainedIn(resolveActivationLedgerHomeForPath(sessionPath), sessionPath);
}

/**
 * Derive the durable work-subject key from a session directory and cwd.
 * Session placement is an implementation detail; relative and absolute role
 * invocations share one key.
 */
export function subjectPath(sessionDir: string, cwd = process.cwd()): string {
  if (sessionDir === "") {
    // Preserve prior fall-through: empty sessionDir with no work cwd → cwd/.ak/work.
    return workIdentityFromCwd(cwd) ?? resolve(cwd, ".ak/work");
  }
  const resolvedSession = resolve(cwd, sessionDir || ".ak/work");
  // Durable role sessions under the machine ledger home are not work roots.
  // Derive subject from cwd (same as empty sessionDir / in-memory) so Navigator
  // keeps issue-root identity when ignition places --session-dir under ADR 0048.
  // Ordinary repository cwd with no explicit work identity uses the established
  // cwd-derived `.ak/work` fallback — never the per-invocation ledger session path.
  if (isMachineLedgerSessionPath(resolvedSession)) {
    return workIdentityFromCwd(cwd) ?? resolve(cwd, ".ak/work");
  }
  const issue = issueRoot(resolvedSession);
  if (issue !== undefined) return issue;
  // Ad-hoc role sessions live below the same work root.  Remove the role's
  // private run directory before deriving identity; the run/session spelling
  // must not become a cross-role routing key.
  const runsMarker = "/runs/";
  const runsIndex = resolvedSession.indexOf(runsMarker);
  if (runsIndex >= 0) {
    return resolvedSession.slice(0, runsIndex);
  }
  return resolvedSession;
}

/**
 * Project/cwd work identity used by public CLI / empty-sessionDir runs.
 * Equivalent to subjectPath("", projectRoot).
 */
export function workSubjectKeyFromProjectRoot(projectRoot: string): string {
  return subjectPath("", projectRoot);
}

/**
 * Physical work-subject equality: collapses macOS /var ↔ /private/var (and any
 * other realpath alias) so the same work root correlates across path spellings.
 */
export function workSubjectKeysEqual(left: string, right: string): boolean {
  return physicalPathIdentity(left) === physicalPathIdentity(right);
}
