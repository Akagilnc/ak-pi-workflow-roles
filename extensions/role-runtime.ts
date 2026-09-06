import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadDoctorCase } from "../src/doctor-evidence.ts";
import { loadNotarySourceRunLocator } from "../src/notary-source-run.ts";
import { createPiRoleRuntimeExtension } from "../src/pi/adapter.ts";

import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

import { createGhCollectorGitHubTransport, createGhIssueSoftFetcher } from "../src/collector-github.ts";
import { createPerDispatchReviewerAgent } from "../src/reviewer-agent.ts";
import { createReviewerPinnedGitReader } from "../src/reviewer-dispatch.ts";
import { createPiDoctorAuditor } from "../src/doctor-auditor.ts";
import {
  createNativeNavigatorSessionFactory,
  createNavigatorAttendance,
  registerNavigatorModelCommand,
  resolveNavigatorAuthorityMaterial,
  type NavigatorTargetRole,
} from "../src/navigator-attendance.ts";
import { loadNavigatorWorkContext as loadHostNeutralNavigatorWorkContext } from "../src/navigator-work-context.ts";
export { resolveNavigatorAuthorityMaterial };
import { loadCanonicalSkillBinding as loadHomeCanonicalSkillBinding } from "../src/canonical-skill-binding.ts";
import { loadPackagedCanonicalSkillBinding } from "../src/package-resources/method-skill-binding.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../src/package-contracts/judge-output.ts";
import { readOAuthKeepaliveProviders } from "../src/oauth-keepalive.ts";
import {
  createProductionMergerGitState,
  formatNavigatorRoleHelp,
} from "../src/role-runtime.ts";
import { createPiJudgeAuditor } from "../src/judge-auditor.ts";
import { loadGatekeeperSessionMaterials, loadMainRoleSessionMaterials } from "../src/session-opening-materials.ts";
const extensionPath = fileURLToPath(import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const navigatorRoutePlaybookPath = fileURLToPath(new URL("../resources/navigator-route-playbook.md", import.meta.url));

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

export { formatNavigatorRoleHelp as formatInProcessNavigatorRoleHelp };

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
  options: { context: ExtensionContext | import("../src/host-contracts.ts").HostContext; role: string },
) {
  return loadHostNeutralNavigatorWorkContext({
    context: options.context as import("../src/host-contracts.ts").HostContext,
    role: options.role,
    getFlag: (name) => pi.getFlag(name),
  });
}

export default function roleRuntime(pi: ExtensionAPI): void {
  const reviewerAgent = createPerDispatchReviewerAgent({ packageRoot });
  const oauthKeepaliveProviders = readOAuthKeepaliveProviders();
  registerNavigatorModelCommand(pi);
  const navigatorSessionFactory = createNativeNavigatorSessionFactory();
  createPiRoleRuntimeExtension({
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
    // #590: auditors / navigator / reviewer consume HostContext directly (no Pi WeakMap recover).
    auditDoctorCompliance: (options) => createPiDoctorAuditor()(options),
    loadNotarySoul: () => loadMainRoleSessionMaterials("notary"),
    loadCountersignSoul: () => loadMainRoleSessionMaterials("countersign"),
    loadGleanerLeftSoul: () => loadMainRoleSessionMaterials("gleaner-left"),
    loadDiaristSoul: () => loadMainRoleSessionMaterials("diarist"),
    loadInspectorSoul: () => loadMainRoleSessionMaterials("inspector"),
    loadGatekeeperSoul: () => loadGatekeeperSessionMaterials("gatekeeper"),
    loadNavigatorSoul: () => loadMainRoleSessionMaterials("navigator"),
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
        loadRoleHelp: async (role) => formatNavigatorRoleHelp(role),
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
    auditSoulCompliance: (options) => createPiJudgeAuditor()(options),
  }, {
    transcriptFromContext,
    oauthKeepalive: { providers: oauthKeepaliveProviders },
  })(pi);
}
