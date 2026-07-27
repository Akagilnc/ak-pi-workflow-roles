import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createReviewerAgentRunner } from "../src/reviewer-agent.ts";
import { createPiReviewerAuditor } from "../src/reviewer-auditor.ts";
import { loadCanonicalSkillBinding } from "../src/canonical-skill-binding.ts";
import { createRoleRuntimeExtension } from "../src/role-runtime.ts";
import { createPiSoulAuditor } from "../src/soul-auditor.ts";

const judgeSoulPath = fileURLToPath(new URL("../souls/judge.md", import.meta.url));
const fixerSoulPath = fileURLToPath(new URL("../souls/fixer.md", import.meta.url));
const coderSoulPath = fileURLToPath(new URL("../souls/coder.md", import.meta.url));
const reviewerSoulPath = fileURLToPath(new URL("../souls/reviewer.md", import.meta.url));

function transcriptFromContext(ctx: ExtensionContext): string {
  const context = buildSessionContext(
    [...ctx.sessionManager.getEntries()],
    ctx.sessionManager.getLeafId(),
  );
  return serializeConversation(convertToLlm(context.messages));
}

export default function roleRuntime(pi: ExtensionAPI): void {
  const reviewerAgent = createReviewerAgentRunner();
  createRoleRuntimeExtension({
    loadJudgeSoul: () => readFile(judgeSoulPath, "utf8"),
    loadFixerSoul: () => readFile(fixerSoulPath, "utf8"),
    loadFixPacket: (path) => readFile(path, "utf8"),
    loadCoderSoul: () => readFile(coderSoulPath, "utf8"),
    loadCoderTask: (path) => readFile(path, "utf8"),
    loadReviewerSoul: () => readFile(reviewerSoulPath, "utf8"),
    loadReviewerTask: (path) => readFile(path, "utf8"),
    loadCanonicalSkillBinding,
    runReviewerAgent: reviewerAgent.runReviewerAgent,
    shutdownReviewerAgent: () => reviewerAgent.shutdown(),
    transcriptFromContext,
    auditSoulCompliance: createPiSoulAuditor(),
    auditReviewerCompliance: createPiReviewerAuditor(),
  })(pi);
}
