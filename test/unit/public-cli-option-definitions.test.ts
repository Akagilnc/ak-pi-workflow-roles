/**
 * #342 — typed option true source → help / README / parsers.
 *
 * Contract → shortest tracer:
 * 1. table → helpDocument structured equivalence (one per-command tracer)
 * 2. required:true → real parser missing reject + shared-seam flip
 * 3. phase + repeatable → real production parsers
 * 4. rejected spellings bidirectional (surfaces + parser refuse)
 * 5. taishi conditional contracts → parseTaishiArgv pos/neg matrix
 * 6. public dashed options admitted (forward scan)
 * 7. README EN/ZH generated regions zero-diff
 * 8. installed-bin loud smoke (non-empty only)
 *
 * Absent on purpose: PUBLIC_ROLE_ARGV/optionsForOwner/projectOwnerOptions
 * identity mirrors, hand-rebuilt projection mirrors, synthetic helper tests
 * superseded by real parser tracers.
 */
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  helpDocument,
  helpDocumentForCommand,
} from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  PUBLIC_ROLE_OPTION_OWNERS,
  PUBLIC_CLI_OPTIONS_README_MARKERS,
  REJECTED_PUBLIC_SPELLINGS,
  TAISHI_REQUIRE_ANY_OF,
  allRejectedSpellingTokens,
  applyReadmeOptionsSection,
  createTypedOptionConsumer,
  optionsForOwner,
  projectOwnerOptions,
  renderReadmeOptionsMarkdown,
  type OptionOwner,
  type PublicOptionDefinition,
  type PublicRoleOptionOwner,
  type StructuredOptionProjection,
} from "../../src/public-cli/option-definitions.ts";
import {
  parseCoderArgv,
  parseCollectorArgv,
  parseDoctorArgv,
  parseFixerArgv,
  parseJudgeArgv,
  parseMergerArgv,
  parseReviewerArgv,
  parseTaishiArgv,
} from "../../src/public-cli/invocation.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const execFileAsync = promisify(execFile);
const isUsage = (error: unknown): boolean =>
  error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

/** Identity + structured semantics only (no prose). */
function structured(opt: StructuredOptionProjection) {
  return {
    id: opt.id,
    owner: opt.owner,
    canonical: opt.canonical,
    aliases: [...opt.aliases],
    valueMetavar: opt.valueMetavar,
    required: opt.required,
    repeatable: opt.repeatable,
    defaultValue: opt.defaultValue,
    form: opt.form,
    phases: opt.phases === undefined ? undefined : [...opt.phases],
    modes: opt.modes === undefined ? undefined : [...opt.modes],
    requiredInModes:
      opt.requiredInModes === undefined ? undefined : [...opt.requiredInModes],
    exclusiveWith:
      opt.exclusiveWith === undefined ? undefined : [...opt.exclusiveWith],
    maxCountByMode: opt.maxCountByMode,
    selectsMode: opt.selectsMode,
  };
}

const COHORT_MIN = [
  "--cohort",
  "--group-a-label",
  "A",
  "--group-a-issues",
  "1",
  "--group-b-label",
  "B",
  "--group-b-issues",
  "2",
] as const;

test("table→helpDocument: per-command structured option semantics are equivalent", () => {
  const owners: OptionOwner[] = ["global", ...PUBLIC_ROLE_OPTION_OWNERS];
  assert.deepEqual(
    helpDocument().globalOptions.map(structured),
    projectOwnerOptions("global").map(structured),
  );
  for (const owner of owners) {
    const doc = helpDocumentForCommand(owner);
    assert.ok(doc, owner);
    assert.equal(doc.command, owner);
    assert.equal(
      doc.kind,
      owner === "global"
        ? "global"
        : owner === "taishi"
          ? "deterministic"
          : "role",
    );
    const fromTable = projectOwnerOptions(owner);
    assert.ok(fromTable.length > 0, owner);
    assert.deepEqual(
      doc.options.map(structured),
      fromTable.map(structured),
      owner,
    );
  }
  assert.equal(helpDocumentForCommand("navigator"), undefined);
  assert.equal(helpDocumentForCommand("not-a-command"), undefined);
});

