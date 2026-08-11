import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export type GitHubPullRequest = {
  number: number;
  state: string;
  headOid: string;
  updatedAt?: string;
  url: string;
  raw: unknown;
};

export type GitHubUser = {
  login: string;
  raw: unknown;
};

export type GitHubMachineIdentity = {
  userType: string;
  userId: number;
  appId?: number;
};

export type GitHubPullRequestReaction = {
  id: number;
  userLogin: string | null;
  machineIdentity?: GitHubMachineIdentity | null;
  content: string;
  createdAt: string;
  raw: unknown;
};

export type GitHubReview = {
  id: number;
  nodeId?: string;
  /** Null when GitHub tombstones the author (`user: null`). */
  userLogin: string | null;
  machineIdentity?: GitHubMachineIdentity | null;
  state: string;
  body: string;
  commitId: string | null;
  submittedAt: string | null;
  htmlUrl: string;
  raw: unknown;
};

export type GitHubIssueComment = {
  id: number;
  /** Null when GitHub tombstones the author (`user: null`). */
  userLogin: string | null;
  machineIdentity?: GitHubMachineIdentity | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  raw: unknown;
};

export type GitHubReviewComment = {
  id: number;
  pullRequestReviewId: number | null;
  /** Null when GitHub tombstones the author (`user: null`). */
  userLogin: string | null;
  machineIdentity?: GitHubMachineIdentity | null;
  body: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  position: number | null;
  originalPosition: number | null;
  commitId: string | null;
  originalCommitId: string | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  raw: unknown;
};

export type GitHubPageDiagnostics = {
  path: string;
  page: number;
  status: number;
  itemCount: number;
  linkHeader?: string;
};

export type GitHubCreateCommentResult =
  | {
      kind: "success";
      comment: GitHubIssueComment;
    }
  | {
      kind: "ambiguous_loss";
      diagnostics: string;
      cause?: { name: string; message: string; evidenceId: string };
    }
  | {
      kind: "rejected";
      status?: number;
      diagnostics: string;
    };

export type CollectorGitHubTransport = {
  getAuthenticatedUser(options?: {
    signal?: AbortSignal;
  }): Promise<GitHubUser>;
  getPullRequest(input: {
    owner: string;
    repo: string;
    prNumber: number;
    signal?: AbortSignal;
  }): Promise<GitHubPullRequest>;
  listPullRequestReviews(input: {
    owner: string;
    repo: string;
    prNumber: number;
    signal?: AbortSignal;
    /** Charge observation budget before aggregate append / next-page fetch. */
    retainPage?: (items: GitHubReview[]) => void;
  }): Promise<{ items: GitHubReview[]; pages: GitHubPageDiagnostics[] }>;
  listPullRequestReactions?(input: {
    owner: string;
    repo: string;
    prNumber: number;
    signal?: AbortSignal;
    retainPage?: (items: GitHubPullRequestReaction[]) => void;
  }): Promise<{ items: GitHubPullRequestReaction[]; pages: GitHubPageDiagnostics[] }>;
  listIssueComments(input: {
    owner: string;
    repo: string;
    prNumber: number;
    signal?: AbortSignal;
    retainPage?: (items: GitHubIssueComment[]) => void;
  }): Promise<{ items: GitHubIssueComment[]; pages: GitHubPageDiagnostics[] }>;
  listReviewComments(input: {
    owner: string;
    repo: string;
    prNumber: number;
    signal?: AbortSignal;
    retainPage?: (items: GitHubReviewComment[]) => void;
  }): Promise<{ items: GitHubReviewComment[]; pages: GitHubPageDiagnostics[] }>;
  createIssueComment(input: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
    signal?: AbortSignal;
  }): Promise<GitHubCreateCommentResult>;
};

export type GhApiResponse = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
};

