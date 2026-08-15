/**
 * #342 — sole typed public CLI option-definition source.
 *
 * PUBLIC_ROLE_ARGV rows reference these definitions. Production parsers and
 * `help <command>` consume this table; README flag inventory is generated from
 * it. Do not maintain a parallel spelling set in parsers, help, or docs.
 */

/** Taishi query faces (#336/#337/#338). */
export type TaishiMode = "issue" | "sweep" | "cohort" | "model-groups";

/** Coder/Fixer public phase tokens. */
export type RolePhase = "plan" | "apply";

export type OptionOwner =
  | "global"
  | "judge"
  | "coder"
  | "fixer"
  | "reviewer"
  | "collector"
  | "doctor"
  | "merger"
  | "taishi";

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
  /** When set, only these taishi modes admit the option. */
  readonly modes?: readonly TaishiMode[];
  /** Modes in which this option is required (taishi conditional requiredness). */
  readonly requiredInModes?: readonly TaishiMode[];
  /**
   * Other option ids on the same owner that cannot co-occur
   * (e.g. cohort × model-groups).
   */
  readonly exclusiveWith?: readonly string[];
  /** Per-mode maximum occurrences (issue `--project-root` ≤ 1). */
  readonly maxCountByMode?: Readonly<Partial<Record<TaishiMode, number>>>;
  /**
   * When this option (or positional) is present it activates this mode.
   * Mode resolution consumes only this field — parsers must not restate selectors.
   */
  readonly selectsMode?: TaishiMode;
  readonly description: { readonly en: string; readonly zh: string };
};

/**
 * Cross-field at-least-one rules for taishi modes (cannot hang on one option row).
 * Parser-consumed sole source together with per-option modes/required/exclusive/max (#342).
 */
export type TaishiRequireAnyOfRule = {
  readonly mode: TaishiMode;
  readonly optionIds: readonly string[];
};

/** Issue face: ticket | project-root at least one. */
export const TAISHI_REQUIRE_ANY_OF = [
  { mode: "issue", optionIds: ["ticket", "project-root"] },
] as const satisfies readonly TaishiRequireAnyOfRule[];

/** Residual taishi mode when no `selectsMode` option is present. */
export const TAISHI_DEFAULT_MODE: TaishiMode = "issue";

/**
 * Resolve taishi mode from collected option ids via `selectsMode` on the table.
 * Deterministic preference when multiple selectors co-occur; exclusiveWith then rejects.
 */
export function resolveTaishiMode(
  presentOptionIds: ReadonlySet<string>,
): TaishiMode {
  const selected = new Set<TaishiMode>();
  for (const def of optionsForOwner("taishi")) {
    if (def.selectsMode === undefined) continue;
    if (presentOptionIds.has(def.id)) selected.add(def.selectsMode);
  }
  if (selected.size === 0) return TAISHI_DEFAULT_MODE;
  if (selected.has("cohort")) return "cohort";
  if (selected.has("model-groups")) return "model-groups";
  if (selected.has("sweep")) return "sweep";
  if (selected.has("issue")) return "issue";
  return TAISHI_DEFAULT_MODE;
}

export type TaishiOptionCounts = ReadonlyMap<string, number>;

/**
 * Evaluate taishi cross-field / cross-mode structured contracts from the sole typed table.
 * Covers: modes admission, requiredInModes, exclusiveWith, maxCountByMode, TAISHI_REQUIRE_ANY_OF.
 */
