/**
 * GitHub ticket snapshot adapter (factory board S2).
 *
 * Thin layer: explicit book→repo bindings + open set (+ named closed drills)
 * → BoardSnapshot. Does not scan ledgers, does not guess git remote.
 *
 * Parent / blocked_by edges come from GitHub's native issue relationship API
 * (GraphQL parent + blockedBy). Binding or API failure throws — callers render
 * the error loudly; never invent an empty successful board.
 *
 * blockedBy is paginated to completion (or fails loudly). Never expose a
 * truncated first page as the full blocker set.
 */
import { createGhApiRunner, type GhApiRunner } from "./collector-github.ts";

export type BookRepoBinding = {
  bookKey: string;
  owner: string;
  repo: string;
};

export type TicketIssueState = "open" | "closed";

export type BlockedByEdge = {
  issueNumber: number;
  state: TicketIssueState;
};

export type SnapshotTicket = {
  issueNumber: number;
  title: string;
  state: TicketIssueState;
  /** Milestone title, or null when unset. */
  milestone: string | null;
  parentIssueNumber: number | null;
  /**
   * Issue closure timestamp (GitHub `closedAt`).
   * Required non-null when state is closed — landing cycle ends here, not at last ledger record.
   * Always null when state is open.
   */
  closedAt: string | null;
  blockedBy: readonly BlockedByEdge[];
};

export type BookSnapshot = {
  bookKey: string;
  owner: string;
  repo: string;
  tickets: readonly SnapshotTicket[];
};

export type BoardSnapshot = {
  books: readonly BookSnapshot[];
};

export type TicketSnapshotTransport = {
  listBookTickets(input: {
    owner: string;
    repo: string;
    closedIssueNumbers: readonly number[];
    /**
     * Retention clock (#162): when supplied, closed issues are drained completely
     * and the merge+24h candidate set is computed mechanically — family-shared
     * parent clock (root closedAt is the family's only exit clock), open-root
     * children 陪跑, named drills always resident. When absent, no closed drain runs.
     */
    retentionNow?: Date;
    signal?: AbortSignal;
  }): Promise<readonly SnapshotTicket[]>;
};

/** Retention window: merged tickets leave the default board closedAt+24h later. */
export const RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export class TicketSnapshotBindingError extends Error {
  readonly kind = "binding" as const;
  readonly bookKey: string;
  constructor(bookKey: string, message: string) {
    super(message);
    this.name = "TicketSnapshotBindingError";
    this.bookKey = bookKey;
  }
}

