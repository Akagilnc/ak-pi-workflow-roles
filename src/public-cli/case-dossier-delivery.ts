/**
 * 系统随案递送本票起居录的中立指针段（ADR 0081 `automatic-case-material`；
 * #709 公共入口通用递送与 #742 给事中受理链路同源；
 * 指针输入沿 ADR 0079 `summons-pointer-input`，不把卷宗正文塞进提示词）。
 * 只读已有案卷：不刷新、不生成、不校验内容、不新增拒收或停工条件。
 * 机器文本仅中立标识材料（ADR 0073），用途说明归角色材料所有。
 *
 * 递送挂载点唯一：`post-admission` 在 beforeDispatch 之后为每个公共入口追加本段。
 */
import { resolveTicketProvenanceVolume } from "../ticket-provenance.ts";

/** Section heading of the system-delivered dossier pointer (presentation only). */
const CASE_DOSSIER_SECTION_HEADING = "## 本票起居录（系统随案提供）" as const;

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
