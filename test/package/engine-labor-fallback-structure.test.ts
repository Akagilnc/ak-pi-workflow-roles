/**
 * #380 S1/S2 / #391 — package structure oracle for sole engineLaborFallback producer.
 * S1: exactly one src module with exactly one construction/assignment of the field.
 * S2: all role accept chains + detour paths reach that sole producer via imports.
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

/** Advance past a brace-balanced `{...}` starting at `openIndex` (must be '{'). */
function skipBalancedBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * Drop `type` / `interface` declarations (including nested braces and
 * `type X = Readonly<{...}>`) so type-only property names are not producers.
 */
function stripTypeDeclarations(sourceText: string): string {
  const startRe =
    /\b(?:type|interface)\s+[A-Za-z0-9_$.]+\s*(?:<[^>]*>)?/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = startRe.exec(sourceText)) !== null) {
    result += sourceText.slice(lastIndex, match.index);
    let i = match.index + match[0].length;
    // optional extends clause for interface
    const extendsMatch = sourceText.slice(i).match(/^\s+extends\s+[^{;=]+/);
    if (extendsMatch) i += extendsMatch[0].length;
    // optional `=` for type alias
    const eqMatch = sourceText.slice(i).match(/^\s*=\s*/);
    if (eqMatch) i += eqMatch[0].length;
    // consume alias/body until semicolon at brace depth 0
    let depth = 0;
    for (; i < sourceText.length; i++) {
      const ch = sourceText[i]!;
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === ";" && depth === 0) {
        i++;
        break;
      }
    }
    result += " ";
    lastIndex = i;
    startRe.lastIndex = i;
  }
  result += sourceText.slice(lastIndex);
  // Drop type assertions `as Foo & { ... }` which are not runtime producers.
  return result.replace(
    /\bas\s+[A-Za-z0-9_$.]+(?:\s*[|&]\s*[A-Za-z0-9_$.]+)*(?:\s*&\s*)?/g,
    (prefix, offset, full: string) => {
      let i = offset + prefix.length;
      if (full[i] === "{") {
        i = skipBalancedBrace(full, i);
        return " ".repeat(Math.max(1, i - offset));
      }
      return " ";
    },
  );
}

/**
 * Drop `const|let|var { ... } =` destructuring bindings only.
 * Must not touch `Object.freeze({ ... })` or other call arguments.
 */
function stripDestructuringBindings(sourceText: string): string {
  const startRe = /\b(?:const|let|var)\s*\{/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = startRe.exec(sourceText)) !== null) {
    const openBrace = match.index + match[0].length - 1;
    const afterBrace = skipBalancedBrace(sourceText, openBrace);
    const eqMatch = sourceText.slice(afterBrace).match(/^\s*=/);
    if (!eqMatch) {
      // not a destructuring assignment — keep scanning inside
      startRe.lastIndex = openBrace + 1;
      continue;
    }
    result += sourceText.slice(lastIndex, match.index);
    result += " ";
    lastIndex = afterBrace + eqMatch[0].length;
    startRe.lastIndex = lastIndex;
  }
  result += sourceText.slice(lastIndex);
  return result;
}

/**
 * Count value-level construction/assignment points of `engineLaborFallback`.
 * - object property: engineLaborFallback: / "engineLaborFallback":
 * - object shorthand: { engineLaborFallback, } / { engineLaborFallback }
 * - assignment: .engineLaborFallback = / ["engineLaborFallback"] =
 * Ordinary reads, string compares, imports, destructuring, and type-only positions are excluded.
 */