export class TicketSnapshotApiError extends Error {
  readonly kind = "api" as const;
  readonly bookKey: string;
  constructor(bookKey: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TicketSnapshotApiError";
    this.bookKey = bookKey;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be a non-empty string`);
  return trimmed;
}

function mapIssueState(raw: unknown): TicketIssueState {
  if (raw === "OPEN" || raw === "open") return "open";
  if (raw === "CLOSED" || raw === "closed") return "closed";
  throw new Error(`unexpected issue state: ${String(raw)}`);
}

type BlockedByPage = {
  edges: BlockedByEdge[];
  hasNextPage: boolean;
  endCursor: string | null;
};

/**
 * Parse one blockedBy connection page. Completeness requires pageInfo;
 * missing pageInfo is a loud failure (never treat a truncated first page as full).
 */
function parseBlockedByPage(raw: unknown, label: string): BlockedByPage {
  if (raw === undefined || raw === null) {
    return { edges: [], hasNextPage: false, endCursor: null };
  }
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) {
    throw new Error(`${label} invalid`);
  }
  const pageInfo = raw.pageInfo;
  if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") {
    throw new Error(`${label}.pageInfo missing — cannot establish blockedBy completeness`);
  }
  let endCursor: string | null = null;
  if (pageInfo.endCursor === null || pageInfo.endCursor === undefined) {
    endCursor = null;
  } else if (typeof pageInfo.endCursor === "string") {
    endCursor = pageInfo.endCursor;
  } else {
    throw new Error(`${label}.pageInfo.endCursor invalid`);
  }
  if (pageInfo.hasNextPage && !endCursor) {
    throw new Error(`${label}.pageInfo endCursor missing while hasNextPage`);
  }
  const edges: BlockedByEdge[] = [];
  for (const [index, node] of raw.nodes.entries()) {
    if (!isRecord(node) || typeof node.number !== "number") {
      throw new Error(`${label}.nodes[${index}] invalid`);
    }
    edges.push({
      issueNumber: node.number,
      state: mapIssueState(node.state),
    });
  }
  return {
    edges,
    hasNextPage: pageInfo.hasNextPage,
    endCursor,
  };
}

type ParsedTicketNode = {
  ticket: Omit<SnapshotTicket, "blockedBy">;
  blockedByPage: BlockedByPage;
};

function parseClosedAt(raw: unknown, label: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
    throw new Error(`${label}.closedAt invalid`);
  }
  return raw;
}

function parseTicketNode(raw: unknown, label: string): ParsedTicketNode {
  if (!isRecord(raw)) throw new Error(`${label} is not an object`);
  const number = raw.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new Error(`${label}.number invalid`);
  }
  if (typeof raw.title !== "string") throw new Error(`${label}.title missing`);
  const milestoneRaw = raw.milestone;
  let milestone: string | null = null;
  if (milestoneRaw === null || milestoneRaw === undefined) {
    milestone = null;
  } else if (isRecord(milestoneRaw) && typeof milestoneRaw.title === "string") {
    milestone = milestoneRaw.title;
  } else {
    throw new Error(`${label}.milestone invalid`);
  }

  let parentIssueNumber: number | null = null;
  if (raw.parent === null || raw.parent === undefined) {
    parentIssueNumber = null;
  } else if (isRecord(raw.parent) && typeof raw.parent.number === "number") {
    parentIssueNumber = raw.parent.number;
  } else {
    throw new Error(`${label}.parent invalid`);
  }

  const state = mapIssueState(raw.state);
  const closedAtRaw = parseClosedAt(raw.closedAt, label);
  if (state === "closed" && closedAtRaw === null) {
    throw new Error(`${label}.closedAt missing for closed issue`);
  }
  // Open tickets never carry a closure endpoint into landing-cycle math.
  const closedAt = state === "closed" ? closedAtRaw : null;

  return {
    ticket: {
      issueNumber: number,
      title: raw.title,
      state,
      milestone,
      parentIssueNumber,
      closedAt,
    },
    blockedByPage: parseBlockedByPage(raw.blockedBy, `${label}.blockedBy`),
  };
}

const BLOCKED_BY_PAGE_SIZE = 100;

function blockedBySelection(afterVar?: string): string {
  const afterArg = afterVar ? `, after: ${afterVar}` : "";
  return `blockedBy(first: ${BLOCKED_BY_PAGE_SIZE}${afterArg}) {
          pageInfo { hasNextPage endCursor }
          nodes { number state }
        }`;
}

function buildOpenIssuesQuery(): string {
  return `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        closedAt
        milestone { title }
        parent { number }
        ${blockedBySelection()}
      }
    }
  }
}`;
}

function buildClosedIssuesQuery(numbers: readonly number[]): string {
  const aliases = numbers
    .map(
      (n, index) => `
    c${index}: issue(number: ${n}) {
      number
      title
      state
      closedAt
      milestone { title }
      parent { number }
      ${blockedBySelection()}
    }`,
    )
    .join("\n");
  return `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    ${aliases}
  }
}`;
}

function buildClosedIssuesDrainQuery(): string {
  return `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: CLOSED, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        closedAt
        milestone { title }
        parent { number }
        ${blockedBySelection()}
      }
    }
  }
}`;
}

function buildBlockedByPageQuery(): string {
  return `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      ${blockedBySelection("$after")}
    }
  }
}`;
}

async function ghGraphql(
  runner: GhApiRunner,
  query: string,
  variables: Record<string, string | number | null>,
  signal?: AbortSignal,
): Promise<unknown> {
  const args = [
    "api",
    "graphql",
    "--hostname",
    "github.com",
    "--include",
    "-f",
    `query=${query}`,
  ];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null) {
      args.push("-F", `${key}=null`);
    } else if (typeof value === "number") {
      // GraphQL Int variables must be typed, not string-forced.
      args.push("-F", `${key}=${value}`);
    } else {
      args.push("-f", `${key}=${value}`);
    }
  }
  const response = await runner(args, signal === undefined ? {} : { signal });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GitHub GraphQL HTTP ${response.status}: ${response.bodyText.slice(0, 400)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.bodyText);
  } catch (error) {
    throw new Error("GitHub GraphQL returned malformed JSON", { cause: error });
  }
  if (!isRecord(payload)) throw new Error("GitHub GraphQL payload is not an object");
  if (payload.errors !== undefined) {
    const msg = JSON.stringify(payload.errors).slice(0, 600);
    throw new Error(`GitHub GraphQL errors: ${msg}`);
  }
  return payload.data;
}

/**
 * Drain blockedBy pages until complete. Never return a partial first page as full.
 */
async function completeBlockedBy(
  runner: GhApiRunner,
  owner: string,
  repo: string,
  issueNumber: number,
  firstPage: BlockedByPage,
  signal?: AbortSignal,
): Promise<BlockedByEdge[]> {
  const edges = [...firstPage.edges];
  let hasNextPage = firstPage.hasNextPage;
  let endCursor = firstPage.endCursor;
  while (hasNextPage) {
    if (!endCursor) {
      throw new Error(
        `blockedBy pagination incomplete for #${issueNumber}: missing endCursor`,
      );
    }
    const data = await ghGraphql(
      runner,
      buildBlockedByPageQuery(),
      { owner, repo, number: issueNumber, after: endCursor },
      signal,
    );
    if (!isRecord(data) || !isRecord(data.repository) || !isRecord(data.repository.issue)) {
      throw new Error(`blockedBy page missing for #${issueNumber}`);
    }
    const page = parseBlockedByPage(
      data.repository.issue.blockedBy,
      `blockedBy[#${issueNumber}]`,
    );
    edges.push(...page.edges);
    hasNextPage = page.hasNextPage;
    endCursor = page.endCursor;
  }
  return edges;
}

