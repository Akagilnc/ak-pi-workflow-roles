/**
 * Sole pure authority for typed run-directory path rewrite / projection.
 * No dossier I/O — run-dossier render and role-run-relocation both consume
 * this module (avoids a cycle through page readers).
 *
 * Scope is typed machine-consumed path fields only — never free text, never
 * caller file-flag path strings.
 */
import { sep } from "node:path";

import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
} from "./host-contracts.ts";
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

/** Typed principal session coordinates rewritten when the owning run leaf moves. */
const PRINCIPAL_SESSION_PATH_FIELDS = [
  "sessionDirectory",
  "sessionFile",
] as const;

const SOURCE_RUN_LOCATOR_FIELDS = ["runDirectory"] as const;
const SUMMONS_PATH_FIELDS = ["sourceRunPath"] as const;

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

/** In-place rewrite of selected fields on one record. */
function rewriteRunDirectoryPathFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  oldRunDirectory: string,
  newRunDirectory: string,
): void {
  for (const field of fields) {
    if (field in record) {
      record[field] = rewriteRunDirectoryPathValue(
        record[field],
        oldRunDirectory,
        newRunDirectory,
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
  rewriteRunDirectoryPathFields(
    principal,
    PRINCIPAL_SESSION_PATH_FIELDS,
    oldRunDirectory,
    newRunDirectory,
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
  oldRunDirectory: string,
  newRunDirectory: string,
): void {
  if (!isRecord(value)) return;
  rewriteRunDirectoryPathFields(
    value,
    SOURCE_RUN_LOCATOR_FIELDS,
    oldRunDirectory,
    newRunDirectory,
  );
}

/** Same-ticket summons materials: typed source-run; caller attach paths stay as-is (#1165). */
function rewriteSummonsMaterials(
  value: unknown,
  oldRunDirectory: string,
  newRunDirectory: string,
): void {
  if (!isRecord(value)) return;
  rewriteRunDirectoryPathFields(
    value,
    SUMMONS_PATH_FIELDS,
    oldRunDirectory,
    newRunDirectory,
  );
  rewriteSourceRunLocator(value.sourceRun, oldRunDirectory, newRunDirectory);
  // #1165: summons.attachmentPaths are caller paths — do not rewrite.
}

/** Project one admitted page in memory after its containing run moved. */
export function rewriteAdmittedRoleRunPage(
  page: Record<string, unknown>,
  oldRunDirectory: string,
  newRunDirectory: string,
): void {
  rewriteRunDirectoryPathFields(
    page,
    ADMITTED_PAGE_PATH_FIELDS,
    oldRunDirectory,
    newRunDirectory,
  );
  rewriteSourceRunLocator(page.sourceRun, oldRunDirectory, newRunDirectory);
  // #1165: admitted attachments are caller paths outside the run directory — do not rewrite.
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
  // Admitted field set is the location-field superset of invocation and runState;
  // runState adds optional currentCourt summons under this run.
  rewriteAdmittedRoleRunPage(projected, stored, actualRunDirectory);
  if (isRecord(projected.currentCourt)) {
    rewriteSummonsMaterials(projected.currentCourt.summons, stored, actualRunDirectory);
  }
  return projected;
}
