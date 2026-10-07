/**
 * Durable run-page path rewrite after a run directory moves, plus retained-path
 * matching for live lookup. Pure path rewrite rules live in role-run-path-rewrite.ts
 * (sole authority); this module owns I/O walks that need dossier page readers.
 *
 * Scope is typed machine-consumed path fields only — never free text, never
 * caller file-flag path strings. Nested walk is confined to package-owned
 * `session/` seams.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { activationBookDirectory, physicalPathIdentity } from "./activation-ledger-topology.ts";
import { AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE } from "./compliance-transport.ts";
import { readRoleRunIdentity } from "./public-cli/run-lifecycle.ts";
import { findRoleRunDirectory, roleRunPlacement } from "./role-run-placement.ts";
import {
  INVOCATION_PAGE_PATH_FIELDS,
  PRINCIPAL_SESSION_PATH_FIELDS,
  RUN_STATE_PAGE_PATH_FIELDS,
  type RunDirectoryPathRewrite,
  projectTurnRequestLiveRunDirectory,
  rewriteAdmittedRoleRunPage,
  rewritePrincipalSessionPaths,
  rewriteRunDirectoryPathFields,
  rewriteRunDirectoryPathFieldsAgainstRewrites,
  rewriteRunDirectoryPathValue,
  rewriteRunDirectoryPathValueAgainstRewrites,
  rewriteSummonsMaterials,
} from "./role-run-path-rewrite.ts";
import { readPageSync, updateSectionSync } from "./run-dossier.ts";
import { isEnoent, isRecord } from "./unknown-value.ts";

// Re-export the pure path API so existing import sites stay on this module path.
export {
  PRINCIPAL_SESSION_PATH_FIELDS,
  type RunDirectoryPathRewrite,
  projectTurnRequestLiveRunDirectory,
  rewriteAdmittedRoleRunPage,
  rewritePrincipalSessionPaths,
  rewriteRunDirectoryPathFields,
  rewriteRunDirectoryPathFieldsAgainstRewrites,
  rewriteRunDirectoryPathValue,
  rewriteRunDirectoryPathValueAgainstRewrites,
} from "./role-run-path-rewrite.ts";

const OFFICER_POINTER_FIELDS = ["sessionFile", "runDirectory"] as const;
const SITIAN_RECORD_FIELDS = ["sessionParent"] as const;
const SESSION_HEADER_FIELDS = ["parentSession"] as const;
const BINDING_PARENT_FIELDS = ["sessionFile"] as const;

/** Match physical aliases or a normal unbound→ticket bind, never historical migration layouts. */
export async function retainedRunPathsMatch(
  recordedPath: unknown,
  currentPath: string,
  currentRunDirectory?: string,
): Promise<boolean> {
  if (recordedPath === currentPath) return true;
  if (typeof recordedPath !== "string") return false;
  const recordedPathIdentity = physicalPathIdentity(recordedPath);
  const currentPathIdentity = physicalPathIdentity(currentPath);
  if (recordedPathIdentity === currentPathIdentity) return true;
  if (currentRunDirectory === undefined) return false;
  const runDirectory = physicalPathIdentity(currentRunDirectory);
  const identity = await readRoleRunIdentity(runDirectory);
  if (identity === undefined) return false;
  for (let directory = runDirectory; dirname(directory) !== directory; directory = dirname(directory)) {
    const ledgerHome = dirname(dirname(directory));
    if (directory !== activationBookDirectory(ledgerHome, identity.bookKey)) continue;
    const unbound = roleRunPlacement(ledgerHome, {
      bookKey: identity.bookKey,
      subject: { unbound: true },
      runId: identity.runId,
      role: identity.role,
    });
    if (rewriteRunDirectoryPathValue(recordedPathIdentity, unbound.runDirectory, runDirectory) !== currentPathIdentity) {
      return false;
    }
    const placed = await findRoleRunDirectory([directory], identity.runId, identity.role);
    return placed !== undefined && physicalPathIdentity(placed) === runDirectory;
  }
  return false;
}

