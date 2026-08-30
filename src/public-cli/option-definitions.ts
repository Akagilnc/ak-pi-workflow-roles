/**
 * #342 — sole typed public CLI option-definition source.
 *
 * PUBLIC_ROLE_ARGV rows reference these definitions. Production parsers and
 * `help <command>` consume this table. Do not maintain a parallel spelling set
 * in parsers, help, or docs.
 *
 * Dashed-option take, positional selector match, role-phase resolution,
 * `repeatable` enforcement, and unconditional `required` checks share one
 * consumer (`createTypedOptionConsumer`). Parsers must not restate phase
 * tokens or add parallel repeatability / requiredness branches.
 */

import { CliUsageError } from "./cli-errors.ts";

/** Analyst public query faces (#336/#337/#338/#399). model-groups CLI face disabled (library kernel retained). */
export type AnalystMode = "issue" | "sweep" | "cohort";

/** Coder/Fixer public phase tokens. */
export type RolePhase = "plan" | "apply";

export type OptionOwner =
  | "global"
  | "judge"
  | "countersign"
  | "coder"
  | "fixer"
  | "reviewer"
  | "collector"
  | "doctor"
  | "merger"
  | "notary"
  | "analyst";

/**
 * One public option (or positional mode/phase token) identity.
 * Structured fields are the contract; EN/ZH strings are presentation only.
 */
export type PublicOptionDefinition = {
  /** Stable id unique within owner (not a spelling). */
  readonly id: string;
  readonly owner: OptionOwner;
  /** Canonical public spelling, e.g. `--attach` or positional `sweep`. */
  readonly canonical: string;
  /** Legal alternate spellings (e.g. `-h` for `--help`). */
  readonly aliases: readonly string[];
  /**
   * Value placeholder for help/README; `null` means flag takes no value
   * (boolean switch or bare positional token).
   */
  readonly valueMetavar: string | null;
  /** Unconditionally required at admission when no mode/phase qualifier applies. */
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly defaultValue?: string;
  /**
   * `option` — dashed flag; `positional` — bare token (phase/mode selector).
   */
  readonly form: "option" | "positional";
  /** When set, only these coder/fixer phases admit the option. */
  readonly phases?: readonly RolePhase[];
  /** When set, only these analyst modes admit the option. */
  readonly modes?: readonly AnalystMode[];
  /** Modes in which this option is required (analyst conditional requiredness). */
  readonly requiredInModes?: readonly AnalystMode[];
  /**
   * Other option ids on the same owner that cannot co-occur.
   */
  readonly exclusiveWith?: readonly string[];
  /** Per-mode maximum occurrences. */
  readonly maxCountByMode?: Readonly<Partial<Record<AnalystMode, number>>>;
  /**
   * When this option (or positional) is present it activates this mode.
   * Mode resolution consumes only this field — parsers must not restate selectors.
   */
  readonly selectsMode?: AnalystMode;
  readonly description: { readonly en: string; readonly zh: string };
};

/**
 * Cross-field at-least-one rules for analyst modes (cannot hang on one option row).
 * Parser-consumed sole source together with per-option modes/required/exclusive/max (#342).
 */
export type AnalystRequireAnyOfRule = {
  readonly mode: AnalystMode;
  readonly optionIds: readonly string[];
};

/**
 * Cross-field at-least-one rules for analyst modes.
 * #399: issue bare call is lawful (whole book from cwd) — no require-any-of on issue.
 */
export const ANALYST_REQUIRE_ANY_OF: readonly AnalystRequireAnyOfRule[] = [];

/** Residual analyst mode when no `selectsMode` option is present. */
export const ANALYST_DEFAULT_MODE: AnalystMode = "issue";

/**
 * Resolve analyst mode from collected option ids via `selectsMode` on the table.
 * Deterministic preference when multiple selectors co-occur; exclusiveWith then rejects.
 */
export function resolveAnalystMode(
  presentOptionIds: ReadonlySet<string>,
): AnalystMode {
  const selected = new Set<AnalystMode>();
  for (const def of optionsForOwner("analyst")) {
    if (def.selectsMode === undefined) continue;
    if (presentOptionIds.has(def.id)) selected.add(def.selectsMode);
  }
  if (selected.size === 0) return ANALYST_DEFAULT_MODE;
  if (selected.has("cohort")) return "cohort";
  if (selected.has("sweep")) return "sweep";
  if (selected.has("issue")) return "issue";
  return ANALYST_DEFAULT_MODE;
}

export type AnalystOptionCounts = ReadonlyMap<string, number>;

/**
 * Evaluate analyst cross-field / cross-mode structured contracts from the sole typed table.
 * Covers: modes admission, requiredInModes, exclusiveWith, maxCountByMode, ANALYST_REQUIRE_ANY_OF.
 */
