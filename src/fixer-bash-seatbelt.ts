/** Exact case-sensitive substring literals blocked on Fixer bash (ADR 0008). */
export const FIXER_BASH_FORBIDDEN_LITERALS = [
  "rm -rf",
  "git reset --hard",
  "git clean",
  "git checkout --",
] as const;

export type FixerBashForbiddenLiteral = (typeof FIXER_BASH_FORBIDDEN_LITERALS)[number];

export function matchFixerBashForbiddenLiteral(
  command: string,
): FixerBashForbiddenLiteral | undefined {
  return FIXER_BASH_FORBIDDEN_LITERALS.find((literal) => command.includes(literal));
}

export function fixerBashSeatbeltDenyReason(matched: FixerBashForbiddenLiteral): string {
  return `修内司 bash 拦截：命中禁用字面量 ${matched}`;
}
