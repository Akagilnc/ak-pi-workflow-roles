import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { auditorRunDirectory } from "./auditor-dossier-tool.js";
import {
  InstitutionalResolutionError,
  readInstitutionalSeatSelection
} from "./institutional-resolution.js";
const NAVIGATOR_PREPARE_TOOL_NAME = "ak_navigator_prepare";
const NAVIGATOR_DEFAULT_MODEL = "openai-codex/gpt-5.6-luna:max";
const NAVIGATOR_UNAVAILABLE_KEYS = /* @__PURE__ */ new Set([
  "context",
  "session",
  "model",
  "thinking",
  "auth",
  "quota",
  "transport",
  "unknown"
]);
function navigatorUnavailableKey(value) {
  return typeof value === "string" && NAVIGATOR_UNAVAILABLE_KEYS.has(value) ? value : void 0;
}
class NavigatorUnavailableError extends Error {
  unavailableSource;
  unavailableCause;
  originalCause;
  constructor(source, message, cause = source, originalCause) {
    super(message);
    this.name = "NavigatorUnavailableError";
    this.unavailableSource = source;
    this.unavailableCause = cause;
    this.originalCause = originalCause;
  }
}
function navigatorUnavailableError(source, error, cause = source) {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof NavigatorUnavailableError ? error : new NavigatorUnavailableError(source, message, cause, error);
}
function exactRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function navigatorProviderFailureFromStatus(status) {
  if (status === 401 || status === 403) return { source: "auth", cause: "auth" };
  if (status === 429) return { source: "quota", cause: "quota" };
  return void 0;
}
function navigatorProviderFailureFromCode(code) {
  if (typeof code === "number") return navigatorProviderFailureFromStatus(code);
  if (typeof code !== "string") return void 0;
  if (code === "unauthorized" || code === "authentication_failed") return { source: "auth", cause: "auth" };
  if (code === "insufficient_quota" || code === "quota_exhausted") return { source: "quota", cause: "quota" };
  if (code === "transport_error") return { source: "transport", cause: "transport" };
  return void 0;
}
function navigatorProviderFailureFromError(error) {
  let cursor = error;
  const seen = /* @__PURE__ */ new Set();
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor instanceof NavigatorUnavailableError) {
      return { source: cursor.unavailableSource, cause: cursor.unavailableCause };
    }
    if (!exactRecord(cursor)) {
      cursor = cursor instanceof Error ? cursor.cause : void 0;
      continue;
    }
    const fromReason = navigatorUnavailableKey(cursor.reason);
    if (fromReason !== void 0) return { source: fromReason, cause: fromReason };
    const statusCode = typeof cursor.statusCode === "number" ? cursor.statusCode : typeof cursor.status === "number" ? cursor.status : typeof cursor.httpStatus === "number" ? cursor.httpStatus : void 0;
    const fromStatus = navigatorProviderFailureFromStatus(statusCode);
    if (fromStatus !== void 0) return fromStatus;
    const fromCode = navigatorProviderFailureFromCode(cursor.code);
    if (fromCode !== void 0) return fromCode;
    cursor = cursor.cause;
  }
  return void 0;
}
function navigatorProviderFailureFromDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return void 0;
  for (const diagnostic of diagnostics) {
    if (!exactRecord(diagnostic)) continue;
    if (diagnostic.type === "provider_transport_failure") return { source: "transport", cause: "transport" };
    if (exactRecord(diagnostic.error)) {
      const fromCode = navigatorProviderFailureFromCode(diagnostic.error.code);
      if (fromCode !== void 0) return fromCode;
    }
    if (exactRecord(diagnostic.details)) {
      const status = typeof diagnostic.details.status === "number" ? diagnostic.details.status : typeof diagnostic.details.statusCode === "number" ? diagnostic.details.statusCode : void 0;
      const fromStatus = navigatorProviderFailureFromStatus(status);
      if (fromStatus !== void 0) return fromStatus;
      const fromCode = navigatorProviderFailureFromCode(diagnostic.details.code);
      if (fromCode !== void 0) return fromCode;
    }
  }
  return void 0;
}
const navigatorProviderFailureSchema = Type.Object({
  source: Type.Union([
    Type.Literal("context"),
    Type.Literal("session"),
    Type.Literal("model"),
    Type.Literal("thinking"),
    Type.Literal("auth"),
    Type.Literal("quota"),
    Type.Literal("transport"),
    Type.Literal("unknown")
  ]),
  cause: Type.Union([
    Type.Literal("context"),
    Type.Literal("session"),
    Type.Literal("model"),
    Type.Literal("thinking"),
    Type.Literal("auth"),
    Type.Literal("quota"),
    Type.Literal("transport"),
    Type.Literal("unknown")
  ])
}, { additionalProperties: false });
function navigatorProviderFailure(message, source, cause = source) {
  const fact = { source, cause };
  if (!Value.Check(navigatorProviderFailureSchema, fact)) throw new TypeError("Navigator provider failure fact is not typed");
  return Object.assign(message, { navigatorFailure: fact });
}
function navigatorModelSettingPath() {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "navigator-model.json");
}
async function readNavigatorModelSetting(path = navigatorModelSettingPath()) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!exactRecord(raw) || typeof raw.model !== "string" || raw.model.trim() === "") {
      throw new Error("Navigator model setting is malformed");
    }
    return raw.model;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return NAVIGATOR_DEFAULT_MODEL;
    }
    throw error;
  }
}
async function writeNavigatorModelSetting(model, path = navigatorModelSettingPath()) {
  const normalized = model.trim();
  parseNavigatorModelSetting(normalized);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ model: normalized })}
