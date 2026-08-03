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
  NAVIGATOR_EVENT_TYPE,
  navigatorSessionDirectory,
  registerNavigatorModelCommand,
  subjectPath,
  type NavigatorTargetRole,
} from "../src/navigator-attendance.ts";
import { loadCanonicalSkillBinding } from "../src/canonical-skill-binding.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../src/package-contracts/judge-output.ts";
import { createProductionMergerGitState, createRoleRuntimeExtension } from "../src/role-runtime.ts";
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
  const names: Record<string, string> = {
    fixer: "ak-fix-packet",
    coder: "ak-coder-task",
    reviewer: "ak-review-task",
    collector: "ak-collector-legs",
    doctor: "ak-doctor-case",
    merger: "ak-merger-input",
  };
  const name = names[role];
  const value = name === undefined ? undefined : pi.getFlag(name);
  return typeof value === "string" && value !== "" ? resolve(value) : undefined;
}

export async function loadNavigatorRoleHelp(
  pi: Pick<ExtensionAPI, "exec">,
  extensionPath: string,
  cwd: string,
  role: NavigatorTargetRole,
): Promise<string> {
  const result = await pi.exec("pi", ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", extensionPath, "--ak-role", role, "--help"], { cwd, timeout: 5000 });
  if (result.code !== 0) throw new Error(`live help unavailable for ${role}: ${result.stderr || result.stdout}`);
  return result.stdout || result.stderr;
}

function navigatorAuthorityFromInput(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.authority === "string" && record.authority.trim() !== "") return record.authority;
      if (typeof record.controllingAuthority === "string" && record.controllingAuthority.trim() !== "") return record.controllingAuthority;
      const materials = record.materials;
      if (typeof materials === "object" && materials !== null && !Array.isArray(materials)) {
        const authority = (materials as Record<string, unknown>).authority;
        if (typeof authority === "object" && authority !== null && !Array.isArray(authority)) {
          const bytesBase64 = (authority as Record<string, unknown>).bytesBase64;
          if (typeof bytesBase64 === "string") {
            const content = Buffer.from(bytesBase64, "base64").toString("utf8");
            if (content.trim() !== "") return content;
          }
        }
      }
    }
  } catch {
    return undefined;
  }
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
  const messages = context.messages.filter((message) => !(message.role === "custom" && (message as { customType?: unknown }).customType === NAVIGATOR_EVENT_TYPE));
  return serializeConversation(
    projectJudgeTranscriptForAudit(convertToLlm(messages)),
  );
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
    loadNavigatorWorkContext: async (options) => {
      const reference = navigatorInputReference(pi, options.role);
      const input = reference === undefined || options.role === "doctor" ? undefined : await readFile(reference, "utf8");
      const subjectKey = subjectPath(reference ?? options.context.sessionManager.getSessionDir(), options.context.cwd);
      const issueRoot = subjectKey.includes("/.ak/work/issues/") ? subjectKey : undefined;
      const issueFiles = issueRoot === undefined ? [] : [
        resolve(issueRoot, "authority.md"),
        resolve(issueRoot, "authority.txt"),
        resolve(issueRoot, "design-v2/owner-direction.md"),
      ];
      let issueMaterial: string | undefined;
      for (const path of issueFiles) {
        try {
          const content = await readFile(path, "utf8");
          if (content.trim() !== "") {
            issueMaterial = content;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      let subject = input ?? issueMaterial ?? `work subject: ${subjectKey}`;
      if (options.role === "doctor" && reference !== undefined) {
        const patient = await loadDoctorCase(reference);
        subject = JSON.stringify({ identity: patient.identity, cost: patient.cost });
      }
      // Assigned task/packet/review bytes are the production work seam.  If the
      // seam carries an explicit authority field use it; otherwise preserve the
      // admitted bytes as the Navigator's bounded controlling context.
      const authority = navigatorAuthorityFromInput(input ?? "") ?? input ?? issueMaterial;
      if (authority === undefined || authority.trim() === "") {
        throw new Error("controlling authority content was not supplied as typed work context");
      }
      return { subjectKey, subject, authority };
    },
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
