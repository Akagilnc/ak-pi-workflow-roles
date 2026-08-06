/**
 * Offline faux provider for the public OPEN-PR + nonexistent-author missing path.
 * observe → advance past eligibility cutoff (external virtual system time) →
 * final observe → ak_collector_output missing.
 *
 * Time control is external to production runtime: patches Date/hrtime so the
 * unmodified production createSystemCollectorClock reaches cutoff. Does not
 * replace extensions/role-runtime.ts or add a production test hook.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
} from "../../src/collector-ledger.ts";
import { collectorVirtualSystemTime } from "./collector-virtual-system-time.ts";

const ELIGIBILITY_PLUS_MS = 16 * 60 * 1000;

function snapshotIdFromToolResult(message: {
  role?: string;
  content?: unknown;
  details?: unknown;
}): string | undefined {
  if (message.role !== "toolResult") return undefined;
  const details = message.details;
  if (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    typeof (details as { snapshotId?: unknown }).snapshotId === "string"
  ) {
    return (details as { snapshotId: string }).snapshotId;
  }
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === "object" &&
              part !== null &&
              typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
            )
            .join("")
        : "";
  if (text.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { snapshotId?: unknown }).snapshotId === "string"
    ) {
      return (parsed as { snapshotId: string }).snapshotId;
    }
  } catch {
    // content is not JSON
  }
  return undefined;
}

export default function collectorMissingProvider(pi: ExtensionAPI): void {
  // Reset shared virtual system time for this process activation.
  collectorVirtualSystemTime.reset();

  const faux = fauxProvider({
    api: "ak-collector-missing-offline",
    provider: "ak-collector-missing-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "collector-miss-obs-1" }),
      { stopReason: "toolUse" },
    ),
    () => {
      // External time fixture: advance past eligibility so production clock/ledger
      // accept missing without replacing the production runtime entrypoint.
      collectorVirtualSystemTime.advance(ELIGIBILITY_PLUS_MS);
      return fauxAssistantMessage(
        fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "collector-miss-obs-2" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const prior = [...context.messages].reverse().find((message) =>
        snapshotIdFromToolResult(message) !== undefined
      );
      const snapshotId =
        prior === undefined ? undefined : snapshotIdFromToolResult(prior);
      if (snapshotId === undefined) {
        throw new Error("missing-path provider: no snapshotId after final observe");
      }
      return fauxAssistantMessage(
        fauxToolCall(
          COLLECTOR_OUTPUT_TOOL,
          {
            legs: [
              {
                legId: "codex",
                status: "missing",
                rationale:
                  "OPEN PR observed; expected author absent with no qualifying review by cutoff",
                evidenceRefs: [snapshotId],
              },
            ],
          },
          { id: "collector-miss-out" },
        ),
        { stopReason: "toolUse" },
      );
    },
  ]);

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Collector missing fixture",
        async resolve() {
          return { auth: { apiKey: "offline" } };
        },
      },
    },
    getModels() {
      return [model];
    },
  };
  pi.registerProvider(provider);
  pi.on("session_shutdown", () => {
    console.error(`COLLECTOR_MISSING_PROVIDER_CALLS=${faux.state.callCount}`);
  });
}
