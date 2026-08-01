import { readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { sha256Hex } from "./sha256.ts";
import type { DoctorCase, DoctorCaseCost, DoctorEvidenceEntry } from "./doctor-contracts.ts";
import { AcceptedDetailsContractError, isTerminatingToolName, validateAcceptedDetails } from "./package-contracts/terminating-tools.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function discoverCaseFiles(root: string): Promise<string[]> { const found: string[] = []; async function walk(dir: string, depth: number) { for (const item of await readdir(dir, { withFileTypes: true })) { const path = resolve(dir, item.name); if (item.isDirectory()) await walk(path, depth + 1); else if (item.isFile() && (item.name.endsWith(".jsonl") || (item.name === "stderr.log" && depth === 1))) found.push(path); } } await walk(root, 0); return found.sort(); }
function sourceList(count: number, sources: string[]) { return { count, sources: [...new Set(sources)].sort() }; }
function timestamp(row: Record<string, unknown>) { return typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined; }

type SessionDerivation = { session: DoctorCaseCost["sessions"][number]; turns: number; calls: number; tokens: number; statuses: DoctorCaseCost["statuses"]; commits: DoctorCaseCost["commits"] };
function deriveSession(content: string, id: string): SessionDerivation {
  const rows: Record<string, unknown>[] = [];
  for (const line of content.split("\n")) if (line.trim()) { const row: unknown = JSON.parse(line); if (!record(row)) throw new Error(`Invalid Pi session row: ${id}`); rows.push(row); }
  const started = rows.find((row) => row.type === "session"); const startedAt = started && timestamp(started); if (!startedAt) throw new Error(`Pi session header is missing: ${id}`);
  let accepted: Record<string, unknown> | undefined, observedCommit: string | undefined, turns = 0, calls = 0, tokens = 0;
  const statuses: DoctorCaseCost["statuses"] = [], commits: DoctorCaseCost["commits"] = [];
  for (const row of rows) {
    const message = record(row.message) ? row.message : undefined;
    if (message?.role === "assistant") { for (const part of Array.isArray(message.content) ? message.content : []) if (record(part) && part.type === "toolCall") calls++; if (typeof message.responseId === "string") { turns++; const usage = record(message.usage) ? message.usage : undefined; if (usage && typeof usage.output === "number") tokens += usage.output; } }
    if (message?.role === "toolResult" && message.isError !== true && typeof message.toolName === "string" && isTerminatingToolName(message.toolName) && record(message.details)) { let details: Record<string, unknown>; try { details = validateAcceptedDetails(message.toolName, message.details) as unknown as Record<string, unknown>; } catch (error) { if (error instanceof AcceptedDetailsContractError) continue; throw error; } accepted = row; const commit = details.commitSha; if (typeof commit === "string" && commit !== observedCommit) { commits.push({ source: id, commit }); observedCommit = commit; } const status = ["status", "judgeStatus"].map((key) => details[key]).find((item) => typeof item === "string"); statuses.length = 0; if (typeof status === "string") statuses.push({ source: id, status }); }
  }
  const final = accepted ?? rows.at(-1)!; const endedAt = timestamp(final) ?? startedAt;
  return { session: { source: id, startedAt, endedAt, wallMilliseconds: Date.parse(endedAt) - Date.parse(startedAt), completion: accepted ? "accepted" : "incomplete" }, turns, calls, tokens, statuses, commits };
}

/** Read Pi's retained session directory as the sole raw material for one case. */
export async function loadDoctorCase(runsPath: string): Promise<DoctorCase> {
  const root = await realpath(runsPath); const match = root.split(sep).join("/").match(/\/issues\/([1-9]\d*)\/runs$/); if (!match) throw new Error("Doctor case must be an .ak/work/issues/<n>/runs directory");
  const evidence: DoctorEvidenceEntry[] = [], sessions: DoctorCaseCost["sessions"] = [], statuses: DoctorCaseCost["statuses"] = [], commits: DoctorCaseCost["commits"] = [];
  const turnSources: string[] = [], callSources: string[] = [], tokenSources: string[] = []; let turns = 0, calls = 0, tokens = 0;
  for (const path of await discoverCaseFiles(root)) {
    const id = relative(root, path).split(sep).join("/"); const bytes = await readFile(path); const content = bytes.toString("utf8"); const kind = id.endsWith(".jsonl") ? "session" : "stderr"; evidence.push({ id, kind, byteLength: bytes.byteLength, sha256: sha256Hex(bytes), content }); if (kind === "stderr") continue;
    const result = deriveSession(content, id); sessions.push(result.session); statuses.push(...result.statuses); commits.push(...result.commits); turns += result.turns; calls += result.calls; tokens += result.tokens; if (result.turns) turnSources.push(id); if (result.calls) callSources.push(id); if (result.tokens) tokenSources.push(id);
  }
  const runDirs = (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort(); const legs = evidence.filter((entry) => entry.kind === "session").map((entry) => entry.id); const retryDirs = runDirs.filter((name) => /(?:^|[-_])retry(?:[-_]|$)/i.test(name)); const rawBytes = evidence.filter((entry) => entry.kind === "session").reduce((sum, entry) => sum + entry.byteLength, 0);
  const cost: DoctorCaseCost = { invocations: sourceList(runDirs.length, runDirs), legs: sourceList(legs.length, legs), modelApiTurns: sourceList(turns, turnSources), outputTokens: sourceList(tokens, tokenSources), toolCalls: sourceList(calls, callSources), retries: { ...sourceList(retryDirs.length, retryDirs), evidence: "literal run-dir naming" }, statuses, commits, sessions, outputBytes: { ...sourceList(rawBytes, legs), payload: "raw JSONL bytes", providerWireBytes: "unavailable" } };
  return { version: 1, identity: { issueNumber: Number(match[1]), runsPath: root }, evidence, cost };
}
