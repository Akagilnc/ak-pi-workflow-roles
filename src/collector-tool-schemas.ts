import { Type, type Static } from "typebox";
import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

/**
 * #1088: LLM gathers evidence via host CLI and submits the receipt.
 * Field declarations guide the model — host must not pure-shape-reject (仓内 CLAUDE.md 开篇 / ADR 0057).
 * Presence of `groups` remains the Collector terminal discriminator for settlement/analyst.
 */
export const collectorOutputBaseSchema = openToolObject(
  Type.Object({
    groups: Type.Unsafe({
      description:
        "按机器身份归组的出席、材料与逐条 findings（LLM 自行从宿主 CLI 取证整理；代码不代收不归并）。",
    }),
    unfinishedReasons: Type.Unknown({
      description: "未完成原因；取证受限时如实报告。",
    }),
  }),
);

/** Runtime does not enrich findings; the model submits the receipt and signals sole-final. */
export const collectorOutputArgsSchema = withTerminatingOutputDeclarations(
  collectorOutputBaseSchema,
);

export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;
