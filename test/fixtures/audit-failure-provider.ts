import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type JsonObject,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  INSPECTOR_OUTPUT_TOOL,
  JUDGE_OUTPUT_TOOL_NAME,
  NOTARY_OUTPUT_TOOL,
} from "../../src/role-runtime.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

export default async function auditFailureProvider(pi: ExtensionAPI): Promise<void> {
  // #475 missing-subject public tracer: keep the live leaf for singleton execute,
  // but hide candidate toolCalls from getEntries so audit materials fail closed.
  if (process.env.AK_AUDIT_MISSING_SUBJECT === "1") {
    pi.on("session_start", (_event, ctx) => {
      const manager = ctx.sessionManager as {
        getEntries?: () => readonly unknown[];
      };
      if (typeof manager.getEntries !== "function") return;
      const original = manager.getEntries.bind(manager);
      manager.getEntries = () =>
        original().map((entry) => {
          if (
            typeof entry !== "object"
            || entry === null
            || (entry as { type?: unknown }).type !== "message"
          ) {
            return entry;
          }
          const message = (entry as { message?: {
            role?: unknown;
            content?: unknown;
          } }).message;
          if (message?.role !== "assistant" || !Array.isArray(message.content)) return entry;
          const content = message.content.filter(
            (part) =>
              !(typeof part === "object"
                && part !== null
                && (part as { type?: unknown }).type === "toolCall"
                && (part as { name?: unknown }).name === JUDGE_OUTPUT_TOOL_NAME),
          );
          if (content.length === message.content.length) return entry;
          return { ...entry, message: { ...message, content } };
        });
    });
  }
  const faux = fauxProvider({
    api: "ak-audit-failure",
    provider: "ak-audit-failure",
    tokenSize: { min: 1000, max: 1000 },
  });
  const seeded = await seedAgentDirModelsJsonFromFaux(faux, process.env.PI_CODING_AGENT_DIR);
  if (process.env.AK_AUDIT_TIMEOUT_FAILURE === "1") {
    // Header timeoutMs and body-idle both default to owner-final 183000ms but are distinct seams.
    // Idle arms first; the provider schedules timeoutMs second. Compress provider waits harder so the
    // typed timeout AssistantMessage can settle before idle abort (and idle retries) take over.
    const realSetTimeout = globalThis.setTimeout;
    let deadlineClocks = 0;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 183000) {
        deadlineClocks += 1;
        const compressed = deadlineClocks % 2 === 1 ? 100 : 25;
        return realSetTimeout(handler, compressed, ...args);
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;
  }
  /** Canonical delivery matrix: recommendation | unavailable | silence (fixture seam). */
  const deliveryOutcome = process.env.AK_NAVIGATOR_DELIVERY_OUTCOME;
  const deliveryMode = deliveryOutcome === "recommendation" || deliveryOutcome === "unavailable" || deliveryOutcome === "silence"
    ? deliveryOutcome
    : undefined;
  const tolerateMalformedAudit =
    process.env.AK_HEALTHY_NAVIGATOR === "1"
    || deliveryMode === "recommendation"
    || deliveryMode === "silence";
  const roleScripted = deliveryMode !== undefined ||
    process.env.AK_AUDIT_NON_OBJECT === "1" || process.env.AK_AUDIT_UNKNOWN_STATUS === "1";
  // #419: settlement binds tool calls to results one-to-one across the whole
  // session. Auto-resume legs are separate pi subprocesses sharing one session,
  // so a fixed id collides on every leg after the first; module-level counters
  // reset per subprocess, so uniqueness needs pid + clock + in-process sequence.
  let observedJudgeSeq = 0;
  const observedJudgeCallId = () =>
    `observed-judge-${process.pid}-${Date.now().toString(36)}-${observedJudgeSeq += 1}`;
  let inputReleasedAt = "";
  /** #475 direct-officer unusable-submission mode via existing fixture. */
  const gateMode = process.env.AK_GATE_MODE;
  const response = async (context: Context, options?: { timeoutMs?: number }) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    if (names.includes(INSPECTOR_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(INSPECTOR_OUTPUT_TOOL, { status: "pass", findings: [] }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(NOTARY_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(
          NOTARY_OUTPUT_TOOL,
          gateMode === "notary-no-pass"
            ? { status: "ok-enough" }
            : { status: "pass", findings: [] },
        ),
        { stopReason: "toolUse" },
      );
    }
    // #675: public auditor uses ak_auditor_output; keep historical soul-audit tool face too.
    const auditTool = names.includes(AUDITOR_OUTPUT_TOOL_NAME)
      ? AUDITOR_OUTPUT_TOOL_NAME
      : names.includes(SOUL_AUDIT_TOOL_NAME)
        ? SOUL_AUDIT_TOOL_NAME
        : undefined;
    if (auditTool !== undefined) {
      if (process.env.AK_AUDIT_NON_OBJECT === "1") {
        return fauxAssistantMessage(fauxToolCall(auditTool, ["malformed auditor candidate"] as unknown as JsonObject));
      }
      if (process.env.AK_AUDIT_UNKNOWN_STATUS === "1") {
        return fauxAssistantMessage(fauxToolCall(auditTool, {
          status: "mystery",
          retained: "raw auditor candidate",
        }));
      }
      if (process.env.AK_AUDIT_TIMEOUT_FAILURE === "1") {
        const timeoutMs = options?.timeoutMs;
        if (typeof timeoutMs !== "number" || timeoutMs <= 0) {
          return await new Promise<ReturnType<typeof fauxAssistantMessage>>(() => undefined);
        }
        // Honor timeoutMs the way registry providers do. The fixture only
        // compresses the 183000 production delay on setTimeout so the real
        // deadline fires without sleeping 183s; it does not invent terminal
        // evidence for the test to read back.
        return await new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
          setTimeout(() => {
            resolve(fauxAssistantMessage([], {
              stopReason: "error",
              errorMessage: "provider timeout: compliance request expired",
            }));
          }, timeoutMs);
        });
      }
      if (deliveryMode === "silence") {
        return fauxAssistantMessage(fauxToolCall(auditTool, {
          status: "escalate",
          violations: [],
          conflicts: ["Soul authority conflicts with controlling authority"],
          decisionGate: {
            question: "Which authority governs this verdict?",
            options: ["Soul", "Controlling authority"],
          },
        }), { stopReason: "toolUse" });
      }
      if (roleScripted) return fauxAssistantMessage(fauxToolCall(auditTool, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
      if (tolerateMalformedAudit) return fauxAssistantMessage("MALFORMED AUDITOR OUTPUT");
      throw new Error("MALFORMED AUDITOR OUTPUT");
    }
    if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
      if (deliveryMode === "silence") {
        return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "silence-judge" }), { stopReason: "toolUse" });
      }
      if (roleScripted) return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: observedJudgeCallId() }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "fatal-judge" }), { stopReason: "toolUse" });
    }
    if (tolerateMalformedAudit || deliveryMode === "unavailable") return fauxAssistantMessage("MALFORMED AUDITOR OUTPUT");
    return fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE");
  };
  // Shared agentDir mock legal call graph (single-invoke e2e, no nested-env skip):
  // Pin 24 = measured graph for parent-stands + gate e2e, not open headroom.
  faux.setResponses(Array.from({ length: 24 }, () => response));

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline audit failure fixture",
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
  pi.on("agent_end", () => {
    inputReleasedAt = new Date().toISOString();
  });
  process.on("exit", () => {
    if (tolerateMalformedAudit) console.error(`AUDIT_FAILURE_PROCESS_RELEASE=${JSON.stringify({ at: new Date().toISOString() })}`);
  });
  pi.on("session_shutdown", async () => {
    await seeded.close();
    console.error(`AUDIT_FAILURE_PROVIDER_CALLS=${faux.state.callCount}`);
    const roleDirectory = process.env.AK_ROLE_SESSION_DIR;
    if (roleDirectory === undefined) return;
    const roleFiles = (await readdir(roleDirectory)).filter((file) => file.endsWith(".jsonl")).sort();
    if (roleFiles.length === 0) return;
    const rolePersisted = (await readFile(join(roleDirectory, roleFiles.at(-1)!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as any);
    const roleResults = rolePersisted
      .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
      .map((entry) => ({
        toolCallId: entry.message.toolCallId,
        toolName: entry.message.toolName,
        isError: entry.message.isError === true,
        details: entry.message.details ?? {},
        usage: entry.message.usage,
      }));
    const failedOutput = roleResults.find((entry) => entry.toolCallId === "fatal-judge");
    const failedOutputEntry = [...rolePersisted].find(
      (entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolCallId === "fatal-judge",
    );
    const closureEntry = [...rolePersisted].reverse().find(
      (entry) => entry.type === "custom" && entry.customType === "ak-role-submission-closure",
    );
    const closureDetails = typeof closureEntry?.data === "object" && closureEntry.data !== null
      ? (closureEntry.data as { details?: unknown }).details ?? {}
      : {};
    console.error(`AUDIT_FAILURE_EVIDENCE=${JSON.stringify({
      providerCalls: faux.state.callCount,
      role: {
        failedOutput,
        failedOutputAt: failedOutputEntry?.timestamp ?? "",
        failedOutputCorrelation:
          failedOutput?.toolCallId === "fatal-judge" && failedOutput?.toolName === JUDGE_OUTPUT_TOOL_NAME,
        closureDetails,
      },
      inputReleasedAt,
    })}`);
  });
}
