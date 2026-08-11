import { spawn } from "node:child_process";
import { dirname } from "node:path";

export type PublicCliSubprocessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Shared graceful lifecycle for installed public-CLI subprocess tests. */
export async function runPublicCliSubprocess(
  bin: string,
  args: readonly string[],
  options: {
    home: string;
    agentDir: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<PublicCliSubprocessResult> {
  return await new Promise((resolve, reject) => {
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      HOME: options.home,
      PI_CODING_AGENT_DIR: options.agentDir,
    };
    const child = spawn(bin, [...args], {
      cwd: options.cwd ?? options.home,
      env: {
        ...mergedEnv,
        PATH: `${dirname(bin)}:${mergedEnv.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.kill("SIGTERM")) {
        reject(new Error(`failed to terminate timed-out subprocess: ${bin}`));
      }
    }, options.timeoutMs ?? 45_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
