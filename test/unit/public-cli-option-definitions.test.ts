/**
 * #342 — typed option-definition true source drives help / README / parsers.
 * Acceptance (owner 2026-08-15 option 2): option identity + structured semantics
 * land on typed true source and structured projection seams
 * (helpDocumentForCommand / projectOwnerOptions); help screen free text is a
 * human surface, not a machine contract. README generated regions zero-diff;
 * real installed-bin entry is loud smoke only (non-empty, no content freeze).
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
  PUBLIC_ROLE_ARGV,
  helpDocument,
  helpDocumentForCommand,
} from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  PUBLIC_OPTION_TABLE,
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
  type TaishiMode,
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

/** Identity + structured-semantics fields of one projected option (no prose). */
function structuredOptionContract(opt: StructuredOptionProjection) {
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

test("PUBLIC_ROLE_ARGV rows expose the sole option table (no parallel spelling owner)", () => {
  for (const owner of PUBLIC_ROLE_OPTION_OWNERS) {
    const row = PUBLIC_ROLE_ARGV[owner];
    assert.equal(typeof row.parse, "function", owner);
    assert.ok(Array.isArray(row.options), `${owner} must reference options`);
    assert.deepEqual(
      row.options.map((o) => o.id),
      optionsForOwner(owner).map((o) => o.id),
      `${owner} PUBLIC_ROLE_ARGV.options must be the typed table row`,
    );
  }
  // One structured projection path — table and projectOwnerOptions stay aligned.
  for (const owner of Object.keys(PUBLIC_OPTION_TABLE) as OptionOwner[]) {
    assert.deepEqual(
      projectOwnerOptions(owner).map((o) => o.id),
      optionsForOwner(owner).map((o) => o.id),
    );
  }
  assert.ok(
    optionsForOwner("global").some(
      (o) => o.canonical === "--help" && o.aliases.includes("-h"),
    ),
  );
});

test("helpDocumentForCommand table-drive: option identity + structured semantics ≡ typed table", () => {
  const owners: OptionOwner[] = ["global", ...PUBLIC_ROLE_OPTION_OWNERS];

  // Bare help document carries the same global option projection.
  const bare = helpDocument();
  assert.equal(bare.executable, "ak-role");
  assert.deepEqual(
    bare.globalOptions.map(structuredOptionContract),
    projectOwnerOptions("global").map(structuredOptionContract),
  );

  for (const owner of owners) {
    const doc = helpDocumentForCommand(owner);
    assert.ok(doc, `helpDocumentForCommand(${owner}) must resolve`);
    assert.equal(doc.command, owner);
    if (owner === "global") {
      assert.equal(doc.kind, "global");
    } else if (owner === "taishi") {
      assert.equal(doc.kind, "deterministic");
    } else {
      assert.equal(doc.kind, "role");
    }

    const fromTable = projectOwnerOptions(owner);
    assert.deepEqual(
      doc.options.map(structuredOptionContract),
      fromTable.map(structuredOptionContract),
      `${owner}: helpDocumentForCommand options must equal projectOwnerOptions`,
    );
    // projectOwnerOptions is the sole projection of optionsForOwner (identity fields).
    assert.deepEqual(
      fromTable.map(structuredOptionContract),
      optionsForOwner(owner).map((def) =>
        structuredOptionContract({
          id: def.id,
          owner: def.owner,
          canonical: def.canonical,
          aliases: def.aliases,
          valueMetavar: def.valueMetavar,
          required: def.required,
          repeatable: def.repeatable,
          ...(def.defaultValue === undefined
            ? {}
            : { defaultValue: def.defaultValue }),
          form: def.form,
          ...(def.phases === undefined ? {} : { phases: def.phases }),
          ...(def.modes === undefined ? {} : { modes: def.modes }),
          ...(def.requiredInModes === undefined
            ? {}
            : { requiredInModes: def.requiredInModes }),
          ...(def.exclusiveWith === undefined
            ? {}
            : { exclusiveWith: def.exclusiveWith }),
          ...(def.maxCountByMode === undefined
            ? {}
            : { maxCountByMode: def.maxCountByMode }),
          ...(def.selectsMode === undefined
            ? {}
            : { selectsMode: def.selectsMode }),
          description: def.description,
        }),
      ),
      `${owner}: projectOwnerOptions must mirror typed table identity/semantics`,
    );
    assert.ok(fromTable.length > 0, `${owner} must expose at least one option`);
    for (const opt of fromTable) {
      assert.equal(typeof opt.canonical, "string");
      assert.ok(opt.canonical.length > 0, `${owner}/${opt.id} canonical empty`);
      assert.ok(Array.isArray(opt.aliases));
    }
  }

  assert.equal(helpDocumentForCommand("navigator"), undefined);
  assert.equal(helpDocumentForCommand("not-a-command"), undefined);
});

test("shared typed consumer: phase from table aliases/default; repeatable:false rejects duplicates", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  // ① Phase resolution consumes the typed phase row — not a hardcoded plan/apply branch.
  // Synthetic defaultValue "plan" proves the consumer reads the table (production default is apply).
  const syntheticPhase: PublicOptionDefinition = {
    id: "phase",
    owner: "coder",
    canonical: "plan|apply",
    aliases: ["plan", "apply"],
    valueMetavar: null,
    required: false,
    repeatable: false,
    defaultValue: "plan",
    form: "positional",
    description: { en: "synthetic", zh: "合成" },
  };
  const synthetic = createTypedOptionConsumer([syntheticPhase]);
  const leading = ["apply", "do work"];
  assert.equal(synthetic.consumeLeadingPhase(leading), "apply");
  assert.deepEqual(leading, ["do work"]);
  assert.equal(synthetic.consumeLeadingPhase(["unrelated"]), "plan");
  assert.equal(synthetic.consumeLeadingPhase([]), "plan");

  // Production coder/fixer still resolve plan|apply via their table rows.
  assert.equal(parseCoderArgv(["task"]).phase, "apply");
  assert.equal(parseCoderArgv(["plan", "task"]).phase, "plan");
  assert.equal(parseCoderArgv(["apply", "task"]).phase, "apply");
  assert.equal(parseFixerArgv(["plan", "fix it"]).phase, "plan");
  assert.equal(parseFixerArgv(["just fix"]).phase, "apply");

  // ③ Non-repeatable dashed options reject a second occurrence on the shared path.
  const nonRepeatableOwners: Array<{
    name: string;
    parse: (args: readonly string[]) => unknown;
    dup: string[];
    canonical: string;
  }> = [
    {
      name: "judge/--project",
      parse: parseJudgeArgv,
      dup: ["--project", "/a", "--project", "/b", "task"],
      canonical: "--project",
    },
    {
      name: "coder/--project",
      parse: parseCoderArgv,
      dup: ["--project", "/a", "--project", "/b", "task"],
      canonical: "--project",
    },
    {
      name: "fixer/--project",
      parse: parseFixerArgv,
      dup: ["--project", "/a", "--project", "/b", "task"],
      canonical: "--project",
    },
    {
      name: "reviewer/--base",
      parse: parseReviewerArgv,
      dup: ["--base", "main", "--base", "dev", "task"],
      canonical: "--base",
    },
    {
      name: "doctor/--issue",
      parse: parseDoctorArgv,
      dup: ["--issue", "1", "--issue", "2"],
      canonical: "--issue",
    },
    {
      name: "collector/--pr",
      parse: parseCollectorArgv,
      dup: ["--pr", "1", "--pr", "2", "--repo", "acme/x"],
      canonical: "--pr",
    },
    {
      name: "merger/--project",
      parse: parseMergerArgv,
      dup: ["--project", "/a", "--project", "/b", "task"],
      canonical: "--project",
    },
    {
      name: "taishi/--ticket",
      parse: parseTaishiArgv,
      dup: ["--ticket", "1", "--ticket", "2"],
      canonical: "--ticket",
    },
  ];
  for (const row of nonRepeatableOwners) {
    assert.throws(
      () => row.parse(row.dup),
      (error: unknown) =>
        isUsage(error)
        && error instanceof Error
        && error.message.includes(`${row.canonical} cannot be repeated`),
      row.name,
    );
  }

  // Repeatable options still accept multiple occurrences.
  const coderMulti = parseCoderArgv([
    "--attach",
    "/a",
    "--attach",
    "/b",
    "task",
  ]);
  assert.deepEqual(coderMulti.attachmentPaths, ["/a", "/b"]);
  const reviewerMulti = parseReviewerArgv([
    "--base",
    "main",
    "--authority-ref",
    "https://example.test/a",
    "--authority-ref",
    "https://example.test/b",
    "task",
  ]);
  assert.deepEqual(reviewerMulti.authorityRefs, [
    "https://example.test/a",
    "https://example.test/b",
  ]);
  const modelGroups = parseTaishiArgv([
    "--model-groups",
    "--project-root",
    "/a",
    "--project-root",
    "/b",
  ]);
  assert.equal(modelGroups.query, "model-groups");
  if (modelGroups.query === "model-groups") {
    assert.deepEqual(modelGroups.projectRoots, ["/a", "/b"]);
  }

  // Positional non-repeatable (taishi sweep) also goes through the shared path.
  assert.throws(
    () => parseTaishiArgv(["sweep", "sweep", "--attach", "/x"]),
    (error: unknown) =>
      isUsage(error)
      && error instanceof Error
      && error.message.includes("sweep cannot be repeated"),
  );
});

