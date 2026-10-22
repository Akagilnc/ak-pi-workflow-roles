/** Shared DOM and filesystem fixtures for board behavior tests. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import vm from "node:vm";

import type { SnapshotTicket } from "../../src/ticket-snapshot.ts";

export type BoardPageSortMode = "ticket-asc" | "cost-desc" | "cost-asc";

export function attrsFromOpenTag(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/\b(data-[a-z0-9-]+|class|href)="([^"]*)"/g)) {
    attrs[m[1]!] = m[2]!;
  }
  return attrs;
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

export function laneSortIdentity(entry: Record<string, string>): number {
  if (entry["data-family"] === "true") return Number(entry["data-parent"]);
  return Number(entry["data-ticket"]);
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
