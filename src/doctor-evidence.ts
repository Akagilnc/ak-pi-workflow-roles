import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { sha256Hex } from "./sha256.ts";
import type { DoctorCase, DoctorCaseCost, DoctorEvidenceEntry } from "./doctor-contracts.ts";
import { isTerminatingToolName, validateAcceptedDetails } from "./package-contracts/terminating-tools.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function files(root: string): Promise<string[]> { const found: string[] = []; async function walk(dir: string) { for (const item of await readdir(dir, { withFileTypes: true })) { const path = resolve(dir, item.name); if (item.isDirectory()) await walk(path); else if (item.isFile() && (item.name.endsWith(".jsonl") || item.name === "stderr.log")) found.push(path); } } await walk(root); return found.sort(); }
function sourceList(count: number, sources: string[]) { return { count, sources: [...new Set(sources)].sort() }; }
function timestamp(row: Record<string, unknown>) { return typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined; }

/** Read Pi's retained session directory as the sole raw material for one case. */
export async function loadDoctorCase(runsPath: string): Promise<DoctorCase> {
  const root = await realpath(runsPath); const match = root.split(sep).join("/").match(/\/issues\/([1-9]\d*)\/runs$/); if (!match) throw new Error("Doctor case must be an .ak/work/issues/<n>/runs directory");
  const paths = await files(root); const evidence: DoctorEvidenceEntry[] = []; const sessions: DoctorCaseCost["sessions"] = []; const turnSources: string[] = [], callSources: string[] = [], tokenSources: string[] = []; let turns = 0, calls = 0, tokens = 0; const statuses: DoctorCaseCost["statuses"] = [], commits: DoctorCaseCost["commits"] = [];
  for (const path of paths) {
    const id = relative(root, path).split(sep).join("/"); const bytes = await readFile(path); const content = bytes.toString("utf8"); const kind = id.endsWith(".jsonl") ? "session" : "stderr"; evidence.push({ id, kind, byteLength: bytes.byteLength, sha256: sha256Hex(bytes), content }); if (kind === "stderr") continue;
    const rows: Record<string, unknown>[] = []; for (const line of content.split("\n")) if (line.trim()) { const row: unknown = JSON.parse(line); if (!record(row)) throw new Error(`Invalid Pi session row: ${id}`); rows.push(row); }
    const started = rows.find((row) => row.type === "session"); const startedAt = started && timestamp(started); if (!startedAt) throw new Error(`Pi session header is missing: ${id}`);
    let accepted: Record<string, unknown> | undefined;
    for (const row of rows) { const message = record(row.message) ? row.message : undefined; if (message?.role === "assistant") { const contentItems = Array.isArray(message.content) ? message.content : []; for (const part of contentItems) if (record(part) && part.type === "toolCall") { calls++; callSources.push(id); } if (typeof message.responseId === "string") { turns++; turnSources.push(id); const usage = record(message.usage) ? message.usage : undefined; if (usage && typeof usage.output === "number") { tokens += usage.output; tokenSources.push(id); } } } if (message?.role === "toolResult" && message.isError !== true && typeof message.toolName === "string" && isTerminatingToolName(message.toolName) && record(message.details)) { let details: Record<string, unknown>; try { details = validateAcceptedDetails(message.toolName, message.details) as unknown as Record<string, unknown>; } catch { continue; } accepted = row; const status = ["status", "judgeStatus"].map((key) => details[key]).find((item) => typeof item === "string"); if (typeof status === "string") statuses.push({ source: id, status }); const commit = ["commitSha", "commit", "commitSHA"].map((key) => details[key]).find((item) => typeof item === "string" && /^[0-9a-f]{7,40}$/i.test(item)); if (typeof commit === "string") commits.push({ source: id, commit }); } }
    const final = accepted ?? rows.at(-1)!; const endedAt = timestamp(final) ?? startedAt; sessions.push({ source: id, startedAt, endedAt, wallMilliseconds: Date.parse(endedAt) - Date.parse(startedAt), completion: accepted ? "accepted" : "incomplete" });
  }
  const runDirs = (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort(); const legs = evidence.filter((entry) => entry.kind === "session").map((entry) => entry.id); const retryDirs = runDirs.filter((name) => /(?:^|[-_])retry(?:[-_]|$)/i.test(name)); const rawBytes = evidence.filter((entry) => entry.kind === "session").reduce((sum, entry) => sum + entry.byteLength, 0);
  const cost: DoctorCaseCost = { invocations: sourceList(runDirs.length, runDirs), legs: sourceList(legs.length, legs), modelApiTurns: sourceList(turns, turnSources), outputTokens: sourceList(tokens, tokenSources), toolCalls: sourceList(calls, callSources), retries: { ...sourceList(retryDirs.length, retryDirs), evidence: "literal run-dir naming" }, statuses, commits, sessions, outputBytes: { ...sourceList(rawBytes, legs), payload: "raw JSONL bytes", providerWireBytes: "unavailable" } };
  return { version: 1, identity: { issueNumber: Number(match[1]), runsPath: root }, evidence, cost };
}
