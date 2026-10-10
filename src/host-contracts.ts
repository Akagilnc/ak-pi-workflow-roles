import type { Static, TSchema } from "typebox";

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

/**
 * Controlled post-admission failure classes (ADR 0052 / #107). Owner = host contract.
 * Closed set of typed facts only — never a fabricated "could not classify" label (#881).
 * When no typed confirmation exists, omit cause and keep the original diagnostic / error pointer.
 */
export const CONTROLLED_FAILURE_CAUSES = [
  "activation", "provider", "session", "output", "timeout",
] as const;
export type ControlledFailureCause = (typeof CONTROLLED_FAILURE_CAUSES)[number];

/** Production-owned typed failure carried on a resolved turn result. */
export type RoleTurnKnownFailure = {
  /** Present only when a typed fact confirms the class; omitted when unknown (#881). */
  readonly cause?: ControlledFailureCause;
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

/** Required machine-installed method Skill (zero/one/many). */
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
    }
  | {
      readonly role: "fixer";
      readonly phase: string;
    }
  | {
      readonly role: "reviewer";
      readonly baseRevision: string;
      readonly lens: "completeness" | "correctness";
      readonly authorityRefs: readonly string[];
      readonly ticketNumber?: number;
    }
  | { readonly role: "merger"; readonly inputPath: string }
  | {
      readonly role: "collector";
      readonly repo: string;
      /** Bound PR when known at admission; omit when role will bind from materials. */
      readonly pr?: string;
      readonly requestManifestPath?: string;
      /** Wait-window ms as decimal string (#678 D4); omit → package default 10 minutes. */
      readonly waitMs?: string;
    }
  | { readonly role: "doctor"; readonly casePath: string }
  | {
      readonly role: "notary";
      readonly sourceRun: string;
      /** Ticket from source-run admitted form rides activation → flag → role read surface (#635). */
      readonly ticketNumber?: number;
    }
  | {
      readonly role: "countersign";
      /** Admitted ticket on activation/admission/invocation (diarist; no private role flag). */
      readonly ticketNumber?: number;
    }
  | {
      readonly role: "gleaner-left";
      /** Required comparison-base revision for the unanchored merge-candidate diff. */
      readonly baseRevision: string;
    }
  | { readonly role: "inspector"; readonly sourceRun?: string }
  | { readonly role: "gatekeeper" }
  | { readonly role: "navigator" }
  | { readonly role: "auditor" }
  | { readonly role: "diarist" }
  | { readonly role: "secretariat" };

export type RoleTurnContinuation =
  | { readonly kind: "initial"; readonly prompt: string }
  | {
      readonly kind: "resume";
      readonly prompt: string;
      /**
       * Stored native host session/thread id for a public explicit resume.
       * Absent on in-call auto-resume and in-gate retries; those still load
       * through the host adapter. Never the package run id.
       */
      readonly hostSessionId?: string;
    };

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
  /** Labor-engine model id from the live seat table (#883); opaque pass-through. */
  readonly engineModel?: string;
  readonly cwd: string;
  readonly home: string;
  readonly agentDir: string;
  readonly runDirectory: string;
  readonly correlationId?: string;
  readonly timeoutMs?: number;
  /**
   * Parent cancellation for a nested activation (role-inside-role public summons,
   * #675). The host terminates its child when this aborts; a public CLI process
   * has no parent to observe and leaves it absent.
   */
  readonly signal?: AbortSignal;
  /**
   * Court-turn attempt (#637 / #833): sole-final per attempt. Open court, summons,
   * and resume-with-message set this; bare resume without an open court omits it.
   */
  readonly courtAttemptId?: string;
  /**
   * Public-invocation scope (#537): one ak-role call. Auto-resume reuses it;
   * explicit resume mints a new one. Owned by this shared Host envelope — not
   * courtAttemptId and not a detour sidecar file.
   */
  readonly invocationScopeId?: string;
  /**
   * Selected host axis for this turn (#537 / ADR 0082). Projected from the
   * public-entry seat resolution — never re-read from invocation.json by tools.
   */
  readonly host?: string;
  /** Station child role run (#840): omit automatic navigator attendance. */
  readonly stationChild?: boolean;
  /**
   * #1160 attendance auto-prepare: host mounts native structured schema so
   * byStatus returns as structured fields. Direct `ak-role navigator` omits
   * this and keeps the free-form prose exit (#959).
   */
  readonly navigatorByStatusPrepare?: boolean;
  /**
   * #1132: the effective delivery-request ceiling resolved once by the caller
   * from the single configured `autoResumeLimit` value and projected here, so
   * the AK execution seam and the host adapter's own re-ask loop share one
   * number. Absent = package default. Never re-read from disk downstream.
   */
  readonly deliveryRequestLimit?: number;
};