export function evaluateAnalystModeOptionContract(
  mode: AnalystMode,
  counts: AnalystOptionCounts,
): { ok: true } | { ok: false; message: string } {
  const definitions = optionsForOwner("analyst");
  const byId = new Map(definitions.map((def) => [def.id, def] as const));

  for (const def of definitions) {
    const count = counts.get(def.id) ?? 0;
    if (count === 0 || def.exclusiveWith === undefined) continue;
    for (const otherId of def.exclusiveWith) {
      if ((counts.get(otherId) ?? 0) === 0) continue;
      const other = byId.get(otherId);
      return {
        ok: false,
        message: `analyst accepts only one of ${def.canonical} / ${other?.canonical ?? otherId}`,
      };
    }
  }

  for (const def of definitions) {
    const count = counts.get(def.id) ?? 0;
    if (count === 0) continue;
    if (def.modes !== undefined && !def.modes.includes(mode)) {
      // Sweep face historically names the attach carrier on mix-face rejects.
      if (mode === "sweep") {
        return {
          ok: false,
          message: `analyst sweep --attach cannot combine with ${def.canonical}`,
        };
      }
      return {
        ok: false,
        message: `analyst ${mode} does not accept ${def.canonical}`,
      };
    }
    const max = def.maxCountByMode?.[mode];
    if (max !== undefined && count > max) {
      return {
        ok: false,
        message:
          max === 1
            ? `analyst ${mode} accepts at most one ${def.canonical}`
            : `analyst ${mode} accepts at most ${max} ${def.canonical}`,
      };
    }
  }

  const missingRequired: PublicOptionDefinition[] = [];
  for (const def of definitions) {
    if (def.requiredInModes === undefined) continue;
    if (!def.requiredInModes.includes(mode)) continue;
    if ((counts.get(def.id) ?? 0) === 0) missingRequired.push(def);
  }
  if (missingRequired.length > 0) {
    if (mode === "cohort") {
      return {
        ok: false,
        message:
          "usage: ak-role analyst --cohort --group-a-label <L> --group-a-issues <N|book:N[,...]> --group-b-label <L> --group-b-issues <N|book:N[,...]>",
      };
    }
    return {
      ok: false,
      message: `usage: ak-role analyst ${mode} requires ${missingRequired
        .map((def) => def.canonical)
        .join(" ")}`,
    };
  }

  for (const rule of ANALYST_REQUIRE_ANY_OF) {
    if (rule.mode !== mode) continue;
    const hit = rule.optionIds.some((id) => (counts.get(id) ?? 0) > 0);
    if (hit) continue;
    if (mode === "issue") {
      // Bare-usage surface names issue faces and the sweep attach carrier.
      return {
        ok: false,
        message:
          "usage: ak-role analyst ([--ticket <N>] | [sweep] --attach <sweep.json> | --cohort ...)",
      };
    }
    const flags = rule.optionIds
      .map((id) => byId.get(id)?.canonical ?? id)
      .join(" | ");
    return {
      ok: false,
      message: `usage: ak-role analyst ${mode} requires one of ${flags}`,
    };
  }

  return { ok: true };
}

/**
 * Rejected / internal spellings retained by parsers for explicit refusal.
 * Must never appear in public help.
 */
export type RejectedSpelling = {
  readonly owner: OptionOwner;
  readonly spellings: readonly string[];
  readonly reason: { readonly en: string; readonly zh: string };
};

export const REJECTED_PUBLIC_SPELLINGS = [
  {
    owner: "judge",
    spellings: ["--burden", "--ak-judge-burden", "--judge-burden"],
    reason: {
      en: "Judge infers its own burden; no public burden selector.",
      zh: "大理寺自行推断举证责任，不接受公开 burden 旗标。",
    },
  },
  {
    owner: "merger",
    spellings: ["--ak-merger-input"],
    reason: {
      en: "Merger input packet is assembled internally; not a public flag.",
      zh: "校书郎 input packet 由内部装配，不是公开旗标。",
    },
  },
  {
    owner: "analyst",
    spellings: ["--project-root"],
    reason: {
      en: "Deleted (#399). analyst no longer accepts --project-root; use bare call for whole book or --ticket N (cwd git common-dir selects the book).",
      zh: "已删除（#399）。analyst 不再接受 --project-root；裸调用=整簿，或 --ticket N（cwd git common-dir 定簿）。",
    },
  },
  {
    owner: "analyst",
    spellings: ["--model-groups"],
    reason: {
      en: "Public CLI face disabled (#399). Input face is being redesigned for multi-issue comparison (see follow-up ticket). Library kernel retained.",
      zh: "公开 CLI 面已停用（#399）。输入面按多 issue 重设计中（见后续票）。聚合内核保留。",
    },
  },
] as const satisfies readonly RejectedSpelling[];

const GLOBAL_OPTIONS = [
  {
    id: "model",
    owner: "global",
    canonical: "--model",
    aliases: [],
    valueMetavar: "provider/model",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Override the effective seat model for this invocation (before or after the command).",
      zh: "覆盖本调用有效席位模型（可置于子命令前或后）。",
    },
  },
  {
    id: "thinking",
    owner: "global",
    canonical: "--thinking",
    aliases: [],
    valueMetavar: "level",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Override thinking level: off|minimal|low|medium|high|xhigh|max.",
      zh: "覆盖 thinking 档位：off|minimal|low|medium|high|xhigh|max。",
    },
  },
  {
    id: "engine",
    owner: "global",
    canonical: "--engine",
    aliases: [],
    valueMetavar: "name",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Optional labor engine for this invocation (owner pool-directive name; packaged notes attached when present; any role).",
      zh: "本调用可选劳动引擎（池令名字；有包内调法笔记则附卷；全部角色可用）。",
    },
  },
  {
    id: "host",
    owner: "global",
    canonical: "--host",
    aliases: [],
    valueMetavar: "name",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Select the named main-session host adapter for this invocation.",
      zh: "为本调用选择具名主会话宿主适配器。",
    },
  },
  {
    id: "help",
    owner: "global",
    canonical: "--help",
    aliases: ["-h"],
    valueMetavar: null,
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Show public CLI help and exit.",
      zh: "显示公开 CLI 帮助并退出。",
    },
  },
] as const satisfies readonly PublicOptionDefinition[];

