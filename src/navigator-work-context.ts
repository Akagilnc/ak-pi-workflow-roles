/**
 * Host-neutral Navigator work-context loader (#590).
 * Flag/input resolution is supplied by the host; no ExtensionAPI dependency.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadDoctorCase } from "./doctor-evidence.ts";
import type { HostContext } from "./host-contracts.ts";
import {
  navigatorSubjectKey,
  navigatorSubjectKeyForInput,
  navigatorUnavailableError,
  resolveNavigatorAuthorityMaterial,
  subjectPath,
  type NavigatorSubjectProvenance,
  type NavigatorWorkContext,
} from "./navigator-attendance.ts";
import { loadNotarySourceRunLocator } from "./notary-source-run.ts";
import { packagedRoleInputFlag } from "./packaged-role-registry.ts";
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
 */
export async function loadNavigatorWorkContext(
  options: NavigatorWorkContextLoaderOptions,
): Promise<NavigatorWorkContext> {
  const reference = navigatorInputReference(options.getFlag, options.role);
  const input = reference === undefined || options.role === "doctor" || options.role === "notary"
    ? undefined
    : await readFile(reference, "utf8");
  const subjectRoot = subjectPath(reference ?? options.context.sessionManager.getSessionDir(), options.context.cwd);
  let subjectKey = reference === undefined
    ? subjectRoot
    : navigatorSubjectKeyForInput(subjectRoot, reference, options.context.cwd);
  let subject = input ?? `work subject: ${subjectKey}`;
  let subjectProvenance: NavigatorSubjectProvenance = input === undefined ? "placeholder" : "role_input";
  if (options.role === "doctor" && reference !== undefined) {
    const patient = await loadDoctorCase(reference);
    subject = JSON.stringify({ identity: patient.identity, cost: patient.cost });
    subjectProvenance = "role_input";
  }
  if (options.role === "notary" && reference !== undefined) {
    const locator = await loadNotarySourceRunLocator(reference);
    subject = JSON.stringify({ sourceRun: locator });
    subjectProvenance = "role_input";
  }
  // Public ak-role run: admitted request is the typed Navigator work-context source.
  const publicRunDir = process.env.AK_ROLE_RUN_DIR;
  const currentSessionDir = options.context.sessionManager.getSessionDir();
  const isBoundPublicRun = typeof publicRunDir === "string"
    && publicRunDir.trim() !== ""
    && resolve(currentSessionDir) === resolve(publicRunDir, "session");
  if (
    options.role === "judge" &&
    isBoundPublicRun
  ) {
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
      const prose = admitted.instruction;
      subjectProvenance = "role_input";
      subject = prose;
      subjectKey = navigatorSubjectKey(subjectRoot, prose, subjectProvenance);
      return { subjectKey, subject, authority: prose, subjectProvenance };
    }
    return {
      subjectKey: subjectRoot,
      subject: `work subject: ${subjectRoot}`,
      authority: "",
      subjectProvenance: "placeholder",
    };
  }
  if (input !== undefined && input.trim() !== "") {
    return { subjectKey, subject, authority: input, subjectProvenance };
  }
  const workRoot = subjectRoot.includes("/.ak/work/") ? subjectRoot : undefined;
  const authorityFiles = workRoot === undefined ? [] : [
    resolve(workRoot, "authority.md"),
    resolve(workRoot, "authority.txt"),
    resolve(workRoot, "design-v2/owner-direction.md"),
  ];
  let authorityMaterial: string | undefined;
  for (const path of authorityFiles) {
    try {
      const content = await readFile(path, "utf8");
      if (content.trim() !== "") {
        authorityMaterial = content;
        break;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
  }
  const authority = resolveNavigatorAuthorityMaterial(input, authorityMaterial);
  if (authority === undefined) {
    return {
      subjectKey: subjectRoot,
      subject: `work subject: ${subjectRoot}`,
      authority: "",
      subjectProvenance: "placeholder",
    };
  }
  return { subjectKey, subject, authority, subjectProvenance };
}
