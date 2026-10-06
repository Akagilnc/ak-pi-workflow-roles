/**
 * Navigator attendance session factory (#675 r3 / #1178).
 * Each prepare turn uses the public navigator activation path (summonPublicRole) —
 * same seat table and shared envelope as `ak-role navigator`.
 * Advice and run facts stay on the nested @navigator run dossier only —
 * no books/<book>/navigator/<hash>/ side-branch nest, work-context file,
 * current-session pointer, or attendance parallel ledger (#1178).
 * Host conversation continuity uses CLI resume (`resumeRunId`) within this
 * attendance lifetime (in-memory pointer); cross-turn design is #1160.
 */
import { basename } from "node:path";

import { sitianReportSafe } from "./host-session-record.ts";
import {
  NavigatorUnavailableError,
  navigatorProviderFailureFromPublicTerminal,
  navigatorProviderFailureFromError,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  type NavigatorProviderFailureFact,
  type NavigatorSessionFactory,
} from "./navigator-session-contracts.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import { runDirectoryFromHostContext, type HostContext } from "./host-contracts.ts";
import { parseRunLeaf } from "./role-run-placement.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import { CliUsageError } from "./public-cli/cli-errors.ts";
import { isNavigatorSeat } from "./packaged-role-registry.ts";

/**
 * Ledger process home for navigator summon: admitted HostContext.runDirectory
 * first, else a parent session file under .ak-roles. Never context.home / env HOME /
 * passwd guesses (#852).
 */
async function resolveNavigatorLedgerHome(context: HostContext): Promise<string | undefined> {
  const { tryHomeFromAkRolesPath } = await import(
    "./activation-ledger-topology.ts"
  );
  const runDirectory = runDirectoryFromHostContext(context);
  if (runDirectory !== undefined) {
    const fromRun = tryHomeFromAkRolesPath(runDirectory);
    if (fromRun !== undefined && fromRun.length > 0) return fromRun;
  }
  const parentFile = context.sessionManager?.getSessionFile?.();
  if (typeof parentFile === "string" && parentFile.trim() !== "") {
    const fromParent = tryHomeFromAkRolesPath(parentFile);
    if (fromParent !== undefined && fromParent.length > 0) return fromParent;
  }
  return undefined;
}

export function runIdFromNavigatorDirectory(runDirectory: string): string | undefined {
  const parsed = parseRunLeaf(basename(runDirectory));
  if (parsed === undefined || parsed.role !== "navigator") return undefined;
  return parsed.runId;
}

/**
 * Typed preflight via public CLI load path: can this run reopen as navigator?
 * CliUsageError (code AK_ROLE_USAGE) from loadResumablePublicRole means
 * unknown id or principal unavailable — not resumable. Any other disk role
 * is not this navigator host run. Other throws propagate. Never reads stderr prose.
 */
export async function navigatorHostRunResumable(home: string, runId: string): Promise<boolean> {
  const { piDurablePrincipalAuthority } = await import("./pi/durable-principal.ts");
  const { loadResumablePublicRole } = await import("./public-cli/run-lifecycle.ts");
  try {
    const loaded = await loadResumablePublicRole(home, runId, piDurablePrincipalAuthority);
    return isNavigatorSeat(loaded.admitted.role);
  } catch (error) {
    if (error instanceof CliUsageError) return false;
    throw error;
  }
}

export type NavigatorPublicSummon = (options: {
  readonly role: "navigator";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly home?: string;
  readonly resumeRunId?: string;
  /** Shared-lifecycle cancel forwarded from HostContext.signal (#675 / #959). */
  readonly signal?: AbortSignal;
}) => Promise<PublicSummonResult>;

type MemoryEntry = {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
};