export function countEngineLaborFallbackConstructions(sourceText: string): number {
  const text = stripDestructuringBindings(
    stripTypeDeclarations(stripComments(sourceText)),
  );
  const patterns = [
    // Object property construction (identifier or quoted key).
    new RegExp(
      `(?:^|[\\s,{])(?:${FIELD}|"${FIELD}"|'${FIELD}')\\s*:`,
      "g",
    ),
    // Object shorthand construction: { engineLaborFallback, } or { engineLaborFallback }
    new RegExp(`(?:^|[\\s,{])${FIELD}\\s*[,}]`, "g"),
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

  // Ordinary import / read / string compare / destructure must not count.
  assert.equal(
    countEngineLaborFallbackConstructions(`
      import { readEngineLaborFallbackFieldFrom } from "./engine-labor-fallback.ts";
      const v = source.engineLaborFallback;
      if (key === "engineLaborFallback") return;
      safelyRead(obj, "engineLaborFallback");
      const { engineLaborFallback } = source;
      const { engineLaborFallback: renamed } = source;
      type T = { engineLaborFallback: string };
    `),
    0,
  );

  // Nested type/interface property must not count (brace-balanced strip).
  assert.equal(
    countEngineLaborFallbackConstructions(`
      type Outer = {
        inner: {
          engineLaborFallback: string;
        };
      };
      interface Bag {
        nested: { engineLaborFallback: string };
      }
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

  // Object shorthand is a real producer.
  assert.equal(
    countEngineLaborFallbackConstructions(`
      const engineLaborFallback = { engine: "kimi", failure: "x", laborBy: "seat" };
      return { engineLaborFallback, other: 1 };
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

test("S2: all role chains reach the sole producer module", async () => {
  const producer = "src/engine-labor-fallback.ts";
  const roleEntryPoints = [
    "src/judge-role.ts",
    "src/reviewer-role.ts",
    "src/worker-role.ts",
    "src/doctor-role.ts",
    "src/collector-role.ts",
    "src/merger-role.ts",
  ] as const;
  for (const entry of roleEntryPoints) {
    const reachable = await collectReachableImports(entry);
    assert.equal(
      reachable.has(producer),
      true,
      `S2 failure: ${entry} accept chain cannot reach sole producer`,
    );
  }
  const detourReachable = await collectReachableImports("src/engine-detour-tool.ts");
  const evidenceReachable = await collectReachableImports("src/evidence-child-executor.ts");
  const runtimeReachable = await collectReachableImports("src/role-runtime.ts");

  assert.equal(
    detourReachable.has(producer),
    true,
    "S2 failure: detour failure path cannot reach sole producer",
  );
  // Direct requirement — detourReachable is independent; no tautological OR.
  assert.equal(
    evidenceReachable.has(producer),
    true,
    "S2 failure: evidence-child detour path cannot reach sole producer",
  );
  assert.equal(
    runtimeReachable.has(producer),
    true,
    "S2 failure: role-runtime activation path cannot reach sole producer",
  );
});

test("#391 E4 structure: registerEngineDetourTool call sites = 1; AK_ROLE_ENGINE write seam = 1",
  async () => {
    const files = await listTsFiles(SRC_ROOT);
    let detourRegisterCalls = 0;
    /** Modules that assign childEnv/env[AK_ROLE_ENGINE_ENV] (symbol-anchored write sites). */
    const engineWriteModules = new Set<string>();
    let applyEngineChildEnvDefs = 0;

    // Call-site: registerEngineDetourTool( — exclude the export function definition.
    const registerCallRe = /(?<!function\s)registerEngineDetourTool\s*\(/g;
    // Write-site: assignment to AK_ROLE_ENGINE_ENV keyed slot (not reads / deletes).
    const engineWriteRe =
      /(?:childEnv|env|process\.env)\s*\[\s*AK_ROLE_ENGINE_ENV\s*\]\s*=/g;
    const applyDefRe = /export\s+function\s+applyEngineChildEnv\s*\(/g;

    for (const file of files) {
      const raw = await readFile(file, "utf8");
      const text = stripTypeDeclarations(stripComments(raw));
      const rel = relative(packageRoot, file);

      const registerMatches = text.match(registerCallRe) ?? [];
      detourRegisterCalls += registerMatches.length;

      if (engineWriteRe.test(text)) {
        engineWriteModules.add(rel);
      }
      engineWriteRe.lastIndex = 0;

      if (applyDefRe.test(text)) {
        applyEngineChildEnvDefs += 1;
        assert.equal(
          rel,
          "src/engine-detour.ts",
          `applyEngineChildEnv must live in engine-detour.ts; found ${rel}`,
        );
      }
    }

    assert.equal(
      detourRegisterCalls,
      1,
      `registerEngineDetourTool call sites must be 1; got ${detourRegisterCalls}`,
    );
    assert.equal(
      applyEngineChildEnvDefs,
      1,
      `applyEngineChildEnv definition count must be 1; got ${applyEngineChildEnvDefs}`,
    );
    // Sole write module = applyEngineChildEnv home (symbol-anchored; not prose).
    assert.deepEqual(
      [...engineWriteModules].sort(),
      ["src/engine-detour.ts"],
      `AK_ROLE_ENGINE write modules must be exactly [engine-detour.ts]; got ${[...engineWriteModules].join(", ") || "none"}`,
    );

    // Call-site cardinality for the helper itself: every public *-run.ts must call it.
    let applyCalls = 0;
    const applyCallRe = /(?<!function\s)applyEngineChildEnv\s*\(/g;
    for (const file of files) {
      const raw = await readFile(file, "utf8");
      const text = stripTypeDeclarations(stripComments(raw));
      const matches = text.match(applyCallRe) ?? [];
      applyCalls += matches.length;
    }
    assert.equal(
      applyCalls,
      7,
      `applyEngineChildEnv call sites must equal the 7 public role runners; got ${applyCalls}`,
    );
  },
);
