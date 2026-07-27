import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  COLLECTOR_LEGS_SCHEMA,
  loadCollectorManifest,
  parseCollectorPrNumber,
  parseCollectorRepository,
  type CollectorManifest,
} from "../src/collector-config.ts";

async function writeManifest(
  dir: string,
  value: unknown,
  name = "legs.json",
): Promise<string> {
  const path = resolve(dir, name);
  await writeFile(
    path,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
  return path;
}

function validManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    legs: [
      {
        id: "codex",
        expectedAuthors: ["CodexBot"],
        request: { body: "Please review this PR." },
      },
    ],
    ...overrides,
  };
}

test("repository grammar accepts owner/repo boundaries and lowercases identity", () => {
  assert.throws(() => parseCollectorRepository("A"), /exactly one/);

  const min = parseCollectorRepository("a/b");
  assert.equal(min.display, "a/b");
  assert.equal(min.canonical, "a/b");
  assert.equal(min.owner, "a");
  assert.equal(min.repo, "b");

  const owner39 = "a".repeat(39);
  const repo100 = `b${"c".repeat(98)}d`;
  const max = parseCollectorRepository(`${owner39}/${repo100}`);
  assert.equal(max.canonical, `${owner39}/${repo100}`.toLowerCase());

  assert.throws(
    () => parseCollectorRepository(`${"a".repeat(40)}/b`),
    /owner/,
  );
  assert.throws(
    () => parseCollectorRepository(`a/${"b".repeat(101)}`),
    /repo/,
  );

  const mixed = parseCollectorRepository("OctoCat/Hello-World");
  assert.equal(mixed.display, "OctoCat/Hello-World");
  assert.equal(mixed.canonical, "octocat/hello-world");
  assert.equal(mixed.owner, "octocat");
  assert.equal(mixed.repo, "hello-world");
});

test("repository grammar rejects URLs, credentials, punctuation edges, and control bytes", () => {
  const rejected = [
    "https://github.com/a/b",
    "a/b?x=1",
    "a/b#frag",
    "user:pass@a/b",
    "a/b/c",
    "a//b",
    "/a/b",
    "a/b/",
    " a/b",
    "a /b",
    "a/b ",
    "a/%2eb",
    "a/b.c.",
    ".a/b",
    "a/.b",
    "a/..",
    "a/.",
    "ä/b",
    "a/\u0001b",
    "a/b\n",
    "-a/b",
    "a/-b",
    "a-/b",
    "a/b-",
    "a/_b",
    "a/b_",
  ];
  for (const input of rejected) {
    assert.throws(() => parseCollectorRepository(input), /repository|owner|repo/i, input);
  }
  // middle hyphen/dot/underscore are allowed when endpoints are alphanumeric
  assert.equal(parseCollectorRepository("a-b/c_d.e").canonical, "a-b/c_d.e");
  assert.equal(parseCollectorRepository("a/b..c").canonical, "a/b..c");
});

test("PR number accepts only positive safe integers", () => {
  assert.equal(parseCollectorPrNumber("1"), 1);
  assert.equal(parseCollectorPrNumber("9007199254740991"), 9007199254740991);
  for (const bad of ["0", "-1", "1.5", "01", "1e2", "NaN", "9007199254740992", ""]) {
    assert.throws(() => parseCollectorPrNumber(bad), /pull request|PR/i, bad);
  }
});

test("manifest schema file matches the packaged machine-readable contract", () => {
  assert.equal(COLLECTOR_LEGS_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(COLLECTOR_LEGS_SCHEMA.type, "object");
  assert.equal((COLLECTOR_LEGS_SCHEMA as { additionalProperties?: boolean }).additionalProperties, false);
  assert.deepEqual(COLLECTOR_LEGS_SCHEMA.required, ["version", "legs"]);
  assert.equal(COLLECTOR_LEGS_SCHEMA.properties.version.const, 1);
});

test("manifest loads, normalizes authors, and digests canonical JSON stably", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "ak-collector-manifest-"));
  const path = await writeManifest(dir, validManifest({
    legs: [
      {
        id: "codex",
        expectedAuthors: [" CodexBot ", "helper"],
        request: { body: "Please review this PR." },
      },
      {
        id: "claude",
        expectedAuthors: ["Claude-Bot"],
      },
    ],
  }));
  const first = await loadCollectorManifest(path);
  const second = await loadCollectorManifest(path);
  assert.equal(first.version, 1);
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest.length, 64);
  assert.deepEqual(
    first.legs.map((leg) => ({
      id: leg.id,
      expectedAuthors: [...leg.expectedAuthors],
      requestBody: leg.requestBody,
    })),
    [
      {
        id: "codex",
        expectedAuthors: ["codexbot", "helper"],
        requestBody: "Please review this PR.",
      },
      {
        id: "claude",
        expectedAuthors: ["claude-bot"],
        requestBody: undefined,
      },
    ],
  );
  assert.equal(first.canonicalJson.includes("CodexBot"), false);
  assert.equal(first.canonicalJson.includes("codexbot"), true);
});