test("rejected spellings never appear in structured projections or README", () => {
  const rejected = allRejectedSpellingTokens();
  assert.ok(rejected.includes("--burden"));
  assert.ok(rejected.includes("--ak-merger-input"));

  // Public documentation surfaces that are machine-checkable: typed table,
  // helpDocumentForCommand projection, and README generators — not help free text.
  const owners: OptionOwner[] = ["global", ...PUBLIC_ROLE_OPTION_OWNERS];
  for (const owner of owners) {
    const doc = helpDocumentForCommand(owner);
    assert.ok(doc, owner);
    for (const opt of doc.options) {
      for (const spelling of [opt.canonical, ...opt.aliases]) {
        assert.equal(
          rejected.includes(spelling),
          false,
          `helpDocumentForCommand(${owner}) leaked rejected ${spelling}`,
        );
      }
    }
    for (const opt of optionsForOwner(owner)) {
      for (const spelling of [opt.canonical, ...opt.aliases]) {
        assert.equal(
          rejected.includes(spelling),
          false,
          `public table must not contain rejected ${spelling}`,
        );
      }
    }
  }

  for (const spelling of rejected) {
    assert.equal(
      renderReadmeOptionsMarkdown("en").includes(spelling),
      false,
      `README EN leaked rejected ${spelling}`,
    );
    assert.equal(
      renderReadmeOptionsMarkdown("zh").includes(spelling),
      false,
      `README ZH leaked rejected ${spelling}`,
    );
  }
});

