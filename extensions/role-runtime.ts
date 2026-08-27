import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { loadDoctorCase } from "../src/doctor-evidence.ts";
import { loadNotarySourceRunLocator } from "../src/notary-source-run.ts";
import { createPiRoleHostAdapter } from "../src/pi/adapter.ts";
import { loadAdmittedJudgeRequest } from "../src/public-cli/invocation.ts";

import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HostContext } from "../src/host-contracts.ts";
import type { Message } from "@earendil-works/pi-ai";

import { createGhCollectorGitHubTransport, createGhIssueSoftFetcher } from "../src/collector-github.ts";
import { createReviewerAgentRunner } from "../src/reviewer-agent.ts";
import { createReviewerPinnedGitReader } from "../src/reviewer-dispatch.ts";
import { createPiDoctorAuditor } from "../src/doctor-auditor.ts";
import {
  createNativeNavigatorSessionFactory,
  createNavigatorAttendance,
  navigatorUnavailableError,
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
import { readOAuthKeepaliveProviders } from "../src/oauth-keepalive.ts";
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
import { loadMainRoleSessionMaterials } from "../src/session-opening-materials.ts";
const extensionPath = fileURLToPath(import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const navigatorRoutePlaybookPath = fileURLToPath(new URL("../resources/navigator-route-playbook.md", import.meta.url));

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
  options: { context: HostContext; role: string },
): Promise<{ subjectKey: string; subject: string; authority: string; subjectProvenance: NavigatorSubjectProvenance }> {
  const reference = navigatorInputReference(pi as ExtensionAPI, options.role);
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
  // Classification failure here stays source=context (distinct from model/session/transport).
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
    // Bare developer seams (judge -p, etc.) supply the prompt only at
    // before_agent_start. session_start absence is a soft placeholder, not a
    // permanent context poison — prepare still fails honestly if nothing arrives.
    return {
      subjectKey: subjectRoot,
      subject: `work subject: ${subjectRoot}`,
      authority: "",
      subjectProvenance: "placeholder",
    };
  }
  return { subjectKey, subject, authority, subjectProvenance };
}

export default function roleRuntime(pi: ExtensionAPI): void {
  const reviewerAgent = createReviewerAgentRunner({ packageRoot });
  const piHostAdapter = createPiRoleHostAdapter(pi, { transcriptFromContext });
  registerNavigatorModelCommand(pi);
  const navigatorSessionFactory = createNativeNavigatorSessionFactory();
  // #351: static provider list from extension setting (default ["kimi-coding"]).
  // Production root is the sole reader; keepalive never auto-detects providers.
  const oauthKeepaliveProviders = readOAuthKeepaliveProviders();
  createRoleRuntimeExtension({
    oauthKeepalive: { providers: oauthKeepaliveProviders },
    loadJudgeSoul: () => loadMainRoleSessionMaterials("judge"),
    loadFixerSoul: () => loadMainRoleSessionMaterials("fixer"),
    loadFixPacket: (path) => readFile(path, "utf8"),
    loadCoderSoul: () => loadMainRoleSessionMaterials("coder"),
    loadCoderTask: (path) => readFile(path, "utf8"),
    loadReviewerSoul: () => loadMainRoleSessionMaterials("reviewer"),
    createReviewerPinnedGitReader: () => createReviewerPinnedGitReader(),
    createReviewerIssueFetcher: () => createGhIssueSoftFetcher(),
    loadCollectorSoul: () => loadMainRoleSessionMaterials("collector"),
    createCollectorTransport: () => createGhCollectorGitHubTransport(),
    collectorPackageExtensionPath: extensionPath,
    loadDoctorSoul: () => loadMainRoleSessionMaterials("doctor"),
    loadDoctorCase,
    auditDoctorCompliance: (options) => createPiDoctorAuditor()(options),
    loadNotarySoul: () => loadMainRoleSessionMaterials("notary"),
    loadNotarySourceRun: loadNotarySourceRunLocator,
    loadNavigatorWorkContext: (options) => loadNavigatorWorkContext(pi, options),
    createNavigatorAttendance: (options) => {
      return createNavigatorAttendance({
        context: options.context,
        role: options.role,
        phase: options.phase,
        subjectKey: options.subjectKey,
        subject: options.subject,
        authority: options.authority,
        invocationId: options.invocationId,
        loadSoul: () => loadMainRoleSessionMaterials("navigator"),
        loadRoutePlaybook: () => readFile(navigatorRoutePlaybookPath, "utf8"),
        // In-process help: subprocess pi --help is reserved for cold-install proofs.
        // N child pi processes cannot fit the accepted 3s post-role grace under CI load.
        loadRoleHelp: async (role) => formatInProcessNavigatorRoleHelp(role),
        createSession: navigatorSessionFactory,
        contextError: options.contextError,
        onEvent: options.onEvent,
      });
    },
    loadMergerSoul: () => loadMainRoleSessionMaterials("merger"),
    loadMergerInput: async (path) => JSON.parse(await readFile(path, "utf8")),
    createMergerGitState: (repositoryRoot) =>
      createProductionMergerGitState(repositoryRoot),
    async loadCanonicalSkillBinding(name) {
      // Coder TDD (#109) and Reviewer code-review (#111) are package-owned.
      // Optional Fixer diagnosing-bugs is available via --skill without this binding.
      if (name === "tdd") {
        return loadPackagedCanonicalSkillBinding(packageRoot, "tdd");
      }
      if (name === "code-review") {
        return loadPackagedCanonicalSkillBinding(packageRoot, "code-review");
      }
      return loadHomeCanonicalSkillBinding(name);
    },
    runReviewerDispatch: (dispatch, options) => reviewerAgent.run(dispatch, options),
    shutdownReviewerAgent: () => reviewerAgent.shutdown(),
    transcriptFromContext: (context) => context.transcript?.() ?? "",
    auditSoulCompliance: (options) => createPiJudgeAuditor()(options),
  }, piHostAdapter)(pi);
}
