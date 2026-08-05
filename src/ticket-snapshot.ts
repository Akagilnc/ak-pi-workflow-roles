/**
 * GitHub ticket snapshot adapter (factory board S2).
 *
 * Thin layer: explicit book→repo bindings + open set (+ named closed drills)
 * → BoardSnapshot. Does not scan ledgers, does not guess git remote.
 *
 * Parent / blocked_by edges come from GitHub's native issue relationship API
 * (GraphQL parent + blockedBy). Binding or API failure throws — callers render
 * the error loudly; never invent an empty successful board.
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
    signal?: AbortSignal;
  }): Promise<readonly SnapshotTicket[]>;
};

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

function parseTicketNode(raw: unknown, label: string): SnapshotTicket {
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

  const blockedBy: BlockedByEdge[] = [];
  const blockedContainer = raw.blockedBy;
  if (blockedContainer !== undefined && blockedContainer !== null) {
    if (!isRecord(blockedContainer) || !Array.isArray(blockedContainer.nodes)) {
      throw new Error(`${label}.blockedBy invalid`);
    }
    for (const [index, node] of blockedContainer.nodes.entries()) {
      if (!isRecord(node) || typeof node.number !== "number") {
        throw new Error(`${label}.blockedBy.nodes[${index}] invalid`);
      }
      blockedBy.push({
        issueNumber: node.number,
        state: mapIssueState(node.state),
      });
    }
  }

  return {
    issueNumber: number,
    title: raw.title,
    state: mapIssueState(raw.state),
    milestone,
    parentIssueNumber,
    blockedBy,
  };
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
        milestone { title }
        parent { number }
        blockedBy(first: 20) { nodes { number state } }
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
      milestone { title }
      parent { number }
      blockedBy(first: 20) { nodes { number state } }
    }`,
    )
    .join("\n");
  return `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    ${aliases}
  }
}`;
}

async function ghGraphql(
  runner: GhApiRunner,
  query: string,
  variables: Record<string, string | null>,
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

export function createGhTicketSnapshotTransport(
  runner: GhApiRunner = createGhApiRunner(),
): TicketSnapshotTransport {
  return {
    async listBookTickets(input) {
      const owner = requireNonEmpty(input.owner, "owner");
      const repo = requireNonEmpty(input.repo, "repo");
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
          const ticket = parseTicketNode(node, `open[${index}]`);
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
          const ticket = parseTicketNode(node, `closed[#${batch[index]}]`);
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
 */
export async function fetchBoardSnapshot(input: {
  bindings: readonly BookRepoBinding[];
  closedIssueNumbersByBook?: Readonly<Record<string, readonly number[]>>;
  transport: TicketSnapshotTransport;
  signal?: AbortSignal;
}): Promise<BoardSnapshot> {
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) {
    throw new TicketSnapshotBindingError("", "bindings must be a non-empty array");
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
