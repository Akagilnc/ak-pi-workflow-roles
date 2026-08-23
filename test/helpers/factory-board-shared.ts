/**
 * Shared board-sort / ledger-read helpers for factory-board coverage (#420 整改拆分).
 * Extracted verbatim from test/contract/factory-board.test.ts — no behavior change.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import vm from "node:vm";

import {
  AcceptedDetailsContractError,
  acceptedFacts,
  isTerminatingToolName,
  validateAcceptedDetails,
} from "../../src/package-contracts/terminating-tools.ts";
import type { TerminatingToolName } from "../../src/package-contracts/terminating-tools.ts";
import type { SnapshotTicket } from "../../src/ticket-snapshot.ts";

export type BoardPageSortMode = "ticket-asc" | "cost-desc" | "cost-asc";

export function attrsFromOpenTag(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/\b(data-[a-z0-9-]+|class|href)="([^"]*)"/g)) {
    attrs[m[1]!] = m[2]!;
  }
  return attrs;
}

export async function discoverTrueHomeUnacceptedActiveIssue(
  homeLedger: string,
): Promise<number | undefined> {
  const issuesDir = join(homeLedger, "issues");
  let issueNumbers: number[] = [];
  try {
    issueNumbers = (await readdir(issuesDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // #127/#130 carry dedicated trajectory/cost assertions in the true-home suite;
  // do not double-book them as the flying sample even if their latest later flips.
  const reserved = new Set([127, 130]);
  for (const issueNumber of issueNumbers) {
    if (reserved.has(issueNumber)) continue;
    const leg = await independentLatestLegActivity(homeLedger, issueNumber);
    if (leg && !leg.hasAcceptedResult && leg.mtimeMs > 0) {
      return issueNumber;
    }
  }
  return undefined;
}

export function elementsWith(html: string, dataAttr: string): Record<string, string>[] {
  const re = new RegExp(`<[^>]+\\b${dataAttr}="[^"]*"[^>]*>`, "g");
  const out: Record<string, string>[] = [];
  for (const tag of html.match(re) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/\b(data-[a-z0-9-]+|href)="([^"]*)"/g)) {
      attrs[m[1]!] = m[2]!;
    }
    out.push(attrs);
  }
  return out;
}

export function executeProductionBoardSort(
  html: string,
  bookKey: string,
  mode: BoardPageSortMode,
): Array<Record<string, string>> {
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch?.[1], "production board must embed sort script");
  const scriptBody = scriptMatch[1]!;

  const select = new BoardSortElement({ "data-sort-control": "true" });
  select.value = "ticket-asc";
  const lane = new BoardSortElement({ "data-lane-tickets": bookKey });
  for (const attrs of topLevelLaneEntries(html, bookKey)) {
    lane.appendChild(new BoardSortElement(attrs));
  }

  const document = {
    querySelector(sel: string): BoardSortElement | null {
      if (sel === "[data-sort-control]") return select;
      return null;
    },
    querySelectorAll(sel: string): BoardSortElement[] {
      if (sel === "[data-lane-tickets]") return [lane];
      return [];
    },
  };

  vm.runInNewContext(scriptBody, { document });
  select.value = mode;
  select.dispatchEvent("change");

  return lane.children.map((child) => {
    const out: Record<string, string> = {};
    for (const key of ["data-ticket", "data-parent", "data-family", "data-cost-usd", "data-book"]) {
      const v = child.getAttribute(key);
      if (v != null) out[key] = v;
    }
    return out;
  });
}

export async function independentAcceptedTrajectory(
  ledgerDir: string,
  issueNumber: number,
): Promise<Array<{ runId: string; resultStatus: string }>> {
  const runsDir = join(ledgerDir, "issues", String(issueNumber), "runs");
  let runIds: string[] = [];
  try {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const accepted: Array<{ runId: string; resultStatus: string }> = [];
  for (const runId of runIds) {
    const sessionDir = join(runsDir, runId, "session");
    let files: string[] = [];
    try {
      files = (await readdir(sessionDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(sessionDir, e.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    let hasResult = false;
    let resultStatus = "";
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          row = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const message =
          row.message && typeof row.message === "object" && !Array.isArray(row.message)
            ? (row.message as Record<string, unknown>)
            : undefined;
        if (!message || message.role !== "toolResult") continue;
        if (typeof message.toolName !== "string" || !isTerminatingToolName(message.toolName)) {
          continue;
        }
        if (message.isError === true) continue;
        if (!message.details || typeof message.details !== "object" || Array.isArray(message.details)) {
          continue;
        }
        try {
          const details = validateAcceptedDetails(
            message.toolName as TerminatingToolName,
            message.details,
          );
          const facts = acceptedFacts(message.toolName as TerminatingToolName, details);
          hasResult = true;
          resultStatus = facts.status ?? "";
        } catch (error) {
          if (error instanceof AcceptedDetailsContractError) continue;
          throw error;
        }
      }
    }
    if (hasResult) accepted.push({ runId, resultStatus });
  }
  return accepted;
}

export async function independentIssueUsage(ledgerDir: string, issueNumber: number): Promise<{
  runCount: number;
  reviewerRunCount: number;
  costUsd: number;
  totalTokens: number;
  reviewerCostUsd: number;
  reviewerTokens: number;
  axisWallMs: number;
}> {
  const runsDir = join(ledgerDir, "issues", String(issueNumber), "runs");
  let runIds: string[] = [];
  try {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        runCount: 0,
        reviewerRunCount: 0,
        costUsd: 0,
        totalTokens: 0,
        reviewerCostUsd: 0,
        reviewerTokens: 0,
        axisWallMs: 0,
      };
    }
    throw error;
  }

  const sumUsage = (rows: Record<string, unknown>[]): { cost: number; tokens: number } => {
    let cost = 0;
    let tokens = 0;
    for (const row of rows) {
      const message = row.message && typeof row.message === "object" ? (row.message as Record<string, unknown>) : undefined;
      const usageRaw =
        message && message.usage && typeof message.usage === "object"
          ? (message.usage as Record<string, unknown>)
          : row.usage && typeof row.usage === "object"
            ? (row.usage as Record<string, unknown>)
            : undefined;
      if (!usageRaw) continue;
      if (typeof usageRaw.totalTokens === "number" && Number.isFinite(usageRaw.totalTokens)) {
        tokens += usageRaw.totalTokens;
      }
      const costObj =
        usageRaw.cost && typeof usageRaw.cost === "object"
          ? (usageRaw.cost as Record<string, unknown>)
          : undefined;
      if (costObj && typeof costObj.total === "number" && Number.isFinite(costObj.total)) {
        cost += costObj.total;
      }
    }
    return { cost, tokens };
  };

  const readJsonl = async (path: string): Promise<Record<string, unknown>[]> => {
    const text = await readFile(path, "utf8");
    const out: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Independent scan skips malformed lines the same way a human eyeball would continue.
      }
    }
    return out;
  };

  const spanWall = (rows: Record<string, unknown>[]): number => {
    const ts = rows
      .map((r) => r.timestamp)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    if (ts.length === 0) return 0;
    const start = Date.parse(ts[0]!);
    const end = Date.parse(ts[ts.length - 1]!);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    return end - start;
  };

  let costUsd = 0;
  let totalTokens = 0;
  let reviewerRunCount = 0;
  let reviewerCostUsd = 0;
  let reviewerTokens = 0;
  let axisWallMs = 0;

  for (const runId of runIds) {
    const runDir = join(runsDir, runId);
    const sessionDir = join(runDir, "session");
    let parentFiles: string[] = [];
    try {
      parentFiles = (await readdir(sessionDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(sessionDir, e.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let axisFiles: string[] = [];
    try {
      const legsDir = join(sessionDir, "reviewer-legs");
      axisFiles = (await readdir(legsDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(legsDir, e.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let runCost = 0;
    let runTokens = 0;
    let runAxisWall = 0;
    for (const f of parentFiles) {
      const u = sumUsage(await readJsonl(f));
      runCost += u.cost;
      runTokens += u.tokens;
    }
    for (const f of axisFiles) {
      const rows = await readJsonl(f);
      const u = sumUsage(rows);
      runCost += u.cost;
      runTokens += u.tokens;
      runAxisWall += spanWall(rows);
    }

    costUsd += runCost;
    totalTokens += runTokens;

    let role: string | undefined;
    try {
      const inv = JSON.parse(await readFile(join(runDir, "invocation.json"), "utf8")) as {
        role?: string;
      };
      if (typeof inv.role === "string") role = inv.role;
    } catch {
      // no invocation
    }
    const lower = runId.toLowerCase();
    const isReviewer =
      role === "reviewer" || lower.startsWith("review") || lower.startsWith("reviewer");
    if (isReviewer) {
      reviewerRunCount += 1;
      reviewerCostUsd += runCost;
      reviewerTokens += runTokens;
      axisWallMs += runAxisWall;
    }
  }

  return {
    runCount: runIds.length,
    reviewerRunCount,
    costUsd,
    totalTokens,
    reviewerCostUsd,
    reviewerTokens,
    axisWallMs,
  };
}

export async function independentLatestLegActivity(
  ledgerDir: string,
  issueNumber: number,
): Promise<{
  runId: string;
  startedAt?: string;
  lastActivityAt?: string;
  mtimeMs: number;
  hasAcceptedResult: boolean;
  acceptedResultStatus?: string;
} | undefined> {
  const runsDir = join(ledgerDir, "issues", String(issueNumber), "runs");
  let runIds: string[] = [];
  try {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (runIds.length === 0) return undefined;

  const readJsonl = async (path: string): Promise<Record<string, unknown>[]> => {
    const text = await readFile(path, "utf8");
    const out: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Independent scan skips malformed lines.
      }
    }
    return out;
  };

  const listJsonl = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(dir, e.name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  const maxMtime = async (paths: readonly string[]): Promise<number> => {
    let max = 0;
    for (const path of paths) {
      try {
        const ms = (await lstat(path)).mtimeMs;
        if (Number.isFinite(ms) && ms > max) max = ms;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return max;
  };

  type RunProbe = {
    runId: string;
    startedAt: string;
    lastActivityAt?: string;
    mtimeMs: number;
    hasAcceptedResult: boolean;
    acceptedResultStatus?: string;
  };
  const probes: RunProbe[] = [];

  for (const runId of runIds) {
    const sessionDir = join(runsDir, runId, "session");
    const parentFiles = await listJsonl(sessionDir);
    const axisFiles = await listJsonl(join(sessionDir, "reviewer-legs"));
    const parentRows: Record<string, unknown>[] = [];
    for (const f of parentFiles) parentRows.push(...(await readJsonl(f)));

    let startedAt: string | undefined;
    for (const row of parentRows) {
      if (row.type === "session" && typeof row.timestamp === "string") {
        startedAt = row.timestamp;
        break;
      }
      if (!startedAt && typeof row.timestamp === "string") startedAt = row.timestamp;
    }
    // Session-start order requires a start key; runs without timestamps sort last via "".
    const startKey = startedAt ?? "";

    let lastActivityAt: string | undefined;
    for (const row of parentRows) {
      if (typeof row.timestamp === "string" && row.timestamp) lastActivityAt = row.timestamp;
    }
    for (const f of axisFiles) {
      const legRows = await readJsonl(f);
      let legEnd: string | undefined;
      for (const row of legRows) {
        if (typeof row.timestamp === "string" && row.timestamp) legEnd = row.timestamp;
      }
      if (legEnd !== undefined && (lastActivityAt === undefined || legEnd > lastActivityAt)) {
        lastActivityAt = legEnd;
      }
    }

    let hasAcceptedResult = false;
    let acceptedResultStatus: string | undefined;
    for (const row of parentRows) {
      const message =
        row.message && typeof row.message === "object" && !Array.isArray(row.message)
          ? (row.message as Record<string, unknown>)
          : undefined;
      if (!message || message.role !== "toolResult") continue;
      if (typeof message.toolName !== "string" || !isTerminatingToolName(message.toolName)) continue;
      if (message.isError === true) continue;
      if (!message.details || typeof message.details !== "object" || Array.isArray(message.details)) {
        continue;
      }
      try {
        const details = validateAcceptedDetails(
          message.toolName as TerminatingToolName,
          message.details,
        );
        const facts = acceptedFacts(message.toolName as TerminatingToolName, details);
        hasAcceptedResult = true;
        acceptedResultStatus = facts.status ?? "";
      } catch (error) {
        if (error instanceof AcceptedDetailsContractError) continue;
        throw error;
      }
    }

    probes.push({
      runId,
      startedAt: startKey,
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      mtimeMs: await maxMtime([...parentFiles, ...axisFiles]),
      hasAcceptedResult,
      ...(acceptedResultStatus !== undefined ? { acceptedResultStatus } : {}),
    });
  }

  probes.sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt.localeCompare(b.startedAt);
    return a.runId.localeCompare(b.runId);
  });
  const latest = probes.at(-1);
  if (!latest) return undefined;
  return {
    runId: latest.runId,
    ...(latest.startedAt ? { startedAt: latest.startedAt } : {}),
    ...(latest.lastActivityAt !== undefined ? { lastActivityAt: latest.lastActivityAt } : {}),
    mtimeMs: latest.mtimeMs,
    hasAcceptedResult: latest.hasAcceptedResult,
    ...(latest.acceptedResultStatus !== undefined
      ? { acceptedResultStatus: latest.acceptedResultStatus }
      : {}),
  };
}

export function laneSortIdentity(entry: Record<string, string>): number {
  if (entry["data-family"] === "true") return Number(entry["data-parent"]);
  return Number(entry["data-ticket"]);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function ticket(
  partial: Partial<SnapshotTicket> & Pick<SnapshotTicket, "issueNumber" | "title" | "state">,
): SnapshotTicket {
  return {
    milestone: null,
    parentIssueNumber: null,
    blockedBy: [],
    closedAt: null,
    ...partial,
  };
}

export function topLevelLaneEntries(html: string, bookKey: string): Array<Record<string, string>> {
  const marker = `data-lane-tickets="${bookKey}"`;
  const markerAt = html.indexOf(marker);
  assert.ok(markerAt >= 0, `missing lane ${bookKey}`);
  const contentStart = html.indexOf(">", markerAt) + 1;
  // lane-tickets closes at the first </div> that returns depth to 0 after optional nested divs.
  let depth = 1;
  let i = contentStart;
  let contentEnd = html.length;
  while (i < html.length) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose < 0) break;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 4;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      contentEnd = nextClose;
      break;
    }
    i = nextClose + 6;
  }
  const chunk = html.slice(contentStart, contentEnd);
  const entries: Array<{ index: number; attrs: Record<string, string> }> = [];
  for (const m of chunk.matchAll(/<section\b[^>]*\bdata-family="true"[^>]*>/g)) {
    entries.push({ index: m.index ?? 0, attrs: attrsFromOpenTag(m[0]!) });
  }
  for (const m of chunk.matchAll(/<article\b[^>]*\bdata-ticket="\d+"[^>]*>/g)) {
    const attrs = attrsFromOpenTag(m[0]!);
    const cls = attrs.class ?? "";
    if (cls.split(/\s+/).includes("ticket-child")) continue;
    // Family parent article sits inside the family section — skip non-top-level by requiring
    // the article is not nested under a family open that hasn't closed. Approximate: only
    // articles whose nearest preceding family/section state is outside. Simpler: skip any
    // article that appears between a family open and its matching close in chunk.
    entries.push({ index: m.index ?? 0, attrs, _article: true } as {
      index: number;
      attrs: Record<string, string>;
      _article?: boolean;
    });
  }
  // Drop articles that fall inside a family section span.
  const familySpans: Array<{ start: number; end: number }> = [];
  for (const m of chunk.matchAll(/<section\b[^>]*\bdata-family="true"[^>]*>/g)) {
    const start = m.index ?? 0;
    // Find matching </section> with nesting.
    let d = 1;
    let j = start + m[0]!.length;
    let end = chunk.length;
    while (j < chunk.length) {
      const open = chunk.indexOf("<section", j);
      const close = chunk.indexOf("</section>", j);
      if (close < 0) break;
      if (open >= 0 && open < close) {
        d += 1;
        j = open + 8;
        continue;
      }
      d -= 1;
      if (d === 0) {
        end = close;
        break;
      }
      j = close + 10;
    }
    familySpans.push({ start, end });
  }
  const filtered = entries.filter((e) => {
    if (!(e as { _article?: boolean })._article) return true;
    return !familySpans.some((s) => e.index > s.start && e.index < s.end);
  });
  filtered.sort((a, b) => a.index - b.index);
  return filtered.map((e) => e.attrs);
}

export async function treeFingerprint(root: string): Promise<string> {
  const h = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = path.slice(root.length + 1).split(sep).join("/");
      h.update(rel);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) h.update(await readFile(path));
      else if (entry.isSymbolicLink()) h.update(`symlink:${entry.name}`);
    }
  }
  await walk(root);
  return h.digest("hex");
}

export function visibleTicketLabel(
  html: string,
  labelAttr: string,
  issueNumber: number,
  bookKey?: string,
): Record<string, string> | undefined {
  return elementsWith(html, labelAttr).find(
    (el) =>
      el[labelAttr] === String(issueNumber) &&
      (bookKey === undefined || el["data-book"] === bookKey),
  );
}

export class BoardSortElement {
  nodeType = 1;
  childNodes: BoardSortElement[] = [];
  parentNode: BoardSortElement | null = null;
  value = "";
  textContent = "";
  readonly style: Record<string, string> = {};
  private readonly attrs: Record<string, string>;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(attrs: Record<string, string> = {}) {
    this.attrs = { ...attrs };
  }

  get children(): BoardSortElement[] {
    return this.childNodes;
  }

  get firstChild(): BoardSortElement | null {
    return this.childNodes[0] ?? null;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name]! : null;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  appendChild(child: BoardSortElement): BoardSortElement {
    if (child.parentNode) {
      const sibs = child.parentNode.childNodes;
      const idx = sibs.indexOf(child);
      if (idx >= 0) sibs.splice(idx, 1);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: BoardSortElement): BoardSortElement {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  private matches(selector: string): boolean {
    const m = selector.match(/^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/);
    if (!m) return false;
    if (!this.hasAttribute(m[1]!)) return false;
    return m[2] === undefined || this.getAttribute(m[1]!) === m[2];
  }

  private walk(predicate: (el: BoardSortElement) => boolean, out: BoardSortElement[]): void {
    for (const child of this.childNodes) {
      if (predicate(child)) out.push(child);
      child.walk(predicate, out);
    }
  }

  querySelector(selector: string): BoardSortElement | null {
    const out: BoardSortElement[] = [];
    this.walk((el) => el.matches(selector), out);
    return out[0] ?? null;
  }

  querySelectorAll(selector: string): BoardSortElement[] {
    const out: BoardSortElement[] = [];
    this.walk((el) => el.matches(selector), out);
    return out;
  }
}