/**
 * Immutable shared semantics for the common ledger `--project` face.
 * Role rows bind owner only — do not copy these fields per role.
 * Role-specific project faces (merger merge-root) stay explicit below and
 * must not use this binding. analyst `--project-root` is deleted (#399).
 */
const SHARED_PROJECT_SEMANTICS = {
  id: "project",
  canonical: "--project",
  aliases: [] as const,
  valueMetavar: "path",
  required: false,
  repeatable: false,
  form: "option" as const,
  description: {
    en: "Project root for ledger identity (defaults to process cwd).",
    zh: "卷宗身份用的项目根（默认进程 cwd）。",
  },
} as const satisfies Omit<PublicOptionDefinition, "owner">;

/**
 * Immutable shared semantics for the common frozen-file `--attach` face.
 * Role rows bind owner only. Reviewer has no attach face; analyst sweep attach
 * keeps its own modes/selectsMode/description and must not use this binding.
 */
const SHARED_ATTACH_SEMANTICS = {
  id: "attach",
  canonical: "--attach",
  aliases: [] as const,
  valueMetavar: "path",
  required: false,
  repeatable: true,
  form: "option" as const,
  description: {
    en: "Attach a regular file; frozen at admission (repeatable).",
    zh: "附加普通文件；受理即冻结（可重复）。",
  },
} as const satisfies Omit<PublicOptionDefinition, "owner">;

/** Minimal owner-binding: one immutable semantic row → one role table entry. */
function bindOwner(
  owner: OptionOwner,
  semantics: Omit<PublicOptionDefinition, "owner">,
): PublicOptionDefinition {
  return { ...semantics, owner };
}

const JUDGE_OPTIONS = [
  bindOwner("judge", SHARED_PROJECT_SEMANTICS),
  bindOwner("judge", SHARED_ATTACH_SEMANTICS),
] as const satisfies readonly PublicOptionDefinition[];

const COUNTERSIGN_OPTIONS = [
  bindOwner("countersign", SHARED_PROJECT_SEMANTICS),
  bindOwner("countersign", SHARED_ATTACH_SEMANTICS),
] as const satisfies readonly PublicOptionDefinition[];

const CODER_OPTIONS = [
  {
    id: "phase",
    owner: "coder",
    canonical: "plan|apply",
    aliases: ["plan", "apply"],
    valueMetavar: null,
    required: false,
    repeatable: false,
    defaultValue: "apply",
    form: "positional",
    phases: ["plan", "apply"],
    description: {
      en: "Optional phase token before the instruction; defaults to apply.",
      zh: "指令前可选 phase 词元；默认 apply。",
    },
  },
  bindOwner("coder", SHARED_PROJECT_SEMANTICS),
  bindOwner("coder", SHARED_ATTACH_SEMANTICS),
] as const satisfies readonly PublicOptionDefinition[];

const FIXER_OPTIONS = [
  {
    id: "phase",
    owner: "fixer",
    canonical: "plan|apply",
    aliases: ["plan", "apply"],
    valueMetavar: null,
    required: false,
    repeatable: false,
    defaultValue: "apply",
    form: "positional",
    phases: ["plan", "apply"],
    description: {
      en: "Optional phase token before the instruction; defaults to apply.",
      zh: "指令前可选 phase 词元；默认 apply。",
    },
  },
  bindOwner("fixer", SHARED_PROJECT_SEMANTICS),
  bindOwner("fixer", SHARED_ATTACH_SEMANTICS),
  {
    id: "prerequisites",
    owner: "fixer",
    canonical: "--prerequisites",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "JSON array of {id, requirement} prerequisite objects.",
      zh: "{id, requirement} 前置条件 JSON 数组路径。",
    },
  },
] as const satisfies readonly PublicOptionDefinition[];

const REVIEWER_OPTIONS = [
  bindOwner("reviewer", SHARED_PROJECT_SEMANTICS),
  // Reviewer deliberately has no --attach face (gathers its own evidence).
  {
    id: "base",
    owner: "reviewer",
    canonical: "--base",
    aliases: [],
    valueMetavar: "revision",
    required: true,
    repeatable: false,
    form: "option",
    description: {
      en: "Required fixed-point revision for the pinned review target.",
      zh: "必填；钉住审查目标的 fixed-point revision。",
    },
  },
  {
    id: "authority-ref",
    owner: "reviewer",
    canonical: "--authority-ref",
    aliases: [],
    valueMetavar: "ref",
    required: false,
    repeatable: true,
    form: "option",
    description: {
      en: "Durable authority reference/URL (repeatable; refs only, not inline prose).",
      zh: "持久 authority 引用/URL（可重复；仅 ref，非内联散文）。",
    },
  },
] as const satisfies readonly PublicOptionDefinition[];

