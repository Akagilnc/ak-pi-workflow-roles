import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const NAVIGATOR_EVENT_TYPE = "ak-navigator-attendance" as const;
export const NAVIGATOR_PREPARE_TOOL_NAME = "ak_navigator_prepare" as const;
export const NAVIGATOR_DEFAULT_MODEL = "openai-codex/gpt-5.6-luna:max" as const;

export const NAVIGATOR_TARGETS = [
  { role: "judge", phases: [null] },
  { role: "fixer", phases: ["plan", "apply"] },
  { role: "coder", phases: ["plan", "apply"] },
  { role: "reviewer", phases: [null] },
  { role: "collector", phases: [null] },
  { role: "doctor", phases: [null] },
  { role: "merger", phases: [null] },
] as const;

export type NavigatorTargetRole = typeof NAVIGATOR_TARGETS[number]["role"];
export type NavigatorPhase = "plan" | "apply" | null;
export type NavigatorSettlement =
  | { kind: "accepted"; role: string; phase: NavigatorPhase; status?: string }
  | { kind: "human_decision"; role: string; phase: NavigatorPhase; status: string }
  | { kind: "role_infrastructure_failure"; role: string; phase: NavigatorPhase }
  | { kind: "arrival"; role: "lander"; phase: null; message?: string };

export type NavigatorWorkContext = {
  subjectKey: string;
  subject: string;
  authority: string;
  contextError?: unknown;
};

export type NavigatorRouteTarget = { role: NavigatorTargetRole; phase: NavigatorPhase };
export type NavigatorCandidate = {
  id: string;
  matches: { role: string; phase: NavigatorPhase; kind: "accepted"; statuses?: string[] };
  route: NavigatorRouteTarget[];
  next: NavigatorRouteTarget;
  reason: string;
  command: string;
};

export type NavigatorReport = {
  disposition: "recommendation" | "silence" | "unavailable" | "arrival";
  route?: NavigatorRouteTarget[];
  next?: NavigatorRouteTarget;
  reason?: string;
  command?: string;
  unavailableReason?: string;
  arrivalMessage?: string;
};

export type NavigatorEvent = {
  version: 1;
  disposition: NavigatorReport["disposition"];
  invocationId: string;
  role: string;
  phase: NavigatorPhase;
  subjectKey: string;
  route?: NavigatorRouteTarget[];
  next?: NavigatorRouteTarget;
  reason?: string;
  command?: string;
  unavailableReason?: string;
  arrivalMessage?: string;
};

const targetSchema = Type.Object({
  role: Type.String({ minLength: 1 }),
  phase: Type.Union([Type.Null(), Type.Literal("plan"), Type.Literal("apply")]),
}, { additionalProperties: false });
const candidateSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  matches: Type.Object({
    role: Type.String({ minLength: 1 }),
    phase: Type.Union([Type.Null(), Type.Literal("plan"), Type.Literal("apply")]),
    kind: Type.Literal("accepted"),
    statuses: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  }, { additionalProperties: false }),
  route: Type.Array(targetSchema, { minItems: 1 }),
  next: targetSchema,
  reason: Type.String({ minLength: 1 }),
  command: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const prepareSchema = Type.Object({ candidates: Type.Array(candidateSchema, { minItems: 1 }) }, { additionalProperties: false });
type PrepareOutput = Static<typeof prepareSchema>;

export type NavigatorPreparationSession = {
  prompt(text: string): Promise<void>;
  appendEntry(customType: string, data: unknown): void;
  entries(): readonly unknown[];
  setModel?(model: string, thinkingLevel: "off" | "max"): Promise<void>;
  getThinkingLevel?(): string;
  dispose(): void;
};

export type NavigatorSessionFactory = (options: {
  context: ExtensionContext;
  sessionDir: string;
  tool: ToolDefinition;
}) => Promise<NavigatorPreparationSession>;

