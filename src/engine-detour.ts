/**
 * Engine-generic one-shot subprocess detour (#357 T2 / ADR 0069).
 * Spawn once; no retry, hang surface, or per-engine branch.
 * Material body is LLM data — this module only executes argv the model assembled.
 */
import { spawn } from "node:child_process";

/** Package-owned detour tool name (settlement whitelist + session principal). */
export const ENGINE_DETOUR_TOOL_NAME = "ak_engine_detour" as const;

/** Env presence/name signal injected by public role runs (registration gate only). */
export const AK_ROLE_ENGINE_ENV = "AK_ROLE_ENGINE" as const;

/**
 * Request-scoped engine flag on RoleHost (#818 P1).
 * Envelope projects RoleTurnRequest.engine here so concurrent in-process hosts
 * do not share process.env. Empty string = explicitly no engine (blocks ambient).
 * Pi never sets this flag — resolve falls through to child-process env.
 */
export const ENGINE_FLAG_NAME = "ak-engine" as const;

/** Request-scoped engine model flag on RoleHost (#883). Empty = no model. */
export const ENGINE_MODEL_FLAG_NAME = "ak-engine-model" as const;

/** Non-empty trimmed engine name, else undefined. */
export function normalizeEngineName(engine: string | undefined): string | undefined {
  if (engine === undefined) return undefined;
  const trimmed = engine.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Sole AK_ROLE_ENGINE write seam (#391 E2 / #818).
 * Child-process env only (pi adapter). Delete ambient first. Child-env objects
 * keep an own-key undefined mask so a later process.env re-merge cannot revive
 * ambient; process.env itself only deletes (Node stringifies undefined assignments).
 */
export function applyEngineChildEnv(
  childEnv: NodeJS.ProcessEnv,
  engine?: string,
): void {
  delete childEnv[AK_ROLE_ENGINE_ENV];
  const normalized = normalizeEngineName(engine);
  if (normalized !== undefined) {
    childEnv[AK_ROLE_ENGINE_ENV] = normalized;
  } else if (childEnv !== process.env) {
    childEnv[AK_ROLE_ENGINE_ENV] = undefined;
  }
}

export const ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC =
  "劳务引擎 stdout 为空" as const;

export type EngineDetourResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

export type EngineDetourRunInput = Readonly<{
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

function abortReasonError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.trim() !== "") {
    return new Error(reason);
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Run one engine subprocess. First argv element is the executable (PATH lookup).
 * stdio: ignore stdin, pipe stdout+stderr. No shell, no retry, no hang timer.
 * AbortSignal cancels the child immediately via an explicit listener (reason preserved).
 */
export async function runEngineDetourOnce(
  input: EngineDetourRunInput,
): Promise<EngineDetourResult> {
  if (input.argv.length === 0) {
    throw new Error("劳务引擎 argv 不得为空");
  }
  const command = input.argv[0]!;
  const args = input.argv.slice(1);
  return await new Promise<EngineDetourResult>((resolve, reject) => {
    let settled = false;
    const signal = input.signal;
    // Own abort→kill explicitly so rejection preserves signal.reason (caller cancel).
    // Do not pass `signal` to spawn (Node replaces reason).
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = (result: EngineDetourResult): void => {
      if (settled) return;
      settled = true;
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(result);
    };
    const onAbort = (): void => {
      // Fail synchronously so caller-cancel soft-settle preserves signal.reason.
      fail(signal !== undefined ? abortReasonError(signal) : new Error("aborted"));
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      succeed({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Failure predicate: nonzero exit OR stdout trim-empty (including whitespace-only). */
export function isEngineDetourFailure(result: {
  code: number;
  stdout: string;
}): boolean {
  return result.code !== 0 || result.stdout.trim() === "";
}

/**
 * Seat-visible failure text for the same-session tool result (#1213).
 * Preserve every received stream byte (including whitespace-only) — failure
 * predicates use trim, but content conservation does not. Nonzero exit and
 * empty-stdout reasons also ride this content channel (MCP delivers content,
 * not details). Fully-empty streams → diagnostics only.
 */
export function engineDetourFailureSeatText(result: {
  stderr: string;
  code: number;
  stdout: string;
}): string {
  // Length, not trim: whitespace-only streams still reach the seat.
  const parts: string[] = [];
  if (result.stdout.length > 0) parts.push(result.stdout);
  if (result.stderr.length > 0) parts.push(result.stderr);
  let text = "";
  if (parts.length > 0) {
    text = parts[0]!;
    for (let index = 1; index < parts.length; index += 1) {
      if (!text.endsWith("\n")) text += "\n";
      text += parts[index]!;
    }
  }
  const append = (line: string): void => {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    text += line;
  };
  // Exit code must reach the seat-visible content channel on every nonzero
  // failure — including when stderr is present (details-only is not enough).
  if (result.code !== 0) {
    append(`劳务引擎以 code ${result.code} 退出`);
  }
  // Empty-stdout failure reason (isEngineDetourFailure) is independent of
  // whether stream bytes were preserved above.
  if (result.stdout.trim() === "") {
    append(ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC);
  }
  return text.length > 0 ? text : ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC;
}

/** Non-empty trimmed engine name from process.env, else undefined. */
export function engineNameFromEnv(): string | undefined {
  return normalizeEngineName(
    typeof process.env[AK_ROLE_ENGINE_ENV] === "string"
      ? process.env[AK_ROLE_ENGINE_ENV]
      : undefined,
  );
}

/**
 * One activation-signal resolver (#818 P1 / ADR 0069 one gate).
 * Request-scoped RoleHost flag wins when present (envelope always projects it,
 * including "" for no-engine so ambient env cannot arm). Flag absent → pi
 * child-process env via engineNameFromEnv.
 */
export function resolveEngineName(
  getFlag?: (name: string) => boolean | string | undefined,
): string | undefined {
  if (getFlag !== undefined) {
    const flag = getFlag(ENGINE_FLAG_NAME);
    if (typeof flag === "string") return normalizeEngineName(flag);
  }
  return engineNameFromEnv();
}

/**
 * Request-scoped engine model resolver (#883).
 * Flag wins when present (including "" = no model). No process.env fallback —
 * model is seat-table only, never ambient.
 */
export function resolveEngineModel(
  getFlag?: (name: string) => boolean | string | undefined,
): string | undefined {
  if (getFlag === undefined) return undefined;
  const flag = getFlag(ENGINE_MODEL_FLAG_NAME);
  if (typeof flag !== "string") return undefined;
  return normalizeEngineName(flag);
}