test("unconditional required: table required:true is the sole missing-option gate", () => {
  const requiredRows: string[] = [];
  for (const owner of PUBLIC_ROLE_OPTION_OWNERS) {
    for (const def of optionsForOwner(owner)) {
      if (def.required) requiredRows.push(`${owner}/${def.id}`);
    }
  }
  assert.deepEqual(requiredRows.sort(), [
    "collector/pr",
    "doctor/issue",
    "reviewer/base",
  ]);
  assert.throws(() => parseReviewerArgv(["task"]), isUsage);
  assert.throws(() => parseCollectorArgv(["task"]), isUsage);
  assert.throws(() => parseDoctorArgv(["task"]), isUsage);

  // Flip required on the shared seam → behavior flips (table is the gate).
  const base = {
    id: "probe",
    owner: "reviewer" as const,
    canonical: "--probe",
    aliases: [] as const,
    valueMetavar: "x",
    repeatable: false,
    form: "option" as const,
    description: { en: "probe", zh: "探针" },
  };
  const req: PublicOptionDefinition = { ...base, required: true };
  const opt: PublicOptionDefinition = { ...base, required: false };
  assert.throws(
    () => createTypedOptionConsumer([req]).assertRequired(),
    (e: unknown) =>
      isUsage(e) && e instanceof Error && e.message.includes("requires --probe"),
  );
  createTypedOptionConsumer([opt]).assertRequired();
  const present = createTypedOptionConsumer([req]);
  assert.ok(present.takeDashed(["--probe", "v"]));
  present.assertRequired();
});

test("real parsers: phase from table; repeatable:false rejects; repeatable:true admits", () => {
  assert.equal(parseCoderArgv(["task"]).phase, "apply");
  assert.equal(parseCoderArgv(["plan", "task"]).phase, "plan");
  assert.equal(parseCoderArgv(["apply", "task"]).phase, "apply");
  assert.equal(parseFixerArgv(["plan", "fix it"]).phase, "plan");
  assert.equal(parseFixerArgv(["just fix"]).phase, "apply");

  const dups: Array<{
    name: string;
    parse: (a: readonly string[]) => unknown;
    argv: string[];
    flag: string;
  }> = [
    {
      name: "judge/--project",
      parse: parseJudgeArgv,
      argv: ["--project", "/a", "--project", "/b", "task"],
      flag: "--project",
    },
    {
      name: "coder/--project",
      parse: parseCoderArgv,
      argv: ["--project", "/a", "--project", "/b", "task"],
      flag: "--project",
    },
    {
      name: "fixer/--project",
      parse: parseFixerArgv,
      argv: ["--project", "/a", "--project", "/b", "task"],
      flag: "--project",
    },
    {
      name: "reviewer/--base",
      parse: parseReviewerArgv,
      argv: ["--base", "main", "--base", "dev", "task"],
      flag: "--base",
    },
    {
      name: "doctor/--issue",
      parse: parseDoctorArgv,
      argv: ["--issue", "1", "--issue", "2"],
      flag: "--issue",
    },
    {
      name: "collector/--pr",
      parse: parseCollectorArgv,
      argv: ["--pr", "1", "--pr", "2", "--repo", "acme/x"],
      flag: "--pr",
    },
    {
      name: "merger/--project",
      parse: parseMergerArgv,
      argv: ["--project", "/a", "--project", "/b", "task"],
      flag: "--project",
    },
    {
      name: "taishi/--ticket",
      parse: parseTaishiArgv,
      argv: ["--ticket", "1", "--ticket", "2"],
      flag: "--ticket",
    },
  ];
  for (const row of dups) {
    assert.throws(
      () => row.parse(row.argv),
      (e: unknown) =>
        isUsage(e)
        && e instanceof Error
        && e.message.includes(`${row.flag} cannot be repeated`),
      row.name,
    );
  }

  assert.deepEqual(
    parseCoderArgv(["--attach", "/a", "--attach", "/b", "task"]).attachmentPaths,
    ["/a", "/b"],
  );
  assert.deepEqual(
    parseReviewerArgv([
      "--base",
      "main",
      "--authority-ref",
      "https://example.test/a",
      "--authority-ref",
      "https://example.test/b",
      "task",
    ]).authorityRefs,
    ["https://example.test/a", "https://example.test/b"],
  );
  assert.throws(
    () => parseTaishiArgv(["--model-groups"]),
    (e: unknown) =>
      isUsage(e)
      && e instanceof Error
      && /model-groups/i.test(e.message)
      && /disabled|redesign|multi-issue|follow-up/i.test(e.message),
  );
  assert.throws(
    () => parseTaishiArgv(["--project-root", "/a"]),
    (e: unknown) =>
      isUsage(e)
      && e instanceof Error
      && /project-root/i.test(e.message)
      && /deleted|bare|--ticket/i.test(e.message),
  );

  assert.throws(
    () => parseTaishiArgv(["sweep", "sweep", "--attach", "/x"]),
    (e: unknown) =>
      isUsage(e)
      && e instanceof Error
      && e.message.includes("sweep cannot be repeated"),
  );
});

