/**
 * #866 (T10): record-class partition migrators.
 * Builds migrators only — execution is #861.
 *
 * - ticket-provenance → <ticket>/ticket-provenance/ by subject ticket number
 * - submission-ledger / attempt-history → owning run's session/<kind>/
 * - misplaced rows of these kinds (content shape) rehomed the same way
 */
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import {
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import { S4_SUBMISSION_LEDGER_KINDS } from "./sitian-appender.ts";
import { TICKET_PROVENANCE_HUMAN_VIEW } from "./ticket-provenance-contracts.ts";

const TICKET_PROVENANCE_KIND = "ticket-provenance";
const ATTEMPT_HISTORY_KIND = "attempt-history";
const SUBMISSION_LEDGER_CATEGORY = "submission-ledger";
const ATTEMPT_HISTORY_CATEGORY = "attempt-history";
const TICKET_PROVENANCE_CATEGORY = "ticket-provenance";

const TICKET_NUMBER_RE = /^[1-9][0-9]*$/;
const RUN_DIR_NAME_RE = /^([^@]+)@([^@]+)$/;
const HUMAN_VIEW_TICKET_RE = /^#\s*起居录\s*·\s*#([1-9][0-9]*)\b/m;

/** Partitions that may hold misplaced rows of the three record classes. */
const MISPLACED_SCAN_PARTITIONS = [
  "auditor-roles",
  "auditor",
  "attendance",
  "dispatch-error",
  "gate",
  "worker-submission-gate",
  "scratchpad",
] as const;

type JsonLine =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly raw: string }
  | { readonly ok: false; readonly raw: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonlLine(raw: string): JsonLine {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return { ok: false, raw };
    return { ok: true, value, raw };
  } catch {
    return { ok: false, raw };
  }
}

async function readJsonlLines(filePath: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // Preserve a trailing empty slot only when the file does not end with newline
  // so callers still see the final partial line; drop the usual terminal empty.
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

async function listBookKeys(booksDirectory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(booksDirectory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
}

async function listVolumeDirectories(partitionDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(partitionDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(partitionDir, entry.name));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
}

function sourceRelative(backupBooksDirectory: string, absolutePath: string): string {
  return relative(backupBooksDirectory, absolutePath).split(sep).join("/");
}

function ticketNumberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && TICKET_NUMBER_RE.test(value)) return Number(value);
  return undefined;
}

function ticketNumberFromSubject(subject: unknown): number | undefined {
  if (typeof subject === "string" || typeof subject === "number") {
    return ticketNumberFromUnknown(subject);
  }
  if (isRecord(subject)) {
    return ticketNumberFromUnknown(subject.ticketNumber);
  }
  return undefined;
}

function runIdFromSubject(subject: unknown): string | undefined {
  if (typeof subject === "string" && subject.length > 0) return subject;
  if (isRecord(subject) && typeof subject.runId === "string" && subject.runId.length > 0) {
    return subject.runId;
  }
  return undefined;
}

function roleFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.role === "string" && payload.role.length > 0) return payload.role;
  return undefined;
}

function runIdFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.runId === "string" && payload.runId.length > 0) return payload.runId;
  return undefined;
}

/** Extract runId@role from a sessionParent path when it points at a run session. */
function runCoordsFromSessionParent(sessionParent: unknown): { runId: string; role: string } | undefined {
  if (typeof sessionParent !== "string" || sessionParent.length === 0) return undefined;
  const normalized = sessionParent.replace(/\\/g, "/");
  const marker = "/runs/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  const after = normalized.slice(index + marker.length);
  const leaf = after.split("/")[0] ?? "";
  const match = RUN_DIR_NAME_RE.exec(leaf);
  if (match === null) return undefined;
  return { runId: match[1]!, role: match[2]! };
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(raw) ? raw : undefined;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    return undefined;
  }
}

/**
 * Ticket binding for a retained run directory — same priority as #865 runs migrator:
 * disk-recorded ticket first, then projectRoot basename when it is a ticket number.
 */