test("manifest rejects unreadable path, non-UTF-8, malformed JSON, and duplicate keys", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "ak-collector-bad-manifest-"));
  await assert.rejects(
    () => loadCollectorManifest(resolve(dir, "missing.json")),
    /unreadable|ENOENT|manifest/i,
  );

  const nonUtf = resolve(dir, "non-utf.json");
  await writeFile(nonUtf, Buffer.from([0xff, 0xfe, 0x00, 0x61]));
  await assert.rejects(() => loadCollectorManifest(nonUtf), /UTF-8|utf-8/i);

  const malformed = await writeManifest(dir, "{not-json", "malformed.json");
  await assert.rejects(() => loadCollectorManifest(malformed), /JSON|manifest/i);

  const topDup = await writeManifest(
    dir,
    '{"version":1,"version":2,"legs":[{"id":"a","expectedAuthors":["x"]}]}',
    "top-dup.json",
  );
  await assert.rejects(() => loadCollectorManifest(topDup), /duplicate/i);

  const nestedDup = await writeManifest(
    dir,
    '{"version":1,"legs":[{"id":"a","id":"b","expectedAuthors":["x"]}]}',
    "nested-dup.json",
  );
  await assert.rejects(() => loadCollectorManifest(nestedDup), /duplicate/i);

  const escapedDup = await writeManifest(
    dir,
    '{"version":1,"legs":[{"id":"a","expectedAuthors":["x"]}],"\\u0076ersion":2}',
    "escaped-dup.json",
  );
  await assert.rejects(() => loadCollectorManifest(escapedDup), /duplicate/i);
});

test("manifest rejects wrong version, unknown fields, empty legs, bad ids, and author problems", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "ak-collector-sem-"));
  const cases: Array<[string, unknown, RegExp]> = [
    ["float-version", { version: 1.1, legs: [{ id: "a", expectedAuthors: ["x"] }] }, /version/i],
    ["string-version", { version: "1", legs: [{ id: "a", expectedAuthors: ["x"] }] }, /version/i],
    ["unknown-top", { version: 1, legs: [{ id: "a", expectedAuthors: ["x"] }], extra: true }, /unknown|additional|only version and legs/i],
    ["unknown-leg", { version: 1, legs: [{ id: "a", expectedAuthors: ["x"], bot: true }] }, /unknown|additional|missing required/i],
    ["no-legs", { version: 1, legs: [] }, /legs|min/i],
    ["bad-id-case", { version: 1, legs: [{ id: "Codex", expectedAuthors: ["x"] }] }, /id/i],
    ["bad-id-start", { version: 1, legs: [{ id: "1codex", expectedAuthors: ["x"] }] }, /id/i],
    ["dup-id", {
      version: 1,
      legs: [
        { id: "a", expectedAuthors: ["x"] },
        { id: "a", expectedAuthors: ["y"] },
      ],
    }, /id|duplicate/i],
    ["empty-authors", { version: 1, legs: [{ id: "a", expectedAuthors: [] }] }, /author/i],
    ["blank-author", { version: 1, legs: [{ id: "a", expectedAuthors: ["  "] }] }, /author/i],
    ["dup-author-case", {
      version: 1,
      legs: [{ id: "a", expectedAuthors: ["Bot", "bot"] }],
    }, /author|duplicate/i],
    ["overlap-authors", {
      version: 1,
      legs: [
        { id: "a", expectedAuthors: ["shared"] },
        { id: "b", expectedAuthors: ["Shared"] },
      ],
    }, /overlap|author/i],
    ["empty-body", {
      version: 1,
      legs: [{ id: "a", expectedAuthors: ["x"], request: { body: "  " } }],
    }, /body/i],
    ["unknown-request", {
      version: 1,
      legs: [{ id: "a", expectedAuthors: ["x"], request: { body: "ok", extra: 1 } }],
    }, /unknown|additional|only body/i],
  ];
  for (const [name, value, pattern] of cases) {
    const path = await writeManifest(dir, value, `${name}.json`);
    await assert.rejects(() => loadCollectorManifest(path), pattern, name);
  }
});

test("request body enforces trim-non-empty content and exact 60_000 UTF-8 byte bound", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "ak-collector-body-"));
  const exact = "é".repeat(30_000); // 2 bytes each => 60_000
  assert.equal(Buffer.byteLength(exact, "utf8"), 60_000);
  const okPath = await writeManifest(dir, validManifest({
    legs: [{ id: "a", expectedAuthors: ["x"], request: { body: exact } }],
  }), "ok-body.json");
  const ok = await loadCollectorManifest(okPath);
  assert.equal(ok.legs[0]?.requestBody, exact);

  const over = `${exact}!`;
  assert.equal(Buffer.byteLength(over, "utf8"), 60_001);
  const overPath = await writeManifest(dir, validManifest({
    legs: [{ id: "a", expectedAuthors: ["x"], request: { body: over } }],
  }), "over-body.json");
  await assert.rejects(() => loadCollectorManifest(overPath), /60,?000|byte/i);
});

test("loadCollectorManifest does not invoke any transport or provider side effects", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "ak-collector-pure-"));
  const path = await writeManifest(dir, validManifest());
  const loaded: CollectorManifest = await loadCollectorManifest(path);
  assert.equal(loaded.legs.length, 1);
  // purity is structural: this module exports no GitHub/provider hooks
  assert.equal("createGitHubTransport" in (await import("../src/collector-config.ts")), false);
});
