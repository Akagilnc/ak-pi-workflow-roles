import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FIXER_BASH_FORBIDDEN_LITERALS,
  fixerBashSeatbeltDenyReason,
} from "../fixer-bash-seatbelt.ts";

/**
 * Render the Grok PreToolUse hook script.
 * Literals and deny reason come from the single ADR 0008 authority; this file is
 * transport-only (stdin event → stdout decision JSON for the Grok hook runner).
 */
export function renderGrokBashSeatbeltHookScript(): string {
  // Reason templates are baked from the authority so the standalone hook process
  // cannot drift from fixerBashSeatbeltDenyReason without editing this render call.
  const reasons = Object.fromEntries(
    FIXER_BASH_FORBIDDEN_LITERALS.map((literal) => [literal, fixerBashSeatbeltDenyReason(literal)]),
  );
  return `#!/usr/bin/env node
const LITERALS = ${JSON.stringify([...FIXER_BASH_FORBIDDEN_LITERALS])};
const REASONS = ${JSON.stringify(reasons)};
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let event = {};
  try { event = JSON.parse(raw); } catch { /* fail-open on malformed host payload */ }
  const input = event && typeof event === "object" ? event.toolInput : undefined;
  const command = input && typeof input === "object" && typeof input.command === "string"
    ? input.command : undefined;
  const matched = typeof command === "string"
    ? LITERALS.find((literal) => command.includes(literal))
    : undefined;
  const decision = matched === undefined
    ? { decision: "allow" }
    : { decision: "deny", reason: REASONS[matched] };
  process.stdout.write(JSON.stringify(decision));
});
`;
}

/**
 * Install the AK bash seatbelt into a controlled Grok home (GROK_HOME root).
 * Never writes the operator's private ~/.grok — callers must pass the isolated home.
 */
export async function installGrokPreToolUseDeny(controlledHome: string): Promise<void> {
  const hooksDir = join(controlledHome, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const scriptName = "ak-bash-seatbelt.mjs";
  const scriptPath = join(hooksDir, scriptName);
  await writeFile(scriptPath, renderGrokBashSeatbeltHookScript(), { mode: 0o755 });
  await writeFile(join(hooksDir, "ak-bash-seatbelt.json"), `${JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|run_terminal_command",
          hooks: [
            {
              type: "command",
              command: process.execPath + " " + JSON.stringify(scriptPath),
              timeout: 5,
            },
          ],
        },
      ],
    },
  }, null, 2)}\n`);
}