const COLLECTOR_OPTIONS = [
  bindOwner("collector", SHARED_PROJECT_SEMANTICS),
  bindOwner("collector", SHARED_ATTACH_SEMANTICS),
  {
    id: "pr",
    owner: "collector",
    canonical: "--pr",
    aliases: [],
    valueMetavar: "number",
    required: true,
    repeatable: false,
    form: "option",
    description: {
      en: "Required positive GitHub pull request number.",
      zh: "必填；正整数 GitHub PR 号。",
    },
  },
  {
    id: "repo",
    owner: "collector",
    canonical: "--repo",
    aliases: [],
    valueMetavar: "owner/repo",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "GitHub owner/repo override (defaults from origin when github.com).",
      zh: "GitHub owner/repo 覆盖（默认取 github.com origin）。",
    },
  },
  {
    id: "request-manifest",
    owner: "collector",
    canonical: "--request-manifest",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Optional request manifest JSON path ({requests:[{id,body}]}).",
      zh: "可选 request manifest JSON 路径（{requests:[{id,body}]}）。",
    },
  },
] as const satisfies readonly PublicOptionDefinition[];

const DOCTOR_OPTIONS = [
  bindOwner("doctor", SHARED_PROJECT_SEMANTICS),
  bindOwner("doctor", SHARED_ATTACH_SEMANTICS),
  {
    id: "issue",
    owner: "doctor",
    canonical: "--issue",
    aliases: [],
    valueMetavar: "number",
    required: true,
    repeatable: false,
    form: "option",
    description: {
      en: "Required positive issue number for the retained case.",
      zh: "必填；留存病例的正整数 issue 号。",
    },
  },
  {
    id: "runs",
    owner: "doctor",
    canonical: "--runs",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Optional project-relative .ak-roles/books/<book>/issues/<n>/runs override matching --issue.",
      zh: "可选项目相对 .ak-roles/books/<book>/issues/<n>/runs 覆盖，且须匹配 --issue。",
    },
  },
] as const satisfies readonly PublicOptionDefinition[];

const NOTARY_OPTIONS = [
  bindOwner("notary", SHARED_PROJECT_SEMANTICS),
  {
    id: "source-run",
    owner: "notary",
    canonical: "--source-run",
    aliases: [],
    valueMetavar: "runId@role|path",
    required: true,
    repeatable: false,
    form: "option",
    description: {
      en: "Required source run locator (runId@role under the book home, or path to that run directory). Zero prompt/attachment projection.",
      zh: "必填源 run 定位符（簿内 runId@role，或该 run 目录路径）。零 prompt/附件投影。",
    },
  },
] as const satisfies readonly PublicOptionDefinition[];

const MERGER_OPTIONS = [
  // Merger project face differs: requires an in-progress ordinary merge root.
  {
    id: "project",
    owner: "merger",
    canonical: "--project",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Project root with one ordinary in-progress merge (defaults to cwd).",
      zh: "已有进行中 ordinary merge 的项目根（默认 cwd）。",
    },
  },
  bindOwner("merger", SHARED_ATTACH_SEMANTICS),
] as const satisfies readonly PublicOptionDefinition[];

