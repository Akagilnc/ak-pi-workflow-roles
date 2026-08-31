/**
 * 起居郎 pre-court ticket resolution — #582 / decision key
 * `diarist-resolves-ticket-llm-layer`.
 *
 * Unbound countersign: LLM typed assertion over accepted instruction only,
 * then two mechanical checks on asserted N (decimal digits verbatim in
 * instruction; live GitHub ticket exists). Verification failure is controlled
 * failure — never washed into true-unbound. Explicit admitted ticket skips.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGhApiRunner,
  projectGhIssueBody,
  type GhApiRunner,
} from "./collector-github.ts";
import {
  ENGINE_DETOUR_STAGED_PROMPT_TOKEN,
  runEngineDetourOnce,
} from "./engine-detour.ts";

/** Owner-domain method material for ticket-resolution judgment. */
export const DIARIST_RESOLVE_TICKET_METHOD_RELATIVE =
  "resources/diarist-resolve-ticket.md" as const;

const packageRootUrl = new URL("..", import.meta.url);

/** Absolute path to packaged diarist-resolve-ticket method material. */
export function resolveDiaristResolveTicketMethodPath(
  packageRoot: string = fileURLToPath(packageRootUrl),
): string {
  return join(packageRoot, DIARIST_RESOLVE_TICKET_METHOD_RELATIVE);
}

/** LLM typed assertion before mechanical verification. */
export type DiaristTicketAssertion =
  | { readonly kind: "ticket"; readonly ticketNumber: number }
  | { readonly kind: "true-unbound" };

/** Final resolution after mechanical verification (or true-unbound). */
export type DiaristTicketResolution = DiaristTicketAssertion;

export type DiaristTicketResolver = (input: {
  readonly instruction: string;
  readonly signal?: AbortSignal;
}) => Promise<DiaristTicketAssertion>;

/** Live existence check for an asserted ticket number. */
export type TicketExistenceChecker = (input: {
  readonly owner: string;
  readonly repo: string;
  readonly ticketNumber: number;
  readonly signal?: AbortSignal;
}) => Promise<boolean>;

export type DiaristTicketResolutionReason =
  | "empty-stdout"
  | "unparseable-json"
  | "not-object"
  | "assertion-missing"
  | "assertion-uninterpretable"
  | "number-not-in-instruction"
  | "ticket-missing"
  | "origin-unresolved"
  | "engine-failed";

/**
 * Honest failure of ticket resolution / mechanical verification.
 * Must settle as controlled failure — never degrade to true-unbound.
 */
