/**
 * Host-neutral Navigator work-context loader (#590 / #1187).
 * Auto prepare is identity-only: subjectKey + provenance. No parent dispatch,
 * role-input bytes, or work-root authority files are loaded as materials.
 * Flag/input resolution is supplied by the host; no ExtensionAPI dependency.
 */
import { resolve } from "node:path";

import { sessionDirectoryOf } from "./role-run-placement.ts";

import { runDirectoryFromHostContext, type HostContext } from "./host-contracts.ts";
import {
  navigatorSubjectKeyForInput,
  navigatorUnavailableError,
  subjectPath,
  type NavigatorSubjectProvenance,
  type NavigatorWorkContext,
} from "./navigator-attendance.ts";
import { packagedNavigatorSubject, packagedRoleInputFlag } from "./packaged-role-registry.ts";
import { loadAdmittedJudgeRequest } from "./public-cli/invocation.ts";

export type NavigatorWorkContextLoaderOptions = {
  context: HostContext;
  role: string;
  /** Host flag reader for role input paths (Pi getFlag / grok activation flags). */
  getFlag?: (name: string) => unknown;
};

function navigatorInputReference(
  getFlag: ((name: string) => unknown) | undefined,
  role: string,
): string | undefined {
  if (getFlag === undefined) return undefined;
  const name = packagedRoleInputFlag(role);
  const value = name === undefined ? undefined : getFlag(name);
  return typeof value === "string" && value !== "" ? resolve(value) : undefined;
}

/**
 * Resolve typed Navigator work context from host flags and/or the public admitted request.
 * Returns identity (subjectKey + provenance) only — auto prepare does not consume materials.
 */
export async function loadNavigatorWorkContext(
  options: NavigatorWorkContextLoaderOptions,
): Promise<NavigatorWorkContext> {
  const reference = navigatorInputReference(options.getFlag, options.role);
  const subjectMode = packagedNavigatorSubject(options.role);
  const subjectRoot = subjectPath(reference ?? options.context.sessionManager.getSessionDir(), options.context.cwd);
  const subjectKey = reference === undefined
    ? subjectRoot
    : navigatorSubjectKeyForInput(subjectRoot, reference, options.context.cwd);

  // Public ak-role run: admitted request decides empty vs concrete identity.
  const publicRunDir = runDirectoryFromHostContext(options.context);
  const currentSessionDir = options.context.sessionManager.getSessionDir();
  const isBoundPublicRun = publicRunDir !== undefined
    && resolve(currentSessionDir) === resolve(sessionDirectoryOf(publicRunDir));
  if (subjectMode === "public-instruction" && isBoundPublicRun) {
    // Control-plane read faults keep their real cause inside context-error (#1187 F2).
    // Only true absence / wrong-shape is undefined → generic missing message.
    let admitted;
    try {
      admitted = await loadAdmittedJudgeRequest(publicRunDir);
    } catch (error) {
      throw navigatorUnavailableError("context", error);
    }
    if (admitted === undefined) {
      throw navigatorUnavailableError(
        "context",
        new Error("public Judge admitted request was missing or malformed"),
      );
    }
    if (!admitted.instructionEmpty && admitted.instruction.trim() !== "") {
      // #1187: non-empty public admission starts parallel prepare by identity.
      // Parent instruction remains the parent role's own dispatch; auto navigator
      // does not receive that prose (or a duplicate authority copy) as material.
      return {
        subjectKey: subjectRoot,
        subjectProvenance: "role_input",
      };
    }
    return {
      subjectKey: subjectRoot,
      subjectProvenance: "placeholder",
    };
  }

  // Concrete role-input path (file/case/source-run flag) is identity enough to start prepare.
  // Navigator reads ticket and station records itself when needed — no material copy here.
  if (reference !== undefined) {
    return { subjectKey, subjectProvenance: "role_input" satisfies NavigatorSubjectProvenance };
  }
  return {
    subjectKey: subjectRoot,
    subjectProvenance: "placeholder",
  };
}
