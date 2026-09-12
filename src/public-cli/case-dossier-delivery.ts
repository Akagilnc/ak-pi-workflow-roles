/**
 * 系统随案递送本票起居录的中立指针段（ADR 0081 `automatic-case-material`；
 * #709 公共入口通用递送与 #742 给事中受理链路同源；
 * 指针输入沿 ADR 0079 `summons-pointer-input`，不把卷宗正文塞进提示词）。
 * 只读已有案卷：不刷新、不生成、不校验内容、不新增拒收或停工条件。
 * 机器文本仅中立标识材料（ADR 0073），用途说明归角色材料所有。
 *
 * 递送挂载点唯一：`post-admission` 在 beforeDispatch 之后为每个公共入口挂载。
 * 普通入口把本段追加进 continuation；station-child 审核轮次走既有 attachments
 * 冻结 + `buildInstructionTransportPrompt` 附件路径投影（#879：对话 instruction
 * 保持父腿 payload 原文；起居录作独立附件面，不新造 RoleTurnRequest.materials）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTicketProvenanceVolume } from "../ticket-provenance.ts";
import {
  freezeAttachmentsIntoRun,
  type FrozenAttachment,
} from "./invocation.ts";

/** Section heading of the system-delivered dossier pointer (presentation only). */
const CASE_DOSSIER_SECTION_HEADING = "## 本票起居录（系统随案提供）" as const;

/** Stable freeze key under run/attachments/ for station-child 0081 delivery. */
const CASE_DOSSIER_ATTACH_KEY = "case-dossier" as const;

/** Leaf name of the frozen pointer section (content = purpose + paths). */
const CASE_DOSSIER_ATTACH_FILE = "case-dossier-pointer.md" as const;

/** Pointer only — presence/absence is for the role to observe at the path. */
function describeDossierFile(path: string): string {
  return path;
}

/**
 * Pointer section for a bound ticket's existing 起居录, or undefined when the
 * run carries no ticket identity (unbound calls stay legal and get no dossier).
 * A bound ticket whose volume is missing or unreadable is stated as such —
 * the section never claims a dossier that is not there.
 */
export async function projectCaseDossierPointerSection(input: {
  readonly ticketNumber: number | undefined;
  readonly projectRoot: string;
  readonly home: string;
}): Promise<string | undefined> {
  if (input.ticketNumber === undefined) return undefined;
  const volume = resolveTicketProvenanceVolume(
    input.ticketNumber,
    input.projectRoot,
    input.home,
  );
  return [
    CASE_DOSSIER_SECTION_HEADING,
    "",
    `票号：#${input.ticketNumber}`,
    `人读视图：${describeDossierFile(volume.humanViewFile)}`,
    `记录卷宗：${describeDossierFile(volume.recordFile)}`,
  ].join("\n");
}

/**
 * ADR 0081 delivery for station-child officer turns (#879): freeze the same
 * pointer section through the existing attachments seam. Caller projects the
 * returned frozen paths via buildInstructionTransportPrompt (existing attach
 * transport) so the seat sees the readable reference — peer dialogue instruction
 * stays the parent payload; never RoleTurnRequest.materials.
 * Returns frozen attachments, or undefined when unbound (no dossier).
 */
export async function deliverCaseDossierAsAttachment(input: {
  readonly ticketNumber: number | undefined;
  readonly projectRoot: string;
  readonly home: string;
  readonly runDirectory: string;
}): Promise<readonly FrozenAttachment[] | undefined> {
  const section = await projectCaseDossierPointerSection({
    ticketNumber: input.ticketNumber,
    projectRoot: input.projectRoot,
    home: input.home,
  });
  if (section === undefined) return undefined;
  // Stage in OS temp only — never leave a run-local .case-dossier-stage copy.
  const stagingDir = await mkdtemp(join(tmpdir(), "ak-case-dossier-"));
  try {
    const stagingPath = join(stagingDir, CASE_DOSSIER_ATTACH_FILE);
    await writeFile(stagingPath, `${section}\n`, "utf8");
    return await freezeAttachmentsIntoRun(
      [stagingPath],
      input.runDirectory,
      CASE_DOSSIER_ATTACH_KEY,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
