import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.js";
import { immutableReviewerPin } from "./reviewer-pinned-git.js";
import { createReviewerPinnedGitReader, immutableReviewerPin as immutableReviewerPin2 } from "./reviewer-pinned-git.js";
import { isReviewerPromptText, sameReviewerPromptText } from "./reviewer-prompt-identity.js";
import { sha256Hex } from "./sha256.js";
import {
  constructReviewerDispatch
} from "./reviewer-construction.js";
import {
} from "./reviewer-construction.js";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.js";
import { sha256Hex as sha256Hex2 } from "./sha256.js";
import { isReviewerPromptText as isReviewerPromptText2, sameReviewerPromptText as sameReviewerPromptText2 } from "./reviewer-prompt-identity.js";
const GENERIC_FEATURE_TOKENS = /* @__PURE__ */ new Set(["", "head", "main", "master", "trunk", "develop", "development"]);
const BRANCH_SHELL_PREFIX = /^(?:feat|feature|fix|bugfix|hotfix|chore|docs|refactor)-/;
const BRANCH_ISSUE_TOKEN = /(?:^|\/)((?:fix|feat|docs|audit|test)\/issue-(\d+)-)/;
const COMMIT_TICKET_TOKEN = /#([1-9]\d*)/;
const ADR_PATH_IN_BODY = /docs\/adr\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md/g;
function normalizeFeatureToken(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function expandFeatureTokens(raw) {
  const normalized = normalizeFeatureToken(raw);
  if (normalized.length === 0) return Object.freeze([]);
  const tokens = /* @__PURE__ */ new Set([normalized]);
  const stripped = normalized.replace(BRANCH_SHELL_PREFIX, "");
  if (stripped.length > 0 && stripped !== normalized) tokens.add(stripped);
  return Object.freeze([...tokens]);
}
function resolveReviewerTicketNumber(input) {
  const typed = typeof input.ticketNumber === "number" && Number.isInteger(input.ticketNumber) && input.ticketNumber >= 1 ? Object.freeze({ source: "typed-ticket-number", ticketNumber: input.ticketNumber }) : void 0;
  let branch;
  for (const name of input.branchNames) {
    const match = BRANCH_ISSUE_TOKEN.exec(name);
    if (match) {
      const n = Number(match[2]);
      if (Number.isInteger(n) && n >= 1) {
        branch = Object.freeze({ source: "branch-token", ticketNumber: n });
        break;
      }
    }
  }
  let commit;
  const newest = input.commitMessagesNewestFirst[0];
  if (newest !== void 0) {
    const match = COMMIT_TICKET_TOKEN.exec(newest);
    if (match) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n >= 1) {
        commit = Object.freeze({ source: "commit-message", ticketNumber: n });
      }
    }
  }
  if (typed !== void 0) {
    const abandoned = [branch, commit].filter((c) => c !== void 0);
    return Object.freeze({ adopted: typed, abandoned: Object.freeze(abandoned) });
  }
  if (branch !== void 0) {
    const abandoned = commit === void 0 ? Object.freeze([]) : Object.freeze([commit]);
    return Object.freeze({ adopted: branch, abandoned });
  }
  if (commit !== void 0) {
    return Object.freeze({ adopted: commit, abandoned: Object.freeze([]) });
  }
  return void 0;
}
function extractReferencedAdrPaths(issueBody) {
  const seen = /* @__PURE__ */ new Set();
  const paths = [];
  for (const match of issueBody.matchAll(ADR_PATH_IN_BODY)) {
    const path = match[0];
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return Object.freeze(paths);
}
async function discoverReviewerSpecAuthority(input) {
  const featureTokens = await input.reader.featureTokens();
  const commitMessages = input.baseCommit === void 0 ? Object.freeze([]) : await input.reader.commitMessagesNewestFirst(input.baseCommit);
  const ticketResolution = resolveReviewerTicketNumber({
    ...input.ticketNumber === void 0 ? {} : { ticketNumber: input.ticketNumber },
    branchNames: featureTokens,
    commitMessagesNewestFirst: commitMessages
  });
  if (ticketResolution !== void 0) {
    const origin = await input.reader.originRepository();
    if (origin !== void 0 && input.fetchIssue !== void 0) {
      const issue = await input.fetchIssue({
        owner: origin.owner,
        repo: origin.repo,
        ticketNumber: ticketResolution.adopted.ticketNumber
      });
      if (issue !== void 0) {
        const adrPaths = extractReferencedAdrPaths(issue.body);
        const adrs = [];
        for (const path of adrPaths) {
          const body = await input.reader.readPinnedText(path);
          if (body === void 0) {
            adrs.push(Object.freeze({ path, status: "missing" }));
          } else {
            adrs.push(Object.freeze({ path, status: "present", body }));
          }
        }
        const issueRef = `https://github.com/${origin.owner}/${origin.repo}/issues/${ticketResolution.adopted.ticketNumber}`;
        const presentAdrRefs = adrs.filter((a) => a.status === "present").map((a) => a.path);
        const fetched = Object.freeze({
          issueRef,
          owner: origin.owner,
          repo: origin.repo,
          ticketNumber: ticketResolution.adopted.ticketNumber,
          adopted: ticketResolution.adopted,
          abandoned: ticketResolution.abandoned,
          issueBody: issue.body,
          adrs: Object.freeze(adrs)
        });
        return Object.freeze({
          status: "available",
          refs: Object.freeze([issueRef, ...presentAdrRefs]),
          fetched
        });
      }
    }
  }
  if (input.authorityRefs.length > 0) {
    return Object.freeze({
      status: "available",
      refs: Object.freeze([...input.authorityRefs])
    });
  }
  const tokens = [
    ...new Set(
      featureTokens.flatMap((raw) => expandFeatureTokens(raw)).filter((token) => token.length >= 3 && !GENERIC_FEATURE_TOKENS.has(token))
    )
  ];
  if (tokens.length === 0) {
    return Object.freeze({ status: "missing" });
  }
  const candidates = await input.reader.listSpecCandidatePaths();
  const matched = candidates.filter((relativePath) => {
    const normalizedPath = normalizeFeatureToken(relativePath);
    return tokens.some((token) => normalizedPath.includes(token));
  });
  if (matched.length === 0) {
    return Object.freeze({ status: "missing" });
  }
  return Object.freeze({
    status: "available",
    refs: Object.freeze(matched)
  });
}
const REVIEWER_PREFLIGHT_VIOLATIONS = ["base-invalid", "range-invalid", "prompt-identity-invalid", "target-drift"];
class ReviewerPreflightError extends Error {
  constructor(code, diagnostic = `${code} constraint failed`) {
    super(`${code}: ${diagnostic}`);
    this.code = code;
    this.diagnostic = diagnostic;
  }
  code;
  diagnostic;
}
function toReviewerExecution(dispatch) {
  return Object.freeze({
    identity: dispatch.identity,
    recipe: dispatch.recipe,
    targetSnapshot: immutableReviewerPin(dispatch.targetSnapshot),
    legs: Object.freeze(dispatch.legs.map((l) => Object.freeze({ axis: l.axis, prompt: l.prompt })))
  });
}
const preflight = (error) => {
  if (error instanceof ReviewerPreflightError) return error;
  if (error instanceof ReviewerCorrectablePreflightError) {
    return new ReviewerPreflightError(error.code, error.diagnostic);
  }
  return void 0;
};
function createReviewerDispatcher(d) {
  const target = immutableReviewerPin(d.reader.pin);
  let started = false;
  return Object.freeze({
    async dispatch(baseRevision, invocation) {
      if (started) throw new Error("Reviewer fixed dispatch can start exactly once");
      const identity = sha256Hex(JSON.stringify({
        baseRevision,
        target: target.targetHead,
        canonicalSkill: sha256Hex(d.canonicalSkill)
      }));
      let dispatch;
      try {
        const base = await d.reader.resolve(baseRevision);
        const range = await d.reader.range(base);
        const authorityRefs = Object.freeze([...d.authorityRefs ?? []]);
        const specAuthority = await discoverReviewerSpecAuthority({
          authorityRefs,
          reader: d.reader,
          baseCommit: base,
          ...d.ticketNumber === void 0 ? {} : { ticketNumber: d.ticketNumber },
          ...d.fetchIssue === void 0 ? {} : { fetchIssue: d.fetchIssue }
        });
        dispatch = constructReviewerDispatch({
          identity,
          canonicalSkill: d.canonicalSkill,
          target,
          range,
          ...d.reviewScopeKeys === void 0 ? {} : { reviewScopeKeys: d.reviewScopeKeys },
          specAuthority
        });
        if (!sameReviewerPinnedTarget(await d.reader.snapshot(), target)) {
          throw new ReviewerPreflightError("target-drift", "pinned target snapshot changed before child execution");
        }
      } catch (error) {
        const p = preflight(error);
        if (!p) throw error;
        d.decisionEvidence?.(Object.freeze({ disposition: "rejected", identity, violations: Object.freeze([p.code]), started: false }));
        return Object.freeze({ status: "rejected", identity, violations: Object.freeze([p.code]), diagnostic: p.diagnostic });
      }
      started = true;
      d.decisionEvidence?.(Object.freeze({ disposition: "accepted", identity, dispatch }));
      const results = await d.run(toReviewerExecution(dispatch), invocation);
      return Object.freeze({ status: "accepted", dispatch, results });
    }
  });
}
export {
  REVIEWER_PREFLIGHT_VIOLATIONS,
  ReviewerPreflightError,
  createReviewerDispatcher,
  createReviewerPinnedGitReader,
  discoverReviewerSpecAuthority,
  extractReferencedAdrPaths,
  immutableReviewerPin2 as immutableReviewerPin,
  isReviewerPromptText2 as isReviewerPromptIdentity,
  isReviewerPromptText,
  resolveReviewerTicketNumber,
  sameReviewerPromptText2 as sameReviewerPromptIdentity,
  sameReviewerPromptText,
  sha256Hex2 as sha256Hex,
  toReviewerExecution
};
