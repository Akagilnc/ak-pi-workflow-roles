/**
 * 游奕使的唯一路线表（#1192）：(衙门角色, 结局 status) → 一句建议。
 * 本表是路线的唯一真源；游奕使不调模型，只按行取出。建议只供调用者参考，
 * 不执行下一站，也不读判词正文猜分支——需判词点名下一步的写「按判词处置」。
 * 没有结局 status 的情况（如宿主故障）与未列出的 status 不设行，走无建议。
 * 每句 20 字以内。
 */
import type { PackagedRole } from "./packaged-role-registry.ts";

export const NAVIGATOR_ADVICE_MAX_CHARS = 20;

const DISPOSE_BY_VERDICT = "按判词处置";
const ESCALATE_TO_OWNER = "呈陛下裁决";
const SETTLED_TO_JUDGE = "可送大理寺审计";
const RESUME_SAME_WORKER = "续修，勿送大理寺";

export type NavigatorRouteRows = Readonly<Record<string, string>>;

export const NAVIGATOR_ROUTE_TABLE: Readonly<Partial<Record<PackagedRole, NavigatorRouteRows>>> = {
  secretariat: { converged: "送给事中审读", escalate: ESCALATE_TO_OWNER },
  countersign: { converged: "派将作监开工", continue: DISPOSE_BY_VERDICT, escalate: ESCALATE_TO_OWNER },
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
  reviewer: { completed: "派大理寺裁决", refused: DISPOSE_BY_VERDICT },
  judge: {
    converged: "调用者合并、关票",
    continue: DISPOSE_BY_VERDICT,
    escalate: ESCALATE_TO_OWNER,
  },
  gatekeeper: { dispatch: "召所点名的官员", pass: "放行，进下一站" },
  merger: { completed: "调用者收尾、关票", escalate: ESCALATE_TO_OWNER },
  diarist: { completed: "继续后续衙门", escalate: ESCALATE_TO_OWNER },
};

/** 某衙门的全部行；表中无此衙门时为空对象。 */
export function navigatorRowsForRole(role: PackagedRole): NavigatorRouteRows {
  return NAVIGATOR_ROUTE_TABLE[role] ?? {};
}

/** 整表：衙门 → (status → 建议)。 */
export function navigatorFullTable(): Readonly<Record<string, NavigatorRouteRows>> {
  return NAVIGATOR_ROUTE_TABLE as Readonly<Record<string, NavigatorRouteRows>>;
}