test("taishi structured mode contracts drive parseTaishiArgv (pos/neg matrix)", () => {
  // —— Table inventory the matrix is bound to ——
  const taishi = optionsForOwner("taishi");
  const byId = new Map(taishi.map((opt) => [opt.id, opt] as const));
  assert.ok(byId.get("ticket")?.modes?.includes("issue"));
  assert.ok(byId.get("project-root")?.modes?.includes("issue"));
  assert.deepEqual(byId.get("project-root")?.maxCountByMode, { issue: 1 });
  assert.deepEqual(byId.get("project-root")?.requiredInModes, ["model-groups"]);
  assert.deepEqual(byId.get("cohort")?.exclusiveWith, ["model-groups"]);
  assert.deepEqual(byId.get("model-groups")?.exclusiveWith, ["cohort"]);
  assert.equal(byId.get("cohort")?.selectsMode, "cohort");
  assert.equal(byId.get("model-groups")?.selectsMode, "model-groups");
  assert.equal(byId.get("sweep")?.selectsMode, "sweep");
  assert.equal(byId.get("attach")?.selectsMode, "sweep");
  for (const id of [
    "group-a-label",
    "group-a-issues",
    "group-b-label",
    "group-b-issues",
  ] as const) {
    assert.deepEqual(byId.get(id)?.requiredInModes, ["cohort"]);
    assert.deepEqual(byId.get(id)?.modes, ["cohort"]);
  }
  assert.deepEqual(
    [...TAISHI_REQUIRE_ANY_OF],
    [{ mode: "issue", optionIds: ["ticket", "project-root"] }],
  );

  type Expect =
    | { ok: true; query: string }
    | { ok: false; messageIncludes: RegExp };

  const cases: Array<{
    name: string;
    /** Structured rule under proof. */
    rule: string;
    argv: string[];
    expect: Expect;
  }> = [
    // issue requireAnyOf ticket|project-root
    {
      name: "issue+ticket",
      rule: "requireAnyOf:issue:ticket|project-root",
      argv: ["--ticket", "1"],
      expect: { ok: true, query: "issue" },
    },
    {
      name: "issue+project-root",
      rule: "requireAnyOf:issue:ticket|project-root",
      argv: ["--project-root", "/tmp/p"],
      expect: { ok: true, query: "issue" },
    },
    {
      name: "issue+both",
      rule: "requireAnyOf:issue:ticket|project-root",
      argv: ["--ticket", "1", "--project-root", "/tmp/p"],
      expect: { ok: true, query: "issue" },
    },
    {
      name: "issue bare missing both",
      rule: "requireAnyOf:issue:ticket|project-root",
      argv: [],
      expect: { ok: false, messageIncludes: /ticket|project-root/i },
    },
    // issue maxCountByMode project-root ≤ 1
    {
      name: "issue two project-roots",
      rule: "maxCountByMode:project-root:issue:1",
      argv: ["--project-root", "/a", "--project-root", "/b"],
      expect: { ok: false, messageIncludes: /project-root/i },
    },
    // cohort requiredInModes + selectsMode
    {
      name: "cohort complete",
      rule: "requiredInModes:cohort:group-*",
      argv: [...COHORT_MIN],
      expect: { ok: true, query: "cohort" },
    },
    {
      name: "cohort missing groups",
      rule: "requiredInModes:cohort:group-*",
      argv: ["--cohort"],
      expect: { ok: false, messageIncludes: /group-a-label|usage:.*cohort/i },
    },
    // modes admission: ticket not in cohort
    {
      name: "cohort rejects ticket",
      rule: "modes:ticket:issue-only",
      argv: [...COHORT_MIN, "--ticket", "1"],
      expect: { ok: false, messageIncludes: /ticket/i },
    },
    // modes admission: project-root not in cohort
    {
      name: "cohort rejects project-root",
      rule: "modes:project-root:issue|model-groups",
      argv: [...COHORT_MIN, "--project-root", "/p"],
      expect: { ok: false, messageIncludes: /project-root/i },
    },
    // modes admission: attach not in cohort
    {
      name: "cohort rejects attach",
      rule: "modes:attach:sweep-only",
      argv: [...COHORT_MIN, "--attach", "/tmp/s.json"],
      expect: { ok: false, messageIncludes: /attach/i },
    },
    // exclusiveWith cohort × model-groups
    {
      name: "cohort xor model-groups",
      rule: "exclusiveWith:cohort×model-groups",
      argv: ["--cohort", "--model-groups", "--project-root", "/p"],
      expect: {
        ok: false,
        messageIncludes: /cohort|model-groups/i,
      },
    },
    // model-groups required project-root + multi root ok
    {
      name: "model-groups missing root",
      rule: "requiredInModes:model-groups:project-root",
      argv: ["--model-groups"],
      expect: { ok: false, messageIncludes: /project-root|model-groups/i },
    },
    {
      name: "model-groups multi root",
      rule: "requiredInModes:model-groups:project-root",
      argv: [
        "--model-groups",
        "--project-root",
        "/a",
        "--project-root",
        "/b",
      ],
      expect: { ok: true, query: "model-groups" },
    },
    {
      name: "model-groups rejects ticket",
      rule: "modes:ticket:issue-only",
      argv: ["--model-groups", "--project-root", "/a", "--ticket", "1"],
      expect: { ok: false, messageIncludes: /ticket/i },
    },
    {
      name: "model-groups rejects cohort group flag",
      rule: "modes:group-a-label:cohort-only",
      argv: [
        "--model-groups",
        "--project-root",
        "/a",
        "--group-a-label",
        "A",
      ],
      expect: { ok: false, messageIncludes: /group-a-label/i },
    },
    // sweep selectsMode + modes admission
    {
      name: "sweep via attach",
      rule: "selectsMode:attach→sweep",
      argv: ["--attach", "/tmp/s.json"],
      expect: { ok: true, query: "sweep" },
    },
    {
      name: "sweep via token",
      rule: "selectsMode:sweep→sweep",
      argv: ["sweep"],
      expect: { ok: true, query: "sweep" },
    },
    {
      name: "sweep rejects ticket",
      rule: "modes:ticket:issue-only",
      argv: ["sweep", "--attach", "/tmp/s.json", "--ticket", "1"],
      expect: { ok: false, messageIncludes: /ticket/i },
    },
    {
      name: "sweep rejects project-root",
      rule: "modes:project-root:issue|model-groups",
      argv: ["--attach", "/tmp/s.json", "--project-root", "/p"],
      expect: { ok: false, messageIncludes: /project-root/i },
    },
    // group flags without cohort selector land in issue and fail modes admission
    {
      name: "group flag alone rejected on issue",
      rule: "modes:group-a-label:cohort-only",
      argv: ["--group-a-label", "A", "--ticket", "1"],
      expect: { ok: false, messageIncludes: /group-a-label/i },
    },
  ];

  const coveredRules = new Set<string>();
  for (const scenario of cases) {
    coveredRules.add(scenario.rule);
    const expected = scenario.expect;
    if (expected.ok) {
      const parsed = parseTaishiArgv(scenario.argv);
      assert.equal(
        parsed.query,
        expected.query,
        `${scenario.name}: query`,
      );
    } else {
      assert.throws(
        () => parseTaishiArgv(scenario.argv),
        (error: unknown) => {
          assert.ok(error instanceof Error, scenario.name);
          assert.match(
            error.message,
            expected.messageIncludes,
            `${scenario.name}: ${error.message}`,
          );
          return true;
        },
        scenario.name,
      );
    }
  }

  // Every structured constraint class named above must appear in the matrix.
  for (const required of [
    "requireAnyOf:issue:ticket|project-root",
    "maxCountByMode:project-root:issue:1",
    "requiredInModes:cohort:group-*",
    "requiredInModes:model-groups:project-root",
    "exclusiveWith:cohort×model-groups",
    "modes:ticket:issue-only",
    "modes:project-root:issue|model-groups",
    "modes:attach:sweep-only",
    "modes:group-a-label:cohort-only",
    "selectsMode:attach→sweep",
    "selectsMode:sweep→sweep",
  ] as const) {
    assert.equal(
      coveredRules.has(required),
      true,
      `matrix missing structured rule ${required}`,
    );
  }

  // Silence unused TaishiMode import guard for future mode literals.
  const _modes: TaishiMode[] = ["issue", "sweep", "cohort", "model-groups"];
  assert.equal(_modes.length, 4);
});

