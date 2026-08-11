import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { sha256Hex } from "./sha256.ts";
import type { DoctorCase, DoctorCaseCost, DoctorCount, DoctorEvidenceEntry } from "./doctor-contracts.ts";
import { AcceptedDetailsContractError, acceptedFacts, isTerminatingToolName, validateAcceptedDetails } from "./package-contracts/terminating-tools.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function discoverCaseFiles(root: string): Promise<string[]> { const found: string[] = []; async function walk(dir: string, depth: number) { for (const item of await readdir(dir, { withFileTypes: true })) { const path = resolve(dir, item.name); if (item.isDirectory()) await walk(path, depth + 1); else if (item.isFile() && (item.name.endsWith(".jsonl") || (item.name === "stderr.log" && depth === 1))) found.push(path); } } await walk(root, 0); return found.sort(); }
function sourceList(count: number, sources: string[]) { return { count, sources: [...new Set(sources)].sort() }; }
function accumulate(metric: DoctorCount, value: number, source: string) { metric.count += value; if (value) metric.sources.push(source); }
function timestamp(row: Record<string, unknown>) { return typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined; }
function isMissingPathError(error: unknown): boolean { return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"); }
async function stableRunsIdentity(root: string): Promise<string> { let cursor = root; while (true) { try { const git = await stat(resolve(cursor, ".git")); if (git.isDirectory() || git.isFile()) return relative(cursor, root).split(sep).join("/"); } catch (error) { if (!isMissingPathError(error)) throw error; } const parent = dirname(cursor); if (parent === cursor) return root; cursor = parent; } }

type SessionDerivation = { session: DoctorCaseCost["sessions"][number]; turns: number; calls: number; tokens: number; statuses: DoctorCaseCost["statuses"]; commits: DoctorCaseCost["commits"] };
function deriveSession(content: string, id: string): SessionDerivation {
  const rows: Record<string, unknown>[] = []; const degradationReasons: string[] = [];
  for (const line of content.split("\n")) if (line.trim()) { try { const row: unknown = JSON.parse(line); if (!record(row)) { degradationReasons.push(`non-object session row in ${id}`); break; } rows.push(row); } catch (error) { if (error instanceof SyntaxError) { degradationReasons.push(`malformed JSON tail in ${id}: ${error.message}`); break; } throw error; } }
  const started = rows.find((row) => row.type === "session"); const startedAt = started && timestamp(started); if (!startedAt) degradationReasons.push(`Pi session header is missing: ${id}`);
  let accepted: Record<string, unknown> | undefined, observedCommit: string | undefined, turns = 0, calls = 0, tokens = 0;
  const statuses: DoctorCaseCost["statuses"] = [], commits: DoctorCaseCost["commits"] = [];
  for (const row of rows) {
    const message = record(row.message) ? row.message : undefined;
    if (message?.role === "assistant") { for (const part of Array.isArray(message.content) ? message.content : []) if (record(part) && part.type === "toolCall") calls++; if (typeof message.responseId === "string") { turns++; const usage = record(message.usage) ? message.usage : undefined; if (usage && typeof usage.output === "number") tokens += usage.output; } }
    if (message?.role === "toolResult" && message.isError !== true && typeof message.toolName === "string" && isTerminatingToolName(message.toolName) && record(message.details)) { let details; try { details = validateAcceptedDetails(message.toolName, message.details); } catch (error) { // Contract: README.md#Doctor — non-accepted terminating receipts are expected-negative evidence and are skipped; all other validation failures propagate with their cause.
        if (error instanceof AcceptedDetailsContractError) continue; throw error; } accepted = row; const facts = acceptedFacts(message.toolName, details); if (facts.commit && facts.commit !== observedCommit) { commits.push({ source: id, commit: facts.commit }); observedCommit = facts.commit; } statuses.length = 0; if (facts.status !== undefined) { statuses.push({ source: id, status: facts.status }); } else { statuses.push({ source: id, status: "terminating receipt has no receipt-level status" }); } }
  }
  const acceptedAt = accepted && timestamp(accepted); const final = acceptedAt ? accepted! : rows.at(-1); const endedAt = final && timestamp(final); const wall = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : undefined;
  if (wall !== undefined && wall < 0) degradationReasons.push(`non-monotonic session timestamps in ${id}`);
  const degradationReason = degradationReasons.length ? degradationReasons.join("; ") : undefined;
  const complete = !!acceptedAt && !degradationReason && wall !== undefined && wall >= 0;
  const session = complete
    ? { source: id, startedAt: startedAt!, endedAt: endedAt!, wallMilliseconds: wall!, completion: "accepted" as const }
    : { source: id, ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}), ...(wall !== undefined && wall >= 0 ? { wallMilliseconds: wall } : {}), completion: "incomplete" as const, ...(degradationReason ? { degradationReason } : {}) };
  return { session, turns, calls, tokens, statuses, commits };
}

/** Read Pi's retained session directory as the sole raw material for one case. */
export async function loadDoctorCase(runsPath: string): Promise<DoctorCase> {
  const root = await realpath(runsPath); const match = root.split(sep).join("/").match(/\/\.ak-roles\/books\/[^/]+\/issues\/([1-9]\d*)\/runs$/); if (!match) throw new Error("Doctor case must be an .ak-roles/books/<book>/issues/<n>/runs directory");
  const evidence: DoctorEvidenceEntry[] = [], sessions: DoctorCaseCost["sessions"] = [], statuses: DoctorCaseCost["statuses"] = [], commits: DoctorCaseCost["commits"] = [];
  const turns: DoctorCount = { count: 0, sources: [] }, calls: DoctorCount = { count: 0, sources: [] }, tokens: DoctorCount = { count: 0, sources: [] };
  for (const path of await discoverCaseFiles(root)) { const id = relative(root, path).split(sep).join("/"); const bytes = await readFile(path); const content = bytes.toString("utf8"); const kind = id.endsWith(".jsonl") ? "session" : "stderr"; evidence.push({ id, kind, byteLength: bytes.byteLength, contentLength: content.length, sha256: sha256Hex(bytes), content }); if (kind === "stderr") continue; const result = deriveSession(content, id); sessions.push(result.session); statuses.push(...result.statuses); commits.push(...result.commits); accumulate(turns, result.turns, id); accumulate(calls, result.calls, id); accumulate(tokens, result.tokens, id); }
  const runDirs = (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort(); const legs = evidence.filter((entry) => entry.kind === "session").map((entry) => entry.id); const retryDirs = runDirs.filter((name) => /(?:^|[-_])retry(?:[-_]|$)/i.test(name)); const rawBytes = evidence.filter((entry) => entry.kind === "session").reduce((sum, entry) => sum + entry.byteLength, 0);
  const cost: DoctorCaseCost = { invocations: sourceList(runDirs.length, runDirs), legs: sourceList(legs.length, legs), modelApiTurns: sourceList(turns.count, turns.sources), outputTokens: sourceList(tokens.count, tokens.sources), toolCalls: sourceList(calls.count, calls.sources), retries: { ...sourceList(retryDirs.length, retryDirs), evidence: "literal run-dir naming" }, statuses, commits, sessions, outputBytes: { ...sourceList(rawBytes, legs), payload: "raw JSONL bytes", providerWireBytes: "unavailable" } };
  return { version: 1, identity: { issueNumber: Number(match[1]), runsPath: await stableRunsIdentity(root) }, evidence, cost };
}
