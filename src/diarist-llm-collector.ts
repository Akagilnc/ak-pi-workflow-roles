/**
 * 起居郎 LLM semantic collector — ADR 0075 / #582.
 * Cheap engine selects decision-related blocks from a frozen candidate set.
 * Every claimed quote must pass mechanical reverse-verify before entry.
 */
import { runEngineDetourOnce } from "./engine-detour.ts";
import type { DiaristSourceBlock } from "./diarist-mechanical.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse collector stdout. Prefer a fenced JSON array/object; fall back to
 * whole-stdout JSON. Unknown shape → empty selections (honest empty, not throw).
 */
export function parseDiaristLlmStdout(
  stdout: string,
  candidateCount: number,
): DiaristLlmSelection[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  let jsonText = trimmed;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence !== null && fence[1] !== undefined && fence[1].trim() !== "") {
    jsonText = fence[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Try last JSON array/object substring.
    const startArr = jsonText.indexOf("[");
    const startObj = jsonText.indexOf("{");
    let start = -1;
    if (startArr >= 0 && (startObj < 0 || startArr < startObj)) start = startArr;
    else if (startObj >= 0) start = startObj;
    if (start < 0) return [];
    const endArr = jsonText.lastIndexOf("]");
    const endObj = jsonText.lastIndexOf("}");
    const end = Math.max(endArr, endObj);
    if (end <= start) return [];
    try {
      parsed = JSON.parse(jsonText.slice(start, end + 1));
    } catch {
      return [];
    }
  }

  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.selections)
      ? parsed.selections
      : isRecord(parsed) && Array.isArray(parsed.blocks)
        ? parsed.blocks
        : [];

  const out: DiaristLlmSelection[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const indexRaw = row.candidateIndex ?? row.index ?? row.i;
    const index =
      typeof indexRaw === "number"
        ? indexRaw
        : typeof indexRaw === "string" && /^\d+$/.test(indexRaw)
          ? Number(indexRaw)
          : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= candidateCount) continue;
    const quotesRaw = row.quotes ?? row.quote;
    const quotes = Array.isArray(quotesRaw)
      ? quotesRaw.filter((q): q is string => typeof q === "string" && q.length > 0)
      : typeof quotesRaw === "string" && quotesRaw.length > 0
        ? [quotesRaw]
        : [];
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

/** Build the one-shot collector prompt (neutral shape description for the engine). */
export function buildDiaristCollectorPrompt(input: {
  readonly ticketNumber: number;
  readonly candidates: readonly DiaristSourceBlock[];
}): string {
  const catalog = input.candidates.map((block, index) => ({
    candidateIndex: index,
    sourceKind: block.sourceKind,
    isUserTurn: block.isUserTurn,
    timestamp: block.timestamp,
    transcript: block.transcript,
  }));
  return [
    `你是起居郎收集器。票号 #${input.ticketNumber}。`,
    "下面是已冻结的来源对话块（仅去通知/去重，未经相关性裁剪）。请挑出与本票决策相关的块。",
    "只输出 JSON，形状：",
    '{"selections":[{"candidateIndex":0,"quotes":["必须是 transcript 中的连续原文子串"],"triage":"relevant|context|irrelevant","note":"可选摘要"}]}',
    "规则：",
    "1. quotes 必须是对应 transcript 的连续原文，禁止拼接、禁止改写。",
    "2. 宁多勿漏：决策相关都收；明显无关标 irrelevant 且可不入 selections。",
    "3. 不要输出 JSON 以外的文字。",
    "",
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
};

/**
 * Default cheap-engine collector via hermes -z (ADR 0069 detour seam).
 * Engine failure throws — caller records honest diagnostic.
 */
export function createHermesDiaristCollector(
  options: HermesDiaristCollectorOptions = {},
): DiaristLlmCollector {
  const executable = options.executable ?? "hermes";
  return async (input) => {
    const prompt = buildDiaristCollectorPrompt({
      ticketNumber: input.ticketNumber,
      candidates: input.candidates,
    });
    // hermes -z takes the prompt as one argv entry (no temp file).
    const argv = [
      executable,
      ...(options.extraArgv ?? []),
      "-z",
      prompt,
      "--no-restore-cwd",
      "--ignore-rules",
    ];
    const result = await runEngineDetourOnce({
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
      engineArgv: argv.map((part, i) => (i === argv.indexOf(prompt) ? "<prompt>" : part)),
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