const ANALYST_OPTIONS = [
  {
    id: "sweep",
    owner: "analyst",
    canonical: "sweep",
    aliases: [],
    valueMetavar: null,
    required: false,
    repeatable: false,
    form: "positional",
    modes: ["sweep"],
    selectsMode: "sweep",
    description: {
      en: "Optional sweep mode token (at most once; no other positionals).",
      zh: "可选 sweep 模式词元（至多一次；不得夹带其他 positional）。",
    },
  },
  {
    id: "ticket",
    owner: "analyst",
    canonical: "--ticket",
    aliases: [],
    valueMetavar: "number",
    required: false,
    repeatable: false,
    form: "option",
    modes: ["issue"],
    description: {
      en: "Ticket/issue number; live filter by invocation.ticketNumber inside the cwd book (git common-dir). Bare call = whole book. No library-index bootstrap.",
      zh: "票号；在 cwd 候簿（git common-dir）内按 invocation.ticketNumber 现取现算。裸调用=整簿。不依赖 library-index 自举。",
    },
  },
  {
    id: "attach",
    owner: "analyst",
    canonical: "--attach",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: true,
    form: "option",
    modes: ["sweep"],
    selectsMode: "sweep",
    requiredInModes: ["sweep"],
    maxCountByMode: { sweep: 1 },
    description: {
      en: "Sweep-mode attachment path; required exactly once in sweep; payload is the attachment body.",
      zh: "sweep 模式附件路径；sweep 必填且恰一次；载荷为附件正文。",
    },
  },
  {
    id: "cohort",
    owner: "analyst",
    canonical: "--cohort",
    aliases: [],
    valueMetavar: null,
    required: false,
    repeatable: false,
    form: "option",
    modes: ["cohort"],
    selectsMode: "cohort",
    description: {
      en: "Select cohort mode.",
      zh: "选择 cohort 模式。",
    },
  },
  {
    id: "group-a-label",
    owner: "analyst",
    canonical: "--group-a-label",
    aliases: [],
    valueMetavar: "label",
    required: false,
    repeatable: false,
    form: "option",
    modes: ["cohort"],
    requiredInModes: ["cohort"],
    description: {
      en: "Cohort group A label (required in cohort mode).",
      zh: "cohort A 组标签（cohort 模式必填）。",
    },
  },
  {
    id: "group-a-issues",
    owner: "analyst",
    canonical: "--group-a-issues",
    aliases: [],
    valueMetavar: "N|book:N[,...]",
    required: false,
    repeatable: false,
    form: "option",
    modes: ["cohort"],
    requiredInModes: ["cohort"],
    description: {
      en: "Cohort group A issues: bare N joins cwd book; book:N selects another book; escape a literal comma/backslash in a book key as \\, / \\\\ (required in cohort mode).",
      zh: "cohort A 组 issue：裸 N 归属 cwd 簿；book:N 显式跨簿；簿键中的逗号/反斜杠用 \\, / \\\\ 转义（cohort 模式必填）。",
    },
  },
  {
    id: "group-b-label",
    owner: "analyst",
    canonical: "--group-b-label",
    aliases: [],
    valueMetavar: "label",
    required: false,
    repeatable: false,
    form: "option",
    modes: ["cohort"],
    requiredInModes: ["cohort"],
    description: {
      en: "Cohort group B label (required in cohort mode).",
      zh: "cohort B 组标签（cohort 模式必填）。",
    },
  },
  {
    id: "group-b-issues",
    owner: "analyst",
    canonical: "--group-b-issues",
    aliases: [],
    valueMetavar: "N|book:N[,...]",
    required: false,
    repeatable: false,
    form: "option",
    modes: ["cohort"],
    requiredInModes: ["cohort"],
    description: {
      en: "Cohort group B issues: bare N joins cwd book; book:N selects another book; escape a literal comma/backslash in a book key as \\, / \\\\ (required in cohort mode).",
      zh: "cohort B 组 issue：裸 N 归属 cwd 簿；book:N 显式跨簿；簿键中的逗号/反斜杠用 \\, / \\\\ 转义（cohort 模式必填）。",
    },
  },
] as const satisfies readonly PublicOptionDefinition[];

/**
 * Sole production option tables keyed by PUBLIC_ROLE_ARGV / global owner.
 * Rows are readonly definition lists — parsers look up spellings here.
 */
export const PUBLIC_OPTION_TABLE = {
  global: GLOBAL_OPTIONS,
  judge: JUDGE_OPTIONS,
  countersign: COUNTERSIGN_OPTIONS,
  coder: CODER_OPTIONS,
  fixer: FIXER_OPTIONS,
  reviewer: REVIEWER_OPTIONS,
  collector: COLLECTOR_OPTIONS,
  doctor: DOCTOR_OPTIONS,
  merger: MERGER_OPTIONS,
  notary: NOTARY_OPTIONS,
  analyst: ANALYST_OPTIONS,
} as const satisfies Record<OptionOwner, readonly PublicOptionDefinition[]>;

export type PublicRoleOptionOwner = Exclude<OptionOwner, "global">;

/** Role/deterministic owners that appear on PUBLIC_ROLE_ARGV. */
export const PUBLIC_ROLE_OPTION_OWNERS = [
  "judge",
  "countersign",
  "coder",
  "fixer",
  "reviewer",
  "collector",
  "doctor",
  "merger",
  "notary",
  "analyst",
] as const satisfies readonly PublicRoleOptionOwner[];

export function optionsForOwner(
  owner: OptionOwner,
): readonly PublicOptionDefinition[] {
  return PUBLIC_OPTION_TABLE[owner];
}

export function optionById(
  owner: OptionOwner,
  id: string,
): PublicOptionDefinition {
  const found = PUBLIC_OPTION_TABLE[owner].find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`public option not defined: ${owner}/${id}`);
  }
  return found;
}

/** Every dashed spelling (canonical + aliases) for option-form entries. */
export function dashedSpellings(
  def: PublicOptionDefinition,
): readonly string[] {
  if (def.form !== "option") return [];
  return [def.canonical, ...def.aliases];
}

/**
 * Match `token` against dashed option definitions.
 * Supports exact `--flag` / `-h` and inline `--flag=value`.
 */
export function matchDashedOption(
  token: string,
  definitions: readonly PublicOptionDefinition[],
):
  | { def: PublicOptionDefinition; inlineValue?: string }
  | undefined {
  if (!token.startsWith("-") || token === "-") return undefined;
  for (const def of definitions) {
    if (def.form !== "option") continue;
    for (const spelling of dashedSpellings(def)) {
      if (token === spelling) {
        return { def };
      }
      if (def.valueMetavar !== null && token.startsWith(`${spelling}=`)) {
        return { def, inlineValue: token.slice(spelling.length + 1) };
      }
    }
  }
  return undefined;
}

