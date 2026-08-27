/**
 * Typed public CLI registry — sole source for discoverable commands, seats,
 * and startup model candidates (ADR 0052 / #105).
 */
import { PACKAGED_ROLE_REGISTRY, } from "../packaged-role-registry.js";
/** Package-relative path of the Internal role entrypoint (explicit load only). */
export const INTERNAL_ROLE_ENTRYPOINT_RELATIVE = "extensions/role-runtime.ts";
export const PUBLIC_CALLABLE_ROLES = PACKAGED_ROLE_REGISTRY.map((entry) => entry.role);
/** Automatic attendance seat — configurable, never a caller-selected command. */
export const AUTOMATIC_NAVIGATOR_SEAT = "navigator";
/** Automatic gate seats — configurable model only; never caller commands (#453). */
export const AUTOMATIC_GATEKEEPER_SEAT = "gatekeeper";
export const AUTOMATIC_INSPECTOR_SEAT = "inspector";
/** All automatic configurable seats (no independent public activation command). */
export const AUTOMATIC_CONFIGURABLE_SEATS = [
    AUTOMATIC_GATEKEEPER_SEAT,
    AUTOMATIC_INSPECTOR_SEAT,
    AUTOMATIC_NAVIGATOR_SEAT,
];
export const PUBLIC_CONFIGURABLE_SEATS = [
    ...PUBLIC_CALLABLE_ROLES,
    ...AUTOMATIC_CONFIGURABLE_SEATS,
];
export function isAutomaticConfigurableSeat(value) {
    return AUTOMATIC_CONFIGURABLE_SEATS.includes(value);
}
export const PUBLIC_CLI_SUPPORT_COMMANDS = [
    "roles",
    "config",
    "help",
    "resume",
];
/**
 * Package startup candidates (#11): Codex family first, then Grok 4.5.
 * Selection among candidates is credential-driven at resolve time.
 */
const STARTUP_CANDIDATES = {
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
    notary: [
        { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
        { provider: "xai", model: "grok-4.5", thinking: "high" },
    ],
    // #453: automatic gate seats have no startup default — unset means inherit parent.
    gatekeeper: [],
    inspector: [],
    navigator: [
        { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" },
        { provider: "xai", model: "grok-4.5", thinking: "high" },
    ],
};
export function publicStartupCandidates(seat) {
    return STARTUP_CANDIDATES[seat];
}
/** Deterministic public commands — discoverable, never LLM-configurable seats. */
export const PUBLIC_DETERMINISTIC_COMMANDS = ["analyst"];
/**
 * Typed help surface. Presentation formats these facts; tests must not assert
 * exact help prose or layout (锚定宪法 / ADR 0016 / #105 AC).
 * analyst is a deterministic analysis command on the public CLI — not an LLM seat.
 */
export function listHelpCapabilities() {
    const support = PUBLIC_CLI_SUPPORT_COMMANDS.map((name) => ({
        kind: "support",
        name,
    }));
    const roles = PACKAGED_ROLE_REGISTRY.map((entry) => {
        const phases = entry.phases;
        const defaultPhase = phases.length === 1 && phases[0] === null
            ? null
            : phases.includes("apply")
                ? "apply"
                : (phases[0] ?? null);
        return {
            kind: "role",
            name: entry.role,
            phases,
            defaultPhase,
        };
    });
    const deterministic = PUBLIC_DETERMINISTIC_COMMANDS.map((name) => ({
        kind: "deterministic",
        name,
    }));
    return [...support, ...roles, ...deterministic];
}
export function isPublicCallableRole(value) {
    return PUBLIC_CALLABLE_ROLES.includes(value);
}
export function isPublicConfigurableSeat(value) {
    return PUBLIC_CONFIGURABLE_SEATS.includes(value);
}
export function isPublicCliSupportCommand(value) {
    return PUBLIC_CLI_SUPPORT_COMMANDS.includes(value);
}