export type GhApiRunner = (
  args: string[],
  options?: { stdin?: string; signal?: AbortSignal },
) => Promise<GhApiResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`GitHub payload missing string ${label}`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`GitHub payload missing number ${label}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseLinkNext(linkHeader: string | undefined): string | undefined {
  if (linkHeader === undefined || linkHeader.length === 0) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="next"$/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`GitHub ${label} returned malformed JSON`, { cause: error });
  }
}

let commentFailureEvidence = 0;
function commentFailureCause(error: unknown) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    evidenceId: `github-comment-failure-${++commentFailureEvidence}`,
  };
}

/** Authenticated /user requires a login; throws when absent. */
function requireUserLogin(raw: unknown): string {
  if (!isRecord(raw) || typeof raw["login"] !== "string") {
    throw new Error("GitHub payload missing user.login");
  }
  return raw["login"];
}

/**
 * Surface authors may be tombstoned only as literal JSON null (`user: null`).
 * Preserve that case with null login; every other shape fails closed.
 */
function optionalUserLogin(raw: unknown): string | null {
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw["login"] !== "string") {
    throw new Error("GitHub payload missing user.login");
  }
  return raw["login"];
}

function machineIdentity(raw: Record<string, unknown>): GitHubMachineIdentity | null {
  const user = raw["user"];
  if (!isRecord(user) || typeof user["type"] !== "string" || typeof user["id"] !== "number") {
    return null;
  }
  const app = raw["performed_via_github_app"];
  const appId = isRecord(app) && typeof app["id"] === "number" ? app["id"] : undefined;
  return {
    userType: user["type"],
    userId: user["id"],
    ...(appId === undefined ? {} : { appId }),
  };
}

export function normalizePullRequest(raw: unknown): GitHubPullRequest {
  if (!isRecord(raw)) throw new Error("GitHub pull request payload must be an object");
  const head = raw["head"];
  if (!isRecord(head) || typeof head["sha"] !== "string" || head["sha"].length === 0) {
    throw new Error("GitHub pull request payload missing head.sha");
  }
  const number = requireNumber(raw["number"], "number");
  const state = requireString(raw["state"], "state").toUpperCase();
  const htmlUrl = typeof raw["html_url"] === "string"
    ? raw["html_url"]
    : `https://github.com/unknown/unknown/pull/${number}`;
  return {
    number,
    state: state === "OPEN" || state === "open" ? "OPEN" : state,
    headOid: head["sha"],
    ...(typeof raw["updated_at"] === "string" ? { updatedAt: raw["updated_at"] } : {}),
    url: htmlUrl,
    raw,
  };
}

export function normalizePullRequestReaction(raw: unknown): GitHubPullRequestReaction {
  if (!isRecord(raw)) throw new Error("GitHub reaction payload must be an object");
  return {
    id: requireNumber(raw["id"], "reaction.id"),
    userLogin: optionalUserLogin(raw["user"]),
    machineIdentity: machineIdentity(raw),
    content: requireString(raw["content"], "reaction.content"),
    createdAt: requireString(raw["created_at"], "reaction.created_at"),
    raw,
  };
}

export function normalizeReview(raw: unknown): GitHubReview {
  if (!isRecord(raw)) throw new Error("GitHub review payload must be an object");
  return {
    id: requireNumber(raw["id"], "review.id"),
    ...(typeof raw["node_id"] === "string" ? { nodeId: raw["node_id"] } : {}),
    userLogin: optionalUserLogin(raw["user"]),
    machineIdentity: machineIdentity(raw),
    state: requireString(raw["state"], "review.state").toUpperCase(),
    body: typeof raw["body"] === "string" ? raw["body"] : "",
    commitId: optionalString(raw["commit_id"]),
    submittedAt: optionalString(raw["submitted_at"]),
    htmlUrl: typeof raw["html_url"] === "string" ? raw["html_url"] : "",
    raw,
  };
}

