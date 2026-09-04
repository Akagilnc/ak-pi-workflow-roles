import type { RoleHost, HostContext, HostToolResult } from "./host-contracts.ts";
import type { Static } from "typebox";

import {
  COLLECTOR_FIXED_KICKOFF,
  emptyCollectorManifest,
  loadCollectorManifest,
  parseCollectorPrNumber,
  parseCollectorRepository,
  type CollectorManifest,
  type CollectorRepository,
} from "./collector-config.ts";
import {
  createSystemCollectorClock,
  type CollectorClock,
} from "./collector-evidence.ts";
import type { CollectorGitHubTransport } from "./collector-github.ts";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  projectEvidenceEntryView,
  type CollectorConfigState,
  type CollectorLedger,
} from "./collector-ledger.ts";
import {
  buildCollectorReceipt,
  type CollectorReceipt,
} from "./collector-receipt.ts";
import {
  collectorObserveArgsSchema,
  collectorOutputArgsSchema,
  collectorReadArgsSchema,
  collectorRequestArgsSchema,
  collectorWaitArgsSchema,
} from "./collector-tool-schemas.ts";
import { COLLECTOR_ACCEPTED_TEXT } from "./package-contracts/collector-output.ts";
import { CorrectableSubmissionError, isCorrectableExecuteError } from "./submission-correctable-error.ts";
import { CollectorUnknownEvidenceError } from "./collector-identity.ts";

export { CollectorUnknownEvidenceError } from "./collector-identity.ts";

/**
 * #641 chain②: normal completion must never declare `infrastructureFailure`.
 * When the runtime can machine-verify a lawful receipt assembly, a declaration
 * is model misuse — bounce it as correctable guidance instead of host failure.
 */
export class CollectorNormalCompletionDeclarationError extends CorrectableSubmissionError {
  constructor() {
    super("runtime 已按机器状态核验本局为正常完工（回执可合法组装）：正常完工的交件不得填 infrastructureFailure，请省略该字段后重新提交。");
    this.name = "CollectorNormalCompletionDeclarationError";
  }
}

export {
  COLLECTOR_FIXED_KICKOFF,
} from "./collector-config.ts";
export {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
};

export const COLLECTOR_REQUIRED_TOOLS = [
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  COLLECTOR_OUTPUT_TOOL,
] as const;

const observeSchema = collectorObserveArgsSchema;
const readSchema = collectorReadArgsSchema;
const requestSchema = collectorRequestArgsSchema;
const waitSchema = collectorWaitArgsSchema;
const outputSchema = collectorOutputArgsSchema;

type RequestParams = Static<typeof requestSchema>;
type ReadParams = Static<typeof readSchema>;
type WaitParams = Static<typeof waitSchema>;
type OutputParams = Static<typeof outputSchema>;

export type CollectorRoleDependencies = {
  loadSoul(): Promise<string>;
  createTransport(): CollectorGitHubTransport;
  createClock?(): CollectorClock;
  createLedger(config: CollectorConfigState, clock: CollectorClock, ctx: HostContext): CollectorLedger;
  packageExtensionPath?: string;
};

export type CollectorRoleHostActions = {
  failInfrastructure(error: unknown, ctx: HostContext, toolCallId?: string): never;
};

type CollectorActivation = {
  soul: string;
  repository: CollectorRepository;
  prNumber: number;
  manifest: CollectorManifest;
  ledger: CollectorLedger;
  transport: CollectorGitHubTransport;
  clock: CollectorClock;
};

/** Sole-final at the output execution seam (same shape as other terminating roles). */

function buildMethodContext(activation: CollectorActivation): string {
  return [
    "<collector_method>",
    `host: github.com`,
    `repository: ${activation.repository.canonical}`,
    `prNumber: ${activation.prNumber}`,
    `requests: ${JSON.stringify(activation.manifest.requests.map((request) => ({ id: request.id })))}`,
    "</collector_method>",
  ].join("\n");
}

