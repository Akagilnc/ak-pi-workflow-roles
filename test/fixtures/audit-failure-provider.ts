import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
  resolveActivationLedgerHomeForPath,
} from "../../src/activation-ledger-topology.ts";
import {
  INSPECTOR_OUTPUT_TOOL,
  JUDGE_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
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
  const observation = process.env.AK_NAVIGATOR_OBSERVATION === "1";
  /** Canonical delivery matrix: recommendation | unavailable | silence (extends observation seam). */
  const deliveryOutcome = process.env.AK_NAVIGATOR_DELIVERY_OUTCOME;
  const deliveryMode = deliveryOutcome === "recommendation" || deliveryOutcome === "unavailable" || deliveryOutcome === "silence"
    ? deliveryOutcome
    : undefined;
  const healthyNavigator =
    process.env.AK_HEALTHY_NAVIGATOR === "1"
    || observation
    || deliveryMode === "recommendation"
    || deliveryMode === "silence";
  const roleScripted = observation || deliveryMode !== undefined ||
    process.env.AK_AUDIT_NON_OBJECT === "1" || process.env.AK_AUDIT_UNKNOWN_STATUS === "1";
  // #419: settlement binds tool calls to results one-to-one across the whole
  // session. Auto-resume legs are separate pi subprocesses sharing one session,
  // so a fixed id collides on every leg after the first; module-level counters
  // reset per subprocess, so uniqueness needs pid + clock + in-process sequence.
  let observedJudgeSeq = 0;
  const observedJudgeCallId = () =>
    `observed-judge-${process.pid}-${Date.now().toString(36)}-${observedJudgeSeq += 1}`;
  let navigatorCalls = 0;
  let navigatorStartedAt = "";
  let navigatorCompletedAt = "";
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
    if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
      if (deliveryMode === "unavailable") {
        navigatorCalls += 1;
        navigatorStartedAt = new Date().toISOString();
        // Malformed prepare forces typed unavailable; role receipt still converges.
        navigatorCompletedAt = new Date().toISOString();
        return fauxAssistantMessage("NAVIGATOR PREPARE MALFORMED");
      }
      if (healthyNavigator) {
        navigatorCalls += 1;
        navigatorStartedAt = new Date().toISOString();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        navigatorCompletedAt = new Date().toISOString();
        return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
          candidates: [{
            id: "audit-failure-route",
            matches: { role: "judge", phase: null },
            route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }],
            next: { role: "reviewer", phase: null },
            reason: "healthy in-flight Navigator preparation",
            command: "Usage: pi --ak-role reviewer --help",
          }],
        }), { stopReason: "toolUse" });
      }
    }
    // #675: public auditor uses ak_auditor_output; keep historical soul-audit tool face too.
    const auditTool = names.includes(AUDITOR_OUTPUT_TOOL_NAME)
      ? AUDITOR_OUTPUT_TOOL_NAME
      : names.includes(SOUL_AUDIT_TOOL_NAME)
        ? SOUL_AUDIT_TOOL_NAME
        : undefined;
    if (auditTool !== undefined) {
      if (process.env.AK_AUDIT_NON_OBJECT === "1") {
        return fauxAssistantMessage(fauxToolCall(auditTool, ["malformed auditor candidate"]));
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
      // Healthy Navigator keeps typed no-receipt (malformed prose). The default
      // fatal path must still abort as infrastructure after Gatekeeper passes:
      // prose alone is no-receipt (exit 0), not infrastructure failure.
      if (healthyNavigator) return fauxAssistantMessage("MALFORMED AUDITOR OUTPUT");
      throw new Error("MALFORMED AUDITOR OUTPUT");
    }
    if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
      if (deliveryMode === "silence") {
        return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "silence-judge" }), { stopReason: "toolUse" });
      }
      if (roleScripted) return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: observedJudgeCallId() }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "fatal-judge" }), { stopReason: "toolUse" });
    }
    if (healthyNavigator || deliveryMode === "unavailable") return fauxAssistantMessage("MALFORMED AUDITOR OUTPUT");
    return fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE");
  };
  // Route by active tool surface so scripted province pass runs before auditor legs.
  // Fatal path used a fixed 3-slot queue; province children need two more turns
  // or MALFORMED is spent on Gatekeeper instead of auditor.
  faux.setResponses(Array.from({ length: 8 }, () => response));

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
    if (healthyNavigator && !observation) console.error(`AUDIT_FAILURE_PROCESS_RELEASE=${JSON.stringify({ at: new Date().toISOString() })}`);
  });
  pi.on("session_shutdown", async () => {
    await seeded.close();
    console.error(`AUDIT_FAILURE_PROVIDER_CALLS=${faux.state.callCount}`);
    if (!healthyNavigator || observation) return;
    const root = process.env.AK_NAVIGATOR_ROOT;
    // #604: derive ledger home from the role session path when present — bare
    // resolveActivationLedgerHome() is packageMachineHome and ignores HOME.
    const sessionDir = process.env.AK_ROLE_SESSION_DIR;
    const ledgerHome =
      typeof sessionDir === "string" && sessionDir.length > 0
        ? resolveActivationLedgerHomeForPath(sessionDir)
        : resolveActivationLedgerHome();
    const navigatorRoot = root === undefined ? undefined : join(
      activationBookDirectory(ledgerHome, resolveBookKeyFromGit(root)),
      "navigator",
    );
    const subjectDirectories = navigatorRoot === undefined ? [] : (await readdir(navigatorRoot)).sort();
    const directory = navigatorRoot === undefined || subjectDirectories.length === 0
      ? undefined
      : join(navigatorRoot, subjectDirectories.at(-1)!);
    const files = directory === undefined ? [] : (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
    const persisted = files.length === 0 || directory === undefined
      ? []
      : (await readFile(join(directory, files.at(-1)!), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    // Prefer explicit role session dir (ledger-home topology); fall back to legacy issue-root layout.
    const roleDirectory = process.env.AK_ROLE_SESSION_DIR
      ?? (root === undefined ? undefined : join(root, "runs", "judge", "session"));
    const roleFiles = roleDirectory === undefined ? [] : (await readdir(roleDirectory)).filter((file) => file.endsWith(".jsonl")).sort();
    const rolePersisted = roleFiles.length === 0 || roleDirectory === undefined
      ? []
      : (await readFile(join(roleDirectory, roleFiles.at(-1)!), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    const prepared = [...persisted].reverse().find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === NAVIGATOR_PREPARE_TOOL_NAME);
    const settlement = [...persisted].reverse().find((entry) => entry.type === "custom" && entry.customType === "ak-navigator-settlement");
    const roleResults = rolePersisted
      .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
      .map((entry) => ({ toolCallId: entry.message.toolCallId, toolName: entry.message.toolName, isError: entry.message.isError === true, details: entry.message.details ?? {}, usage: entry.message.usage }));
    const failedOutput = roleResults.find((entry) => entry.toolCallId === "fatal-judge");
    const failedOutputEntry = [...rolePersisted].find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolCallId === "fatal-judge");
    // #575 sole-final barrier: execute projects only a pending-round-closure candidate;
    // the audited decisive facts (judgeStatus + auditNoReceipt) arrive on the typed closure.
    const closureEntry = [...rolePersisted].reverse().find((entry) => entry.type === "custom" && entry.customType === "ak-role-submission-closure");
    const closureDetails = typeof closureEntry?.data === "object" && closureEntry.data !== null
      ? (closureEntry.data as { details?: unknown }).details ?? {}
      : {};
    // #675: nested public path may rebind prepare after settle; ordering contract is
    // first preparation complete before last settlement.
    const allPrepares = persisted.filter((entry: any) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === NAVIGATOR_PREPARE_TOOL_NAME && entry.message?.isError !== true);
    const firstPrepare = allPrepares[0];
    const preparedAt = typeof firstPrepare?.timestamp === "string"
      ? firstPrepare.timestamp
      : (typeof prepared?.timestamp === "string" ? prepared.timestamp : "");
    const settledAt = typeof settlement?.timestamp === "string" ? settlement.timestamp : "";
    // Prefer the earliest start (counter may record a late rebind start after first prepare).
    const startedAt = navigatorStartedAt !== "" && preparedAt !== ""
      ? (Date.parse(navigatorStartedAt) <= Date.parse(preparedAt) ? navigatorStartedAt : preparedAt)
      : (navigatorStartedAt !== "" ? navigatorStartedAt : preparedAt);
    // Use first-prepare completion for drain-before-settle; last counter complete may post-date settle under rebind.
    const completedAt = preparedAt !== "" ? preparedAt : (navigatorCompletedAt !== "" ? navigatorCompletedAt : "");
    const drainedBeforeSettlement = completedAt !== "" && settledAt !== "" && Date.parse(completedAt) <= Date.parse(settledAt);
    console.error(`AUDIT_FAILURE_EVIDENCE=${JSON.stringify({
      providerCalls: faux.state.callCount,
      navigatorCalls: navigatorCalls > 0 ? navigatorCalls : (preparedAt !== "" ? 1 : 0),
      navigator: { startedAt, completedAt, preparedAt, settledAt, settlementKind: settlement?.data?.kind ?? "", inputReleasedAt, releaseAfterDrain: drainedBeforeSettlement },
      role: { failedOutput, failedOutputAt: failedOutputEntry?.timestamp ?? "", failedOutputCorrelation: failedOutput?.toolCallId === "fatal-judge" && failedOutput?.toolName === JUDGE_OUTPUT_TOOL_NAME, closureDetails },
    })}`);
  });
}