function collectRewrites(input: {
  readonly oldRunDirectory: string;
  readonly newRunDirectory: string;
  readonly crossRunRewrites?: readonly RunDirectoryPathRewrite[];
}): readonly RunDirectoryPathRewrite[] {
  const own: RunDirectoryPathRewrite = {
    oldRunDirectory: input.oldRunDirectory,
    newRunDirectory: input.newRunDirectory,
  };
  if (
    input.crossRunRewrites === undefined ||
    input.crossRunRewrites.length === 0
  ) {
    return [own];
  }
  // Own pair first; duplicates of the same old path keep the first (own) target.
  const seen = new Set<string>([own.oldRunDirectory]);
  const out: RunDirectoryPathRewrite[] = [own];
  for (const rewrite of input.crossRunRewrites) {
    if (seen.has(rewrite.oldRunDirectory)) continue;
    seen.add(rewrite.oldRunDirectory);
    out.push(rewrite);
  }
  return out;
}

/** Pre-#1161 `session/auditor-roles/<officer>.pointer.json` (migrator input only). */
async function rewriteLegacyOfficerPointerFile(
  path: string,
  rewrites: readonly RunDirectoryPathRewrite[],
): Promise<void> {
  const page = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(page) || page.kind !== "direct-officer-run-pointer") return;
  const before = JSON.stringify(page);
  rewriteRunDirectoryPathFieldsAgainstRewrites(page, OFFICER_POINTER_FIELDS, rewrites);
  if (JSON.stringify(page) !== before) await writeFile(path, `${JSON.stringify(page)}\n`, "utf8");
}

async function rewriteSitianRecordsJsonl(
  path: string,
  rewrites: readonly RunDirectoryPathRewrite[],
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (raw.length === 0) return;
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  // split keeps a trailing empty slot when file ends with \n — preserve it.
  let changed = false;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "" && i === lines.length - 1 && endsWithNewline) {
      out.push("");
      continue;
    }
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (!isRecord(parsed)) {
      out.push(line);
      continue;
    }
    if (!("sessionParent" in parsed)) {
      out.push(line);
      continue;
    }
    const before = parsed.sessionParent;
    rewriteRunDirectoryPathFieldsAgainstRewrites(
      parsed,
      SITIAN_RECORD_FIELDS,
      rewrites,
    );
    if (parsed.sessionParent !== before) changed = true;
    out.push(JSON.stringify(parsed));
  }
  if (!changed) return;
  const body = out.join("\n");
  await writeFile(
    path,
    endsWithNewline && !body.endsWith("\n") ? `${body}\n` : body,
    "utf8",
  );
}

/**
 * Session transcript typed locators only: header.parentSession and
 * ak_auditor_parent_attempt_binding data.parent.sessionFile. Never message text.
 */
async function rewriteSessionTranscriptBindings(
  path: string,
  rewrites: readonly RunDirectoryPathRewrite[],
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (raw.length === 0) return;
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  let changed = false;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "" && i === lines.length - 1 && endsWithNewline) {
      out.push("");
      continue;
    }
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (!isRecord(parsed)) {
      out.push(line);
      continue;
    }
    let lineChanged = false;
    if (parsed.type === "session" && "parentSession" in parsed) {
      const before = parsed.parentSession;
      rewriteRunDirectoryPathFieldsAgainstRewrites(
        parsed,
        SESSION_HEADER_FIELDS,
        rewrites,
      );
      if (parsed.parentSession !== before) lineChanged = true;
    } else if (
      parsed.type === "custom" &&
      parsed.customType === AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE &&
      isRecord(parsed.data) &&
      isRecord(parsed.data.parent)
    ) {
      const parent = parsed.data.parent;
      const before = parent.sessionFile;
      rewriteRunDirectoryPathFieldsAgainstRewrites(
        parent,
        BINDING_PARENT_FIELDS,
        rewrites,
      );
      if (parent.sessionFile !== before) lineChanged = true;
    }
    if (lineChanged) changed = true;
    out.push(lineChanged ? JSON.stringify(parsed) : line);
  }
  if (!changed) return;
  const body = out.join("\n");
  await writeFile(
    path,
    endsWithNewline && !body.endsWith("\n") ? `${body}\n` : body,
    "utf8",
  );
}

