import { NAVIGATOR_OUTPUT_TOOL_NAME, navigatorOutputSchema } from "./package-contracts/navigator-output.ts";

/**
 * 决定工具规格。生命周期装配归注册信封 owner——src/role-runtime.ts（ADR 0018）。
 * #959: navigator speaks free-form prose; tool is a lifecycle vehicle only.
 */
export const NAVIGATOR_TOOL_SPEC = {
  name: NAVIGATOR_OUTPUT_TOOL_NAME,
  label: "游奕使建议",
  description: "游奕使终局回执：散文建议，原样呈现。",
  promptSnippet: "游奕使建议",
  parameters: navigatorOutputSchema,
} as const;

export type NavigatorRuntimeDependencies = {
  loadSoul(): Promise<string>;
  /** Standing route playbook. Production omits this and reads the package file once. */
  loadRoutePlaybook?(): Promise<string>;
  /** Same read's native failure, for the existing routePlaybookReadFailure outlet. */
  recordRoutePlaybookReadFailure?(message: string | undefined): void;
};