export function evaluateTaishiModeOptionContract(
  mode: TaishiMode,
  counts: TaishiOptionCounts,
): { ok: true } | { ok: false; message: string } {
  const definitions = optionsForOwner("taishi");
  const byId = new Map(definitions.map((def) => [def.id, def] as const));

  for (const def of definitions) {
    const count = counts.get(def.id) ?? 0;
    if (count === 0 || def.exclusiveWith === undefined) continue;
    for (const otherId of def.exclusiveWith) {
      if ((counts.get(otherId) ?? 0) === 0) continue;
      const other = byId.get(otherId);
      return {
        ok: false,
        message: `taishi accepts only one of ${def.canonical} / ${other?.canonical ?? otherId}`,
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
          message: `taishi sweep --attach cannot combine with ${def.canonical}`,
        };
      }
      return {
        ok: false,
        message: `taishi ${mode} does not accept ${def.canonical}`,
      };
    }
    const max = def.maxCountByMode?.[mode];
    if (max !== undefined && count > max) {
      return {
        ok: false,
        message:
          max === 1
            ? `taishi ${mode} accepts at most one ${def.canonical}`
            : `taishi ${mode} accepts at most ${max} ${def.canonical}`,
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
          "usage: ak-role taishi --cohort --group-a-label <L> --group-a-issues <N[,N...]> --group-b-label <L> --group-b-issues <N[,N...]",
      };
    }
    if (mode === "model-groups") {
      return {
        ok: false,
        message:
          "usage: ak-role taishi --model-groups --project-root <P> [--project-root <P> ...]",
      };
    }
    return {
      ok: false,
      message: `usage: ak-role taishi ${mode} requires ${missingRequired
        .map((def) => def.canonical)
        .join(" ")}`,
    };
  }

  for (const rule of TAISHI_REQUIRE_ANY_OF) {
    if (rule.mode !== mode) continue;
    const hit = rule.optionIds.some((id) => (counts.get(id) ?? 0) > 0);
    if (hit) continue;
    if (mode === "issue") {
      // Bare-usage surface names issue faces and the sweep attach carrier.
      return {
        ok: false,
        message:
          "usage: ak-role taishi ((--ticket <N> | --project-root <P>) | [sweep] --attach <sweep.json> | --cohort ... | --model-groups ...)",
      };
    }
    const flags = rule.optionIds
      .map((id) => byId.get(id)?.canonical ?? id)
      .join(" | ");
    return {
      ok: false,
      message: `usage: ak-role taishi ${mode} requires one of ${flags}`,
    };
  }

  return { ok: true };
}

