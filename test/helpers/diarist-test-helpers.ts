/**
 * Test helper for scripted diarist collector.
 * (Moved out of production src per ADR 0075 / #582 verdict).
 */
import type {
  DiaristLlmCollector,
  DiaristLlmCollectResult,
} from "../../src/diarist-llm-collector.ts";
import type { DiaristSourceBlock } from "../../src/diarist-mechanical.ts";

export function createScriptedDiaristCollector(
  script:
    | DiaristLlmCollectResult
    | ((input: {
        readonly ticketNumber: number;
        readonly candidates: readonly DiaristSourceBlock[];
      }) => DiaristLlmCollectResult | Promise<DiaristLlmCollectResult>),
): DiaristLlmCollector {
  return async (input) => {
    if (typeof script === "function") {
      return await script(input);
    }
    return script;
  };
}