export async function resolveMigratingRunTicket(runDirectory: string): Promise<{
  readonly ticketNumber: number | undefined;
  readonly derivation:
    | { readonly method: "admitted-request" | "invocation" | "project-root-basename"; readonly source: string }
    | undefined;
}> {
  for (const page of ["admitted-request.json", "invocation.json"] as const) {
    const path = join(runDirectory, page);
    const body = await readJsonObject(path);
    if (body === undefined) continue;
    const direct = ticketNumberFromUnknown(body.ticketNumber);
    if (direct !== undefined) {
      return {
        ticketNumber: direct,
        derivation: { method: page === "admitted-request.json" ? "admitted-request" : "invocation", source: path },
      };
    }
    if (isRecord(body.subject)) {
      const fromSubject = ticketNumberFromUnknown(body.subject.ticketNumber);
      if (fromSubject !== undefined) {
        return {
          ticketNumber: fromSubject,
          derivation: { method: page === "admitted-request.json" ? "admitted-request" : "invocation", source: path },
        };
      }
    }
  }

  const admitted = await readJsonObject(join(runDirectory, "admitted-request.json"));
  const invocation = await readJsonObject(join(runDirectory, "invocation.json"));
  const projectRoot =
    (admitted !== undefined && typeof admitted.projectRoot === "string" ? admitted.projectRoot : undefined)
    ?? (invocation !== undefined && typeof invocation.projectRoot === "string" ? invocation.projectRoot : undefined);
  if (projectRoot !== undefined) {
    const leaf = basename(projectRoot.replace(/\\/g, "/"));
    const ticketNumber = ticketNumberFromUnknown(leaf);
    if (ticketNumber !== undefined) {
      return {
        ticketNumber,
        derivation: { method: "project-root-basename", source: projectRoot },
      };
    }
  }
  return { ticketNumber: undefined, derivation: undefined };
}

async function findBackupRunDirectory(
  backupBookDir: string,
  runId: string,
): Promise<{ readonly runDirectory: string; readonly role: string } | undefined> {
  if (runId.trim() === "") return undefined;
  const subjectEntries = await readdir(backupBookDir, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as { code?: unknown }).code === "ENOENT") return [] as const;
      throw error;
    },
  );
  const subjectDirs = [
    "",
    ...subjectEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  ];
  for (const subject of subjectDirs) {
    const runsDir = subject === "" ? join(backupBookDir, "runs") : join(backupBookDir, subject, "runs");
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry === `${runId}@` || !entry.startsWith(`${runId}@`)) continue;
      const role = entry.slice(runId.length + 1);
      if (role.length === 0 || role.includes("@")) continue;
      return { runDirectory: join(runsDir, entry), role };
    }
  }
  return undefined;
}

function destinationRunDirectory(
  booksDirectory: string,
  bookKey: string,
  ticketNumber: number | undefined,
  runId: string,
  role: string,
): string {
  const subjectDirectory = ticketNumber !== undefined ? String(ticketNumber) : "unbound";
  return join(booksDirectory, bookKey, subjectDirectory, "runs", `${runId}@${role}`);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function existingIdentities(recordFile: string): Promise<Set<string>> {
  const identities = new Set<string>();
  for (const line of await readJsonlLines(recordFile)) {
    if (line.trim() === "") continue;
    const parsed = parseJsonlLine(line);
    if (!parsed.ok) continue;
    if (typeof parsed.value.identity === "string") identities.add(parsed.value.identity);
  }
  return identities;
}

/** Append JSONL rows, skipping identities already present at the destination. */
async function appendRecordLines(
  recordFile: string,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) return;
  await ensureDir(dirname(recordFile));
  const existing = await existingIdentities(recordFile);
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const parsed = parseJsonlLine(line);
    if (parsed.ok && typeof parsed.value.identity === "string" && existing.has(parsed.value.identity)) {
      continue;
    }
    if (parsed.ok && typeof parsed.value.identity === "string") {
      existing.add(parsed.value.identity);
    }
    out.push(line.endsWith("\n") ? line : `${line}\n`);
  }
  if (out.length === 0) return;
  await appendFile(recordFile, out.join(""), "utf8");
}

async function copyCompanionFiles(
  sourceDir: string,
  destDir: string,
  companions: readonly string[],
): Promise<void> {
  await ensureDir(destDir);
  for (const name of companions) {
    const from = join(sourceDir, name);
    try {
      await stat(from);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") continue;
      throw error;
    }
    await copyFile(from, join(destDir, name));
  }
}

function ticketFromHumanView(markdown: string): number | undefined {
  const match = HUMAN_VIEW_TICKET_RE.exec(markdown);
  if (match === null) return undefined;
  return Number(match[1]);
}

