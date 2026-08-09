import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";

export default function mergerBaselineProvider(pi: ExtensionAPI): void {
  const mergeCommitId = process.env.AK_MERGER_FIXTURE_COMMIT!;
  const mutation = process.env.AK_MERGER_FIXTURE_MUTATION ?? "unchanged";
  const mutate = mutation === "new"
    ? " && printf 'new\\n' > .ak/work/new.jsonl"
    : mutation === "changed"
      ? " && printf 'changed\\n' > .ak/work/opening.jsonl"
      : mutation === "deleted"
        ? " && rm .ak/work/opening.jsonl"
        : "";
  const faux = fauxProvider({
    api: "ak-merger-baseline",
    provider: "ak-merger-baseline",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", { command: `git reset --hard ${mergeCommitId}${mutate}` }, { id: "resolve" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall(MERGER_OUTPUT_TOOL_NAME, {
        status: "completed",
        attemptId: "run-merger-baseline-public",
        report: "Resolved the ordinary conflict.",
        mergeCommitId,
      }, { id: "settle" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Unable to settle the rejected completion.", { stopReason: "stop" }),
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: { apiKey: { name: "Offline Merger baseline fixture", async resolve() { return { auth: { apiKey: "offline" } }; } } },
    getModels() { return [model]; },
  };
  pi.registerProvider(provider);
}
