/**
 * #342 — typed option-definition true source drives help / README / parsers.
 * Acceptance: structured contracts drive the real parser; rejected spellings
 * stay private; README generated regions zero-diff; shortest real installed-bin
 * tracer checks public command/option identities only (no presentation freeze).
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
  runAkRole,
} from "../../src/public-cli/cli.ts";
import {
  PUBLIC_OPTION_TABLE,
  PUBLIC_ROLE_OPTION_OWNERS,
  PUBLIC_CLI_OPTIONS_README_MARKERS,
  REJECTED_PUBLIC_SPELLINGS,
  TAISHI_REQUIRE_ANY_OF,
  allRejectedSpellingTokens,
  applyReadmeOptionsSection,
  optionsForOwner,
  projectOwnerOptions,
  renderReadmeOptionsMarkdown,
  type OptionOwner,
  type PublicRoleOptionOwner,
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

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
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

test("real help surfaces public option identities from the sole table", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-opt-help-"));
  try {
    const bare = captureIo();
    const bareResult = await runAkRole(["--help"], {
      packageRoot,
      home,
      io: bare.io,
    });
    assert.equal(bareResult.exitCode, 0);
    const bareText = bare.stdout.join("");
    for (const opt of optionsForOwner("global")) {
      assert.equal(
        bareText.includes(opt.canonical),
        true,
        `bare help missing global identity ${opt.canonical}`,
      );
      for (const alias of opt.aliases) {
        assert.equal(
          bareText.includes(alias),
          true,
          `bare help missing global alias ${alias}`,
        );
      }
    }

    for (const owner of PUBLIC_ROLE_OPTION_OWNERS) {
      const cap = captureIo();
      const result = await runAkRole(["help", owner], {
        packageRoot,
        home,
        io: cap.io,
      });
      assert.equal(result.exitCode, 0, owner);
      const text = cap.stdout.join("");
      for (const opt of optionsForOwner(owner)) {
        assert.equal(
          text.includes(opt.canonical),
          true,
          `help ${owner} missing identity ${opt.canonical}`,
        );
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rejected spellings never appear in public help or README projections", async () => {
  const rejected = allRejectedSpellingTokens();
  assert.ok(rejected.includes("--burden"));
  assert.ok(rejected.includes("--ak-merger-input"));

  const home = await mkdtemp(join(tmpdir(), "ak-opt-reject-"));
  try {
    const surfaces: string[] = [];
    const bare = captureIo();
    await runAkRole(["--help"], { packageRoot, home, io: bare.io });
    surfaces.push(bare.stdout.join(""));

    for (const owner of PUBLIC_ROLE_OPTION_OWNERS) {
      const cap = captureIo();
      await runAkRole(["help", owner], { packageRoot, home, io: cap.io });
      surfaces.push(cap.stdout.join(""));
    }

    surfaces.push(renderReadmeOptionsMarkdown("en"));
    surfaces.push(renderReadmeOptionsMarkdown("zh"));

    for (const text of surfaces) {
      for (const spelling of rejected) {
        assert.equal(
          text.includes(spelling),
          false,
          `rejected spelling leaked: ${spelling}`,
        );
      }
    }

    for (const owner of Object.keys(PUBLIC_OPTION_TABLE) as OptionOwner[]) {
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
  } finally {
    await rm(home, { recursive: true, force: true });
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

test("installed package bin tracer: real executable surfaces command and option identities", async () => {
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

    const run = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync(process.execPath, [binPath, ...args], {
        cwd: packageRoot,
        env: { ...process.env, HOME: home },
        timeout: 30_000,
      });
      return stdout;
    };

    const bare = await run(["--help"]);
    for (const name of [
      "roles",
      "config",
      "help",
      "resume",
      ...PUBLIC_ROLE_OPTION_OWNERS,
    ]) {
      assert.equal(bare.includes(name), true, `bare help lists ${name}`);
    }
    for (const opt of optionsForOwner("global")) {
      assert.equal(
        bare.includes(opt.canonical),
        true,
        `bare help lists ${opt.canonical}`,
      );
      for (const alias of opt.aliases) {
        assert.equal(bare.includes(alias), true, `bare help lists ${alias}`);
      }
    }

    for (const owner of PUBLIC_ROLE_OPTION_OWNERS) {
      const text = await run(["help", owner]);
      for (const opt of optionsForOwner(owner)) {
        assert.equal(
          text.includes(opt.canonical),
          true,
          `help ${owner} must list ${opt.canonical}`,
        );
      }
    }
  } finally {
    await rm(binDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