export class DiaristTicketResolutionError extends Error {
  readonly code = "diarist-ticket-resolution" as const;
  readonly reason: DiaristTicketResolutionReason;
  constructor(
    reason: DiaristTicketResolutionReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DiaristTicketResolutionError";
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decision-key narrow identity check: decimal digits of N appear verbatim
 * in the accepted instruction. Not a prose/relevance gate.
 */
export function instructionContainsTicketNumber(
  instruction: string,
  ticketNumber: number,
): boolean {
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) return false;
  return instruction.includes(String(ticketNumber));
}

/**
 * Consumer-driven parse of resolver stdout.
 * Sole shapes: {assertion:"ticket",ticketNumber:N} | {assertion:"true-unbound"}.
 * No fence/substring recovery.
 */
export function parseDiaristTicketResolverStdout(
  stdout: string,
): DiaristTicketAssertion {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new DiaristTicketResolutionError(
      "empty-stdout",
      "diarist ticket resolver stdout is empty",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new DiaristTicketResolutionError(
      "unparseable-json",
      "diarist ticket resolver stdout is not JSON",
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new DiaristTicketResolutionError(
      "not-object",
      "diarist ticket resolver stdout must be one JSON object",
    );
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "assertion")) {
    throw new DiaristTicketResolutionError(
      "assertion-missing",
      "diarist ticket resolver stdout missing assertion",
    );
  }
  if (parsed.assertion === "true-unbound") {
    return { kind: "true-unbound" };
  }
  if (parsed.assertion === "ticket") {
    const raw = parsed.ticketNumber;
    if (
      typeof raw === "number" &&
      Number.isSafeInteger(raw) &&
      raw >= 1
    ) {
      return { kind: "ticket", ticketNumber: raw };
    }
  }
  throw new DiaristTicketResolutionError(
    "assertion-uninterpretable",
    "diarist ticket resolver assertion is not ticket|true-unbound with safe ticketNumber",
  );
}

/** Structured engine payload for hermes staged prompt. */
export type DiaristTicketResolverEnginePayload = {
  readonly method: string;
  readonly instruction: string;
};

export function buildDiaristTicketResolverEnginePayload(input: {
  readonly method: string;
  readonly instruction: string;
}): DiaristTicketResolverEnginePayload {
  return {
    method: input.method,
    instruction: input.instruction,
  };
}

export function serializeDiaristTicketResolverEnginePayload(
  payload: DiaristTicketResolverEnginePayload,
): string {
  return JSON.stringify(payload);
}

/**
 * Hermes built-in toolset that resolves to zero tools.
 * Resolver labor is pure JSON assertion — never a tools-capable agent surface.
 */
const HERMES_DIARIST_RESOLVER_TOOLSET = "context_engine" as const;

export type HermesDiaristTicketResolverOptions = {
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly extraArgv?: readonly string[];
  readonly packageRoot?: string;
  readonly runDetour?: typeof runEngineDetourOnce;
};

/**
 * Default cheap-engine ticket resolver via hermes (ADR 0069 detour seam).
 * Method bytes + accepted instruction only; staged via shared engine seam.
 */
export function createHermesDiaristTicketResolver(
  options: HermesDiaristTicketResolverOptions = {},
): DiaristTicketResolver {
  const executable = options.executable ?? "hermes";
  const methodPath = resolveDiaristResolveTicketMethodPath(options.packageRoot);
  if (!existsSync(methodPath)) {
    throw new Error(`diarist resolve-ticket method material missing (${methodPath})`);
  }
  const method = readFileSync(methodPath, "utf8");
  if (method.trim().length === 0) {
    throw new Error(`diarist resolve-ticket method material is empty (${methodPath})`);
  }
  const runDetour = options.runDetour ?? runEngineDetourOnce;
  return async (input) => {
    const payload = buildDiaristTicketResolverEnginePayload({
      method,
      instruction: input.instruction,
    });
    const prompt = serializeDiaristTicketResolverEnginePayload(payload);
    const argv = [
      executable,
      ...(options.extraArgv ?? []),
      "chat",
      "--query-file",
      ENGINE_DETOUR_STAGED_PROMPT_TOKEN,
      "-Q",
      "--no-restore-cwd",
      "--ignore-rules",
      "-t",
      HERMES_DIARIST_RESOLVER_TOOLSET,
    ];
    let result: Awaited<ReturnType<typeof runEngineDetourOnce>>;
    try {
      result = await runDetour({
        argv,
        stagedPrompt: prompt,
        cwd: options.cwd ?? process.cwd(),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw new DiaristTicketResolutionError(
        "engine-failed",
        "diarist ticket resolver engine failed to launch",
        { cause: error },
      );
    }
    if (result.code !== 0) {
      throw new DiaristTicketResolutionError(
        "engine-failed",
        `diarist ticket resolver engine exited ${result.code}: ${result.stderr.slice(0, 500)}`,
      );
    }
    return parseDiaristTicketResolverStdout(result.stdout);
  };
}

/** Test/scripted resolver — pure function over fixed assertion. */
export function createScriptedDiaristTicketResolver(
  script:
    | DiaristTicketAssertion
    | ((input: {
        readonly instruction: string;
      }) => DiaristTicketAssertion | Promise<DiaristTicketAssertion>),
): DiaristTicketResolver {
  return async (input) => {
    if (typeof script === "function") {
      return await script(input);
    }
    return script;
  };
}

/**
 * Production live-ticket check over shared gh issue-body projection.
 * Available issue face → exists; unavailable/invalid → missing.
 */
export function createGhTicketExistenceChecker(options?: {
  readonly runner?: GhApiRunner;
}): TicketExistenceChecker {
  const runner = options?.runner ?? createGhApiRunner();
  return async (input) => {
    const projected = await projectGhIssueBody(runner, {
      owner: input.owner,
      repo: input.repo,
      ticketNumber: input.ticketNumber,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return projected.status === "available";
  };
}

/**
 * Apply mechanical verification to an LLM ticket assertion.
 * true-unbound passes through. ticket N requires both checks.
 */
export async function verifyDiaristTicketAssertion(input: {
  readonly assertion: DiaristTicketAssertion;
  readonly instruction: string;
  readonly origin: { readonly owner: string; readonly repo: string } | undefined;
  readonly checkExistence: TicketExistenceChecker;
  readonly signal?: AbortSignal;
}): Promise<DiaristTicketResolution> {
  if (input.assertion.kind === "true-unbound") {
    return input.assertion;
  }
  const n = input.assertion.ticketNumber;
  if (!instructionContainsTicketNumber(input.instruction, n)) {
    throw new DiaristTicketResolutionError(
      "number-not-in-instruction",
      `diarist ticket assertion #${n} decimal digits do not appear in accepted instruction`,
    );
  }
  if (input.origin === undefined) {
    throw new DiaristTicketResolutionError(
      "origin-unresolved",
      `diarist ticket assertion #${n} requires a resolvable github.com origin remote for live verification`,
    );
  }
  let exists: boolean;
  try {
    exists = await input.checkExistence({
      owner: input.origin.owner,
      repo: input.origin.repo,
      ticketNumber: n,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    throw new DiaristTicketResolutionError(
      "ticket-missing",
      `diarist ticket assertion #${n} live verification failed`,
      { cause: error },
    );
  }
  if (!exists) {
    throw new DiaristTicketResolutionError(
      "ticket-missing",
      `diarist ticket assertion #${n} does not exist as a live issue on ${input.origin.owner}/${input.origin.repo}`,
    );
  }
  return input.assertion;
}

/**
 * Full unbound resolution: LLM assert → mechanical verify.
 * Caller supplies origin from project root; missing origin fails when N asserted.
 */
export async function resolveDiaristTicketFromInstruction(input: {
  readonly instruction: string;
  readonly origin: { readonly owner: string; readonly repo: string } | undefined;
  readonly resolver: DiaristTicketResolver;
  readonly checkExistence: TicketExistenceChecker;
  readonly signal?: AbortSignal;
}): Promise<DiaristTicketResolution> {
  const assertion = await input.resolver({
    instruction: input.instruction,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return verifyDiaristTicketAssertion({
    assertion,
    instruction: input.instruction,
    origin: input.origin,
    checkExistence: input.checkExistence,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