export function createNativeNavigatorSessionFactory(deps?: {
  /** Test/composition inject — production leaves unset and uses public-role-summons. */
  readonly summonPublicRole?: NavigatorPublicSummon;
  /** Test inject — production uses navigatorHostRunResumable (typed CLI load). */
  readonly hostRunResumable?: (home: string, runId: string) => Promise<boolean>;
}): NavigatorSessionFactory {
  return async ({ context, tool }) => {
    // Model is enforced at prepare (attendance seat resolve) and at prompt (summon).
    // Factory open only holds in-memory attendance bookkeeping — no side-branch nest.
    let thinkingLevel: string | undefined;
    const entries: MemoryEntry[] = [];
    let providerFailure: NavigatorProviderFailureFact | undefined;
    let noReceipt: Partial<NoReceiptLifecycleFacts> | undefined;
    let routePlaybookReadFailure: string | undefined;
    let disposed = false;
    /** In-factory host run id for CLI resume within this attendance lifetime. */
    let hostRunId: string | undefined;

    const summon: NavigatorPublicSummon = deps?.summonPublicRole
      ?? (async (options) => {
        const { summonPublicRole } = await import("./public-role-summons.ts");
        return summonPublicRole(options);
      });

    const parentSessionFile = (): string | undefined =>
      context.sessionManager?.getSessionFile?.();

    return {
      prompt: async (text) => {
        if (disposed) {
          throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
        }
        providerFailure = undefined;
        noReceipt = undefined;
        routePlaybookReadFailure = undefined;
        try {
          const summonHome = await resolveNavigatorLedgerHome(context);
          // Admission after every await: dispose during preflight must not start summon
          // (ADR 0018 / #959 — legal HostContext may omit signal).
          if (disposed) return;
          const resumeRunId = hostRunId;

          // Call contract only: forward shared-lifecycle signal; do not own AbortController here
          // (ADR 0018 / #959 — cancel ownership stays on the attendance/envelope seam).
          const baseSummon = {
            role: "navigator" as const,
            argv: [text] as const,
            cwd: context.cwd,
            ...(summonHome === undefined ? {} : { home: summonHome }),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          };

          // Prefer host CLI resume so prior advice stays on the host session.
          // Fresh mint only when typed load says the principal cannot reopen.
          const resumable = deps?.hostRunResumable ?? navigatorHostRunResumable;
          let summoned: PublicSummonResult;
          if (resumeRunId === undefined || summonHome === undefined) {
            if (disposed) return;
            summoned = await summon(baseSummon);
          } else {
            const canResume = await resumable(summonHome, resumeRunId);
            if (disposed) return;
            if (canResume) {
              summoned = await summon({ ...baseSummon, resumeRunId });
            } else {
              hostRunId = undefined;
              summoned = await summon(baseSummon);
            }
          }

          // Dispose won the race (with or without HostContext.signal): no late pointer/prepare.
          // Cancel ownership stays on attendance/envelope; this only closes side effects (#959).
          if (disposed) return;

          const playbookFailure = summoned.terminal?.navigator?.advisoryDiagnostic;
          routePlaybookReadFailure = typeof playbookFailure === "string" && playbookFailure.trim() !== ""
            ? playbookFailure
            : undefined;
          const outcome = summoned.terminal?.roleOutcome;
          if (outcome === undefined) {
            const detail = summoned.stderr?.trim() || `exit ${summoned.exitCode}`;
            // Known source is the public-summon transport path; unconfirmed cause stays unknown.
            providerFailure = { source: "transport", cause: "unknown" };
            throw navigatorUnavailableError(
              providerFailure.source,
              new Error(`Navigator public summon produced no terminal (${detail})`),
              providerFailure.cause,
            );
          }
          if (outcome.kind === "failure") {
            providerFailure = navigatorProviderFailureFromPublicTerminal(outcome);
            const failedAttempts = outcome.decisiveFacts.failedAttempts;
            const attemptReasons = Array.isArray(failedAttempts)
              ? failedAttempts.map((entry: unknown, index: number) => {
                const fact = entry !== null && typeof entry === "object"
                  ? entry as { attempt?: unknown; diagnostic?: unknown }
                  : undefined;
                return `${typeof fact?.attempt === "number" ? fact.attempt + 1 : index + 1}: ${
                  typeof fact?.diagnostic === "string" ? fact.diagnostic : outcome.diagnostic
                }`;
              })
              : [];
            throw navigatorUnavailableError(
              providerFailure.source,
              new Error(attemptReasons.length > 0 ? attemptReasons.join("\n") : outcome.diagnostic),
              providerFailure.cause,
            );
          }
          if (outcome.kind === "no_receipt") {
            // The nested session spent its own delivery budget; attendance settles
            // no-receipt on these facts instead of opening another summon (#675).
            noReceipt = outcome;
            return;
          }

          // Pin host run for the next attendance prompt in this lifetime (CLI resume key).
          const runDirectory = summoned.runDirectory
            ?? (typeof summoned.admitted?.runDirectory === "string"
              ? summoned.admitted.runDirectory
              : undefined);
          if (typeof runDirectory === "string" && runDirectory.trim() !== "") {
            const nextRunId = runIdFromNavigatorDirectory(runDirectory);
            if (nextRunId !== undefined) {
              // In-memory only for this attendance lifetime (#1178) — no side-branch pointer ledger.
              hostRunId = nextRunId;
            }
          }

          if (outcome.kind !== "accepted") {
            // Non-accepted kinds (e.g. audit_escalation): no prose advice this turn.
            // Not a shape-unusable judgment on the navigator reply (#757).
            return;
          }
          // #959: present navigator words as prose. No candidates/next parsing.
          const { navigatorProseFromUnknown } = await import("./package-contracts/navigator-output.ts");
          const proseParts: string[] = [];
          for (const payload of outcome.payloads ?? []) {
            const prose = navigatorProseFromUnknown(payload);
            if (prose !== undefined) proseParts.push(prose);
          }
          if (proseParts.length === 0) return;
          if (disposed) return;
          await tool.execute(
            "navigator-public-prepare",
            { prose: proseParts.join("\n\n") },
            undefined,
            undefined,
            context as never,
          );
        } catch (error) {
          // Closed session: drain late nest errors without providerFailure side effects.
          if (disposed) return;
          if (error instanceof NavigatorUnavailableError) throw error;
          const fact = navigatorProviderFailureFromError(error);
          // Catch path is the public-summon seam (source transport); untyped cause stays unknown.
          providerFailure = fact ?? { source: "transport", cause: "unknown" };
          throw navigatorUnavailableError(providerFailure.source, error, providerFailure.cause);
        }
      },
      providerFailure: () => providerFailure,
      noReceipt: () => noReceipt,
      routePlaybookReadFailure: () => routePlaybookReadFailure,
      appendEntry: (customType, data) => {
        entries.push({ type: "custom", customType, data });
        const parent = parentSessionFile();
        sitianReportSafe({
          level: "event",
          kind: "attendance",
          cwd: context.cwd,
          ...(parent === undefined ? {} : { sessionParent: parent }),
          payload: { customType, data },
          source: "navigator-public-session",
        });
      },
      entries: () => entries,
      setModel: async (next, nextThinking) => {
        let nextParsed: ReturnType<typeof parseNavigatorModelSetting>;
        try {
          nextParsed = parseNavigatorModelSetting(next);
        } catch (error) {
          throw navigatorUnavailableError("model", error);
        }
        // Resume and fresh mint both read the live seat table (#675 / #617 DK-3).
        // A seat edit between prepares applies on the next host turn.
        thinkingLevel = nextThinking ?? nextParsed.thinkingLevel;
      },
      getThinkingLevel: () => thinkingLevel,
      // No side-branch nest path — empty pointer so work-base persist is a no-op.
      recordPointer: () => "",
      dispose: async () => {
        // Marker only — nested cancel and non-blocking teardown are owned by
        // navigator-attendance / role-runtime (ADR 0018 / #959).
        disposed = true;
      },
    };
  };
}
