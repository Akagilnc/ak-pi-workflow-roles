import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PACKAGED_ROLE_REGISTRY, packagedRoleMetadata } from "./packaged-role-registry.js";
const NAVIGATOR_EVENT_TYPE = "ak-navigator-attendance";
const NAVIGATOR_PREPARE_TOOL_NAME = "ak_navigator_prepare";
const NAVIGATOR_DEFAULT_MODEL = "openai-codex/gpt-5.6-luna:max";
const NAVIGATOR_TARGETS = PACKAGED_ROLE_REGISTRY.map(({ role, phases }) => ({ role, phases }));
class NavigatorUnavailableError extends Error {
  unavailableSource;
  unavailableCause;
  constructor(source, message, cause = source) {
    super(message);
    this.name = "NavigatorUnavailableError";
    this.unavailableSource = source;
    this.unavailableCause = cause;
  }
}
const navigatorProviderFailureSchema = Type.Object({
  source: Type.Union([Type.Literal("context"), Type.Literal("session"), Type.Literal("model"), Type.Literal("thinking"), Type.Literal("auth"), Type.Literal("quota"), Type.Literal("transport"), Type.Literal("unknown")]),
  cause: Type.Union([Type.Literal("context"), Type.Literal("session"), Type.Literal("model"), Type.Literal("thinking"), Type.Literal("auth"), Type.Literal("quota"), Type.Literal("transport"), Type.Literal("unknown")])
}, { additionalProperties: false });
function navigatorProviderFailure(message, source, cause = source) {
  const fact = { source, cause };
  if (!Value.Check(navigatorProviderFailureSchema, fact)) throw new TypeError("Navigator provider failure fact is not typed");
  return Object.assign(message, { navigatorFailure: fact });
}
function navigatorUnavailableError(source, error, cause = source) {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof NavigatorUnavailableError ? error : new NavigatorUnavailableError(source, message, cause);
}
const targetSchema = Type.Object({
  role: Type.String({ minLength: 1 }),
  phase: Type.Union([Type.Null(), Type.Literal("plan"), Type.Literal("apply")])
}, { additionalProperties: false });
const candidateSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  matches: Type.Object({
    role: Type.String({ minLength: 1 }),
    phase: Type.Union([Type.Null(), Type.Literal("plan"), Type.Literal("apply")]),
    kind: Type.Literal("accepted"),
    statuses: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
  }, { additionalProperties: false }),
  route: Type.Array(targetSchema, { minItems: 1 }),
  next: targetSchema,
  reason: Type.String({ minLength: 1 }),
  command: Type.String({ minLength: 1 })
}, { additionalProperties: false });
const prepareSchema = Type.Object({ candidates: Type.Array(candidateSchema, { minItems: 1 }) }, { additionalProperties: false });
const ROUTE_ENTRY = "ak-navigator-route";
const CONTEXT_ENTRY = "ak-navigator-context";
const INVOCATION_ENTRY = "ak-navigator-invocation";
const SETTLEMENT_ENTRY = "ak-navigator-settlement";
const targetRoles = new Set(NAVIGATOR_TARGETS.map(({ role }) => role));
const unavailableKeys = /* @__PURE__ */ new Set(["context", "session", "model", "thinking", "auth", "quota", "transport", "unknown"]);
function unavailableKey(value) {
  return typeof value === "string" && unavailableKeys.has(value) ? value : void 0;
}
function exactRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function targetIsValid(value) {
  if (!exactRecord(value) || !targetRoles.has(String(value.role))) return false;
  const metadata = packagedRoleMetadata(String(value.role));
  return metadata !== void 0 && metadata.phases.includes(value.phase);
}
function validateCandidate(value) {
  const next = exactRecord(value) ? value.next : void 0;
  if (!exactRecord(value) || typeof value.id !== "string" || value.id.trim() === "" || !exactRecord(value.matches) || typeof value.matches.role !== "string" || value.matches.role.trim() === "" || value.matches.phase !== null && value.matches.phase !== "plan" && value.matches.phase !== "apply" || value.matches.kind !== "accepted" || value.matches.statuses !== void 0 && (!Array.isArray(value.matches.statuses) || value.matches.statuses.some((s) => typeof s !== "string" || s.trim() === "")) || !Array.isArray(value.route) || value.route.length === 0 || value.route.some((target) => !targetIsValid(target)) || !targetIsValid(next) || !value.route.some((target) => target.role === next.role && target.phase === next.phase) || typeof value.reason !== "string" || value.reason.trim() === "" || typeof value.command !== "string" || value.command.trim() === "") {
    throw new Error("Navigator preparation output is not a typed route candidate");
  }
  return {
    id: value.id,
    matches: {
      role: value.matches.role,
      phase: value.matches.phase,
      kind: "accepted",
      ...value.matches.statuses === void 0 ? {} : { statuses: [...value.matches.statuses] }
    },
    route: value.route.map((target) => ({ role: target.role, phase: target.phase })),
    next: { role: next.role, phase: next.phase },
    reason: value.reason,
    command: value.command
  };
}
function validatePrepareOutput(value) {
  if (!exactRecord(value) || !Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new Error("Navigator must prepare at least one route candidate");
  }
  return value.candidates.map(validateCandidate);
}
function routeEqual(a, b) {
  return a !== void 0 && a.length === b.length && a.every((target, index) => target.role === b[index].role && target.phase === b[index].phase);
}
function routeText(route) {
  return route.map((target) => target.phase === null ? target.role : `${target.role} ${target.phase}`).join(" \u2192 ");
}
function targetText(target) {
  return target.phase === null ? target.role : `${target.role} ${target.phase}`;
}
function oneLine(value) {
  return value.split(/\r?\n/, 1)[0].trim();
}
function issueRoot(value) {
  const normalized = value.replaceAll("\\", "/");
  const marker = ".ak/work/issues/";
  const index = normalized.indexOf(marker);
  if (index < 0) return void 0;
  const issue = normalized.slice(index + marker.length).split("/")[0]?.split("#")[0];
  return issue === void 0 || issue === "" ? void 0 : normalized.slice(0, index + marker.length) + issue;
}
function subjectPath(sessionDir, cwd = process.cwd()) {
  if (sessionDir === "") {
    const resolvedCwd = resolve(cwd, ".");
    const cwdIssue = issueRoot(resolvedCwd);
    if (cwdIssue !== void 0) return cwdIssue;
    if (resolvedCwd.includes("/.ak/work/")) return resolvedCwd;
  }
  const resolvedSession = resolve(cwd, sessionDir || ".ak/work");
  const issue = issueRoot(resolvedSession);
  if (issue !== void 0) return issue;
  const runsMarker = "/runs/";
  const runsIndex = resolvedSession.indexOf(runsMarker);
  if (runsIndex >= 0) {
    return resolvedSession.slice(0, runsIndex);
  }
  return resolvedSession;
}
function navigatorSubjectKey(subjectRoot, subject) {
  if (issueRoot(subjectRoot) !== void 0 || !subjectRoot.includes("/.ak/work/")) return subjectRoot;
  const normalized = subject.trim().replace(/\s+/g, " ");
  if (normalized === "" || normalized === `work subject: ${subjectRoot}`) return subjectRoot;
  return `${subjectRoot}#${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}
function navigatorSubjectKeyForInput(subjectRoot, reference, cwd = process.cwd()) {
  if (issueRoot(subjectRoot) !== void 0 || !subjectRoot.includes("/.ak/work/")) return subjectRoot;
  const resolvedReference = resolve(cwd, reference);
  const marker = "/runs/";
  if (resolvedReference.includes(marker)) {
    return subjectRoot;
  }
  return navigatorSubjectKey(subjectRoot, resolvedReference);
}
function subjectDirectory(cwd, subjectKey) {
  const issue = issueRoot(subjectKey);
  if (issue !== void 0) {
    const base = join(issue, "runs", "navigator");
    if (subjectKey === issue) return base;
    const digest2 = createHash("sha256").update(subjectKey).digest("hex").slice(0, 32);
    return join(base, digest2);
  }
  const digest = createHash("sha256").update(subjectKey).digest("hex").slice(0, 32);
  return join(resolve(cwd, ".ak", "work", "navigator"), digest);
}
function navigatorModelSettingPath() {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "navigator-model.json");
}
async function readNavigatorModelSetting(path = navigatorModelSettingPath()) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!exactRecord(raw) || typeof raw.model !== "string" || raw.model.trim() === "") throw new Error("Navigator model setting is malformed");
    return raw.model;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return NAVIGATOR_DEFAULT_MODEL;
    throw error;
  }
}
async function writeNavigatorModelSetting(model, path = navigatorModelSettingPath()) {
  const normalized = model.trim();
  parseNavigatorModelSetting(normalized);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ model: normalized }) + "\n", "utf8");
}
function parseNavigatorModelSetting(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error("Navigator model setting must be provider/model[:max]");
  const provider = value.slice(0, slash);
  const modelWithThinking = value.slice(slash + 1);
  const colon = modelWithThinking.lastIndexOf(":");
  const suffix = colon < 0 ? void 0 : modelWithThinking.slice(colon + 1);
  if (suffix !== void 0 && suffix !== "max") throw new Error("Navigator model setting must use :max or omit the thinking suffix");
  const model = colon < 0 ? modelWithThinking : modelWithThinking.slice(0, colon);
  if (model === "") throw new Error("Navigator model setting must include a model");
  return { provider, model, thinkingLevel: suffix === "max" ? "max" : "off" };
}
function createNavigatorPrepareTool(onOutput) {
  return {
    name: NAVIGATOR_PREPARE_TOOL_NAME,
    label: "Navigator preparation",
    description: "Submit typed route candidates for the shared Navigator attendance seat.",
    parameters: prepareSchema,
    async execute(_id, value) {
      onOutput(value);
      return { content: [{ type: "text", text: "Navigator preparation accepted" }], details: value, terminate: true };
    }
  };
}
function selectNavigatorCandidate(candidates, settlement) {
  if (settlement.kind !== "accepted") return void 0;
  return candidates.find((candidate) => {
    if (candidate.matches.role !== settlement.role || candidate.matches.phase !== settlement.phase) return false;
    if (candidate.matches.statuses !== void 0 && (settlement.status === void 0 || !candidate.matches.statuses.includes(settlement.status))) return false;
    return true;
  });
}
function formatNavigatorReport(report) {
  if (report.disposition === "silence") return "";
  if (report.disposition === "unavailable") return `\u5BFC\u822A\u4E0D\u53EF\u7528\uFF1A${oneLine(report.unavailableReason ?? "\u672A\u80FD\u5B8C\u6210\u5BFC\u822A\u51C6\u5907")}`;
  if (report.disposition === "arrival") return oneLine(report.arrivalMessage ?? "\u5DF2\u5230\u8FBE\u76EE\u7684\u5730");
  return [
    ...report.route === void 0 ? [] : [`\u8DEF\u7EBF\uFF1A${routeText(report.route)}`],
    `\u4E0B\u4E00\u6B65\uFF1A${targetText(report.next)}`,
    `\u7406\u7531\uFF1A${oneLine(report.reason ?? "")}`,
    `\u547D\u4EE4\uFF1A${oneLine(report.command ?? "")}`
  ].join("\n");
}
function createNavigatorAttendance(options) {
  let preparation;
  let sessionReady;
  let session;
  let subjectKey = options.subjectKey;
  let subject = options.subject;
  let authority = options.authority;
  let contextError = options.contextError;
  let sessionDir = options.sessionDir;
  let candidates;
  let invocationNumber = 0;
  let activeInvocationId;
  let previousRoute;
  let outputSink;
  let settlementTail = Promise.resolve();
  let disposed = false;
  const unavailable = (invocationId, reason) => {
    const failure = reason instanceof NavigatorUnavailableError ? reason : navigatorUnavailableError("unknown", reason);
    return {
      disposition: "unavailable",
      unavailableReason: failure.message,
      unavailableSource: failure.unavailableSource,
      unavailableCause: failure.unavailableCause
    };
  };
  const prepare = async () => {
    const invocationId = `${options.context.sessionManager.getSessionId()}:${++invocationNumber}`;
    activeInvocationId = invocationId;
    try {
      if (contextError !== void 0) throw navigatorUnavailableError("context", contextError);
      let soul;
      try {
        soul = (await options.loadSoul()).trim();
        if (!soul) throw new Error("Navigator soul is empty");
      } catch (error) {
        throw navigatorUnavailableError("context", error);
      }
      let modelSetting;
      try {
        modelSetting = await readNavigatorModelSetting(options.modelSettingPath);
      } catch (error) {
        throw navigatorUnavailableError("model", error);
      }
      let help;
      try {
        help = await Promise.all(NAVIGATOR_TARGETS.map(async ({ role }) => ({ role, help: await options.loadRoleHelp(role) })));
      } catch (error) {
        throw navigatorUnavailableError("transport", error);
      }
      let model;
      try {
        model = parseNavigatorModelSetting(modelSetting);
      } catch (error) {
        throw navigatorUnavailableError("model", error);
      }
      const helpContext = help.map(({ role, help: text }) => `<role_help role="${role}">
${text}
</role_help>`).join("\n");
      let output;
      outputSink = (value) => {
        if (output !== void 0) throw new Error("Navigator preparation must submit exactly one typed candidate batch");
        output = value;
      };
      const tool = createNavigatorPrepareTool((value) => {
        outputSink?.(value);
      });
      if (session === void 0) {
        sessionReady = (async () => {
          let created;
          try {
            created = await options.createSession({ context: options.context, sessionDir, ...options.modelSettingPath === void 0 ? {} : { modelSettingPath: options.modelSettingPath }, tool });
          } catch (error) {
            throw navigatorUnavailableError("session", error);
          }
          try {
            await created.setModel?.(modelSetting, model.thinkingLevel);
            if (created.getThinkingLevel?.() !== void 0 && created.getThinkingLevel() !== model.thinkingLevel) {
              throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${model.thinkingLevel} is unavailable for ${modelSetting}`);
            }
            created.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
            session = created;
            return created;
          } catch (error) {
            created.dispose();
            throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("session", error);
          }
        })();
        await sessionReady;
        sessionReady = void 0;
      } else {
        await session.setModel?.(modelSetting, model.thinkingLevel);
        if (session.getThinkingLevel?.() !== void 0 && session.getThinkingLevel() !== model.thinkingLevel) {
          throw new Error(`Navigator thinking level ${model.thinkingLevel} is unavailable for ${modelSetting}`);
        }
        session.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
      }
      const activeSession = session;
      if (activeSession === void 0) throw new Error("Navigator session was not created");
      const prior = activeSession.entries().filter((entry) => exactRecord(entry) && entry.type === "custom" && entry.customType === ROUTE_ENTRY && exactRecord(entry.data) && entry.data.subjectKey === subjectKey).at(-1)?.data;
      if (exactRecord(prior) && Array.isArray(prior.route) && prior.route.every((target) => targetIsValid(target))) {
        previousRoute = prior.route.map((target) => ({ role: target.role, phase: target.phase }));
      }
      const publicSettlementHistory = activeSession.entries().filter((entry) => exactRecord(entry) && entry.type === "custom" && entry.customType === SETTLEMENT_ENTRY && exactRecord(entry.data)).slice(-8).map((entry) => entry.data);
      const projection = {
        subjectKey,
        subject,
        authority,
        currentRole: { role: options.role, phase: options.phase },
        priorRoute: exactRecord(prior) && Array.isArray(prior.route) && prior.route.every((target) => targetIsValid(target)) ? prior.route.map((target) => ({ role: target.role, phase: target.phase })) : null,
        publicSettlementHistory,
        liveRoleHelp: help
      };
      activeSession.appendEntry(CONTEXT_ENTRY, projection);
      const request = [
        "Act as the Navigator route judge. Prepare distinct typed route candidates; do not execute or invoke any role.",
        `<navigator_soul>
${soul}
</navigator_soul>`,
        `<work_subject>
${subject}
</work_subject>`,
        `<controlling_authority>
${authority}
</controlling_authority>`,
        `<current_role>
${JSON.stringify({ role: options.role, phase: options.phase })}
</current_role>`,
        `<prior_route>
${JSON.stringify(prior ?? null)}
</prior_route>`,
        `<public_settlement_history>
${JSON.stringify(projection.publicSettlementHistory)}
</public_settlement_history>`,
        `<live_role_help>
${helpContext}
</live_role_help>`,
        `Use model setting ${JSON.stringify(modelSetting)} for this call. Return exactly one ${NAVIGATOR_PREPARE_TOOL_NAME} call. The command field is only a short Usage hint; never fill task-specific paths, prompts, packets, or Skill bindings.`
      ].join("\n\n");
      try {
        try {
          await activeSession.prompt(request, projection);
        } catch (error) {
          throw navigatorUnavailableError("transport", error);
        }
        if (output === void 0) {
          const nativeFailure = [...activeSession.entries()].reverse().find((entry) => {
            if (!exactRecord(entry) || entry.type !== "message" || !exactRecord(entry.message)) return false;
            return entry.message.role === "assistant" && typeof entry.message.errorMessage === "string" && entry.message.errorMessage.trim() !== "";
          });
          const nativeMessage = exactRecord(nativeFailure) && exactRecord(nativeFailure.message) ? nativeFailure.message : void 0;
          const errorMessage = nativeMessage !== void 0 && typeof nativeMessage.errorMessage === "string" ? nativeMessage.errorMessage : "Navigator did not submit typed route candidates";
          const providerFailure = exactRecord(nativeMessage?.navigatorFailure) ? nativeMessage.navigatorFailure : void 0;
          const source = unavailableKey(providerFailure?.source) ?? "unknown";
          const cause = unavailableKey(providerFailure?.cause) ?? source;
          throw navigatorUnavailableError(source, errorMessage, cause);
        }
        candidates = validatePrepareOutput(output);
        return candidates;
      } finally {
        outputSink = void 0;
      }
    } catch (error) {
      throw error;
    }
  };
  return {
    setWorkContext(next) {
      if (next.subjectKey !== subjectKey && session !== void 0) {
        session.dispose();
        session = void 0;
        previousRoute = void 0;
      }
      subjectKey = next.subjectKey;
      subject = next.subject;
      authority = next.authority;
      contextError = next.contextError;
      sessionDir = options.sessionDirectory?.(next.subjectKey) ?? options.sessionDir;
    },
    prepare() {
      if (disposed || preparation !== void 0) return;
      preparation = prepare();
      void preparation.catch(() => void 0);
    },
    isPreparing() {
      return preparation !== void 0 || sessionReady !== void 0;
    },
    settle(settlement) {
      const next = settlementTail.then(() => settleOnce(settlement));
      settlementTail = next.catch(() => void 0);
      return next;
    },
    dispose() {
      disposed = true;
      sessionReady = void 0;
      session?.dispose();
      session = void 0;
      activeInvocationId = void 0;
    }
  };
  async function settleOnce(settlement) {
    const invocationId = activeInvocationId ?? `${options.context.sessionManager.getSessionId()}:${invocationNumber || 1}`;
    let report;
    if (settlement.kind === "human_decision" || settlement.kind === "role_infrastructure_failure") {
      if (sessionReady !== void 0) await sessionReady.catch(() => void 0);
      if (preparation !== void 0) await preparation.catch(() => void 0);
      session?.appendEntry(SETTLEMENT_ENTRY, { invocationId, subjectKey, role: settlement.role, phase: settlement.phase, kind: settlement.kind, ...settlement.kind === "human_decision" ? { status: settlement.status } : {} });
      report = { disposition: "silence" };
    } else if (settlement.kind === "arrival") {
      if (sessionReady !== void 0) await sessionReady.catch(() => void 0);
      if (preparation !== void 0) await preparation.catch(() => void 0);
      report = { disposition: "arrival", arrivalMessage: settlement.message ?? "\u5DF2\u5230\u8FBE\u76EE\u7684\u5730" };
    } else if (preparation === void 0) {
      report = unavailable(invocationId, "Navigator preparation did not start");
    } else {
      try {
        if (sessionReady !== void 0) await sessionReady;
        const prepared = await preparation;
        session?.appendEntry(SETTLEMENT_ENTRY, { invocationId, subjectKey, role: settlement.role, phase: settlement.phase, kind: settlement.kind, ...settlement.status === void 0 ? {} : { status: settlement.status } });
        const selected = selectNavigatorCandidate(prepared, settlement);
        if (!selected) throw new Error("Navigator prepared no candidate for the typed settlement");
        const routeChanged = !routeEqual(previousRoute, selected.route);
        report = {
          disposition: "recommendation",
          ...routeChanged ? { route: selected.route } : {},
          next: selected.next,
          reason: oneLine(selected.reason),
          command: oneLine(selected.command)
        };
        previousRoute = selected.route;
        session?.appendEntry(ROUTE_ENTRY, { invocationId, subjectKey, route: selected.route });
      } catch (error) {
        report = unavailable(invocationId, error);
      }
    }
    const event = {
      version: 1,
      disposition: report.disposition,
      invocationId,
      role: options.role,
      phase: options.phase,
      subjectKey,
      ...report.route === void 0 ? {} : { route: report.route },
      ...report.next === void 0 ? {} : { next: report.next },
      ...report.reason === void 0 ? {} : { reason: report.reason },
      ...report.command === void 0 ? {} : { command: report.command },
      ...report.unavailableReason === void 0 ? {} : { unavailableReason: report.unavailableReason },
      ...report.unavailableSource === void 0 ? {} : { unavailableSource: report.unavailableSource },
      ...report.unavailableCause === void 0 ? {} : { unavailableCause: report.unavailableCause },
      ...report.arrivalMessage === void 0 ? {} : { arrivalMessage: report.arrivalMessage }
    };
    if (report.disposition !== "silence") await options.onEvent(event, report);
    preparation = void 0;
    sessionReady = void 0;
    candidates = void 0;
  }
}
function createNativeNavigatorSessionFactory(defaultModelSettingPath = navigatorModelSettingPath()) {
  return async ({ context, sessionDir, modelSettingPath, tool }) => {
    let configured;
    try {
      configured = await readNavigatorModelSetting(modelSettingPath ?? defaultModelSettingPath);
    } catch (error) {
      throw navigatorUnavailableError("model", error);
    }
    let parsed;
    try {
      parsed = parseNavigatorModelSetting(configured);
    } catch (error) {
      throw navigatorUnavailableError("model", error);
    }
    const model = context.modelRegistry.find(parsed.provider, parsed.model);
    const provider = context.modelRegistry.getProvider(parsed.provider);
    if (model === void 0 || provider === void 0) throw new NavigatorUnavailableError("model", `Navigator model is unavailable: ${configured}`);
    let auth;
    try {
      auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    } catch (error) {
      throw navigatorUnavailableError("auth", error);
    }
    if (!auth.ok) throw new NavigatorUnavailableError("auth", auth.error);
    try {
      const sessionInfo = await stat(sessionDir);
      if (!sessionInfo.isDirectory()) throw new NavigatorUnavailableError("session", `Navigator session path is not a directory: ${sessionDir}`);
    } catch (error) {
      if (error instanceof NavigatorUnavailableError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw navigatorUnavailableError("session", error);
      }
    }
    let modelRuntime;
    try {
      modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
      modelRuntime.registerNativeProvider(provider);
    } catch (error) {
      throw navigatorUnavailableError("session", error);
    }
    let created;
    try {
      created = await createAgentSession({
        cwd: context.cwd,
        model,
        modelRuntime,
        thinkingLevel: parsed.thinkingLevel,
        sessionManager: SessionManager.continueRecent(context.cwd, sessionDir),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        noTools: "all",
        tools: [NAVIGATOR_PREPARE_TOOL_NAME],
        customTools: [tool]
      });
    } catch (error) {
      throw navigatorUnavailableError("session", error);
    }
    if (created.session.thinkingLevel !== parsed.thinkingLevel) {
      created.session.dispose();
      throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${parsed.thinkingLevel} is unavailable for ${configured}`);
    }
    return {
      prompt: async (text) => {
        try {
          await created.session.prompt(text);
        } catch (error) {
          throw navigatorUnavailableError("transport", error);
        }
      },
      appendEntry: (customType, data) => {
        created.session.sessionManager.appendCustomEntry(customType, data);
      },
      entries: () => created.session.sessionManager.getEntries(),
      setModel: async (next, thinkingLevel) => {
        let nextParsed;
        try {
          nextParsed = parseNavigatorModelSetting(next);
        } catch (error) {
          throw navigatorUnavailableError("model", error);
        }
        const nextModel = context.modelRegistry.find(nextParsed.provider, nextParsed.model);
        const nextProvider = context.modelRegistry.getProvider(nextParsed.provider);
        if (nextModel === void 0 || nextProvider === void 0) throw new NavigatorUnavailableError("model", `Navigator model is unavailable: ${next}`);
        let nextAuth;
        try {
          nextAuth = await context.modelRegistry.getApiKeyAndHeaders(nextModel);
        } catch (error) {
          throw navigatorUnavailableError("auth", error);
        }
        if (!nextAuth.ok) throw new NavigatorUnavailableError("auth", nextAuth.error);
        try {
          modelRuntime.registerNativeProvider(nextProvider);
          await created.session.setModel(nextModel);
          created.session.setThinkingLevel(thinkingLevel);
        } catch (error) {
          throw navigatorUnavailableError("session", error);
        }
        if (created.session.thinkingLevel !== nextParsed.thinkingLevel || created.session.thinkingLevel !== thinkingLevel) {
          throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${thinkingLevel} is unavailable for ${next}`);
        }
      },
      getThinkingLevel: () => created.session.thinkingLevel,
      dispose: () => created.session.dispose()
    };
  };
}
function registerNavigatorModelCommand(pi, path = navigatorModelSettingPath()) {
  pi.registerCommand("navigator-model", {
    description: "Set the persistent Navigator model (provider/model[:max]).",
    handler: async (args) => {
      await writeNavigatorModelSetting(args.trim(), path);
    }
  });
}
function navigatorSessionDirectory(context, subjectKey) {
  const current = context.sessionManager.getSessionDir();
  const key = subjectKey ?? subjectPath(current, context.cwd);
  return subjectDirectory(context.cwd, key);
}
export {
  NAVIGATOR_DEFAULT_MODEL,
  NAVIGATOR_EVENT_TYPE,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NAVIGATOR_TARGETS,
  NavigatorUnavailableError,
  createNativeNavigatorSessionFactory,
  createNavigatorAttendance,
  createNavigatorPrepareTool,
  formatNavigatorReport,
  navigatorModelSettingPath,
  navigatorProviderFailure,
  navigatorSessionDirectory,
  navigatorSubjectKey,
  navigatorSubjectKeyForInput,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  registerNavigatorModelCommand,
  selectNavigatorCandidate,
  subjectPath,
  writeNavigatorModelSetting
};
