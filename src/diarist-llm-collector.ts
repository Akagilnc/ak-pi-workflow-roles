/**
 * 起居郎 LLM semantic collector — ADR 0075 / #582.
 * Cheap engine selects decision-related blocks from a frozen candidate set.
 * Every claimed quote must pass mechanical reverse-verify before entry.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENGINE_DETOUR_STAGED_PROMPT_TOKEN,
  runEngineDetourOnce,
} from "./engine-detour.ts";
import type { DiaristSourceBlock } from "./diarist-mechanical.ts";

/** Owner-domain method material for collector semantic judgment (ADR 0073/0075). */
export const DIARIST_COLLECT_METHOD_RELATIVE = "resources/diarist-collect.md" as const;

const packageRootUrl = new URL("..", import.meta.url);

/** Absolute path to packaged diarist-collect method material. */
export function resolveDiaristCollectMethodPath(
  packageRoot: string = fileURLToPath(packageRootUrl),
): string {
  return join(packageRoot, DIARIST_COLLECT_METHOD_RELATIVE);
}

/** One LLM-selected block reference into the candidate set. */
export type DiaristLlmSelection = {
  /** Index into the candidate array the collector received. */
  readonly candidateIndex: number;
  /** Quotes the model claims (must be verbatim in the block transcript). */
  readonly quotes: readonly string[];
  /** Optional human-facing note (theme / summary). Not a machine gate. */
  readonly note?: string;
  /** Human-face triage label — never a machine gate. */
  readonly triage?: "relevant" | "context" | "irrelevant";
};

export type DiaristLlmCollectResult = {
  readonly selections: readonly DiaristLlmSelection[];
  /** Raw engine stdout retained for diagnostics (not a gate). */
  readonly rawStdout: string;
  readonly engineArgv: readonly string[];
};

export type DiaristLlmCollector = (input: {
  readonly ticketNumber: number;
  readonly candidates: readonly DiaristSourceBlock[];
  readonly signal?: AbortSignal;
}) => Promise<DiaristLlmCollectResult>;

/** Typed cause when collector stdout cannot be consumed as the sole selections object. */
export type DiaristLlmStdoutReason =
  | "empty-stdout"
  | "unparseable-json"
  | "not-object"
  | "selections-missing"
  | "selections-wrong-type"
  | "selection-uninterpretable";