export function normalizeIssueComment(raw: unknown): GitHubIssueComment {
  if (!isRecord(raw)) throw new Error("GitHub issue comment payload must be an object");
  return {
    id: requireNumber(raw["id"], "comment.id"),
    userLogin: optionalUserLogin(raw["user"]),
    machineIdentity: machineIdentity(raw),
    body: typeof raw["body"] === "string" ? raw["body"] : "",
    createdAt: requireString(raw["created_at"], "comment.created_at"),
    updatedAt: requireString(raw["updated_at"], "comment.updated_at"),
    htmlUrl: typeof raw["html_url"] === "string" ? raw["html_url"] : "",
    raw,
  };
}

export function normalizeReviewComment(raw: unknown): GitHubReviewComment {
  if (!isRecord(raw)) throw new Error("GitHub review comment payload must be an object");
  return {
    id: requireNumber(raw["id"], "review_comment.id"),
    pullRequestReviewId: typeof raw["pull_request_review_id"] === "number"
      ? raw["pull_request_review_id"]
      : null,
    userLogin: optionalUserLogin(raw["user"]),
    machineIdentity: machineIdentity(raw),
    body: typeof raw["body"] === "string" ? raw["body"] : "",
    path: requireString(raw["path"], "review_comment.path"),
    line: typeof raw["line"] === "number" ? raw["line"] : null,
    originalLine: typeof raw["original_line"] === "number" ? raw["original_line"] : null,
    side: optionalString(raw["side"]),
    position: typeof raw["position"] === "number" ? raw["position"] : null,
    originalPosition: typeof raw["original_position"] === "number"
      ? raw["original_position"]
      : null,
    commitId: optionalString(raw["commit_id"]),
    originalCommitId: optionalString(raw["original_commit_id"]),
    createdAt: requireString(raw["created_at"], "review_comment.created_at"),
    updatedAt: requireString(raw["updated_at"], "review_comment.updated_at"),
    htmlUrl: typeof raw["html_url"] === "string" ? raw["html_url"] : "",
    raw,
  };
}

export function createGhApiRunner(
  options: {
    spawnImpl?: typeof spawn;
    env?: NodeJS.ProcessEnv;
  } = {},
): GhApiRunner {
  const spawnImpl = options.spawnImpl ?? spawn;
  return async (args, runOptions = {}) => {
    return await new Promise<GhApiResponse>((resolve, reject) => {
      const signal = runOptions.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const child = spawnImpl("gh", args, {
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
        fn();
      };
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch (error) {
          settle(() => reject(error));
          return;
        }
        settle(() => {
          reject(signal?.reason ?? new Error("aborted"));
        });
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        settle(() => reject(error));
      });
      // Attach before write/end so early child exit cannot raise uncaught EPIPE.
      child.stdin.on("error", (error) => {
        settle(() => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          const err = error instanceof Error ? error : new Error(String(error));
          reject(Object.assign(err, { ambiguousGhFailure: true }));
        });
      });
      if (runOptions.stdin !== undefined) {
        child.stdin.write(runOptions.stdin);
      }
      child.stdin.end();
      child.on("close", (code, signal) => {
        settle(() => {
          // gh api --include prints: HTTP/ headers blank-line body
          const match = stdout.match(/^HTTP\/[\d.]+\s+(\d+)[^\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
          if (match) {
            const status = Number(match[1]);
            const headerText = match[2] ?? "";
            const bodyText = match[3] ?? "";
            const headers: Record<string, string> = {};
            for (const line of headerText.split(/\r?\n/)) {
              const idx = line.indexOf(":");
              if (idx === -1) continue;
              const name = line.slice(0, idx).trim().toLowerCase();
              const value = line.slice(idx + 1).trim();
              headers[name] = value;
            }
            resolve({ status, headers, bodyText });
            return;
          }
          if (code === 0) {
            resolve({ status: 200, headers: {}, bodyText: stdout });
            return;
          }
          // Ambiguous: process failed without parseable HTTP response
          const failure = new Error(
            `gh api failed without a parseable HTTP response (code=${String(code)}): ${stderr || stdout}`,
            { cause: { code, signal, stderr, stdout } },
          );
          reject(Object.assign(failure, { ambiguousGhFailure: true, stderr, stdout, code, signal }));
        });
      });
    });
  };
}

