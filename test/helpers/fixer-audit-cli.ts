import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { packageRoot, runPiSubprocess, withHermeticHome } from "./pi-test-harness.ts";

export type FixerAuditFailureCliOptions = {
  mode?: "print" | "json";
  /**
   * Fix packet file contents. Strings are written as-is (markdown instructions);
   * objects are JSON.stringified. Default: valid apply packet object.
   */
  packet?: unknown;
  /** When set, written as JSON and passed via --ak-fixer-prerequisites. */
  prerequisites?: unknown;
  /** Prefer --no-session over a durable session-dir. */
  noSession?: boolean;
  timeoutMs?: number;
  prefix?: string;
};

/**
 * Shared Fixer + fixer-audit-failure-provider CLI boot used by activation-envelope
 * and audit-failure-subprocess. One harness, still one real CLI boot per call.
 */
export async function runFixerAuditFailureCli(
  options: FixerAuditFailureCliOptions = {},
) {
  const mode = options.mode ?? "print";
  return withHermeticHome(
    { prefix: options.prefix ?? "ak-fixer-audit-cli-" },
    async ({ home, agentDir }) => {
      const packetPath = resolve(
        home,
        typeof options.packet === "string" ? "instructions.md" : "packet.json",
      );
      const packet =
        options.packet ??
        {
          version: 1,
          instructions: "Settle Contract.",
          prerequisites: [],
        };
      await writeFile(
        packetPath,
        typeof packet === "string" ? packet : JSON.stringify(packet),
      );

      const args: string[] = [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
      ];

      const useNoSession = options.noSession === true || options.prerequisites !== undefined;
      if (useNoSession) {
        args.push("--no-session");
      } else {
        const runDirectory = resolve(
          packageRoot,
          `.ak/work/issues/44/runs/audit-failure-subprocess-${mode}`,
        );
        const sessionDirectory = resolve(runDirectory, "session");
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(
          resolve(runDirectory, "invocation.json"),
          JSON.stringify(
            {
              role: "fixer",
              phase: "apply",
              mode,
              provider: "ak-fixer-audit-failure",
              model: "faux-1",
            },
            null,
            2,
          ),
        );
        args.push("--session-dir", sessionDirectory);
      }

      args.push(
        "-e",
        resolve(packageRoot, "extensions/role-runtime.ts"),
        "-e",
        resolve(packageRoot, "test/fixtures/fixer-audit-failure-provider.ts"),
        "--ak-role",
        "fixer",
        "--ak-fixer-phase",
        "apply",
        "--ak-fix-packet",
        packetPath,
      );

      if (options.prerequisites !== undefined) {
        const prerequisitesPath = resolve(home, "prerequisites.json");
        await writeFile(prerequisitesPath, JSON.stringify(options.prerequisites));
        args.push("--ak-fixer-prerequisites", prerequisitesPath);
      }

      args.push(
        "--provider",
        "ak-fixer-audit-failure",
        "--model",
        "faux-1",
        ...(mode === "print" ? ["-p", "Apply."] : ["--mode", "json", "Apply."]),
      );

      const result = await runPiSubprocess(args, {
        cwd: packageRoot,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
        },
      });

      if (!useNoSession) {
        const runDirectory = resolve(
          packageRoot,
          `.ak/work/issues/44/runs/audit-failure-subprocess-${mode}`,
        );
        await writeFile(resolve(runDirectory, "stderr.log"), result.stderr);
      }
      return result;
    },
  );
}
