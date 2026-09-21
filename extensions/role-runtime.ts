import { fileURLToPath } from "node:url";

import { createPiRoleRuntimeExtension } from "../src/pi/adapter.ts";

import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

import {
  registerNavigatorModelCommand,
  resolveNavigatorAuthorityMaterial,
  type NavigatorTargetRole,
} from "../src/navigator-attendance.ts";
import { loadNavigatorWorkContext as loadHostNeutralNavigatorWorkContext } from "../src/navigator-work-context.ts";
export { resolveNavigatorAuthorityMaterial };
import { JUDGE_OUTPUT_TOOL_NAME } from "../src/package-contracts/judge-output.ts";
import { readOAuthKeepaliveProviders } from "../src/oauth-keepalive.ts";
import {
  formatNavigatorRoleHelp,
  type RoleRuntimeDependencies,
} from "../src/role-runtime.ts";
import { createRoleRuntimeDependencies } from "../src/role-runtime-dependencies.ts";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// #675: nested public summons (gate/auditor) resolve root via env under jiti.
if (process.env.AK_ROLE_PACKAGE_ROOT === undefined || process.env.AK_ROLE_PACKAGE_ROOT.trim() === "") {
  process.env.AK_ROLE_PACKAGE_ROOT = packageRoot;
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

/** Pi extension deps are the shared packaged factory. Host flags stay on the envelope. */
export function createPiRoleRuntimeDependencies(
  _pi: ExtensionAPI,
): RoleRuntimeDependencies {
  return createRoleRuntimeDependencies(packageRoot);
}

export default function roleRuntime(pi: ExtensionAPI): void {
  const oauthKeepaliveProviders = readOAuthKeepaliveProviders();
  registerNavigatorModelCommand(pi);
  createPiRoleRuntimeExtension(createPiRoleRuntimeDependencies(pi), {
    transcriptFromContext,
    oauthKeepalive: { providers: oauthKeepaliveProviders },
  })(pi);
}