test("rejected spellings: absent from public surfaces; parsers refuse them", () => {
  const rejected = allRejectedSpellingTokens();
  assert.ok(rejected.includes("--burden"));
  assert.ok(rejected.includes("--ak-merger-input"));
  assert.ok(rejected.includes("--project-root"));
  assert.ok(rejected.includes("--model-groups"));

  for (const owner of ["global", ...PUBLIC_ROLE_OPTION_OWNERS] as OptionOwner[]) {
    const doc = helpDocumentForCommand(owner);
    assert.ok(doc, owner);
    for (const opt of [...doc.options, ...optionsForOwner(owner)]) {
      for (const spelling of [opt.canonical, ...opt.aliases]) {
        assert.equal(
          rejected.includes(spelling),
          false,
          `${owner} leaked rejected ${spelling}`,
        );
      }
    }
  }

  for (const entry of REJECTED_PUBLIC_SPELLINGS) {
    for (const spelling of entry.spellings) {
      if (entry.owner === "judge") {
        assert.throws(
          () => parseJudgeArgv([spelling, "x", "task"]),
          (e: unknown) =>
            e instanceof Error
            && e.message.includes("burden")
            && !e.message.includes("unknown judge option"),
        );
      }
      if (entry.owner === "merger") {
        assert.throws(
          () => parseMergerArgv([spelling, "x", "task"]),
          (e: unknown) =>
            e instanceof Error
            && (e.message.includes("ak-merger-input")
              || e.message.includes("internal")
              || e.message.includes("packet")
              || e.message.includes("merger")),
        );
      }
      if (entry.owner === "taishi") {
        const argv =
          spelling === "--project-root" ? [spelling, "/tmp/p"] : [spelling];
        assert.throws(
          () => parseTaishiArgv(argv),
          (e: unknown) =>
            e instanceof Error
            && e.message.includes(spelling.slice(2))
            && !e.message.includes("unknown taishi option"),
        );
      }
    }
  }
});