export function createGhCollectorGitHubTransport(
  runner: GhApiRunner = createGhApiRunner(),
): CollectorGitHubTransport {
  const hostnameArgs = ["api", "--hostname", "github.com", "--include"] as const;

  async function apiGet(
    path: string,
    signal?: AbortSignal,
  ): Promise<GhApiResponse> {
    return await runner(
      [...hostnameArgs, "-X", "GET", path],
      signal === undefined ? {} : { signal },
    );
  }

  async function paginate<T>(
    path: string,
    mapItem: (raw: unknown) => T,
    options: {
      signal?: AbortSignal;
      retainPage?: (items: T[]) => void;
    } = {},
  ): Promise<{ items: T[]; pages: GitHubPageDiagnostics[] }> {
    const { signal, retainPage } = options;
    const items: T[] = [];
    const pages: GitHubPageDiagnostics[] = [];
    let nextPath: string | undefined = path;
    let page = 1;
    const seen = new Set<string>();
    while (nextPath !== undefined) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("aborted");
      }
      if (seen.has(nextPath)) {
        throw new Error(`GitHub pagination repeated page: ${nextPath}`);
      }
      seen.add(nextPath);
      const response = await apiGet(nextPath, signal);
      const diagnostics: GitHubPageDiagnostics = {
        path: nextPath,
        page,
        status: response.status,
        itemCount: 0,
        ...(response.headers["link"] === undefined
          ? {}
          : { linkHeader: response.headers["link"] }),
      };
      if (response.status === 429) {
        throw Object.assign(
          new Error(`GitHub API rate limited on ${nextPath} (HTTP 429)`),
          { githubStatus: 429, page: diagnostics },
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw Object.assign(
          new Error(`GitHub API ${nextPath} failed with HTTP ${response.status}`),
          { githubStatus: response.status, page: diagnostics },
        );
      }
      const parsed = parseJson(response.bodyText, nextPath);
      if (!Array.isArray(parsed)) {
        throw new Error(`GitHub API ${nextPath} did not return a JSON array`);
      }
      diagnostics.itemCount = parsed.length;
      pages.push(diagnostics);
      const pageItems = parsed.map((entry) => mapItem(entry));
      // Observation budget hook: charge before aggregate append / next-page fetch.
      retainPage?.(pageItems);
      for (const item of pageItems) items.push(item);
      const nextUrl = parseLinkNext(response.headers["link"]);
      if (nextUrl === undefined) {
        nextPath = undefined;
      } else {
        // Accept absolute or path-style next links; normalize to API path + query.
        if (nextUrl.startsWith("/")) {
          nextPath = nextUrl;
        } else {
          const url = new URL(nextUrl);
          if (url.hostname !== "api.github.com" && url.hostname !== "github.com") {
            throw new Error(`unexpected pagination host ${url.hostname}`);
          }
          nextPath = `${url.pathname}${url.search}`;
          if (nextPath.startsWith("/api/v3/")) {
            nextPath = nextPath.slice("/api/v3".length);
          }
        }
      }
      page += 1;
    }
    return { items, pages };
  }

  return {
    async getAuthenticatedUser(options = {}) {
      const response = await apiGet("/user", options.signal);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GitHub /user failed with HTTP ${response.status}`, { cause: { endpoint: "/user", status: response.status, headers: response.headers, body: response.bodyText } });
      }
      const raw = parseJson(response.bodyText, "/user");
      return { login: requireUserLogin(raw).toLowerCase(), raw };
    },

    async getPullRequest(input) {
      const path =
        `/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}`;
      const response = await apiGet(path, input.signal);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GitHub ${path} failed with HTTP ${response.status}`, { cause: { endpoint: path, status: response.status, headers: response.headers, body: response.bodyText } });
      }
      return normalizePullRequest(parseJson(response.bodyText, path));
    },

    async listPullRequestReviews(input) {
      const path =
        `/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/reviews?per_page=100`;
      return await paginate(path, normalizeReview, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.retainPage === undefined ? {} : { retainPage: input.retainPage }),
      });
    },

    async listPullRequestReactions(input) {
      const path =
        `/repos/${input.owner}/${input.repo}/issues/${input.prNumber}/reactions?per_page=100`;
      return await paginate(path, normalizePullRequestReaction, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.retainPage === undefined ? {} : { retainPage: input.retainPage }),
      });
    },

    async listIssueComments(input) {
      const path =
        `/repos/${input.owner}/${input.repo}/issues/${input.prNumber}/comments?per_page=100`;
      return await paginate(path, normalizeIssueComment, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.retainPage === undefined ? {} : { retainPage: input.retainPage }),
      });
    },

    async listReviewComments(input) {
      const path =
        `/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/comments?per_page=100`;
      return await paginate(path, normalizeReviewComment, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.retainPage === undefined ? {} : { retainPage: input.retainPage }),
      });
    },

    async createIssueComment(input) {
      const path =
        `/repos/${input.owner}/${input.repo}/issues/${input.prNumber}/comments`;
      try {
        const response = await runner(
          [...hostnameArgs, "-X", "POST", path, "--input", "-"],
          input.signal === undefined
            ? { stdin: JSON.stringify({ body: input.body }) }
            : { stdin: JSON.stringify({ body: input.body }), signal: input.signal },
        );
        if (response.status >= 200 && response.status < 300) {
          // Contract: README.md#Collector — a successful write with unreadable response is recoverable only as an observable ambiguous result.
          // 2xx means the comment may already exist; parse/normalize failure is
          // ambiguous_loss so ledger marker recovery can resolve without repost.
          try {
            return {
              kind: "success",
              comment: normalizeIssueComment(parseJson(response.bodyText, path)),
            };
            } catch (error) {
            const cause = commentFailureCause(error);
            return { kind: "ambiguous_loss", diagnostics: cause.message, cause };
          }
        }
        return {
          kind: "rejected",
          status: response.status,
          diagnostics: `HTTP ${response.status}: ${response.bodyText.slice(0, 500)}`,
        };
      } catch (error) {
        // Signal state is authoritative cancel; rethrow exact caught value.
        if (input.signal?.aborted) {
          throw error;
        }
        // Non-aborted transport tag only (after signal).
        if (isRecord(error) && error["ambiguousGhFailure"] === true) {
          const cause = commentFailureCause(error);
          return { kind: "ambiguous_loss", diagnostics: cause.message, cause };
        }
        // Non-signal AbortError belt only (after tag).
        if (isRecord(error) && error["name"] === "AbortError") {
          throw error;
        }
        throw error;
      }
    },
  };
}

export function buildCollectorRequestMarker(input: {
  manifestDigest: string;
  requestId: string;
  headOid: string;
}): string {
  const prefix = input.manifestDigest.slice(0, 12);
  const requestMarkerId = createHash("sha256").update(input.requestId).digest("hex");
  return `<!-- ak-collector:v1 manifest=${prefix} request=${requestMarkerId} head=${input.headOid} -->`;
}

export function buildCollectorRequestBody(input: {
  configuredBody: string;
  manifestDigest: string;
  requestId: string;
  headOid: string;
}): { body: string; marker: string } {
  const marker = buildCollectorRequestMarker(input);
  // Preserve configured body byte-for-byte; append marker on its own line.
  const body = input.configuredBody.endsWith("\n")
    ? `${input.configuredBody}${marker}\n`
    : `${input.configuredBody}\n${marker}\n`;
  return { body, marker };
}