/** Turn result — only fields upper layers currently consume. */
export type RoleTurnResult = {
  /**
   * The child's exit code, or null when it was killed by a signal — Node's
   * native close contract. A null code is a non-normal exit, never a success.
   */
  readonly code: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  /**
   * The signal that killed the child, when one did. Carried so a signal death
   * reports the real cause instead of settling as a successful no_receipt.
   */
  readonly signal?: string;
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
  /**
   * Host-owned seal of already-placed coordinates into a durable principal wire
   * object. Public layers must not forge opaque principal shapes (#636).
   */
  seal(coordinates: DurablePrincipalCoordinates): DurablePrincipal;
  decode(principal: unknown): DurablePrincipalCoordinates;
}

type HostSessionManager = { getLeafEntry(): HostSessionEntry | undefined; getLeafId(): string | null | undefined; getEntries(): Iterable<HostSessionEntry>; getSessionDir(): string; getSessionFile(): string | undefined; getHeader?(): { readonly type: string; readonly id?: string } | null; setSessionFile?(path: string): void; appendCustomEntry?(customType: string, data?: unknown): unknown; };

/** Context supplied by a host for one activation and its interceptable events. */
export type HostContext = { cwd: string; mode: string; model: { readonly provider: string } | undefined; sessionManager: HostSessionManager; /** Per-turn admitted run directory (#879); never process-global env. */ runDirectory?: string; /** Per-turn court attempt (#879); never process-global env. */ courtAttemptId?: string; /** Public-invocation scope (#537); never process-global env. */ invocationScopeId?: string; /** Selected host axis (#537 / ADR 0082); never process-global env invent. */ host?: string; /** #1199 bytes actually sent to the seat this turn (progress instruction); input-seam / in-process only — never env/argv body. */ summonsInstruction?: string; signal?: AbortSignal | undefined; ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void }; transcript?(): string; abort(): void; };

/** Per-turn run directory; adapters must project any child-process identity. */
export function runDirectoryFromHostContext(context: HostContext): string | undefined {
  return typeof context.runDirectory === "string" && context.runDirectory.trim() !== ""
    ? context.runDirectory
    : undefined;
}

/** Per-turn court attempt; absence never inherits ambient process identity. */
export function courtAttemptIdFromHostContext(context: HostContext): string | undefined {
  return typeof context.courtAttemptId === "string" && context.courtAttemptId.trim() !== ""
    ? context.courtAttemptId
    : undefined;
}

export type HostToolDefinition<S extends TSchema = TSchema, D = unknown, C = HostContext> = { name: string; label: string; description: string; promptSnippet?: string; parameters: S; execute( toolCallId: string, params: Static<S>, signal: AbortSignal | undefined, update: ((result: HostToolResult<D>) => void) | undefined, context: C, ): Promise<HostToolResult<D>>; };

type BeforeAgentStartEvent = { prompt: string; systemPrompt: string; systemPromptOptions: { skills?: readonly unknown[]; contextFiles?: readonly unknown[]; appendSystemPrompt?: string } };
type InputEvent = { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; source?: string };
type ToolCallEvent = { toolName: string; toolCallId: string; input: Record<string, unknown> };
type ToolResultEvent = { toolName: string; toolCallId: string; isError: boolean; content: HostToolResult["content"]; details: unknown };
type SessionStartEvent = { reason: string };
type AgentEndEvent = { messages: readonly HostEventMessage[] };
/** Typed closure of exactly one assistant turn; calls come from the host event, not transcript inspection. */
type TurnEndEvent = { readonly turnIndex: number; readonly calls: readonly ToolExecutionEvent[] };
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
  agent_end: AgentEndEvent;
  turn_end: TurnEndEvent;
  agent_settled: Record<never, never>;
  tool_execution_start: ToolExecutionEvent;
  tool_execution_update: ToolExecutionUpdateEvent;
  tool_execution_end: ToolExecutionEndEvent;
};

