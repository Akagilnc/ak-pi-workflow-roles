/**
 * Collector business tools, soul/material assembly, and result projection.
 * Registration flags, activation barrier, resource assembly (no-skills / no-context),
 * sole-final seal, mode/fork gates, tool surface narrowing, and failInfrastructure
 * exit live on the shared envelope (ADR 0018 / #676 E). Role keeps materials,
 * business tools, ledger facts, and projection only.
 */
import type { RoleHost, HostContext, HostToolResult } from "./host-contracts.ts";
import type { Static } from "typebox";

import {
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
import {
  createGhApiRunner,
  listPullRequestNumbersByTicket,
  type CollectorGitHubTransport,
} from "./collector-github.ts";
import {
  COLLECTOR_BIND_TARGET_TOOL,
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
  collectorBindTargetArgsSchema,
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

/** #676 A: role-chosen target could not bind uniquely — correctable, not host failure. */
export class CollectorTargetBindError extends CorrectableSubmissionError {
  constructor(message: string) {
    super(message);
    this.name = "CollectorTargetBindError";
  }
}

export {
  COLLECTOR_BIND_TARGET_TOOL,
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
};

export const COLLECTOR_REQUIRED_TOOLS = [
  COLLECTOR_BIND_TARGET_TOOL,
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  COLLECTOR_OUTPUT_TOOL,
] as const;

/** Envelope-owned transport flags (ADR 0018 / #676 E). */
export const COLLECTOR_TRANSPORT_FLAGS = Object.freeze([
  Object.freeze({
    name: "ak-collector-repo",
    definition: Object.freeze({
      description:
        "GitHub owner/repo target for Collector (github.com only; conservative ASCII grammar).",
      type: "string" as const,
    }),
  }),
  Object.freeze({
    name: "ak-collector-pr",
    definition: Object.freeze({
      description:
        "Optional positive safe-integer pull request number for Collector. Omit when the role will bind from task materials.",
      type: "string" as const,
    }),
  }),
  Object.freeze({
    name: "ak-collector-request-manifest",
    definition: Object.freeze({
      description:
        "Path to the Collector v1 request manifest JSON file.",
      type: "string" as const,
    }),
  }),
] as const);

const observeSchema = collectorObserveArgsSchema;
const readSchema = collectorReadArgsSchema;
const requestSchema = collectorRequestArgsSchema;
const waitSchema = collectorWaitArgsSchema;
const bindSchema = collectorBindTargetArgsSchema;
const outputSchema = collectorOutputArgsSchema;

type RequestParams = Static<typeof requestSchema>;
type ReadParams = Static<typeof readSchema>;
type WaitParams = Static<typeof waitSchema>;
type BindParams = Static<typeof bindSchema>;
type OutputParams = Static<typeof outputSchema>;

export type CollectorRoleDependencies = {
  loadSoul(): Promise<string>;
  createTransport(): CollectorGitHubTransport;
  createClock?(): CollectorClock;
  createLedger(config: CollectorConfigState, clock: CollectorClock, ctx: HostContext): CollectorLedger;
};

export type CollectorRoleHostActions = {
  failInfrastructure(error: unknown, ctx: HostContext, toolCallId?: string): never;
};

export type CollectorActivation = {
  soul: string;
  repository: CollectorRepository;
  manifest: CollectorManifest;
  ledger: CollectorLedger;
  transport: CollectorGitHubTransport;
  clock: CollectorClock;
};

function buildMethodContext(activation: CollectorActivation): string {
  const pr = activation.ledger.config.prNumber;
  return [
    "<collector_method>",
    `host: github.com`,
    `repository: ${activation.repository.canonical}`,
    `prNumber: ${pr === undefined ? "unbound — call ak_collector_bind_target with the role-decided issue/PR before observe" : String(pr)}`,
    `requests: ${JSON.stringify(activation.manifest.requests.map((request) => ({ id: request.id })))}`,
    "</collector_method>",
  ].join("\n");
}

function parsePositiveTicket(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1) return raw;
  if (typeof raw === "string" && /^[1-9]\d*$/.test(raw.trim())) return Number(raw.trim());
  throw new CollectorTargetBindError(`ak_collector_bind_target ${label} must be a positive safe integer`);
}

/**
 * Shared envelope installs business tools and material callback after lifecycle gates.
 * Role module does not self-hook events, setActiveTools, or mode/fork checks (ADR 0018 / #676 E).
 */
export function createCollectorRoleRuntime(
  pi: RoleHost,
  dependencies: CollectorRoleDependencies,
  hostActions: CollectorRoleHostActions,
): {
  /** Business activation only: soul, flags→config, ledger. Envelope owns lifecycle gates. */
  activate(ctx: HostContext): Promise<CollectorActivation>;
  /** Business material assembly — envelope hangs this on before_agent_start. */
  assembleMaterials(activation: CollectorActivation, baseSystemPrompt: string): string;
  /** Business operational bookkeeping callbacks for shared tool_call / tool_result seams. */
  onToolCall(
    activation: CollectorActivation,
    event: { toolName: string; toolCallId: string },
  ): { block: true; reason: string } | undefined;
  onToolResult(activation: CollectorActivation, event: { toolCallId: string }): void;
  /** Register business tools once. Envelope owns uniqueness + setActiveTools. */
  registerBusinessTools(getActivation: () => CollectorActivation | undefined): void;
} {
  let toolsRegistered = false;

  return {
    async activate(ctx) {
      const soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Collector soul is empty");

      // Flags registered by the shared envelope (COLLECTOR_TRANSPORT_FLAGS).
      const repoFlag = pi.getFlag("ak-collector-repo");
      const prFlag = pi.getFlag("ak-collector-pr");
      const requestManifestFlag = pi.getFlag("ak-collector-request-manifest");
      if (typeof repoFlag !== "string" || repoFlag.trim().length === 0) {
        throw new Error("Collector requires --ak-collector-repo");
      }
      const repository = parseCollectorRepository(repoFlag);
      // #676 A: PR may be unbound — role binds via ak_collector_bind_target from materials.
      let prNumber: number | undefined;
      if (typeof prFlag === "string" && prFlag.trim().length > 0) {
        prNumber = parseCollectorPrNumber(prFlag);
      } else if (typeof prFlag === "number") {
        prNumber = parseCollectorPrNumber(prFlag);
      }
      const manifest = typeof requestManifestFlag === "string" && requestManifestFlag.trim().length > 0
        ? await loadCollectorManifest(requestManifestFlag)
        : emptyCollectorManifest();

      const clock = dependencies.createClock?.() ?? createSystemCollectorClock();
      const transport = dependencies.createTransport();
      const ledger = dependencies.createLedger(
        { repository, prNumber, manifest },
        clock,
        ctx,
      );

      return {
        soul,
        repository,
        manifest,
        ledger,
        transport,
        clock,
      };
    },

    assembleMaterials(activation, baseSystemPrompt) {
      return [
        baseSystemPrompt,
        "",
        "<collector_soul>",
        activation.soul,
        "</collector_soul>",
        "",
        buildMethodContext(activation),
      ].join("\n");
    },

    onToolCall(activation, event) {
      // Business ledger facts only — allowed-tool / mode gates live on the envelope.
      if (activation.ledger.fatal) {
        return {
          block: true,
          reason: activation.ledger.fatalReason ?? "通进司致命状态",
        };
      }
      if (event.toolName === COLLECTOR_OUTPUT_TOOL) {
        activation.ledger.beginOperational(COLLECTOR_OUTPUT_TOOL, event.toolCallId);
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
    },

    onToolResult(activation, event) {
      activation.ledger.completeOperational(event.toolCallId);
    },

    registerBusinessTools(getActivation) {
      if (toolsRegistered) return;
      toolsRegistered = true;

      pi.registerTool({
        name: COLLECTOR_BIND_TARGET_TOOL,
        label: "通进司认票绑定",
        description:
          "角色判定任务材料后绑定本仓唯一 PR 目标。可提交 prNumber 或 issueNumber（线上关联唯一 PR）；显式 --pr 已绑定时无需再调。多义或无法确定时会正确驳回，要求调用方明确 --pr。",
        promptSnippet: "绑定角色判定的 issue/PR 目标",
        parameters: bindSchema,
        async execute(toolCallId: string, params: BindParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext) {
          const activation = getActivation();
          if (activation === undefined) throw new Error("通进司未激活");
          try {
            activation.ledger.beginOperational(COLLECTOR_BIND_TARGET_TOOL, toolCallId);
            const prNumber = parsePositiveTicket(params.prNumber, "prNumber");
            const issueNumber = parsePositiveTicket(params.issueNumber, "issueNumber");
            if (prNumber === undefined && issueNumber === undefined) {
              throw new CollectorTargetBindError(
                "ak_collector_bind_target requires role-decided prNumber and/or issueNumber",
              );
            }

            let bound = prNumber;
            if (issueNumber !== undefined) {
              const associated = await listPullRequestNumbersByTicket(createGhApiRunner(), {
                owner: activation.repository.owner,
                repo: activation.repository.repo,
                ticketNumber: issueNumber,
              });
              if (associated.length === 0) {
                throw new CollectorTargetBindError(
                  `no PR associated with issue #${issueNumber} in ${activation.repository.canonical}; pass an explicit --pr or a different issueNumber`,
                );
              }
              if (associated.length > 1) {
                throw new CollectorTargetBindError(
                  `multiple PRs associated with issue #${issueNumber}: ${associated.join(", ")}; pass an explicit prNumber or --pr`,
                );
              }
              const fromIssue = associated[0]!;
              if (prNumber !== undefined && prNumber !== fromIssue) {
                throw new CollectorTargetBindError(
                  `prNumber ${prNumber} conflicts with issue #${issueNumber} association PR ${fromIssue}`,
                );
              }
              bound = fromIssue;
            }

            activation.ledger.bindTarget(bound!);
            activation.ledger.completeOperational(toolCallId);
            return {
              content: [{
                type: "text" as const,
                text: `目标已绑定：${activation.repository.canonical}#${bound}`,
              }],
              details: {
                repository: activation.repository.canonical,
                prNumber: bound,
                ...(issueNumber === undefined ? {} : { issueNumber }),
              },
            };
          } catch (error) {
            if (isCorrectableExecuteError(error)) throw error;
            hostActions.failInfrastructure(error, ctx, toolCallId);
          } finally {
            try {
              activation.ledger.completeOperational(toolCallId);
            } catch {
              // already completed or not begun
            }
          }
        },
      });

      pi.registerTool({
        name: COLLECTOR_OBSERVE_TOOL,
        label: "通进司观察",
        description: "抓取配置目标的完整 GitHub PR 证据，存不可变快照入卷。正文在上下文中只给头部摘录加指针；需要头部之外的正文时，用 ak_collector_read 按 evidenceId 开卷；findings 的拆分与归类由你在交件时完成。目标未绑定前须先 ak_collector_bind_target。",
        promptSnippet: "抓取配置目标 PR 证据",
        parameters: observeSchema,
        async execute(toolCallId: string, _params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext) {
          const activation = getActivation();
          if (activation === undefined) throw new Error("通进司未激活");
          try {
            activation.ledger.beginOperational(COLLECTOR_OBSERVE_TOOL, toolCallId);
            const { snapshot, contextView } = await activation.ledger.observe(
              activation.transport,
              activation.clock,
              signal,
            );
            activation.ledger.completeOperational(toolCallId);
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify(contextView),
              }],
              details: contextView,
            };
          } catch (error) {
            if (isCorrectableExecuteError(error)) throw error;
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
          const activation = getActivation();
          if (activation === undefined) throw new Error("通进司未激活");
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
                text: JSON.stringify(material),
              }],
              details: material,
            };
          } catch (error) {
            if (isCorrectableExecuteError(error)) throw error;
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
          const activation = getActivation();
          if (activation === undefined) throw new Error("通进司未激活");
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
            if (isCorrectableExecuteError(error)) throw error;
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
          const activation = getActivation();
          if (activation === undefined) throw new Error("通进司未激活");
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
        bounceInfrastructureDeclaration(params) {
          const activation = getActivation();
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
          const activation = getActivation();
          if (activation === undefined) throw new Error("通进司未激活");
          try {
            activation.ledger.beginOperational(COLLECTOR_OUTPUT_TOOL, toolCallId);
            const receipt: CollectorReceipt = buildCollectorReceipt(
              activation.ledger,
              params,
              activation.clock,
            );
            activation.ledger.recordOutputCandidate();
            return {
              content: [{
                type: "text" as const,
                text: COLLECTOR_ACCEPTED_TEXT,
              }],
              details: receipt,
              terminate: true as const,
            };
          } catch (error) {
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
    },
  };
}