export type NavigatorAttendanceOptions = {
  context: ExtensionContext;
  role: string;
  phase: NavigatorPhase;
  subjectKey: string;
  sessionDir: string;
  loadSoul: () => Promise<string>;
  loadRoleHelp: (role: NavigatorTargetRole) => Promise<string>;
  createSession: NavigatorSessionFactory;
  modelSettingPath?: string;
  subject: string;
  authority: string;
  contextError?: unknown;
  sessionDirectory?: (subjectKey: string) => string;
  onEvent: (event: NavigatorEvent, report: NavigatorReport) => void | Promise<void>;
};

const ROUTE_ENTRY = "ak-navigator-route";
const INVOCATION_ENTRY = "ak-navigator-invocation";
const SETTLEMENT_ENTRY = "ak-navigator-settlement";
const targetRoles = new Set<string>(NAVIGATOR_TARGETS.map(({ role }) => role));

function exactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function targetIsValid(value: unknown): value is NavigatorRouteTarget {
  return exactRecord(value) && targetRoles.has(String(value.role)) &&
    (value.phase === null || value.phase === "plan" || value.phase === "apply") &&
    (value.role === "coder" || value.role === "fixer" ? value.phase !== null : value.phase === null);
}
function validateCandidate(value: unknown): NavigatorCandidate {
  const next = exactRecord(value) ? value.next : undefined;
  if (!exactRecord(value) || typeof value.id !== "string" || value.id.trim() === "" ||
      !exactRecord(value.matches) || typeof value.matches.role !== "string" || value.matches.role.trim() === "" ||
      (value.matches.phase !== null && value.matches.phase !== "plan" && value.matches.phase !== "apply") || value.matches.kind !== "accepted" ||
      (value.matches.statuses !== undefined && (!Array.isArray(value.matches.statuses) || value.matches.statuses.some((s) => typeof s !== "string" || s.trim() === ""))) ||
      !Array.isArray(value.route) || value.route.length === 0 || value.route.some((target) => !targetIsValid(target)) ||
      !targetIsValid(next) || !value.route.some((target) => target.role === next.role && target.phase === next.phase) ||
      typeof value.reason !== "string" || value.reason.trim() === "" ||
      typeof value.command !== "string" || value.command.trim() === "") {
    throw new Error("Navigator preparation output is not a typed route candidate");
  }
  return {
    id: value.id,
    matches: {
      role: value.matches.role,
      phase: value.matches.phase as NavigatorPhase,
      kind: "accepted",
      ...(value.matches.statuses === undefined ? {} : { statuses: [...value.matches.statuses] }),
    },
    route: value.route.map((target) => ({ role: target.role as NavigatorTargetRole, phase: target.phase as NavigatorPhase })),
    next: { role: next.role as NavigatorTargetRole, phase: next.phase as NavigatorPhase },
    reason: value.reason,
    command: value.command,
  };
}
function validatePrepareOutput(value: unknown): NavigatorCandidate[] {
  if (!exactRecord(value) || !Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new Error("Navigator must prepare at least one route candidate");
  }
  return value.candidates.map(validateCandidate);
}
function routeEqual(a: readonly NavigatorRouteTarget[] | undefined, b: readonly NavigatorRouteTarget[]): boolean {
  return a !== undefined && a.length === b.length && a.every((target, index) => target.role === b[index]!.role && target.phase === b[index]!.phase);
}
function routeText(route: readonly NavigatorRouteTarget[]): string {
  return route.map((target) => target.phase === null ? target.role : `${target.role} ${target.phase}`).join(" → ");
}
function targetText(target: NavigatorRouteTarget): string {
  return target.phase === null ? target.role : `${target.role} ${target.phase}`;
}
function oneLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]!.trim();
}
function issueRoot(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  const marker = ".ak/work/issues/";
  const index = normalized.indexOf(marker);
  if (index < 0) return undefined;
  const issue = normalized.slice(index + marker.length).split("/")[0]?.split("#")[0];
  return issue === undefined || issue === "" ? undefined : normalized.slice(0, index + marker.length) + issue;
}

