import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDoctorCase } from "../src/doctor-evidence.ts";

import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createGhCollectorGitHubTransport } from "../src/collector-github.ts";
import { createReviewerAgentRunner } from "../src/reviewer-agent.ts";
import { createReviewerPinnedGitReader } from "../src/reviewer-dispatch.ts";
import { createPiReviewerAuditor } from "../src/reviewer-auditor.ts";
import { createPiFixerAuditor } from "../src/fixer-auditor.ts";
import { createPiDoctorAuditor } from "../src/doctor-auditor.ts";
import { createPiNavigatorAuditor } from "../src/navigator-auditor.ts";
import type { CurrentPositionSnapshotV1 } from "../src/navigator-contracts.ts";
import { loadCanonicalSkillBinding } from "../src/canonical-skill-binding.ts";
import { createProductionMergerGitState, createRoleRuntimeExtension } from "../src/role-runtime.ts";
import { createPiSoulAuditor } from "../src/soul-auditor.ts";

const extensionPath = fileURLToPath(import.meta.url);
const judgeSoulPath = fileURLToPath(new URL("../souls/judge.md", import.meta.url));
const fixerSoulPath = fileURLToPath(new URL("../souls/fixer.md", import.meta.url));
const coderSoulPath = fileURLToPath(new URL("../souls/coder.md", import.meta.url));
const reviewerSoulPath = fileURLToPath(new URL("../souls/reviewer.md", import.meta.url));
const collectorSoulPath = fileURLToPath(new URL("../souls/collector.md", import.meta.url));
const doctorSoulPath = fileURLToPath(new URL("../souls/doctor.md", import.meta.url));
const navigatorSoulPath = fileURLToPath(new URL("../souls/navigator.md", import.meta.url));
const mergerSoulPath = fileURLToPath(new URL("../souls/merger.md", import.meta.url));

function transcriptFromContext(ctx: ExtensionContext): string {
  const context = buildSessionContext(
    [...ctx.sessionManager.getEntries()],
    ctx.sessionManager.getLeafId(),
  );
  return serializeConversation(convertToLlm(context.messages));
}

export const MAX_NAVIGATOR_EVIDENCE_ITEMS = 256;
export const MAX_NAVIGATOR_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_NAVIGATOR_EVIDENCE_ITEM_BYTES = 8 * 1024 * 1024;

export async function loadNavigatorEvidence(snapshot: CurrentPositionSnapshotV1): Promise<Map<string, Uint8Array>> {
  if (snapshot.evidence.length > MAX_NAVIGATOR_EVIDENCE_ITEMS) {
    throw new Error("Navigator evidence item count exceeds bound");
  }
  const root = await realpath(join(snapshot.subject.repositoryRoot, ".ak", "work", "issues", String(snapshot.subject.parent.number), "assisted", snapshot.runId, "evidence"));
  const loaded = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const item of snapshot.evidence) {
    const path = await realpath(item.handle);
    const rel = relative(root, path);
    if (rel.startsWith("..") || rel === "" || rel.includes("/../")) throw new Error("evidence handle escapes admitted capability");
    const fd = await open(path, constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0));
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > MAX_NAVIGATOR_EVIDENCE_ITEM_BYTES) throw new Error("invalid bounded evidence handle");
      totalBytes += stat.size;
      if (totalBytes > MAX_NAVIGATOR_EVIDENCE_BYTES) throw new Error("Navigator evidence aggregate byte budget exceeded");
      const bytes = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await fd.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw new Error("evidence changed while loading");
        offset += result.bytesRead;
      }
      loaded.set(item.handle, bytes);
    } finally {
      await fd.close();
    }
  }
  return loaded;
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
    loadReviewerTask: (path) => readFile(path),
    loadReviewerCapabilities: (path) => readFile(path),
    createReviewerPinnedGitReader: () => createReviewerPinnedGitReader(),
    loadCollectorSoul: () => readFile(collectorSoulPath, "utf8"),
    createCollectorTransport: () => createGhCollectorGitHubTransport(),
    loadDoctorSoul: () => readFile(doctorSoulPath, "utf8"),
    loadDoctorCase,
    auditDoctorCompliance: createPiDoctorAuditor(),
    loadNavigatorSoul: () => readFile(navigatorSoulPath, "utf8"),
    loadNavigatorSnapshot: async (path) => JSON.parse(await readFile(path, "utf8")),
    loadNavigatorEvidence,
    auditNavigatorCompliance: createPiNavigatorAuditor(),
    loadMergerSoul: () => readFile(mergerSoulPath, "utf8"),
    loadMergerInput: async (path) => JSON.parse(await readFile(path, "utf8")),
    createMergerGitState: (repositoryRoot) =>
      createProductionMergerGitState(repositoryRoot),
    collectorPackageExtensionPath: extensionPath,
    loadCanonicalSkillBinding,
    runReviewerDispatch: (dispatch, options) => reviewerAgent.run(dispatch, options),
    shutdownReviewerAgent: () => reviewerAgent.shutdown(),
    transcriptFromContext,
    auditSoulCompliance: createPiSoulAuditor(),
    auditFixerCompliance: createPiFixerAuditor(),
    auditReviewerCompliance: createPiReviewerAuditor(),
  })(pi);
}