/**
 * Consume one dashed option from the front of `tokens` (mutates).
 * Returns undefined when tokens[0] is not a known definition spelling.
 * Does not enforce `repeatable` — production parsers use `createTypedOptionConsumer`.
 */
export function takeDashedOption(
  tokens: string[],
  definitions: readonly PublicOptionDefinition[],
): { def: PublicOptionDefinition; value: string | undefined } | undefined {
  const token = tokens[0];
  if (token === undefined) return undefined;
  const matched = matchDashedOption(token, definitions);
  if (matched === undefined) return undefined;
  tokens.shift();
  if (matched.def.valueMetavar === null) {
    return { def: matched.def, value: undefined };
  }
  if (matched.inlineValue !== undefined) {
    return { def: matched.def, value: matched.inlineValue };
  }
  return { def: matched.def, value: tokens.shift() };
}

/**
 * Match a bare token against form:"positional" definitions (canonical or alias).
 * Does not record occurrence — use `createTypedOptionConsumer().takePositional`.
 */
export function matchPositionalOption(
  token: string,
  definitions: readonly PublicOptionDefinition[],
): PublicOptionDefinition | undefined {
  for (const def of definitions) {
    if (def.form !== "positional") continue;
    if (def.canonical === token || def.aliases.includes(token)) {
      return def;
    }
  }
  return undefined;
}

export type TakenTypedOption = {
  readonly def: PublicOptionDefinition;
  readonly value: string | undefined;
};

/**
 * Shared typed-table argv consumer (#342).
 * Single path for dashed take, positional selector take, leading role-phase
 * resolution, `repeatable:false` rejection, and unconditional `required:true`
 * missing checks via CliUsageError.
 */
export type TypedOptionConsumer = {
  /** Take one dashed option from `tokens` front; enforces repeatable. */
  readonly takeDashed: (tokens: string[]) => TakenTypedOption | undefined;
  /**
   * If `token` is a known positional spelling, record it (repeatable-enforced)
   * and return its definition; otherwise undefined.
   */
  readonly takePositional: (token: string) => PublicOptionDefinition | undefined;
  /**
   * Consume a leading role phase token from `positional` using the owner's
   * typed `phase` definition (aliases + defaultValue). Mutates `positional`
   * when a phase token is taken. No hardcoded plan/apply branch at call sites.
   */
  readonly consumeLeadingPhase: (positional: string[]) => RolePhase;
  /** Occurrence count for an option id (0 when never seen). */
  readonly count: (id: string) => number;
  /**
   * Reject when any definition with unconditional `required:true` has count 0.
   * Table-driven sole missing-required gate — parsers must not restate it.
   */
  readonly assertRequired: () => void;
};

/**
 * Build the sole production consumer for one owner definition list.
 * Every public argv parser shares this path — no parallel phase/repeatable/required logic.
 */
export function createTypedOptionConsumer(
  definitions: readonly PublicOptionDefinition[],
): TypedOptionConsumer {
  const counts = new Map<string, number>();

  const note = (def: PublicOptionDefinition): void => {
    const next = (counts.get(def.id) ?? 0) + 1;
    counts.set(def.id, next);
    if (next > 1 && !def.repeatable) {
      throw new CliUsageError(`${def.canonical} cannot be repeated`);
    }
  };

  return {
    takeDashed(tokens) {
      const taken = takeDashedOption(tokens, definitions);
      if (taken === undefined) return undefined;
      note(taken.def);
      return taken;
    },
    takePositional(token) {
      const def = matchPositionalOption(token, definitions);
      if (def === undefined) return undefined;
      note(def);
      return def;
    },
    consumeLeadingPhase(positional) {
      const phaseDef = definitions.find(
        (def) => def.id === "phase" && def.form === "positional",
      );
      const defaultPhase: RolePhase =
        phaseDef?.defaultValue === "plan" || phaseDef?.defaultValue === "apply"
          ? phaseDef.defaultValue
          : "apply";
      if (phaseDef === undefined || positional.length === 0) {
        return defaultPhase;
      }
      const token = positional[0]!;
      // Aliases carry single-token spellings; canonical may be a joint label (plan|apply).
      if (!phaseDef.aliases.includes(token) && phaseDef.canonical !== token) {
        return defaultPhase;
      }
      positional.shift();
      note(phaseDef);
      if (token !== "plan" && token !== "apply") {
        throw new CliUsageError(`invalid phase token: ${token}`);
      }
      return token;
    },
    count(id) {
      return counts.get(id) ?? 0;
    },
    assertRequired() {
      for (const def of definitions) {
        if (!def.required) continue;
        if ((counts.get(def.id) ?? 0) > 0) continue;
        const suffix =
          def.valueMetavar === null ? "" : ` <${def.valueMetavar}>`;
        throw new CliUsageError(
          `${def.owner} requires ${def.canonical}${suffix}`,
        );
      }
    },
  };
}

/** Structured option projection used by help and acceptance tests. */
export type StructuredOptionProjection = {
  readonly id: string;
  readonly owner: OptionOwner;
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly valueMetavar: string | null;
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly defaultValue?: string;
  readonly form: "option" | "positional";
  readonly phases?: readonly RolePhase[];
  readonly modes?: readonly AnalystMode[];
  readonly requiredInModes?: readonly AnalystMode[];
  readonly exclusiveWith?: readonly string[];
  readonly maxCountByMode?: Readonly<Partial<Record<AnalystMode, number>>>;
  readonly selectsMode?: AnalystMode;
  readonly description: { readonly en: string; readonly zh: string };
};