/**
 * Rejected / internal spellings retained by parsers for explicit refusal.
 * Must never appear in public help or README projections.
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

const JUDGE_OPTIONS = [
  {
    id: "project",
    owner: "judge",
    canonical: "--project",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Project root for ledger identity (defaults to process cwd).",
      zh: "卷宗身份用的项目根（默认进程 cwd）。",
    },
  },
  {
    id: "attach",
    owner: "judge",
    canonical: "--attach",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: true,
    form: "option",
    description: {
      en: "Attach a regular file; frozen at admission (repeatable).",
      zh: "附加普通文件；受理即冻结（可重复）。",
    },
  },
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
  {
    id: "project",
    owner: "coder",
    canonical: "--project",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Project root for ledger identity (defaults to process cwd).",
      zh: "卷宗身份用的项目根（默认进程 cwd）。",
    },
  },
  {
    id: "attach",
    owner: "coder",
    canonical: "--attach",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: true,
    form: "option",
    description: {
      en: "Attach a regular file; frozen at admission (repeatable).",
      zh: "附加普通文件；受理即冻结（可重复）。",
    },
  },
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
  {
    id: "project",
    owner: "fixer",
    canonical: "--project",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Project root for ledger identity (defaults to process cwd).",
      zh: "卷宗身份用的项目根（默认进程 cwd）。",
    },
  },
  {
    id: "attach",
    owner: "fixer",
    canonical: "--attach",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: true,
    form: "option",
    description: {
      en: "Attach a regular file; frozen at admission (repeatable).",
      zh: "附加普通文件；受理即冻结（可重复）。",
    },
  },
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
  {
    id: "project",
    owner: "reviewer",
    canonical: "--project",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Project root for ledger identity (defaults to process cwd).",
      zh: "卷宗身份用的项目根（默认进程 cwd）。",
    },
  },
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
  {
    id: "project",
    owner: "collector",
    canonical: "--project",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Project root for ledger identity (defaults to process cwd).",
      zh: "卷宗身份用的项目根（默认进程 cwd）。",
    },
  },
  {
    id: "attach",
    owner: "collector",
    canonical: "--attach",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: true,
    form: "option",
    description: {
      en: "Attach a regular file; frozen at admission (repeatable).",
      zh: "附加普通文件；受理即冻结（可重复）。",
    },
  },
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
  {
    id: "project",
    owner: "doctor",
    canonical: "--project",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: false,
    form: "option",
    description: {
      en: "Project root for ledger identity (defaults to process cwd).",
      zh: "卷宗身份用的项目根（默认进程 cwd）。",
    },
  },
  {
    id: "attach",
    owner: "doctor",
    canonical: "--attach",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: true,
    form: "option",
    description: {
      en: "Attach a regular file; frozen at admission (repeatable).",
      zh: "附加普通文件；受理即冻结（可重复）。",
    },
  },
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

const MERGER_OPTIONS = [
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
  {
    id: "attach",
    owner: "merger",
    canonical: "--attach",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: true,
    form: "option",
    description: {
      en: "Attach a regular file; frozen at admission (repeatable).",
      zh: "附加普通文件；受理即冻结（可重复）。",
    },
  },
] as const satisfies readonly PublicOptionDefinition[];

const TAISHI_OPTIONS = [
  {
    id: "sweep",
    owner: "taishi",
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
    id: "project-root",
    owner: "taishi",
    canonical: "--project-root",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: true,
    form: "option",
    modes: ["issue", "model-groups"],
    requiredInModes: ["model-groups"],
    maxCountByMode: { issue: 1 },
    description: {
      en: "Project-root scope key. Issue: at most one (with --ticket at least one of the two). Model-groups: one or more required.",
      zh: "projectRoot 范围键。issue：至多一个（与 --ticket 至少居其一）。model-groups：一个或多个且必填。",
    },
  },
  {
    id: "ticket",
    owner: "taishi",
    canonical: "--ticket",
    aliases: [],
    valueMetavar: "number",
    required: false,
    repeatable: false,
    form: "option",
    modes: ["issue"],
    description: {
      en: "Ticket/issue number for issue mode (with --project-root at least one of the two).",
      zh: "issue 模式的票号（与 --project-root 至少居其一）。",
    },
  },
  {
    id: "attach",
    owner: "taishi",
    canonical: "--attach",
    aliases: [],
    valueMetavar: "path",
    required: false,
    repeatable: true,
    form: "option",
    modes: ["sweep"],
    selectsMode: "sweep",
    description: {
      en: "Sweep-only attachment path(s); payload is the attachment body (exactly one on the run path).",
      zh: "仅 sweep 模式的附件路径；载荷为附件正文（运行路径上恰好一个）。",
    },
  },
  {
    id: "cohort",
    owner: "taishi",
    canonical: "--cohort",
    aliases: [],
    valueMetavar: null,
    required: false,
    repeatable: false,
    form: "option",
    modes: ["cohort"],
    exclusiveWith: ["model-groups"],
    selectsMode: "cohort",
    description: {
      en: "Select cohort mode (mutually exclusive with --model-groups).",
      zh: "选择 cohort 模式（与 --model-groups 互斥）。",
    },
  },
  {
    id: "model-groups",
    owner: "taishi",
    canonical: "--model-groups",
    aliases: [],
    valueMetavar: null,
    required: false,
    repeatable: false,
    form: "option",
    modes: ["model-groups"],
    exclusiveWith: ["cohort"],
    selectsMode: "model-groups",
    description: {
      en: "Select model-groups mode (mutually exclusive with --cohort).",
      zh: "选择 model-groups 模式（与 --cohort 互斥）。",
    },
  },
  {
    id: "group-a-label",
    owner: "taishi",
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
    owner: "taishi",
    canonical: "--group-a-issues",
    aliases: [],
    valueMetavar: "N[,N...]",
    required: false,
    repeatable: false,
    form: "option",
    modes: ["cohort"],
    requiredInModes: ["cohort"],
    description: {
      en: "Cohort group A comma-separated positive issue numbers (required in cohort mode).",
      zh: "cohort A 组逗号分隔正整数 issue 列表（cohort 模式必填）。",
    },
  },
  {
    id: "group-b-label",
    owner: "taishi",
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
    owner: "taishi",
    canonical: "--group-b-issues",
    aliases: [],
    valueMetavar: "N[,N...]",
    required: false,
    repeatable: false,
    form: "option",
    modes: ["cohort"],
    requiredInModes: ["cohort"],
    description: {
      en: "Cohort group B comma-separated positive issue numbers (required in cohort mode).",
      zh: "cohort B 组逗号分隔正整数 issue 列表（cohort 模式必填）。",
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
  coder: CODER_OPTIONS,
  fixer: FIXER_OPTIONS,
  reviewer: REVIEWER_OPTIONS,
  collector: COLLECTOR_OPTIONS,
  doctor: DOCTOR_OPTIONS,
  merger: MERGER_OPTIONS,
  taishi: TAISHI_OPTIONS,
} as const satisfies Record<OptionOwner, readonly PublicOptionDefinition[]>;

export type PublicRoleOptionOwner = Exclude<OptionOwner, "global">;

/** Role/deterministic owners that appear on PUBLIC_ROLE_ARGV. */
export const PUBLIC_ROLE_OPTION_OWNERS = [
  "judge",
  "coder",
  "fixer",
  "reviewer",
  "collector",
  "doctor",
  "merger",
  "taishi",
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
  readonly modes?: readonly TaishiMode[];
  readonly requiredInModes?: readonly TaishiMode[];
  readonly exclusiveWith?: readonly string[];
  readonly maxCountByMode?: Readonly<Partial<Record<TaishiMode, number>>>;
  readonly selectsMode?: TaishiMode;
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
 * Render one owner’s options as stable TSV lines for help.
 * Layout is presentation; identity columns are the structured contract.
 */
export function renderOwnerOptionHelpLines(
  owner: OptionOwner,
  locale: "en" | "zh" = "en",
): string[] {
  const lines: string[] = [];
  for (const opt of projectOwnerOptions(owner)) {
    const aliasText =
      opt.aliases.length === 0 ? "-" : opt.aliases.join(",");
    const metavar = opt.valueMetavar ?? "-";
    const required = opt.required ? "required" : "optional";
    const repeatable = opt.repeatable ? "repeatable" : "single";
    const form = opt.form;
    const phases =
      opt.phases === undefined ? "-" : opt.phases.join("|");
    const modes = opt.modes === undefined ? "-" : opt.modes.join("|");
    const requiredInModes =
      opt.requiredInModes === undefined
        ? "-"
        : opt.requiredInModes.join("|");
    const exclusiveWith =
      opt.exclusiveWith === undefined ? "-" : opt.exclusiveWith.join("|");
    const maxCount =
      opt.maxCountByMode === undefined
        ? "-"
        : Object.entries(opt.maxCountByMode)
            .map(([mode, n]) => `${mode}:${n}`)
            .join(",");
    const defaultValue = opt.defaultValue ?? "-";
    const desc = locale === "zh" ? opt.description.zh : opt.description.en;
    lines.push(
      [
        "option",
        opt.id,
        opt.canonical,
        `aliases=${aliasText}`,
        `metavar=${metavar}`,
        required,
        repeatable,
        `form=${form}`,
        `phases=${phases}`,
        `modes=${modes}`,
        `requiredInModes=${requiredInModes}`,
        `exclusiveWith=${exclusiveWith}`,
        `maxCountByMode=${maxCount}`,
        `default=${defaultValue}`,
        desc,
      ].join("\t"),
    );
  }
  return lines;
}

const README_BEGIN = "<!-- BEGIN GENERATED: public-cli-options -->";
const README_END = "<!-- END GENERATED: public-cli-options -->";

export const PUBLIC_CLI_OPTIONS_README_MARKERS = {
  begin: README_BEGIN,
  end: README_END,
} as const;

/** Markdown flag inventory for README generation (EN or ZH). */
export function renderReadmeOptionsMarkdown(locale: "en" | "zh"): string {
  const lines: string[] = [];
  if (locale === "zh") {
    lines.push("## 公开 CLI 选项（生成）");
    lines.push("");
    lines.push(
      "本表由 `src/public-cli/option-definitions.ts` 生成；以 `ak-role help <command>` 为准。勿手改本区。",
    );
  } else {
    lines.push("## Public CLI options (generated)");
    lines.push("");
    lines.push(
      "Generated from `src/public-cli/option-definitions.ts`. Prefer `ak-role help <command>`. Do not hand-edit this section.",
    );
  }
  lines.push("");

  const owners: OptionOwner[] = ["global", ...PUBLIC_ROLE_OPTION_OWNERS];
  for (const owner of owners) {
    lines.push(locale === "zh" ? `### \`${owner}\`` : `### \`${owner}\``);
    lines.push("");
    lines.push(
      locale === "zh"
        ? "| 拼写 | 别名 | 值 | 必填 | 可重复 | 形式 | 模式/阶段 | 说明 |"
        : "| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const opt of projectOwnerOptions(owner)) {
      const aliases = opt.aliases.length === 0 ? "—" : opt.aliases.join(", ");
      const value = opt.valueMetavar ?? "—";
      const required = opt.required
        ? locale === "zh"
          ? "是"
          : "yes"
        : opt.requiredInModes !== undefined
          ? locale === "zh"
            ? `条件:${opt.requiredInModes.join("|")}`
            : `when:${opt.requiredInModes.join("|")}`
          : locale === "zh"
            ? "否"
            : "no";
      const repeatable = opt.repeatable
        ? locale === "zh"
          ? "是"
          : "yes"
        : locale === "zh"
          ? "否"
          : "no";
      const modePhase = [
        opt.modes === undefined ? "" : `modes=${opt.modes.join("|")}`,
        opt.phases === undefined ? "" : `phases=${opt.phases.join("|")}`,
        opt.exclusiveWith === undefined
          ? ""
          : `xor=${opt.exclusiveWith.join("|")}`,
        opt.maxCountByMode === undefined
          ? ""
          : `max=${Object.entries(opt.maxCountByMode)
              .map(([m, n]) => `${m}:${n}`)
              .join(",")}`,
        opt.defaultValue === undefined ? "" : `default=${opt.defaultValue}`,
      ]
        .filter((part) => part !== "")
        .join("; ");
      const desc = locale === "zh" ? opt.description.zh : opt.description.en;
      lines.push(
        `| \`${opt.canonical}\` | ${aliases === "—" ? aliases : aliases
            .split(", ")
            .map((a) => `\`${a}\``)
            .join(", ")} | ${value === "—" ? value : `\`${value}\``} | ${required} | ${repeatable} | ${opt.form} | ${modePhase || "—"} | ${desc} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Replace the generated region inside a README body, or append one.
 * Returns the full file text.
 */
export function applyReadmeOptionsSection(
  readmeText: string,
  locale: "en" | "zh",
): string {
  const section = `${README_BEGIN}\n${renderReadmeOptionsMarkdown(locale)}${README_END}\n`;
  const beginIdx = readmeText.indexOf(README_BEGIN);
  const endIdx = readmeText.indexOf(README_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const afterEnd = endIdx + README_END.length;
    // Consume a single trailing newline after the end marker when present.
    const tailStart =
      readmeText[afterEnd] === "\n" ? afterEnd + 1 : afterEnd;
    return (
      readmeText.slice(0, beginIdx) + section + readmeText.slice(tailStart)
    );
  }
  // No markers yet — append before EOF.
  const base = readmeText.endsWith("\n") ? readmeText : `${readmeText}\n`;
  return `${base}\n${section}`;
}