function subjectPath(sessionDir: string, cwd = process.cwd()): string {
  return issueRoot(sessionDir) ?? (sessionDir === "" ? resolve(cwd, ".ak", "work") : sessionDir);
}

function subjectDirectory(cwd: string, subjectKey: string): string {
  const issue = issueRoot(subjectKey);
  if (issue !== undefined) {
    const base = join(issue, "runs", "navigator");
    if (subjectKey === issue) return base;
    const digest = createHash("sha256").update(subjectKey).digest("hex").slice(0, 32);
    return join(base, digest);
  }
  const digest = createHash("sha256").update(subjectKey).digest("hex").slice(0, 32);
  return join(resolve(cwd, ".ak", "work", "navigator"), digest);
}

export function navigatorModelSettingPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "navigator-model.json");
}
export async function readNavigatorModelSetting(path = navigatorModelSettingPath()): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!exactRecord(raw) || typeof raw.model !== "string" || raw.model.trim() === "") throw new Error("Navigator model setting is malformed");
    return raw.model;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return NAVIGATOR_DEFAULT_MODEL;
    throw error;
  }
}
export async function writeNavigatorModelSetting(model: string, path = navigatorModelSettingPath()): Promise<void> {
  const normalized = model.trim();
  parseNavigatorModelSetting(normalized);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ model: normalized }) + "\n", "utf8");
}
export function parseNavigatorModelSetting(value: string): { provider: string; model: string; thinkingLevel: "off" | "max" } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error("Navigator model setting must be provider/model[:max]");
  const provider = value.slice(0, slash);
  const modelWithThinking = value.slice(slash + 1);
  const colon = modelWithThinking.lastIndexOf(":");
  const suffix = colon < 0 ? undefined : modelWithThinking.slice(colon + 1);
  if (suffix !== undefined && suffix !== "max") throw new Error("Navigator model setting must use :max or omit the thinking suffix");
  const model = colon < 0 ? modelWithThinking : modelWithThinking.slice(0, colon);
  if (model === "") throw new Error("Navigator model setting must include a model");
  return { provider, model, thinkingLevel: suffix === "max" ? "max" : "off" };
}

export function createNavigatorPrepareTool(onOutput: (value: PrepareOutput) => void): ToolDefinition {
  return {
    name: NAVIGATOR_PREPARE_TOOL_NAME,
    label: "Navigator preparation",
    description: "Submit typed route candidates for the shared Navigator attendance seat.",
    parameters: prepareSchema,
    async execute(_id, value) {
      onOutput(value as PrepareOutput);
      return { content: [{ type: "text" as const, text: "Navigator preparation accepted" }], details: value, terminate: true as const };
    },
  };
}

export function selectNavigatorCandidate(candidates: readonly NavigatorCandidate[], settlement: NavigatorSettlement): NavigatorCandidate | undefined {
  if (settlement.kind !== "accepted") return undefined;
  return candidates.find((candidate) => {
    if (candidate.matches.role !== settlement.role || candidate.matches.phase !== settlement.phase) return false;
    if (candidate.matches.statuses !== undefined && (settlement.status === undefined || !candidate.matches.statuses.includes(settlement.status))) return false;
    return true;
  });
}

export function formatNavigatorReport(report: NavigatorReport): string {
  if (report.disposition === "silence") return "";
  if (report.disposition === "unavailable") return `导航不可用：${oneLine(report.unavailableReason ?? "未能完成导航准备")}`;
  if (report.disposition === "arrival") return oneLine(report.arrivalMessage ?? "已到达目的地");
  return [
    ...(report.route === undefined ? [] : [`路线：${routeText(report.route)}`]),
    `下一步：${targetText(report.next!)}`,
    `理由：${oneLine(report.reason ?? "")}`,
    `命令：${oneLine(report.command ?? "")}`,
  ].join("\n");
}

