/**
 * Navigator attendance session factory (#675 r3).
 * Each prepare turn uses the public navigator activation path (summonPublicRole) —
 * same seat table and shared envelope as `ak-role navigator`.
 * Archivist createRecordSession books the attendance nest under the parent;
 * host conversation continuity uses CLI resume (`resumeRunId`), not a package
 * advice ledger (development-closure: do not invent package-level memory).
 */
import { basename } from "node:path";

import { sitianReport } from "./sitian-facade.ts";
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
import type { PublicSummonResult } from "./public-role-summons.ts";
import { CliUsageError } from "./public-cli/cli-errors.ts";

/**
 * Ledger process home for navigator attendance: admitted HostContext.runDirectory
 * first, else a parent session file under .ak-roles. Never context.home / env HOME /
 * passwd guesses — those split the nest from the owning run (#852).
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

/** Resume key only — points at a host run principal, never stores advice prose. */
export const NAVIGATOR_HOST_RUN_POINTER_ENTRY = "ak-navigator-host-run";

function exactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function runIdFromNavigatorDirectory(runDirectory: string): string | undefined {
  const entry = basename(runDirectory);
  const suffix = "@navigator";
  if (!entry.endsWith(suffix)) return undefined;
  const runId = entry.slice(0, entry.length - suffix.length);
  return runId.length > 0 ? runId : undefined;
}

export function readNavigatorHostRunPointer(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!exactRecord(entry)) continue;
    if (entry.type === "custom" && entry.customType === NAVIGATOR_HOST_RUN_POINTER_ENTRY) {
      const data = entry.data;
      if (exactRecord(data) && typeof data.runId === "string" && data.runId.trim() !== "") {
        return data.runId.trim();
      }
    }
  }
  return undefined;
}

/**
 * Typed preflight via public CLI load path: can this run reopen as navigator?
 * CliUsageError (code AK_ROLE_USAGE) from loadResumableInstructionSeatRun means
 * unknown id / principal unavailable / non-instruction seat — not resumable.
 * Other throws propagate. Never reads stderr prose.
 */
export async function navigatorHostRunResumable(home: string, runId: string): Promise<boolean> {
  const { piDurablePrincipalAuthority } = await import("./pi/durable-principal.ts");
  const { loadResumableInstructionSeatRun } = await import("./public-cli/run-lifecycle.ts");
  try {
    const loaded = await loadResumableInstructionSeatRun(home, runId, piDurablePrincipalAuthority);
    return loaded.admitted.role === "navigator";
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

export function createNativeNavigatorSessionFactory(deps?: {
  /** Test/composition inject — production leaves unset and uses public-role-summons. */
  readonly summonPublicRole?: NavigatorPublicSummon;
  /** Test inject — production uses navigatorHostRunResumable (typed CLI load). */
  readonly hostRunResumable?: (home: string, runId: string) => Promise<boolean>;
}): NavigatorSessionFactory {
  return async ({ context, subject, tool }) => {
    // Model is enforced at prepare (attendance seat resolve) and at prompt (summon).
    // Factory open only books the archivist nest — no package default, no eager seat read.
    let thinkingLevel: string | undefined;

    // Archivist nest for attendance bookkeeping (ADR 0018 / 0065) — not a host session open.
    // #852: navigator/<work-subject> is the sole book-top exception; always pass subject so
    // unmaterialized/missing parent still gets a durable nest instead of silent in-memory.
    // Home comes from HostContext.runDirectory (or ledger parent path) — never context.home.
    const { createRecordSession, NAVIGATOR_RECORD_KIND } = await import("./archivist-record-entry.ts");
    const home = await resolveNavigatorLedgerHome(context);
    const sessionManager = createRecordSession({
      cwd: context.cwd,
      kind: NAVIGATOR_RECORD_KIND,
      subject,
      ...(context.sessionManager !== undefined ? { parent: context.sessionManager } : {}),
      ...(home !== undefined ? { home } : {}),
    });

    let providerFailure: NavigatorProviderFailureFact | undefined;
    let noReceipt: NoReceiptLifecycleFacts | undefined;
    let disposed = false;
    /** In-factory host run id for CLI resume; durable pointer also lives on the nest. */
    let hostRunId = readNavigatorHostRunPointer(sessionManager.getEntries() as readonly unknown[]);

    const summon: NavigatorPublicSummon = deps?.summonPublicRole
      ?? (async (options) => {
        const { summonPublicRole } = await import("./public-role-summons.ts");
        return summonPublicRole(options);
      });

    return {
      prompt: async (text) => {
        if (disposed) {
          throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
        }
        providerFailure = undefined;
        noReceipt = undefined;
        try {
          const summonHome = await resolveNavigatorLedgerHome(context);
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
            summoned = await summon(baseSummon);
          } else if (await resumable(summonHome, resumeRunId)) {
            summoned = await summon({ ...baseSummon, resumeRunId });
          } else {
            hostRunId = undefined;
            summoned = await summon(baseSummon);
          }

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
            throw navigatorUnavailableError(
              providerFailure.source,
              new Error(outcome.diagnostic),
              providerFailure.cause,
            );
          }
          if (outcome.kind === "no_receipt") {
            // The nested session spent its own delivery budget; attendance settles
            // no-receipt on these facts instead of opening another summon (#675).
            noReceipt = outcome;
            return;
          }

          // Pin host run for the next attendance prompt on this subject (CLI resume key).
          const runDirectory = summoned.runDirectory
            ?? (typeof summoned.admitted?.runDirectory === "string"
              ? summoned.admitted.runDirectory
              : undefined);
          if (typeof runDirectory === "string" && runDirectory.trim() !== "") {
            const nextRunId = runIdFromNavigatorDirectory(runDirectory);
            if (nextRunId !== undefined) {
              hostRunId = nextRunId;
              sessionManager.appendCustomEntry(NAVIGATOR_HOST_RUN_POINTER_ENTRY, { runId: nextRunId });
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
          await tool.execute(
            "navigator-public-prepare",
            { prose: proseParts.join("\n\n") },
            undefined,
            undefined,
            context as never,
          );
        } catch (error) {
          if (error instanceof NavigatorUnavailableError) throw error;
          const fact = navigatorProviderFailureFromError(error);
          // Catch path is the public-summon seam (source transport); untyped cause stays unknown.
          providerFailure = fact ?? { source: "transport", cause: "unknown" };
          throw navigatorUnavailableError(providerFailure.source, error, providerFailure.cause);
        }
      },
      providerFailure: () => providerFailure,
      noReceipt: () => noReceipt,
      appendEntry: (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
        try {
          sitianReport({
            level: "event",
            kind: "attendance",
            cwd: context.cwd,
            sessionParent: sessionManager.getSessionFile(),
            payload: { customType, data },
            source: "navigator-public-session",
          });
        } catch {
          // best-effort
        }
      },
      entries: () => sessionManager.getEntries(),
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
      recordPointer: () => sessionManager.getSessionDir(),
      dispose: async () => {
        // Marker only — nested cancel and non-blocking teardown are owned by
        // navigator-attendance / role-runtime (ADR 0018 / #959).
        disposed = true;
      },
    };
  };
}
