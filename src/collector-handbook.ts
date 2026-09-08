/**
 * Collector bot handbook — opaque working memory under the book topology.
 * Runtime stores and delivers UTF-8 text only; never parses free text into
 * code state rules (parent #673 D3 / #677).
 *
 * Placement reuses the machine ledger home (ADR 0048) when the admitted
 * session already sits under books/<bookKey>/ — no parallel persistence frame.
 */
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { writeFileAtomically } from "./atomic-write.ts";
import {
  activationBookDirectory,
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";
import { COLLECTOR_HANDBOOK_MAX_BYTES } from "./collector-tool-schemas.ts";

export type CollectorHandbookScope = "general" | "repo";

export type CollectorHandbookRead = {
  readonly general: string;
  readonly repo: string;
  readonly generalSource: "book" | "seed" | "empty";
  readonly repoSource: "book" | "empty";
  readonly generalPath: string;
  readonly repoPath: string;
};

export type CollectorHandbookWriteResult = {
  readonly scope: CollectorHandbookScope;
  readonly path: string;
  readonly byteLength: number;
};

export type CollectorHandbookStore = {
  readonly root: string;
  readonly repositoryCanonical: string;
  read(): Promise<CollectorHandbookRead>;
  write(scope: CollectorHandbookScope, body: string): Promise<CollectorHandbookWriteResult>;
};

export type CollectorHandbookPlacement = {
  readonly ledgerHome: string;
  readonly bookKey: string;
  readonly root: string;
};

/**
 * Derive handbook root from an admitted session/run path under
 * `.ak-roles/books/<bookKey>/...`. Fails closed when topology is absent.
 */
export function resolveCollectorHandbookRoot(sessionPath: string): CollectorHandbookPlacement {
  if (typeof sessionPath !== "string" || sessionPath.trim().length === 0) {
    throw new Error("通进司手册要求非空 session 路径，且位于 books/<bookKey>/");
  }
  // Platform path segments only — never rewrite non-separator characters (POSIX `\\` is literal).
  const segments = sessionPath.split(sep);
  let bookKey: string | undefined;
  for (let i = 0; i + 3 < segments.length; i += 1) {
    if (segments[i] === ".ak-roles" && segments[i + 1] === "books") {
      const candidate = segments[i + 2]!;
      // Require a following segment so bookKey is a true path component under books/.
      if (candidate.length > 0) {
        bookKey = candidate;
        break;
      }
    }
  }
  if (bookKey === undefined) {
    throw new Error(
      `通进司手册要求 session 位于 books/<bookKey>/；收到 ${sessionPath}`,
    );
  }
  if (bookKey === "." || bookKey === "..") {
    throw new Error(`通进司手册拒绝不安全 bookKey ${JSON.stringify(bookKey)}`);
  }
  const ledgerHome = resolveActivationLedgerHomeForPath(sessionPath);
  const root = join(activationBookDirectory(ledgerHome, bookKey), "collector-handbook");
  return { ledgerHome, bookKey, root };
}

/** Flat repo file name under handbook/repos/ — avoids nested owner/repo dirs. */
function collectorHandbookRepoFileName(repositoryCanonical: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(repositoryCanonical)) {
    throw new Error(
      `通进司手册仓库文件要求规范 owner/repo，收到 ${JSON.stringify(repositoryCanonical)}`,
    );
  }
  return `${repositoryCanonical.replaceAll("/", "__")}.md`;
}

export function createCollectorHandbookStore(input: {
  readonly ledgerHome: string;
  readonly handbookRoot: string;
  readonly repositoryCanonical: string;
  readonly seedGeneral?: string;
}): CollectorHandbookStore {
  const generalPath = join(input.handbookRoot, "general.md");
  const repoDir = join(input.handbookRoot, "repos");
  const repoPath = join(repoDir, collectorHandbookRepoFileName(input.repositoryCanonical));

  /**
   * ADR 0038: confine at the real read seam. Parent dirs must be physical under
   * ledger home; the leaf must not be a pre-existing symlink (even in-home).
   */
  /** Sole UTF-8 budget seam — write and read share COLLECTOR_HANDBOOK_MAX_BYTES. */
  const assertHandbookBudget = (body: string, label: string): number => {
    const byteLength = Buffer.byteLength(body, "utf8");
    if (byteLength > COLLECTOR_HANDBOOK_MAX_BYTES) {
      throw new Error(
        `通进司手册${label} UTF-8 至多 ${COLLECTOR_HANDBOOK_MAX_BYTES} 字节，收到 ${byteLength}`,
      );
    }
    return byteLength;
  };

  const readOptional = async (path: string, parentDir: string): Promise<string | undefined> => {
    ensureRealDirectoryTree(input.ledgerHome, parentDir);
    assertLedgerFileInsideHome(path, input.ledgerHome);
    try {
      const body = await readFile(path, "utf8");
      assertHandbookBudget(body, "正文");
      return body;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };

  return {
    root: input.handbookRoot,
    repositoryCanonical: input.repositoryCanonical,
    async read() {
      const bookGeneral = await readOptional(generalPath, input.handbookRoot);
      const bookRepo = await readOptional(repoPath, repoDir);
      if (bookGeneral !== undefined) {
        return {
          general: bookGeneral,
          repo: bookRepo ?? "",
          generalSource: "book",
          repoSource: bookRepo === undefined ? "empty" : "book",
          generalPath,
          repoPath,
        };
      }
      const seed = input.seedGeneral;
      if (typeof seed === "string" && seed.length > 0) {
        assertHandbookBudget(seed, "正文");
        return {
          general: seed,
          repo: bookRepo ?? "",
          generalSource: "seed",
          repoSource: bookRepo === undefined ? "empty" : "book",
          generalPath,
          repoPath,
        };
      }
      return {
        general: "",
        repo: bookRepo ?? "",
        generalSource: "empty",
        repoSource: bookRepo === undefined ? "empty" : "book",
        generalPath,
        repoPath,
      };
    },
    async write(scope, body) {
      // body string shape = collectorHandbookWriteArgsSchema; byte budget is business (UTF-8).
      const byteLength = assertHandbookBudget(body, "正文");
      ensureRealDirectoryTree(input.ledgerHome, input.handbookRoot);
      const path = scope === "general" ? generalPath : repoPath;
      if (scope === "repo") {
        ensureRealDirectoryTree(input.ledgerHome, repoDir);
      }
      assertLedgerFileInsideHome(path, input.ledgerHome);
      await writeFileAtomically(path, body);
      return {
        scope,
        path,
        byteLength,
      };
    },
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