async function resolveTicketProvenanceTicket(
  volumeDir: string,
  records: readonly JsonLine[],
): Promise<number | undefined> {
  for (const line of records) {
    if (!line.ok) continue;
    const ticket = ticketNumberFromSubject(line.value.subject);
    if (ticket !== undefined) return ticket;
  }
  try {
    const human = await readFile(join(volumeDir, TICKET_PROVENANCE_HUMAN_VIEW), "utf8");
    return ticketFromHumanView(human);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

function isSubmissionLedgerKind(kind: unknown): boolean {
  return typeof kind === "string" && S4_SUBMISSION_LEDGER_KINDS.has(kind);
}

function recordClassOfKind(kind: unknown):
  | typeof TICKET_PROVENANCE_CATEGORY
  | typeof SUBMISSION_LEDGER_CATEGORY
  | typeof ATTEMPT_HISTORY_CATEGORY
  | undefined {
  if (kind === TICKET_PROVENANCE_KIND) return TICKET_PROVENANCE_CATEGORY;
  if (kind === ATTEMPT_HISTORY_KIND) return ATTEMPT_HISTORY_CATEGORY;
  if (isSubmissionLedgerKind(kind)) return SUBMISSION_LEDGER_CATEGORY;
  return undefined;
}

type RunPlacementTarget = {
  readonly runDirectory: string;
  readonly disposition: "placed" | "unbound";
};

async function resolveRunOwnedDestination(
  context: BookTopologyMigrationContext,
  bookKey: string,
  runId: string,
  hints: {
    readonly role?: string;
    readonly sessionParent?: unknown;
  },
): Promise<RunPlacementTarget | { readonly disposition: "discarded" }> {
  const backupBookDir = join(context.backupBooksDirectory, bookKey);

  // Prefer a run already migrated into the destination tree (when #865 ran first).
  const existingDest = await findBackupRunDirectory(join(context.booksDirectory, bookKey), runId);
  if (existingDest !== undefined) {
    const underUnbound = existingDest.runDirectory.includes(`${sep}unbound${sep}runs${sep}`);
    return {
      runDirectory: existingDest.runDirectory,
      disposition: underUnbound ? "unbound" : "placed",
    };
  }

  const backupRun = await findBackupRunDirectory(backupBookDir, runId);
  if (backupRun === undefined) {
    // No retained run in backup or destination — test debris / unplaceable (US27).
    // Do not invent unbound run skeletons from payload.role alone.
    return { disposition: "discarded" };
  }

  const role = backupRun.role ?? hints.role ?? runCoordsFromSessionParent(hints.sessionParent)?.role;
  if (role === undefined) {
    return { disposition: "discarded" };
  }

  const ticketNumber = (await resolveMigratingRunTicket(backupRun.runDirectory)).ticketNumber;
  const runDirectory = destinationRunDirectory(
    context.booksDirectory,
    bookKey,
    ticketNumber,
    runId,
    role,
  );
  return {
    runDirectory,
    disposition: ticketNumber !== undefined ? "placed" : "unbound",
  };
}

async function migrateTicketProvenanceBook(
  context: BookTopologyMigrationContext,
  bookKey: string,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const backupPartition = join(context.backupBooksDirectory, bookKey, TICKET_PROVENANCE_CATEGORY);
  const volumes = await listVolumeDirectories(backupPartition);
  for (const volumeDir of volumes) {
    const source = sourceRelative(context.backupBooksDirectory, volumeDir);
    const recordFile = join(volumeDir, "records.jsonl");
    const rawLines = await readJsonlLines(recordFile);
    const parsedLines = rawLines.map(parseJsonlLine);
    const ticketNumber = await resolveTicketProvenanceTicket(volumeDir, parsedLines);

    if (ticketNumber === undefined) {
      // Keep the bytes under unbound so the volume is not silently dropped.
      const destDir = join(
        context.booksDirectory,
        bookKey,
        "unbound",
        TICKET_PROVENANCE_CATEGORY,
        basename(volumeDir),
      );
      await ensureDir(destDir);
      if (rawLines.length > 0) {
        await appendRecordLines(join(destDir, "records.jsonl"), rawLines);
      } else {
        await appendFile(join(destDir, "records.jsonl"), "", "utf8");
      }
      await copyCompanionFiles(volumeDir, destDir, [TICKET_PROVENANCE_HUMAN_VIEW, "offered-identities.jsonl"]);
      outcomes.push({ disposition: "unbound", source });
      continue;
    }

    const destDir = join(
      context.booksDirectory,
      bookKey,
      String(ticketNumber),
      TICKET_PROVENANCE_CATEGORY,
    );
    await ensureDir(destDir);
    if (rawLines.length > 0) {
      await appendRecordLines(join(destDir, "records.jsonl"), rawLines);
    } else {
      // Preserve empty court volumes (ADR 0075: 每票一份).
      try {
        await stat(join(destDir, "records.jsonl"));
      } catch {
        await appendFile(join(destDir, "records.jsonl"), "", "utf8");
      }
    }
    await copyCompanionFiles(volumeDir, destDir, [TICKET_PROVENANCE_HUMAN_VIEW, "offered-identities.jsonl"]);
    outcomes.push({ disposition: "placed", source });
  }

  // Already-nested ticket volumes under <ticket>/ticket-provenance/ (partial nesting era).
  const backupBookDir = join(context.backupBooksDirectory, bookKey);
  let ticketDirs: string[] = [];
  try {
    ticketDirs = (await readdir(backupBookDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && TICKET_NUMBER_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  for (const ticket of ticketDirs) {
    const nestedDir = join(backupBookDir, ticket, TICKET_PROVENANCE_CATEGORY);
    try {
      await stat(nestedDir);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") continue;
      throw error;
    }
    const source = sourceRelative(context.backupBooksDirectory, nestedDir);
    const rawLines = await readJsonlLines(join(nestedDir, "records.jsonl"));
    const destDir = join(context.booksDirectory, bookKey, ticket, TICKET_PROVENANCE_CATEGORY);
    await ensureDir(destDir);
    if (rawLines.length > 0) {
      await appendRecordLines(join(destDir, "records.jsonl"), rawLines);
    } else {
      try {
        await stat(join(destDir, "records.jsonl"));
      } catch {
        await appendFile(join(destDir, "records.jsonl"), "", "utf8");
      }
    }
    await copyCompanionFiles(nestedDir, destDir, [TICKET_PROVENANCE_HUMAN_VIEW, "offered-identities.jsonl"]);
    outcomes.push({ disposition: "placed", source });
  }
}

async function migrateRunOwnedPartitionBook(
  context: BookTopologyMigrationContext,
  bookKey: string,
  category: typeof SUBMISSION_LEDGER_CATEGORY | typeof ATTEMPT_HISTORY_CATEGORY,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const backupPartition = join(context.backupBooksDirectory, bookKey, category);
  const volumes = await listVolumeDirectories(backupPartition);
  for (const volumeDir of volumes) {
    const source = sourceRelative(context.backupBooksDirectory, volumeDir);
    const rawLines = await readJsonlLines(join(volumeDir, "records.jsonl"));
    if (rawLines.length === 0) {
      outcomes.push({ disposition: "discarded", source });
      continue;
    }

    let runId: string | undefined;
    let role: string | undefined;
    let sessionParent: unknown;
    const validLines: string[] = [];
    let sawMalformed = false;
    let malformedRaw = "";

    for (const raw of rawLines) {
      if (raw.trim() === "") continue;
      const parsed = parseJsonlLine(raw);
      if (!parsed.ok) {
        sawMalformed = true;
        malformedRaw = raw;
        // Keep exact bytes with the volume destination when we can place it.
        validLines.push(raw);
        continue;
      }
      validLines.push(raw);
      runId ??= runIdFromSubject(parsed.value.subject) ?? runIdFromPayload(parsed.value.payload);
      role ??= roleFromPayload(parsed.value.payload);
      sessionParent ??= parsed.value.sessionParent;
      const fromParent = runCoordsFromSessionParent(parsed.value.sessionParent);
      if (fromParent !== undefined) {
        runId ??= fromParent.runId;
        role ??= fromParent.role;
      }
    }

    if (runId === undefined) {
      // Unplaceable volume: keep exact malformed bytes in the report when present.
      if (sawMalformed) {
        outcomes.push({
          disposition: "unbound",
          source,
          malformed: true,
          malformedRaw,
        });
      } else {
        outcomes.push({ disposition: "discarded", source });
      }
      continue;
    }

    const target = await resolveRunOwnedDestination(context, bookKey, runId, {
      ...(role === undefined ? {} : { role }),
      ...(sessionParent === undefined ? {} : { sessionParent }),
    });
    if (target.disposition === "discarded") {
      if (sawMalformed) {
        outcomes.push({
          disposition: "unbound",
          source,
          malformed: true,
          malformedRaw,
        });
      } else {
        outcomes.push({ disposition: "discarded", source });
      }
      continue;
    }

    const destFile = join(target.runDirectory, "session", category, "records.jsonl");
    await appendRecordLines(destFile, validLines);
    // Entry placed (or unbound with its run). Malformed lines are preserved as
    // exact bytes inside the destination volume; T8 malformedRows is for rows
    // that could not be attributed to any destination.
    outcomes.push({ disposition: target.disposition, source });
  }
}

async function migrateMisplacedBook(
  context: BookTopologyMigrationContext,
  bookKey: string,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const backupBookDir = join(context.backupBooksDirectory, bookKey);
  for (const partition of MISPLACED_SCAN_PARTITIONS) {
    const partitionDir = join(backupBookDir, partition);
    const files: string[] = [];
    async function walk(directory: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      }
    }
    await walk(partitionDir);

    for (const filePath of files) {
      const rawLines = await readJsonlLines(filePath);
      for (let index = 0; index < rawLines.length; index += 1) {
        const raw = rawLines[index]!;
        if (raw.trim() === "") continue;
        const source = `${sourceRelative(context.backupBooksDirectory, filePath)}#${index + 1}`;
        const parsed = parseJsonlLine(raw);
        if (!parsed.ok) {
          // Not our class — leave for the owning partition migrator.
          continue;
        }
        const recordClass = recordClassOfKind(parsed.value.kind);
        if (recordClass === undefined) continue;

        if (recordClass === TICKET_PROVENANCE_CATEGORY) {
          const ticketNumber = ticketNumberFromSubject(parsed.value.subject);
          if (ticketNumber === undefined) {
            const destDir = join(
              context.booksDirectory,
              bookKey,
              "unbound",
              TICKET_PROVENANCE_CATEGORY,
              createHash("sha256").update(raw).digest("hex").slice(0, 32),
            );
            await appendRecordLines(join(destDir, "records.jsonl"), [raw]);
            outcomes.push({ disposition: "unbound", source });
            continue;
          }
          const destFile = join(
            context.booksDirectory,
            bookKey,
            String(ticketNumber),
            TICKET_PROVENANCE_CATEGORY,
            "records.jsonl",
          );
          await appendRecordLines(destFile, [raw]);
          outcomes.push({ disposition: "placed", source });
          continue;
        }

        const runId =
          runIdFromSubject(parsed.value.subject)
          ?? runIdFromPayload(parsed.value.payload)
          ?? runCoordsFromSessionParent(parsed.value.sessionParent)?.runId;
        if (runId === undefined) {
          outcomes.push({ disposition: "discarded", source });
          continue;
        }
        const role =
          roleFromPayload(parsed.value.payload)
          ?? runCoordsFromSessionParent(parsed.value.sessionParent)?.role;
        const target = await resolveRunOwnedDestination(context, bookKey, runId, {
          ...(role === undefined ? {} : { role }),
          ...(parsed.value.sessionParent === undefined ? {} : { sessionParent: parsed.value.sessionParent }),
        });
        if (target.disposition === "discarded") {
          outcomes.push({ disposition: "discarded", source });
          continue;
        }
        const destFile = join(target.runDirectory, "session", recordClass, "records.jsonl");
        await appendRecordLines(destFile, [raw]);
        outcomes.push({ disposition: target.disposition, source });
      }
    }
  }
}

async function forEachBook(
  context: BookTopologyMigrationContext,
  body: (bookKey: string) => Promise<void>,
): Promise<void> {
  for (const bookKey of await listBookKeys(context.backupBooksDirectory)) {
    await body(bookKey);
  }
}

export const ticketProvenancePartitionMigrator: BookTopologyPartitionMigrator = {
  partition: TICKET_PROVENANCE_CATEGORY,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey) => migrateTicketProvenanceBook(context, bookKey, outcomes));
    return reconcileMigrationPartition(TICKET_PROVENANCE_CATEGORY, "entries", outcomes);
  },
};

export const submissionLedgerPartitionMigrator: BookTopologyPartitionMigrator = {
  partition: SUBMISSION_LEDGER_CATEGORY,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey) =>
      migrateRunOwnedPartitionBook(context, bookKey, SUBMISSION_LEDGER_CATEGORY, outcomes));
    return reconcileMigrationPartition(SUBMISSION_LEDGER_CATEGORY, "entries", outcomes);
  },
};

export const attemptHistoryPartitionMigrator: BookTopologyPartitionMigrator = {
  partition: ATTEMPT_HISTORY_CATEGORY,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey) =>
      migrateRunOwnedPartitionBook(context, bookKey, ATTEMPT_HISTORY_CATEGORY, outcomes));
    return reconcileMigrationPartition(ATTEMPT_HISTORY_CATEGORY, "entries", outcomes);
  },
};

/** Content-shape rescue for the three record classes that landed outside their home partition. */
export const misplacedRecordClassPartitionMigrator: BookTopologyPartitionMigrator = {
  partition: "misplaced-record-class",
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey) => migrateMisplacedBook(context, bookKey, outcomes));
    return reconcileMigrationPartition("misplaced-record-class", "lines", outcomes);
  },
};

/** #866 migrators in assembly order (home partitions, then misplaced rescue). */
export const BOOK_TOPOLOGY_RECORD_CLASS_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  ticketProvenancePartitionMigrator,
  submissionLedgerPartitionMigrator,
  attemptHistoryPartitionMigrator,
  misplacedRecordClassPartitionMigrator,
];
