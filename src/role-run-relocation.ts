/**
 * Single authority for rewriting durable run pages after a run directory moves.
 * Live unbound→ticket relocate and book-topology migration both call this.
 *
 * Scope is typed machine-consumed path fields only — never free text or
 * generated session transcript content.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
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
  "sourceRunPath",
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

const CURRENT_SESSION_FIELDS = ["sessionFile"] as const;
const OFFICER_POINTER_FIELDS = ["sessionFile", "runDirectory"] as const;
const SITIAN_RECORD_FIELDS = ["sessionParent"] as const;

export type RunDirectoryPathRewrite = {
  readonly oldRunDirectory: string;
  readonly newRunDirectory: string;
};

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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

async function rewriteJsonObjectFile(
  path: string,
  fields: readonly string[],
  rewrites: readonly RunDirectoryPathRewrite[],
): Promise<void> {
  if (!existsSync(path)) return;
  const page = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (page === null || typeof page !== "object" || Array.isArray(page)) return;
  const record = page as Record<string, unknown>;
  rewriteRunDirectoryPathFieldsAgainstRewrites(record, fields, rewrites);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function rewriteOfficerPointerFile(
  path: string,
  rewrites: readonly RunDirectoryPathRewrite[],
): Promise<void> {
  if (!existsSync(path)) return;
  const page = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (page === null || typeof page !== "object" || Array.isArray(page)) return;
  const record = page as Record<string, unknown>;
  // Only the typed direct-officer pointer shape — never arbitrary .pointer.json.
  if (record.kind !== "direct-officer-run-pointer") return;
  rewriteRunDirectoryPathFieldsAgainstRewrites(
    record,
    OFFICER_POINTER_FIELDS,
    rewrites,
  );
  await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function rewriteSitianRecordsJsonl(
  path: string,
  rewrites: readonly RunDirectoryPathRewrite[],
): Promise<void> {
  if (!existsSync(path)) return;
  const raw = await readFile(path, "utf8");
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
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      out.push(line);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (!("sessionParent" in record)) {
      out.push(line);
      continue;
    }
    const before = record.sessionParent;
    rewriteRunDirectoryPathFieldsAgainstRewrites(
      record,
      SITIAN_RECORD_FIELDS,
      rewrites,
    );
    if (record.sessionParent !== before) changed = true;
    out.push(JSON.stringify(record));
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
 * Nested machine-consumed path pages under a relocated run tree:
 * current-session.json, direct-officer *.pointer.json, sitian records.jsonl.
 * Does not open session transcripts or free-text files.
 */
async function rewriteNestedMachinePathPages(
  rootDirectory: string,
  rewrites: readonly RunDirectoryPathRewrite[],
): Promise<void> {
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
      if (entry.name === "current-session.json") {
        await rewriteJsonObjectFile(path, CURRENT_SESSION_FIELDS, rewrites);
      } else if (entry.name.endsWith(".pointer.json")) {
        await rewriteOfficerPointerFile(path, rewrites);
      } else if (entry.name === "records.jsonl") {
        await rewriteSitianRecordsJsonl(path, rewrites);
      }
    }
  }
  await walk(rootDirectory);
}

/**
 * Rewrite admitted-request / invocation / run-state path fields (and attachment
 * frozenPath), then nested machine-consumed path pages, after the run directory
 * has already been moved or copied.
 * `pagesDirectory` is where the pages now live; path strings still naming an
 * old run directory become the matching new directory. `crossRunRewrites`
 * covers officer/parent pointers that landed under a different final placement.
 */
export async function rewriteRoleRunDurablePages(input: {
  readonly pagesDirectory: string;
  readonly oldRunDirectory: string;
  readonly newRunDirectory: string;
  readonly crossRunRewrites?: readonly RunDirectoryPathRewrite[];
}): Promise<void> {
  const { pagesDirectory } = input;
  const rewrites = collectRewrites(input);

  const admittedPath = join(pagesDirectory, "admitted-request.json");
  if (existsSync(admittedPath)) {
    const page = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
      string,
      unknown
    >;
    rewriteRunDirectoryPathFieldsAgainstRewrites(
      page,
      ADMITTED_PAGE_FIELDS,
      rewrites,
    );
    if (Array.isArray(page.attachments)) {
      for (const attachment of page.attachments) {
        if (attachment !== null && typeof attachment === "object") {
          rewriteRunDirectoryPathFieldsAgainstRewrites(
            attachment as Record<string, unknown>,
            ["frozenPath"],
            rewrites,
          );
        }
      }
    }
    // Nested principal wire (sessionDirectory/sessionFile) when present.
    if (
      page.principal !== null &&
      typeof page.principal === "object" &&
      !Array.isArray(page.principal)
    ) {
      rewriteRunDirectoryPathFieldsAgainstRewrites(
        page.principal as Record<string, unknown>,
        ["sessionDirectory", "sessionFile"],
        rewrites,
      );
    }
    await writeFile(admittedPath, `${JSON.stringify(page, null, 2)}\n`, "utf8");
  }

  const invocationPath = join(pagesDirectory, "invocation.json");
  if (existsSync(invocationPath)) {
    const page = JSON.parse(await readFile(invocationPath, "utf8")) as Record<
      string,
      unknown
    >;
    rewriteRunDirectoryPathFieldsAgainstRewrites(
      page,
      INVOCATION_PAGE_FIELDS,
      rewrites,
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
    rewriteRunDirectoryPathFieldsAgainstRewrites(
      page,
      RUN_STATE_PAGE_FIELDS,
      rewrites,
    );
    if (
      page.principal !== null &&
      typeof page.principal === "object" &&
      !Array.isArray(page.principal)
    ) {
      rewriteRunDirectoryPathFieldsAgainstRewrites(
        page.principal as Record<string, unknown>,
        ["sessionDirectory", "sessionFile"],
        rewrites,
      );
    }
    await writeFile(statePath, `${JSON.stringify(page, null, 2)}\n`, "utf8");
  }

  await rewriteNestedMachinePathPages(pagesDirectory, rewrites);
}
