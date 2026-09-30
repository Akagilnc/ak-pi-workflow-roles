/**
 * #342 — typed option true source → help / parsers.
 *
 * Contract → shortest tracer:
 * 1. table → helpDocument structured equivalence (one per-command tracer)
 * 2. required:true → real parser missing reject + shared-seam flip
 * 3. phase + repeatable → real production parsers
 * 4. rejected spellings bidirectional (surfaces + parser refuse)
 * 5. analyst conditional contracts → parseAnalystArgv pos/neg matrix
 * 6. public dashed options admitted (forward scan)
 * 7. installed-bin loud smoke (non-empty only)
 *
 * Absent on purpose: PUBLIC_ROLE_ARGV/optionsForOwner/projectOwnerOptions
 * identity mirrors, hand-rebuilt projection mirrors, synthetic helper tests
 * superseded by real parser tracers.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  helpDocument,
  helpDocumentForCommand,
} from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  PUBLIC_ROLE_OPTION_OWNERS,
  REJECTED_PUBLIC_SPELLINGS,
  ANALYST_REQUIRE_ANY_OF,
  allRejectedSpellingTokens,
  createTypedOptionConsumer,
  optionsForOwner,
  projectOwnerOptions,
  type OptionOwner,
  type PublicOptionDefinition,
  type PublicRoleOptionOwner,
  type StructuredOptionProjection,
} from "../../src/public-cli/option-definitions.ts";
import {
  parseAnalystArgv,
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";

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
        : owner === "analyst"
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
    "auditor/source-run",
    "auditor/subject",
    "doctor/issue",
    "gleaner-left/base",
    "notary/source-run",
    "reviewer/authority-ref",
    "reviewer/base",
  ]);
  assert.throws(() => parsePublicSeatArgv("reviewer", ["task"]), isUsage);
  // #676 D1: collector --pr is optional at parse; ambiguity rejects at admission.
  assert.deepEqual(parsePublicSeatArgv("collector", ["task"]), {
    instruction: "task",
    attachmentPaths: [],
  });
  assert.throws(() => parsePublicSeatArgv("doctor", ["task"]), isUsage);

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
    isUsage,
  );
  createTypedOptionConsumer([opt]).assertRequired();
  const present = createTypedOptionConsumer([req]);
  assert.ok(present.takeDashed(["--probe", "v"]));
  present.assertRequired();
});

test("real parsers: phase from table; repeatable:false rejects; repeatable:true admits", () => {
  assert.equal(parsePublicSeatArgv("coder", ["task"]).phase, "apply");
  assert.equal(parsePublicSeatArgv("coder", ["plan", "task"]).phase, "plan");
  assert.equal(parsePublicSeatArgv("coder", ["apply", "task"]).phase, "apply");
  assert.equal(parsePublicSeatArgv("fixer", ["plan", "fix it"]).phase, "plan");
  assert.equal(parsePublicSeatArgv("fixer", ["just fix"]).phase, "apply");

  const dups: Array<{
    name: string;
    parse: (a: readonly string[]) => unknown;
    argv: string[];
  }> = [
    {
      name: "judge/--project",
      parse: (args) => parsePublicSeatArgv("judge", args),
      argv: ["--project", "/a", "--project", "/b", "task"],
    },
    {
      name: "coder/--project",
      parse: (args) => parsePublicSeatArgv("coder", args),
      argv: ["--project", "/a", "--project", "/b", "task"],
    },
    {
      name: "fixer/--project",
      parse: (args) => parsePublicSeatArgv("fixer", args),
      argv: ["--project", "/a", "--project", "/b", "task"],
    },
    {
      // Satisfies every other reviewer precondition, so only the repeated
      // --base can reject: otherwise a missing --authority-ref would mask it.
      name: "reviewer/--base",
      parse: (args) => parsePublicSeatArgv("reviewer", args),
      argv: [
        "--base",
        "main",
        "--base",
        "dev",
        "--authority-ref",
        "https://example.test/a",
        "task",
      ],
    },
    {
      name: "doctor/--issue",
      parse: (args) => parsePublicSeatArgv("doctor", args),
      argv: ["--issue", "1", "--issue", "2"],
    },
    {
      name: "collector/--pr",
      parse: (args) => parsePublicSeatArgv("collector", args),
      argv: ["--pr", "1", "--pr", "2", "--repo", "acme/x"],
    },
    {
      name: "merger/--project",
      parse: (args) => parsePublicSeatArgv("merger", args),
      argv: ["--project", "/a", "--project", "/b", "task"],
    },
    {
      name: "analyst/--ticket",
      parse: parseAnalystArgv,
      argv: ["--ticket", "1", "--ticket", "2"],
    },
  ];
  for (const row of dups) {
    assert.throws(
      () => row.parse(row.argv),
      isUsage,
      row.name,
    );
  }

  assert.deepEqual(
    parsePublicSeatArgv("coder", ["--attach", "/a", "--attach", "/b", "task"]).attachmentPaths,
    ["/a", "/b"],
  );
  assert.deepEqual(
    parsePublicSeatArgv("reviewer", [
      "--base",
      "main",
      "--lens",
      "completeness",
      "--authority-ref",
      "https://example.test/a",
      "--authority-ref",
      "https://example.test/b",
      "task",
    ]).authorityRefs,
    ["https://example.test/a", "https://example.test/b"],
  );
  // --model-groups refusal is carried by the real CLI case in
  // analyst-public-cli.test.ts (refusal + zero analyst writes); asserting it
  // here too would restate the same conclusion.
  assert.throws(
    () => parseAnalystArgv(["--project-root", "/a"]),
    isUsage,
  );

  assert.throws(
    () => parseAnalystArgv(["sweep", "sweep", "--attach", "/x"]),
    isUsage,
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
          () => parsePublicSeatArgv("judge", [spelling, "x", "task"]),
          isUsage,
        );
      }
      if (entry.owner === "merger") {
        assert.throws(
          () => parsePublicSeatArgv("merger", [spelling, "x", "task"]),
          isUsage,
        );
      }
      if (entry.owner === "analyst") {
        // --model-groups is covered by the real CLI case in
        // analyst-public-cli.test.ts; only --project-root remains here.
        if (spelling === "--model-groups") continue;
        assert.throws(
          () => parseAnalystArgv([spelling, "/tmp/p"]),
          isUsage,
        );
      }
    }
  }
});

test("analyst structured mode contracts drive parseAnalystArgv (pos/neg matrix)", () => {
  const byId = new Map(
    optionsForOwner("analyst").map((opt) => [opt.id, opt] as const),
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
  assert.deepEqual([...ANALYST_REQUIRE_ANY_OF], []);
  const rejected = allRejectedSpellingTokens();
  assert.ok(rejected.includes("--project-root"));
  assert.ok(rejected.includes("--model-groups"));

  type Expect =
    | { ok: true; query: string }
    | { ok: false };
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
      expect: { ok: false },
    },
    {
      name: "issue rejects ticket+project-root",
      rule: "rejected:project-root",
      argv: ["--ticket", "1", "--project-root", "/tmp/p"],
      expect: { ok: false },
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
      expect: { ok: false },
    },
    {
      name: "cohort×ticket",
      rule: "modes:ticket:issue-only",
      argv: [...COHORT_MIN, "--ticket", "1"],
      expect: { ok: false },
    },
    {
      name: "cohort×root",
      rule: "rejected:project-root",
      argv: [...COHORT_MIN, "--project-root", "/p"],
      expect: { ok: false },
    },
    {
      name: "cohort×attach",
      rule: "modes:attach:sweep-only",
      argv: [...COHORT_MIN, "--attach", "/tmp/s.json"],
      expect: { ok: false },
    },
    {
      // The bare --model-groups refusal is carried by the real CLI case in
      // analyst-public-cli.test.ts; the two combination rows below keep the
      // mode-combination contract that the bare row cannot express.
      name: "model-groups disabled + roots",
      rule: "rejected:model-groups-disabled",
      argv: ["--model-groups", "--project-root", "/a", "--project-root", "/b"],
      expect: { ok: false },
    },
    {
      // Cohort's four group-* options are required in cohort mode, so the row
      // carries them: otherwise the missing-requirement rejection would fire
      // even if --model-groups were wrongly admitted, masking this rule.
      name: "cohort×model-groups",
      rule: "rejected:model-groups-disabled",
      argv: [...COHORT_MIN, "--model-groups"],
      expect: { ok: false },
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
      expect: { ok: false },
    },
    {
      name: "sweep double attach",
      rule: "maxCountByMode:attach:sweep:1",
      argv: ["sweep", "--attach", "/a", "--attach", "/b"],
      expect: { ok: false },
    },
    {
      name: "sweep×ticket",
      rule: "modes:ticket:issue-only",
      argv: ["sweep", "--attach", "/tmp/s.json", "--ticket", "1"],
      expect: { ok: false },
    },
    {
      name: "sweep×root",
      rule: "rejected:project-root",
      argv: ["--attach", "/tmp/s.json", "--project-root", "/p"],
      expect: { ok: false },
    },
    {
      name: "group on issue",
      rule: "modes:group-a-label:cohort-only",
      argv: ["--group-a-label", "A", "--ticket", "1"],
      expect: { ok: false },
    },
  ];

  const covered = new Set<string>();
  for (const s of cases) {
    covered.add(s.rule);
    if (s.expect.ok) {
      assert.equal(parseAnalystArgv(s.argv).query, s.expect.query, s.name);
    } else {
      assert.throws(() => parseAnalystArgv(s.argv), isUsage, s.name);
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
      parse: (args) => parsePublicSeatArgv("judge", args),
      build: (f) => [...f, "task"],
    },
    {
      owner: "coder",
      parse: (args) => parsePublicSeatArgv("coder", args),
      build: (f) => [...f, "task"],
    },
    {
      owner: "fixer",
      parse: (args) => parsePublicSeatArgv("fixer", args),
      build: (f) => [...f, "task"],
    },
    {
      owner: "reviewer",
      parse: (args) => parsePublicSeatArgv("reviewer", args),
      build: (f) => [
        ...(f.some((t) => t === "--base" || t.startsWith("--base=")) ? [] : ["--base", "main"]),
        ...(f.some((t) => t === "--authority-ref" || t.startsWith("--authority-ref="))
          ? [] : ["--authority-ref", "CLAUDE.md"]),
        ...f, "task",
      ],
    },
    {
      owner: "collector",
      parse: (args) => parsePublicSeatArgv("collector", args),
      build: (f) => [
        ...(f.some((t) => t === "--pr" || t.startsWith("--pr=")) ? [] : ["--pr", "1"]),
        ...(f.some((t) => t === "--repo" || t.startsWith("--repo=")) ? [] : ["--repo", "acme/widgets"]),
        ...f,
      ],
    },
    {
      owner: "doctor",
      parse: (args) => parsePublicSeatArgv("doctor", args),
      build: (f) =>
        f.some((t) => t === "--issue" || t.startsWith("--issue="))
          ? [...f]
          : ["--issue", "1", ...f],
    },
    {
      owner: "merger",
      parse: (args) => parsePublicSeatArgv("merger", args),
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
          : [opt.canonical, opt.id === "lens" ? "completeness" : sampleValue(opt.valueMetavar, opt.id)];
      s.parse(s.build(flags));
      ok += 1;
    }
  }
  assert.ok(ok >= 10);

  const rejectedSpellings = new Set(allRejectedSpellingTokens());
  for (const opt of optionsForOwner("analyst")) {
    if (opt.form !== "option" || rejectedSpellings.has(opt.canonical)) continue;
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
    parseAnalystArgv(face);
  }

  // Shared project semantics (owner-binding only); merger/analyst/reviewer differ.
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
  const analystAttach = optionsForOwner("analyst").find((o) => o.id === "attach")!;
  assert.deepEqual(analystAttach.modes, ["sweep"]);
  assert.equal(analystAttach.selectsMode, "sweep");
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

