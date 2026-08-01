import { readFile, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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

const execFileAsync = promisify(execFile);
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
    loadDoctorEvidenceIndex: async (path) => JSON.parse(await readFile(path, "utf8")),
    readDoctorCommittedEvidence: async (targetCommit, path) => { const { stdout } = await execFileAsync("git", ["show", `${targetCommit}:${path}`], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }); return new Uint8Array(stdout); },
    auditDoctorCompliance: createPiDoctorAuditor(),
    loadNavigatorSoul: () => readFile(navigatorSoulPath, "utf8"),
    loadNavigatorSnapshot: async (path) => JSON.parse(await readFile(path, "utf8")),
    loadNavigatorEvidence: async (snapshot: CurrentPositionSnapshotV1) => { const root=await realpath(join(snapshot.subject.repositoryRoot,".ak","work","issues",String(snapshot.subject.parent.number),"assisted",snapshot.runId,"evidence")); return new Map(await Promise.all(snapshot.evidence.map(async item=>{const path=await realpath(item.handle),rel=relative(root,path);if(rel.startsWith("..")||rel===""||rel.includes("/../"))throw new Error("evidence handle escapes admitted capability");const fd=await open(path,constants.O_RDONLY|("O_NOFOLLOW" in constants?constants.O_NOFOLLOW:0));try{const stat=await fd.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw new Error("invalid bounded evidence handle");const bytes=new Uint8Array(stat.size);let offset=0;while(offset<bytes.length){const r=await fd.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)throw new Error("evidence changed while loading");offset+=r.bytesRead}return[item.handle,bytes]as const}finally{await fd.close()}})))},
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
