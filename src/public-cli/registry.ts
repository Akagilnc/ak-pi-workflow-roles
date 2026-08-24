/**
 * Typed public CLI registry — sole source for discoverable commands, seats,
 * and startup model candidates (ADR 0052 / #105).
 */
import {
  PACKAGED_ROLE_REGISTRY,
  type PackagedRole,
} from "../packaged-role-registry.ts";

/** Package-relative path of the Internal role entrypoint (explicit load only). */
export const INTERNAL_ROLE_ENTRYPOINT_RELATIVE = "extensions/role-runtime.ts" as const;

export const PUBLIC_CALLABLE_ROLES = PACKAGED_ROLE_REGISTRY.map(
  (entry) => entry.role,
) as readonly PackagedRole[];

export type PublicCallableRole = (typeof PUBLIC_CALLABLE_ROLES)[number];

/** Automatic attendance seat — configurable, never a caller-selected command. */
export const AUTOMATIC_NAVIGATOR_SEAT = "navigator" as const;

export type PublicConfigurableSeat =
  | PublicCallableRole
  | typeof AUTOMATIC_NAVIGATOR_SEAT;

export const PUBLIC_CONFIGURABLE_SEATS = [
  ...PUBLIC_CALLABLE_ROLES,
  AUTOMATIC_NAVIGATOR_SEAT,
] as const satisfies readonly PublicConfigurableSeat[];

export const PUBLIC_CLI_SUPPORT_COMMANDS = [
  "roles",
  "config",
  "help",
  "resume",
] as const;

export type PublicCliSupportCommand = (typeof PUBLIC_CLI_SUPPORT_COMMANDS)[number];

export type PublicThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ModelRef = {
  provider: string;
  model: string;
  /** Absent when invocation passed bare provider/model — pi/model default applies. */
  thinking?: PublicThinkingLevel;
};

/**
 * Package startup candidates (#11): Codex family first, then Grok 4.5.
 * Selection among candidates is credential-driven at resolve time.
 */
const STARTUP_CANDIDATES: Record<PublicConfigurableSeat, readonly ModelRef[]> = {
  judge: [
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ],
  reviewer: [
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ],
  coder: [
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ],
  fixer: [
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ],
  collector: [
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ],
  doctor: [
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ],
  merger: [
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ],
  navigator: [
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ],
};

export function publicStartupCandidates(
  seat: PublicConfigurableSeat,
): readonly ModelRef[] {
  return STARTUP_CANDIDATES[seat];
}

/** Deterministic public commands — discoverable, never LLM-configurable seats. */
export const PUBLIC_DETERMINISTIC_COMMANDS = ["analyst"] as const;

export type PublicDeterministicCommand =
  (typeof PUBLIC_DETERMINISTIC_COMMANDS)[number];

export type HelpCapability =
  | {
      kind: "support";
      name: PublicCliSupportCommand;
    }
  | {
      kind: "role";
      name: PublicCallableRole;
      phases: readonly (string | null)[];
      defaultPhase: string | null;
    }
  | {
      kind: "deterministic";
      name: PublicDeterministicCommand;
    };

/**
 * Typed help surface. Presentation formats these facts; tests must not assert
 * exact help prose or layout (锚定宪法 / ADR 0016 / #105 AC).
 * analyst is a deterministic analysis command on the public CLI — not an LLM seat.
 */
export function listHelpCapabilities(): readonly HelpCapability[] {
  const support: HelpCapability[] = PUBLIC_CLI_SUPPORT_COMMANDS.map((name) => ({
    kind: "support" as const,
    name,
  }));
  const roles: HelpCapability[] = PACKAGED_ROLE_REGISTRY.map((entry) => {
    const phases = entry.phases as readonly (string | null)[];
    const defaultPhase =
      phases.length === 1 && phases[0] === null
        ? null
        : phases.includes("apply")
        ? "apply"
        : (phases[0] ?? null);
    return {
      kind: "role" as const,
      name: entry.role,
      phases,
      defaultPhase,
    };
  });
  const deterministic: HelpCapability[] = PUBLIC_DETERMINISTIC_COMMANDS.map(
    (name) => ({
      kind: "deterministic" as const,
      name,
    }),
  );
  return [...support, ...roles, ...deterministic];
}

export function isPublicCallableRole(value: string): value is PublicCallableRole {
  return (PUBLIC_CALLABLE_ROLES as readonly string[]).includes(value);
}

export function isPublicConfigurableSeat(
  value: string,
): value is PublicConfigurableSeat {
  return (PUBLIC_CONFIGURABLE_SEATS as readonly string[]).includes(value);
}

export function isPublicCliSupportCommand(
  value: string,
): value is PublicCliSupportCommand {
  return (PUBLIC_CLI_SUPPORT_COMMANDS as readonly string[]).includes(value);
}
