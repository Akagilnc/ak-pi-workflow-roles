import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";

/**
 * 决定工具规格。生命周期装配归注册信封 owner——src/role-runtime.ts（ADR 0018）。
 * #959: navigator speaks free-form prose; tool is a lifecycle vehicle only.
 */
export const NAVIGATOR_TOOL_SPEC = roleSubmissionDeclaration("navigator");

export type NavigatorRuntimeDependencies = {
  loadSoul(): Promise<string>;
  /** Standing route playbook. Production omits this and reads the package file once. */
  loadRoutePlaybook?(): Promise<string>;
  /** Same read's native failure, for the existing routePlaybookReadFailure outlet. */
  recordRoutePlaybookReadFailure?(message: string | undefined): void;
};