type HostInputResult = { action: "continue" } | { action: "transform"; text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> } | { action: "handled" };
type HostEventResultMap = {
  /**
   * systemPrompt — model-facing prompt body (presentation bytes).
   * readingMaterial — optional typed material for the same agent-start turn.
   * Host adapters fold readingMaterial into the provider-visible system prompt
   * at the send boundary; it is not a test-only parallel face.
   */
  before_agent_start: { systemPrompt?: string; readingMaterial?: unknown };
  input: HostInputResult;
  tool_call: { block?: boolean; reason?: string; terminate?: boolean };
  tool_result: { content?: HostToolResult["content"]; details?: unknown; isError?: boolean };
  session_start: void;
  session_shutdown: void;
  agent_end: void;
  turn_end: void;
  agent_settled: void;
  tool_execution_start: void;
  tool_execution_update: void;
  tool_execution_end: void;
};
type HostEventHandler<K extends keyof HostEventMap> = (event: HostEventMap[K], ctx: HostContext) => HostEventResultMap[K] | void | Promise<HostEventResultMap[K] | void>;
export type HostEventRegistration = { [K in keyof HostEventMap]: [event: K, handler: HostEventHandler<K>] }[keyof HostEventMap];

/** Host actions shared by worker / engine seams that may still fail infrastructure. */
export type HostGatekeeperActions = {
  failInfrastructure(error: unknown, context: HostContext, toolCallId?: string): never;
};

/** Host-owned effects used by the shared activation envelope. */
export interface RoleEnvelopeHost {
  readonly host: RoleHost;
  appendEntry(customType: string, data?: unknown): void;
  sendMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }, options: { triggerTurn: boolean; deliverAs?: "followUp" }): void | Promise<void>;
  startKeepalive(context: HostContext): void;
  stopKeepalive(): void;
}

/** The activation surface consumed by package role factories. */
export interface RoleHost {
  /** Deliver a typed correctable rejection into the current durable session's model context. */
  deliverSubmissionRejection?(rejection: { readonly kind: "correctable-rejection"; readonly code: string; readonly toolCallIds: readonly string[] }): void | Promise<void>;
  registerFlag(name: string, definition:
    | { description: string; type: "boolean"; default?: boolean }
    | { description: string; type: "string"; default?: string }): void;
  getFlag(name: string): boolean | string | undefined;
  registerTool<S extends TSchema, D = unknown>(tool: HostToolDefinition<S, D>): void;
  getAllTools(): Array<{ name: string; sourceInfo?: { path?: string } }>;
  setActiveTools(names: string[]): void;
  getActiveTools(): string[];
  on(event: "before_agent_start", handler: HostEventHandler<"before_agent_start">): void;
  on(event: "input", handler: HostEventHandler<"input">): void;
  on(event: "tool_call", handler: HostEventHandler<"tool_call">): void;
  on(event: "tool_result", handler: HostEventHandler<"tool_result">): void;
  on(event: "session_start", handler: HostEventHandler<"session_start">): void;
  on(event: "session_shutdown", handler: HostEventHandler<"session_shutdown">): void;
  on(event: "agent_end", handler: HostEventHandler<"agent_end">): void;
  on(event: "turn_end", handler: HostEventHandler<"turn_end">): void;
  on(event: "agent_settled", handler: HostEventHandler<"agent_settled">): void;
  on(event: "tool_execution_start", handler: HostEventHandler<"tool_execution_start">): void;
  on(event: "tool_execution_update", handler: HostEventHandler<"tool_execution_update">): void;
  on(event: "tool_execution_end", handler: HostEventHandler<"tool_execution_end">): void;
  getCommands?(): Array<{ name: string }>;
}

/** Non-secret host-neutral seat model selection. Single truth source is RoleTurnModelConfig. */
export type HostInstitutionalModelSelection = RoleTurnModelConfig;
