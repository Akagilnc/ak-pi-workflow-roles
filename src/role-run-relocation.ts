/**
 * Single authority for rewriting durable run pages after a run directory moves.
 * Live callers project typed fields; only historical migrators walk durable pages.
 *
 * Scope is typed machine-consumed path fields only — never free text, never
 * caller file-flag path strings. Nested walk is confined to package-owned
 * `session/` seams.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import { activationBookDirectory, physicalPathIdentity } from "./activation-ledger-topology.ts";
import { readRoleRunIdentity } from "./public-cli/run-lifecycle.ts";
import { findRoleRunDirectory, roleRunPlacement } from "./role-run-placement.ts";

import { AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE } from "./compliance-transport.ts";

import { readPageSync, updateSectionSync } from "./run-dossier.ts";
import { isRecord, isEnoent } from "./unknown-value.ts";

const ADMITTED_PAGE_FIELDS = [
  "runDirectory",
  "admittedRequestPath", // pre-#1161 pages only
  "sessionDirectory",
  "sessionFile",
  // #1165/#1168: caller file-flag paths (requestManifestPath, prerequisitesPath)
  // stay as given. Obsolete copy fields (taskPath/packetPath) are not rewritten —
  // stock volumes keep their bytes; live relocate no longer maintains them.
  "mergerInputPath",
  "sourceRunPath",
] as const;

const INVOCATION_PAGE_FIELDS = [
  "runDirectory",
  "sessionDirectory",
  "sessionFile",
] as const;

const RUN_STATE_PAGE_FIELDS = [
  "runDirectory",
  "admittedRequestPath", // pre-#1161 pages only
  "sessionDirectory",
  "sessionFile",
] as const;

/** Typed principal session coordinates rewritten when the owning run leaf moves. */
export const PRINCIPAL_SESSION_PATH_FIELDS = [
  "sessionDirectory",
  "sessionFile",
] as const;

const SOURCE_RUN_LOCATOR_FIELDS = ["runDirectory"] as const;
const SUMMONS_PATH_FIELDS = ["sourceRunPath"] as const;
const OFFICER_POINTER_FIELDS = ["sessionFile", "runDirectory"] as const;
const SITIAN_RECORD_FIELDS = ["sessionParent"] as const;
const SESSION_HEADER_FIELDS = ["parentSession"] as const;
const BINDING_PARENT_FIELDS = ["sessionFile"] as const;

export type RunDirectoryPathRewrite = {
  readonly oldRunDirectory: string;
  readonly newRunDirectory: string;
};

/** Rewrite one path value that points at or under oldRunDirectory. */
export function rewriteRunDirectoryPathValue(
  value: unknown,
  oldRunDirectory: string,
  newRunDirectory: string,
): unknown {
  if (typeof value !== "string") return value;
  if (value === oldRunDirectory) return newRunDirectory;
  const prefix = `${oldRunDirectory}${sep}`;
  if (value.startsWith(prefix)) {
    return `${newRunDirectory}${value.slice(oldRunDirectory.length)}`;
  }
  return value;
}

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

/**
 * Apply the longest matching oldRunDirectory rewrite. Longer keys win so a
 * nested run path is not partially claimed by a shorter sibling prefix.
 */
export function rewriteRunDirectoryPathValueAgainstRewrites(
  value: unknown,
  rewrites: readonly RunDirectoryPathRewrite[],
): unknown {
  if (typeof value !== "string" || rewrites.length === 0) return value;
  let best: RunDirectoryPathRewrite | undefined;
  for (const rewrite of rewrites) {
    if (
      value === rewrite.oldRunDirectory ||
      value.startsWith(`${rewrite.oldRunDirectory}${sep}`)
    ) {
      if (
        best === undefined ||
        rewrite.oldRunDirectory.length > best.oldRunDirectory.length
      ) {
        best = rewrite;
      }
    }
  }
  if (best === undefined) return value;
  return rewriteRunDirectoryPathValue(
    value,
    best.oldRunDirectory,
    best.newRunDirectory,
  );
}

