/**
 * 游奕使的唯一路线表（#1192）：(衙门角色, 结局 status) → 一句建议。
 * 本表是路线的唯一真源；游奕使不调模型，只按行取出。建议只供调用者参考，
 * 不执行下一站，也不读判词正文猜分支——需判词点名下一步的写「按判词处置」。
 * 没有结局 status 的情况（如宿主故障；通进司的回执也没有 status 字段）与未列出的
 * status（如 coder 的 planned）不设行，走无建议。
 * 闸在同一次公开调用内自动传召的站（闸表真源：gatekeeper-role.ts 的
 * GATE_OFFICER_BY_SUBJECT 与 judge-role.ts 的 JUDGE_GATES）不再建议；
 * 建议写闸线之后的下一站。
 * 每句 20 字以内。
 */
import type { DiaristOutput } from "./diarist-contracts.ts";
import type { MergerOutput } from "./merger-contracts.ts";
import type { PackagedRole } from "./packaged-role-registry.ts";
import type { GatekeeperDirectOutput } from "./package-contracts/gatekeeper-output.ts";
import type { ReviewerIntent } from "./package-contracts/reviewer-output.ts";
import type { CoderOutput } from "./package-contracts/worker-output.ts";
import type { ReviewQueueWord } from "./review-submission.ts";

export const NAVIGATOR_ADVICE_MAX_CHARS = 20;

const DISPOSE_BY_VERDICT = "按判词处置";
const ESCALATE_TO_OWNER = "呈陛下裁决";
const DISPATCH_WORKER = "派将作监开工";
const SETTLED_TO_JUDGE = "可送大理寺审计";
const RESUME_SAME_WORKER = "续修，勿送大理寺";

export type NavigatorRouteRows = Readonly<Record<string, string>>;

/** Rows keyed by a seat's own status words; a lawful status may have no row. */
type Rows<Status extends string> = Readonly<Partial<Record<Status, string>>>;

/**
 * Status keys follow each seat's existing receipt type. The fixer's output type
 * leaves status open (its words are the coder's, per the fixer contract) and the
 * secretariat's receipt has no status type, so those two stay on their words.
 */
type RoleRows = {
  readonly judge: Rows<ReviewQueueWord>;
  readonly countersign: Rows<ReviewQueueWord>;
  readonly notary: Rows<ReviewQueueWord>;
  readonly inspector: Rows<ReviewQueueWord>;
  readonly coder: Rows<CoderOutput["status"]>;
  readonly fixer: Rows<CoderOutput["status"]>;
  readonly diarist: Rows<DiaristOutput["status"]>;
  readonly merger: Rows<MergerOutput["status"]>;
  readonly secretariat: NavigatorRouteRows;
  readonly reviewer: Rows<ReviewerIntent["status"]>;
  readonly gatekeeper: Rows<GatekeeperDirectOutput["status"]>;
};

export type NavigatorRouteTable = Readonly<Partial<Record<PackagedRole, NavigatorRouteRows>>>;

const ROUTE_ROWS = {
  secretariat: { converged: DISPATCH_WORKER, escalate: ESCALATE_TO_OWNER },
  countersign: { converged: DISPATCH_WORKER, continue: DISPOSE_BY_VERDICT, escalate: ESCALATE_TO_OWNER },
  notary: { converged: "按流程进下一站", continue: DISPOSE_BY_VERDICT, escalate: ESCALATE_TO_OWNER },
  inspector: { converged: "按流程进下一站", continue: DISPOSE_BY_VERDICT, escalate: ESCALATE_TO_OWNER },
  coder: {
    completed: "派御史台",
    partially_completed: SETTLED_TO_JUDGE,
    refused: SETTLED_TO_JUDGE,
    unfinished: RESUME_SAME_WORKER,
  },
  fixer: {
    completed: "直回大理寺复审",
    partially_completed: SETTLED_TO_JUDGE,
    refused: SETTLED_TO_JUDGE,
    unfinished: RESUME_SAME_WORKER,
  },
  reviewer: { completed: "派大理寺裁决", refused: "呈调用者处置" },
  judge: {
    converged: "调用者合并、关票",
    continue: DISPOSE_BY_VERDICT,
    escalate: ESCALATE_TO_OWNER,
  },
  gatekeeper: { dispatch: "召所点名的官员", pass: "放行，进下一站" },
  merger: { completed: "调用者收尾、关票", escalate: ESCALATE_TO_OWNER },
  diarist: { completed: "继续后续衙门", escalate: ESCALATE_TO_OWNER },
} as const satisfies RoleRows;

export const NAVIGATOR_ROUTE_TABLE: NavigatorRouteTable = ROUTE_ROWS;

/** 某衙门的全部行；表中无此衙门时为空对象。 */
export function navigatorRowsForRole(role: PackagedRole): NavigatorRouteRows {
  return NAVIGATOR_ROUTE_TABLE[role] ?? {};
}

/** 整表：衙门 → (status → 建议)。 */
export function navigatorFullTable(): NavigatorRouteTable {
  return NAVIGATOR_ROUTE_TABLE;
}
