import type {
  CollectorGitHubTransport,
  GitHubCreateCommentResult,
  GitHubIssueComment,
  GitHubPageDiagnostics,
  GitHubPullRequest,
  GitHubReview,
  GitHubReviewComment,
  GitHubUser,
} from "../../src/collector-github.ts";

export type FakeGitHubState = {
  user: GitHubUser;
  pullRequest: GitHubPullRequest;
  /**
   * Optional per-call pull sequence for terminal-reread tests.
   * Call N returns sequence[min(N-1, last)].
   */
  pullRequestSequence?: GitHubPullRequest[];
  reviews: GitHubReview[];
  issueComments: GitHubIssueComment[];
  reviewComments: GitHubReviewComment[];
  reviewPages?: GitHubReview[][];
  issueCommentPages?: GitHubIssueComment[][];
  reviewCommentPages?: GitHubReviewComment[][];
  createComment?: (
    body: string,
  ) => Promise<GitHubCreateCommentResult> | GitHubCreateCommentResult;
  failNext?: Partial<Record<
    | "user"
    | "pull"
    | "reviews"
    | "issueComments"
    | "reviewComments"
    | "create",
    Error
  >>;
};

export type FakeGitHubTransport = CollectorGitHubTransport & {
  state: FakeGitHubState;
  calls: {
    user: number;
    pull: number;
    reviews: number;
    issueComments: number;
    reviewComments: number;
    create: number;
  };
};

function pageDiagnostics(
  path: string,
  pages: unknown[][],
): GitHubPageDiagnostics[] {
  return pages.map((items, index) => ({
    path: index === 0 ? path : `${path}&page=${index + 1}`,
    page: index + 1,
    status: 200,
    itemCount: items.length,
  }));
}

export function createFakeGitHubTransport(
  initial: FakeGitHubState,
): FakeGitHubTransport {
  const state: FakeGitHubState = initial;
  const calls = {
    user: 0,
    pull: 0,
    reviews: 0,
    issueComments: 0,
    reviewComments: 0,
    create: 0,
  };

  return {
    state,
    calls,
    async getAuthenticatedUser() {
      calls.user += 1;
      if (state.failNext?.user) throw state.failNext.user;
      return state.user;
    },
    async getPullRequest() {
      calls.pull += 1;
      if (state.failNext?.pull) throw state.failNext.pull;
      if (state.pullRequestSequence && state.pullRequestSequence.length > 0) {
        const index = Math.min(
          calls.pull - 1,
          state.pullRequestSequence.length - 1,
        );
        return state.pullRequestSequence[index]!;
      }
      return state.pullRequest;
    },
    async listPullRequestReviews(input) {
      calls.reviews += 1;
      if (state.failNext?.reviews) throw state.failNext.reviews;
      const pages = state.reviewPages ?? [state.reviews];
      const items: GitHubReview[] = [];
      for (const page of pages) {
        input.retainPage?.(page);
        items.push(...page);
      }
      return {
        items,
        pages: pageDiagnostics("/reviews", pages),
      };
    },
    async listIssueComments(input) {
      calls.issueComments += 1;
      if (state.failNext?.issueComments) throw state.failNext.issueComments;
      const pages = state.issueCommentPages ?? [state.issueComments];
      const items: GitHubIssueComment[] = [];
      for (const page of pages) {
        input.retainPage?.(page);
        items.push(...page);
      }
      return {
        items,
        pages: pageDiagnostics("/issue-comments", pages),
      };
    },
    async listReviewComments(input) {
      calls.reviewComments += 1;
      if (state.failNext?.reviewComments) throw state.failNext.reviewComments;
      const pages = state.reviewCommentPages ?? [state.reviewComments];
      const items: GitHubReviewComment[] = [];
      for (const page of pages) {
        input.retainPage?.(page);
        items.push(...page);
      }
      return {
        items,
        pages: pageDiagnostics("/review-comments", pages),
      };
    },
    async createIssueComment(input) {
      calls.create += 1;
      if (state.failNext?.create) throw state.failNext.create;
      if (state.createComment) return await state.createComment(input.body);
      const id = 10_000 + calls.create;
      const createdAt = new Date().toISOString();
      const updatedAt = new Date().toISOString();
      const htmlUrl = "https://github.com/o/r/pull/1#issuecomment-1";
      const comment: GitHubIssueComment = {
        id,
        userLogin: state.user.login,
        body: input.body,
        createdAt,
        updatedAt,
        htmlUrl,
        raw: {
          id,
          user: { login: state.user.login },
          body: input.body,
          created_at: createdAt,
          updated_at: updatedAt,
          html_url: htmlUrl,
        },
      };
      state.issueComments = [...state.issueComments, comment];
      return { kind: "success", comment };
    },
  };
}

export function samplePull(
  overrides: Partial<GitHubPullRequest> = {},
): GitHubPullRequest {
  return {
    number: 1,
    state: "OPEN",
    headOid: "aaa111",
    updatedAt: "2024-01-01T00:00:00Z",
    url: "https://github.com/acme/widgets/pull/1",
    raw: { number: 1, state: "open", head: { sha: "aaa111" } },
    ...overrides,
  };
}

export function sampleUser(login = "collector-bot"): GitHubUser {
  return { login, raw: { login } };
}

export function sampleReview(
  overrides: Partial<GitHubReview> & { id: number; userLogin: string },
): GitHubReview {
  return {
    state: "APPROVED",
    body: "LGTM",
    commitId: "aaa111",
    submittedAt: "2024-01-01T00:05:00Z",
    htmlUrl: `https://github.com/acme/widgets/pull/1#pullrequestreview-${overrides.id}`,
    raw: {},
    ...overrides,
  };
}

export function sampleIssueComment(
  overrides: Partial<GitHubIssueComment> & { id: number; userLogin: string },
): GitHubIssueComment {
  return {
    body: "note",
    createdAt: "2024-01-01T00:01:00Z",
    updatedAt: "2024-01-01T00:01:00Z",
    htmlUrl: `https://github.com/acme/widgets/pull/1#issuecomment-${overrides.id}`,
    raw: {},
    ...overrides,
  };
}

export function sampleReviewComment(
  overrides: Partial<GitHubReviewComment> & { id: number; userLogin: string },
): GitHubReviewComment {
  return {
    pullRequestReviewId: 1,
    body: "nit",
    path: "src/a.ts",
    line: 10,
    originalLine: 10,
    side: "RIGHT",
    position: 1,
    originalPosition: 1,
    commitId: "aaa111",
    originalCommitId: "aaa111",
    createdAt: "2024-01-01T00:05:00Z",
    updatedAt: "2024-01-01T00:05:00Z",
    htmlUrl: `https://github.com/acme/widgets/pull/1#discussion_r${overrides.id}`,
    raw: {},
    ...overrides,
  };
}