export function createCollectorRoleRuntime(
  pi: RoleHost,
  dependencies: CollectorRoleDependencies,
  hostActions: CollectorRoleHostActions,
): {
  activate(
    ctx: HostContext,
    event: { reason: string },
  ): Promise<void>;
} {
  let activation: CollectorActivation | undefined;
  let inputCount = 0;
  let lifecycleRegistered = false;
  let toolsRegistered = false;
  let firstDispatchDone = false;

  pi.registerFlag("ak-collector-repo", {
    description:
      "GitHub owner/repo target for Collector (github.com only; conservative ASCII grammar). Collector forbids every Skill, including command-only Skills.",
    type: "string",
  });
  pi.registerFlag("ak-collector-pr", {
    description:
      "Positive safe-integer pull request number for Collector. Supported profile: --no-skills, --no-extensions with only the explicit Collector package extension, no prompt templates/context files, one print/JSON prompt",
    type: "string",
  });
  pi.registerFlag("ak-collector-request-manifest", {
    description:
      "Path to the Collector v1 request manifest JSON file. In Pi latest, late hostile sibling-extension Skill injection is unsupported and fail-closed when detected; drift prevention only, not a security boundary or provider-zero guarantee",
    type: "string",
  });

  const ensureLifecycle = (): void => {
    if (lifecycleRegistered) return;
    lifecycleRegistered = true;

    pi.on("input", (event, ctx) => {
      if (activation === undefined) {
        // role not active
        return { action: "continue" as const };
      }
      if (inputCount >= 1) {
        activation.ledger.latchFatal("通进司已拒绝后续输入");
        if (process.exitCode === undefined || process.exitCode === 0) {
          process.exitCode = 1;
        }
        console.error("Collector rejected later input");
        return { action: "handled" as const };
      }
      inputCount += 1;
      return {
        action: "transform" as const,
        text: COLLECTOR_FIXED_KICKOFF,
        images: [],
      };
    });

    pi.on("before_agent_start", (event, ctx) => {
      if (activation === undefined) return;

      // Detectable ambient instruction resources on the supported prompt surface.
      const options = event.systemPromptOptions;
      if (options.skills && options.skills.length > 0) {
        hostActions.failInfrastructure(
          activation.ledger.latchFatal(
            "通进司检测到系统提示中的环境 skills",
          ),
          ctx,
        );
      }
      if (options.contextFiles && options.contextFiles.length > 0) {
        hostActions.failInfrastructure(
          activation.ledger.latchFatal(
            "通进司检测到系统提示中的环境 context files",
          ),
          ctx,
        );
      }
      if (
        typeof options.appendSystemPrompt === "string" &&
        options.appendSystemPrompt.trim().length > 0
      ) {
        hostActions.failInfrastructure(
          activation.ledger.latchFatal(
            "通进司检测到 appendSystemPrompt 漂移",
          ),
          ctx,
        );
      }

      if (event.prompt !== COLLECTOR_FIXED_KICKOFF) {
        hostActions.failInfrastructure(
          activation.ledger.latchFatal(
            "通进司首条提示不是固定开场令",
          ),
          ctx,
        );
      }

      if (!firstDispatchDone) {
        firstDispatchDone = true;
        activation.ledger.recordActivation(activation.clock);
      }

      return {
        systemPrompt: [
          event.systemPrompt,
          "",
          "<collector_soul>",
          activation.soul,
          "</collector_soul>",
          "",
          buildMethodContext(activation),
        ].join("\n"),
      };
    });

    pi.on("tool_call", (event) => {
      if (activation === undefined) return;
      if (activation.ledger.fatal) {
        return {
          block: true,
          reason: activation.ledger.fatalReason ?? "通进司致命状态",
        };
      }
      if (!(COLLECTOR_REQUIRED_TOOLS as readonly string[]).includes(event.toolName)) {
        return {
          block: true,
          reason: `通进司禁用工具 ${event.toolName}`,
        };
      }
      if (
        activation.ledger.outputCandidate &&
        event.toolName !== COLLECTOR_OUTPUT_TOOL
      ) {
        return {
          block: true,
          reason: "通进司已产出输出候选，本局不再受理操作",
        };
      }
      return undefined;
    });

    pi.on("tool_result", (event) => {
      if (activation === undefined) return;
      activation.ledger.completeOperational(event.toolCallId);
    });

    pi.on("session_shutdown", () => {
      if (activation === undefined) return;
      if (activation.ledger.fatal) {
        if (process.exitCode === undefined || process.exitCode === 0) {
          process.exitCode = 1;
        }
      }
    });
  };

  const registerTools = (): void => {
    if (toolsRegistered) return;
    toolsRegistered = true;

    pi.registerTool({
      name: COLLECTOR_OBSERVE_TOOL,
      label: "通进司观察",
      description: "抓取配置目标的完整 GitHub PR 证据，存不可变快照入卷。正文在上下文中只给头部摘录加指针；需要头部之外的正文时，用 ak_collector_read 按 evidenceId 开卷；findings 的拆分与归类由你在交件时完成。",
      promptSnippet: "抓取配置目标 PR 证据",
      parameters: observeSchema,
      async execute(toolCallId: string, _params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext) {
        if (activation === undefined) {
          throw new Error("通进司未激活");
        }
        try {
          activation.ledger.beginOperational(COLLECTOR_OBSERVE_TOOL, toolCallId);
          const { snapshot, contextView } = await activation.ledger.observe(
            activation.transport,
            activation.clock,
            signal,
          );
          activation.ledger.completeOperational(toolCallId);
          if (snapshot.prState !== "OPEN") {
            // Non-OPEN observed as latest complete snapshot is target-state failure at output,
            // but observe itself may return the fact. If this is a final observation, still return.
          }
          return {
            content: [{
              type: "text" as const,
              // #641 chain①: model context carries bounded body heads + pointers only.
              text: JSON.stringify(contextView),
            }],
            // #641 the bounded projection is the only provider-visible face on every host
            // (Grok/ACP relays tool details as MCP structuredContent); full bodies stay
            // in the ledger volume and enter context only by explicit ak_collector_read.
            details: contextView,
          };
        } catch (error) {
          hostActions.failInfrastructure(error, ctx, toolCallId);
        }
      },
    });

    pi.registerTool({
      name: COLLECTOR_READ_TOOL,
      label: "通进司开卷",
      description: "按 evidenceId 开卷读取一条已观测材料的全量正文与指针；只在观察头部摘录不足以判读时调用。",
      promptSnippet: "按指针开卷读材料",
      parameters: readSchema,
      async execute(toolCallId: string, params: ReadParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext) {
        if (activation === undefined) {
          throw new Error("通进司未激活");
        }
        try {
          activation.ledger.beginOperational(COLLECTOR_READ_TOOL, toolCallId);
          const record = activation.ledger.getEvidence(params.evidenceId);
          if (
            record === undefined ||
            (record.kind !== "review" && record.kind !== "issue_comment" && record.kind !== "review_comment" && record.kind !== "reaction") ||
            typeof record.body !== "string"
          ) {
            throw new CollectorUnknownEvidenceError(params.evidenceId);
          }
          const material = projectEvidenceEntryView(record);
          activation.ledger.completeOperational(toolCallId);
          return {
            content: [{
              type: "text" as const,
              // #641 chain①: full bodies enter provider context only by explicit pointer.
              text: JSON.stringify(material),
            }],
            details: material,
          };
        } catch (error) {
          if (isCorrectableExecuteError(error)) throw error;
          // typed toolCallId books the shared infrastructure fact so settlement can
          // tell a read tool's real host failure from a correctable pointer bounce.
          hostActions.failInfrastructure(error, ctx, toolCallId);
        }
      },
    });

    pi.registerTool({
      name: COLLECTOR_REQUEST_TOOL,
      label: "通进司请求",
      description: "按配置请求体与关联标记，在所引最新快照 HEAD 发一次请求。",
      promptSnippet: "按配置发一次请求",
      parameters: requestSchema,
      async execute(toolCallId: string, params: RequestParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext) {
        if (activation === undefined) {
          throw new Error("通进司未激活");
        }
        try {
          activation.ledger.beginOperational(COLLECTOR_REQUEST_TOOL, toolCallId);
          const details = await activation.ledger.request(
            params,
            activation.transport,
            activation.clock,
            signal,
          );
          activation.ledger.completeOperational(toolCallId);
          return {
            content: [{
              type: "text" as const,
              text: `请求尝试已记录：request ${params.requestId}`,
            }],
            details,
          };
        } catch (error) {
          hostActions.failInfrastructure(error, ctx, toolCallId);
        }
      },
    });

    pi.registerTool({
      name: COLLECTOR_WAIT_TOOL,
      label: "通进司等待",
      description: "再观察前等待；单次上限五分钟且不超剩余资格。",
      promptSnippet: "资格截止前等待",
      parameters: waitSchema,
      async execute(toolCallId: string, params: WaitParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext) {
        if (activation === undefined) {
          throw new Error("通进司未激活");
        }
        try {
          activation.ledger.beginOperational(COLLECTOR_WAIT_TOOL, toolCallId);
          const details = await activation.ledger.wait(
            params,
            activation.clock,
            signal,
          );
          activation.ledger.completeOperational(toolCallId);
          return {
            content: [{
              type: "text" as const,
              text: `已等待 ${String((details as { effectiveMs: number }).effectiveMs)}ms`,
            }],
            details,
          };
        } catch (error) {
          hostActions.failInfrastructure(error, ctx, toolCallId);
        }
      },
    });

    pi.registerTool({
      name: COLLECTOR_OUTPUT_TOOL,
      label: "通进司输出",
      description: "观察完成后提交；回执由 runtime 组装。正常完工提交空对象 {}（如需报 finding，填 findings 指针数组）；仅在基础设施真实失败时才可填 infrastructureFailure，无失败时必须省略该字段。",
      promptSnippet: "提交通进司回执",
      // #641 chain②: the seat owns the normal-completion decision. The probe
      // runs the exact receipt assembly (validation only, no accept side
      // effects); success ⇒ machine-verified normal completion ⇒ bounce.
      bounceInfrastructureDeclaration(params) {
        if (activation === undefined) return undefined;
        try {
          buildCollectorReceipt(activation.ledger, params, activation.clock);
        } catch {
          return undefined;
        }
        return new CollectorNormalCompletionDeclarationError();
      },
      parameters: outputSchema,
      async execute(toolCallId: string, params: OutputParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext) {
        if (activation === undefined) {
          throw new Error("通进司未激活");
        }
        try {
          activation.ledger.beginOperational(COLLECTOR_OUTPUT_TOOL, toolCallId);
          const receipt: CollectorReceipt = buildCollectorReceipt(
            activation.ledger,
            params,
            activation.clock,
          );
          activation.ledger.recordOutputCandidate();
          const acceptedDetails = receipt;
          return {
            content: [{
              type: "text" as const,
              text: COLLECTOR_ACCEPTED_TEXT,
            }],
            details: acceptedDetails,
            terminate: true as const,
          };
        } catch (error) {
          // Output validation errors are model-visible rejections when non-fatal.
          if (
            error instanceof Error &&
            (error as { collectorFatal?: boolean }).collectorFatal === true
          ) {
            hostActions.failInfrastructure(error, ctx, toolCallId);
          }
          throw error;
        } finally {
          activation.ledger.completeOperational(toolCallId);
        }
      },
    });
  };

  return {
    async activate(ctx, event) {
      activation = undefined;
      ensureLifecycle();

      if (ctx.mode !== "print" && ctx.mode !== "json") {
          throw new Error(
            `Collector supports only print or json mode (got ${ctx.mode})`,
          );
        }
        if (
          event.reason === "fork" ||
          event.reason === "reload"
        ) {
          throw new Error(
            `Collector does not support session_start reason ${event.reason}`,
          );
        }

        const soul = (await dependencies.loadSoul()).trim();
        if (soul.length === 0) throw new Error("Collector soul is empty");

        const repoFlag = pi.getFlag("ak-collector-repo");
        const prFlag = pi.getFlag("ak-collector-pr");
        const requestManifestFlag = pi.getFlag("ak-collector-request-manifest");
        if (typeof repoFlag !== "string" || repoFlag.trim().length === 0) {
          throw new Error("Collector requires --ak-collector-repo");
        }
        if (typeof prFlag !== "string" && typeof prFlag !== "number") {
          throw new Error("Collector requires --ak-collector-pr");
        }
        const repository = parseCollectorRepository(repoFlag);
        const prNumber = parseCollectorPrNumber(prFlag);
        const manifest = typeof requestManifestFlag === "string" && requestManifestFlag.trim().length > 0
          ? await loadCollectorManifest(requestManifestFlag)
          : emptyCollectorManifest();

        // Detectable ambient command surface (skills/templates) when exposed.
        const commands = pi.getCommands?.() ?? [];
        const ambientCommands = commands.filter((command) => {
          const name = command.name.toLowerCase();
          return (
            name.includes("skill") ||
            name.includes("prompt") ||
            name.startsWith("template")
          );
        });
        if (ambientCommands.length > 0) {
          throw new Error(
            `Collector detected ambient instruction commands: ${
              ambientCommands.map((c) => c.name).join(", ")
            }`,
          );
        }

        // Fail closed if a required name is already occupied before Collector registers.
        const preExisting = pi.getAllTools();
        for (const required of COLLECTOR_REQUIRED_TOOLS) {
          const prior = preExisting.filter((tool) => tool.name === required);
          if (prior.length > 0) {
            throw new Error(`Collector required tool name collision: ${required}`);
          }
        }

        registerTools();

        const allTools = pi.getAllTools();
        for (const required of COLLECTOR_REQUIRED_TOOLS) {
          const matches = allTools.filter((tool) => tool.name === required);
          if (matches.length === 0) {
            throw new Error(`Collector required tool missing: ${required}`);
          }
          if (matches.length > 1) {
            throw new Error(`Collector required tool name collision: ${required}`);
          }
          const tool = matches[0]!;
          if (
            dependencies.packageExtensionPath !== undefined &&
            tool.sourceInfo?.path !== undefined &&
            tool.sourceInfo.path !== dependencies.packageExtensionPath &&
            !tool.sourceInfo.path.includes("role-runtime")
          ) {
            throw new Error(
              `Collector required tool ${required} is overridden by ${tool.sourceInfo.path}`,
            );
          }
        }

        pi.setActiveTools([...COLLECTOR_REQUIRED_TOOLS]);
        const active = new Set(pi.getActiveTools());
        for (const required of COLLECTOR_REQUIRED_TOOLS) {
          if (!active.has(required)) {
            throw new Error(`Collector failed to activate required tool ${required}`);
          }
        }
        for (const name of active) {
          if (!(COLLECTOR_REQUIRED_TOOLS as readonly string[]).includes(name)) {
            throw new Error(`Collector active tool surface includes unexpected ${name}`);
          }
        }

        const clock = dependencies.createClock?.() ?? createSystemCollectorClock();
        const transport = dependencies.createTransport();

        const ledger = dependencies.createLedger(
          { repository, prNumber, manifest },
          clock,
          ctx,
        );

        if (ledger.activationRecorded) {
          firstDispatchDone = true;
        }

      activation = {
        soul,
        repository,
        prNumber,
        manifest,
        ledger,
        transport,
        clock,
      };
    },
  };
}