test("taishi structured mode contracts drive parseTaishiArgv (pos/neg matrix)", () => {
  const byId = new Map(
    optionsForOwner("taishi").map((opt) => [opt.id, opt] as const),
  );
  assert.ok(byId.get("ticket")?.modes?.includes("issue"));
  assert.equal(byId.has("project-root"), false);
  assert.equal(byId.has("model-groups"), false);
  assert.equal(byId.get("cohort")?.selectsMode, "cohort");
  assert.equal(byId.get("cohort")?.exclusiveWith, undefined);
  assert.equal(byId.get("sweep")?.selectsMode, "sweep");
  assert.equal(byId.get("attach")?.selectsMode, "sweep");
  assert.deepEqual(byId.get("attach")?.requiredInModes, ["sweep"]);
  assert.deepEqual(byId.get("attach")?.maxCountByMode, { sweep: 1 });
  for (const id of [
    "group-a-label",
    "group-a-issues",
    "group-b-label",
    "group-b-issues",
  ] as const) {
    assert.deepEqual(byId.get(id)?.requiredInModes, ["cohort"]);
    assert.deepEqual(byId.get(id)?.modes, ["cohort"]);
  }
  assert.deepEqual([...TAISHI_REQUIRE_ANY_OF], []);
  const rejected = allRejectedSpellingTokens();
  assert.ok(rejected.includes("--project-root"));
  assert.ok(rejected.includes("--model-groups"));

  type Expect =
    | { ok: true; query: string }
    | { ok: false; re: RegExp };
  const cases: Array<{
    name: string;
    rule: string;
    argv: string[];
    expect: Expect;
  }> = [
    {
      name: "issue+ticket",
      rule: "modes:ticket:issue-ok",
      argv: ["--ticket", "1"],
      expect: { ok: true, query: "issue" },
    },
    {
      name: "issue bare",
      rule: "issue-bare-lawful",
      argv: [],
      expect: { ok: true, query: "issue" },
    },
    {
      name: "issue rejects project-root",
      rule: "rejected:project-root",
      argv: ["--project-root", "/tmp/p"],
      expect: { ok: false, re: /project-root/i },
    },
    {
      name: "issue rejects ticket+project-root",
      rule: "rejected:project-root",
      argv: ["--ticket", "1", "--project-root", "/tmp/p"],
      expect: { ok: false, re: /project-root/i },
    },
    {
      name: "cohort ok",
      rule: "requiredInModes:cohort:group-*",
      argv: [...COHORT_MIN],
      expect: { ok: true, query: "cohort" },
    },
    {
      name: "cohort missing",
      rule: "requiredInModes:cohort:group-*",
      argv: ["--cohort"],
      expect: { ok: false, re: /group-a-label|usage:.*cohort/i },
    },
    {
      name: "cohort×ticket",
      rule: "modes:ticket:issue-only",
      argv: [...COHORT_MIN, "--ticket", "1"],
      expect: { ok: false, re: /ticket/i },
    },
    {
      name: "cohort×root",
      rule: "rejected:project-root",
      argv: [...COHORT_MIN, "--project-root", "/p"],
      expect: { ok: false, re: /project-root/i },
    },
    {
      name: "cohort×attach",
      rule: "modes:attach:sweep-only",
      argv: [...COHORT_MIN, "--attach", "/tmp/s.json"],
      expect: { ok: false, re: /attach/i },
    },
    {
      name: "model-groups disabled bare",
      rule: "rejected:model-groups-disabled",
      argv: ["--model-groups"],
      expect: { ok: false, re: /model-groups/i },
    },
    {
      name: "model-groups disabled + roots",
      rule: "rejected:model-groups-disabled",
      argv: ["--model-groups", "--project-root", "/a", "--project-root", "/b"],
      expect: { ok: false, re: /model-groups|project-root/i },
    },
    {
      name: "cohort×model-groups",
      rule: "rejected:model-groups-disabled",
      argv: ["--cohort", "--model-groups"],
      expect: { ok: false, re: /model-groups/i },
    },
    {
      name: "sweep attach",
      rule: "selectsMode:attach→sweep",
      argv: ["--attach", "/tmp/s.json"],
      expect: { ok: true, query: "sweep" },
    },
    {
      name: "sweep token + attach",
      rule: "selectsMode:sweep→sweep",
      argv: ["sweep", "--attach", "/tmp/s.json"],
      expect: { ok: true, query: "sweep" },
    },
    {
      name: "sweep zero attach",
      rule: "requiredInModes:sweep:attach",
      argv: ["sweep"],
      expect: { ok: false, re: /requires --attach/i },
    },
    {
      name: "sweep double attach",
      rule: "maxCountByMode:attach:sweep:1",
      argv: ["sweep", "--attach", "/a", "--attach", "/b"],
      expect: { ok: false, re: /at most one --attach/i },
    },
    {
      name: "sweep×ticket",
      rule: "modes:ticket:issue-only",
      argv: ["sweep", "--attach", "/tmp/s.json", "--ticket", "1"],
      expect: { ok: false, re: /ticket/i },
    },
    {
      name: "sweep×root",
      rule: "rejected:project-root",
      argv: ["--attach", "/tmp/s.json", "--project-root", "/p"],
      expect: { ok: false, re: /project-root/i },
    },
    {
      name: "group on issue",
      rule: "modes:group-a-label:cohort-only",
      argv: ["--group-a-label", "A", "--ticket", "1"],
      expect: { ok: false, re: /group-a-label/i },
    },
  ];

  const covered = new Set<string>();
  for (const s of cases) {
    covered.add(s.rule);
    if (s.expect.ok) {
      assert.equal(parseTaishiArgv(s.argv).query, s.expect.query, s.name);
    } else {
      const expectedRe = s.expect.re;
      assert.throws(
        () => parseTaishiArgv(s.argv),
        (e: unknown) => {
          assert.ok(e instanceof Error, s.name);
          assert.match(e.message, expectedRe, `${s.name}: ${e.message}`);
          return true;
        },
        s.name,
      );
    }
  }
  for (const rule of [
    "issue-bare-lawful",
    "modes:ticket:issue-ok",
    "rejected:project-root",
    "rejected:model-groups-disabled",
    "requiredInModes:cohort:group-*",
    "requiredInModes:sweep:attach",
    "maxCountByMode:attach:sweep:1",
    "modes:ticket:issue-only",
    "modes:attach:sweep-only",
    "modes:group-a-label:cohort-only",
    "selectsMode:attach→sweep",
    "selectsMode:sweep→sweep",
  ] as const) {
    assert.equal(covered.has(rule), true, `missing ${rule}`);
  }
});

