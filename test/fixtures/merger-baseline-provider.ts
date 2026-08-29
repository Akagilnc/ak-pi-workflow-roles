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
  const residual = process.env.AK_MERGER_FIXTURE_RESIDUAL;
  const faux = fauxProvider({
    api: "ak-merger-baseline",
    provider: "ak-merger-baseline",
    tokenSize: { min: 1000, max: 1000 },
  });
  const attemptId = process.env.AK_MERGER_FIXTURE_ATTEMPT_ID ?? "run-merger-baseline-public";
  // Residual cases are single-fault: sibling = sole-final only; sole/wrong-attempt = shape/identity only.
  // Dual-fault (sibling + malformed) made schema reject before the ledger owned 0041.
  const output = {
    status: "completed",
    attemptId: residual === "wrong-attempt" ? "other-attempt" : attemptId,
    report: "Resolved the ordinary conflict.",
    mergeCommitId: residual === "sole" || residual === "wrong-attempt" ? "malformed" : mergeCommitId,
  };
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", { command: `git reset --hard ${mergeCommitId}` }, { id: "resolve" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall(MERGER_OUTPUT_TOOL_NAME, output, { id: "settle" }),
        ...(residual === "sibling"
          ? [fauxToolCall("read", { path: "same.txt" }, { id: "sibling" })]
          : []),
      ],
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
