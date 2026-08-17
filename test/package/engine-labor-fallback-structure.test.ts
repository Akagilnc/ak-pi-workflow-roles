/**
 * #380 S1/S2 — package structure oracle for sole engineLaborFallback producer.
 * S1: exactly one src module with exactly one construction/assignment of the field.
 * S2: judge + reviewer failure/accept chains both reach that sole producer via imports.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";

const FIELD = "engineLaborFallback";
const SRC_ROOT = join(packageRoot, "src");

async function listTsFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

/** Strip block + line comments so type/prose noise does not count. */
function stripComments(sourceText: string): string {
  return sourceText
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Drop `type` / `interface` declaration bodies so type-only property names
 * are not counted as runtime producers.
 */
function stripTypeDeclarations(sourceText: string): string {
  // type Foo = ...;  without braces
  let text = sourceText.replace(
    /\btype\s+[A-Za-z0-9_$.]+\s*(?:<[^>]*>)?\s*=\s*[^;{]+;/g,
    " ",
  );
  // type/interface with brace body (single- or multi-line)
  text = text.replace(
    /\b(?:type|interface)\s+[A-Za-z0-9_$.]+\s*(?:<[^>]*>)?(?:\s+extends\s+[^{]+)?\s*=?\s*\{[^}]*\}\s*;?/g,
    " ",
  );
  return text;
}

/**
 * Count value-level construction/assignment points of `engineLaborFallback`.
 * - object property: engineLaborFallback: / "engineLaborFallback":
 * - assignment: .engineLaborFallback = / ["engineLaborFallback"] =
 * Ordinary reads, string compares, imports, and type-only positions are excluded.
 */
export function countEngineLaborFallbackConstructions(sourceText: string): number {
  const text = stripTypeDeclarations(stripComments(sourceText));
  const patterns = [
    // Object property construction (identifier or quoted key).
    new RegExp(
      `(?:^|[\\s,{])(?:${FIELD}|"${FIELD}"|'${FIELD}')\\s*:`,
      "g",
    ),
    // Property assignment.
    new RegExp(`\\.${FIELD}\\s*=`, "g"),
    // Element assignment with string key.
    new RegExp(`\\[\\s*["']${FIELD}["']\\s*\\]\\s*=`, "g"),
  ];
  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

async function scanSrcProducers(): Promise<Map<string, number>> {
  const files = await listTsFiles(SRC_ROOT);
  const producers = new Map<string, number>();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const n = countEngineLaborFallbackConstructions(text);
    if (n > 0) producers.set(relative(packageRoot, file), n);
  }
  return producers;
}

function resolveImportSpecifier(
  fromFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = join(dirname(fromFile), specifier);
  if (base.endsWith(".ts")) return base;
  return `${base}.ts`;
}

async function collectReachableImports(entryRel: string): Promise<Set<string>> {
  const entry = join(packageRoot, entryRel);
  const seen = new Set<string>();
  const queue = [entry];
  const importRe =
    /(?:import|export)\s+(?:type\s+)?(?:[^"'()]+from\s+)?["'](\.[^"']+)["']/g;
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = relative(packageRoot, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    importRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(text)) !== null) {
      const resolved = resolveImportSpecifier(file, match[1]!);
      if (resolved !== undefined) queue.push(resolved);
    }
  }
  return seen;
}

test("S1: sole producer module has exactly one engineLaborFallback construction", async () => {
  const producers = await scanSrcProducers();
  assert.equal(
    producers.size,
    1,
    `S1 failure: producer module count ≠ 1; got ${[...producers.keys()].join(", ") || "none"}`,
  );
  const [mod, count] = [...producers.entries()][0]!;
  assert.equal(
    count,
    1,
    `S1 failure: construction points in ${mod} ≠ 1; got ${count}`,
  );
  assert.equal(mod, "src/engine-labor-fallback.ts");
});

test("S1 negative: zero / cross-module / same-module split all fail the cardinality predicate", () => {
  // Zero producers.
  assert.equal(countEngineLaborFallbackConstructions("export const x = 1;\n"), 0);

  // Ordinary import / read / string compare must not count.
  assert.equal(
    countEngineLaborFallbackConstructions(`
      import { readEngineLaborFallbackFieldFrom } from "./engine-labor-fallback.ts";
      const v = source.engineLaborFallback;
      if (key === "engineLaborFallback") return;
      safelyRead(obj, "engineLaborFallback");
      type T = { engineLaborFallback: string };
    `),
    0,
  );

  // Single legitimate construction.
  assert.equal(
    countEngineLaborFallbackConstructions(`
      export function build() {
        return { engineLaborFallback: { engine: "kimi", failure: "x", laborBy: "seat" } };
      }
    `),
    1,
  );

  // Same-module split: two object constructions.
  assert.equal(
    countEngineLaborFallbackConstructions(`
      const a = { engineLaborFallback: { engine: "a", failure: "1", laborBy: "seat" } };
      const b = { engineLaborFallback: { engine: "b", failure: "2", laborBy: "seat" } };
    `),
    2,
  );

  // Same-module split: two functions each constructing.
  assert.equal(
    countEngineLaborFallbackConstructions(`
      function one() { return { engineLaborFallback: { engine: "a", failure: "1", laborBy: "seat" } }; }
      function two() { return { engineLaborFallback: { engine: "b", failure: "2", laborBy: "seat" } }; }
    `),
    2,
  );

  // Same-module split: two assignment branches.
  assert.equal(
    countEngineLaborFallbackConstructions(`
      const bag: Record<string, unknown> = {};
      if (cond) bag.engineLaborFallback = { engine: "a", failure: "1", laborBy: "seat" };
      else bag.engineLaborFallback = { engine: "b", failure: "2", laborBy: "seat" };
    `),
    2,
  );
});

test("S2: judge and reviewer chains both reach the sole producer module", async () => {
  const producer = "src/engine-labor-fallback.ts";
  const judgeReachable = await collectReachableImports("src/judge-role.ts");
  const reviewerReachable = await collectReachableImports("src/reviewer-role.ts");
  const detourReachable = await collectReachableImports("src/engine-detour-tool.ts");
  const evidenceReachable = await collectReachableImports("src/evidence-child-executor.ts");
  const runtimeReachable = await collectReachableImports("src/role-runtime.ts");

  assert.equal(
    judgeReachable.has(producer),
    true,
    "S2 failure: judge accept chain cannot reach sole producer",
  );
  assert.equal(
    reviewerReachable.has(producer),
    true,
    "S2 failure: reviewer accept chain cannot reach sole producer",
  );
  assert.equal(
    detourReachable.has(producer),
    true,
    "S2 failure: detour failure path cannot reach sole producer",
  );
  assert.equal(
    evidenceReachable.has(producer) || detourReachable.has(producer),
    true,
    "S2 failure: evidence-child detour path cannot reach sole producer",
  );
  assert.equal(
    runtimeReachable.has(producer),
    true,
    "S2 failure: role-runtime activation path cannot reach sole producer",
  );
});