async function materializeTicket(
  runner: GhApiRunner,
  owner: string,
  repo: string,
  raw: unknown,
  label: string,
  signal?: AbortSignal,
): Promise<SnapshotTicket> {
  const parsed = parseTicketNode(raw, label);
  const blockedBy = await completeBlockedBy(
    runner,
    owner,
    repo,
    parsed.ticket.issueNumber,
    parsed.blockedByPage,
    signal,
  );
  return {
    ...parsed.ticket,
    blockedBy,
  };
}

export function createGhTicketSnapshotTransport(
  runner: GhApiRunner = createGhApiRunner(),
): TicketSnapshotTransport {
  return {
    async listBookTickets(input) {
      const owner = requireNonEmpty(input.owner, "owner");
      const repo = requireNonEmpty(input.repo, "repo");
      const retentionNow = input.retentionNow;
      if (retentionNow !== undefined && !Number.isFinite(retentionNow.getTime())) {
        throw new Error("retentionNow must be a finite Date");
      }
      const tickets = new Map<number, SnapshotTicket>();

      let after: string | null = null;
      for (;;) {
        const data = await ghGraphql(
          runner,
          buildOpenIssuesQuery(),
          { owner, repo, after },
          input.signal,
        );
        if (!isRecord(data) || !isRecord(data.repository)) {
          throw new Error("GitHub GraphQL repository missing");
        }
        const issues = data.repository.issues;
        if (!isRecord(issues) || !Array.isArray(issues.nodes)) {
          throw new Error("GitHub GraphQL issues connection missing");
        }
        for (const [index, node] of issues.nodes.entries()) {
          if (node === null) continue;
          const ticket = await materializeTicket(
            runner,
            owner,
            repo,
            node,
            `open[${index}]`,
            input.signal,
          );
          tickets.set(ticket.issueNumber, ticket);
        }
        const pageInfo = issues.pageInfo;
        if (
          !isRecord(pageInfo) ||
          typeof pageInfo.hasNextPage !== "boolean"
        ) {
          throw new Error("GitHub GraphQL pageInfo missing");
        }
        if (!pageInfo.hasNextPage) break;
        if (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor) {
          throw new Error("GitHub GraphQL endCursor missing");
        }
        after = pageInfo.endCursor;
      }

      if (retentionNow !== undefined) {
        // Closed drain: complete pagination only (never a truncated first page),
        // then the mechanical merge+24h candidate set with the family shared clock.
        const closedPool = new Map<number, SnapshotTicket>();
        let closedAfter: string | null = null;
        for (;;) {
          const data = await ghGraphql(
            runner,
            buildClosedIssuesDrainQuery(),
            { owner, repo, after: closedAfter },
            input.signal,
          );
          if (!isRecord(data) || !isRecord(data.repository)) {
            throw new Error("GitHub GraphQL repository missing");
          }
          const issues = data.repository.issues;
          if (!isRecord(issues) || !Array.isArray(issues.nodes)) {
            throw new Error("GitHub GraphQL closed issues connection missing");
          }
          for (const [index, node] of issues.nodes.entries()) {
            if (node === null) continue;
            const ticket = await materializeTicket(
              runner,
              owner,
              repo,
              node,
              `closedDrain[${index}]`,
              input.signal,
            );
            closedPool.set(ticket.issueNumber, ticket);
          }
          const pageInfo = issues.pageInfo;
          if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") {
            throw new Error("GitHub GraphQL closed issues pageInfo missing — cannot establish completeness");
          }
          if (!pageInfo.hasNextPage) break;
          if (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor) {
            throw new Error("GitHub GraphQL closed issues endCursor missing");
          }
          closedAfter = pageInfo.endCursor;
        }

        // Family roots from native parent edges across open ∪ closed (cycle-safe).
        const allByNumber = new Map<number, SnapshotTicket>([...tickets, ...closedPool]);
        const rootOf = (ticket: SnapshotTicket): SnapshotTicket => {
          const seen = new Set<number>();
          let current = ticket;
          for (;;) {
            if (seen.has(current.issueNumber)) return current;
            seen.add(current.issueNumber);
            const parentNumber = current.parentIssueNumber;
            if (parentNumber === null) return current;
            const parent = allByNumber.get(parentNumber);
            if (!parent) return current; // edge outside the book — self is the best clock
            current = parent;
          }
        };

        const nowMs = retentionNow.getTime();
        for (const candidate of closedPool.values()) {
          if (tickets.has(candidate.issueNumber)) continue;
          const root = rootOf(candidate);
          if (root.state === "open") {
            // 陪跑: merged children stay while the family root is open.
            tickets.set(candidate.issueNumber, candidate);
            continue;
          }
          const rootClosedAt = root.closedAt;
          if (rootClosedAt === null) {
            throw new Error(`closed family root #${root.issueNumber} missing closedAt`);
          }
          if (Date.parse(rootClosedAt) + RETENTION_WINDOW_MS > nowMs) {
            tickets.set(candidate.issueNumber, candidate);
          }
          // else: the family has exited (root closedAt+24h passed) — not supplied.
        }
      }

      const closedNumbers = [
        ...new Set(
          input.closedIssueNumbers.filter(
            (n) => Number.isInteger(n) && n > 0 && !tickets.has(n),
          ),
        ),
      ].sort((a, b) => a - b);

      // Fetch named closed issues in modest batches (alias query size).
      const batchSize = 20;
      for (let offset = 0; offset < closedNumbers.length; offset += batchSize) {
        const batch = closedNumbers.slice(offset, offset + batchSize);
        if (batch.length === 0) continue;
        const data = await ghGraphql(
          runner,
          buildClosedIssuesQuery(batch),
          { owner, repo },
          input.signal,
        );
        if (!isRecord(data) || !isRecord(data.repository)) {
          throw new Error("GitHub GraphQL repository missing for closed drills");
        }
        for (let index = 0; index < batch.length; index += 1) {
          const node = data.repository[`c${index}`];
          if (node === null || node === undefined) {
            throw new Error(
              `named closed issue #${batch[index]} not found in ${owner}/${repo}`,
            );
          }
          const ticket = await materializeTicket(
            runner,
            owner,
            repo,
            node,
            `closed[#${batch[index]}]`,
            input.signal,
          );
          tickets.set(ticket.issueNumber, ticket);
        }
      }

      return [...tickets.values()].sort((a, b) => a.issueNumber - b.issueNumber);
    },
  };
}