export class DiaristLlmStdoutError extends Error {
  readonly code = "diarist-llm-stdout" as const;
  readonly reason: DiaristLlmStdoutReason;
  constructor(reason: DiaristLlmStdoutReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiaristLlmStdoutError";
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Consumer-driven parse of collector stdout.
 * Sole shape: one JSON object with typed `selections` array.
 * Unknown top-level / row fields are ignored. No fence/substring recovery,
 * no blocks/index/i/quote aliases. Empty or uninterpretable input fails honestly.
 */
export function parseDiaristLlmStdout(
  stdout: string,
  candidateCount: number,
): DiaristLlmSelection[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new DiaristLlmStdoutError("empty-stdout", "diarist collector stdout is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new DiaristLlmStdoutError(
      "unparseable-json",
      "diarist collector stdout is not JSON",
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new DiaristLlmStdoutError(
      "not-object",
      "diarist collector stdout must be one JSON object",
    );
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, "selections")) {
    throw new DiaristLlmStdoutError(
      "selections-missing",
      "diarist collector stdout missing selections",
    );
  }

  if (!Array.isArray(parsed.selections)) {
    throw new DiaristLlmStdoutError(
      "selections-wrong-type",
      "diarist collector selections must be an array",
    );
  }

  const out: DiaristLlmSelection[] = [];
  for (let rowIndex = 0; rowIndex < parsed.selections.length; rowIndex += 1) {
    const row = parsed.selections[rowIndex];
    if (!isRecord(row)) {
      throw new DiaristLlmStdoutError(
        "selection-uninterpretable",
        `diarist collector selection[${rowIndex}] is not an object`,
      );
    }

    // Consume only typed fields; ignore unknown row keys.
    if (typeof row.candidateIndex !== "number" || !Number.isInteger(row.candidateIndex)) {
      throw new DiaristLlmStdoutError(
        "selection-uninterpretable",
        `diarist collector selection[${rowIndex}].candidateIndex is not an integer`,
      );
    }
    const index = row.candidateIndex;
    if (index < 0 || index >= candidateCount) {
      throw new DiaristLlmStdoutError(
        "selection-uninterpretable",
        `diarist collector selection[${rowIndex}].candidateIndex ${index} out of range 0..${candidateCount - 1}`,
      );
    }

    if (!Object.prototype.hasOwnProperty.call(row, "quotes")) {
      throw new DiaristLlmStdoutError(
        "selection-uninterpretable",
        `diarist collector selection[${rowIndex}].quotes missing`,
      );
    }
    if (!Array.isArray(row.quotes)) {
      throw new DiaristLlmStdoutError(
        "selection-uninterpretable",
        `diarist collector selection[${rowIndex}].quotes must be an array`,
      );
    }
    const quotes: string[] = [];
    for (let qIndex = 0; qIndex < row.quotes.length; qIndex += 1) {
      const q = row.quotes[qIndex];
      if (typeof q !== "string") {
        throw new DiaristLlmStdoutError(
          "selection-uninterpretable",
          `diarist collector selection[${rowIndex}].quotes[${qIndex}] is not a string`,
        );
      }
      // Empty string quotes are skipped at reverse-verify; keep non-empty only.
      if (q.length > 0) quotes.push(q);
    }

    const triage =
      row.triage === "relevant" ||
      row.triage === "context" ||
      row.triage === "irrelevant"
        ? row.triage
        : undefined;

    out.push({
      candidateIndex: index,
      quotes,
      ...(typeof row.note === "string" ? { note: row.note } : {}),
      ...(triage === undefined ? {} : { triage }),
    });
  }
  return out;
}

/** Structured engine payload for hermes -z (sole method-delivery seam). */
export type DiaristCollectorEnginePayload = {
  /**
   * Owner-domain diarist-collect method material bytes.
   * File at DIARIST_COLLECT_METHOD_RELATIVE is the sole source of truth; bytes are
   * read at call time and delivered in the same -z structured input (no coordinate-only).
   */
  readonly method: string;
  readonly ticketNumber: number;
  readonly candidates: readonly {
    readonly candidateIndex: number;
    readonly sourceKind: DiaristSourceBlock["sourceKind"];
    readonly isUserTurn: boolean;
    readonly timestamp: string;
    readonly transcript: string;
  }[];
};

/**
 * Machine kickoff payload (ADR 0073): method material bytes + frozen candidate catalog.
 * Semantic judgment lives in owner-domain method material — delivered as `method` bytes,
 * not a path coordinate. Serialized body is staged by the shared engine seam (never argv).
 */
export function buildDiaristCollectorEnginePayload(input: {
  readonly ticketNumber: number;
  readonly candidates: readonly DiaristSourceBlock[];
  readonly method: string;
}): DiaristCollectorEnginePayload {
  return {
    method: input.method,
    ticketNumber: input.ticketNumber,
    candidates: input.candidates.map((block, index) => ({
      candidateIndex: index,
      sourceKind: block.sourceKind,
      isUserTurn: block.isUserTurn,
      timestamp: block.timestamp,
      transcript: block.transcript,
    })),
  };
}

/** Serialize engine payload body for seam-owned staged prompt file delivery. */
export function serializeDiaristCollectorEnginePayload(
  payload: DiaristCollectorEnginePayload,
): string {
  return JSON.stringify(payload);
}

/**
 * Hermes built-in toolset that resolves to zero tools.
 * Collector labor is pure JSON selection — never a tools-capable agent surface.
 */
export const HERMES_DIARIST_COLLECTOR_TOOLSET = "context_engine" as const;

export type HermesDiaristCollectorOptions = {
  /** Executable name or path. Default hermes. */
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Extra argv after executable (before -z). */
  readonly extraArgv?: readonly string[];
  /** Package root for resolving diarist-collect method material. */
  readonly packageRoot?: string;
  /** Test seam: inject detour runner (default production runEngineDetourOnce). */
  readonly runDetour?: typeof runEngineDetourOnce;
};

/**
 * Default cheap-engine collector via hermes (ADR 0069 detour seam).
 * Owner-domain method material is read from the packaged file (sole source of truth)
 * and delivered as `method` bytes inside the structured JSON body. The body is staged
 * by the shared engine seam (`--query-file` path token) — never a single argv blob
 * (E2BIG / engine-dispatch). No path-only method coordinate; no env dual transport.
 * Engine failure and uninterpretable stdout throw — caller records honest diagnostic.
 */
export function createHermesDiaristCollector(
  options: HermesDiaristCollectorOptions = {},
): DiaristLlmCollector {
  const executable = options.executable ?? "hermes";
  const methodPath = resolveDiaristCollectMethodPath(options.packageRoot);
  if (!existsSync(methodPath)) {
    throw new Error(`diarist collect method material missing (${methodPath})`);
  }
  // Read once at factory time — file remains the sole editable source of truth.
  const method = readFileSync(methodPath, "utf8");
  if (method.trim().length === 0) {
    throw new Error(`diarist collect method material is empty (${methodPath})`);
  }
  const runDetour = options.runDetour ?? runEngineDetourOnce;
  return async (input) => {
    const payload = buildDiaristCollectorEnginePayload({
      ticketNumber: input.ticketNumber,
      candidates: input.candidates,
      method,
    });
    const prompt = serializeDiaristCollectorEnginePayload(payload);
    // File-path delivery via shared seam token (never paste body into argv).
    // chat --query-file + -Q keeps final-response-only stdout. Tool surface is
    // the empty built-in `context_engine` toolset — collector is pure JSON
    // selection over untrusted ticket text; never terminal/file/web tools.
    // --ignore-rules keeps host identity out.
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
      HERMES_DIARIST_COLLECTOR_TOOLSET,
    ];
    const result = await runDetour({
      argv,
      stagedPrompt: prompt,
      cwd: options.cwd ?? process.cwd(),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.code !== 0) {
      throw new Error(
        `diarist LLM collector engine exited ${result.code}: ${result.stderr.slice(0, 500)}`,
      );
    }
    const selections = parseDiaristLlmStdout(
      result.stdout,
      input.candidates.length,
    );
    return {
      selections,
      rawStdout: result.stdout,
      // Staged body redacted — argv face shows the path token only.
      engineArgv: argv,
    };
  };
}

/** Test/scripted collector — pure function over fixed selections. */
export function createScriptedDiaristCollector(
  script: DiaristLlmCollectResult | ((input: {
    readonly ticketNumber: number;
    readonly candidates: readonly DiaristSourceBlock[];
  }) => DiaristLlmCollectResult | Promise<DiaristLlmCollectResult>),
): DiaristLlmCollector {
  return async (input) => {
    if (typeof script === "function") {
      return await script(input);
    }
    return script;
  };
}