export function createNavigatorAttendance(options: NavigatorAttendanceOptions) {
  let preparation: Promise<NavigatorCandidate[]> | undefined;
  let sessionReady: Promise<NavigatorPreparationSession> | undefined;
  let session: NavigatorPreparationSession | undefined;
  let subjectKey = options.subjectKey;
  let subject = options.subject;
  let authority = options.authority;
  let contextError = options.contextError;
  let sessionDir = options.sessionDir;
  let candidates: NavigatorCandidate[] | undefined;
  let invocationNumber = 0;
  let activeInvocationId: string | undefined;
  let previousRoute: NavigatorRouteTarget[] | undefined;
  let outputSink: ((value: PrepareOutput) => void) | undefined;
  let disposed = false;

  const unavailable = (invocationId: string, reason: unknown): NavigatorReport => ({
    disposition: "unavailable",
    unavailableReason: reason instanceof Error ? reason.message : String(reason),
  });
  const prepare = async (): Promise<NavigatorCandidate[]> => {
    const invocationId = `${options.context.sessionManager.getSessionId()}:${++invocationNumber}`;
    activeInvocationId = invocationId;
    try {
      if (contextError !== undefined) throw contextError;
      const soul = (await options.loadSoul()).trim();
      if (!soul) throw new Error("Navigator soul is empty");
      const [modelSetting, ...help] = await Promise.all([
        readNavigatorModelSetting(options.modelSettingPath),
        ...NAVIGATOR_TARGETS.map(async ({ role }) => ({ role, help: await options.loadRoleHelp(role) })),
      ]);
      const model = parseNavigatorModelSetting(modelSetting);
      const helpContext = help.map(({ role, help: text }) => `<role_help role="${role}">\n${text}\n</role_help>`).join("\n");
      let output: PrepareOutput | undefined;
      outputSink = (value) => {
        if (output !== undefined) throw new Error("Navigator preparation must submit exactly one typed candidate batch");
        output = value;
      };
      const tool = createNavigatorPrepareTool((value) => { outputSink?.(value); });
      if (session === undefined) {
        sessionReady = (async () => {
          const created = await options.createSession({ context: options.context, sessionDir, tool });
          session = created;
          await created.setModel?.(modelSetting, model.thinkingLevel);
          if (created.getThinkingLevel?.() !== undefined && created.getThinkingLevel() !== model.thinkingLevel) {
            throw new Error(`Navigator thinking level ${model.thinkingLevel} is unavailable for ${modelSetting}`);
          }
          created.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
          return created;
        })();
        await sessionReady;
        sessionReady = undefined;
      } else {
        await session.setModel?.(modelSetting, model.thinkingLevel);
        if (session.getThinkingLevel?.() !== undefined && session.getThinkingLevel() !== model.thinkingLevel) {
          throw new Error(`Navigator thinking level ${model.thinkingLevel} is unavailable for ${modelSetting}`);
        }
        session.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
      }
      const activeSession = session;
      if (activeSession === undefined) throw new Error("Navigator session was not created");
      const prior = activeSession.entries().filter((entry): entry is { type: "custom"; customType: string; data?: unknown } => exactRecord(entry) && entry.type === "custom" && entry.customType === ROUTE_ENTRY && exactRecord(entry.data) && entry.data.subjectKey === subjectKey).at(-1)?.data;
      if (exactRecord(prior) && Array.isArray(prior.route) && prior.route.every((target) => targetIsValid(target))) {
        previousRoute = prior.route.map((target) => ({ role: target.role as NavigatorTargetRole, phase: target.phase as NavigatorPhase }));
      }
      const request = [
        "Act as the Navigator route judge. Prepare distinct typed route candidates; do not execute or invoke any role.",
        `<navigator_soul>\n${soul}\n</navigator_soul>`,
        `<work_subject>\n${subject}\n</work_subject>`,
        `<controlling_authority>\n${authority}\n</controlling_authority>`,
        `<current_role>\n${JSON.stringify({ role: options.role, phase: options.phase })}\n</current_role>`,
        `<prior_route>\n${JSON.stringify(prior ?? null)}\n</prior_route>`,
        `<public_settlement_history>\n${JSON.stringify(activeSession.entries().filter((entry) => exactRecord(entry) && entry.type === "custom" && entry.customType === SETTLEMENT_ENTRY).slice(-8))}\n</public_settlement_history>`,
        `<live_role_help>\n${helpContext}\n</live_role_help>`,
        `Use model setting ${JSON.stringify(modelSetting)} for this call. Return exactly one ${NAVIGATOR_PREPARE_TOOL_NAME} call. The command field is only a short Usage hint; never fill task-specific paths, prompts, packets, or Skill bindings.`,
      ].join("\n\n");
      try {
        await activeSession.prompt(request);
        if (output === undefined) throw new Error("Navigator did not submit typed route candidates");
        candidates = validatePrepareOutput(output);
        return candidates;
      } finally {
        outputSink = undefined;
      }
    } catch (error) {
      throw error;
    }
  };

  return {
    setWorkContext(next: NavigatorWorkContext): void {
      if (next.subjectKey !== subjectKey && session !== undefined) {
        session.dispose();
        session = undefined;
        previousRoute = undefined;
      }
      subjectKey = next.subjectKey;
      subject = next.subject;
      authority = next.authority;
      contextError = next.contextError;
      sessionDir = options.sessionDirectory?.(next.subjectKey) ?? options.sessionDir;
    },
    prepare(): void {
      if (disposed || preparation !== undefined) return;
      preparation = prepare();
      void preparation.catch(() => undefined);
    },
    async settle(settlement: NavigatorSettlement): Promise<void> {
      const invocationId = activeInvocationId ?? `${options.context.sessionManager.getSessionId()}:${invocationNumber || 1}`;
      let report: NavigatorReport;
      if (settlement.kind === "human_decision" || settlement.kind === "role_infrastructure_failure") {
        if (sessionReady !== undefined) await sessionReady.catch(() => undefined);
        session?.appendEntry(SETTLEMENT_ENTRY, { invocationId, subjectKey, role: settlement.role, phase: settlement.phase, kind: settlement.kind, ...(settlement.kind === "human_decision" ? { status: settlement.status } : {}) });
        report = { disposition: "silence" };
      } else if (settlement.kind === "arrival") {
        report = { disposition: "arrival", arrivalMessage: settlement.message ?? "已到达目的地" };
      } else if (preparation === undefined) {
        report = unavailable(invocationId, "Navigator preparation did not start");
      } else {
        if (sessionReady !== undefined) await sessionReady;
        session?.appendEntry(SETTLEMENT_ENTRY, { invocationId, subjectKey, role: settlement.role, phase: settlement.phase, kind: settlement.kind, ...(settlement.status === undefined ? {} : { status: settlement.status }) });
        try {
          const prepared = await preparation;
          const selected = selectNavigatorCandidate(prepared, settlement);
          if (!selected) throw new Error("Navigator prepared no candidate for the typed settlement");
          const routeChanged = !routeEqual(previousRoute, selected.route);
          report = {
            disposition: "recommendation",
            ...(routeChanged ? { route: selected.route } : {}),
            next: selected.next,
            reason: oneLine(selected.reason),
            command: oneLine(selected.command),
          };
          previousRoute = selected.route;
          session?.appendEntry(ROUTE_ENTRY, { invocationId, subjectKey, route: selected.route });
        } catch (error) {
          report = unavailable(invocationId, error);
        }
      }
      const event: NavigatorEvent = {
        version: 1,
        disposition: report.disposition,
        invocationId,
        role: options.role,
        phase: options.phase,
        subjectKey,
        ...(report.route === undefined ? {} : { route: report.route }),
        ...(report.next === undefined ? {} : { next: report.next }),
        ...(report.reason === undefined ? {} : { reason: report.reason }),
        ...(report.command === undefined ? {} : { command: report.command }),
        ...(report.unavailableReason === undefined ? {} : { unavailableReason: report.unavailableReason }),
        ...(report.arrivalMessage === undefined ? {} : { arrivalMessage: report.arrivalMessage }),
      };
      if (report.disposition !== "silence") await options.onEvent(event, report);
      preparation = undefined;
      sessionReady = undefined;
      candidates = undefined;
    },
    dispose(): void {
      disposed = true;
      sessionReady = undefined;
      session?.dispose();
      session = undefined;
      activeInvocationId = undefined;
    },
  };
}

