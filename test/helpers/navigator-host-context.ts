/**
 * Shared host context fixture for native Navigator session factory tests.
 * Used by contract attendance and real-session lifecycle suites.
 */
import { basename, dirname, join } from "node:path";

export function hostContextFor(root: string, sessionFile?: string) {
  const bookKey = basename(root);
  const file = sessionFile ?? join(root, ".ak-roles", "books", bookKey, "runs", "nav", "session", "session.jsonl");
  return {
    cwd: root,
    mode: "print" as const,
    model: undefined,
    sessionManager: {
      getLeafEntry: () => undefined,
      getLeafId: () => null,
      getEntries: () => [],
      getSessionDir: () => dirname(file),
      getSessionFile: () => file,
    },
    abort() {},
  };
}
