import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { loadDoctorCase } from "../src/doctor-evidence.ts";

import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

import { createGhCollectorGitHubTransport } from "../src/collector-github.ts";
import { createReviewerAgentRunner } from "../src/reviewer-agent.ts";
import { createReviewerPinnedGitReader } from "../src/reviewer-dispatch.ts";
import { createPiReviewerAuditor } from "../src/reviewer-auditor.ts";
import { createPiFixerAuditor } from "../src/fixer-auditor.ts";
import { createPiDoctorAuditor } from "../src/doctor-auditor.ts";
import {
  createNativeNavigatorSessionFactory,
  createNavigatorAttendance,
  navigatorUnavailableError,
  navigatorSessionDirectory,
  navigatorSubjectKeyForInput,
  registerNavigatorModelCommand,
  subjectPath,
  type NavigatorSubjectProvenance,
  type NavigatorTargetRole,
} from "../src/navigator-attendance.ts";
import { loadCanonicalSkillBinding } from "../src/canonical-skill-binding.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../src/package-contracts/judge-output.ts";
import { validateMergerInput } from "../src/merger-contracts.ts";
import { createProductionMergerGitState, createRoleRuntimeExtension } from "../src/role-runtime.ts";
import { packagedRoleInputFlag } from "../src/packaged-role-registry.ts";
import { createPiJudgeAuditor } from "../src/judge-auditor.ts";

const extensionPath = fileURLToPath(import.meta.url);
const judgeSoulPath = fileURLToPath(new URL("../souls/judge.md", import.meta.url));
const fixerSoulPath = fileURLToPath(new URL("../souls/fixer.md", import.meta.url));
const coderSoulPath = fileURLToPath(new URL("../souls/coder.md", import.meta.url));
const reviewerSoulPath = fileURLToPath(new URL("../souls/reviewer.md", import.meta.url));
const collectorSoulPath = fileURLToPath(new URL("../souls/collector.md", import.meta.url));
const doctorSoulPath = fileURLToPath(new URL("../souls/doctor.md", import.meta.url));
const navigatorSoulPath = fileURLToPath(new URL("../souls/navigator.md", import.meta.url));
const mergerSoulPath = fileURLToPath(new URL("../souls/merger.md", import.meta.url));

function navigatorInputReference(pi: ExtensionAPI, role: string): string | undefined {
  const name = packagedRoleInputFlag(role);
  const value = name === undefined ? undefined : pi.getFlag(name);
  return typeof value === "string" && value !== "" ? resolve(value) : undefined;
}

// Cold `pi -e <extension> --help` must cover installed-package process startup under CI load.
// This bound is process-startup budget only — not settlement-to-visible presentation latency.
export const NAVIGATOR_LIVE_HELP_TIMEOUT_MS = 30_000;

export async function loadNavigatorRoleHelp(
  pi: Pick<ExtensionAPI, "exec">,
  extensionPath: string,
  cwd: string,
  role: NavigatorTargetRole,
): Promise<string> {
  const result = await pi.exec("pi", ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", extensionPath, "--ak-role", role, "--help"], { cwd, timeout: NAVIGATOR_LIVE_HELP_TIMEOUT_MS });
  if (result.killed) {
    throw new Error(`live help unavailable for ${role}: timed out after ${NAVIGATOR_LIVE_HELP_TIMEOUT_MS}ms`);
  }
  if (result.code !== 0) throw new Error(`live help unavailable for ${role}: ${result.stderr || result.stdout}`);
  return result.stdout || result.stderr;
}

/**
 * Authority may come only from a role-owned validated typed contract leaf.
 * Opaque task/packet JSON top-level fields never override the separate authority seam.
 * Merger is the current contract owner via materials.authority.
 */
export function navigatorAuthorityFromRoleInput(role: string, raw: string): string | undefined {
  if (role !== "merger" || raw.trim() === "") return undefined;
  try {
    const input = validateMergerInput(JSON.parse(raw) as unknown);
    const content = Buffer.from(input.materials.authority.bytesBase64, "base64").toString("utf8");
    return content.trim() === "" ? undefined : content;
  } catch {
    return undefined;
  }
}

/**
 * Role-input document bytes win verbatim over work-root file authority when non-empty.
 * Absent or whitespace-only input yields to fileAuthority; neither remains undefined.
 */
export function resolveNavigatorAuthorityMaterial(
  roleInput: string | undefined,
  fileAuthority: string | undefined,
): string | undefined {
  if (roleInput !== undefined && roleInput.trim() !== "") return roleInput;
  if (fileAuthority !== undefined && fileAuthority.trim() !== "") return fileAuthority;
  return undefined;
}

function projectJudgeTranscriptForAudit(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "toolCall" || part.name !== JUDGE_OUTPUT_TOOL_NAME) {
          return part;
        }
        const { evidence: _evidence, ...adjudicativeArguments } = part.arguments;
        return { ...part, arguments: adjudicativeArguments };
      }),
    };
  });
}

