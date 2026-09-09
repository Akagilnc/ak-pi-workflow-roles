import type { RoleTurnKnownFailure, RoleTurnRequest } from "./host-contracts.ts";
import { renderAgentStartMaterials } from "./agent-start-materials.ts";

/** The shared envelope, prepared before session/new (systemPrompt delivery) and
 * able to observe the host's real builtin tool surface once it arrives post-session. */
export type PreparedRoleTurn = Readonly<{
  mcpServers: readonly Readonly<Record<string, unknown>>[];
  /**
   * Structured system-prompt authority. `body` is the provider-facing prompt
   * bytes; `materials` are typed agent-start reading materials (e.g. Notary
   * session bound) that the adapter folds into the override at the provider
   * boundary. This structure is the authoritative production input of the
   * send path — never a test-only parallel face.
   */
  systemPrompt: { readonly body: string; readonly materials: readonly unknown[] };
  /** Effective user prompt after host-side input transform (canonical Skill invocation). */
  prompt: string;
  /**
   * Host abort signal armed only by typed infrastructure failure (envelope
   * rememberInfrastructureFailure / non-correctable MCP catch). Lawful
   * context.abort() (seal / non-sole) does not arm it. executeTurn races
   * session/prompt against this so infra declarations terminate even when
   * ACP never resolves (#593).
   */
  abortSignal?: AbortSignal;
  /** Shared ledger consumes the complete ACP round after session/prompt resolves. */
  closeRound(): Promise<
    | { readonly accepted: true }
    | {
      readonly accepted: false;
      /** Shared envelope provides officer/correctable text; adapters only deliver it (#813). */
      readonly retry: {
        readonly code: string;
        readonly toolCallIds: readonly string[];
        readonly message: string;
      };
    }
    | { readonly accepted: false; readonly failure: RoleTurnKnownFailure }
  >;
  dispose?(): Promise<void>;
  /**
   * Headless CLI family (#645): role terminating-tool schema for host-native
   * `--json-schema`. Present for every prepared turn; ACP ignores it.
   */
  jsonSchema: Readonly<Record<string, unknown>>;
  /** Terminating tool name whose schema is `jsonSchema`. */
  terminatingToolName: string;
  /**
   * Headless CLI family: feed host-native `structured_output` through the same
   * terminating-tool path the MCP relay uses (ledger + gates). ACP ignores it.
   */
  ingestStructuredOutput(params: unknown): Promise<void>;
}>;

/** Fold structured system-prompt authority into the provider-visible ACP override. */
export function renderSystemPromptOverride(authority: {
  readonly body: string;
  readonly materials: readonly unknown[];
}): string {
  return renderAgentStartMaterials(authority.body, authority.materials);
}

export type SessionIdentityAuthority = Readonly<{
  load(principal: RoleTurnRequest["principal"]): Promise<string | undefined>;
  bind(principal: RoleTurnRequest["principal"], sessionId: string): Promise<void>;
  /** Durable principal session path for layout ownership / isAvailable — not a rebuild source (#617 DK-4). */
  resolveSessionFile(principal: RoleTurnRequest["principal"]): string;
}>;
