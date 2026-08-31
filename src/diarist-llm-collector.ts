/**
 * 起居郎 LLM semantic collector — ADR 0075 / #582.
 * Cheap engine selects decision-related blocks from a frozen candidate set.
 * Every claimed quote must pass mechanical reverse-verify before entry.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runEngineDetourOnce } from "./engine-detour.ts";
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
  /**
   * Absolute path of owner-domain method material bound for this collect.
   * Typed delivery evidence — production hermes collector always sets it.
   */
  readonly methodPath?: string;
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

/**
 * Machine kickoff text only (ADR 0073): start session, deliver material paths, describe output shape.
 * Semantic judgment lives in owner-domain method material — delivered by path, not restated here.
 */
export function buildDiaristCollectorPrompt(input: {
  readonly ticketNumber: number;
  readonly candidates: readonly DiaristSourceBlock[];
  /** Absolute path to owner-domain diarist-collect method material. */
  readonly methodPath: string;
}): string {
  const catalog = input.candidates.map((block, index) => ({
    candidateIndex: index,
    sourceKind: block.sourceKind,
    isUserTurn: block.isUserTurn,
    timestamp: block.timestamp,
    transcript: block.transcript,
  }));
  return [
    `起居郎收集器。票号 #${input.ticketNumber}。`,
    "本次配置的方法材料：",
    `- ${input.methodPath}`,
    "材料：已冻结来源对话块目录（JSON）。",
    "输出形状：单一 JSON 对象",
    '{"selections":[{"candidateIndex":0,"quotes":["transcript 连续原文子串"],"triage":"relevant|context|irrelevant","note":"可选"}]}',
    "来源块：",
    JSON.stringify(catalog),
  ].join("\n");
}

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
 * Default cheap-engine collector via hermes -z (ADR 0069 detour seam).
 * Owner-domain method material is delivered once: absolute path inside the -z
 * prompt (enters LLM view). No parallel env transport.
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
  const runDetour = options.runDetour ?? runEngineDetourOnce;
  return async (input) => {
    const prompt = buildDiaristCollectorPrompt({
      ticketNumber: input.ticketNumber,
      candidates: input.candidates,
      methodPath,
    });
    // hermes -z takes the prompt as one argv entry (no temp file).
    // --ignore-rules keeps host identity out; method path is solely in the prompt.
    const argv = [
      executable,
      ...(options.extraArgv ?? []),
      "-z",
      prompt,
      "--no-restore-cwd",
      "--ignore-rules",
    ];
    const result = await runDetour({
      argv,
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
      // Prompt bytes redacted — method path is the typed delivery evidence.
      engineArgv: argv.map((part, i) => (i === argv.indexOf(prompt) ? "<prompt>" : part)),
      methodPath,
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