export function projectOwnerOptions(
  owner: OptionOwner,
): readonly StructuredOptionProjection[] {
  return optionsForOwner(owner).map((def) => ({
    id: def.id,
    owner: def.owner,
    canonical: def.canonical,
    aliases: def.aliases,
    valueMetavar: def.valueMetavar,
    required: def.required,
    repeatable: def.repeatable,
    ...(def.defaultValue === undefined ? {} : { defaultValue: def.defaultValue }),
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
    ...(def.selectsMode === undefined ? {} : { selectsMode: def.selectsMode }),
    description: def.description,
  }));
}

/** All rejected spelling tokens flattened (for leakage scans). */
export function allRejectedSpellingTokens(): readonly string[] {
  const out: string[] = [];
  for (const entry of REJECTED_PUBLIC_SPELLINGS) {
    out.push(...entry.spellings);
  }
  return out;
}

/**
 * #125 — public command help facts on the sole option-owner module.
 * Presentation inputs only (USAGE synopsis + public `ak-role` examples).
 * Option identity/requiredness remain on PUBLIC_OPTION_TABLE rows.
 * Free text is not a test contract (机器只咬契约，不咬呈现).
 */
export type PublicCommandHelpFacts = {
  /** Command / topic id (role owner, support command, or "top"). */
  readonly command: string;
  /** One-line what-it-does (presentation). */
  readonly summary: string;
  /** USAGE synopsis line(s), each a full public `ak-role …` sketch. */
  readonly usage: readonly string[];
  /** 1–2 public invocation examples using only public spellings. */
  readonly examples: readonly string[];
};

/**
 * Top-level public help short note for automatic Navigator attendance.
 * Not a caller command; configure via `ak-role config set navigator …`.
 */
export const PUBLIC_NAVIGATOR_HELP_NOTE =
  "Navigator attends automatically on every run; configure with `ak-role config set navigator <provider/model[:thinking]>` (not a caller command)." as const;

const TOP_LEVEL_HELP = {
  command: "top",
  summary: "public role CLI",
  usage: [
    "ak-role <command> [options]",
    "ak-role help <command>",
  ],
  examples: [
    'ak-role judge --attach ./plan.md "Review this plan."',
    'ak-role coder plan "Propose the first implementation plan."',
  ],
} as const satisfies PublicCommandHelpFacts;

const ROLE_COMMAND_HELP = {
  judge: {
    command: "judge",
    summary: "Adjudicate the supplied materials; infers its own burden.",
    usage: ["ak-role judge [options] [instruction]"],
    examples: [
      'ak-role judge --attach ./plan.md "Review this plan."',
      'ak-role judge --attach ./findings.md --attach ./adr.md "Adjudicate every finding."',
    ],
  },
  countersign: {
    command: "countersign",
    summary: "Ticket-court review before work starts; five questions, 署/封驳/上呈.",
    usage: ["ak-role countersign [options] [instruction]"],
    examples: [
      'ak-role countersign --attach ./ticket.md "裁：本票是否足以开工。"',
      'ak-role countersign --attach ./plan.md --attach ./adr.md "裁：方案五问。"',
    ],
  },
  coder: {
    command: "coder",
    summary: "First implementation; phase defaults to apply.",
    usage: ["ak-role coder [plan|apply] [options] <instruction>"],
    examples: [
      'ak-role coder plan "Propose the first implementation plan."',
      'ak-role coder apply --attach ./plan.md "Implement the approved slice."',
    ],
  },
  fixer: {
    command: "fixer",
    summary: "Repair the assigned findings; phase defaults to apply.",
    usage: ["ak-role fixer [plan|apply] [options] <instruction>"],
    examples: [
      'ak-role fixer --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."',
      'ak-role fixer plan --attach ./findings.md "Propose the repair plan."',
    ],
  },
  reviewer: {
    command: "reviewer",
    summary: "Fixed-target two-axis review (Standards + Spec).",
    usage: ["ak-role reviewer --base <revision> [options] <instruction>"],
    examples: [
      'ak-role reviewer --base main "Review the branch against the governing issue and repository authority."',
    ],
  },
  collector: {
    command: "collector",
    summary: "Collect GitHub PR review evidence (one-shot).",
    usage: ["ak-role collector --pr <number> [options] [instruction]"],
    examples: [
      "ak-role collector --pr 42 --repo owner/repository",
      "ak-role collector --pr 42 --request-manifest ./requests.json",
    ],
  },
  doctor: {
    command: "doctor",
    summary: "Diagnose one retained case (one-shot).",
    usage: ["ak-role doctor --issue <number> [options] [instruction]"],
    examples: [
      'ak-role doctor --issue 115 "Diagnose this retained case."',
    ],
  },
  merger: {
    command: "merger",
    summary: "Resolve one ordinary merge already in conflict.",
    usage: ["ak-role merger [options] <instruction>"],
    examples: [
      'ak-role merger --project /path/to/worktree "Reconcile the active merge."',
    ],
  },
  notary: {
    command: "notary",
    summary: "Direct Notary document check (quote fidelity + ticket alignment); zero prompt/attachment.",
    usage: ["ak-role notary --source-run <runId@role|path> [options]"],
    examples: [
      "ak-role notary --source-run 01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
    ],
  },
  analyst: {
    command: "analyst",
    summary: "Deterministic analysis seat (issue / sweep / cohort).",
    usage: [
      "ak-role analyst [--ticket <N>]",
      "ak-role analyst [sweep] --attach <path>",
      "ak-role analyst --cohort --group-a-label <L> --group-a-issues <N|book:N[,...]> --group-b-label <L> --group-b-issues <N|book:N[,...]>",
    ],
    examples: [
      "ak-role analyst",
      "ak-role analyst --ticket 125",
      "ak-role analyst sweep --attach ./sweep.json",
    ],
  },
} as const satisfies Record<PublicRoleOptionOwner, PublicCommandHelpFacts>;

