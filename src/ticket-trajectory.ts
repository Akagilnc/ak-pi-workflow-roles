/**
 * Single-ticket trajectory tracer (factory board S1).
 *
 * Mechanism, not a role: deterministic scan → HTML. Unique seam:
 *   (ledgerDir, ticketSnapshot, now) → HTML
 *
 * Station resolution (four-layer fallback):
 *   1) terminating tool name inside the session (ak_<role>_output)
 *   2) invocation.json role
 *   3) run-directory name heuristic
 *   4) unknown (still listed; never dropped)
 *
 * Receipt trust: only successful toolResults that pass typed contract
 * validation count as round results. Prior rejected attempts stay attempts.
 */
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  AcceptedDetailsContractError,
  acceptedFacts,
  isTerminatingToolName,
  validateAcceptedDetails,
  type TerminatingToolName,
} from "./package-contracts/terminating-tools.ts";
import { PACKAGED_ROLE_REGISTRY } from "./packaged-role-registry.ts";

/** Declared refresh bound for the same viewing surface (seconds). */
export const DEFAULT_REFRESH_BOUNDARY_SECONDS = 30;

/** Minimal ticket snapshot stub for S1 (no GitHub adapter). */
export type TicketSnapshot = {
  issueNumber: number;
};

export type StationSource = "tool" | "invocation" | "name" | "unknown";

type SessionRow = Record<string, unknown>;

type ParsedRun = {
  runId: string;
  ledgerCoord: string;
  startedAt?: string;
  station: string;
  stationSource: StationSource;
  attemptCount: number;
  hasResult: boolean;
  resultStatus: string;
  model: string;
  provider: string;
  thinking: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

const TOOL_TO_ROLE: ReadonlyMap<string, string> = new Map(
  PACKAGED_ROLE_REGISTRY.map((entry) => [entry.outputTool, entry.role]),
);

const NAME_PREFIX_ROLES: readonly string[] = PACKAGED_ROLE_REGISTRY.map((entry) => entry.role);

function roleFromToolName(toolName: string): string | undefined {
  return TOOL_TO_ROLE.get(toolName);
}

function roleFromRunName(runId: string): string | undefined {
  const base = runId.split("@")[0] ?? runId;
  const lower = base.toLowerCase();
  // plan-court / *-court* → judge (ticket-court family)
  if (/(^|[-_])court([-_]|$)/.test(lower) || lower.startsWith("plan-court")) return "judge";
  for (const role of NAME_PREFIX_ROLES) {
    if (lower === role || lower.startsWith(`${role}-`) || lower.startsWith(`${role}_`)) return role;
  }
  // review-* shorthand used heavily in the home ledger
  if (lower.startsWith("review")) return "reviewer";
  return undefined;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function attr(value: string): string {
  return escapeHtml(value);
}

async function readJsonl(path: string): Promise<SessionRow[]> {
  const text = await readFile(path, "utf8");
  const rows: SessionRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (isRecord(row)) rows.push(row);
    } catch (error) {
      if (error instanceof SyntaxError) break; // truncated tail — stop, keep prior rows
      throw error;
    }
  }
  return rows;
}

function extractModelFields(rows: SessionRow[]): { model: string; provider: string; thinking: string } {
  let model = "";
  let provider = "";
  let thinking = "";
  for (const row of rows) {
    if (row.type === "model_change") {
      if (typeof row.provider === "string" && row.provider) provider = row.provider;
      if (typeof row.modelId === "string" && row.modelId) model = row.modelId;
    }
    if (row.type === "thinking_level_change" && typeof row.thinkingLevel === "string" && row.thinkingLevel) {
      thinking = row.thinkingLevel;
    }
    const message = isRecord(row.message) ? row.message : undefined;
    if (message?.role === "assistant") {
      if (typeof message.model === "string" && message.model) model = message.model;
      if (typeof message.provider === "string" && message.provider) provider = message.provider;
    }
  }
  return { model, provider, thinking };
}

