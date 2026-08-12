import { spawn } from "node:child_process";

/**
 * Unique owner for test-harness subprocess termination classification (#271).
 * Domain: successful start → process termination only. Spawn/collection failures
 * remain {@link TestSubprocessOperationalError} rejections.
 */
export type TestSubprocessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True only when this harness's deadline callback fired and initiated kill. */
  localTimeout: boolean;
  /** Helper owner label when localTimeout; otherwise null. */
  localTimeoutOwner: string | null;
  /** Configured deadline ms when localTimeout; otherwise null. */
  localTimeoutMs: number | null;
  /** Alias of localTimeout for existing call sites. */
  timedOut: boolean;
};

export class TestSubprocessOperationalError extends Error {
  readonly code: number | string | null;
  readonly signal: NodeJS.Signals | null;
  readonly localTimeout: boolean;
  readonly localTimeoutOwner: string | null;
  readonly localTimeoutMs: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    message: string;
    code?: number | string | null;
    signal?: NodeJS.Signals | null;
    localTimeout?: boolean;
    localTimeoutOwner?: string | null;
    localTimeoutMs?: number | null;
    stdout?: string;
    stderr?: string;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "TestSubprocessOperationalError";
    this.code = input.code ?? null;
    this.signal = input.signal ?? null;
    this.localTimeout = input.localTimeout === true;
    this.localTimeoutOwner = input.localTimeoutOwner ?? null;
    this.localTimeoutMs = input.localTimeoutMs ?? null;
    this.stdout = input.stdout ?? "";
    this.stderr = input.stderr ?? "";
  }
}

function settleResult(input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  localTimeout: boolean;
  owner: string;
  timeoutMs: number | undefined;
}): TestSubprocessResult {
  const localTimeout = input.localTimeout;
  return {
    code: input.code,
    signal: input.signal,
    stdout: input.stdout,
    stderr: input.stderr,
    localTimeout,
    localTimeoutOwner: localTimeout ? input.owner : null,
    localTimeoutMs: localTimeout ? (input.timeoutMs ?? null) : null,
    timedOut: localTimeout,
  };
}

export type RunTestSubprocessOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  owner: string;
};

export async function runTestSubprocess(
  command: string,
  args: readonly string[],
  options: RunTestSubprocessOptions,
): Promise<TestSubprocessResult> {
  return await new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new TestSubprocessOperationalError({
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        }),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let localTimeout = false;
    let settled = false;

    const settleOnce = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };

    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });

    let timeout: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        localTimeout = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }

    child.once("error", (error) => {
      if (timeout !== undefined) clearTimeout(timeout);
      settleOnce(() => {
        const errno = error as NodeJS.ErrnoException;
        reject(
          new TestSubprocessOperationalError({
            message: error.message,
            code: errno.code ?? null,
            localTimeout,
            localTimeoutOwner: localTimeout ? options.owner : null,
            localTimeoutMs: localTimeout ? (options.timeoutMs ?? null) : null,
            stdout,
            stderr,
            cause: error,
          }),
        );
      });
    });

    child.once("close", (code, signal) => {
      if (timeout !== undefined) clearTimeout(timeout);
      settleOnce(() => {
        resolveResult(
          settleResult({
            code,
            signal,
            stdout,
            stderr,
            localTimeout,
            owner: options.owner,
            timeoutMs: options.timeoutMs,
          }),
        );
      });
    });
  });
}
