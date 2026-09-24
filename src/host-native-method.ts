import { basename, dirname } from "node:path";

import type { MethodBinding } from "./host-contracts.ts";

/** Claude Code's native skill command; the skill itself is discovered from machine skill directories. */
export function applyClaudeSkillInvocation(
  methods: readonly MethodBinding[],
  prompt: string,
): string {
  if (methods.length !== 1) return prompt;
  const name = basename(dirname(methods[0]!.path));
  if (!name) return prompt;
  const token = `/${name}`;
  const trimmed = prompt.trimStart();
  if (trimmed === token || trimmed.startsWith(`${token} `) || trimmed.startsWith(`${token}\n`)) return prompt;
  return prompt.length === 0 ? token : `${token} ${prompt}`;
}
