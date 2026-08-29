import { Type, type Static, type TLiteral, type TSchema } from "typebox";

type HostContentPart = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments?: unknown } | { type: string };
type HostMessage = { role: string; content?: unknown; toolName?: string; isError?: boolean; stopReason?: string };
type HostEventMessage = { role: string; content: readonly HostContentPart[]; toolName?: string; isError?: boolean; stopReason?: string };
type HostSessionEntry = { type: string; message?: HostMessage };

export type HostToolResult<T = unknown> = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: T;
  terminate?: boolean;
};

/** Opaque host-owned identity persisted with a Role run. */
export type DurablePrincipal = object & { readonly __durablePrincipal?: never };

/** Controlled post-admission failure classes (ADR 0052 / #107). Owner = host contract. */
export type ControlledFailureCause =
  | "activation"
  | "provider"
  | "session"
  | "output"
  | "timeout"
  | "unrecognized";

/** Production-owned typed failure carried on a resolved turn result. */
export type RoleTurnKnownFailure = {
  readonly cause: ControlledFailureCause;
  readonly identity?: {
    readonly name?: string;
    readonly code?: string | number;
  };
  /**
   * Optional diagnostic already owned by a typed production field (e.g. session
   * assistant errorMessage). Settlement prefers this over child stderr selection.
   */
  readonly diagnostic?: string;
  /** Secondary evidence attached to the same typed failure record. */
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * Thrown activation failure with a production-owned typed cause.
 * Prefer this over ad-hoc Error property tags so settlement retains typed identity.
 * Final owner = host contract (#526); public-cli/pi/role-runtime all import here.
 */
export class ExplicitInternalActivationError extends Error {
  readonly knownCause: ControlledFailureCause;
  readonly failureCode?: string | number;

  constructor(
    message: string,
    options: {
      knownCause: ControlledFailureCause;
      code?: string | number;
      name?: string;
      cause?: unknown;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = options.name ?? "ExplicitInternalActivationError";
    this.knownCause = options.knownCause;
    if (options.code !== undefined) {
      this.failureCode = options.code;
    }
  }
}

/** Packaged method skill binding (zero/one/many). */
export type MethodBinding = {
  readonly kind: "skill";
  readonly path: string;
};

/**
 * Host-neutral closed role activation projection.
 * Adapter translates to host-specific flags; does not reverse-parse prompt prose.
 */
export type RoleTurnActivation =
  | { readonly role: "judge" }
  | {
      readonly role: "coder";
      readonly phase: string;
      readonly taskPath: string;
    }
  | {
      readonly role: "fixer";
      readonly phase: string;
      readonly packetPath: string;
      readonly prerequisitesPath?: string;
    }
  | {
      readonly role: "reviewer";
      readonly baseRevision: string;
      readonly authorityRefs: readonly string[];
      readonly ticketNumber?: number;
    }
  | { readonly role: "merger"; readonly inputPath: string }
  | {
      readonly role: "collector";
      readonly repo: string;
      readonly pr: string;
      readonly requestManifestPath?: string;
    }
  | { readonly role: "doctor"; readonly casePath: string }
  | { readonly role: "notary"; readonly sourceRun: string };

export type RoleTurnContinuation =
  | { readonly kind: "initial"; readonly prompt: string }
  | { readonly kind: "resume"; readonly prompt: string };

/** Seat model consumed by the turn host (provider/model/thinking). */
export type RoleTurnModelConfig = {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string;
};

/** One main-session turn request over the host-neutral execution seam. */
export type RoleTurnRequest = {
  readonly principal: DurablePrincipal;
  readonly activation: RoleTurnActivation;
  readonly methods: readonly MethodBinding[];
  readonly continuation: RoleTurnContinuation;
  readonly model?: RoleTurnModelConfig;
  readonly engine?: string;
  readonly cwd: string;
  readonly home: string;
  readonly agentDir: string;
  readonly runDirectory: string;
  readonly correlationId?: string;
  readonly timeoutMs?: number;
};

/** Turn result — only fields upper layers currently consume. */
export type RoleTurnResult = {
  readonly code: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly knownFailure?: RoleTurnKnownFailure;
};

/** Host-neutral session custom-entry appender (Pi adapter provides the concrete codec). */
export type SessionCustomEntryAppender = (
  authority: DurablePrincipalAuthority,
  principal: DurablePrincipal,
  customType: string,
  data: unknown,
) => Promise<void>;

/** Host-neutral main-session execution seam (S1b-2 / #526). */
export interface RoleTurnHost {
  executeTurn(request: RoleTurnRequest): Promise<RoleTurnResult>;
}

export type DurablePrincipalCoordinates = {
  readonly sessionDirectory: string;
  readonly sessionFile: string;
};

export type NewDurablePrincipalRequest = {
  readonly cwd: string;
  readonly runId: string;
  readonly role: string;
  readonly home?: string;
};

/** Host authority for issuing, checking, and temporarily decoding durable principals. */
export interface DurablePrincipalAuthority {
  issue(request: NewDurablePrincipalRequest): DurablePrincipal;
  isAvailable(principal: DurablePrincipal): Promise<boolean>;
  decode(principal: unknown): DurablePrincipalCoordinates;
}

type HostSessionManager = { getLeafEntry(): HostSessionEntry | undefined; getLeafId(): string | null | undefined; getEntries(): Iterable<HostSessionEntry>; getSessionDir(): string; getSessionFile(): string | undefined; getHeader?(): { readonly type: string; readonly id?: string } | null; setSessionFile?(path: string): void; appendCustomEntry?(customType: string, data?: unknown): unknown; };

/** Context supplied by a host for one activation and its interceptable events. */
export type HostContext = { cwd: string; mode: string; model: { readonly provider: string } | undefined; sessionManager: HostSessionManager; signal?: AbortSignal | undefined; ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void }; transcript?(): string; abort(): void; };

export type HostToolDefinition<S extends TSchema = TSchema, D = unknown, C = HostContext> = { name: string; label: string; description: string; promptSnippet?: string; parameters: S; execute( toolCallId: string, params: Static<S>, signal: AbortSignal | undefined, update: ((result: HostToolResult<D>) => void) | undefined, context: C, ): Promise<HostToolResult<D>>; };

type BeforeAgentStartEvent = { prompt: string; systemPrompt: string; systemPromptOptions: { skills?: readonly unknown[]; contextFiles?: readonly unknown[]; appendSystemPrompt?: string } };
type InputEvent = { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; source?: string };
type ToolCallEvent = { toolName: string; toolCallId: string; input: Record<string, unknown> };
type ToolResultEvent = { toolName: string; toolCallId: string; isError: boolean; content: HostToolResult["content"]; details: unknown };
type SessionStartEvent = { reason: string };
type ProviderResponseEvent = { status?: number };
type AgentEndEvent = { messages: readonly HostEventMessage[] };
type ToolExecutionEvent = { toolName: string; toolCallId: string };
type ToolExecutionUpdateEvent = ToolExecutionEvent & { partialResult: unknown };
type ToolExecutionEndEvent = ToolExecutionEvent & { isError: boolean };

type HostEventMap = {
  before_agent_start: BeforeAgentStartEvent;
  input: InputEvent;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  session_start: SessionStartEvent;
  session_shutdown: Record<never, never>;
  after_provider_response: ProviderResponseEvent;
  agent_end: AgentEndEvent;
  agent_settled: Record<never, never>;
  tool_execution_start: ToolExecutionEvent;
  tool_execution_update: ToolExecutionUpdateEvent;
  tool_execution_end: ToolExecutionEndEvent;
};

type HostInputResult = { action: "continue" } | { action: "transform"; text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> } | { action: "handled" };
type HostEventResultMap = {
  before_agent_start: { systemPrompt?: string };
  input: HostInputResult;
  tool_call: { block?: boolean; reason?: string; terminate?: boolean };
  tool_result: { content?: HostToolResult["content"]; details?: unknown; isError?: boolean };
  session_start: void;
  session_shutdown: void;
  after_provider_response: void;
  agent_end: void;
  agent_settled: void;
  tool_execution_start: void;
  tool_execution_update: void;
  tool_execution_end: void;
};
type HostEventHandler<K extends keyof HostEventMap> = (event: HostEventMap[K], ctx: HostContext) => HostEventResultMap[K] | void | Promise<HostEventResultMap[K] | void>;
export type HostEventRegistration = { [K in keyof HostEventMap]: [event: K, handler: HostEventHandler<K>] }[keyof HostEventMap];

type HostGatekeeperSubject = { readonly kind: "worker_completion" | "judge_draft"; readonly material: string };
type HostGatekeeperNonPass = { readonly status: "bounce" | "no_receipt" } & Record<string, unknown>;
export type HostGatekeeperActions = { failInfrastructure(error: unknown, context: HostContext, toolCallId?: string): never; bindGatekeeperNonPass(toolCallId: string, result: HostGatekeeperNonPass): void };

export type HostSkillExpansionEvidence = Readonly<{
  name: string;
  location: string;
  content: string;
  userMessage: string;
}>;

/** Host capability declaration (contract verb ④). */
export type HostCapabilityDeclaration = Readonly<{
  skillExpansion(prompt: string): HostSkillExpansionEvidence | undefined;
}>;

/** The activation surface consumed by package role factories. */
export interface RoleHost {
  readonly capabilities?: HostCapabilityDeclaration;
  registerFlag(name: string, definition: { description: string; type: "boolean" | "string"; default?: boolean | string }): void;
  getFlag(name: string): boolean | string | undefined;
  registerTool<S extends TSchema, D = unknown>(tool: HostToolDefinition<S, D>): void;
  getAllTools(): Array<{ name: string; sourceInfo?: { path?: string } }>;
  setActiveTools(names: string[]): void;
  getActiveTools(): string[];
  requireGatekeeperPass?(options: { context: HostContext; subject: HostGatekeeperSubject; signal?: AbortSignal; hostActions: HostGatekeeperActions; toolCallId: string }): Promise<void>;
  on(event: "before_agent_start", handler: HostEventHandler<"before_agent_start">): void;
  on(event: "input", handler: HostEventHandler<"input">): void;
  on(event: "tool_call", handler: HostEventHandler<"tool_call">): void;
  on(event: "tool_result", handler: HostEventHandler<"tool_result">): void;
  on(event: "session_start", handler: HostEventHandler<"session_start">): void;
  on(event: "session_shutdown", handler: HostEventHandler<"session_shutdown">): void;
  on(event: "after_provider_response", handler: HostEventHandler<"after_provider_response">): void;
  on(event: "agent_end", handler: HostEventHandler<"agent_end">): void;
  on(event: "agent_settled", handler: HostEventHandler<"agent_settled">): void;
  on(event: "tool_execution_start", handler: HostEventHandler<"tool_execution_start">): void;
  on(event: "tool_execution_update", handler: HostEventHandler<"tool_execution_update">): void;
  on(event: "tool_execution_end", handler: HostEventHandler<"tool_execution_end">): void;
  getCommands?(): Array<{ name: string }>;
}

/** Institutional sub-session seats (#518 §1). */
export type InstitutionalSeat =
  | "gatekeeper"
  | "inspector"
  | "notary"
  | "auditor"
  | "evidenceChild"
  | (string & {});

/** Non-secret host-neutral seat model selection. Single truth source is RoleTurnModelConfig. */
export type HostInstitutionalModelSelection = RoleTurnModelConfig;

/** Usage statistics for institutional sub-session events and turns. */
export type HostSessionUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
};

/** Closed stream event union consumed by institutional callers (#518 §1③). */
export type HostInstitutionalSessionEvent =
  | {
      readonly type: "message_end";
      readonly role: "assistant" | "user" | string;
      readonly message?: unknown;
      readonly usage?: HostSessionUsage;
    }
  | {
      readonly type: "turn_end";
      readonly stopReason?: string;
    }
  | {
      readonly type: "tool_call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError?: boolean;
      readonly details?: unknown;
    };

/** Terminal result of an institutional assistant turn (#518 §1③). */
export type HostAssistantTurnResult = {
  readonly text: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly usage?: HostSessionUsage;
  readonly messages?: readonly unknown[];
};

/**
 * Handle to an active institutional sub-session (#518 §1②).
 * Does not leak AgentSession, ModelRuntime, or Provider objects out of the adapter.
 */
export interface HostInstitutionalSessionHandle {
  readonly sessionFile?: string;
  readonly sessionId?: string;
  prompt(text: string): Promise<HostAssistantTurnResult>;
  subscribe(listener: (event: HostInstitutionalSessionEvent) => void): () => void;
  abort(): void;
  close(): Promise<void>;
}

/** Open options for an institutional sub-session (#518 §1①). */
export type HostInstitutionalSessionOptions = {
  readonly cwd: string;
  readonly selection: HostInstitutionalModelSelection;
  readonly systemPrompt: string;
  readonly tools?: readonly HostToolDefinition[];
  readonly customTools?: readonly unknown[];
  readonly noTools?: "all" | "builtin";
  readonly toolsAllowlist?: readonly string[];
  readonly agentDir?: string;
  readonly credentialScratchParent?: string;
  readonly signal?: AbortSignal;
  readonly idleRetry?: boolean;
  readonly sessionIdentity?: {
    readonly kind: string;
    readonly subject?: string;
    readonly parent?: { getSessionFile(): string | undefined };
  };
  readonly sessionManager?: unknown;
};

/** Host-neutral institutional sub-session open seam. */
export interface InstitutionalSessionHost {
  openInstitutionalSession(
    options: HostInstitutionalSessionOptions,
  ): Promise<HostInstitutionalSessionHandle>;
}

/** Local replacement for Pi AI's convenience constructor. */
export function stringEnum<const V extends readonly string[]>(values: V, options: Record<string, unknown> = {}) {
  return Type.Union(values.map((value) => Type.Literal(value)) as [TLiteral<V[number]>, ...TLiteral<V[number]>[]], options);
}

