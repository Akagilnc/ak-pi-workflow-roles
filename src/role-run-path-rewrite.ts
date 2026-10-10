/**
 * Sole pure authority for typed run-directory path rewrite / projection.
 * No dossier I/O — run-dossier render and role-run-relocation durable walks
 * both consume this module (avoids a cycle through page readers).
 *
 * Scope is typed machine-consumed path fields only — never free text, never
 * caller file-flag path strings.
 */
import { sep } from "node:path";

import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
} from "./host-contracts.ts";
import { expandSessionDirectory } from "./role-run-placement.ts";
import { isRecord } from "./unknown-value.ts";

export const ADMITTED_PAGE_PATH_FIELDS = [
  "runDirectory",
  "admittedRequestPath", // pre-#1161 pages only
  "sessionDirectory",
  "sessionFile",
  // #1165/#1168: caller file-flag paths stay as given.
  "mergerInputPath",
  "sourceRunPath",
] as const;

export const INVOCATION_PAGE_PATH_FIELDS = [
  "runDirectory",
  "sessionDirectory",
  "sessionFile",
] as const;

export const RUN_STATE_PAGE_PATH_FIELDS = [
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

export type RunDirectoryPathRewrite = {
  readonly oldRunDirectory: string;
  readonly newRunDirectory: string;
};

/**
 * #1199: when runs move unbound→ticket, sessions move as siblings under
 * `<subject>/sessions/<leaf>`. Expand each run rewrite with that pair so typed
 * sessionDirectory/sessionFile fields rewrite with the same authority.
 */
export function withSessionSiblingRewrites(
  rewrites: readonly RunDirectoryPathRewrite[],
): readonly RunDirectoryPathRewrite[] {
  const out: RunDirectoryPathRewrite[] = [];
  const seen = new Set<string>();
  const push = (pair: RunDirectoryPathRewrite): void => {
    const key = `${pair.oldRunDirectory}\0${pair.newRunDirectory}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(pair);
  };
  for (const pair of rewrites) {
    push(pair);
    const oldExpand = expandSessionDirectory(pair.oldRunDirectory);
    const newExpand = expandSessionDirectory(pair.newRunDirectory);
    if (
      oldExpand !== undefined
      && newExpand !== undefined
      && oldExpand !== newExpand
    ) {
      push({ oldRunDirectory: oldExpand, newRunDirectory: newExpand });
    }
  }
  return out;
}

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

/** Principal session paths only — shared live + durable projection after a run move. */
export function rewritePrincipalSessionPaths(
  principal: Record<string, unknown>,
  oldRunDirectory: string,
  newRunDirectory: string,
): void {
  // One authority with withSessionSiblingRewrites: legacy run prefix + expand sibling.
  rewriteRunDirectoryPathFieldsAgainstRewrites(
    principal,
    PRINCIPAL_SESSION_PATH_FIELDS,
    withSessionSiblingRewrites([
      { oldRunDirectory, newRunDirectory },
    ]),
  );
}

/**
 * Live turn request: move runDirectory and keep principal session paths on the
 * new leaf. Sole path = host authority decode → rewrite coords copy → seal
 * (#1183 / #636). No shape-based in-place rewrite and no silent skip.
 */
export function projectTurnRequestLiveRunDirectory(
  request: {
    runDirectory: string;
    principal: DurablePrincipal;
  },
  newRunDirectory: string,
  authority: DurablePrincipalAuthority,
): void {
  const old = request.runDirectory;
  if (old === newRunDirectory) return;
  const coords = { ...authority.decode(request.principal) };
  rewritePrincipalSessionPaths(
    coords as Record<string, unknown>,
    old,
    newRunDirectory,
  );
  const sealed = authority.seal(coords);
  request.runDirectory = newRunDirectory;
  (request as { principal: DurablePrincipal }).principal = sealed;
}

/** Typed notary/source-run locator: only runDirectory is a path. */
export function rewriteSourceRunLocator(
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
export function rewriteSummonsMaterials(
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
  const expanded = withSessionSiblingRewrites(rewrites);
  rewriteRunDirectoryPathFieldsAgainstRewrites(page, ADMITTED_PAGE_PATH_FIELDS, expanded);
  rewriteSourceRunLocator(page.sourceRun, expanded);
  // #1165: admitted attachments are caller paths outside the run directory — do not rewrite.
  if (isRecord(page.principal)) {
    rewriteRunDirectoryPathFieldsAgainstRewrites(
      page.principal,
      PRINCIPAL_SESSION_PATH_FIELDS,
      expanded,
    );
  }
}

/**
 * #1183: current.json location fields follow the directory being rendered.
 * Fact rows stay as written (append-only); only the rendering projects stored→actual.
 * Returns the same object when already aligned. Caller file-flag paths stay opaque.
 */
export function projectRenderedPagePaths(
  page: Record<string, unknown>,
  actualRunDirectory: string,
): Record<string, unknown> {
  const stored =
    typeof page.runDirectory === "string" && page.runDirectory.trim() !== ""
      ? page.runDirectory
      : undefined;
  if (stored === undefined || stored === actualRunDirectory) return page;
  const projected = structuredClone(page);
  const rewrites: readonly RunDirectoryPathRewrite[] = [
    { oldRunDirectory: stored, newRunDirectory: actualRunDirectory },
  ];
  // Admitted field set is the location-field superset of invocation; runState adds
  // principal (covered) and optional currentCourt summons under this run.
  rewriteAdmittedRoleRunPage(projected, rewrites);
  if (isRecord(projected.currentCourt)) {
    rewriteSummonsMaterials(projected.currentCourt.summons, rewrites);
  }
  return projected;
}