function extractTerminatingLifecycle(rows: SessionRow[]): {
  attemptCount: number;
  toolNames: string[];
  hasResult: boolean;
  resultStatus: string;
} {
  let callAttempts = 0;
  let resultAttempts = 0;
  const toolNames: string[] = [];
  let hasResult = false;
  let resultStatus = "";

  for (const row of rows) {
    const message = isRecord(row.message) ? row.message : undefined;
    if (!message) continue;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== "toolCall") continue;
        const name = part.name;
        if (typeof name === "string" && isTerminatingToolName(name)) {
          callAttempts += 1;
          toolNames.push(name);
        }
      }
    }

    if (message.role === "toolResult" && typeof message.toolName === "string" && isTerminatingToolName(message.toolName)) {
      resultAttempts += 1;
      toolNames.push(message.toolName);
      if (message.isError === true) continue;
      if (!isRecord(message.details)) continue;
      try {
        const details = validateAcceptedDetails(message.toolName as TerminatingToolName, message.details);
        const facts = acceptedFacts(message.toolName as TerminatingToolName, details);
        hasResult = true;
        resultStatus = facts.status ?? "";
      } catch (error) {
        if (error instanceof AcceptedDetailsContractError) continue;
        throw error;
      }
    }
  }

  // Prefer toolCall count; fall back to toolResult count when calls were clipped away.
  const attemptCount = callAttempts > 0 ? callAttempts : resultAttempts;
  return { attemptCount, toolNames, hasResult, resultStatus };
}

type InvocationInfo = {
  role?: string;
  model?: string;
  provider?: string;
  thinking?: string;
};