/**
 * Package-owned nested seams under session/ only:
 * sitian records.jsonl,
 * session transcript typed parent bindings. Never walks caller file paths.
 */
async function rewriteNestedMachinePathPages(
  pagesDirectory: string,
  rewrites: readonly RunDirectoryPathRewrite[],
): Promise<void> {
  const sessionRoot = join(pagesDirectory, "session");
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".pointer.json")) {
        await rewriteLegacyOfficerPointerFile(path, rewrites);
      } else if (entry.name === "records.jsonl") {
        await rewriteSitianRecordsJsonl(path, rewrites);
      } else if (entry.name.endsWith(".jsonl")) {
        await rewriteSessionTranscriptBindings(path, rewrites);
      }
    }
  }
  await walk(sessionRoot);
}

/**
 * Rewrite the admitted / invocation / runState fact rows (typed run placement
 * paths only; caller --attach / --request-manifest paths stay as-is, #1165),
 * then nested package-owned session seams. Callers may rewrite before or after
 * the filesystem move/copy: `pagesDirectory` is where the pages currently live
 * on disk; path strings that still name `oldRunDirectory` become
 * `newRunDirectory`. `crossRunRewrites` covers officer/parent pointers that
 * landed under a different final placement.
 */
export async function rewriteRoleRunDurablePages(input: {
  readonly pagesDirectory: string;
  readonly oldRunDirectory: string;
  readonly newRunDirectory: string;
  readonly crossRunRewrites?: readonly RunDirectoryPathRewrite[];
}): Promise<void> {
  const { pagesDirectory } = input;
  const rewrites = collectRewrites(input);

  // One rewriter per page kind; each keeps its own field list.
  const pageRewriters: Readonly<Record<"admitted" | "invocation" | "runState", (page: Record<string, unknown>) => void>> = {
    admitted: (page) => rewriteAdmittedRoleRunPage(page, rewrites),
    invocation: (page) =>
      rewriteRunDirectoryPathFieldsAgainstRewrites(page, INVOCATION_PAGE_PATH_FIELDS, rewrites),
    runState: (page) => {
      rewriteRunDirectoryPathFieldsAgainstRewrites(page, RUN_STATE_PAGE_PATH_FIELDS, rewrites);
      if (isRecord(page.principal)) {
        rewriteRunDirectoryPathFieldsAgainstRewrites(
          page.principal,
          PRINCIPAL_SESSION_PATH_FIELDS,
          rewrites,
        );
      }
      // Open court summons: source-run locators only; caller attach paths stay (#1165).
      if (isRecord(page.currentCourt)) {
        rewriteSummonsMaterials(page.currentCourt.summons, rewrites);
      }
    },
  };
  // A page is rewritten only when its fact row exists — never gate on the rendering.
  for (const [section, rewrite] of Object.entries(pageRewriters) as [keyof typeof pageRewriters, (page: Record<string, unknown>) => void][]) {
    if (readPageSync(pagesDirectory, section) === undefined) continue;
    updateSectionSync(pagesDirectory, section, (current) => {
      const page = structuredClone(current);
      rewrite(page);
      return JSON.stringify(page) === JSON.stringify(current) ? undefined : page;
    });
  }
  // Runs from before #1161 (the one-shot book-topology migrator's input) keep these
  // as separate page files; the same rewriters apply. Nothing live writes them.
  for (const [file, rewrite] of [
    ["admitted-request.json", pageRewriters.admitted],
    ["invocation.json", pageRewriters.invocation],
    ["run-state.json", pageRewriters.runState],
  ] as const) {
    const path = join(pagesDirectory, file);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    const page = JSON.parse(raw) as Record<string, unknown>;
    const before = JSON.stringify(page);
    rewrite(page);
    if (JSON.stringify(page) !== before) {
      await writeFile(path, `${JSON.stringify(page, null, 2)}\n`, "utf8");
    }
  }

  await rewriteNestedMachinePathPages(pagesDirectory, rewrites);
}
