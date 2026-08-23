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
 * Sole AK_ROLE_ENGINE write seam for public role child env (#391 E2).
 * Delete ambient inheritance first; own-key undefined mask survives process.env re-merge.
 */
export function applyEngineChildEnv(
  childEnv: NodeJS.ProcessEnv,
  engine?: string,
): void {
  delete childEnv[AK_ROLE_ENGINE_ENV];
  if (engine !== undefined && engine.trim() !== "") {
    childEnv[AK_ROLE_ENGINE_ENV] = engine.trim();
  } else {
    childEnv[AK_ROLE_ENGINE_ENV] = undefined;
  }
}

export const ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC =
  "engine detour produced empty stdout" as const;

export const ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC =
  "engine detour already used in this activation" as const;

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
    throw new Error("engine detour argv must be non-empty");
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
 * Diagnostic string for shared settlement / Terminal Error Artifact (#395).
 * Prefer engine stderr 原样; whitespace-only/empty stderr with stdout body must
 * carry the child's last result/error row verbatim (e.g. a 529 API Error row) —
 * never swallow the cause behind an exit code. Fully-empty output → stable fallback.
 */
export function engineDetourFailureDiagnostic(result: {
  stderr: string;
  code: number;
  stdout: string;
}): string {
  if (result.stderr.trim().length > 0) return result.stderr;
  if (result.stdout.trim() === "") return ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC;
  const rows = result.stdout.trimEnd().split("\n");
  const lastRow = rows[rows.length - 1] ?? "";
  return `engine detour exited with code ${result.code}: ${lastRow.trim()}`;
}

/** Non-empty trimmed engine name from process.env, else undefined. */
export function engineNameFromEnv(): string | undefined {
  const raw = process.env[AK_ROLE_ENGINE_ENV];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}