test("public dashed options admitted; shared project/attach owner-binding preserved", () => {
  type Case = {
    owner: PublicRoleOptionOwner;
    parse: (a: readonly string[]) => unknown;
    build: (flags: string[]) => string[];
  };
  const cases: Case[] = [
    {
      owner: "judge",
      parse: parseJudgeArgv,
      build: (f) => [...f, "task"],
    },
    {
      owner: "coder",
      parse: parseCoderArgv,
      build: (f) => [...f, "task"],
    },
    {
      owner: "fixer",
      parse: parseFixerArgv,
      build: (f) => [...f, "task"],
    },
    {
      owner: "reviewer",
      parse: parseReviewerArgv,
      build: (f) =>
        f.some((t) => t === "--base" || t.startsWith("--base="))
          ? [...f, "task"]
          : ["--base", "main", ...f, "task"],
    },
    {
      owner: "collector",
      parse: parseCollectorArgv,
      build: (f) =>
        f.some((t) => t === "--pr" || t.startsWith("--pr="))
          ? [...f, "--repo", "acme/widgets"]
          : ["--pr", "1", "--repo", "acme/widgets", ...f],
    },
    {
      owner: "doctor",
      parse: parseDoctorArgv,
      build: (f) =>
        f.some((t) => t === "--issue" || t.startsWith("--issue="))
          ? [...f]
          : ["--issue", "1", ...f],
    },
    {
      owner: "merger",
      parse: parseMergerArgv,
      build: (f) => [...f, "task"],
    },
  ];

  let ok = 0;
  for (const s of cases) {
    for (const opt of optionsForOwner(s.owner)) {
      if (opt.form !== "option") continue;
      const flags =
        opt.valueMetavar === null
          ? [opt.canonical]
          : [opt.canonical, sampleValue(opt.valueMetavar, opt.id)];
      try {
        s.parse(s.build(flags));
        ok += 1;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        assert.equal(
          /unknown \w+ option/.test(msg),
          false,
          `${s.owner} ${opt.canonical}: ${msg}`,
        );
        ok += 1;
      }
    }
  }
  assert.ok(ok >= 10);

  for (const opt of optionsForOwner("taishi")) {
    if (opt.form !== "option") continue;
    const face =
      opt.modes?.[0] === "cohort"
        ? [...COHORT_MIN]
        : opt.modes?.[0] === "sweep"
          ? opt.id === "attach"
            ? ["--attach", "/tmp/s.json"]
            : [
                "sweep",
                opt.canonical,
                sampleValue(opt.valueMetavar ?? "path", opt.id),
              ]
          : opt.id === "ticket"
            ? ["--ticket", "1"]
            : [
                "--ticket",
                "1",
                opt.canonical,
                sampleValue(opt.valueMetavar ?? "path", opt.id),
              ];
    try {
      parseTaishiArgv(face);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      assert.equal(
        /unknown taishi option/.test(msg),
        false,
        `taishi ${opt.canonical}: ${msg}`,
      );
    }
  }

  // Shared project semantics (owner-binding only); merger/taishi/reviewer differ.
  const judgeProject = optionsForOwner("judge").find((o) => o.id === "project")!;
  const canon = structured(projectOwnerOptions("judge").find((o) => o.id === "project")!);
  for (const owner of [
    "judge",
    "coder",
    "fixer",
    "reviewer",
    "collector",
    "doctor",
  ] as const) {
    const row = projectOwnerOptions(owner).find((o) => o.id === "project")!;
    assert.deepEqual({ ...structured(row), owner: "judge" }, canon, owner);
    assert.equal(row.description.en, judgeProject.description.en, owner);
  }
  assert.notEqual(
    optionsForOwner("merger").find((o) => o.id === "project")!.description.en,
    judgeProject.description.en,
  );
  assert.equal(optionsForOwner("reviewer").some((o) => o.id === "attach"), false);
  const taishiAttach = optionsForOwner("taishi").find((o) => o.id === "attach")!;
  assert.deepEqual(taishiAttach.modes, ["sweep"]);
  assert.equal(taishiAttach.selectsMode, "sweep");
});

