#!/usr/bin/env node
/**
 * Internal entry for the factory board full view (S2+S3).
 *
 * Not a public role CLI (ADR 0052). Not registered as a package bin.
 *
 * Book→repo bindings are explicit flags — never guessed from git remote.
 * S3 current-state / wallclock / cost are computed inside the render seam from
 * ledger runs + injected now — this script only supplies bindings and clock.
 * #162: the default board supplies merge+24h retention candidates (family shared
 * parent clock) from the snapshot seam; --watch re-loads the snapshot every tick
 * (the startup snapshot is never pinned).
 *
 *   npx tsx scripts/render-factory-board.ts \
 *     --book ak-pi-workflow-roles=~/.ak-roles/books/ak-pi-workflow-roles:Akagilnc/ak-pi-workflow-roles \
 *     --book ak-workflow-orchestrator=~/.ak-roles/books/ak-workflow-orchestrator:Akagilnc/ak-workflow-orchestrator \
 *     --closed ak-pi-workflow-roles=130 \
 *     --out /tmp/factory-board.html
 *
 * Optional --watch starts the production page lifecycle (regenerate on the
 * declared refresh boundary). Stop with Ctrl-C / SIGINT / SIGTERM.
 * One-shot (default) writes a page that does NOT advertise refresh.
 *
 * Output MUST sit outside every ledger. Ledgers are read-only.
 *
 * When --out is present but explicit --book binding is absent or malformed,
 * write a binding error page (data-board-error=binding) then exit nonzero —
 * do not terminate before any page exists.
 */
import { resolve } from "node:path";

import { createGhApiRunner } from "../src/collector-github.ts";
import {
  DEFAULT_REFRESH_BOUNDARY_SECONDS,
  startFactoryBoardPage,
  writeFactoryBoardPage,
  type FactoryBoardBook,
  type FactoryBoardView,
} from "../src/factory-board.ts";
import {
  createGhTicketSnapshotTransport,
  fetchBoardSnapshot,
  TicketSnapshotApiError,
  TicketSnapshotBindingError,
  type BookRepoBinding,
} from "../src/ticket-snapshot.ts";

function usage(): never {
  console.error(`Usage: npx tsx scripts/render-factory-board.ts --book <key>=<ledgerDir>:<owner>/<repo> [--book ...] [--closed <key>=<n,n>] --out <htmlPath> [--watch] [--refresh-seconds <n>]
  --book              explicit book binding (repeatable). ledgerDir + owner/repo required.
  --closed            optional named closed issues to drill, keyed by book (repeatable)
  --out               HTML output path (must be outside every ledger)
  --watch             keep regenerating within the refresh boundary until stopped
  --refresh-seconds   refresh boundary in seconds when --watch (default ${DEFAULT_REFRESH_BOUNDARY_SECONDS})
`);
  process.exit(2);
}

function allArgs(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name) {
      const value = process.argv[i + 1];
      if (value === undefined) usage();
      out.push(value);
    }
  }
  return out;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

type ParsedBook =
  | { ok: true; book: FactoryBoardBook; binding: BookRepoBinding }
  | { ok: false; message: string };

/** Parse `key=ledgerDir:owner/repo` without terminating — caller owns disposition. */
function parseBook(raw: string): ParsedBook {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    return { ok: false, message: `invalid --book (expected key=ledgerDir:owner/repo): ${raw}` };
  }
  const bookKey = raw.slice(0, eq);
  const rest = raw.slice(eq + 1);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) {
    return { ok: false, message: `invalid --book (missing :owner/repo): ${raw}` };
  }
  const ledgerDir = rest.slice(0, colon);
  const repoPart = rest.slice(colon + 1);
  const slash = repoPart.indexOf("/");
  if (slash <= 0 || slash === repoPart.length - 1) {
    return { ok: false, message: `invalid --book (owner/repo): ${raw}` };
  }
  const owner = repoPart.slice(0, slash);
  const repo = repoPart.slice(slash + 1);
  return {
    ok: true,
    book: { bookKey, ledgerDir: resolve(ledgerDir) },
    binding: { bookKey, owner, repo },
  };
}

/** Parse `key=1,2,3` */
function parseClosed(raw: string): { bookKey: string; numbers: number[] } {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    console.error(`invalid --closed (expected key=n,n): ${raw}`);
    process.exit(2);
  }
  const bookKey = raw.slice(0, eq);
  const numbers = raw
    .slice(eq + 1)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part));
  if (numbers.some((n) => !Number.isInteger(n) || n < 1)) {
    console.error(`invalid --closed numbers: ${raw}`);
    process.exit(2);
  }
  return { bookKey, numbers };
}

const bookArgs = allArgs("--book");
const closedArgs = allArgs("--closed");
const out = arg("--out");
const watch = process.argv.includes("--watch");
const refreshRaw = arg("--refresh-seconds");
// Without --out there is no page destination — usage only.
if (!out) usage();

const outputPath = resolve(out);
const refreshBoundarySeconds =
  refreshRaw !== undefined ? Number(refreshRaw) : DEFAULT_REFRESH_BOUNDARY_SECONDS;
