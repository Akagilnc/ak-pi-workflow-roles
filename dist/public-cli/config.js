/**
 * Persistent and effective per-seat model/thinking configuration for ak-role.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertLegalEngineName } from "../package-resources/engine-material.js";
import { AUTOMATIC_CONFIGURABLE_SEATS, PUBLIC_CALLABLE_ROLES, PUBLIC_CONFIGURABLE_SEATS, isAutomaticConfigurableSeat, isPublicCallableRole, isPublicConfigurableSeat, publicStartupCandidates, } from "./registry.js";
/** Province officers that may carry a persistent model override (#453). */
export const MENXIA_OFFICER_SEATS = [
    "gatekeeper",
    "inspector",
    "notary",
];
export function isMenxiaOfficerSeat(value) {
    return MENXIA_OFFICER_SEATS.includes(value);
}
const THINKING_LEVELS = new Set([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
export function publicCliConfigPath(home = homedir()) {
    return join(home, ".ak-roles", "public-cli.json");
}
export async function loadPublicCliConfig(home = homedir()) {
    const path = publicCliConfigPath(home);
    try {
        const raw = await readFile(path, "utf8");
        return parsePublicCliConfig(JSON.parse(raw));
    }
    catch (error) {
        if (error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT") {
            return { seats: {} };
        }
        throw error;
    }
}
export async function savePublicCliConfig(config, home = homedir()) {
    const path = publicCliConfigPath(home);
    await mkdir(dirname(path), { recursive: true });
    const normalized = parsePublicCliConfig(config);
    await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}
export function setPersistentSeatConfig(config, seat, selection) {
    const previous = config.seats[seat];
    return {
        // Spread preserves sibling top-level keys such as autoResumeLimit (#422):
        // a seat write must never silently drop them.
        ...config,
        seats: {
            ...config.seats,
            [seat]: {
                ...selection,
                // Model rewrite preserves a previously configured engine axis.
                ...(previous?.engine === undefined ? {} : { engine: previous.engine }),
            },
        },
    };
}
/**
 * Clear a seat's persistent model override only (#453).
 * Engine axis is independent: when present it remains as an engine-only residual
 * so direct callable activation keeps its labor engine while model resolution
 * returns to startup / province inheritance. Model-less residual with no engine
 * drops the row. Already-absent seats are a no-op.
 */
export function clearPersistentSeatConfig(config, seat) {
    const previous = config.seats[seat];
    if (previous === undefined)
        return config;
    if (previous.engine === undefined) {
        const { [seat]: _dropped, ...seats } = config.seats;
        return { ...config, seats };
    }
    return {
        ...config,
        seats: {
            ...config.seats,
            [seat]: { engine: previous.engine },
        },
    };
}
/**
 * Province-only model selection (#453): officer persistent > gatekeeper persistent
 * > unset (caller inherits parent session). Never consults startup candidates —
 * direct `ak-role notary` keeps resolveEffectiveSeat; only province reads this.
 * Engine-only residual is not a model override.
 */
export function resolveMenxiaOfficerModelSelection(config, officer) {
    const ownModel = seatModelOnly(config.seats[officer]);
    if (ownModel !== undefined)
        return ownModel;
    if (officer === "gatekeeper")
        return undefined;
    return seatModelOnly(config.seats.gatekeeper);
}
/**
 * Seats that own the labor-engine axis (#391: PUBLIC_CALLABLE_ROLES only).
 * Navigator is configurable for model but has no independent activation path.
 */
export function isEngineAxisSeat(seat) {
    return isPublicCallableRole(seat);
}
/**
 * Set or clear persistent engine on a callable role seat (#356 / #378 / #391).
 * Engine-only seats are rejected — provider/model[:thinking] remains required first.
 * Seat type is PublicCallableRole (navigator excluded at the type boundary).
 */
export function setPersistentSeatEngine(config, seat, engine) {
    const previous = config.seats[seat];
    if (previous === undefined) {
        throw new Error(`config seat ${seat} has no persistent model; set provider/model[:thinking] before engine`);
    }
    if (engine === undefined) {
        const { engine: _dropped, ...modelOnly } = previous;
        // Engine-only residual with engine cleared → drop the empty row.
        if (seatModelOnly(modelOnly) === undefined) {
            const { [seat]: _row, ...seats } = config.seats;
            return { ...config, seats };
        }
        return {
            ...config,
            seats: {
                ...config.seats,
                [seat]: modelOnly,
            },
        };
    }
    // Engine-name path-safety syntax is owned solely by assertLegalEngineName
    // (call-request + config-parse seams). Setter is pure seat mutation.
    return {
        ...config,
        seats: {
            ...config.seats,
            [seat]: { ...previous, engine },
        },
    };
}
/**
 * #422 value domain authority for the auto-resume ceiling: non-negative integer,
 * no package-local upper bound (ADR 0035). `0` is legal and means auto-resume is
 * disabled (a single dispatch, no in-place retry). Negative numbers, fractions,
 * NaN, Infinity and non-number types are rejected loudly — never silently coerced.
 */
export function parseAutoResumeLimit(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(`auto-resume limit must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
    return value;
}
/**
 * #422: set the persistent autoResumeLimit top-level key. Pure mutation that
 * preserves all sibling keys (seats included).
 */
export function setAutoResumeLimit(config, limit) {
    return { ...config, autoResumeLimit: parseAutoResumeLimit(limit) };
}
/**
 * Strip optional engine so activation model argv never sees the engine axis.
 * Engine-only residual (model cleared) yields undefined — not a model override.
 */
export function seatModelOnly(seat) {
    if (seat?.provider === undefined || seat.model === undefined)
        return undefined;
    return seat.thinking === undefined
        ? { provider: seat.provider, model: seat.model }
        : { provider: seat.provider, model: seat.model, thinking: seat.thinking };
}
/**
 * Config-parse seam: engine axis is PUBLIC_CALLABLE_ROLES; engine names need only
 * path-safety syntax (no closed material catalog; #376 / #378 / #391 / ADR 0069).
 * Disk-handwritten navigator.engine is rejected (no independent activation → silent
 * ineffective would violate failure honesty). Call after load / before dispatch (#356).
 * Syntax authority = assertLegalEngineName (no injected duplicate).
 */
export function validatePublicCliConfigEngines(config, _packageRoot) {
    for (const seat of Object.keys(config.seats)) {
        const row = config.seats[seat];
        if (row?.engine === undefined)
            continue;
        if (!isEngineAxisSeat(seat)) {
            throw new Error(`config seat ${seat} cannot persist engine: no independent activation path; storing would be silently ineffective`);
        }
        try {
            assertLegalEngineName(row.engine);
        }
        catch (error) {
            throw new Error(`config seat ${seat} engine is illegal: ${row.engine}`, { cause: error });
        }
    }
}
export function parseModelSpec(spec, fallbackThinking) {
    const trimmed = spec.trim();
    if (!trimmed) {
        throw new Error("model specification must be non-empty");
    }
    const thinkingSplit = trimmed.lastIndexOf(":");
    let modelPart = trimmed;
    let thinking = fallbackThinking;
    // #346: no colon → bare provider/model is legal. Colon present (any index,
    // including 0) → suffix must be a typed PublicThinkingLevel (empty/unknown
    // stay format rejects; never swallow ":…" into the model name).
    if (thinkingSplit !== -1) {
        const maybeThinking = trimmed.slice(thinkingSplit + 1);
        if (!THINKING_LEVELS.has(maybeThinking)) {
            throw new Error(`model specification must be provider/model[:thinking], got ${spec}`);
        }
        thinking = maybeThinking;
        modelPart = trimmed.slice(0, thinkingSplit);
    }
    const slash = modelPart.indexOf("/");
    if (slash <= 0 || slash === modelPart.length - 1) {
        throw new Error(`model specification must be provider/model[:thinking], got ${spec}`);
    }
    const provider = modelPart.slice(0, slash);
    const model = modelPart.slice(slash + 1);
    // #346/#384: bare provider/model is legal — do not invent thinking.
    return thinking === undefined
        ? { provider, model }
        : { provider, model, thinking };
}
export function formatModelSpec(selection) {
    const base = `${selection.provider}/${selection.model}`;
    return selection.thinking === undefined ? base : `${base}:${selection.thinking}`;
}
/**
 * Single source: seat model selection → Pi argv at the public CLI execution seam.
 * Bare provider/model omits --thinking so pi/model defaults apply; suffix passes through.
 */
export function buildSeatModelCliArgs(model) {
    if (model === undefined)
        return [];
    return [
        "--provider",
        model.provider,
        "--model",
        model.model,
        ...(model.thinking === undefined ? [] : ["--thinking", model.thinking]),
    ];
}
function parsePublicCliConfig(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("public CLI config must be an object");
    }
    const record = value;
    // #422 round-trip preservation: the sibling top-level key must survive every
    // parse→save cycle; an unknown-key drop would silently erase it on any write.
    let autoResumeLimit;
    if (record.autoResumeLimit !== undefined) {
        autoResumeLimit = parseAutoResumeLimit(record.autoResumeLimit);
    }
    if (record.seats === undefined) {
        return {
            seats: {},
            ...(autoResumeLimit === undefined ? {} : { autoResumeLimit }),
        };
    }
    if (record.seats === null ||
        typeof record.seats !== "object" ||
        Array.isArray(record.seats)) {
        throw new Error("public CLI config.seats must be an object");
    }
    const seats = {};
    for (const [key, raw] of Object.entries(record.seats)) {
        if (!PUBLIC_CONFIGURABLE_SEATS.includes(key)) {
            throw new Error(`unknown configurable seat in config: ${key}`);
        }
        seats[key] = parseSeatModelConfig(raw, key);
    }
    return {
        seats,
        ...(autoResumeLimit === undefined ? {} : { autoResumeLimit }),
    };
}
function parseSeatModelConfig(value, seat) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`config seat ${seat} must be an object`);
    }
    const raw = value;
    const hasProvider = raw.provider !== undefined;
    const hasModel = raw.model !== undefined;
    if (hasProvider !== hasModel) {
        throw new Error(`config seat ${seat} requires both provider and model`);
    }
    if (raw.engine !== undefined && typeof raw.engine !== "string") {
        // Shape only: engine must be a string field. Path-safety syntax is deferred to
        // validatePublicCliConfigEngines → assertLegalEngineName (single authority).
        throw new Error(`config seat ${seat} engine must be a string`);
    }
    // #453: engine-only residual is legal after model clear (independent axes).
    if (!hasProvider && raw.engine === undefined) {
        throw new Error(`config seat ${seat} requires provider/model or engine`);
    }
    if (hasProvider) {
        if (typeof raw.provider !== "string" || raw.provider.trim() === "") {
            throw new Error(`config seat ${seat} requires provider`);
        }
        if (typeof raw.model !== "string" || raw.model.trim() === "") {
            throw new Error(`config seat ${seat} requires model`);
        }
    }
    // #384: thinking is optional on persistent seats; when present it must be typed.
    // Thinking without model is meaningless and rejected.
    if (raw.thinking !== undefined) {
        if (!hasProvider) {
            throw new Error(`config seat ${seat} thinking requires provider/model`);
        }
        if (typeof raw.thinking !== "string" ||
            !THINKING_LEVELS.has(raw.thinking)) {
            throw new Error(`config seat ${seat} requires a valid thinking level`);
        }
    }
    const parsed = {
        ...(hasProvider
            ? {
                provider: raw.provider,
                model: raw.model,
                ...(raw.thinking === undefined
                    ? {}
                    : { thinking: raw.thinking }),
            }
            : {}),
        ...(raw.engine === undefined ? {} : { engine: raw.engine }),
    };
    return parsed;
}
export function providerConfigured(credentials, provider) {
    if (provider === "openai-codex")
        return credentials["openai-codex"] === true;
    if (provider === "xai")
        return credentials.xai === true;
    return false;
}
/**
 * Typed provider-credential absence for the public seat providers ak-role owns.
 * Presence is read from auth.json shape (CredentialProviders), never from stderr prose.
 * Returns undefined for unknown/custom providers (not this package's credential map).
 */
export function missingPublicProviderCredential(provider, credentials) {
    if (provider !== "openai-codex" && provider !== "xai")
        return false;
    return !providerConfigured(credentials, provider);
}
function pickStartupCandidate(seat, credentials) {
    for (const candidate of publicStartupCandidates(seat)) {
        if (providerConfigured(credentials, candidate.provider)) {
            return { ...candidate };
        }
    }
    return undefined;
}
function attachEngineAxis(seat, config, invocation) {
    // #391: engine axis is PUBLIC_CALLABLE_ROLES only (single isEngineAxisSeat predicate).
    if (!isEngineAxisSeat(seat.seat)) {
        return {
            ...seat,
            engineSource: "unconfigured",
        };
    }
    const persistentEngine = config.seats[seat.seat]?.engine;
    if (invocation?.engine !== undefined) {
        return {
            ...seat,
            engine: invocation.engine,
            engineSource: "invocation",
        };
    }
    if (persistentEngine !== undefined) {
        return {
            ...seat,
            engine: persistentEngine,
            engineSource: "persistent",
        };
    }
    return {
        ...seat,
        engineSource: "unconfigured",
    };
}
function resolveBaseSeat(config, seat, credentials) {
    const automatic = isAutomaticConfigurableSeat(seat);
    // Engine-only residual is not a persistent model source (#453).
    const persistentModel = seatModelOnly(config.seats[seat]);
    if (persistentModel !== undefined) {
        return {
            seat,
            automatic,
            source: "persistent",
            selection: persistentModel,
            engineSource: "unconfigured",
        };
    }
    const startup = pickStartupCandidate(seat, credentials);
    if (startup !== undefined) {
        return {
            seat,
            automatic,
            source: "startup",
            selection: startup,
            engineSource: "unconfigured",
        };
    }
    return { seat, automatic, source: "unconfigured", engineSource: "unconfigured" };
}
export function resolveEffectiveSeat(config, seat, credentials, invocation) {
    const automatic = isAutomaticConfigurableSeat(seat);
    const hasModelInvocation = invocation !== undefined &&
        (invocation.model !== undefined || invocation.thinking !== undefined);
    let modelSeat;
    if (!hasModelInvocation || invocation === undefined) {
        modelSeat = resolveBaseSeat(config, seat, credentials);
    }
    else if (invocation.model !== undefined) {
        const spec = invocation.model.includes(":") || invocation.thinking === undefined
            ? invocation.model
            : `${invocation.model}:${invocation.thinking}`;
        modelSeat = {
            seat,
            automatic,
            source: "invocation",
            selection: parseModelSpec(spec),
            engineSource: "unconfigured",
        };
    }
    else {
        const base = resolveBaseSeat(config, seat, credentials);
        if (base.selection === undefined || invocation.thinking === undefined) {
            modelSeat = {
                seat,
                automatic,
                source: "unconfigured",
                engineSource: "unconfigured",
            };
        }
        else {
            modelSeat = {
                seat,
                automatic,
                source: "invocation",
                selection: { ...base.selection, thinking: invocation.thinking },
                engineSource: "unconfigured",
            };
        }
    }
    return attachEngineAxis(modelSeat, config, invocation);
}
export function effectiveSeatConfigurations(config, credentials, invocation) {
    return PUBLIC_CONFIGURABLE_SEATS.map((seat) => resolveEffectiveSeat(config, seat, credentials, invocation));
}
/** Callable roles first (package order), then automatic configurable seats. */
export function listRolesForDisplay(config, credentials, invocation) {
    const all = effectiveSeatConfigurations(config, credentials, invocation);
    const callable = PUBLIC_CALLABLE_ROLES.map((role) => all.find((entry) => entry.seat === role));
    const automatic = AUTOMATIC_CONFIGURABLE_SEATS.map((seat) => all.find((entry) => entry.seat === seat));
    return [...callable, ...automatic];
}
/**
 * Read configured credential presence from a Pi auth.json document.
 * Only presence of a provider key matters for startup selection (#11).
 */
export function credentialProvidersFromAuthData(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return { "openai-codex": false, xai: false };
    }
    const record = data;
    return {
        "openai-codex": Object.prototype.hasOwnProperty.call(record, "openai-codex"),
        xai: Object.prototype.hasOwnProperty.call(record, "xai"),
    };
}
export async function loadCredentialProviders(agentDir) {
    try {
        const raw = await readFile(join(agentDir, "auth.json"), "utf8");
        return credentialProvidersFromAuthData(JSON.parse(raw));
    }
    catch (error) {
        if (error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT") {
            return { "openai-codex": false, xai: false };
        }
        throw error;
    }
}