`, "utf8");
}
function parseNavigatorModelSetting(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error("Navigator model setting must be provider/model[:max]");
  }
  const provider = value.slice(0, slash);
  const modelWithThinking = value.slice(slash + 1);
  const colon = modelWithThinking.lastIndexOf(":");
  const suffix = colon < 0 ? void 0 : modelWithThinking.slice(colon + 1);
  if (suffix !== void 0 && suffix !== "max") {
    throw new Error("Navigator model setting must use :max or omit the thinking suffix");
  }
  const model = colon < 0 ? modelWithThinking : modelWithThinking.slice(0, colon);
  if (model === "") throw new Error("Navigator model setting must include a model");
  return { provider, model, thinkingLevel: suffix === "max" ? "max" : "off" };
}
async function resolveNavigatorSeatSelection(context, modelSettingPath, defaultModelSettingPath) {
  const runDirectory = auditorRunDirectory(context);
  if (runDirectory !== void 0) {
    try {
      const selection = await readInstitutionalSeatSelection(runDirectory, "navigator");
      const thinkingLevel = selection.thinking === "max" ? "max" : "off";
      return {
        selection: {
          provider: selection.provider,
          model: selection.model,
          ...selection.thinking === void 0 ? {} : { thinking: selection.thinking }
        },
        configuredLabel: `${selection.provider}/${selection.model}${thinkingLevel === "max" ? ":max" : ""}`,
        thinkingLevel
      };
    } catch (error) {
      if (error instanceof InstitutionalResolutionError && (error.reason === "missing-page" || error.reason === "missing-seat")) {
      } else {
        throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("model", error);
      }
    }
  }
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
  return {
    selection: {
      provider: parsed.provider,
      model: parsed.model,
      thinking: parsed.thinkingLevel
    },
    configuredLabel: configured,
    thinkingLevel: parsed.thinkingLevel
  };
}
export {
  NAVIGATOR_DEFAULT_MODEL,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  navigatorModelSettingPath,
  navigatorProviderFailure,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
  navigatorProviderFailureFromStatus,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  resolveNavigatorSeatSelection,
  writeNavigatorModelSetting
};