const SUPPORT_COMMAND_HELP = {
  roles: {
    command: "roles",
    summary: "List effective seats and models.",
    usage: ["ak-role roles"],
    examples: ["ak-role roles"],
  },
  config: {
    command: "config",
    summary: "Persistent seat model, labor-engine, and auto-resume defaults.",
    usage: [
      "ak-role config set <seat> <provider/model[:thinking]> [<seat> <spec> ...]",
      "ak-role config unset <gatekeeper|inspector|notary>",
      "ak-role config set-engine <seat> <name>",
      "ak-role config unset-engine <seat>",
      "ak-role config set-host <seat> <name>",
      "ak-role config unset-host <seat>",
      "ak-role config set-auto-resume-limit <N>",
    ],
    examples: [
      "ak-role config set judge openai-codex/gpt-5.6-sol:high",
      "ak-role config unset gatekeeper",
      "ak-role config set-engine judge opus",
      "ak-role config set-auto-resume-limit 3",
    ],
  },
  help: {
    command: "help",
    summary: "Show public CLI help.",
    usage: ["ak-role help [command]", "ak-role --help"],
    examples: ["ak-role help coder", "ak-role help judge"],
  },
  resume: {
    command: "resume",
    summary: "Reopen an exact role run whose Pi session principal still exists.",
    usage: ["ak-role resume <runId> [message]"],
    examples: [
      "ak-role resume 01abc…",
      "ak-role resume 01abc… \"owner ruling\"",
    ],
  },
} as const satisfies Record<string, PublicCommandHelpFacts>;

/**
 * Sole public help-copy owner keyed by command/topic id.
 * Role topics share identity with PUBLIC_ROLE_OPTION_OWNERS; options still
 * project from PUBLIC_OPTION_TABLE. Support topics cover non-option commands.
 */
export const PUBLIC_COMMAND_HELP = {
  top: TOP_LEVEL_HELP,
  ...ROLE_COMMAND_HELP,
  ...SUPPORT_COMMAND_HELP,
} as const;

export type PublicCommandHelpTopic = keyof typeof PUBLIC_COMMAND_HELP;

/** Structured projector — identity + presence; free text is presentation. */
export function projectCommandHelp(
  topic: string,
): PublicCommandHelpFacts | undefined {
  if (!(topic in PUBLIC_COMMAND_HELP)) return undefined;
  const facts = PUBLIC_COMMAND_HELP[topic as PublicCommandHelpTopic];
  return {
    command: facts.command,
    summary: facts.summary,
    usage: [...facts.usage],
    examples: [...facts.examples],
  };
}

/**
 * Human OPTIONS lines from the sole option table.
 * Layout is presentation; structured identity stays on projectOwnerOptions.
 */
export function renderHumanOwnerOptionLines(
  owner: OptionOwner,
  locale: "en" | "zh" = "en",
): string[] {
  const lines: string[] = [];
  for (const opt of projectOwnerOptions(owner)) {
    let spelling = opt.canonical;
    if (opt.valueMetavar !== null) {
      spelling = `${spelling} <${opt.valueMetavar}>`;
    }
    if (opt.aliases.length > 0) {
      // Prefer single-token aliases in the spelling hint (plan/apply, -h).
      // #412/397-F2: inside aliases.length > 0 the empty branch is dead — join directly.
      const aliasHint = opt.aliases.join(", ");
      if (opt.form === "positional") {
        spelling = opt.aliases.join("|");
      } else {
        spelling = `${spelling} (${aliasHint})`;
      }
    }
    const tags: string[] = [];
    if (opt.required) tags.push("required");
    if (opt.requiredInModes !== undefined) {
      tags.push(`required:${opt.requiredInModes.join("|")}`);
    }
    if (opt.repeatable) tags.push("repeatable");
    if (opt.defaultValue !== undefined) tags.push(`default=${opt.defaultValue}`);
    if (opt.form === "positional") tags.push("positional");
    const tagText = tags.length === 0 ? "" : ` [${tags.join(", ")}]`;
    const desc = locale === "zh" ? opt.description.zh : opt.description.en;
    lines.push(`  ${spelling}${tagText}  ${desc}`);
  }
  return lines;
}