async function readInvocation(runDir: string): Promise<InvocationInfo | undefined> {
  try {
    const raw = await readFile(join(runDir, "invocation.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const info: InvocationInfo = {};
    if (typeof parsed.role === "string" && parsed.role.trim()) info.role = parsed.role.trim();
    if (typeof parsed.thinking === "string" && parsed.thinking.trim()) info.thinking = parsed.thinking.trim();
    if (typeof parsed.model === "string" && parsed.model.trim()) {
      const rawModel = parsed.model.trim();
      if (rawModel.includes("/")) {
        const slash = rawModel.indexOf("/");
        info.provider = rawModel.slice(0, slash);
        info.model = rawModel.slice(slash + 1);
      } else {
        info.model = rawModel;
      }
    }
    return info;
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function resolveStation(input: {
  toolNames: string[];
  invocationRole?: string;
  runId: string;
}): { station: string; stationSource: StationSource } {
  for (const toolName of input.toolNames) {
    const role = roleFromToolName(toolName);
    if (role) return { station: role, stationSource: "tool" };
  }
  // Also accept tool names observed only via accepted results order
  if (input.invocationRole) {
    return { station: input.invocationRole, stationSource: "invocation" };
  }
  const byName = roleFromRunName(input.runId);
  if (byName) return { station: byName, stationSource: "name" };
  return { station: "unknown", stationSource: "unknown" };
}

async function listSessionFiles(sessionDir: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(sessionDir, entry.name))
      .sort();
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

async function parseRun(ledgerDir: string, issueNumber: number, runId: string): Promise<ParsedRun> {
  const runDir = join(ledgerDir, "issues", String(issueNumber), "runs", runId);
  const ledgerCoord = ["issues", String(issueNumber), "runs", runId].join("/");
  const sessionFiles = await listSessionFiles(join(runDir, "session"));
  const rows: SessionRow[] = [];
  for (const file of sessionFiles) {
    rows.push(...(await readJsonl(file)));
  }

  let startedAt: string | undefined;
  for (const row of rows) {
    if (row.type === "session" && typeof row.timestamp === "string") {
      startedAt = row.timestamp;
      break;
    }
    if (!startedAt && typeof row.timestamp === "string") startedAt = row.timestamp;
  }

  const lifecycle = extractTerminatingLifecycle(rows);
  const models = extractModelFields(rows);
  const invocation = await readInvocation(runDir);
  const { station, stationSource } = resolveStation({
    toolNames: lifecycle.toolNames,
    runId,
    ...(invocation?.role !== undefined ? { invocationRole: invocation.role } : {}),
  });

  // Session mechanical fields win; invocation.json fills gaps only.
  let { model, provider, thinking } = models;
  if (invocation) {
    if (!thinking && invocation.thinking) thinking = invocation.thinking;
    if (!provider && invocation.provider) provider = invocation.provider;
    if (!model && invocation.model) model = invocation.model;
  }

  return {
    runId,
    ledgerCoord,
    ...(startedAt !== undefined ? { startedAt } : {}),
    station,
    stationSource,
    attemptCount: lifecycle.attemptCount,
    hasResult: lifecycle.hasResult,
    resultStatus: lifecycle.resultStatus,
    model,
    provider,
    thinking,
  };
}

async function listRunIds(ledgerDir: string, issueNumber: number): Promise<string[]> {
  const runsDir = join(ledgerDir, "issues", String(issueNumber), "runs");
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function renderHtml(input: {
  issueNumber: number;
  generatedAt: string;
  refreshBoundarySeconds: number;
  runs: ParsedRun[];
}): string {
  // Group by station preserving first-seen chronological order.
  const stationOrder: string[] = [];
  const byStation = new Map<string, ParsedRun[]>();
  const sortedRuns = [...input.runs].sort((a, b) => {
    const at = a.startedAt ?? "";
    const bt = b.startedAt ?? "";
    if (at !== bt) return at.localeCompare(bt);
    return a.runId.localeCompare(b.runId);
  });
  for (const run of sortedRuns) {
    if (!byStation.has(run.station)) {
      byStation.set(run.station, []);
      stationOrder.push(run.station);
    }
    byStation.get(run.station)!.push(run);
  }

  const stationBlocks = stationOrder.map((station) => {
    const rounds = byStation.get(station)!;
    const stationLabel = station === "unknown" ? "未知站" : station;
    const roundHtml = rounds
      .map((run) => {
        return [
          `<article class="run"`,
          ` data-run-id="${attr(run.runId)}"`,
          ` data-station="${attr(run.station)}"`,
          ` data-station-source="${attr(run.stationSource)}"`,
          ` data-ledger-coord="${attr(run.ledgerCoord)}"`,
          ` data-attempt-count="${attr(String(run.attemptCount))}"`,
          ` data-has-result="${run.hasResult ? "true" : "false"}"`,
          ` data-result-status="${attr(run.resultStatus)}"`,
          ` data-model="${attr(run.model)}"`,
          ` data-provider="${attr(run.provider)}"`,
          ` data-thinking="${attr(run.thinking)}"`,
          `>`,
          `<header class="run-head">`,
          `<span class="run-id">${escapeHtml(run.runId)}</span>`,
          run.model || run.provider || run.thinking
            ? `<span class="run-model">${escapeHtml([run.provider, run.model].filter(Boolean).join("/"))}${run.thinking ? ` · ${escapeHtml(run.thinking)}` : ""}</span>`
            : "",
          `</header>`,
          `<p class="run-meta">`,
          `<span class="attempts">attempts: ${run.attemptCount}</span>`,
          run.hasResult
            ? `<span class="result">result: ${escapeHtml(run.resultStatus)}</span>`
            : `<span class="result">result: (none — attempts only)</span>`,
          `</p>`,
          `<p class="ledger"><a data-ledger-link="${attr(run.ledgerCoord)}" href="#${attr(run.ledgerCoord)}">${escapeHtml(run.ledgerCoord)}</a></p>`,
          `</article>`,
        ].join("");
      })
      .join("\n");

    return [
      `<section class="station" data-station-block="${attr(station)}" data-round-count="${rounds.length}">`,
      `<h2 class="station-title">${escapeHtml(stationLabel)}</h2>`,
      roundHtml,
      `</section>`,
    ].join("\n");
  });

  return `<!DOCTYPE html>
<html lang="zh-CN"
  data-issue="${attr(String(input.issueNumber))}"
  data-generated-at="${attr(input.generatedAt)}"
  data-refresh-boundary-seconds="${attr(String(input.refreshBoundarySeconds))}"
>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="refresh" content="${attr(String(input.refreshBoundarySeconds))}"/>
<title>Ticket #${escapeHtml(String(input.issueNumber))} trajectory</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.45; }
  body { margin: 0 auto; padding: 1rem; max-width: 52rem; }
  header.page { margin-bottom: 1rem; }
  .generated { font-size: 0.9rem; opacity: 0.8; }
  .station { border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); border-radius: 0.5rem; padding: 0.75rem; margin: 0.75rem 0; }
  .station-title { margin: 0 0 0.5rem; font-size: 1.1rem; }
  .run { padding: 0.5rem 0; border-top: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); }
  .run:first-of-type { border-top: 0; }
  .run-head { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; justify-content: space-between; }
  .run-id { font-family: ui-monospace, monospace; font-size: 0.9rem; word-break: break-all; }
  .run-model { font-size: 0.85rem; opacity: 0.85; }
  .run-meta { margin: 0.25rem 0; font-size: 0.9rem; display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .ledger { margin: 0.25rem 0 0; font-size: 0.8rem; word-break: break-all; }
  @media (max-width: 640px) {
    body { padding: 0.75rem; }
    .run-head { flex-direction: column; }
  }
</style>
</head>
<body>
<header class="page">
  <h1>Ticket #${escapeHtml(String(input.issueNumber))} · 驿传轨迹</h1>
  <p class="generated">generated-at <time datetime="${attr(input.generatedAt)}">${escapeHtml(input.generatedAt)}</time>
    · refresh ≤ ${escapeHtml(String(input.refreshBoundarySeconds))}s</p>
</header>
<main data-run-count="${sortedRuns.length}">
${stationBlocks.join("\n") || "<p data-empty=\"true\">no runs</p>"}
</main>
</body>
</html>
`;
}

/**
 * Unique production seam: pure scan of the ledger + snapshot + now → HTML.
 * Read-only against the ledger. Snapshot is the S1 minimal stub.
 */
export async function renderTicketTrajectoryHtml(
  ledgerDir: string,
  ticketSnapshot: TicketSnapshot,
  now: Date,
  options?: { refreshBoundarySeconds?: number },
): Promise<string> {
  if (!isRecord(ticketSnapshot) || typeof ticketSnapshot.issueNumber !== "number" || !Number.isInteger(ticketSnapshot.issueNumber) || ticketSnapshot.issueNumber < 1) {
    throw new Error("ticketSnapshot.issueNumber must be a positive integer");
  }
  const issueNumber = ticketSnapshot.issueNumber;
  const root = resolve(ledgerDir);
  const runIds = await listRunIds(root, issueNumber);
  const runs: ParsedRun[] = [];
  for (const runId of runIds) {
    runs.push(await parseRun(root, issueNumber, runId));
  }
  const generatedAt = now.toISOString();
  const refreshBoundarySeconds = options?.refreshBoundarySeconds ?? DEFAULT_REFRESH_BOUNDARY_SECONDS;
  return renderHtml({ issueNumber, generatedAt, refreshBoundarySeconds, runs });
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(".."));
}

/**
 * Page lifecycle: render via the unique seam and write ONLY to an explicit
 * path outside the ledger. Caller owns output location and process lifetime.
 */
export async function writeTicketTrajectoryPage(input: {
  ledgerDir: string;
  ticketSnapshot: TicketSnapshot;
  now: Date;
  outputPath: string;
  refreshBoundarySeconds?: number;
}): Promise<{ outputPath: string; html: string }> {
  const ledgerRoot = await realpath(resolve(input.ledgerDir)).catch(async () => resolve(input.ledgerDir));
  const outputResolved = resolve(input.outputPath);

  // Ensure we never write into the ledger tree (including not-yet-created paths).
  let outputParent = dirname(outputResolved);
  try {
    outputParent = await realpath(outputParent);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    // parent may not exist yet — compare resolved absolute paths
  }

  if (isPathInside(ledgerRoot, outputResolved) || isPathInside(ledgerRoot, outputParent)) {
    throw new Error("ticket trajectory outputPath must be outside the ledger directory");
  }

  const html = await renderTicketTrajectoryHtml(
    input.ledgerDir,
    input.ticketSnapshot,
    input.now,
    input.refreshBoundarySeconds !== undefined
      ? { refreshBoundarySeconds: input.refreshBoundarySeconds }
      : undefined,
  );

  await mkdir(dirname(outputResolved), { recursive: true });
  await writeFile(outputResolved, html, "utf8");
  const outputPath = await realpath(outputResolved);
  return { outputPath, html };
}