test("bidirectional parser rescan: public dashed options admitted; rejected spellings refused", () => {
  type Case = {
    owner: PublicRoleOptionOwner;
    parse: (args: readonly string[]) => unknown;
    build: (flagArgs: string[]) => string[];
  };

  const cases: Case[] = [
    {
      owner: "judge",
      parse: parseJudgeArgv,
      build: (flagArgs) => [...flagArgs, "task"],
    },
    {
      owner: "coder",
      parse: parseCoderArgv,
      build: (flagArgs) => [...flagArgs, "task"],
    },
    {
      owner: "fixer",
      parse: parseFixerArgv,
      build: (flagArgs) => [...flagArgs, "task"],
    },
    {
      owner: "reviewer",
      parse: parseReviewerArgv,
      build: (flagArgs) => {
        const hasBase = flagArgs.some(
          (t) => t === "--base" || t.startsWith("--base="),
        );
        return hasBase
          ? [...flagArgs, "task"]
          : ["--base", "main", ...flagArgs, "task"];
      },
    },
    {
      owner: "collector",
      parse: parseCollectorArgv,
      build: (flagArgs) => {
        const hasPr = flagArgs.some(
          (t) => t === "--pr" || t.startsWith("--pr="),
        );
        return hasPr
          ? [...flagArgs, "--repo", "acme/widgets"]
          : ["--pr", "1", "--repo", "acme/widgets", ...flagArgs];
      },
    },
    {
      owner: "doctor",
      parse: parseDoctorArgv,
      build: (flagArgs) => {
        const hasIssue = flagArgs.some(
          (t) => t === "--issue" || t.startsWith("--issue="),
        );
        return hasIssue ? [...flagArgs] : ["--issue", "1", ...flagArgs];
      },
    },
    {
      owner: "merger",
      parse: parseMergerArgv,
      build: (flagArgs) => [...flagArgs, "task"],
    },
  ];

  let forwardOk = 0;
  for (const scenario of cases) {
    for (const opt of optionsForOwner(scenario.owner)) {
      if (opt.form !== "option") continue;
      const valueArgs =
        opt.valueMetavar === null
          ? [opt.canonical]
          : [opt.canonical, sampleValue(opt.valueMetavar, opt.id)];
      try {
        scenario.parse(scenario.build(valueArgs));
        forwardOk += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(
          /unknown \w+ option/.test(message),
          false,
          `public option ${scenario.owner} ${opt.canonical} treated as unknown: ${message}`,
        );
        forwardOk += 1;
      }
    }
  }
  assert.ok(forwardOk >= 10, "forward scan must admit public options");

  // taishi dashed identities covered by the structured matrix; still prove
  // each dashed spelling is not "unknown" under a valid face.
  for (const opt of optionsForOwner("taishi")) {
    if (opt.form !== "option") continue;
    const face =
      opt.modes?.[0] === "cohort"
        ? [...COHORT_MIN]
        : opt.modes?.[0] === "model-groups"
          ? opt.id === "project-root"
            ? ["--model-groups", "--project-root", "/tmp/p"]
            : ["--model-groups", "--project-root", "/tmp/p", opt.canonical]
          : opt.modes?.[0] === "sweep"
            ? opt.id === "attach"
              ? ["--attach", "/tmp/s.json"]
              : ["sweep", opt.canonical, sampleValue(opt.valueMetavar ?? "path", opt.id)]
            : opt.id === "ticket"
              ? ["--ticket", "1"]
              : opt.id === "project-root"
                ? ["--project-root", "/tmp/p"]
                : ["--ticket", "1", opt.canonical, sampleValue(opt.valueMetavar ?? "path", opt.id)];
    try {
      parseTaishiArgv(face);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(
        /unknown taishi option/.test(message),
        false,
        `taishi ${opt.canonical} treated as unknown: ${message}`,
      );
    }
  }

  for (const entry of REJECTED_PUBLIC_SPELLINGS) {
    for (const spelling of entry.spellings) {
      if (entry.owner === "judge") {
        assert.throws(
          () => parseJudgeArgv([spelling, "x", "task"]),
          (error: unknown) =>
            error instanceof Error
            && error.message.includes("burden")
            && !error.message.includes("unknown judge option"),
        );
      }
      if (entry.owner === "merger") {
        assert.throws(
          () => parseMergerArgv([spelling, "x", "task"]),
          (error: unknown) =>
            error instanceof Error
            && (error.message.includes("ak-merger-input")
              || error.message.includes("internal")
              || error.message.includes("packet")
              || error.message.includes("merger")),
        );
      }
    }
  }
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

test("README EN/ZH generated regions are regeneration-clean", async () => {
  const enPath = resolve(packageRoot, "README.md");
  const zhPath = resolve(packageRoot, "README.zh-CN.md");
  const en = await readFile(enPath, "utf8");
  const zh = await readFile(zhPath, "utf8");

  assert.equal(
    en.includes(PUBLIC_CLI_OPTIONS_README_MARKERS.begin),
    true,
    "README.md must contain generated options region markers",
  );
  assert.equal(
    zh.includes(PUBLIC_CLI_OPTIONS_README_MARKERS.begin),
    true,
    "README.zh-CN.md must contain generated options region markers",
  );

  const enNext = applyReadmeOptionsSection(en, "en");
  const zhNext = applyReadmeOptionsSection(zh, "zh");
  assert.equal(
    enNext,
    en,
    "README.md generated region drifted — run: node --import tsx scripts/render-public-cli-options-readme.ts",
  );
  assert.equal(
    zhNext,
    zh,
    "README.zh-CN.md generated region drifted — run: node --import tsx scripts/render-public-cli-options-readme.ts",
  );

  for (const spelling of allRejectedSpellingTokens()) {
    assert.equal(renderReadmeOptionsMarkdown("en").includes(spelling), false);
    assert.equal(renderReadmeOptionsMarkdown("zh").includes(spelling), false);
  }
});

test("installed package bin tracer: bare --help and help <role> smoke (non-empty)", async () => {
  const { buildPublicAkRoleBin } = (await import(
    pathToFileURL(resolve(packageRoot, "scripts/build-package.mjs")).href
  )) as { buildPublicAkRoleBin: (outfile?: string) => Promise<void> };

  // Pin under /tmp (not os.tmpdir()): same host-pi packageRoot footgun as
  // taishi-entry / main.ts resolvePackageRoot — keep the CI shape locally.
  const binDir = await mkdtemp(join("/tmp", "ak-opt-bin-"));
  const binPath = join(binDir, "main.js");
  const home = await mkdtemp(join(tmpdir(), "ak-opt-bin-home-"));
  try {
    const previousCwd = process.cwd();
    process.chdir(packageRoot);
    try {
      await buildPublicAkRoleBin(binPath);
    } finally {
      process.chdir(previousCwd);
    }
    await chmod(binPath, 0o755);

    // Loud smoke only: build/exec failures must throw (no catch→runAkRole).
    // Help free text is a human surface — do not assert option/command content.
    const run = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync(process.execPath, [binPath, ...args], {
        cwd: packageRoot,
        env: { ...process.env, HOME: home },
        timeout: 30_000,
      });
      return stdout;
    };

    const bare = await run(["--help"]);
    assert.ok(bare.trim().length > 0, "bare --help must produce non-empty stdout");

    for (const owner of PUBLIC_ROLE_OPTION_OWNERS) {
      const text = await run(["help", owner]);
      assert.ok(
        text.trim().length > 0,
        `help ${owner} must produce non-empty stdout`,
      );
    }
  } finally {
    await rm(binDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