function assertBinding(binding: BookRepoBinding): { owner: string; repo: string } {
  if (!binding.bookKey.trim()) {
    throw new TicketSnapshotBindingError(binding.bookKey, "bookKey must be a non-empty string");
  }
  const owner = binding.owner?.trim() ?? "";
  const repo = binding.repo?.trim() ?? "";
  if (!owner || !repo) {
    throw new TicketSnapshotBindingError(
      binding.bookKey,
      `binding missing owner/repo for book ${binding.bookKey}`,
    );
  }
  return { owner, repo };
}

/**
 * Fetch a board snapshot from explicit book→repo bindings.
 * Never inspects git remotes. Transport failures become TicketSnapshotApiError.
 * Duplicate bookKey bindings fail closed before any transport work.
 */
export async function fetchBoardSnapshot(input: {
  bindings: readonly BookRepoBinding[];
  closedIssueNumbersByBook?: Readonly<Record<string, readonly number[]>>;
  /** Retention clock for the merge+24h candidate supply (#162); injected per fetch. */
  retentionNow?: Date;
  transport: TicketSnapshotTransport;
  signal?: AbortSignal;
}): Promise<BoardSnapshot> {
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) {
    throw new TicketSnapshotBindingError("", "bindings must be a non-empty array");
  }

  // Reject duplicate bookKeys before any API / ledger work — bookKey is the
  // sole join identity across bindings, snapshot books, and swimlanes.
  const seenBookKeys = new Set<string>();
  for (const binding of input.bindings) {
    const key = binding.bookKey;
    if (seenBookKeys.has(key)) {
      throw new TicketSnapshotBindingError(
        key,
        `duplicate bookKey binding: ${key}`,
      );
    }
    seenBookKeys.add(key);
  }

  const books: BookSnapshot[] = [];
  for (const binding of input.bindings) {
    const { owner, repo } = assertBinding(binding);
    const closedIssueNumbers = input.closedIssueNumbersByBook?.[binding.bookKey] ?? [];
    try {
      const tickets = await input.transport.listBookTickets({
        owner,
        repo,
        closedIssueNumbers,
        ...(input.retentionNow !== undefined ? { retentionNow: input.retentionNow } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      books.push({
        bookKey: binding.bookKey,
        owner,
        repo,
        tickets,
      });
    } catch (error) {
      if (error instanceof TicketSnapshotBindingError) throw error;
      const message =
        error instanceof Error
          ? error.message
          : `ticket snapshot API failed for book ${binding.bookKey}`;
      throw new TicketSnapshotApiError(
        binding.bookKey,
        `ticket snapshot API failed for book ${binding.bookKey}: ${message}`,
        { cause: error },
      );
    }
  }
  return { books };
}
