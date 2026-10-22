// Expand phase (#1244): a test file that still imports node:test runs under
// scripts/run-test-all.mjs; every other test file runs under Vitest.
// Deleted together with that runner (#1250).
import { readFileSync } from "node:fs";

// A top-level import declaration, not node:test text inside a fixture string.
const NODE_TEST_IMPORT = /^(?:import\b[^\n]*|\}) from "node:test";?$/m;

export function importsNodeTest(path: string): boolean {
  return NODE_TEST_IMPORT.test(readFileSync(path, "utf8"));
}
