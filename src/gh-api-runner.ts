import { spawn } from "node:child_process";

export type GhApiRunOptions = {
  signal?: AbortSignal;
};

export type GhApiResponse = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
};

export type GhApiRunner = (
  args: readonly string[],
  options?: GhApiRunOptions,
) => Promise<GhApiResponse>;

export function createGhApiRunner(
  options: {
    spawnImpl?: typeof spawn;
    env?: NodeJS.ProcessEnv;
  } = {},
): GhApiRunner {
  const spawnImpl = options.spawnImpl ?? spawn;
  return async (args, runOptions = {}) => {
    return await new Promise<GhApiResponse>((resolve, reject) => {
      const signal = runOptions.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const child = spawnImpl("gh", args, {
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
        fn();
      };
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch (error) {
          settle(() => reject(error));
          return;
        }
        settle(() => {
          reject(signal?.reason ?? new Error("aborted"));
        });
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        settle(() => reject(error));
      });
      child.on("close", (code, signal) => {
        settle(() => {
          // gh api --include prints: HTTP/ headers blank-line body
          const match = stdout.match(/^HTTP\/[\d.]+\s+(\d+)[^\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
          if (match) {
            const status = Number(match[1]);
            const headerText = match[2] ?? "";
            const bodyText = match[3] ?? "";
            const headers: Record<string, string> = {};
            for (const line of headerText.split(/\r?\n/)) {
              const idx = line.indexOf(":");
              if (idx === -1) continue;
              const name = line.slice(0, idx).trim().toLowerCase();
              const value = line.slice(idx + 1).trim();
              headers[name] = value;
            }
            resolve({ status, headers, bodyText });
            return;
          }
          if (code === 0) {
            resolve({ status: 200, headers: {}, bodyText: stdout });
            return;
          }
          const failure = new Error(
            `gh api failed without a parseable HTTP response (code=${String(code)}): ${stderr || stdout}`,
            { cause: { code, signal, stderr, stdout } },
          );
          reject(failure);
        });
      });
    });
  };
}
