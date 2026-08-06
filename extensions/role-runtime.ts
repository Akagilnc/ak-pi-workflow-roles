import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { loadDoctorCase } from "../src/doctor-evidence.ts";
import { loadAdmittedJudgeRequest } from "../src/public-cli/invocation.ts";

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
  navigatorSubjectKey,
  navigatorSubjectKeyForInput,
  registerNavigatorModelCommand,
  subjectPath,
  type NavigatorSubjectProvenance,
  type NavigatorTargetRole,
} from "../src/navigator-attendance.ts";
import { loadCanonicalSkillBinding as loadHomeCanonicalSkillBinding } from "../src/canonical-skill-binding.ts";
import { loadPackagedCanonicalSkillBinding } from "../src/package-resources/method-skill-binding.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../src/package-contracts/judge-output.ts";
import {
  createProductionMergerGitState,
  createRoleRuntimeExtension,
  ROLE_FLAG,
} from "../src/role-runtime.ts";
import {
  packagedRoleInputFlag,
  packagedRoleMetadata,
} from "../src/packaged-role-registry.ts";
import { createPiJudgeAuditor } from "../src/judge-auditor.ts";

const extensionPath = fileURLToPath(import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
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

/**
 * Subprocess live help (disk-reread via fresh pi -e). Kept for cold-install proofs.
 * Production Navigator prepare must not call this on the post-role grace path — under
 * concurrent CI load each role's pi --help alone can exceed the accepted 3s grace.
 */
export async function loadNavigatorRoleHelp(
  pi: Pick<ExtensionAPI, "exec">,
  extensionPath: string,
  cwd: string,
  role: NavigatorTargetRole,
): Promise<string> {
  const result = await pi.exec("pi", ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", extensionPath, "--ak-role", role, "--help"], { cwd, timeout: NAVIGATOR_LIVE_HELP_TIMEOUT_MS });
  if (result.killed) {
    throw new Error(`live help unavailable for ${role}: process did not settle`, { cause: result });
  }
  if (result.code !== 0) throw new Error(`live help unavailable for ${role}: process exited with code ${result.code}`, { cause: result });
  return result.stdout || result.stderr;
}

/**
 * In-process role help for Navigator prepare. Same loaded package/module the role
 * is already running — no child pi. Public command surface is ak-role (ADR 0052).
 */
export function formatInProcessNavigatorRoleHelp(role: NavigatorTargetRole): string {
  const metadata = packagedRoleMetadata(role);
  const lines = [
    `Usage: ak-role ${role}`,
    ROLE_FLAG.definition.description,
  ];
  if (metadata?.inputFlag !== undefined) {
    lines.push(`  --${metadata.inputFlag} <value>    ${role} input material`);
  }
  if (metadata?.phaseFlag !== undefined) {
    lines.push(
      `  --${metadata.phaseFlag} <value>    ${role} phase: ${(metadata.phases.filter((p) => p !== null) as string[]).join(" | ")}`,
    );
  }
  lines.push(`Public next-command form: ak-role ${role}`);
  return lines.join("\n");
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
  // Public ak-role run: admitted request is the typed Navigator work-context source.
  // Classification failure here stays source=context (distinct from model/session/transport).
  const publicRunDir = process.env.AK_ROLE_RUN_DIR;
  if (
    options.role === "judge" &&
    typeof publicRunDir === "string" &&
    publicRunDir.trim() !== ""
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
    // Structurally empty public request: placeholder work context, no invented task.
    return {
      subjectKey: subjectRoot,
      subject: `work subject: ${subjectRoot}`,
      authority: "",
      subjectProvenance: "placeholder",
    };
  }
  // True short-circuit: non-whitespace role-input is authority verbatim.
  // Do not probe work-root authority files once input already supplies material.
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
  // Absent or whitespace-only input yields to the existing file fallback.
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
    collectorPackageExtensionPath: extensionPath,
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
        // In-process help: subprocess pi --help is reserved for cold-install proofs.
        // N child pi processes cannot fit the accepted 3s post-role grace under CI load.
        loadRoleHelp: async (role) => formatInProcessNavigatorRoleHelp(role),
        createSession: navigatorSessionFactory,
        contextError: options.contextError,
        onEvent: options.onEvent,
      });
    },
    loadMergerSoul: () => readFile(mergerSoulPath, "utf8"),
    loadMergerInput: async (path) => JSON.parse(await readFile(path, "utf8")),
    createMergerGitState: (repositoryRoot) =>
      createProductionMergerGitState(repositoryRoot),
    async loadCanonicalSkillBinding(name) {
      // Coder TDD is package-owned (#109). Other methods keep legacy loaders until their tickets.
      if (name === "tdd") {
        return loadPackagedCanonicalSkillBinding(packageRoot, "tdd");
      }
      return loadHomeCanonicalSkillBinding(name);
    },
    runReviewerDispatch: (dispatch, options) => reviewerAgent.run(dispatch, options),
    shutdownReviewerAgent: () => reviewerAgent.shutdown(),
    transcriptFromContext,
    auditSoulCompliance: createPiJudgeAuditor(),
    auditFixerCompliance: createPiFixerAuditor(),
    auditReviewerCompliance: createPiReviewerAuditor(),
  })(pi);
}