if (!(refreshBoundarySeconds > 0) || !Number.isFinite(refreshBoundarySeconds)) {
  console.error("--refresh-seconds must be a positive finite number");
  process.exit(2);
}

async function writeBindingFailurePage(message: string, books: readonly FactoryBoardBook[] = []): Promise<never> {
  const view: FactoryBoardView = {
    ok: false,
    error: {
      kind: "binding",
      message,
    },
  };
  try {
    const result = await writeFactoryBoardPage({
      books,
      view,
      now: new Date(),
      outputPath,
    });
    console.error(`wrote ${result.outputPath} (error page)`);
    console.error(message);
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }
  process.exit(1);
}

if (bookArgs.length === 0) {
  await writeBindingFailurePage("explicit --book binding required (key=ledgerDir:owner/repo)");
}

const books: FactoryBoardBook[] = [];
const bindings: BookRepoBinding[] = [];
const seenBookKeys = new Set<string>();
for (const raw of bookArgs) {
  const parsed = parseBook(raw);
  if (!parsed.ok) {
    // Malformed binding: still emit the requested page as binding failure.
    await writeBindingFailurePage(parsed.message, books);
  }
  // bookKey is the sole lane/ledger join identity — duplicates fail closed before API.
  if (seenBookKeys.has(parsed.book.bookKey)) {
    await writeBindingFailurePage(
      `duplicate bookKey binding: ${parsed.book.bookKey}`,
      books,
    );
  }
  seenBookKeys.add(parsed.book.bookKey);
  books.push(parsed.book);
  bindings.push(parsed.binding);
}

const closedIssueNumbersByBook: Record<string, number[]> = {};
for (const raw of closedArgs) {
  const parsed = parseClosed(raw);
  closedIssueNumbersByBook[parsed.bookKey] = [
    ...(closedIssueNumbersByBook[parsed.bookKey] ?? []),
    ...parsed.numbers,
  ];
}

const transport = createGhTicketSnapshotTransport(createGhApiRunner());

/**
 * Default-board snapshot load (#162): open set + named drills + merge+24h retention
 * candidates, clock injected per call so watch ticks re-derive the candidate set.
 * Binding/API failures become loud error views; unexpected errors propagate.
 */
async function loadBoardView(): Promise<FactoryBoardView> {
  try {
    const snapshot = await fetchBoardSnapshot({
      bindings,
      closedIssueNumbersByBook,
      retentionNow: new Date(),
      transport,
    });
    return { ok: true, snapshot };
  } catch (error) {
    if (error instanceof TicketSnapshotBindingError) {
      return {
        ok: false,
        error: {
          kind: "binding",
          message: error.message,
          ...(error.bookKey ? { bookKey: error.bookKey } : {}),
        },
      };
    }
    if (error instanceof TicketSnapshotApiError) {
      return {
        ok: false,
        error: {
          kind: "api",
          message: error.message,
          ...(error.bookKey ? { bookKey: error.bookKey } : {}),
        },
      };
    }
    throw error;
  }
}

if (!watch) {
  // One-shot: no refresh declaration — page lifecycle matches actual behavior.
  try {
    const view = await loadBoardView();
    const result = await writeFactoryBoardPage({
      books,
      view,
      now: new Date(),
      outputPath,
    });
    console.error(`wrote ${result.outputPath}${view.ok ? "" : " (error page)"}`);
    process.exit(view.ok ? 0 : 1);
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }
}

// Watch: declare refresh bound and regenerate within it. The snapshot is re-loaded
// every tick (not pinned at startup); ledgers stay read-only.
let lastView: FactoryBoardView | undefined;
const handle = startFactoryBoardPage({
  books,
  loadView: async () => {
    lastView = await loadBoardView();
    return lastView;
  },
  outputPath,
  refreshBoundarySeconds,
});

let exiting = false;
const exitOnce = (code: number): void => {
  if (exiting) return;
  exiting = true;
  process.exit(code);
};

void handle.closed.then(
  () => undefined,
  (error) => {
    console.error(formatError(error));
    exitOnce(1);
  },
);

try {
  const first = await handle.started;
  const firstOk = lastView?.ok !== false;
  console.error(
    `wrote ${first.outputPath}${firstOk ? "" : " (error page)"}; watching every ${refreshBoundarySeconds}s (stop with SIGINT)`,
  );
  if (!firstOk) {
    await handle.stop().catch(() => undefined);
    exitOnce(1);
  }
} catch (error) {
  console.error(formatError(error));
  exitOnce(1);
}

const shutdown = async (signal: string) => {
  console.error(`stopping on ${signal}`);
  try {
    await handle.stop();
    exitOnce(0);
  } catch (error) {
    console.error(formatError(error));
    exitOnce(1);
  }
};

// Keepalive: the default scheduler unrefs its interval (a test-suite courtesy so
// injected-clock suites can exit); a production watch must own an explicit
// referenced handle or the process exits silently after the first render.
const keepalive = setInterval(() => undefined, 1 << 30);
handle.closed.finally(() => clearInterval(keepalive));

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
