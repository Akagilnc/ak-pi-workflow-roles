import { NAVIGATOR_OUTPUT_TOOL_NAME, navigatorOutputSchema } from "./package-contracts/navigator-output.ts";

/**
 * 决定工具规格。生命周期装配归注册信封 owner——src/role-runtime.ts（ADR 0018）。
 * Candidates share the route-advice shape the attendance prepare tool owns.
 */
export const NAVIGATOR_TOOL_SPEC = {
  name: NAVIGATOR_OUTPUT_TOOL_NAME,
  label: "游奕使建议",
  description: "游奕使终局回执：排好序的下一步角色路线建议。",
  promptSnippet: "游奕使建议",
  parameters: navigatorOutputSchema,
} as const;

export type NavigatorRuntimeDependencies = {
  loadSoul(): Promise<string>;
};
