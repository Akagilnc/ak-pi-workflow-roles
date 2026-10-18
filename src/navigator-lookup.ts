/**
 * Automatic navigator attendance lookup (#1192, builds on #1160).
 * The parent role's start summons the navigator public activation — an ordinary
 * `@navigator` run that looks its rows up in navigator-route-table with no model
 * and no host session. The parent role arrives as the structured `--role` input,
 * never inferred from prose. A failed lookup is reported with its real cause.
 */
import {
  mergePreparedAdvice,
  preparedAdviceFromUnknown,
  type PreparedNavigatorAdvice,
} from "./package-contracts/navigator-output.ts";
import { runDirectoryFromHostContext, type HostContext } from "./host-contracts.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";

export type NavigatorUnavailableKey = "session" | "unknown";

export class NavigatorUnavailableError extends Error {
  readonly unavailableSource: NavigatorUnavailableKey;
  readonly originalCause: unknown;

  constructor(source: NavigatorUnavailableKey, message: string, originalCause?: unknown) {
    super(message);
    this.name = "NavigatorUnavailableError";
    this.unavailableSource = source;
    this.originalCause = originalCause;
  }
}

export function navigatorUnavailableError(source: NavigatorUnavailableKey, error: unknown): NavigatorUnavailableError {
  if (error instanceof NavigatorUnavailableError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NavigatorUnavailableError(source, message, error);
}

/** One attendance lookup: the parent role's rows, or undefined when it has none. */
export type NavigatorLookup = (input: {
  readonly context: HostContext;
  readonly role: string;
}) => Promise<PreparedNavigatorAdvice | undefined>;

type NavigatorSummon = (options: {
  readonly role: "navigator";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly home?: string;
  readonly signal?: AbortSignal;
}) => Promise<PublicSummonResult>;

/**
 * Ledger process home for the nested summon: the admitted run directory first,
 * else the parent session file under .ak-roles. Never ambient HOME (#852).
 */
async function ledgerHomeFor(context: HostContext): Promise<string | undefined> {
  const { tryHomeFromAkRolesPath } = await import("./activation-ledger-topology.ts");
  for (const path of [runDirectoryFromHostContext(context), context.sessionManager?.getSessionFile?.()]) {
    if (typeof path !== "string" || path.trim() === "") continue;
    const home = tryHomeFromAkRolesPath(path);
    if (home !== undefined && home.length > 0) return home;
  }
  return undefined;
}

export function createNavigatorLookup(deps?: { readonly summonPublicRole?: NavigatorSummon }): NavigatorLookup {
  const summon: NavigatorSummon = deps?.summonPublicRole
    ?? (async (options) => (await import("./public-role-summons.ts")).summonPublicRole(options));
  return async ({ context, role }) => {
    const home = await ledgerHomeFor(context);
    let summoned: PublicSummonResult;
    try {
      summoned = await summon({
        role: "navigator",
        argv: ["--role", role],
        cwd: context.cwd,
        ...(home === undefined ? {} : { home }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
    } catch (error) {
      throw navigatorUnavailableError("session", error);
    }
    const outcome = summoned.terminal?.roleOutcome;
    if (outcome === undefined) {
      const detail = summoned.stderr?.trim() || `exit ${summoned.exitCode}`;
      throw new NavigatorUnavailableError("session", `Navigator lookup produced no terminal (${detail})`);
    }
    if (outcome.kind === "failure") {
      throw new NavigatorUnavailableError("session", outcome.diagnostic);
    }
    if (outcome.kind !== "accepted") {
      throw new NavigatorUnavailableError("session", `Navigator lookup settled ${outcome.kind}`);
    }
    let prepared: PreparedNavigatorAdvice | undefined;
    for (const payload of outcome.payloads ?? []) {
      prepared = mergePreparedAdvice(prepared, preparedAdviceFromUnknown(payload));
    }
    return prepared;
  };
}