export function transcriptFromContext(ctx: ExtensionContext): string {
  const context = buildSessionContext(
    [...ctx.sessionManager.getEntries()],
    ctx.sessionManager.getLeafId(),
  );
  return serializeConversation(
    projectJudgeTranscriptForAudit(convertToLlm(context.messages)),
  );
}

export async function loadNavigatorWorkContext(
  pi: Pick<ExtensionAPI, "getFlag">,
  options: { context: ExtensionContext; role: string },
): Promise<{ subjectKey: string; subject: string; authority: string; subjectProvenance: NavigatorSubjectProvenance }> {
  const reference = navigatorInputReference(pi as ExtensionAPI, options.role);
  const input = reference === undefined || options.role === "doctor" ? undefined : await readFile(reference, "utf8");
  const subjectRoot = subjectPath(reference ?? options.context.sessionManager.getSessionDir(), options.context.cwd);
  const subjectKey = reference === undefined
    ? subjectRoot
    : navigatorSubjectKeyForInput(subjectRoot, reference, options.context.cwd);
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let subject = input ?? `work subject: ${subjectKey}`;
  let subjectProvenance: NavigatorSubjectProvenance = input === undefined ? "placeholder" : "role_input";
  if (options.role === "doctor" && reference !== undefined) {
    const patient = await loadDoctorCase(reference);
    subject = JSON.stringify({ identity: patient.identity, cost: patient.cost });
    subjectProvenance = "role_input";
  }
  // Non-empty role-input document bytes are authority material verbatim and
  // win over work-root files (closest per-dispatch provenance). Absent or
  // whitespace-only input yields to the existing file fallback.
  const authority = resolveNavigatorAuthorityMaterial(input, authorityMaterial);
  if (authority === undefined) {
    throw navigatorUnavailableError("context", new Error("controlling authority content was not supplied as typed work context"));
  }
  return { subjectKey, subject, authority, subjectProvenance };
}

export default function roleRuntime(pi: ExtensionAPI): void {
  const reviewerAgent = createReviewerAgentRunner();
  registerNavigatorModelCommand(pi);
  const navigatorSessionFactory = createNativeNavigatorSessionFactory();
  createRoleRuntimeExtension({
    loadJudgeSoul: () => readFile(judgeSoulPath, "utf8"),
    loadFixerSoul: () => readFile(fixerSoulPath, "utf8"),
    loadFixPacket: (path) => readFile(path, "utf8"),
    loadCoderSoul: () => readFile(coderSoulPath, "utf8"),
    loadCoderTask: (path) => readFile(path, "utf8"),
    loadReviewerSoul: () => readFile(reviewerSoulPath, "utf8"),
    loadReviewerTask: (path) => readFile(path),
    loadReviewerCapabilities: (path) => readFile(path),
    createReviewerPinnedGitReader: () => createReviewerPinnedGitReader(),
    loadCollectorSoul: () => readFile(collectorSoulPath, "utf8"),
    createCollectorTransport: () => createGhCollectorGitHubTransport(),
    loadDoctorSoul: () => readFile(doctorSoulPath, "utf8"),
    loadDoctorCase,
    auditDoctorCompliance: createPiDoctorAuditor(),
    loadNavigatorWorkContext: (options) => loadNavigatorWorkContext(pi, options),
    createNavigatorAttendance: (options) => {
      const sessionDir = navigatorSessionDirectory(options.context, options.subjectKey);
      return createNavigatorAttendance({
        context: options.context,
        role: options.role,
        phase: options.phase,
        subjectKey: options.subjectKey,
        sessionDir,
        sessionDirectory: (subjectKey) => navigatorSessionDirectory(options.context, subjectKey),
        subject: options.subject,
        authority: options.authority,
        loadSoul: () => readFile(navigatorSoulPath, "utf8"),
        loadRoleHelp: (role) => loadNavigatorRoleHelp(pi, extensionPath, options.context.cwd, role),
        createSession: navigatorSessionFactory,
        contextError: options.contextError,
        onEvent: options.onEvent,
      });
    },
    loadMergerSoul: () => readFile(mergerSoulPath, "utf8"),
    loadMergerInput: async (path) => JSON.parse(await readFile(path, "utf8")),
    createMergerGitState: (repositoryRoot) =>
      createProductionMergerGitState(repositoryRoot),
    collectorPackageExtensionPath: extensionPath,
    loadCanonicalSkillBinding,
    runReviewerDispatch: (dispatch, options) => reviewerAgent.run(dispatch, options),
    shutdownReviewerAgent: () => reviewerAgent.shutdown(),
    transcriptFromContext,
    auditSoulCompliance: createPiJudgeAuditor(),
    auditFixerCompliance: createPiFixerAuditor(),
    auditReviewerCompliance: createPiReviewerAuditor(),
  })(pi);
}
