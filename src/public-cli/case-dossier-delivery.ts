/**
 * 系统随案递送起居录路径的中立指针段（ADR 0081：公共入口直接挂案卷，Soul 只说明用途不负责派送；
 * #709 公共入口通用递送与 #742 给事中受理链路同源；#858 告诉 LLM 路径，不另建取号/lookup）。
 * 指针输入沿 ADR 0079（指针是绑定材料由代码精准递送），不把卷宗正文塞进提示词。
 * 只告诉路径：不刷新、不生成、不校验内容、不新增拒收或停工条件、不从 instruction 抽票号。
 * 机器文本仅中立标识材料（ADR 0073），用途说明归角色材料所有。
 *
 * 递送挂载点唯一：`post-admission` 在 beforeDispatch 之后为每个公共入口挂载。
 * 全部公共入口（ordinary 已绑定／未绑定与 station-child）统一走 attachments 冻结 +
 * role-runtime `loadCaseDossierReadingMaterial` → readingMaterial →
 * systemPrompt.materials fold（#879 / #858：对话 instruction、空请求、resume
 * message 保持调用者原文；起居录作独立附件面，不新造 RoleTurnRequest.materials，
 * 不拼进 user-dialogue continuation）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectTicketRecordsPathShape } from "../sitian-facade.ts";
import { resolveTicketProvenanceVolume } from "../ticket-provenance.ts";
import {
  freezeAttachmentsIntoRun,
  type FrozenAttachment,
} from "./invocation.ts";

/** Bound-ticket section heading (presentation only). */
const CASE_DOSSIER_SECTION_HEADING = "## 本票起居录（系统随案提供）" as const;

/** Unbound path-only heading — no 本票 claim when no typed ticket is on the run. */
const UNBOUND_DOSSIER_PATH_HEADING = "## 起居录路径（系统随案提供）" as const;

/** Stable freeze key under run/attachments/ for station-child 0081 delivery. */
const CASE_DOSSIER_ATTACH_KEY = "case-dossier" as const;

/** Leaf name of the frozen pointer section (content = purpose + paths). */
const CASE_DOSSIER_ATTACH_FILE = "case-dossier-pointer.md" as const;

/**
 * Sole frozen-path authority for the case-dossier pointer (#858).
 * Matches freezeAttachmentsIntoRun index-0 naming: `00-${basename(staging file)}`
 * under attachments/`CASE_DOSSIER_ATTACH_KEY`/. deliver stages CASE_DOSSIER_ATTACH_FILE
 * so the leaf is determined here once — load never readdir-guesses, never joins ad hoc.
 */
export function caseDossierPointerFrozenPath(runDirectory: string): string {
  return join(
    runDirectory,
    "attachments",
    CASE_DOSSIER_ATTACH_KEY,
    `00-${CASE_DOSSIER_ATTACH_FILE}`,
  );
}

/**
 * Neutral 起居录 path pointer for every public entry (ADR 0081 delivery seam).
 * Always tells the canonical path shape so the seat LLM can read the diary
 * itself (陛下 2026-09-15: 只需要告诉llm这个路径). When a typed ticket identity is
 * already on the run, also project the concrete resolved file. Never claims a
 * volume or「本票」exists when unbound; never extracts a ticket from instruction.
 * Under-book shape comes only from sitian writer joins — no local replica.
 */
export async function projectCaseDossierPointerSection(input: {
  readonly ticketNumber: number | undefined;
  readonly projectRoot: string;
  readonly home: string;
}): Promise<string> {
  if (input.ticketNumber === undefined) {
    return [
      UNBOUND_DOSSIER_PATH_HEADING,
      "",
      `记录卷宗：${projectTicketRecordsPathShape()}`,
    ].join("\n");
  }
  const volume = resolveTicketProvenanceVolume(
    input.ticketNumber,
    input.projectRoot,
    input.home,
  );
  return [
    CASE_DOSSIER_SECTION_HEADING,
    "",
    `票号：#${input.ticketNumber}`,
    `记录卷宗：${volume.recordFile}`,
  ].join("\n");
}

/**
 * ADR 0081 delivery for every public entry (#879 / #858): freeze the pointer
 * section through the existing attachments seam. Role-runtime loads that freeze
 * via loadCaseDossierReadingMaterial onto readingMaterial; the envelope then
 * folds it into systemPrompt.materials. Caller / peer dialogue instruction stays
 * opaque; never RoleTurnRequest.materials, never user-dialogue continuation.
 * Always freezes the path pointer (canonical shape, or concrete file when a
 * typed ticket is already bound).
 */
export async function deliverCaseDossierAsAttachment(input: {
  readonly ticketNumber: number | undefined;
  readonly projectRoot: string;
  readonly home: string;
  readonly runDirectory: string;
}): Promise<readonly FrozenAttachment[]> {
  const section = await projectCaseDossierPointerSection({
    ticketNumber: input.ticketNumber,
    projectRoot: input.projectRoot,
    home: input.home,
  });
  // Stage in OS temp only — never leave a run-local .case-dossier-stage copy.
  const stagingDir = await mkdtemp(join(tmpdir(), "ak-case-dossier-"));
  try {
    const stagingPath = join(stagingDir, CASE_DOSSIER_ATTACH_FILE);
    await writeFile(stagingPath, `${section}\n`, "utf8");
    const frozen = await freezeAttachmentsIntoRun(
      [stagingPath],
      input.runDirectory,
      CASE_DOSSIER_ATTACH_KEY,
    );
    // Typed freeze path must equal the sole load authority — one path fact (#858).
    const expected = caseDossierPointerFrozenPath(input.runDirectory);
    const actual = frozen[0]?.frozenPath;
    if (actual !== expected) {
      throw new Error(
        `case-dossier freeze path drift: expected ${expected}, got ${String(actual)}`,
      );
    }
    return frozen;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/** Typed reading-material face for a frozen station-child 0081 attachment. */
export type CaseDossierReadingMaterial = {
  readonly kind: "case-dossier-pointer";
  readonly frozenPath: string;
  readonly section: string;
};

/**
 * Load a previously frozen case-dossier attachment as reading material
 * (existing agent-start / systemPrompt.materials fold — not dialogue prompt,
 * not RoleTurnRequest.materials). Undefined when the run has no such freeze.
 * Path = caseDossierPointerFrozenPath only (#858 single authority).
 */
export async function loadCaseDossierReadingMaterial(
  runDirectory: string,
): Promise<CaseDossierReadingMaterial | undefined> {
  const frozenPath = caseDossierPointerFrozenPath(runDirectory);
  let section: string;
  try {
    section = await readFile(frozenPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (section.trim() === "") return undefined;
  return { kind: "case-dossier-pointer", frozenPath, section };
}