/** In-place rewrite of selected fields on one record (single pair). */
export function rewriteRunDirectoryPathFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  oldRunDirectory: string,
  newRunDirectory: string,
): void {
  rewriteRunDirectoryPathFieldsAgainstRewrites(record, fields, [
    { oldRunDirectory, newRunDirectory },
  ]);
}

/** Principal session paths only — shared live + durable projection after a run move. */
export function rewritePrincipalSessionPaths(
  principal: Record<string, unknown>,
  oldRunDirectory: string,
  newRunDirectory: string,
): void {
  rewriteRunDirectoryPathFields(
    principal,
    PRINCIPAL_SESSION_PATH_FIELDS,
    oldRunDirectory,
    newRunDirectory,
  );
}

/**
 * Live turn request: move runDirectory and rewrite principal session paths in place.
 * Callers that lack authority.seal use this; admitted refresh seals after the same rewrite.
 */
export function projectTurnRequestLiveRunDirectory(
  request: {
    runDirectory: string;
    principal: { sessionDirectory?: string; sessionFile?: string };
  },
  newRunDirectory: string,
): void {
  const old = request.runDirectory;
  if (old === newRunDirectory) return;
  request.runDirectory = newRunDirectory;
  rewritePrincipalSessionPaths(
    request.principal as Record<string, unknown>,
    old,
    newRunDirectory,
  );
}

/** In-place rewrite of selected fields against a rewrite set. */
export function rewriteRunDirectoryPathFieldsAgainstRewrites(
  record: Record<string, unknown>,
  fields: readonly string[],
  rewrites: readonly RunDirectoryPathRewrite[],
): void {
  for (const field of fields) {
    if (field in record) {
      record[field] = rewriteRunDirectoryPathValueAgainstRewrites(
        record[field],
        rewrites,
      );
    }
  }
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

/** Typed notary/source-run locator: only runDirectory is a path. */
function rewriteSourceRunLocator(
  value: unknown,
  rewrites: readonly RunDirectoryPathRewrite[],
): void {
  if (!isRecord(value)) return;
  rewriteRunDirectoryPathFieldsAgainstRewrites(
    value,
    SOURCE_RUN_LOCATOR_FIELDS,
    rewrites,
  );
}

/** Same-ticket summons materials: typed source-run; caller attach paths stay as-is (#1165). */
function rewriteSummonsMaterials(
  value: unknown,
  rewrites: readonly RunDirectoryPathRewrite[],
): void {
  if (!isRecord(value)) return;
  rewriteRunDirectoryPathFieldsAgainstRewrites(
    value,
    SUMMONS_PATH_FIELDS,
    rewrites,
  );
  rewriteSourceRunLocator(value.sourceRun, rewrites);
  // #1165: summons.attachmentPaths are caller paths — do not rewrite.
}

/** Project one admitted page in memory after its containing run moved. */
export function rewriteAdmittedRoleRunPage(
  page: Record<string, unknown>,
  rewrites: readonly RunDirectoryPathRewrite[],
): void {
  rewriteRunDirectoryPathFieldsAgainstRewrites(page, ADMITTED_PAGE_FIELDS, rewrites);
  rewriteSourceRunLocator(page.sourceRun, rewrites);
  // #1165: admitted attachments are caller paths outside the run directory — do not rewrite.
  if (isRecord(page.principal)) {
    rewriteRunDirectoryPathFieldsAgainstRewrites(
      page.principal,
      PRINCIPAL_SESSION_PATH_FIELDS,
      rewrites,
    );
  }
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
      rewriteRunDirectoryPathFieldsAgainstRewrites(page, INVOCATION_PAGE_FIELDS, rewrites),
    runState: (page) => {
      rewriteRunDirectoryPathFieldsAgainstRewrites(page, RUN_STATE_PAGE_FIELDS, rewrites);
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