export type NavigatorAttendance = ReturnType<typeof createNavigatorAttendance>;

export function createNativeNavigatorSessionFactory(): NavigatorSessionFactory {
  return async ({ context, sessionDir, tool }) => {
    const configured = await readNavigatorModelSetting();
    const parsed = parseNavigatorModelSetting(configured);
    const model = context.modelRegistry.find(parsed.provider, parsed.model);
    const provider = context.modelRegistry.getProvider(parsed.provider);
    if (model === undefined || provider === undefined) throw new Error(`Navigator model is unavailable: ${configured}`);
    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(provider);
    const created = await createAgentSession({
      cwd: context.cwd,
      model,
      modelRuntime,
      thinkingLevel: parsed.thinkingLevel,
      sessionManager: SessionManager.continueRecent(context.cwd, sessionDir),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      noTools: "all",
      tools: [NAVIGATOR_PREPARE_TOOL_NAME],
      customTools: [tool],
    });
    if (created.session.thinkingLevel !== parsed.thinkingLevel) {
      created.session.dispose();
      throw new Error(`Navigator thinking level ${parsed.thinkingLevel} is unavailable for ${configured}`);
    }
    return {
      prompt: (text) => created.session.prompt(text),
      appendEntry: (customType, data) => { created.session.sessionManager.appendCustomEntry(customType, data); },
      entries: () => created.session.sessionManager.getEntries(),
      setModel: async (next, thinkingLevel) => {
        const nextParsed = parseNavigatorModelSetting(next);
        const nextModel = context.modelRegistry.find(nextParsed.provider, nextParsed.model);
        const nextProvider = context.modelRegistry.getProvider(nextParsed.provider);
        if (nextModel === undefined || nextProvider === undefined) throw new Error(`Navigator model is unavailable: ${next}`);
        const nextAuth = await context.modelRegistry.getApiKeyAndHeaders(nextModel);
        if (!nextAuth.ok) throw new Error(nextAuth.error);
        modelRuntime.registerNativeProvider(nextProvider);
        await created.session.setModel(nextModel);
        created.session.setThinkingLevel(thinkingLevel);
        if (created.session.thinkingLevel !== nextParsed.thinkingLevel || created.session.thinkingLevel !== thinkingLevel) {
          throw new Error(`Navigator thinking level ${thinkingLevel} is unavailable for ${next}`);
        }
      },
      getThinkingLevel: () => created.session.thinkingLevel,
      dispose: () => created.session.dispose(),
    };
  };
}

export function registerNavigatorModelCommand(pi: ExtensionAPI, path = navigatorModelSettingPath()): void {
  pi.registerCommand("navigator-model", {
    description: "Set the persistent Navigator model (provider/model[:max]).",
    handler: async (args) => {
      await writeNavigatorModelSetting(args.trim(), path);
    },
  });
}

export function navigatorSessionDirectory(context: ExtensionContext, subjectKey?: string): string {
  const current = context.sessionManager.getSessionDir();
  const key = subjectKey ?? subjectPath(current, context.cwd);
  return subjectDirectory(context.cwd, key);
}

export { subjectPath };
