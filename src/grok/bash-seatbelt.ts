import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** ADR 0008 Fixer bash seatbelt literals — exact case-sensitive substrings. */
export const GROK_BASH_SEATBELT_LITERALS = [
  "rm -rf",
  "git reset --hard",
  "git clean",
  "git checkout --",
] as const;

export type GrokBashSeatbeltLiteral = (typeof GROK_BASH_SEATBELT_LITERALS)[number];

export function matchGrokBashSeatbeltLiteral(
  command: string,
): GrokBashSeatbeltLiteral | undefined {
  return GROK_BASH_SEATBELT_LITERALS.find((literal) => command.includes(literal));
}

export type GrokPreToolUseDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string };

/** Structured PreToolUse decision for one host-side tool invocation. */
export function decideGrokPreToolUse(event: {
  readonly toolName?: unknown;
  readonly toolInput?: unknown;
}): GrokPreToolUseDecision {
  const input = event.toolInput;
  const command = typeof input === "object" && input !== null && "command" in input
    && typeof (input as { command?: unknown }).command === "string"
    ? (input as { command: string }).command
    : undefined;
  if (command === undefined) return { decision: "allow" };
  const matched = matchGrokBashSeatbeltLiteral(command);
  if (matched === undefined) return { decision: "allow" };
  return {
    decision: "deny",
    reason: `修内司 bash 拦截：命中禁用字面量 ${matched}`,
  };
}

/** Render the hook script body; literals stay single-sourced above. */
export function renderGrokBashSeatbeltHookScript(): string {
  return `#!/usr/bin/env node
const LITERALS = ${JSON.stringify([...GROK_BASH_SEATBELT_LITERALS])};
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
    : { decision: "deny", reason: "修内司 bash 拦截：命中禁用字面量 " + matched };
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