function sampleValue(metavar: string, id: string): string {
  switch (metavar) {
    case "path":
      return id === "attach" ? "/tmp/attach.txt" : "/tmp/project";
    case "revision":
      return "main";
    case "number":
      return "1";
    case "owner/repo":
      return "acme/widgets";
    case "ref":
      return "https://example.invalid/authority";
    case "label":
      return "group";
    case "N[,N...]":
      return "1,2";
    case "provider/model":
      return "xai/grok-4.5";
    case "level":
      return "high";
    default:
      return "sample";
  }
}

/** Split a GFM table row on unescaped `|` cell boundaries. */

test("README EN/ZH generated regions are regeneration-clean", async () => {
  const en = await readFile(resolve(packageRoot, "README.md"), "utf8");
  const zh = await readFile(resolve(packageRoot, "README.zh-CN.md"), "utf8");
  assert.ok(en.includes(PUBLIC_CLI_OPTIONS_README_MARKERS.begin));
  assert.ok(zh.includes(PUBLIC_CLI_OPTIONS_README_MARKERS.begin));
  assert.equal(
    applyReadmeOptionsSection(en, "en"),
    en,
    "README.md drifted — run: node --import tsx scripts/render-public-cli-options-readme.ts",
  );
  assert.equal(
    applyReadmeOptionsSection(zh, "zh"),
    zh,
    "README.zh-CN.md drifted — run: node --import tsx scripts/render-public-cli-options-readme.ts",
  );
  for (const spelling of allRejectedSpellingTokens()) {
    assert.equal(renderReadmeOptionsMarkdown("en").includes(spelling), false);
    assert.equal(renderReadmeOptionsMarkdown("zh").includes(spelling), false);
  }
});

