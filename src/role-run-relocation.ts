/**
 * Single authority for rewriting durable run pages after a run directory moves.
 * Live unbound→ticket relocate and book-topology migration both call this.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

const ADMITTED_PAGE_FIELDS = [
  "runDirectory",
  "admittedRequestPath",
  "sessionDirectory",
  "sessionFile",
  "taskPath",
  "packetPath",
  "prerequisitesPath",
  "requestManifestPath",
  "mergerInputPath",
] as const;

const INVOCATION_PAGE_FIELDS = [
  "runDirectory",
  "sessionDirectory",
  "sessionFile",
] as const;

const RUN_STATE_PAGE_FIELDS = [
  "runDirectory",
  "admittedRequestPath",
  "sessionDirectory",
  "sessionFile",
] as const;

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
export function rewriteRunDirectoryPathFields(
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

/**
 * Rewrite admitted-request / invocation / run-state path fields (and attachment
 * frozenPath) after the run directory has already been moved or copied.
 * `pagesDirectory` is where the pages now live; path strings still naming
 * `oldRunDirectory` become `newRunDirectory`.
 */
export async function rewriteRoleRunDurablePages(input: {
  readonly pagesDirectory: string;
  readonly oldRunDirectory: string;
  readonly newRunDirectory: string;
}): Promise<void> {
  const { pagesDirectory, oldRunDirectory, newRunDirectory } = input;

  const admittedPath = join(pagesDirectory, "admitted-request.json");
  if (existsSync(admittedPath)) {
    const page = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
      string,
      unknown
    >;
    rewriteRunDirectoryPathFields(
      page,
      ADMITTED_PAGE_FIELDS,
      oldRunDirectory,
      newRunDirectory,
    );
    if (Array.isArray(page.attachments)) {
      for (const attachment of page.attachments) {
        if (attachment !== null && typeof attachment === "object") {
          rewriteRunDirectoryPathFields(
            attachment as Record<string, unknown>,
            ["frozenPath"],
            oldRunDirectory,
            newRunDirectory,
          );
        }
      }
    }
    await writeFile(admittedPath, `${JSON.stringify(page, null, 2)}\n`, "utf8");
  }

  const invocationPath = join(pagesDirectory, "invocation.json");
  if (existsSync(invocationPath)) {
    const page = JSON.parse(await readFile(invocationPath, "utf8")) as Record<
      string,
      unknown
    >;
    rewriteRunDirectoryPathFields(
      page,
      INVOCATION_PAGE_FIELDS,
      oldRunDirectory,
      newRunDirectory,
    );
    await writeFile(
      invocationPath,
      `${JSON.stringify(page, null, 2)}\n`,
      "utf8",
    );
  }

  const statePath = join(pagesDirectory, "run-state.json");
  if (existsSync(statePath)) {
    const page = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    rewriteRunDirectoryPathFields(
      page,
      RUN_STATE_PAGE_FIELDS,
      oldRunDirectory,
      newRunDirectory,
    );
    await writeFile(statePath, `${JSON.stringify(page, null, 2)}\n`, "utf8");
  }
}
