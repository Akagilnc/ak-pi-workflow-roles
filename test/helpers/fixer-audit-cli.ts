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
  timeoutMs?: number;
  prefix?: string;
};

/**
 * Shared Fixer + fixer-audit-failure-provider CLI boot used by activation-envelope
 * and audit-failure-subprocess. One real CLI boot per call; durable session under
 * the hermetic ledger home (no --no-session).
 */
export async function runFixerAuditFailureCli(
  options: FixerAuditFailureCliOptions = {},
) {
  const mode = options.mode ?? "print";
  return withHermeticHome(
    { prefix: options.prefix ?? "ak-fixer-audit-cli-" },
    async ({ home, agentDir }) => {
      // packageRoot is the git cwd; hermetic HOME only owns ledger + session.
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

      const sessionDirectory = resolve(
        home,
        ".ak-roles",
        "books",
        "ak-roles-127",
        "runs",
        `fixer-audit-${mode}`,
        "session",
      );
      await mkdir(sessionDirectory, { recursive: true });

      const args: string[] = [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--session-dir",
        sessionDirectory,
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
      ];

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

      await writeFile(resolve(sessionDirectory, "..", "stderr.log"), result.stderr);
      return result;
    },
  );
}
