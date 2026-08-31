/**
 * 起居郎 pre-court ticket resolution (#582 / diarist-resolves-ticket-llm-layer).
 * Unbound countersign: LLM typed assertion over accepted instruction, then two
 * mechanical checks on N (complete decimal number in instruction; live GitHub issue).
 * Verification failure is controlled failure — never washed to true-unbound.
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

export const DIARIST_RESOLVE_TICKET_METHOD_RELATIVE =
  "resources/diarist-resolve-ticket.md" as const;

export type DiaristTicketAssertion =
  | { readonly kind: "ticket"; readonly ticketNumber: number }
  | { readonly kind: "true-unbound" };

export type DiaristTicketResolution = DiaristTicketAssertion;

export type DiaristTicketResolver = (input: {
  readonly instruction: string;
  readonly signal?: AbortSignal;
}) => Promise<DiaristTicketAssertion>;

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

export function resolveDiaristResolveTicketMethodPath(
  packageRoot: string = fileURLToPath(new URL("..", import.meta.url)),
): string {
  return join(packageRoot, DIARIST_RESOLVE_TICKET_METHOD_RELATIVE);
}

/**
 * Decision-key exact identity: complete decimal number N appears in instruction.
 * A longer number's digit substring (e.g. 82 inside #582) is not N.
 */
export function instructionContainsTicketNumber(
  instruction: string,
  ticketNumber: number,
): boolean {
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) return false;
  // Complete number token: not preceded or followed by another digit.
  return new RegExp(`(?<!\\d)${String(ticketNumber)}(?!\\d)`).test(instruction);
}

/** Sole stdout shapes: {assertion:"ticket",ticketNumber:N} | {assertion:"true-unbound"}. */
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DiaristTicketResolutionError(
      "not-object",
      "diarist ticket resolver stdout must be one JSON object",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "assertion")) {
    throw new DiaristTicketResolutionError(
      "assertion-missing",
      "diarist ticket resolver stdout missing assertion",
    );
  }
  if (record.assertion === "true-unbound") return { kind: "true-unbound" };
  const n = record.ticketNumber;
  if (
    record.assertion === "ticket" &&
    typeof n === "number" &&
    Number.isSafeInteger(n) &&
    n >= 1
  ) {
    return { kind: "ticket", ticketNumber: n };
  }
  throw new DiaristTicketResolutionError(
    "assertion-uninterpretable",
    "diarist ticket resolver assertion is not ticket|true-unbound with safe ticketNumber",
  );
}

const HERMES_RESOLVER_TOOLSET = "context_engine" as const;

/** Hermes resolver: method bytes + instruction only; empty toolset; staged prompt. */
export function createHermesDiaristTicketResolver(options: {
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly packageRoot?: string;
} = {}): DiaristTicketResolver {
  const methodPath = resolveDiaristResolveTicketMethodPath(options.packageRoot);
  if (!existsSync(methodPath)) {
    throw new Error(`diarist resolve-ticket method material missing (${methodPath})`);
  }
  const method = readFileSync(methodPath, "utf8");
  if (method.trim().length === 0) {
    throw new Error(`diarist resolve-ticket method material is empty (${methodPath})`);
  }
  const executable = options.executable ?? "hermes";
  return async (input) => {
    const argv = [
      executable,
      "chat",
      "--query-file",
      ENGINE_DETOUR_STAGED_PROMPT_TOKEN,
      "-Q",
      "--no-restore-cwd",
      "--ignore-rules",
      "-t",
      HERMES_RESOLVER_TOOLSET,
    ];
    let result: Awaited<ReturnType<typeof runEngineDetourOnce>>;
    try {
      result = await runEngineDetourOnce({
        argv,
        stagedPrompt: JSON.stringify({ method, instruction: input.instruction }),
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

/** Live ticket check over shared gh issue-body projection. */
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

/** Mechanical verify after LLM assertion. true-unbound passes; ticket needs both checks. */
export async function verifyDiaristTicketAssertion(input: {
  readonly assertion: DiaristTicketAssertion;
  readonly instruction: string;
  readonly origin: { readonly owner: string; readonly repo: string } | undefined;
  readonly checkExistence: TicketExistenceChecker;
  readonly signal?: AbortSignal;
}): Promise<DiaristTicketResolution> {
  if (input.assertion.kind === "true-unbound") return input.assertion;
  const n = input.assertion.ticketNumber;
  if (!instructionContainsTicketNumber(input.instruction, n)) {
    throw new DiaristTicketResolutionError(
      "number-not-in-instruction",
      `diarist ticket assertion #${n} complete decimal number does not appear in accepted instruction`,
    );
  }
  if (input.origin === undefined) {
    throw new DiaristTicketResolutionError(
      "origin-unresolved",
      `diarist ticket assertion #${n} requires a resolvable github.com origin remote`,
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
