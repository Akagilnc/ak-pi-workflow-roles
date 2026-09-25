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
} from "../src/navigator-attendance.ts";
import { loadNavigatorWorkContext as loadHostNeutralNavigatorWorkContext } from "../src/navigator-work-context.ts";
export { resolveNavigatorAuthorityMaterial };
import { JUDGE_OUTPUT_TOOL_NAME } from "../src/package-contracts/judge-output.ts";
import { readOAuthKeepaliveProviders } from "../src/oauth-keepalive.ts";
import {
  type RoleRuntimeDependencies,
} from "../src/role-runtime.ts";
import { createRoleRuntimeDependencies } from "../src/role-runtime-dependencies.ts";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// #675: nested public summons (gate/auditor) resolve root via env under jiti.
if (process.env.AK_ROLE_PACKAGE_ROOT === undefined || process.env.AK_ROLE_PACKAGE_ROOT.trim() === "") {
  process.env.AK_ROLE_PACKAGE_ROOT = packageRoot;
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
