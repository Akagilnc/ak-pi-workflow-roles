/**
 * Collector bot handbook — opaque working memory under the book topology.
 * Runtime stores and delivers UTF-8 text only; never parses free text into
 * code state rules (parent #673 D3 / #677).
 *
 * Placement reuses the machine ledger home (ADR 0048) when the admitted
 * session already sits under books/<bookKey>/ — no parallel persistence frame.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomically } from "./atomic-write.ts";
import {
  activationBookDirectory,
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";

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
  const normalized = sessionPath.replaceAll("\\", "/");
  const match = /(?:^|\/)\.ak-roles\/books\/([^/]+)\//.exec(normalized);
  if (match === null) {
    throw new Error(
      `通进司手册要求 session 位于 books/<bookKey>/；收到 ${sessionPath}`,
    );
  }
  const bookKey = match[1]!;
  if (bookKey.length === 0 || bookKey === "." || bookKey === ".." || bookKey.includes("\\")) {
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
  const readOptional = async (path: string, parentDir: string): Promise<string | undefined> => {
    ensureRealDirectoryTree(input.ledgerHome, parentDir);
    assertLedgerFileInsideHome(path, input.ledgerHome);
    try {
      return await readFile(path, "utf8");
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
      // scope/body shape authority = collectorHandbookWriteArgsSchema (call site host parameters).
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
        byteLength: Buffer.byteLength(body, "utf8"),
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
