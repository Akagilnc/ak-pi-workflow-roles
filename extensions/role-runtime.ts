import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createRoleRuntimeExtension } from "../src/role-runtime.ts";
import { createPiSoulAuditor } from "../src/soul-auditor.ts";

const judgeSoulPath = fileURLToPath(
  new URL("../souls/judge.md", import.meta.url),
);
const fixerSoulPath = fileURLToPath(
  new URL("../souls/fixer.md", import.meta.url),
);
const coderSoulPath = fileURLToPath(
  new URL("../souls/coder.md", import.meta.url),
);

function transcriptFromContext(ctx: ExtensionContext): string {
  const context = buildSessionContext(
    [...ctx.sessionManager.getEntries()],
    ctx.sessionManager.getLeafId(),
  );
  return serializeConversation(convertToLlm(context.messages));
}

export default createRoleRuntimeExtension({
  loadJudgeSoul: () => readFile(judgeSoulPath, "utf8"),
  loadFixerSoul: () => readFile(fixerSoulPath, "utf8"),
  loadFixPacket: (path) => readFile(path, "utf8"),
  loadCoderSoul: () => readFile(coderSoulPath, "utf8"),
  loadCoderTask: (path) => readFile(path, "utf8"),
  transcriptFromContext,
  auditSoulCompliance: createPiSoulAuditor(),
});
