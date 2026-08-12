#!/usr/bin/env node

var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/package-contracts/collector-output.ts
function safeGet(value, key) {
  if (typeof value !== "object" && typeof value !== "function" || value === null) return void 0;
  try {
    return value[key];
  } catch {
    return void 0;
  }
}
function records(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && typeof item === "object") : [];
}
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function validateAcceptedCollectorReceipt(value) {
  const rawGroups = safeGet(value, "groups");
  if (!Array.isArray(rawGroups)) throw new Error("Collector receipt has no typed groups terminal discriminator");
  const groups = records(rawGroups).map((group) => ({
    identity: safeGet(group, "identity") ?? null,
    ...typeof safeGet(group, "displayLogin") === "string" ? { displayLogin: safeGet(group, "displayLogin") } : {},
    attendance: true,
    materials: records(safeGet(group, "materials")),
    findings: records(safeGet(group, "findings"))
  }));
  return {
    host: safeGet(value, "host"),
    repository: safeGet(value, "repository"),
    prNumber: safeGet(value, "prNumber"),
    manifestDigest: safeGet(value, "manifestDigest"),
    activationTime: safeGet(value, "activationTime"),
    deadlineTime: safeGet(value, "deadlineTime"),
    finalObservationTime: safeGet(value, "finalObservationTime"),
    finalSnapshotId: safeGet(value, "finalSnapshotId"),
    targetHead: safeGet(value, "targetHead"),
    groups,
    requestAttempts: records(safeGet(value, "requestAttempts")),
    snapshots: records(safeGet(value, "snapshots")).map((snapshot) => ({
      snapshotId: safeGet(snapshot, "snapshotId"),
      observedAt: safeGet(snapshot, "observedAt"),
      completedAt: safeGet(snapshot, "completedAt"),
      completedMono: safeGet(snapshot, "completedMono"),
      host: safeGet(snapshot, "host"),
      repository: safeGet(snapshot, "repository"),
      prNumber: safeGet(snapshot, "prNumber"),
      prState: safeGet(snapshot, "prState"),
      headOid: safeGet(snapshot, "headOid"),
      complete: safeGet(snapshot, "complete"),
      evidenceIds: strings(safeGet(snapshot, "evidenceIds")),
      pageDiagnostics: records(safeGet(snapshot, "pageDiagnostics")),
      normalizedByteLength: safeGet(snapshot, "normalizedByteLength")
    })),
    evidenceRecords: records(safeGet(value, "evidenceRecords")).map((record4) => ({ evidenceId: safeGet(record4, "evidenceId"), kind: safeGet(record4, "kind"), versionId: safeGet(record4, "versionId"), contentDigest: safeGet(record4, "contentDigest"), firstObservedAt: safeGet(record4, "firstObservedAt"), raw: safeGet(record4, "raw") }))
  };
}
var COLLECTOR_OUTPUT_TOOL;
var init_collector_output = __esm({
  "src/package-contracts/collector-output.ts"() {
    "use strict";
    COLLECTOR_OUTPUT_TOOL = "ak_collector_output";
  }
});

// src/package-contracts/judge-output.ts
function validateAcceptedJudgeDetails(verdict) {
  if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) throw new Error("Judge verdict has no execution discriminator");
  let judgeStatus;
  try {
    judgeStatus = verdict.judgeStatus;
  } catch {
    throw new Error("Judge verdict has no execution discriminator");
  }
  if (["converged", "continue", "escalate"].includes(String(judgeStatus))) return verdict;
  throw new Error("Judge verdict has no execution discriminator");
}
var JUDGE_OUTPUT_TOOL_NAME;
var init_judge_output = __esm({
  "src/package-contracts/judge-output.ts"() {
    "use strict";
    JUDGE_OUTPUT_TOOL_NAME = "ak_judge_output";
  }
});

// src/package-contracts/reviewer-output.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function read(value, key) {
  if (!isRecord(value)) return void 0;
  try {
    return value[key];
  } catch {
    return void 0;
  }
}
function validateRuntimeReviewerReceipt(output) {
  const acceptedBatch = read(output, "acceptedBatch");
  const identities = read(output, "identities");
  const construction = read(identities, "construction");
  const target = read(identities, "target");
  const reports = read(output, "reports");
  const outcomes = read(output, "outcomes");
  const legs = read(acceptedBatch, "legs");
  if (acceptedBatch !== void 0 || construction !== void 0 || target !== void 0) {
    if (!isRecord(acceptedBatch) || !isRecord(construction) || !isRecord(target) || !Array.isArray(legs))
      throw new Error("Incomplete Reviewer accepted-batch identity");
    const objectFormat = read(target, "objectFormat");
    const objectId = (value) => typeof value === "string" && new RegExp(objectFormat === "sha1" ? "^[0-9a-f]{40}$" : "^[0-9a-f]{64}$").test(value);
    const refs = read(target, "refs");
    const skillText = read(read(identities, "canonicalSkill"), "text");
    if (typeof skillText !== "string" || read(construction, "recipe") !== "reviewer-common-bundle-v1" || objectFormat !== "sha1" && objectFormat !== "sha256" || !objectId(read(target, "targetHead")) || !isRecord(refs) || Object.values(refs).some((ref) => !isRecord(ref) || !objectId(read(ref, "objectId")) || read(ref, "peeledCommitId") !== null && !objectId(read(ref, "peeledCommitId"))))
      throw new Error("Invalid Reviewer construction or target identity");
    const expectedAxes = legs.map((leg) => read(leg, "axis"));
    if (expectedAxes[0] !== "standards" || expectedAxes.length === 2 && expectedAxes[1] !== "spec" || expectedAxes.length < 1 || expectedAxes.length > 2)
      throw new Error("Invalid Reviewer accepted-leg projection");
    if (!isRecord(outcomes) || !isRecord(reports)) throw new Error("Accepted Reviewer batch lacks outcomes or reports");
    const outcomeAxes = Object.keys(outcomes).filter((axis) => axis === "standards" || axis === "spec");
    if (outcomeAxes.length !== expectedAxes.length || outcomeAxes.some((axis, index) => axis !== expectedAxes[index]))
      throw new Error("Reviewer outcomes must exactly cover accepted legs in canonical order");
    for (const [index, axisValue] of expectedAxes.entries()) {
      const axis = axisValue;
      const outcome = read(outcomes, axis);
      if (!isRecord(outcome)) throw new Error("Reviewer accepted leg lacks outcome");
      const expectedPrompt = read(read(legs[index], "prompt"), "text");
      const actualPrompt = read(read(outcome, "prompt"), "text");
      if (expectedPrompt !== actualPrompt) throw new Error("Reviewer outcome prompt disagrees with accepted leg");
      const status = read(outcome, "status");
      const report = read(reports, axis);
      if (status === "successful" && report === void 0)
        throw new Error("Successful Reviewer outcome lacks report");
      if (status === "failed" && report !== void 0) throw new Error("Failed Reviewer outcome cannot bind a report");
    }
  }
  return output;
}
var REVIEWER_OUTPUT_TOOL_NAME;
var init_reviewer_output = __esm({
  "src/package-contracts/reviewer-output.ts"() {
    "use strict";
    REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/metrics.mjs
var Metrics;
var init_metrics = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/metrics.mjs"() {
    Metrics = {
      assign: 0,
      create: 0,
      clone: 0,
      discard: 0,
      update: 0
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/assign.mjs
function Assign(left, right) {
  Metrics.assign += 1;
  return { ...left, ...right };
}
var init_assign = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/assign.mjs"() {
    init_metrics();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/string.mjs
function IsBetween(value, min, max) {
  return value >= min && value <= max;
}
function IsZeroWidthJoiner(value) {
  return value === 8205;
}
function IsHighSurrogate(value) {
  return IsBetween(value, 55296, 56319);
}
function IsRegionalIndicator(value) {
  return IsBetween(value, 127462, 127487);
}
function IsVariationSelector(value) {
  return IsBetween(value, 65024, 65039);
}
function IsCombiningMark(value) {
  return IsBetween(value, 768, 879) || IsBetween(value, 6832, 6911) || IsBetween(value, 7616, 7679) || IsBetween(value, 65056, 65071);
}
function CodePointLength(value) {
  return value > 65535 ? 2 : 1;
}
function ConsumeModifiers(value, index) {
  while (index < value.length) {
    const point = value.codePointAt(index);
    if (IsCombiningMark(point) || IsVariationSelector(point)) {
      index += CodePointLength(point);
    } else {
      break;
    }
  }
  return index;
}
function NextGraphemeClusterIndex(value, clusterStart) {
  const startCP = value.codePointAt(clusterStart);
  let clusterEnd = clusterStart + CodePointLength(startCP);
  clusterEnd = ConsumeModifiers(value, clusterEnd);
  while (clusterEnd < value.length - 1 && value[clusterEnd] === "\u200D") {
    const nextCP = value.codePointAt(clusterEnd + 1);
    clusterEnd += 1 + CodePointLength(nextCP);
    clusterEnd = ConsumeModifiers(value, clusterEnd);
  }
  if (IsRegionalIndicator(startCP) && clusterEnd < value.length && IsRegionalIndicator(value.codePointAt(clusterEnd))) {
    clusterEnd += CodePointLength(value.codePointAt(clusterEnd));
  }
  return clusterEnd;
}
function IsGraphemeCodePoint(value) {
  return IsHighSurrogate(value) || IsCombiningMark(value) || IsVariationSelector(value) || IsZeroWidthJoiner(value);
}
function GraphemeCount(value) {
  let count2 = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count2++;
  }
  return count2;
}
function IsMinLength(value, minLength) {
  if (minLength === 0)
    return true;
  let count2 = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count2++;
    if (count2 >= minLength)
      return true;
  }
  return false;
}
function IsMaxLength(value, maxLength) {
  let count2 = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count2++;
    if (count2 > maxLength)
      return false;
  }
  return true;
}
function IsMinLengthFast(value, minLength) {
  if (minLength === 0)
    return true;
  let index = 0;
  while (index < value.length) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMinLength(value, minLength);
    }
    index++;
    if (index >= minLength)
      return true;
  }
  return false;
}
function IsMaxLengthFast(value, maxLength) {
  let index = 0;
  while (index < value.length) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMaxLength(value, maxLength);
    }
    index++;
    if (index > maxLength)
      return false;
  }
  return true;
}
var init_string = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/string.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/guard.mjs
var guard_exports = {};
__export(guard_exports, {
  Counted: () => Counted,
  Entries: () => Entries,
  EntriesRegExp: () => EntriesRegExp,
  Every: () => Every,
  EveryAll: () => EveryAll,
  GraphemeCount: () => GraphemeCount2,
  HasPropertyKey: () => HasPropertyKey,
  IsArray: () => IsArray,
  IsBigInt: () => IsBigInt,
  IsBoolean: () => IsBoolean,
  IsClassInstance: () => IsClassInstance,
  IsConstructor: () => IsConstructor,
  IsDeepEqual: () => IsDeepEqual,
  IsEqual: () => IsEqual,
  IsFunction: () => IsFunction,
  IsGreaterEqualThan: () => IsGreaterEqualThan,
  IsGreaterThan: () => IsGreaterThan,
  IsInteger: () => IsInteger,
  IsLessEqualThan: () => IsLessEqualThan,
  IsLessThan: () => IsLessThan,
  IsMaxLength: () => IsMaxLength2,
  IsMinLength: () => IsMinLength2,
  IsMultipleOf: () => IsMultipleOf,
  IsNull: () => IsNull,
  IsNumber: () => IsNumber,
  IsObject: () => IsObject,
  IsObjectNotArray: () => IsObjectNotArray,
  IsString: () => IsString,
  IsSymbol: () => IsSymbol,
  IsUndefined: () => IsUndefined,
  IsUnsafePropertyKey: () => IsUnsafePropertyKey,
  IsValueLike: () => IsValueLike,
  Keys: () => Keys,
  ShiftLeft: () => ShiftLeft,
  Some: () => Some,
  SomeAll: () => SomeAll,
  Symbols: () => Symbols,
  Values: () => Values
});
function IsArray(value) {
  return Array.isArray(value);
}
function IsBigInt(value) {
  return IsEqual(typeof value, "bigint");
}
function IsBoolean(value) {
  return IsEqual(typeof value, "boolean");
}
function IsConstructor(value) {
  if (IsUndefined(value) || !IsFunction(value))
    return false;
  const result2 = Function.prototype.toString.call(value);
  if (/^class\s/.test(result2))
    return true;
  if (/\[native code\]/.test(result2))
    return true;
  return false;
}
function IsFunction(value) {
  return IsEqual(typeof value, "function");
}
function IsInteger(value) {
  return Number.isInteger(value);
}
function IsNull(value) {
  return IsEqual(value, null);
}
function IsNumber(value) {
  return Number.isFinite(value);
}
function IsObjectNotArray(value) {
  return IsObject(value) && !IsArray(value);
}
function IsObject(value) {
  return IsEqual(typeof value, "object") && !IsNull(value);
}
function IsString(value) {
  return IsEqual(typeof value, "string");
}
function IsSymbol(value) {
  return IsEqual(typeof value, "symbol");
}
function IsUndefined(value) {
  return IsEqual(value, void 0);
}
function IsEqual(left, right) {
  return left === right;
}
function IsGreaterThan(left, right) {
  return left > right;
}
function IsLessThan(left, right) {
  return left < right;
}
function IsLessEqualThan(left, right) {
  return left <= right;
}
function IsGreaterEqualThan(left, right) {
  return left >= right;
}
function IsMultipleOf(dividend, divisor) {
  if (IsBigInt(dividend) || IsBigInt(divisor)) {
    return BigInt(dividend) % BigInt(divisor) === 0n;
  }
  const tolerance = 1e-10;
  if (!IsNumber(dividend))
    return true;
  if (IsInteger(dividend) && 1 / divisor % 1 === 0)
    return true;
  const mod = dividend % divisor;
  return Math.min(Math.abs(mod), Math.abs(mod - divisor), Math.abs(mod + divisor)) < tolerance;
}
function IsClassInstance(value) {
  if (!IsObject(value))
    return false;
  const proto = globalThis.Object.getPrototypeOf(value);
  if (IsNull(proto))
    return false;
  return IsEqual(typeof proto.constructor, "function") && !(IsEqual(proto.constructor, globalThis.Object) || IsEqual(proto.constructor.name, "Object"));
}
function IsValueLike(value) {
  return IsBigInt(value) || IsBoolean(value) || IsNull(value) || IsNumber(value) || IsString(value) || IsUndefined(value);
}
function GraphemeCount2(value) {
  return GraphemeCount(value);
}
function IsMaxLength2(value, length) {
  return IsMaxLengthFast(value, length);
}
function IsMinLength2(value, length) {
  return IsMinLengthFast(value, length);
}
function Every(value, offset, callback) {
  for (let index = offset; index < value.length; index++) {
    if (!callback(value[index], index))
      return false;
  }
  return true;
}
function EveryAll(value, offset, callback) {
  let result2 = true;
  for (let index = offset; index < value.length; index++) {
    if (!callback(value[index], index))
      result2 = false;
  }
  return result2;
}
function Some(value, callback) {
  for (let index = 0; index < value.length; index++) {
    if (callback(value[index], index))
      return true;
  }
  return false;
}
function SomeAll(value, callback) {
  let result2 = false;
  for (let index = 0; index < value.length; index++) {
    if (callback(value[index], index))
      result2 = true;
  }
  return result2;
}
function Counted(value, callback) {
  return value.reduce((result2, value2, index) => callback(value2, index) ? ++result2 : result2, 0);
}
function ShiftLeft(array, true_, false_) {
  return IsEqual(array.length, 0) ? false_() : true_(array[0], array.slice(1));
}
function IsUnsafePropertyKey(key) {
  return IsEqual(key, "__proto__") || IsEqual(key, "constructor") || IsEqual(key, "prototype");
}
function HasPropertyKey(value, key) {
  return IsUnsafePropertyKey(key) ? Object.prototype.hasOwnProperty.call(value, key) : key in value;
}
function EntriesRegExp(value) {
  return Keys(value).map((key) => [new RegExp(`^${key}$`), value[key]]);
}
function Entries(value) {
  return Object.entries(value);
}
function Keys(value) {
  return Object.getOwnPropertyNames(value);
}
function Symbols(value) {
  return Object.getOwnPropertySymbols(value);
}
function Values(value) {
  return Object.values(value);
}
function DeepEqualObject(left, right) {
  if (!IsObject(right))
    return false;
  const keys = Keys(left);
  return IsEqual(keys.length, Keys(right).length) && keys.every((key) => IsDeepEqual(left[key], right[key]));
}
function DeepEqualArray(left, right) {
  return IsArray(right) && IsEqual(left.length, right.length) && left.every((_, index) => IsDeepEqual(left[index], right[index]));
}
function IsDeepEqual(left, right) {
  return IsArray(left) ? DeepEqualArray(left, right) : IsObject(left) ? DeepEqualObject(left, right) : IsEqual(left, right);
}
var init_guard = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/guard.mjs"() {
    init_string();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/emit.mjs
var init_emit = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/emit.mjs"() {
    init_guard();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/globals.mjs
var globals_exports = {};
__export(globals_exports, {
  IsBigInt64Array: () => IsBigInt64Array,
  IsBigUint64Array: () => IsBigUint64Array,
  IsBoolean: () => IsBoolean2,
  IsDate: () => IsDate,
  IsFloat32Array: () => IsFloat32Array,
  IsFloat64Array: () => IsFloat64Array,
  IsInt16Array: () => IsInt16Array,
  IsInt32Array: () => IsInt32Array,
  IsInt8Array: () => IsInt8Array,
  IsMap: () => IsMap,
  IsNumber: () => IsNumber2,
  IsRegExp: () => IsRegExp,
  IsSet: () => IsSet,
  IsString: () => IsString2,
  IsTypeArray: () => IsTypeArray,
  IsUint16Array: () => IsUint16Array,
  IsUint32Array: () => IsUint32Array,
  IsUint8Array: () => IsUint8Array,
  IsUint8ClampedArray: () => IsUint8ClampedArray
});
function IsBoolean2(value) {
  return value instanceof Boolean;
}
function IsNumber2(value) {
  return value instanceof Number;
}
function IsString2(value) {
  return value instanceof String;
}
function IsTypeArray(value) {
  return globalThis.ArrayBuffer.isView(value);
}
function IsInt8Array(value) {
  return value instanceof globalThis.Int8Array;
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
function IsUint8ClampedArray(value) {
  return value instanceof globalThis.Uint8ClampedArray;
}
function IsInt16Array(value) {
  return value instanceof globalThis.Int16Array;
}
function IsUint16Array(value) {
  return value instanceof globalThis.Uint16Array;
}
function IsInt32Array(value) {
  return value instanceof globalThis.Int32Array;
}
function IsUint32Array(value) {
  return value instanceof globalThis.Uint32Array;
}
function IsFloat32Array(value) {
  return value instanceof globalThis.Float32Array;
}
function IsFloat64Array(value) {
  return value instanceof globalThis.Float64Array;
}
function IsBigInt64Array(value) {
  return value instanceof globalThis.BigInt64Array;
}
function IsBigUint64Array(value) {
  return value instanceof globalThis.BigUint64Array;
}
function IsRegExp(value) {
  return value instanceof globalThis.RegExp;
}
function IsDate(value) {
  return value instanceof globalThis.Date;
}
function IsSet(value) {
  return value instanceof globalThis.Set;
}
function IsMap(value) {
  return value instanceof globalThis.Map;
}
var init_globals = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/globals.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/native.mjs
var init_native = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/native.mjs"() {
    init_guard();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/index.mjs
var guard_default;
var init_guard2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/guard/index.mjs"() {
    init_emit();
    init_globals();
    init_native();
    init_guard();
    init_guard();
    guard_default = guard_exports;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/clone.mjs
function FromClassInstance(value) {
  return value;
}
function IsTypeObject(value) {
  return guard_exports.HasPropertyKey(value, "~kind") || guard_exports.HasPropertyKey(value, "~unsafe");
}
function FromTypeObject(value) {
  const result2 = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    const descriptor = descriptors[key];
    if (guard_exports.HasPropertyKey(descriptor, "value")) {
      Object.defineProperty(result2, key, { ...descriptor, value: FromValue(descriptor.value) });
    }
  }
  return result2;
}
function FromPlainObject(value) {
  const result2 = {};
  for (const key of guard_exports.Keys(value)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    result2[key] = FromValue(value[key]);
  }
  for (const key of guard_exports.Symbols(value)) {
    result2[key] = FromValue(value[key]);
  }
  return result2;
}
function FromObject(value) {
  return guard_exports.IsClassInstance(value) ? FromClassInstance(value) : IsTypeObject(value) ? FromTypeObject(value) : FromPlainObject(value);
}
function FromArray(value) {
  return value.map((element) => FromValue(element));
}
function FromTypedArray(value) {
  return value.slice();
}
function FromRegExp(value) {
  return new RegExp(value.source, value.flags);
}
function FromMap(value) {
  return new Map(FromValue([...value.entries()]));
}
function FromSet(value) {
  return new Set(FromValue([...value.values()]));
}
function FromValue(value) {
  return globals_exports.IsTypeArray(value) ? FromTypedArray(value) : globals_exports.IsRegExp(value) ? FromRegExp(value) : globals_exports.IsMap(value) ? FromMap(value) : globals_exports.IsSet(value) ? FromSet(value) : guard_exports.IsArray(value) ? FromArray(value) : guard_exports.IsObject(value) ? FromObject(value) : value;
}
function Clone(value) {
  Metrics.clone += 1;
  return FromValue(value);
}
var init_clone = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/clone.mjs"() {
    init_guard2();
    init_metrics();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/settings/settings.mjs
var settings_exports = {};
__export(settings_exports, {
  Get: () => Get,
  Reset: () => Reset,
  Set: () => Set2
});
function Reset() {
  settings.immutableTypes = false;
  settings.maxErrors = 8;
  settings.useAcceleration = true;
  settings.exactOptionalPropertyTypes = false;
  settings.enumerableKind = false;
  settings.correctiveParse = false;
  settings.unionPrioritySort = true;
}
function Set2(options) {
  for (const key of guard_exports.Keys(options)) {
    const value = options[key];
    if (value !== void 0) {
      Object.defineProperty(settings, key, { value });
    }
  }
}
function Get() {
  return settings;
}
var settings;
var init_settings = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/settings/settings.mjs"() {
    init_guard2();
    settings = {
      immutableTypes: false,
      maxErrors: 8,
      useAcceleration: true,
      exactOptionalPropertyTypes: false,
      enumerableKind: false,
      correctiveParse: false,
      unionPrioritySort: true
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/settings/index.mjs
var init_settings2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/settings/index.mjs"() {
    init_settings();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/create.mjs
function MergeHidden(left, right) {
  for (const key of Object.keys(right)) {
    Object.defineProperty(left, key, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: right[key]
    });
  }
  return left;
}
function Merge(left, right) {
  return { ...left, ...right };
}
function Create(hidden, enumerable, options = {}) {
  Metrics.create += 1;
  const settings2 = settings_exports.Get();
  const withOptions = Merge(enumerable, options);
  const withHidden = settings2.enumerableKind ? Merge(withOptions, hidden) : MergeHidden(withOptions, hidden);
  return settings2.immutableTypes ? Object.freeze(withHidden) : withHidden;
}
var init_create = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/create.mjs"() {
    init_settings2();
    init_metrics();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/discard.mjs
function Discard(value, propertyKeys) {
  Metrics.discard += 1;
  const result2 = {};
  const descriptors = Object.getOwnPropertyDescriptors(Clone(value));
  const keysToDiscard = new Set(propertyKeys);
  for (const key of Object.keys(descriptors)) {
    if (keysToDiscard.has(key))
      continue;
    Object.defineProperty(result2, key, descriptors[key]);
  }
  return result2;
}
var init_discard = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/discard.mjs"() {
    init_metrics();
    init_clone();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/update.mjs
function Update(current, hidden, enumerable) {
  Metrics.update += 1;
  const settings2 = settings_exports.Get();
  const result2 = Clone(current);
  for (const key of Object.keys(hidden)) {
    Object.defineProperty(result2, key, {
      configurable: true,
      writable: true,
      enumerable: settings2.enumerableKind,
      value: hidden[key]
    });
  }
  for (const key of Object.keys(enumerable)) {
    Object.defineProperty(result2, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: enumerable[key]
    });
  }
  return result2;
}
var init_update = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/update.mjs"() {
    init_settings2();
    init_metrics();
    init_clone();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/memory.mjs
var memory_exports = {};
__export(memory_exports, {
  Assign: () => Assign,
  Clone: () => Clone,
  Create: () => Create,
  Discard: () => Discard,
  Metrics: () => Metrics,
  Update: () => Update
});
var init_memory = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/memory.mjs"() {
    init_assign();
    init_clone();
    init_create();
    init_discard();
    init_metrics();
    init_update();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/index.mjs
var init_memory2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/memory/index.mjs"() {
    init_memory();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/schema.mjs
function IsKind(value, kind) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], kind);
}
function IsSchema(value) {
  return guard_exports.IsObject(value);
}
var init_schema = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/schema.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/deferred.mjs
function Deferred(action, parameters, options) {
  return memory_exports.Create({ "~kind": "Deferred" }, { type: "deferred", action, parameters, options }, {});
}
function IsDeferred(value) {
  return IsKind(value, "Deferred");
}
var init_deferred = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/deferred.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly/instantiate_add.mjs
function AddReadonlyOperation(type) {
  return memory_exports.Update(type, { "~readonly": true }, {});
}
function AddReadonlyAction(type, options) {
  const result2 = memory_exports.Update(AddReadonlyOperation(type), {}, options);
  return result2;
}
function AddReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddReadonlyAction(instantiatedType, options);
}
var init_instantiate_add = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly/instantiate_add.mjs"() {
    init_memory2();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/optional/instantiate_add.mjs
function AddOptionalOperation(type) {
  return memory_exports.Update(type, { "~optional": true }, {});
}
function AddOptionalAction(type, options) {
  const result2 = memory_exports.Update(AddOptionalOperation(type), {}, options);
  return result2;
}
function AddOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddOptionalAction(instantiatedType, options);
}
var init_instantiate_add2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/optional/instantiate_add.mjs"() {
    init_memory2();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/array.mjs
function _Array_(items, options) {
  return memory_exports.Create({ "~kind": "Array" }, { type: "array", items }, options);
}
function IsArray2(value) {
  return IsKind(value, "Array");
}
function ArrayOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items"]);
}
var init_array = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/array.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/constructor.mjs
function Constructor(parameters, instanceType, options = {}) {
  return memory_exports.Create({ "~kind": "Constructor" }, { type: "constructor", parameters, instanceType }, options);
}
function IsConstructor2(value) {
  return IsKind(value, "Constructor");
}
function ConstructorOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "instanceType"]);
}
var init_constructor = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/constructor.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/function.mjs
function _Function_(parameters, returnType, options = {}) {
  return memory_exports.Create({ ["~kind"]: "Function" }, { type: "function", parameters, returnType }, options);
}
function IsFunction2(value) {
  return IsKind(value, "Function");
}
function FunctionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "returnType"]);
}
var init_function = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/function.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/ref.mjs
function Ref(ref, options) {
  return memory_exports.Create({ ["~kind"]: "Ref" }, { $ref: ref }, options);
}
function IsRef(value) {
  return IsKind(value, "Ref");
}
var init_ref = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/ref.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/generic.mjs
function Generic(parameters, expression) {
  return memory_exports.Create({ "~kind": "Generic" }, { type: "generic", parameters, expression });
}
function IsGeneric(value) {
  return IsKind(value, "Generic");
}
var init_generic = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/generic.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/any.mjs
function Any(options) {
  return memory_exports.Create({ ["~kind"]: "Any" }, {}, options);
}
function IsAny(value) {
  return IsKind(value, "Any");
}
var init_any = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/any.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/never.mjs
function Never(options) {
  return memory_exports.Create({ "~kind": "Never" }, { not: {} }, options);
}
function IsNever(value) {
  return IsKind(value, "Never");
}
var NeverPattern;
var init_never = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/never.mjs"() {
    init_memory2();
    init_schema();
    NeverPattern = "(?!)";
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_add_optional.mjs
function AddOptionalDeferred(type, options = {}) {
  return Deferred("AddOptional", [type], options);
}
function AddOptional(type, options = {}) {
  return AddOptionalAction(type, options);
}
var init_add_optional = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_add_optional.mjs"() {
    init_deferred();
    init_instantiate_add2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_optional.mjs
function Optional(type) {
  return AddOptional(type);
}
function IsOptional(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~optional");
}
var init_optional = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_optional.mjs"() {
    init_guard2();
    init_schema();
    init_add_optional();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/properties.mjs
function RequiredArray(properties) {
  return guard_exports.Keys(properties).filter((key) => !IsOptional(properties[key]));
}
function PropertyKeys(properties) {
  return guard_exports.Keys(properties);
}
function PropertyValues(properties) {
  return guard_exports.Values(properties);
}
var init_properties = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/properties.mjs"() {
    init_guard2();
    init_optional();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/object.mjs
function _Object_(properties, options = {}) {
  const requiredKeys = RequiredArray(properties);
  const required = requiredKeys.length > 0 ? { required: requiredKeys } : {};
  return memory_exports.Create({ "~kind": "Object" }, { type: "object", ...required, properties }, options);
}
function IsObject2(value) {
  return IsKind(value, "Object");
}
function ObjectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "properties", "required"]);
}
var init_object = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/object.mjs"() {
    init_memory2();
    init_schema();
    init_properties();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/unknown.mjs
function Unknown(options) {
  return memory_exports.Create({ ["~kind"]: "Unknown" }, {}, options);
}
function IsUnknown(value) {
  return IsKind(value, "Unknown");
}
var init_unknown = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/unknown.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/cyclic.mjs
function Cyclic($defs, $ref, options) {
  const defs = guard_exports.Keys($defs).reduce((result2, key) => {
    return { ...result2, [key]: memory_exports.Update($defs[key], {}, { $id: key }) };
  }, {});
  return memory_exports.Create({ ["~kind"]: "Cyclic" }, { $defs: defs, $ref }, options);
}
function IsCyclic(value) {
  return IsKind(value, "Cyclic");
}
var init_cyclic = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/cyclic.mjs"() {
    init_guard2();
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/unsafe.mjs
function Unsafe(schema) {
  return memory_exports.Update(schema, { ["~unsafe"]: null }, {});
}
function IsUnsafe(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "~unsafe") && guard_exports.IsNull(value["~unsafe"]);
}
var init_unsafe = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/unsafe.mjs"() {
    init_guard2();
    init_memory2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/arguments/arguments.mjs
var arguments_exports = {};
__export(arguments_exports, {
  Match: () => Match
});
function Match(args, match) {
  return match[args.length]?.(...args) ?? (() => {
    throw Error("Invalid Arguments");
  })();
}
var init_arguments = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/arguments/arguments.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/arguments/index.mjs
var init_arguments2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/arguments/index.mjs"() {
    init_arguments();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/infer.mjs
function Infer(...args) {
  const [name, extends_] = arguments_exports.Match(args, {
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ ["~kind"]: "Infer" }, { type: "infer", name, extends: extends_ }, {});
}
function IsInfer(value) {
  return IsKind(value, "Infer");
}
var init_infer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/infer.mjs"() {
    init_arguments2();
    init_memory2();
    init_schema();
    init_unknown();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/dependent.mjs
function Dependent(if_, then_, else_, options = {}) {
  return memory_exports.Create({ "~kind": "Dependent" }, { if: if_, then: then_, else: else_ }, options);
}
function IsDependent(value) {
  return IsKind(value, "Dependent");
}
function DependentOptions(type) {
  return memory_exports.Discard(type, ["~kind", "if", "then", "else"]);
}
var init_dependent = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/dependent.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/enum/typescript_enum_to_enum_values.mjs
function IsTypeScriptEnumLike(value) {
  return guard_exports.IsObjectNotArray(value);
}
function TypeScriptEnumToEnumValues(type) {
  const keys = guard_exports.Keys(type).filter((key) => isNaN(key));
  return keys.reduce((result2, key) => [...result2, type[key]], []);
}
var init_typescript_enum_to_enum_values = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/enum/typescript_enum_to_enum_values.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/enum.mjs
function IsEnumValue(value) {
  return guard_exports.IsString(value) || guard_exports.IsNumber(value);
}
function Enum(value, options) {
  const values = IsTypeScriptEnumLike(value) ? TypeScriptEnumToEnumValues(value) : value;
  return memory_exports.Create({ "~kind": "Enum" }, { enum: values }, options);
}
function IsEnum(value) {
  return IsKind(value, "Enum");
}
var init_enum = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/enum.mjs"() {
    init_guard2();
    init_memory2();
    init_schema();
    init_typescript_enum_to_enum_values();
    init_typescript_enum_to_enum_values();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/intersect.mjs
function Intersect(types, options = {}) {
  return memory_exports.Create({ "~kind": "Intersect" }, { allOf: types }, options);
}
function IsIntersect(value) {
  return IsKind(value, "Intersect");
}
function IntersectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "allOf"]);
}
var init_intersect = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/intersect.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/environment/evaluate.mjs
var init_evaluate = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/environment/evaluate.mjs"() {
    init_settings2();
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/environment/environment.mjs
var init_environment = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/environment/environment.mjs"() {
    init_evaluate();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/environment/index.mjs
var init_environment2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/environment/index.mjs"() {
    init_environment();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/unreachable/unreachable.mjs
function Unreachable() {
  throw new Error("Unreachable");
}
var init_unreachable = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/unreachable/unreachable.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/unreachable/index.mjs
var init_unreachable2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/unreachable/index.mjs"() {
    init_unreachable();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/hashing/hash.mjs
var hash_exports = {};
__export(hash_exports, {
  Hash: () => Hash,
  HashCode: () => HashCode
});
function InstanceKeys(value) {
  const propertyKeys = /* @__PURE__ */ new Set();
  let current = value;
  while (current && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      if (key !== "constructor" && typeof key !== "symbol")
        propertyKeys.add(key);
    }
    current = Object.getPrototypeOf(current);
  }
  return [...propertyKeys];
}
function IsIEEE754(value) {
  return typeof value === "number";
}
function FNV1A64_OP(byte) {
  Accumulator = Accumulator ^ Bytes[byte];
  Accumulator = Accumulator * Prime % Size;
}
function FromArray2(value) {
  FNV1A64_OP(ByteMarker.Array);
  for (const item of value) {
    FromValue2(item);
  }
}
function FromBigInt(value) {
  FNV1A64_OP(ByteMarker.BigInt);
  F64In.setBigInt64(0, value);
  for (const byte of F64Out) {
    FNV1A64_OP(byte);
  }
}
function FromBoolean(value) {
  FNV1A64_OP(ByteMarker.Boolean);
  FNV1A64_OP(value ? 1 : 0);
}
function FromConstructor(value) {
  FNV1A64_OP(ByteMarker.Constructor);
  FromValue2(value.toString());
}
function FromDate(value) {
  FNV1A64_OP(ByteMarker.Date);
  FromValue2(value.getTime());
}
function FromFunction(value) {
  FNV1A64_OP(ByteMarker.Function);
  FromValue2(value.toString());
}
function FromNull(_value) {
  FNV1A64_OP(ByteMarker.Null);
}
function FromNumber(value) {
  FNV1A64_OP(ByteMarker.Number);
  F64In.setFloat64(
    0,
    value,
    true
    /* little-endian */
  );
  for (const byte of F64Out) {
    FNV1A64_OP(byte);
  }
}
function FromObject2(value) {
  FNV1A64_OP(ByteMarker.Object);
  for (const key of InstanceKeys(value).sort()) {
    FromValue2(key);
    FromValue2(value[key]);
  }
}
function FromRegExp2(value) {
  FNV1A64_OP(ByteMarker.RegExp);
  FromString(value.toString());
}
function FromString(value) {
  FNV1A64_OP(ByteMarker.String);
  for (const byte of encoder.encode(value)) {
    FNV1A64_OP(byte);
  }
}
function FromSymbol(value) {
  FNV1A64_OP(ByteMarker.Symbol);
  FromValue2(value.toString());
}
function FromTypeArray(value) {
  FNV1A64_OP(ByteMarker.TypeArray);
  const buffer = new Uint8Array(value.buffer);
  for (let i = 0; i < buffer.length; i++) {
    FNV1A64_OP(buffer[i]);
  }
}
function FromUndefined(_value) {
  return FNV1A64_OP(ByteMarker.Undefined);
}
function FromValue2(value) {
  return globals_exports.IsTypeArray(value) ? FromTypeArray(value) : globals_exports.IsDate(value) ? FromDate(value) : globals_exports.IsRegExp(value) ? FromRegExp2(value) : globals_exports.IsBoolean(value) ? FromBoolean(value.valueOf()) : globals_exports.IsString(value) ? FromString(value.valueOf()) : globals_exports.IsNumber(value) ? FromNumber(value.valueOf()) : IsIEEE754(value) ? FromNumber(value) : guard_exports.IsArray(value) ? FromArray2(value) : guard_exports.IsBoolean(value) ? FromBoolean(value) : guard_exports.IsBigInt(value) ? FromBigInt(value) : guard_exports.IsConstructor(value) ? FromConstructor(value) : guard_exports.IsNull(value) ? FromNull(value) : guard_exports.IsObject(value) ? FromObject2(value) : guard_exports.IsString(value) ? FromString(value) : guard_exports.IsSymbol(value) ? FromSymbol(value) : guard_exports.IsUndefined(value) ? FromUndefined(value) : guard_exports.IsFunction(value) ? FromFunction(value) : Unreachable();
}
function HashCode(value) {
  Accumulator = BigInt("14695981039346656037");
  FromValue2(value);
  return Accumulator;
}
function Hash(value) {
  return HashCode(value).toString(16).padStart(16, "0");
}
var ByteMarker, Accumulator, Prime, Size, Bytes, F64, F64In, F64Out, encoder;
var init_hash = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/hashing/hash.mjs"() {
    init_unreachable2();
    init_guard2();
    (function(ByteMarker2) {
      ByteMarker2[ByteMarker2["Array"] = 0] = "Array";
      ByteMarker2[ByteMarker2["BigInt"] = 1] = "BigInt";
      ByteMarker2[ByteMarker2["Boolean"] = 2] = "Boolean";
      ByteMarker2[ByteMarker2["Date"] = 3] = "Date";
      ByteMarker2[ByteMarker2["Constructor"] = 4] = "Constructor";
      ByteMarker2[ByteMarker2["Function"] = 5] = "Function";
      ByteMarker2[ByteMarker2["Null"] = 6] = "Null";
      ByteMarker2[ByteMarker2["Number"] = 7] = "Number";
      ByteMarker2[ByteMarker2["Object"] = 8] = "Object";
      ByteMarker2[ByteMarker2["RegExp"] = 9] = "RegExp";
      ByteMarker2[ByteMarker2["String"] = 10] = "String";
      ByteMarker2[ByteMarker2["Symbol"] = 11] = "Symbol";
      ByteMarker2[ByteMarker2["TypeArray"] = 12] = "TypeArray";
      ByteMarker2[ByteMarker2["Undefined"] = 13] = "Undefined";
    })(ByteMarker || (ByteMarker = {}));
    Accumulator = BigInt("14695981039346656037");
    [Prime, Size] = [BigInt("1099511628211"), BigInt(
      "18446744073709551616"
      /* 2 ^ 64 */
    )];
    Bytes = Array.from({ length: 256 }).map((_, i) => BigInt(i));
    F64 = new Float64Array(1);
    F64In = new DataView(F64.buffer);
    F64Out = new Uint8Array(F64.buffer);
    encoder = new TextEncoder();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/hashing/index.mjs
var init_hashing = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/hashing/index.mjs"() {
    init_hash();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/en_US.mjs
function en_US(error) {
  switch (error.keyword) {
    case "additionalProperties":
      return "must not have additional properties";
    case "anyOf":
      return "must match a schema in anyOf";
    case "boolean":
      return "schema is false";
    case "const":
      return "must be equal to constant";
    case "contains":
      return "must contain at least 1 valid item";
    case "dependencies":
      return `must have properties ${error.params.dependencies.join(", ")} when property ${error.params.property} is present`;
    case "dependentRequired":
      return `must have properties ${error.params.dependencies.join(", ")} when property ${error.params.property} is present`;
    case "enum":
      return "must be equal to one of the allowed values";
    case "exclusiveMaximum":
      return `must be ${error.params.comparison} ${error.params.limit}`;
    case "exclusiveMinimum":
      return `must be ${error.params.comparison} ${error.params.limit}`;
    case "format":
      return `must match format "${error.params.format}"`;
    case "if":
      return `must match "${error.params.failingKeyword}" schema`;
    case "maxItems":
      return `must not have more than ${error.params.limit} items`;
    case "maxLength":
      return `must not have more than ${error.params.limit} characters`;
    case "maxProperties":
      return `must not have more than ${error.params.limit} properties`;
    case "maximum":
      return `must be ${error.params.comparison} ${error.params.limit}`;
    case "minItems":
      return `must not have fewer than ${error.params.limit} items`;
    case "minLength":
      return `must not have fewer than ${error.params.limit} characters`;
    case "minProperties":
      return `must not have fewer than ${error.params.limit} properties`;
    case "minimum":
      return `must be ${error.params.comparison} ${error.params.limit}`;
    case "multipleOf":
      return `must be multiple of ${error.params.multipleOf}`;
    case "not":
      return "must not be valid";
    case "oneOf":
      return "must match exactly one schema in oneOf";
    case "pattern":
      return `must match pattern "${error.params.pattern}"`;
    case "propertyNames":
      return `property names ${error.params.propertyNames.join(", ")} are invalid`;
    case "required":
      return `must have required properties ${error.params.requiredProperties.join(", ")}`;
    case "type":
      return typeof error.params.type === "string" ? `must be ${error.params.type}` : `must be either ${error.params.type.join(" or ")}`;
    case "unevaluatedItems":
      return "must not have unevaluated items";
    case "unevaluatedProperties":
      return "must not have unevaluated properties";
    case "uniqueItems":
      return `must not have duplicate items`;
    case "~refine":
      return error.params.message;
    // deno-coverage-ignore - unreachable
    default:
      return "an unknown validation error occurred";
  }
}
var init_en_US = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/en_US.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/_config.mjs
function Get2() {
  return locale;
}
var locale;
var init_config = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/_config.mjs"() {
    init_en_US();
    locale = en_US;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ar_001.mjs
var init_ar_001 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ar_001.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/bn_BD.mjs
var init_bn_BD = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/bn_BD.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/cs_CZ.mjs
var init_cs_CZ = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/cs_CZ.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/de_DE.mjs
var init_de_DE = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/de_DE.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/el_GR.mjs
var init_el_GR = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/el_GR.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/es_419.mjs
var init_es_419 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/es_419.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/es_AR.mjs
var init_es_AR = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/es_AR.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/es_ES.mjs
var init_es_ES = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/es_ES.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/es_MX.mjs
var init_es_MX = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/es_MX.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/fa_IR.mjs
var init_fa_IR = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/fa_IR.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/fil_PH.mjs
var init_fil_PH = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/fil_PH.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/fr_CA.mjs
var init_fr_CA = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/fr_CA.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/fr_FR.mjs
var init_fr_FR = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/fr_FR.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ha_NG.mjs
var init_ha_NG = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ha_NG.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/hi_IN.mjs
var init_hi_IN = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/hi_IN.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/hu_HU.mjs
var init_hu_HU = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/hu_HU.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/id_ID.mjs
var init_id_ID = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/id_ID.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/it_IT.mjs
var init_it_IT = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/it_IT.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ja_JP.mjs
var init_ja_JP = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ja_JP.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ko_KR.mjs
var init_ko_KR = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ko_KR.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ms_MY.mjs
var init_ms_MY = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ms_MY.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/nl_NL.mjs
var init_nl_NL = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/nl_NL.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/pl_PL.mjs
var init_pl_PL = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/pl_PL.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/pt_BR.mjs
var init_pt_BR = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/pt_BR.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/pt_PT.mjs
var init_pt_PT = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/pt_PT.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ro_RO.mjs
var init_ro_RO = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ro_RO.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ru_RU.mjs
var init_ru_RU = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ru_RU.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/sv_SE.mjs
var init_sv_SE = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/sv_SE.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/sw_TZ.mjs
var init_sw_TZ = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/sw_TZ.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/th_TH.mjs
var init_th_TH = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/th_TH.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/tr_TR.mjs
var init_tr_TR = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/tr_TR.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/uk_UA.mjs
var init_uk_UA = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/uk_UA.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ur_PK.mjs
var init_ur_PK = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/ur_PK.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/vi_VN.mjs
var init_vi_VN = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/vi_VN.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/yo_NG.mjs
var init_yo_NG = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/yo_NG.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/zh_Hans.mjs
var init_zh_Hans = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/zh_Hans.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/zh_Hant.mjs
var init_zh_Hant = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/zh_Hant.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/_locale.mjs
var init_locale = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/_locale.mjs"() {
    init_config();
    init_ar_001();
    init_bn_BD();
    init_cs_CZ();
    init_de_DE();
    init_el_GR();
    init_en_US();
    init_es_419();
    init_es_AR();
    init_es_ES();
    init_es_MX();
    init_fa_IR();
    init_fil_PH();
    init_fr_CA();
    init_fr_CA();
    init_fr_FR();
    init_ha_NG();
    init_hi_IN();
    init_hu_HU();
    init_id_ID();
    init_it_IT();
    init_ja_JP();
    init_ko_KR();
    init_ms_MY();
    init_nl_NL();
    init_pl_PL();
    init_pt_BR();
    init_pt_PT();
    init_ro_RO();
    init_ru_RU();
    init_sv_SE();
    init_sw_TZ();
    init_th_TH();
    init_tr_TR();
    init_uk_UA();
    init_ur_PK();
    init_vi_VN();
    init_yo_NG();
    init_zh_Hans();
    init_zh_Hant();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/index.mjs
var init_locale2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/locale/index.mjs"() {
    init_locale();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/system.mjs
var init_system = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/system.mjs"() {
    init_arguments2();
    init_environment2();
    init_hashing();
    init_locale2();
    init_memory2();
    init_settings2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/index.mjs
var init_system2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/system/index.mjs"() {
    init_system();
    init_system();
    init_system();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_codec.mjs
function Codec(type) {
  return new DecodeBuilder(type);
}
function Decode(type, callback) {
  return Codec(type).Decode(callback).Encode(() => {
    throw Error("Encode not implemented");
  });
}
function Encode(type, callback) {
  return Codec(type).Decode(() => {
    throw Error("Decode not implemented");
  }).Encode(callback);
}
function IsCodec(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~codec") && guard_exports.IsObject(value["~codec"]) && guard_exports.HasPropertyKey(value["~codec"], "encode") && guard_exports.HasPropertyKey(value["~codec"], "decode");
}
var EncodeBuilder, DecodeBuilder;
var init_codec = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_codec.mjs"() {
    init_system2();
    init_guard2();
    init_schema();
    EncodeBuilder = class {
      constructor(type, decode) {
        this.type = type;
        this.decode = decode;
      }
      Encode(callback) {
        const type = this.type;
        const decode = IsCodec(type) ? (value) => this.decode(type["~codec"].decode(value)) : this.decode;
        const encode = IsCodec(type) ? (value) => type["~codec"].encode(callback(value)) : callback;
        const codec = { decode, encode };
        return memory_exports.Update(this.type, { "~codec": codec }, {});
      }
    };
    DecodeBuilder = class {
      constructor(type) {
        this.type = type;
      }
      Decode(callback) {
        return new EncodeBuilder(this.type, callback);
      }
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_immutable.mjs
function Immutable(type) {
  return AddImmutable(type);
}
function IsImmutable(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~immutable");
}
var init_immutable = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_immutable.mjs"() {
    init_guard2();
    init_schema();
    init_add_immutable();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_add_readonly.mjs
function AddReadonlyDeferred(type, options = {}) {
  return Deferred("AddReadonly", [type], options);
}
function AddReadonly(type, options = {}) {
  return AddReadonlyAction(type, options);
}
var init_add_readonly = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_add_readonly.mjs"() {
    init_deferred();
    init_instantiate_add();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_readonly.mjs
function Readonly(type) {
  return AddReadonly(type);
}
function IsReadonly(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~readonly");
}
var init_readonly = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_readonly.mjs"() {
    init_guard2();
    init_schema();
    init_add_readonly();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_refine.mjs
function RefineAdd(type, refinement) {
  const refinements = IsRefine(type) ? [...type["~refine"], refinement] : [refinement];
  return memory_exports.Update(type, { "~refine": refinements }, {});
}
function Refine(...args) {
  const [type, check, error] = arguments_exports.Match(args, {
    3: (type2, check2, error2) => [type2, check2, error2],
    2: (type2, check2) => [type2, check2, () => "Refine Error"]
  });
  return RefineAdd(type, { check, error });
}
function IsRefinement(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "check") && guard_exports.HasPropertyKey(value, "error") && guard_exports.IsFunction(value.check) && guard_exports.IsFunction(value.error);
}
function IsRefine(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~refine") && guard_exports.IsArray(value["~refine"]) && guard_exports.Every(value["~refine"], 0, (value2) => IsRefinement(value2));
}
var init_refine = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/_refine.mjs"() {
    init_arguments2();
    init_memory2();
    init_guard2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/bigint.mjs
function BigInt2(options) {
  return memory_exports.Create({ "~kind": "BigInt" }, { type: "bigint" }, options);
}
function IsBigInt2(value) {
  return IsKind(value, "BigInt");
}
var BigIntPattern;
var init_bigint = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/bigint.mjs"() {
    init_memory2();
    init_schema();
    BigIntPattern = "-?(?:0|[1-9][0-9]*)n";
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/boolean.mjs
function Boolean2(options) {
  return memory_exports.Create({ "~kind": "Boolean" }, { type: "boolean" }, options);
}
function IsBoolean3(value) {
  return IsKind(value, "Boolean");
}
var init_boolean = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/boolean.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/identifier.mjs
function Identifier(name) {
  return memory_exports.Create({ "~kind": "Identifier" }, { name });
}
function IsIdentifier(value) {
  return IsKind(value, "Identifier");
}
var init_identifier = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/identifier.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/integer.mjs
function Integer(options) {
  return memory_exports.Create({ "~kind": "Integer" }, { type: "integer" }, options);
}
function IsInteger2(value) {
  return IsKind(value, "Integer");
}
var IntegerPattern;
var init_integer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/integer.mjs"() {
    init_memory2();
    init_schema();
    IntegerPattern = "-?(?:0|[1-9][0-9]*)";
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/literal.mjs
function LiteralTypeName(value) {
  return guard_exports.IsBigInt(value) ? "bigint" : guard_exports.IsBoolean(value) ? "boolean" : guard_exports.IsNumber(value) ? "number" : guard_exports.IsString(value) ? "string" : (() => {
    throw new InvalidLiteralValue(value);
  })();
}
function Literal(value, options) {
  return memory_exports.Create({ "~kind": "Literal" }, { type: LiteralTypeName(value), const: value }, options);
}
function IsLiteralValue(value) {
  return guard_exports.IsBigInt(value) || guard_exports.IsBoolean(value) || guard_exports.IsNumber(value) || guard_exports.IsString(value);
}
function IsLiteralBigInt(value) {
  return IsLiteral(value) && guard_exports.IsBigInt(value.const);
}
function IsLiteralBoolean(value) {
  return IsLiteral(value) && guard_exports.IsBoolean(value.const);
}
function IsLiteralNumber(value) {
  return IsLiteral(value) && guard_exports.IsNumber(value.const);
}
function IsLiteralString(value) {
  return IsLiteral(value) && guard_exports.IsString(value.const);
}
function IsLiteral(value) {
  return IsKind(value, "Literal");
}
var InvalidLiteralValue;
var init_literal = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/literal.mjs"() {
    init_memory2();
    init_guard2();
    init_schema();
    InvalidLiteralValue = class extends Error {
      constructor(value) {
        super(`Invalid Literal value`);
        Object.defineProperty(this, "cause", {
          value: { value },
          writable: false,
          configurable: false,
          enumerable: false
        });
      }
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/null.mjs
function Null(options) {
  return memory_exports.Create({ "~kind": "Null" }, { type: "null" }, options);
}
function IsNull2(value) {
  return IsKind(value, "Null");
}
var init_null = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/null.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/number.mjs
function Number2(options) {
  return memory_exports.Create({ "~kind": "Number" }, { type: "number" }, options);
}
function IsNumber3(value) {
  return IsKind(value, "Number");
}
var NumberPattern;
var init_number = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/number.mjs"() {
    init_memory2();
    init_schema();
    NumberPattern = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?";
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/symbol.mjs
function Symbol2(options) {
  return memory_exports.Create({ "~kind": "Symbol" }, { type: "symbol" }, options);
}
function IsSymbol2(value) {
  return IsKind(value, "Symbol");
}
var init_symbol = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/symbol.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/parameter.mjs
function Parameter(...args) {
  const [name, extends_, equals] = arguments_exports.Match(args, {
    3: (name2, extends_2, equals2) => [name2, extends_2, equals2],
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ "~kind": "Parameter" }, { name, extends: extends_, equals }, {});
}
function IsParameter(value) {
  return IsKind(value, "Parameter");
}
var init_parameter = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/parameter.mjs"() {
    init_arguments2();
    init_memory2();
    init_schema();
    init_unknown();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/string.mjs
function String2(options) {
  return memory_exports.Create({ "~kind": "String" }, { type: "string" }, options);
}
function IsString3(value) {
  return IsKind(value, "String");
}
var StringPattern;
var init_string2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/string.mjs"() {
    init_memory2();
    init_schema();
    StringPattern = ".*";
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/union.mjs
function Union(anyOf, options = {}) {
  return memory_exports.Create({ "~kind": "Union" }, { anyOf }, options);
}
function IsUnion(value) {
  return IsKind(value, "Union");
}
function UnionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "anyOf"]);
}
var init_union = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/union.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/patterns/pattern.mjs
function ParsePatternIntoTypes(pattern) {
  const parsed = Pattern(pattern);
  const result2 = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : [];
  return result2;
}
var init_pattern = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/patterns/pattern.mjs"() {
    init_guard2();
    init_parser();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/is_finite.mjs
function FromLiteral(_value) {
  return true;
}
function FromTypesReduce(types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType(left) ? FromTypesReduce(right) : false, () => true);
}
function FromTypes(types) {
  const result2 = guard_exports.IsEqual(types.length, 0) ? false : FromTypesReduce(types);
  return result2;
}
function FromType(type) {
  return IsUnion(type) ? FromTypes(type.anyOf) : IsLiteral(type) ? FromLiteral(type.const) : false;
}
function IsTemplateLiteralFinite(types) {
  const result2 = FromTypes(types);
  return result2;
}
var init_is_finite = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/is_finite.mjs"() {
    init_guard2();
    init_literal();
    init_union();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/create.mjs
function TemplateLiteralCreate(pattern) {
  return memory_exports.Create({ ["~kind"]: "TemplateLiteral" }, { type: "string", pattern }, {});
}
var init_create2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/create.mjs"() {
    init_memory2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/decode.mjs
function FromLiteralPush(variants, value, result2 = []) {
  return guard_exports.ShiftLeft(variants, (left, right) => FromLiteralPush(right, value, [...result2, `${left}${value}`]), () => result2);
}
function FromLiteral2(variants, value) {
  return guard_exports.IsEqual(variants.length, 0) ? [`${value}`] : FromLiteralPush(variants, value);
}
function FromUnion(variants, types, result2 = []) {
  return guard_exports.ShiftLeft(types, (left, right) => FromUnion(variants, right, [...result2, ...FromType2(variants, left)]), () => result2);
}
function FromType2(variants, type) {
  const result2 = IsUnion(type) ? FromUnion(variants, type.anyOf) : IsLiteral(type) ? FromLiteral2(variants, type.const) : Unreachable();
  return result2;
}
function DecodeFromSpan(variants, types) {
  return guard_exports.ShiftLeft(types, (left, right) => DecodeFromSpan(FromType2(variants, left), right), () => variants);
}
function VariantsToLiterals(variants) {
  return variants.map((variant) => Literal(variant));
}
function DecodeTypesAsUnion(types) {
  const variants = DecodeFromSpan([], types);
  const literals = VariantsToLiterals(variants);
  const result2 = Union(literals);
  return result2;
}
function DecodeTypes(types) {
  return guard_exports.IsEqual(types.length, 0) ? Unreachable() : (
    // Literal('') :
    guard_exports.IsEqual(types.length, 1) && IsLiteral(types[0]) ? types[0] : DecodeTypesAsUnion(types)
  );
}
function TemplateLiteralDecodeUnsafe(pattern) {
  const types = ParsePatternIntoTypes(pattern);
  const result2 = guard_exports.IsEqual(types.length, 0) ? String2() : IsTemplateLiteralFinite(types) ? DecodeTypes(types) : TemplateLiteralCreate(pattern);
  return result2;
}
function TemplateLiteralDecode(pattern) {
  const decoded = TemplateLiteralDecodeUnsafe(pattern);
  const result2 = IsTemplateLiteral(decoded) ? String2() : decoded;
  return result2;
}
var init_decode = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/decode.mjs"() {
    init_guard2();
    init_unreachable2();
    init_literal();
    init_string2();
    init_template_literal();
    init_union();
    init_pattern();
    init_is_finite();
    init_create2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/record_create.mjs
function CreateRecord(key, value) {
  const type = "object";
  const patternProperties = { [key]: value };
  return memory_exports.Create({ ["~kind"]: "Record" }, { type, patternProperties });
}
var init_record_create = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/record_create.mjs"() {
    init_memory2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_any.mjs
function FromAnyKey(value) {
  return CreateRecord(StringKey, value);
}
var init_from_key_any = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_any.mjs"() {
    init_record();
    init_record_create();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_boolean.mjs
function FromBooleanKey(value) {
  return _Object_({ true: value, false: value });
}
var init_from_key_boolean = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_boolean.mjs"() {
    init_object();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/tuple.mjs
function Tuple(types, options = {}) {
  const [items, minItems, additionalItems] = [types, types.length, false];
  return memory_exports.Create({ ["~kind"]: "Tuple" }, { type: "array", additionalItems, items, minItems }, options);
}
function IsTuple(value) {
  return IsKind(value, "Tuple");
}
function TupleOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items", "minItems", "additionalItems"]);
}
var init_tuple = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/tuple.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly/instantiate_remove.mjs
function RemoveReadonlyOperation(type) {
  return memory_exports.Discard(type, ["~readonly"]);
}
function RemoveReadonlyAction(type, options) {
  const result2 = memory_exports.Update(RemoveReadonlyOperation(type), {}, options);
  return result2;
}
function RemoveReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveReadonlyAction(instantiatedType, options);
}
var init_instantiate_remove = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly/instantiate_remove.mjs"() {
    init_memory2();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_remove_readonly.mjs
function RemoveReadonlyDeferred(type, options = {}) {
  return Deferred("RemoveReadonly", [type], options);
}
function RemoveReadonly(type, options = {}) {
  return RemoveReadonlyAction(type, options);
}
var init_remove_readonly = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_remove_readonly.mjs"() {
    init_deferred();
    init_instantiate_remove();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/optional/instantiate_remove.mjs
function RemoveOptionalOperation(type) {
  return memory_exports.Discard(type, ["~optional"]);
}
function RemoveOptionalAction(type, options) {
  const result2 = memory_exports.Update(RemoveOptionalOperation(type), {}, options);
  return result2;
}
function RemoveOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveOptionalAction(instantiatedType, options);
}
var init_instantiate_remove2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/optional/instantiate_remove.mjs"() {
    init_memory2();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_remove_optional.mjs
function RemoveOptionalDeferred(type, options = {}) {
  return Deferred("RemoveOptional", [type], options);
}
function RemoveOptional(type, options = {}) {
  return RemoveOptionalAction(type, options);
}
var init_remove_optional = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_remove_optional.mjs"() {
    init_deferred();
    init_instantiate_remove2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/tuple/to_object.mjs
function TupleElementsToProperties(types) {
  const result2 = types.reduceRight((result3, right, index) => {
    return { [index]: right, ...result3 };
  }, {});
  return result2;
}
function TupleToObject(type) {
  const properties = TupleElementsToProperties(type.items);
  const result2 = _Object_(properties);
  return result2;
}
var init_to_object = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/tuple/to_object.mjs"() {
    init_object();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/composite.mjs
function IsReadonlyProperty(left, right) {
  return IsReadonly(left) ? IsReadonly(right) ? true : false : false;
}
function IsOptionalProperty(left, right) {
  return IsOptional(left) ? IsOptional(right) ? true : false : false;
}
function CompositeProperty(left, right) {
  const isReadonly = IsReadonlyProperty(left, right);
  const isOptional = IsOptionalProperty(left, right);
  const evaluated = EvaluateIntersect([left, right]);
  const property = RemoveReadonly(RemoveOptional(evaluated));
  return isReadonly && isOptional ? AddReadonly(AddOptional(property)) : isReadonly && !isOptional ? AddReadonly(property) : !isReadonly && isOptional ? AddOptional(property) : property;
}
function CompositePropertyKey(left, right, key) {
  return key in left ? key in right ? CompositeProperty(left[key], right[key]) : left[key] : key in right ? right[key] : Never();
}
function CompositeProperties(left, right) {
  const keys = /* @__PURE__ */ new Set([...guard_exports.Keys(right), ...guard_exports.Keys(left)]);
  return [...keys].reduce((result2, key) => {
    return { ...result2, [key]: CompositePropertyKey(left, right, key) };
  }, {});
}
function GetProperties(type) {
  const result2 = IsObject2(type) ? type.properties : IsTuple(type) ? TupleElementsToProperties(type.items) : Unreachable();
  return result2;
}
function Composite(left, right) {
  const leftProperties = GetProperties(left);
  const rightProperties = GetProperties(right);
  const properties = CompositeProperties(leftProperties, rightProperties);
  return _Object_(properties);
}
var init_composite = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/composite.mjs"() {
    init_unreachable2();
    init_guard2();
    init_readonly();
    init_optional();
    init_object();
    init_never();
    init_tuple();
    init_add_readonly();
    init_add_optional();
    init_remove_readonly();
    init_remove_optional();
    init_to_object();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/narrow.mjs
function Narrow(left, right) {
  const result2 = Compare(left, right);
  return guard_exports.IsEqual(result2, ResultLeftInside) ? left : guard_exports.IsEqual(result2, ResultRightInside) ? right : guard_exports.IsEqual(result2, ResultEqual) ? right : Never();
}
var init_narrow = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/narrow.mjs"() {
    init_guard2();
    init_never();
    init_compare();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/distribute.mjs
function IsObjectLike(type) {
  return IsObject2(type) || IsTuple(type);
}
function IsUnionOperand(left, right) {
  const isUnionLeft = IsUnion(left);
  const isUnionRight = IsUnion(right);
  const result2 = isUnionLeft || isUnionRight;
  return result2;
}
function DistributeOperation(left, right) {
  const evaluatedLeft = EvaluateType(left);
  const evaluatedRight = EvaluateType(right);
  const isUnionOperand = IsUnionOperand(evaluatedLeft, evaluatedRight);
  const isObjectLeft = IsObjectLike(evaluatedLeft);
  const IsObjectRight = IsObjectLike(evaluatedRight);
  const result2 = isUnionOperand ? EvaluateIntersect([evaluatedLeft, evaluatedRight]) : isObjectLeft && IsObjectRight ? Composite(evaluatedLeft, evaluatedRight) : isObjectLeft && !IsObjectRight ? evaluatedLeft : !isObjectLeft && IsObjectRight ? evaluatedRight : Narrow(evaluatedLeft, evaluatedRight);
  return result2;
}
function DistributeType(type, types, result2 = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeType(type, right, [...result2, DistributeOperation(type, left)]), () => guard_exports.IsEqual(result2.length, 0) ? [type] : result2);
}
function DistributeUnion(types, distribution, result2 = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeUnion(right, distribution, [...result2, ...Distribute([left], distribution)]), () => result2);
}
function Distribute(types, result2 = []) {
  return guard_exports.ShiftLeft(types, (left, right) => IsUnion(left) ? Distribute(right, DistributeUnion(left.anyOf, result2)) : Distribute(right, DistributeType(left, result2)), () => result2);
}
var init_distribute = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/distribute.mjs"() {
    init_guard2();
    init_union();
    init_object();
    init_tuple();
    init_composite();
    init_narrow();
    init_evaluate2();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/exclude/operation.mjs
function ExcludeType(left, right) {
  const check = Extends({}, left, right);
  const result2 = result_exports.IsExtendsTrueLike(check) ? [] : [left];
  return result2;
}
function ExcludeUnion(types, right) {
  return types.reduce((result2, head) => {
    return [...result2, ...ExcludeType(head, right)];
  }, []);
}
function ExcludeOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExcludeUnion(canonical, right);
  const result2 = EvaluateUnion(remaining);
  return result2;
}
var init_operation = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/exclude/operation.mjs"() {
    init_union();
    init_extends3();
    init_evaluate2();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/evaluate.mjs
function EvaluateDependent(if_, then_, else_) {
  const intersect = Intersect([if_, then_]);
  const excluded = ExcludeOperation(else_, if_);
  const result2 = EvaluateUnion([intersect, excluded]);
  return result2;
}
function EvaluateEnum(values) {
  const result2 = values.map((value) => Literal(value));
  return EvaluateUnion(result2);
}
function EvaluateIntersect(types) {
  const distribution = Distribute(types);
  const broadend = Broaden(distribution);
  const result2 = EvaluateUnionFast(broadend);
  return result2;
}
function EvaluateTemplateLiteral(pattern) {
  const evaluated = TemplateLiteralDecode(pattern);
  const result2 = EvaluateType(evaluated);
  return result2;
}
function EvaluateUnion(types) {
  const broadend = Broaden(types);
  const result2 = EvaluateUnionFast(broadend);
  return result2;
}
function EvaluateType(type) {
  return IsDependent(type) ? EvaluateDependent(type.if, type.then, type.else) : IsEnum(type) ? EvaluateEnum(type.enum) : IsIntersect(type) ? EvaluateIntersect(type.allOf) : IsTemplateLiteral(type) ? EvaluateTemplateLiteral(type.pattern) : IsUnion(type) ? EvaluateUnion(type.anyOf) : type;
}
function EvaluateUnionFast(types) {
  const result2 = guard_exports.IsEqual(types.length, 1) ? types[0] : guard_exports.IsEqual(types.length, 0) ? Never() : Union(types);
  return result2;
}
var init_evaluate2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/evaluate.mjs"() {
    init_guard2();
    init_dependent();
    init_enum();
    init_literal();
    init_intersect();
    init_never();
    init_template_literal();
    init_union();
    init_distribute();
    init_broaden();
    init_operation();
    init_decode();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_enum.mjs
function FromEnumKey(values, value) {
  const unionKey = EvaluateEnum(values);
  const result2 = FromKey(unionKey, value);
  return result2;
}
var init_from_key_enum = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_enum.mjs"() {
    init_from_key();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_integer.mjs
function FromIntegerKey(_key, value) {
  const result2 = CreateRecord(IntegerKey, value);
  return result2;
}
var init_from_key_integer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_integer.mjs"() {
    init_record();
    init_record_create();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_intersect.mjs
function FromIntersectKey(types, value) {
  const evaluatedKey = EvaluateIntersect(types);
  const result2 = FromKey(evaluatedKey, value);
  return result2;
}
var init_from_key_intersect = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_intersect.mjs"() {
    init_evaluate2();
    init_from_key();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_literal.mjs
function FromLiteralKey(key, value) {
  return guard_exports.IsString(key) || guard_exports.IsNumber(key) ? _Object_({ [key]: value }) : guard_exports.IsEqual(key, false) ? _Object_({ false: value }) : guard_exports.IsEqual(key, true) ? _Object_({ true: value }) : _Object_({});
}
var init_from_key_literal = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_literal.mjs"() {
    init_guard2();
    init_object();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_number.mjs
function FromNumberKey(_key, value) {
  const result2 = CreateRecord(NumberKey, value);
  return result2;
}
var init_from_key_number = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_number.mjs"() {
    init_record();
    init_record_create();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_string.mjs
function FromStringKey(key, value) {
  return guard_exports.HasPropertyKey(key, "pattern") && (guard_exports.IsString(key.pattern) || key.pattern instanceof RegExp) ? CreateRecord(key.pattern.toString(), value) : CreateRecord(StringKey, value);
}
var init_from_key_string = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_string.mjs"() {
    init_guard2();
    init_record();
    init_record_create();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_template_literal.mjs
function FromTemplateKey(pattern, value) {
  const types = ParsePatternIntoTypes(pattern);
  const finite = IsTemplateLiteralFinite(types);
  const result2 = finite ? FromKey(EvaluateTemplateLiteral(pattern), value) : CreateRecord(pattern, value);
  return result2;
}
var init_from_key_template_literal = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_template_literal.mjs"() {
    init_from_key();
    init_pattern();
    init_is_finite();
    init_evaluate2();
    init_record_create();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/flatten.mjs
function FlattenType(type) {
  const result2 = IsUnion(type) ? Flatten(type.anyOf) : [type];
  return result2;
}
function Flatten(types) {
  return types.reduce((result2, type) => {
    return [...result2, ...FlattenType(type)];
  }, []);
}
var init_flatten = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/flatten.mjs"() {
    init_union();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_union.mjs
function StringOrNumberCheck(types) {
  return types.some((type) => IsString3(type) || IsNumber3(type) || IsInteger2(type));
}
function TryBuildRecord(types, value) {
  return guard_exports.IsEqual(StringOrNumberCheck(types), true) ? CreateRecord(StringKey, value) : void 0;
}
function CreateProperties(types, value) {
  return types.reduce((result2, left) => {
    return IsLiteral(left) && (guard_exports.IsString(left.const) || guard_exports.IsNumber(left.const)) ? { ...result2, [left.const]: value } : result2;
  }, {});
}
function CreateObject(types, value) {
  const properties = CreateProperties(types, value);
  const result2 = _Object_(properties);
  return result2;
}
function FromUnionKey(types, value) {
  const flattened = Flatten(types);
  const record4 = TryBuildRecord(flattened, value);
  return IsSchema(record4) ? record4 : CreateObject(flattened, value);
}
var init_from_key_union = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key_union.mjs"() {
    init_guard2();
    init_schema();
    init_literal();
    init_number();
    init_integer();
    init_object();
    init_string2();
    init_record();
    init_flatten();
    init_record_create();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key.mjs
function FromKey(key, value) {
  const result2 = IsAny(key) ? FromAnyKey(value) : IsBoolean3(key) ? FromBooleanKey(value) : IsEnum(key) ? FromEnumKey(key.enum, value) : IsInteger2(key) ? FromIntegerKey(key, value) : IsIntersect(key) ? FromIntersectKey(key.allOf, value) : IsLiteral(key) ? FromLiteralKey(key.const, value) : IsNumber3(key) ? FromNumberKey(key, value) : IsUnion(key) ? FromUnionKey(key.anyOf, value) : IsString3(key) ? FromStringKey(key, value) : IsTemplateLiteral(key) ? FromTemplateKey(key.pattern, value) : _Object_({});
  return result2;
}
var init_from_key = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/from_key.mjs"() {
    init_any();
    init_boolean();
    init_enum();
    init_intersect();
    init_integer();
    init_literal();
    init_number();
    init_object();
    init_string2();
    init_template_literal();
    init_union();
    init_from_key_any();
    init_from_key_boolean();
    init_from_key_enum();
    init_from_key_integer();
    init_from_key_intersect();
    init_from_key_literal();
    init_from_key_number();
    init_from_key_string();
    init_from_key_template_literal();
    init_from_key_union();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/instantiate.mjs
function RecordAction(key, value, options) {
  const result2 = CanInstantiate([key]) ? memory_exports.Update(FromKey(key, value), {}, options) : RecordDeferred(key, value, options);
  return result2;
}
function RecordInstantiate(context, state, key, value, options) {
  const instantiatedKey = InstantiateType(context, state, key);
  const instantiatedValue = InstantiateType(context, state, value);
  return RecordAction(instantiatedKey, instantiatedValue, options);
}
var init_instantiate = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/instantiate.mjs"() {
    init_memory2();
    init_record();
    init_from_key();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/record.mjs
function RecordDeferred(key, value, options = {}) {
  return Deferred("Record", [key, value], options);
}
function Record(key, value, options = {}) {
  return RecordAction(key, value, options);
}
function RecordFromPattern(pattern, value) {
  return CreateRecord(pattern, value);
}
function RecordPatternToType(pattern) {
  const result2 = guard_exports.IsEqual(pattern, StringKey) ? String2() : guard_exports.IsEqual(pattern, IntegerKey) ? Integer() : guard_exports.IsEqual(pattern, NumberKey) ? Number2() : TemplateLiteralDecodeUnsafe(pattern);
  return result2;
}
function RecordPattern(type) {
  return guard_exports.Keys(type.patternProperties)[0];
}
function RecordKey(type) {
  const pattern = RecordPattern(type);
  const result2 = RecordPatternToType(pattern);
  return result2;
}
function RecordValue(type) {
  return type.patternProperties[RecordPattern(type)];
}
function IsRecord(value) {
  return IsKind(value, "Record");
}
var IntegerKey, NumberKey, StringKey;
var init_record = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/record.mjs"() {
    init_memory2();
    init_guard2();
    init_schema();
    init_integer();
    init_number();
    init_string2();
    init_deferred();
    init_decode();
    init_record_create();
    init_instantiate();
    IntegerKey = `^${IntegerPattern}$`;
    NumberKey = `^${NumberPattern}$`;
    StringKey = `^${StringPattern}$`;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/rest.mjs
function Rest(type) {
  return memory_exports.Create({ "~kind": "Rest" }, { type: "rest", items: type }, {});
}
function IsRest(value) {
  return IsKind(value, "Rest");
}
var init_rest = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/rest.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/static.mjs
var init_static = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/static.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/this.mjs
function This(options) {
  return memory_exports.Create({ ["~kind"]: "This" }, { $ref: "#" }, options);
}
function IsThis(value) {
  return IsKind(value, "This");
}
var init_this = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/this.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/undefined.mjs
function Undefined(options) {
  return memory_exports.Create({ "~kind": "Undefined" }, { type: "undefined" }, options);
}
function IsUndefined2(value) {
  return IsKind(value, "Undefined");
}
var init_undefined = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/undefined.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/void.mjs
function Void(options) {
  return memory_exports.Create({ "~kind": "Void" }, { type: "void" }, options);
}
function IsVoid(value) {
  return IsKind(value, "Void");
}
var init_void = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/void.mjs"() {
    init_memory2();
    init_schema();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/index.mjs
var init_types = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/index.mjs"() {
    init_codec();
    init_immutable();
    init_optional();
    init_readonly();
    init_refine();
    init_any();
    init_array();
    init_bigint();
    init_boolean();
    init_call();
    init_constructor();
    init_cyclic();
    init_deferred();
    init_enum();
    init_function();
    init_generic();
    init_identifier();
    init_dependent();
    init_infer();
    init_integer();
    init_intersect();
    init_literal();
    init_never();
    init_null();
    init_number();
    init_unknown();
    init_symbol();
    init_object();
    init_parameter();
    init_properties();
    init_record();
    init_ref();
    init_rest();
    init_schema();
    init_static();
    init_string2();
    init_symbol();
    init_template_literal();
    init_this();
    init_tuple();
    init_undefined();
    init_union();
    init_unknown();
    init_unsafe();
    init_void();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/mapping.mjs
function IntrinsicOrCall(ref, parameters) {
  return guard_exports.IsEqual(ref, "Array") ? _Array_(parameters[0]) : guard_exports.IsEqual(ref, "Capitalize") ? CapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ConstructorParameters") ? ConstructorParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Evaluate") ? EvaluateDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Exclude") ? ExcludeDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Extract") ? ExtractDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Index") ? IndexDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "InstanceType") ? InstanceTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Lowercase") ? LowercaseDeferred(parameters[0]) : guard_exports.IsEqual(ref, "NonNullable") ? NonNullableDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Omit") ? OmitDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Parameters") ? ParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Partial") ? PartialDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Pick") ? PickDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Readonly") ? ReadonlyObjectDeferred(parameters[0]) : guard_exports.IsEqual(ref, "KeyOf") ? KeyOfDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Record") ? RecordDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Required") ? RequiredDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ReturnType") ? ReturnTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uncapitalize") ? UncapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uppercase") ? UppercaseDeferred(parameters[0]) : CallConstruct(Ref(ref), parameters);
}
function Unreachable2() {
  throw Error("Unreachable");
}
function GenericParameterExtendsEqualsMapping(input) {
  return Parameter(input[0], input[2], input[4]);
}
function GenericParameterExtendsMapping(input) {
  return Parameter(input[0], input[2], input[2]);
}
function GenericParameterEqualsMapping(input) {
  return Parameter(input[0], Unknown(), input[2]);
}
function GenericParameterIdentifierMapping(input) {
  return Parameter(input, Unknown(), Unknown());
}
function GenericParameterMapping(input) {
  return input;
}
function GenericParameterListMapping(input) {
  return Delimited(input);
}
function GenericParametersMapping(input) {
  return input[1];
}
function GenericCallArgumentListMapping(input) {
  return Delimited(input);
}
function GenericCallArgumentsMapping(input) {
  return input[1];
}
function GenericCallMapping(input) {
  return IntrinsicOrCall(input[0], input[1]);
}
function OptionalSemiColonMapping(input) {
  return null;
}
function KeywordStringMapping(input) {
  return String2();
}
function KeywordNumberMapping(input) {
  return Number2();
}
function KeywordBooleanMapping(input) {
  return Boolean2();
}
function KeywordUndefinedMapping(input) {
  return Undefined();
}
function KeywordNullMapping(input) {
  return Null();
}
function KeywordIntegerMapping(input) {
  return Integer();
}
function KeywordBigIntMapping(input) {
  return BigInt2();
}
function KeywordUnknownMapping(input) {
  return Unknown();
}
function KeywordAnyMapping(input) {
  return Any();
}
function KeywordObjectMapping(input) {
  return _Object_({});
}
function KeywordNeverMapping(input) {
  return Never();
}
function KeywordSymbolMapping(input) {
  return Symbol2();
}
function KeywordVoidMapping(input) {
  return Void();
}
function KeywordThisMapping(input) {
  return This();
}
function LiteralBigIntMapping(input) {
  return Literal(BigInt(input));
}
function LiteralBooleanMapping(input) {
  return Literal(guard_exports.IsEqual(input, "true"));
}
function LiteralNumberMapping(input) {
  return Literal(parseFloat(input));
}
function LiteralStringMapping(input) {
  return Literal(input);
}
function TemplateInterpolateMapping(input) {
  return input[1];
}
function TemplateSpanMapping(input) {
  return Literal(input);
}
function TemplateBodyMapping(input) {
  return guard_exports.IsEqual(input.length, 3) ? [input[0], input[1], ...input[2]] : [input[0]];
}
function TemplateLiteralTypesMapping(input) {
  return input[1];
}
function TemplateLiteralMapping(input) {
  return TemplateLiteralDeferred(input);
}
function DependentMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? Dependent(input[1], input[3], input[5]) : Dependent(input[1], input[3], Unknown());
}
function KeyOfMapping(input) {
  return input.length > 0;
}
function IndexArrayMapping(input) {
  return input.reduce((result2, current) => {
    return guard_exports.IsEqual(current.length, 3) ? [...result2, [current[1]]] : [...result2, []];
  }, []);
}
function ExtendsMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? [input[1], input[3], input[5]] : [];
}
function BaseMapping(input) {
  return guard_exports.IsArray(input) && guard_exports.IsEqual(input.length, 3) ? input[1] : input;
}
function WithMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function FactorIndexArray(Type2, indexArray) {
  return indexArray.reduce((result2, left) => {
    const _left = left;
    return guard_exports.IsEqual(_left.length, 1) ? IndexDeferred(result2, _left[0]) : guard_exports.IsEqual(_left.length, 0) ? _Array_(result2) : Unreachable2();
  }, Type2);
}
function FactorExtends(type, extend) {
  return guard_exports.IsEqual(extend.length, 3) ? ConditionalDeferred(type, extend[0], extend[1], extend[2]) : type;
}
function FactorWith(type, withClause) {
  return guard_exports.IsArray(withClause) && guard_exports.IsEqual(withClause.length, 0) ? type : WithDeferred(type, withClause);
}
function FactorMapping(input) {
  const [keyOf, type, indexArray, extend, withClause] = input;
  return FactorWith(keyOf ? FactorExtends(KeyOfDeferred(FactorIndexArray(type, indexArray)), extend) : FactorExtends(FactorIndexArray(type, indexArray), extend), withClause);
}
function ExprBinaryMapping(left, rest) {
  return guard_exports.IsEqual(rest.length, 3) ? (() => {
    const [operator, right, next] = rest;
    const Schema = ExprBinaryMapping(right, next);
    if (guard_exports.IsEqual(operator, "&")) {
      return IsIntersect(Schema) ? Intersect([left, ...Schema.allOf]) : Intersect([left, Schema]);
    }
    if (guard_exports.IsEqual(operator, "|")) {
      return IsUnion(Schema) ? Union([left, ...Schema.anyOf]) : Union([left, Schema]);
    }
    Unreachable2();
  })() : left;
}
function ExprTermTailMapping(input) {
  return input;
}
function ExprTermMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprTailMapping(input) {
  return input;
}
function ExprMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprReadonlyMapping(input) {
  return AddImmutableDeferred(input[1]);
}
function ExprPipeMapping(input) {
  return input[1];
}
function GenericTypeMapping(input) {
  return Generic(input[0], input[2]);
}
function InferTypeMapping(input) {
  return guard_exports.IsEqual(input.length, 4) ? Infer(input[1], input[3]) : guard_exports.IsEqual(input.length, 2) ? Infer(input[1], Unknown()) : Unreachable2();
}
function TypeMapping(input) {
  return input;
}
function PropertyKeyNumberMapping(input) {
  return `${input}`;
}
function PropertyKeyIdentMapping(input) {
  return input;
}
function PropertyKeyQuotedMapping(input) {
  return input;
}
function PropertyKeyIndexMapping(input) {
  return IsInteger2(input[3]) ? IntegerKey : IsNumber3(input[3]) ? NumberKey : IsSymbol2(input[3]) ? StringKey : IsString3(input[3]) ? StringKey : Unreachable2();
}
function PropertyKeyMapping(input) {
  return input;
}
function ReadonlyMapping(input) {
  return input.length > 0;
}
function OptionalMapping(input) {
  return input.length > 0;
}
function PropertyMapping(input) {
  const [isReadonly, key, isOptional, _colon, type] = input;
  return {
    [key]: isReadonly && isOptional ? AddReadonlyDeferred(AddOptionalDeferred(type)) : isReadonly && !isOptional ? AddReadonlyDeferred(type) : !isReadonly && isOptional ? AddOptionalDeferred(type) : type
  };
}
function PropertyDelimiterMapping(input) {
  return input;
}
function PropertyListMapping(input) {
  return Delimited(input);
}
function PropertiesReduce(propertyList) {
  return propertyList.reduce((result2, left) => {
    const isPatternProperties = guard_exports.HasPropertyKey(left, IntegerKey) || guard_exports.HasPropertyKey(left, NumberKey) || guard_exports.HasPropertyKey(left, StringKey);
    return isPatternProperties ? [result2[0], memory_exports.Assign(result2[1], left)] : [memory_exports.Assign(result2[0], left), result2[1]];
  }, [{}, {}]);
}
function PropertiesMapping(input) {
  return PropertiesReduce(input[1]);
}
function _Object_Mapping(input) {
  const [properties, patternProperties] = input;
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return _Object_(properties, options);
}
function ElementNamedMapping(input) {
  return guard_exports.IsEqual(input.length, 5) ? AddReadonlyDeferred(AddOptionalDeferred(input[4])) : guard_exports.IsEqual(input.length, 3) ? input[2] : guard_exports.IsEqual(input.length, 4) ? guard_exports.IsEqual(input[2], "readonly") ? AddReadonlyDeferred(input[3]) : AddOptionalDeferred(input[3]) : Unreachable2();
}
function ElementReadonlyOptionalMapping(input) {
  return AddReadonlyDeferred(AddOptionalDeferred(input[1]));
}
function ElementReadonlyMapping(input) {
  return AddReadonlyDeferred(input[1]);
}
function ElementOptionalMapping(input) {
  return AddOptionalDeferred(input[0]);
}
function ElementBaseMapping(input) {
  return input;
}
function ElementMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ElementListMapping(input) {
  return Delimited(input);
}
function _Tuple_Mapping(input) {
  return Tuple(input[1]);
}
function ParameterReadonlyOptionalMapping(input) {
  return AddReadonlyDeferred(AddOptionalDeferred(input[4]));
}
function ParameterReadonlyMapping(input) {
  return AddReadonlyDeferred(input[3]);
}
function ParameterOptionalMapping(input) {
  return AddOptionalDeferred(input[3]);
}
function ParameterTypeMapping(input) {
  return input[2];
}
function ParameterBaseMapping(input) {
  return input;
}
function ParameterMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ParameterListMapping(input) {
  return Delimited(input);
}
function _Function_Mapping(input) {
  return _Function_(input[1], input[4]);
}
function _Constructor_Mapping(input) {
  return Constructor(input[2], input[5]);
}
function ApplyReadonly(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveReadonlyDeferred(type) : guard_exports.IsEqual(state, "add") ? AddReadonlyDeferred(type) : type;
}
function MappedReadonlyMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function ApplyOptional(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveOptionalDeferred(type) : guard_exports.IsEqual(state, "add") ? AddOptionalDeferred(type) : type;
}
function MappedOptionalMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function MappedAsMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? [input[1]] : [];
}
function _Mapped_Mapping(input) {
  return guard_exports.IsArray(input[6]) && guard_exports.IsEqual(input[6].length, 1) ? MappedDeferred(Identifier(input[3]), input[5], input[6][0], ApplyReadonly(input[1], ApplyOptional(input[8], input[10]))) : MappedDeferred(Identifier(input[3]), input[5], Ref(input[3]), ApplyReadonly(input[1], ApplyOptional(input[8], input[10])));
}
function ReferenceMapping(input) {
  return Ref(input);
}
function WithBigIntMapping(input) {
  return BigInt(input);
}
function WithNumberMapping(input) {
  return parseFloat(input);
}
function WithBooleanMapping(input) {
  return guard_exports.IsEqual(input, "true");
}
function WithStringMapping(input) {
  return input;
}
function WithNullMapping(input) {
  return null;
}
function WithUndefinedMapping(input) {
  return void 0;
}
function WithPropertyMapping(input) {
  return { [input[0]]: input[2] };
}
function WithPropertyListMapping(input) {
  return Delimited(input);
}
function WithObjectMappingReduce(propertyList) {
  return propertyList.reduce((result2, left) => {
    return memory_exports.Assign(result2, left);
  }, {});
}
function WithObjectMapping(input) {
  return WithObjectMappingReduce(input[1]);
}
function WithElementListMapping(input) {
  return Delimited(input);
}
function WithArrayMapping(input) {
  return input[1];
}
function WithValueMapping(input) {
  return input;
}
function PatternBigIntMapping(input) {
  return BigInt2();
}
function PatternStringMapping(input) {
  return String2();
}
function PatternNumberMapping(input) {
  return Number2();
}
function PatternIntegerMapping(input) {
  return Integer();
}
function PatternNeverMapping(input) {
  return Never();
}
function PatternTextMapping(input) {
  return Literal(input);
}
function PatternBaseMapping(input) {
  return input;
}
function PatternGroupMapping(input) {
  return Union(input[1]);
}
function PatternUnionMapping(input) {
  return input.length === 3 ? [...input[0], ...input[2]] : input.length === 1 ? [...input[0]] : [];
}
function PatternTermMapping(input) {
  return [input[0], ...input[1]];
}
function PatternBodyMapping(input) {
  return input;
}
function PatternMapping(input) {
  return input[1];
}
function InterfaceDeclarationHeritageListMapping(input) {
  return Delimited(input);
}
function InterfaceDeclarationHeritageMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function InterfaceDeclarationGenericMapping(input) {
  const parameters = input[2];
  const heritage = input[3];
  const [properties, patternProperties] = input[4];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: Generic(parameters, InterfaceDeferred(heritage, properties, options)) };
}
function InterfaceDeclarationMapping(input) {
  const heritage = input[2];
  const [properties, patternProperties] = input[3];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: InterfaceDeferred(heritage, properties, options) };
}
function TypeAliasDeclarationGenericMapping(input) {
  return { [input[1]]: Generic(input[2], input[4]) };
}
function TypeAliasDeclarationMapping(input) {
  return { [input[1]]: input[3] };
}
function ExportKeywordMapping(input) {
  return null;
}
function ModuleDeclarationDelimiterMapping(input) {
  return input;
}
function ModuleDeclarationListMapping(input) {
  return PropertiesReduce(Delimited(input));
}
function ModuleDeclarationMapping(input) {
  return input[1];
}
function ModuleMapping(input) {
  const moduleDeclaration = input[0];
  const moduleDeclarationList = input[1];
  return ModuleDeferred(memory_exports.Assign(moduleDeclaration, moduleDeclarationList[0]));
}
function ScriptMapping(input) {
  return input;
}
var DelimitedDecode, Delimited;
var init_mapping = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/mapping.mjs"() {
    init_memory2();
    init_guard2();
    init_types();
    init_action();
    DelimitedDecode = (input, result2 = []) => {
      return input.reduce((result3, left) => {
        return guard_exports.IsArray(left) && guard_exports.IsEqual(left.length, 2) ? [...result3, left[0]] : [...result3, left];
      }, []);
    };
    Delimited = (input) => {
      const [left, right] = input;
      return DelimitedDecode([...left, ...right]);
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/guard.mjs
var init_guard3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/guard.mjs"() {
    init_guard();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/match.mjs
function IsMatch(value) {
  return IsEqual(value.length, 2);
}
function Match2(input, ok, fail4) {
  return IsMatch(input) ? ok(input[0], input[1]) : fail4();
}
var init_match = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/match.mjs"() {
    init_guard3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/take.mjs
function TakeVariant(variant, input) {
  return IsEqual(input.indexOf(variant), 0) ? [variant, input.slice(variant.length)] : [];
}
function Take(variants, input) {
  for (let i = 0; i < variants.length; i++) {
    const result2 = TakeVariant(variants[i], input);
    if (IsMatch(result2))
      return result2;
  }
  return [];
}
var init_take = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/take.mjs"() {
    init_match();
    init_guard3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/char.mjs
function Range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, i) => String.fromCharCode(start + i));
}
var Alpha, Zero, NonZero, Digit, WhiteSpace, NewLine, UnderScore, Dot, DollarSign, Hyphen;
var init_char = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/char.mjs"() {
    Alpha = [
      ...Range(97, 122),
      // Lowercase
      ...Range(65, 90)
      // Uppercase
    ];
    Zero = "0";
    NonZero = Range(49, 57);
    Digit = [Zero, ...NonZero];
    WhiteSpace = " ";
    NewLine = "\n";
    UnderScore = "_";
    Dot = ".";
    DollarSign = "$";
    Hyphen = "-";
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/trim.mjs
function DiscardMultilineComment(input) {
  const index = input.indexOf(CloseComment);
  const result2 = IsEqual(index, -1) ? "" : input.slice(index + 2);
  return result2;
}
function DiscardLineComment(input) {
  const index = input.indexOf(NewLine);
  const result2 = IsEqual(index, -1) ? "" : input.slice(index);
  return result2;
}
function TrimStartUntilNewline(input) {
  return input.replace(/^[ \t\r\f\v]+/, "");
}
function TrimWhitespace(input) {
  const trimmed = TrimStartUntilNewline(input);
  return trimmed.startsWith(OpenComment) ? TrimWhitespace(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? TrimWhitespace(DiscardLineComment(trimmed.slice(2))) : trimmed;
}
function Trim(input) {
  const trimmed = input.trimStart();
  return trimmed.startsWith(OpenComment) ? Trim(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? Trim(DiscardLineComment(trimmed.slice(2))) : trimmed;
}
var LineComment, OpenComment, CloseComment;
var init_trim = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/trim.mjs"() {
    init_guard3();
    init_char();
    LineComment = "//";
    OpenComment = "/*";
    CloseComment = "*/";
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/optional.mjs
function Optional2(value, input) {
  return Match2(Take([value], input), (Optional4, Rest2) => [Optional4, Rest2], () => ["", input]);
}
var init_optional2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/optional.mjs"() {
    init_match();
    init_take();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/many.mjs
function IsDiscard(discard, input) {
  return discard.includes(input);
}
function Many(allowed, discard, input, result2 = "") {
  return Match2(Take(allowed, input), (Char, Rest2) => IsDiscard(discard, Char) ? Many(allowed, discard, Rest2, result2) : Many(allowed, discard, Rest2, `${result2}${Char}`), () => [result2, input]);
}
var init_many = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/internal/many.mjs"() {
    init_match();
    init_take();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/unsigned_integer.mjs
function TakeNonZero(input) {
  return Take(NonZero, input);
}
function TakeDigits(input) {
  return Many(AllowedDigits, [UnderScore], input);
}
function TakeUnsignedInteger(input) {
  return Match2(Take([Zero], input), (Zero2, ZeroRest) => [Zero2, ZeroRest], () => Match2(
    TakeNonZero(input),
    (NonZero2, NonZeroRest) => Match2(TakeDigits(NonZeroRest), (Digits, DigitsRest) => [`${NonZero2}${Digits}`, DigitsRest], () => []),
    // fail: did not match Digits
    () => []
  ));
}
function UnsignedInteger(input) {
  return TakeUnsignedInteger(Trim(input));
}
var AllowedDigits;
var init_unsigned_integer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/unsigned_integer.mjs"() {
    init_match();
    init_trim();
    init_take();
    init_many();
    init_char();
    init_char();
    init_char();
    init_char();
    AllowedDigits = [...Digit, UnderScore];
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/integer.mjs
function TakeSign(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedInteger(input) {
  return Match2(
    TakeSign(input),
    (Sign, SignRest) => Match2(UnsignedInteger(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Integer2(input) {
  return TakeSignedInteger(Trim(input));
}
var init_integer2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/integer.mjs"() {
    init_match();
    init_trim();
    init_optional2();
    init_char();
    init_unsigned_integer();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/bigint.mjs
function TakeBigInt(input) {
  return Match2(
    Integer2(input),
    (Integer3, IntegerRest) => Match2(Take(["n"], IntegerRest), (_N, NRest) => [`${Integer3}`, NRest], () => []),
    // fail: did not match 'n'
    () => []
  );
}
function BigInt3(input) {
  return TakeBigInt(input);
}
var init_bigint2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/bigint.mjs"() {
    init_match();
    init_take();
    init_integer2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/const.mjs
function TakeConst(const_, input) {
  return Take([const_], input);
}
function Const(const_, input) {
  return IsEqual(const_, "") ? ["", input] : const_.startsWith(NewLine) ? TakeConst(const_, TrimWhitespace(input)) : const_.startsWith(WhiteSpace) ? TakeConst(const_, input) : TakeConst(const_, Trim(input));
}
var init_const = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/const.mjs"() {
    init_guard3();
    init_trim();
    init_trim();
    init_take();
    init_char();
    init_char();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/ident.mjs
function TakeInitial(input) {
  return Take(Initial, input);
}
function TakeRemaining(input, result2 = "") {
  return Match2(Take(Remaining, input), (Remaining2, RemainingRest) => TakeRemaining(RemainingRest, `${result2}${Remaining2}`), () => [result2, input]);
}
function TakeIdent(input) {
  return Match2(
    TakeInitial(input),
    (Initial2, InitialRest) => Match2(TakeRemaining(InitialRest), (Remaining2, RemainingRest) => [`${Initial2}${Remaining2}`, RemainingRest], () => []),
    // fail: did not match Remaining
    () => []
  );
}
function Ident(input) {
  return TakeIdent(Trim(input));
}
var Initial, Remaining;
var init_ident = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/ident.mjs"() {
    init_match();
    init_trim();
    init_take();
    init_char();
    init_char();
    init_char();
    init_char();
    Initial = [...Alpha, UnderScore, DollarSign];
    Remaining = [...Initial, ...Digit];
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/unsigned_number.mjs
function IsLeadingDot(input) {
  return IsMatch(Take([Dot], input));
}
function TakeFractional(input) {
  return Match2(Many(AllowedDigits2, [UnderScore], input), (Digits, DigitsRest) => IsEqual(Digits, "") ? [] : [Digits, DigitsRest], () => []);
}
function LeadingDot(input) {
  return Match2(
    Take([Dot], input),
    (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`0${Dot2}${Fractional}`, FractionalRest], () => []),
    // fail: did not match Fractional
    () => []
  );
}
function LeadingInteger(input) {
  return Match2(
    UnsignedInteger(input),
    (Integer3, IntegerRest) => Match2(
      Take([Dot], IntegerRest),
      (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`${Integer3}${Dot2}${Fractional}`, FractionalRest], () => [`${Integer3}`, DotRest]),
      // fail: did not match Fractional, use Integer
      () => [`${Integer3}`, IntegerRest]
    ),
    // fail: did not match Dot, use Integer
    () => []
  );
}
function TakeUnsignedNumber(input) {
  return IsLeadingDot(input) ? LeadingDot(input) : LeadingInteger(input);
}
function UnsignedNumber(input) {
  return TakeUnsignedNumber(Trim(input));
}
var AllowedDigits2;
var init_unsigned_number = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/unsigned_number.mjs"() {
    init_guard3();
    init_match();
    init_trim();
    init_take();
    init_many();
    init_char();
    init_char();
    init_unsigned_integer();
    AllowedDigits2 = [...Digit, UnderScore];
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/number.mjs
function TakeSign2(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedNumber(input) {
  return Match2(
    TakeSign2(input),
    (Sign, SignRest) => Match2(UnsignedNumber(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Number3(input) {
  return TakeSignedNumber(Trim(input));
}
var init_number2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/number.mjs"() {
    init_match();
    init_trim();
    init_optional2();
    init_char();
    init_unsigned_number();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/rest.mjs
var init_rest2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/rest.mjs"() {
    init_guard3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/until.mjs
function TakeOne(input) {
  const result2 = IsEqual(input, "") ? [] : [input.slice(0, 1), input.slice(1)];
  return result2;
}
function IsInputMatchSentinal(end, input) {
  return ShiftLeft(end, (left, right) => input.startsWith(left) ? true : IsInputMatchSentinal(right, input), () => false);
}
function Until(end, input, result2 = "") {
  return Match2(
    TakeOne(input),
    (One, Rest2) => IsInputMatchSentinal(end, input) ? [result2, input] : Until(end, Rest2, `${result2}${One}`),
    () => []
  );
}
var init_until = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/until.mjs"() {
    init_match();
    init_guard3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/span.mjs
function MultiLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, Rest3) => [`${Until2}`, Rest3], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function SingleLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([NewLine, end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, EndRest) => [`${Until2}`, EndRest], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function Span(start, end, multiLine, input) {
  return multiLine ? MultiLine(start, end, Trim(input)) : SingleLine(start, end, Trim(input));
}
var init_span = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/span.mjs"() {
    init_match();
    init_trim();
    init_char();
    init_take();
    init_until();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/string.mjs
function TakeInitial2(quotes, input) {
  return Take(quotes, input);
}
function TakeSpan(quote, input) {
  return Span(quote, quote, false, input);
}
function TakeString(quotes, input) {
  return Match2(TakeInitial2(quotes, input), (Initial2, InitialRest) => TakeSpan(Initial2, `${Initial2}${InitialRest}`), () => []);
}
function String3(quotes, input) {
  return TakeString(quotes, Trim(input));
}
var init_string3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/string.mjs"() {
    init_match();
    init_take();
    init_trim();
    init_span();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/until_1.mjs
function Until_1(end, input) {
  return Match2(Until(end, input), (Until2, UntilRest) => IsEqual(Until2, "") ? [] : [Until2, UntilRest], () => []);
}
var init_until_1 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/until_1.mjs"() {
    init_guard3();
    init_match();
    init_until();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/index.mjs
var init_token = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/token/index.mjs"() {
    init_bigint2();
    init_const();
    init_ident();
    init_integer2();
    init_number2();
    init_rest2();
    init_span();
    init_string3();
    init_unsigned_integer();
    init_unsigned_number();
    init_until_1();
    init_until();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/parser.mjs
var If, GenericParameterExtendsEquals, GenericParameterExtends, GenericParameterEquals, GenericParameterIdentifier, GenericParameter, GenericParameterList_0, GenericParameterList, GenericParameters, GenericCallArgumentList_0, GenericCallArgumentList, GenericCallArguments, GenericCall, OptionalSemiColon, KeywordString, KeywordNumber, KeywordBoolean, KeywordUndefined, KeywordNull, KeywordInteger, KeywordBigInt, KeywordUnknown, KeywordAny, KeywordObject, KeywordNever, KeywordSymbol, KeywordVoid, KeywordThis, TemplateInterpolate, TemplateSpan, TemplateBody, TemplateLiteralTypes, TemplateLiteral, Dependent2, LiteralBigInt, LiteralBoolean, LiteralNumber, LiteralString, KeyOf, IndexArray_0, IndexArray, Extends2, Base, With, Factor, ExprTermTail, ExprTerm, ExprTail, Expr, ExprReadonly, ExprPipe, GenericType, InferType, Type, PropertyKeyNumber, PropertyKeyIdent, PropertyKeyQuoted, PropertyKeyIndex, PropertyKey, Readonly2, Optional3, Property, PropertyDelimiter, PropertyList_0, PropertyList, Properties, _Object_2, ElementNamed, ElementReadonlyOptional, ElementReadonly, ElementOptional, ElementBase, Element, ElementList_0, ElementList, _Tuple_, ParameterReadonlyOptional, ParameterReadonly, ParameterOptional, ParameterType, ParameterBase, Parameter2, ParameterList_0, ParameterList, _Function_2, _Constructor_, MappedReadonly, MappedOptional, MappedAs, _Mapped_, Reference, WithBigInt, WithNumber, WithBoolean, WithString, WithNull, WithUndefined, WithProperty, WithPropertyList_0, WithPropertyList, WithObject, WithElementList_0, WithElementList, WithArray, WithValue, PatternBigInt, PatternString, PatternNumber, PatternInteger, PatternNever, PatternText, PatternBase, PatternGroup, PatternUnion, PatternTerm, PatternBody, Pattern, InterfaceDeclarationHeritageList_0, InterfaceDeclarationHeritageList, InterfaceDeclarationHeritage, InterfaceDeclarationGeneric, InterfaceDeclaration, TypeAliasDeclarationGeneric, TypeAliasDeclaration, ExportKeyword, ModuleDeclarationDelimiter, ModuleDeclarationList_0, ModuleDeclarationList, ModuleDeclaration, Module, Script;
var init_parser = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/parser.mjs"() {
    init_mapping();
    init_token();
    If = (result2, left, right = () => []) => result2.length === 2 ? left(result2) : right();
    GenericParameterExtendsEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [GenericParameterExtendsEqualsMapping(_0), input2]);
    GenericParameterExtends = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterExtendsMapping(_0), input2]);
    GenericParameterEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterEqualsMapping(_0), input2]);
    GenericParameterIdentifier = (input) => If(Ident(input), ([_0, input2]) => [GenericParameterIdentifierMapping(_0), input2]);
    GenericParameter = (input) => If(If(GenericParameterExtendsEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterExtends(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterIdentifier(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [GenericParameterMapping(_0), input2]);
    GenericParameterList_0 = (input, result2 = []) => If(If(GenericParameter(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericParameterList_0(input2, [...result2, _0]), () => [result2, input]);
    GenericParameterList = (input) => If(If(GenericParameterList_0(input), ([_0, input2]) => If(If(If(GenericParameter(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericParameterListMapping(_0), input2]);
    GenericParameters = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericParameterList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParametersMapping(_0), input2]);
    GenericCallArgumentList_0 = (input, result2 = []) => If(If(Type(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericCallArgumentList_0(input2, [...result2, _0]), () => [result2, input]);
    GenericCallArgumentList = (input) => If(If(GenericCallArgumentList_0(input), ([_0, input2]) => If(If(If(Type(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericCallArgumentListMapping(_0), input2]);
    GenericCallArguments = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericCallArgumentList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericCallArgumentsMapping(_0), input2]);
    GenericCall = (input) => If(If(Ident(input), ([_0, input2]) => If(GenericCallArguments(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericCallMapping(_0), input2]);
    OptionalSemiColon = (input) => If(If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalSemiColonMapping(_0), input2]);
    KeywordString = (input) => If(Const("string", input), ([_0, input2]) => [KeywordStringMapping(_0), input2]);
    KeywordNumber = (input) => If(Const("number", input), ([_0, input2]) => [KeywordNumberMapping(_0), input2]);
    KeywordBoolean = (input) => If(Const("boolean", input), ([_0, input2]) => [KeywordBooleanMapping(_0), input2]);
    KeywordUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [KeywordUndefinedMapping(_0), input2]);
    KeywordNull = (input) => If(Const("null", input), ([_0, input2]) => [KeywordNullMapping(_0), input2]);
    KeywordInteger = (input) => If(Const("integer", input), ([_0, input2]) => [KeywordIntegerMapping(_0), input2]);
    KeywordBigInt = (input) => If(Const("bigint", input), ([_0, input2]) => [KeywordBigIntMapping(_0), input2]);
    KeywordUnknown = (input) => If(Const("unknown", input), ([_0, input2]) => [KeywordUnknownMapping(_0), input2]);
    KeywordAny = (input) => If(Const("any", input), ([_0, input2]) => [KeywordAnyMapping(_0), input2]);
    KeywordObject = (input) => If(Const("object", input), ([_0, input2]) => [KeywordObjectMapping(_0), input2]);
    KeywordNever = (input) => If(Const("never", input), ([_0, input2]) => [KeywordNeverMapping(_0), input2]);
    KeywordSymbol = (input) => If(Const("symbol", input), ([_0, input2]) => [KeywordSymbolMapping(_0), input2]);
    KeywordVoid = (input) => If(Const("void", input), ([_0, input2]) => [KeywordVoidMapping(_0), input2]);
    KeywordThis = (input) => If(Const("this", input), ([_0, input2]) => [KeywordThisMapping(_0), input2]);
    TemplateInterpolate = (input) => If(If(Const("${", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateInterpolateMapping(_0), input2]);
    TemplateSpan = (input) => If(Until(["${", "`"], input), ([_0, input2]) => [TemplateSpanMapping(_0), input2]);
    TemplateBody = (input) => If(If(If(TemplateSpan(input), ([_0, input2]) => If(TemplateInterpolate(input2), ([_1, input3]) => If(TemplateBody(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [TemplateBodyMapping(_0), input2]);
    TemplateLiteralTypes = (input) => If(If(Const("`", input), ([_0, input2]) => If(TemplateBody(input2), ([_1, input3]) => If(Const("`", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateLiteralTypesMapping(_0), input2]);
    TemplateLiteral = (input) => If(TemplateLiteralTypes(input), ([_0, input2]) => [TemplateLiteralMapping(_0), input2]);
    Dependent2 = (input) => If(If(If(Const("if", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => If(Const("else", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If(If(Const("if", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [DependentMapping(_0), input2]);
    LiteralBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [LiteralBigIntMapping(_0), input2]);
    LiteralBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [LiteralBooleanMapping(_0), input2]);
    LiteralNumber = (input) => If(Number3(input), ([_0, input2]) => [LiteralNumberMapping(_0), input2]);
    LiteralString = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [LiteralStringMapping(_0), input2]);
    KeyOf = (input) => If(If(If(Const("keyof", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [KeyOfMapping(_0), input2]);
    IndexArray_0 = (input, result2 = []) => If(If(If(Const("[", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(Const("[", input), ([_0, input2]) => If(Const("]", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => IndexArray_0(input2, [...result2, _0]), () => [result2, input]);
    IndexArray = (input) => If(IndexArray_0(input), ([_0, input2]) => [IndexArrayMapping(_0), input2]);
    Extends2 = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("?", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => If(Const(":", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExtendsMapping(_0), input2]);
    Base = (input) => If(If(If(Const("(", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(KeywordString(input), ([_0, input2]) => [_0, input2], () => If(KeywordNumber(input), ([_0, input2]) => [_0, input2], () => If(KeywordBoolean(input), ([_0, input2]) => [_0, input2], () => If(KeywordUndefined(input), ([_0, input2]) => [_0, input2], () => If(KeywordNull(input), ([_0, input2]) => [_0, input2], () => If(KeywordInteger(input), ([_0, input2]) => [_0, input2], () => If(KeywordBigInt(input), ([_0, input2]) => [_0, input2], () => If(KeywordUnknown(input), ([_0, input2]) => [_0, input2], () => If(KeywordAny(input), ([_0, input2]) => [_0, input2], () => If(KeywordObject(input), ([_0, input2]) => [_0, input2], () => If(KeywordNever(input), ([_0, input2]) => [_0, input2], () => If(KeywordSymbol(input), ([_0, input2]) => [_0, input2], () => If(KeywordVoid(input), ([_0, input2]) => [_0, input2], () => If(KeywordThis(input), ([_0, input2]) => [_0, input2], () => If(LiteralBigInt(input), ([_0, input2]) => [_0, input2], () => If(LiteralBoolean(input), ([_0, input2]) => [_0, input2], () => If(LiteralNumber(input), ([_0, input2]) => [_0, input2], () => If(LiteralString(input), ([_0, input2]) => [_0, input2], () => If(TemplateLiteral(input), ([_0, input2]) => [_0, input2], () => If(Dependent2(input), ([_0, input2]) => [_0, input2], () => If(_Object_2(input), ([_0, input2]) => [_0, input2], () => If(_Tuple_(input), ([_0, input2]) => [_0, input2], () => If(_Constructor_(input), ([_0, input2]) => [_0, input2], () => If(_Function_2(input), ([_0, input2]) => [_0, input2], () => If(_Mapped_(input), ([_0, input2]) => [_0, input2], () => If(GenericCall(input), ([_0, input2]) => [_0, input2], () => If(Reference(input), ([_0, input2]) => [_0, input2], () => [])))))))))))))))))))))))))))), ([_0, input2]) => [BaseMapping(_0), input2]);
    With = (input) => If(If(If(Const("with", input), ([_0, input2]) => If(WithObject(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithMapping(_0), input2]);
    Factor = (input) => If(If(KeyOf(input), ([_0, input2]) => If(Base(input2), ([_1, input3]) => If(IndexArray(input3), ([_2, input4]) => If(Extends2(input4), ([_3, input5]) => If(With(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [FactorMapping(_0), input2]);
    ExprTermTail = (input) => If(If(If(Const("&", input), ([_0, input2]) => If(Factor(input2), ([_1, input3]) => If(ExprTermTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTermTailMapping(_0), input2]);
    ExprTerm = (input) => If(If(Factor(input), ([_0, input2]) => If(ExprTermTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprTermMapping(_0), input2]);
    ExprTail = (input) => If(If(If(Const("|", input), ([_0, input2]) => If(ExprTerm(input2), ([_1, input3]) => If(ExprTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTailMapping(_0), input2]);
    Expr = (input) => If(If(ExprTerm(input), ([_0, input2]) => If(ExprTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprMapping(_0), input2]);
    ExprReadonly = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprReadonlyMapping(_0), input2]);
    ExprPipe = (input) => If(If(Const("|", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprPipeMapping(_0), input2]);
    GenericType = (input) => If(If(GenericParameters(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericTypeMapping(_0), input2]);
    InferType = (input) => If(If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("extends", input3), ([_2, input4]) => If(Expr(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InferTypeMapping(_0), input2]);
    Type = (input) => If(If(InferType(input), ([_0, input2]) => [_0, input2], () => If(ExprPipe(input), ([_0, input2]) => [_0, input2], () => If(ExprReadonly(input), ([_0, input2]) => [_0, input2], () => If(Expr(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [TypeMapping(_0), input2]);
    PropertyKeyNumber = (input) => If(Number3(input), ([_0, input2]) => [PropertyKeyNumberMapping(_0), input2]);
    PropertyKeyIdent = (input) => If(Ident(input), ([_0, input2]) => [PropertyKeyIdentMapping(_0), input2]);
    PropertyKeyQuoted = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [PropertyKeyQuotedMapping(_0), input2]);
    PropertyKeyIndex = (input) => If(If(Const("[", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(If(KeywordInteger(input4), ([_02, input5]) => [_02, input5], () => If(KeywordNumber(input4), ([_02, input5]) => [_02, input5], () => If(KeywordString(input4), ([_02, input5]) => [_02, input5], () => If(KeywordSymbol(input4), ([_02, input5]) => [_02, input5], () => [])))), ([_3, input5]) => If(Const("]", input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyKeyIndexMapping(_0), input2]);
    PropertyKey = (input) => If(If(PropertyKeyNumber(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIdent(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyQuoted(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIndex(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [PropertyKeyMapping(_0), input2]);
    Readonly2 = (input) => If(If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ReadonlyMapping(_0), input2]);
    Optional3 = (input) => If(If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalMapping(_0), input2]);
    Property = (input) => If(If(Readonly2(input), ([_0, input2]) => If(PropertyKey(input2), ([_1, input3]) => If(Optional3(input3), ([_2, input4]) => If(Const(":", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyMapping(_0), input2]);
    PropertyDelimiter = (input) => If(If(If(Const(",", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(",", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))))), ([_0, input2]) => [PropertyDelimiterMapping(_0), input2]);
    PropertyList_0 = (input, result2 = []) => If(If(Property(input), ([_0, input2]) => If(PropertyDelimiter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => PropertyList_0(input2, [...result2, _0]), () => [result2, input]);
    PropertyList = (input) => If(If(PropertyList_0(input), ([_0, input2]) => If(If(If(Property(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [PropertyListMapping(_0), input2]);
    Properties = (input) => If(If(Const("{", input), ([_0, input2]) => If(PropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PropertiesMapping(_0), input2]);
    _Object_2 = (input) => If(Properties(input), ([_0, input2]) => [_Object_Mapping(_0), input2]);
    ElementNamed = (input) => If(If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ElementNamedMapping(_0), input2]);
    ElementReadonlyOptional = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("?", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ElementReadonlyOptionalMapping(_0), input2]);
    ElementReadonly = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ElementReadonlyMapping(_0), input2]);
    ElementOptional = (input) => If(If(Type(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ElementOptionalMapping(_0), input2]);
    ElementBase = (input) => If(If(ElementNamed(input), ([_0, input2]) => [_0, input2], () => If(ElementReadonlyOptional(input), ([_0, input2]) => [_0, input2], () => If(ElementReadonly(input), ([_0, input2]) => [_0, input2], () => If(ElementOptional(input), ([_0, input2]) => [_0, input2], () => If(Type(input), ([_0, input2]) => [_0, input2], () => []))))), ([_0, input2]) => [ElementBaseMapping(_0), input2]);
    Element = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ElementBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ElementBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ElementMapping(_0), input2]);
    ElementList_0 = (input, result2 = []) => If(If(Element(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ElementList_0(input2, [...result2, _0]), () => [result2, input]);
    ElementList = (input) => If(If(ElementList_0(input), ([_0, input2]) => If(If(If(Element(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ElementListMapping(_0), input2]);
    _Tuple_ = (input) => If(If(Const("[", input), ([_0, input2]) => If(ElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_Tuple_Mapping(_0), input2]);
    ParameterReadonlyOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [ParameterReadonlyOptionalMapping(_0), input2]);
    ParameterReadonly = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterReadonlyMapping(_0), input2]);
    ParameterOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterOptionalMapping(_0), input2]);
    ParameterType = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ParameterTypeMapping(_0), input2]);
    ParameterBase = (input) => If(If(ParameterReadonlyOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterReadonly(input), ([_0, input2]) => [_0, input2], () => If(ParameterOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterType(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ParameterBaseMapping(_0), input2]);
    Parameter2 = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ParameterBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ParameterBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ParameterMapping(_0), input2]);
    ParameterList_0 = (input, result2 = []) => If(If(Parameter2(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ParameterList_0(input2, [...result2, _0]), () => [result2, input]);
    ParameterList = (input) => If(If(ParameterList_0(input), ([_0, input2]) => If(If(If(Parameter2(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ParameterListMapping(_0), input2]);
    _Function_2 = (input) => If(If(Const("(", input), ([_0, input2]) => If(ParameterList(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => If(Const("=>", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_Function_Mapping(_0), input2]);
    _Constructor_ = (input) => If(If(Const("new", input), ([_0, input2]) => If(Const("(", input2), ([_1, input3]) => If(ParameterList(input3), ([_2, input4]) => If(Const(")", input4), ([_3, input5]) => If(Const("=>", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_Constructor_Mapping(_0), input2]);
    MappedReadonly = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedReadonlyMapping(_0), input2]);
    MappedOptional = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedOptionalMapping(_0), input2]);
    MappedAs = (input) => If(If(If(Const("as", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [MappedAsMapping(_0), input2]);
    _Mapped_ = (input) => If(If(Const("{", input), ([_0, input2]) => If(MappedReadonly(input2), ([_1, input3]) => If(Const("[", input3), ([_2, input4]) => If(Ident(input4), ([_3, input5]) => If(Const("in", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => If(MappedAs(input7), ([_6, input8]) => If(Const("]", input8), ([_7, input9]) => If(MappedOptional(input9), ([_8, input10]) => If(Const(":", input10), ([_9, input11]) => If(Type(input11), ([_10, input12]) => If(OptionalSemiColon(input12), ([_11, input13]) => If(Const("}", input13), ([_12, input14]) => [[_0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12], input14]))))))))))))), ([_0, input2]) => [_Mapped_Mapping(_0), input2]);
    Reference = (input) => If(Ident(input), ([_0, input2]) => [ReferenceMapping(_0), input2]);
    WithBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [WithBigIntMapping(_0), input2]);
    WithNumber = (input) => If(Number3(input), ([_0, input2]) => [WithNumberMapping(_0), input2]);
    WithBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithBooleanMapping(_0), input2]);
    WithString = (input) => If(String3(['"', "'"], input), ([_0, input2]) => [WithStringMapping(_0), input2]);
    WithNull = (input) => If(Const("null", input), ([_0, input2]) => [WithNullMapping(_0), input2]);
    WithUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [WithUndefinedMapping(_0), input2]);
    WithProperty = (input) => If(If(PropertyKey(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(WithValue(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithPropertyMapping(_0), input2]);
    WithPropertyList_0 = (input, result2 = []) => If(If(WithProperty(input), ([_0, input2]) => If(PropertyDelimiter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithPropertyList_0(input2, [...result2, _0]), () => [result2, input]);
    WithPropertyList = (input) => If(If(WithPropertyList_0(input), ([_0, input2]) => If(If(If(WithProperty(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [WithPropertyListMapping(_0), input2]);
    WithObject = (input) => If(If(Const("{", input), ([_0, input2]) => If(WithPropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithObjectMapping(_0), input2]);
    WithElementList_0 = (input, result2 = []) => If(If(WithValue(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithElementList_0(input2, [...result2, _0]), () => [result2, input]);
    WithElementList = (input) => If(If(WithElementList_0(input), ([_0, input2]) => If(If(If(WithValue(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [WithElementListMapping(_0), input2]);
    WithArray = (input) => If(If(Const("[", input), ([_0, input2]) => If(WithElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithArrayMapping(_0), input2]);
    WithValue = (input) => If(If(WithBigInt(input), ([_0, input2]) => [_0, input2], () => If(WithNumber(input), ([_0, input2]) => [_0, input2], () => If(WithBoolean(input), ([_0, input2]) => [_0, input2], () => If(WithString(input), ([_0, input2]) => [_0, input2], () => If(WithNull(input), ([_0, input2]) => [_0, input2], () => If(WithUndefined(input), ([_0, input2]) => [_0, input2], () => If(WithObject(input), ([_0, input2]) => [_0, input2], () => If(WithArray(input), ([_0, input2]) => [_0, input2], () => [])))))))), ([_0, input2]) => [WithValueMapping(_0), input2]);
    PatternBigInt = (input) => If(Const("-?(?:0|[1-9][0-9]*)n", input), ([_0, input2]) => [PatternBigIntMapping(_0), input2]);
    PatternString = (input) => If(Const(".*", input), ([_0, input2]) => [PatternStringMapping(_0), input2]);
    PatternNumber = (input) => If(Const("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", input), ([_0, input2]) => [PatternNumberMapping(_0), input2]);
    PatternInteger = (input) => If(Const("-?(?:0|[1-9][0-9]*)", input), ([_0, input2]) => [PatternIntegerMapping(_0), input2]);
    PatternNever = (input) => If(Const("(?!)", input), ([_0, input2]) => [PatternNeverMapping(_0), input2]);
    PatternText = (input) => If(Until_1(["-?(?:0|[1-9][0-9]*)n", ".*", "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", "-?(?:0|[1-9][0-9]*)", "(?!)", "(", ")", "$", "|"], input), ([_0, input2]) => [PatternTextMapping(_0), input2]);
    PatternBase = (input) => If(If(PatternBigInt(input), ([_0, input2]) => [_0, input2], () => If(PatternString(input), ([_0, input2]) => [_0, input2], () => If(PatternNumber(input), ([_0, input2]) => [_0, input2], () => If(PatternInteger(input), ([_0, input2]) => [_0, input2], () => If(PatternNever(input), ([_0, input2]) => [_0, input2], () => If(PatternGroup(input), ([_0, input2]) => [_0, input2], () => If(PatternText(input), ([_0, input2]) => [_0, input2], () => []))))))), ([_0, input2]) => [PatternBaseMapping(_0), input2]);
    PatternGroup = (input) => If(If(Const("(", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternGroupMapping(_0), input2]);
    PatternUnion = (input) => If(If(If(PatternTerm(input), ([_0, input2]) => If(Const("|", input2), ([_1, input3]) => If(PatternUnion(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(PatternTerm(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [PatternUnionMapping(_0), input2]);
    PatternTerm = (input) => If(If(PatternBase(input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [PatternTermMapping(_0), input2]);
    PatternBody = (input) => If(If(PatternUnion(input), ([_0, input2]) => [_0, input2], () => If(PatternTerm(input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [PatternBodyMapping(_0), input2]);
    Pattern = (input) => If(If(Const("^", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const("$", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternMapping(_0), input2]);
    InterfaceDeclarationHeritageList_0 = (input, result2 = []) => If(If(Type(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => InterfaceDeclarationHeritageList_0(input2, [...result2, _0]), () => [result2, input]);
    InterfaceDeclarationHeritageList = (input) => If(If(InterfaceDeclarationHeritageList_0(input), ([_0, input2]) => If(If(If(Type(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [InterfaceDeclarationHeritageListMapping(_0), input2]);
    InterfaceDeclarationHeritage = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(InterfaceDeclarationHeritageList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InterfaceDeclarationHeritageMapping(_0), input2]);
    InterfaceDeclarationGeneric = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(InterfaceDeclarationHeritage(input4), ([_3, input5]) => If(Properties(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [InterfaceDeclarationGenericMapping(_0), input2]);
    InterfaceDeclaration = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(InterfaceDeclarationHeritage(input3), ([_2, input4]) => If(Properties(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [InterfaceDeclarationMapping(_0), input2]);
    TypeAliasDeclarationGeneric = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [TypeAliasDeclarationGenericMapping(_0), input2]);
    TypeAliasDeclaration = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("=", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [TypeAliasDeclarationMapping(_0), input2]);
    ExportKeyword = (input) => If(If(If(Const("export", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExportKeywordMapping(_0), input2]);
    ModuleDeclarationDelimiter = (input) => If(If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ModuleDeclarationDelimiterMapping(_0), input2]);
    ModuleDeclarationList_0 = (input, result2 = []) => If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationDelimiter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ModuleDeclarationList_0(input2, [...result2, _0]), () => [result2, input]);
    ModuleDeclarationList = (input) => If(If(ModuleDeclarationList_0(input), ([_0, input2]) => If(If(If(ModuleDeclaration(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ModuleDeclarationListMapping(_0), input2]);
    ModuleDeclaration = (input) => If(If(ExportKeyword(input), ([_0, input2]) => If(If(InterfaceDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(InterfaceDeclaration(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclaration(input2), ([_02, input3]) => [_02, input3], () => [])))), ([_1, input3]) => If(OptionalSemiColon(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ModuleDeclarationMapping(_0), input2]);
    Module = (input) => If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ModuleMapping(_0), input2]);
    Script = (input) => If(If(Module(input), ([_0, input2]) => [_0, input2], () => If(GenericType(input), ([_0, input2]) => [_0, input2], () => If(Type(input), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ScriptMapping(_0), input2]);
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/patterns/template.mjs
function ParseTemplateIntoTypes(template) {
  const parsed = TemplateLiteralTypes(`\`${template}\``);
  const result2 = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : Unreachable();
  return result2;
}
var init_template = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/patterns/template.mjs"() {
    init_unreachable2();
    init_guard2();
    init_parser();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/encode.mjs
function JoinString(input) {
  return input.join("|");
}
function UnwrapTemplateLiteralPattern(pattern) {
  return pattern.slice(1, pattern.length - 1);
}
function EncodeLiteral(value, right, pattern) {
  return EncodeTypes(right, `${pattern}${value}`);
}
function EncodeBigInt(right, pattern) {
  return EncodeTypes(right, `${pattern}${BigIntPattern}`);
}
function EncodeInteger(right, pattern) {
  return EncodeTypes(right, `${pattern}${IntegerPattern}`);
}
function EncodeNumber(right, pattern) {
  return EncodeTypes(right, `${pattern}${NumberPattern}`);
}
function EncodeBoolean(right, pattern) {
  return EncodeType(Union([Literal("false"), Literal("true")]), right, pattern);
}
function EncodeString(right, pattern) {
  return EncodeTypes(right, `${pattern}${StringPattern}`);
}
function EncodeTemplateLiteral(templatePattern, right, pattern) {
  return EncodeTypes(right, `${pattern}${UnwrapTemplateLiteralPattern(templatePattern)}`);
}
function EncodeTemplateLiteralDeferred(types, right, pattern) {
  const templateLiteral = TemplateLiteralAction(types, {});
  const result2 = EncodeType(templateLiteral, right, pattern);
  return result2;
}
function EncodeEnum(values, right, pattern) {
  const evaluated = EvaluateEnum(values);
  return EncodeType(evaluated, right, pattern);
}
function EncodeUnion(types, right, pattern, result2 = []) {
  return guard_exports.ShiftLeft(types, (head, tail) => EncodeUnion(tail, right, pattern, [...result2, EncodeType(head, [], "")]), () => EncodeTypes(right, `${pattern}(${JoinString(result2)})`));
}
function EncodeType(type, right, pattern) {
  return IsEnum(type) ? EncodeEnum(type.enum, right, pattern) : IsInteger2(type) ? EncodeInteger(right, pattern) : IsLiteral(type) ? EncodeLiteral(type.const, right, pattern) : IsBigInt2(type) ? EncodeBigInt(right, pattern) : IsBoolean3(type) ? EncodeBoolean(right, pattern) : IsNumber3(type) ? EncodeNumber(right, pattern) : IsString3(type) ? EncodeString(right, pattern) : IsTemplateLiteral(type) ? EncodeTemplateLiteral(type.pattern, right, pattern) : IsTemplateLiteralDeferred(type) ? EncodeTemplateLiteralDeferred(type.parameters[0], right, pattern) : IsUnion(type) ? EncodeUnion(type.anyOf, right, pattern) : NeverPattern;
}
function EncodeTypes(types, pattern) {
  return guard_exports.ShiftLeft(types, (left, right) => EncodeType(left, right, pattern), () => pattern);
}
function EncodePattern(types) {
  const encoded = EncodeTypes(types, "");
  const result2 = `^${encoded}$`;
  return result2;
}
function TemplateLiteralEncode(types) {
  const pattern = EncodePattern(types);
  const result2 = TemplateLiteralCreate(pattern);
  return result2;
}
var init_encode = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/encode.mjs"() {
    init_guard2();
    init_enum();
    init_literal();
    init_union();
    init_template_literal();
    init_bigint();
    init_string2();
    init_number();
    init_integer();
    init_boolean();
    init_never();
    init_create2();
    init_evaluate2();
    init_instantiate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/instantiate.mjs
function TemplateLiteralAction(types, options) {
  const result2 = CanInstantiate(types) ? memory_exports.Update(TemplateLiteralEncode(types), {}, options) : TemplateLiteralDeferred(types, options);
  return result2;
}
function TemplateLiteralInstantiate(context, state, types, options) {
  const instantiatedTypes = InstantiateTypes(context, state, types);
  return TemplateLiteralAction(instantiatedTypes, options);
}
var init_instantiate2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/instantiate.mjs"() {
    init_memory2();
    init_template_literal();
    init_encode();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/template_literal.mjs
function TemplateLiteralDeferred(types, options = {}) {
  return Deferred("TemplateLiteral", [types], options);
}
function IsTemplateLiteralDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "TemplateLiteral");
}
function TemplateLiteralFromTypes(types) {
  return TemplateLiteralAction(types, {});
}
function TemplateLiteralFromString(template) {
  const types = ParseTemplateIntoTypes(template);
  return TemplateLiteralFromTypes(types);
}
function TemplateLiteral2(input, options = {}) {
  const type = guard_exports.IsString(input) ? TemplateLiteralFromString(input) : TemplateLiteralFromTypes(input);
  return memory_exports.Update(type, {}, options);
}
function IsTemplateLiteral(value) {
  return IsKind(value, "TemplateLiteral");
}
var init_template_literal = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/template_literal.mjs"() {
    init_system();
    init_guard2();
    init_schema();
    init_deferred();
    init_template();
    init_instantiate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/result.mjs
var result_exports = {};
__export(result_exports, {
  ExtendsFalse: () => ExtendsFalse,
  ExtendsTrue: () => ExtendsTrue,
  ExtendsUnion: () => ExtendsUnion,
  IsExtendsFalse: () => IsExtendsFalse,
  IsExtendsTrue: () => IsExtendsTrue,
  IsExtendsTrueLike: () => IsExtendsTrueLike,
  IsExtendsUnion: () => IsExtendsUnion,
  Match: () => Match3
});
function ExtendsUnion(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsUnion" }, { inferred });
}
function IsExtendsUnion(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsUnion") && guard_exports.IsObject(value.inferred);
}
function ExtendsTrue(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsTrue" }, { inferred });
}
function IsExtendsTrue(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsTrue") && guard_exports.IsObject(value.inferred);
}
function ExtendsFalse() {
  return memory_exports.Create({ ["~kind"]: "ExtendsFalse" }, {});
}
function IsExtendsFalse(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], "ExtendsFalse");
}
function IsExtendsTrueLike(value) {
  return IsExtendsUnion(value) || IsExtendsTrue(value);
}
function Match3(result2, true_, false_) {
  return IsExtendsTrueLike(result2) ? true_(result2.inferred) : false_();
}
var init_result = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/result.mjs"() {
    init_guard2();
    init_memory2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/extends_right.mjs
function ExtendsRightInfer(inferred, name, left, right) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => ExtendsTrue(memory_exports.Assign(memory_exports.Assign(inferred, checkInferred), { [name]: left })), () => ExtendsFalse());
}
function ExtendsRightAny(inferred, _left) {
  return ExtendsTrue(inferred);
}
function ExtendsRightDependent(inferred, left, if_, then_, else_) {
  return Match3(ExtendsLeft(inferred, left, if_), (inferred2) => Match3(ExtendsLeft(inferred2, left, then_), (inferred3) => ExtendsTrue(inferred3), () => ExtendsFalse()), () => Match3(ExtendsLeft(inferred, left, else_), (inferred2) => ExtendsTrue(inferred2), () => ExtendsFalse()));
}
function ExtendsRightEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightIntersect(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsRightIntersect(inferred2, left, tail), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsRightTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightUnion(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsRightUnion(inferred, left, tail)), () => ExtendsFalse());
}
function ExtendsRight(inferred, left, right) {
  return IsAny(right) ? ExtendsRightAny(inferred, left) : IsDependent(right) ? ExtendsRightDependent(inferred, left, right.if, right.then, right.else) : IsEnum(right) ? ExtendsRightEnum(inferred, left, right.enum) : IsInfer(right) ? ExtendsRightInfer(inferred, right.name, left, right.extends) : IsIntersect(right) ? ExtendsRightIntersect(inferred, left, right.allOf) : IsTemplateLiteral(right) ? ExtendsRightTemplateLiteral(inferred, left, right.pattern) : IsUnion(right) ? ExtendsRightUnion(inferred, left, right.anyOf) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}
var init_extends_right = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/extends_right.mjs"() {
    init_guard2();
    init_memory2();
    init_any();
    init_dependent();
    init_enum();
    init_infer();
    init_intersect();
    init_template_literal();
    init_union();
    init_unknown();
    init_extends_left();
    init_result();
    init_evaluate2();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/any.mjs
function ExtendsAny(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsUnion(inferred);
}
var init_any2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/any.mjs"() {
    init_infer();
    init_any();
    init_unknown();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/array.mjs
function ExtendsImmutable(left, right) {
  const isImmutableLeft = IsImmutable(left);
  const isImmutableRight = IsImmutable(right);
  return isImmutableLeft && isImmutableRight ? true : !isImmutableLeft && isImmutableRight ? true : isImmutableLeft && !isImmutableRight ? false : true;
}
function ExtendsArray(inferred, arrayLeft, left, right) {
  return IsArray2(right) ? ExtendsImmutable(arrayLeft, right) ? ExtendsLeft(inferred, left, right.items) : ExtendsFalse() : ExtendsRight(inferred, arrayLeft, right);
}
var init_array2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/array.mjs"() {
    init_array();
    init_immutable();
    init_extends_right();
    init_extends_left();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/bigint.mjs
function ExtendsBigInt(inferred, left, right) {
  return IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}
var init_bigint3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/bigint.mjs"() {
    init_bigint();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/boolean.mjs
function ExtendsBoolean(inferred, left, right) {
  return IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}
var init_boolean2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/boolean.mjs"() {
    init_boolean();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/parameters.mjs
function ParameterCompare(inferred, left, leftRest, right, rightRest) {
  const checkLeft = IsInfer(right) ? left : right;
  const checkRight = IsInfer(right) ? right : left;
  const isLeftOptional = IsOptional(left);
  const isRightOptional = IsOptional(right);
  return !isLeftOptional && isRightOptional ? ExtendsFalse() : Match3(ExtendsLeft(inferred, checkLeft, checkRight), (inferred2) => ExtendsParameters(inferred2, leftRest, rightRest), () => ExtendsFalse());
}
function ParameterRight(inferred, left, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ParameterCompare(inferred, left, leftRest, head, tail), () => IsOptional(left) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function ParametersLeft(inferred, left, rightRest) {
  return guard_exports.ShiftLeft(left, (head, tail) => ParameterRight(inferred, head, tail, rightRest), () => ExtendsTrue(inferred));
}
function ExtendsParameters(inferred, left, right) {
  return ParametersLeft(inferred, left, right);
}
var init_parameters = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/parameters.mjs"() {
    init_guard2();
    init_infer();
    init_optional();
    init_extends_left();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/return_type.mjs
function ExtendsReturnType(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsLeft(inferred, left, right);
}
var init_return_type = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/return_type.mjs"() {
    init_void();
    init_extends_left();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/constructor.mjs
function ExtendsConstructor(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsConstructor2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["instanceType"]), () => ExtendsFalse()) : ExtendsFalse();
}
var init_constructor2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/constructor.mjs"() {
    init_any();
    init_constructor();
    init_unknown();
    init_result();
    init_parameters();
    init_return_type();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/dependent.mjs
function ExtendsDependent(inferred, if_, then_, else_, right) {
  return Match3(ExtendsLeft(inferred, if_, right), () => ExtendsLeft(inferred, then_, right), () => ExtendsLeft(inferred, else_, right));
}
var init_dependent2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/dependent.mjs"() {
    init_extends_left();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/enum.mjs
function ExtendsEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(left);
  return ExtendsLeft(inferred, evaluated, right);
}
var init_enum2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/enum.mjs"() {
    init_extends_left();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/function.mjs
function ExtendsFunction(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsFunction2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["returnType"]), () => ExtendsFalse()) : ExtendsFalse();
}
var init_function2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/function.mjs"() {
    init_any();
    init_function();
    init_unknown();
    init_result();
    init_parameters();
    init_return_type();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/integer.mjs
function ExtendsInteger(inferred, left, right) {
  return IsInteger2(right) ? ExtendsTrue(inferred) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}
var init_integer3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/integer.mjs"() {
    init_integer();
    init_number();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/intersect.mjs
function ExtendsIntersect(inferred, left, right) {
  const evaluated = EvaluateIntersect(left);
  return ExtendsLeft(inferred, evaluated, right);
}
var init_intersect2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/intersect.mjs"() {
    init_extends_left();
    init_evaluate3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/literal.mjs
function ExtendsLiteralValue(inferred, left, right) {
  return left === right ? ExtendsTrue(inferred) : ExtendsFalse();
}
function ExtendsLiteralBigInt(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralBoolean(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralNumber(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralString(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteral(inferred, left, right) {
  return guard_exports.IsBigInt(left.const) ? ExtendsLiteralBigInt(inferred, left.const, right) : guard_exports.IsBoolean(left.const) ? ExtendsLiteralBoolean(inferred, left.const, right) : guard_exports.IsNumber(left.const) ? ExtendsLiteralNumber(inferred, left.const, right) : guard_exports.IsString(left.const) ? ExtendsLiteralString(inferred, left.const, right) : Unreachable();
}
var init_literal2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/literal.mjs"() {
    init_guard2();
    init_unreachable();
    init_literal();
    init_bigint();
    init_boolean();
    init_number();
    init_string2();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/never.mjs
function ExtendsNever(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : ExtendsTrue(inferred);
}
var init_never2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/never.mjs"() {
    init_infer();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/null.mjs
function ExtendsNull(inferred, left, right) {
  return IsNull2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}
var init_null2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/null.mjs"() {
    init_null();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/number.mjs
function ExtendsNumber(inferred, left, right) {
  return IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}
var init_number3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/number.mjs"() {
    init_number();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/object.mjs
function ExtendsPropertyOptional(inferred, left, right) {
  return IsOptional(left) ? IsOptional(right) ? ExtendsTrue(inferred) : ExtendsFalse() : ExtendsTrue(inferred);
}
function ExtendsProperty(inferred, left, right) {
  return (
    // Right TInfer<TNever> is TExtendsFalse
    IsInfer(right) && IsNever(right.extends) ? ExtendsFalse() : Match3(ExtendsLeft(inferred, left, right), (inferred2) => ExtendsPropertyOptional(inferred2, left, right), () => ExtendsFalse())
  );
}
function ExtractInferredProperties(keys, properties) {
  return keys.reduce((result2, key) => {
    return key in properties ? IsExtendsTrueLike(properties[key]) ? { ...result2, ...properties[key].inferred } : Unreachable() : Unreachable();
  }, {});
}
function ExtendsPropertiesComparer(inferred, left, right) {
  const properties = {};
  for (const rightKey of guard_exports.Keys(right)) {
    properties[rightKey] = rightKey in left ? ExtendsProperty({}, left[rightKey], right[rightKey]) : IsOptional(right[rightKey]) ? IsInfer(right[rightKey]) ? ExtendsTrue(memory_exports.Assign(inferred, { [right[rightKey].name]: right[rightKey].extends })) : ExtendsTrue(inferred) : ExtendsFalse();
  }
  const checked = guard_exports.Values(properties).every((result2) => IsExtendsTrueLike(result2));
  const extracted = checked ? ExtractInferredProperties(guard_exports.Keys(properties), properties) : {};
  return checked ? ExtendsTrue(extracted) : ExtendsFalse();
}
function ExtendsProperties(inferred, left, right) {
  const compared = ExtendsPropertiesComparer(inferred, left, right);
  return IsExtendsTrueLike(compared) ? ExtendsTrue(memory_exports.Assign(inferred, compared.inferred)) : ExtendsFalse();
}
function ExtendsObjectToObject(inferred, left, right) {
  return ExtendsProperties(inferred, left, right);
}
function RecordMergeInferred(left, right) {
  return guard_exports.Keys(right).reduce((result2, key) => {
    return {
      ...result2,
      [key]: guard_exports.HasPropertyKey(left, key) ? IsUnion(result2[key]) ? Union([...result2[key].anyOf, right[key]]) : Union([left[key], right[key]]) : right[key]
    };
  }, left);
}
function ExtendsRecordComparer(properties, keys, type, result2) {
  return guard_exports.ShiftLeft(keys, (left, right) => Match3(ExtendsLeft({}, properties[left], type), (inferred) => ExtendsRecordComparer(properties, right, type, RecordMergeInferred(result2, inferred)), () => ExtendsFalse()), () => ExtendsTrue(result2));
}
function ExtendsObjectToRecord(inferred, properties, _pattern, value) {
  const keys = guard_exports.Keys(properties);
  const result2 = ExtendsRecordComparer(properties, keys, value, inferred);
  return result2;
}
function ExtendsObject(inferred, left, right) {
  return IsRecord(right) ? ExtendsObjectToRecord(inferred, left, RecordPattern(right), RecordValue(right)) : IsObject2(right) ? ExtendsObjectToObject(inferred, left, right.properties) : ExtendsRight(inferred, _Object_(left), right);
}
var init_object2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/object.mjs"() {
    init_unreachable2();
    init_memory2();
    init_guard2();
    init_optional();
    init_infer();
    init_never();
    init_object();
    init_record();
    init_union();
    init_extends_left();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/record.mjs
function FromObject3(inferred, properties) {
  return guard_exports.IsEqual(guard_exports.Keys(properties).length, 0) ? ExtendsTrue(inferred) : ExtendsFalse();
}
function FromRecord(inferred, _leftKey, leftValue, _rightKey, rightValue) {
  return ExtendsLeft(inferred, leftValue, rightValue);
}
function ExtendsRecord(inferred, leftPattern, leftValue, right) {
  return IsRecord(right) ? FromRecord(inferred, RecordPatternToType(leftPattern), leftValue, RecordPatternToType(RecordPattern(right)), RecordValue(right)) : IsObject2(right) ? FromObject3(inferred, right.properties) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}
var init_record2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/record.mjs"() {
    init_guard2();
    init_any();
    init_unknown();
    init_object();
    init_record();
    init_extends_left();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/string.mjs
function ExtendsString(inferred, left, right) {
  return IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}
var init_string4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/string.mjs"() {
    init_string2();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/symbol.mjs
function ExtendsSymbol(inferred, left, right) {
  return IsSymbol2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}
var init_symbol2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/symbol.mjs"() {
    init_symbol();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/template_literal.mjs
function ExtendsTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(left);
  return ExtendsLeft(inferred, evaluated, right);
}
var init_template_literal2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/template_literal.mjs"() {
    init_extends_left();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/inference.mjs
function Inferrable(name, type) {
  return memory_exports.Create({ "~kind": "Inferrable" }, { name, type }, {});
}
function IsInferable(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "name") && guard_exports.HasPropertyKey(value, "type") && guard_exports.IsEqual(value["~kind"], "Inferrable") && guard_exports.IsString(value.name) && guard_exports.IsObject(value.type);
}
function TryRestInferable(type) {
  return IsRest(type) ? IsInfer(type.items) ? IsArray2(type.items.extends) ? Inferrable(type.items.name, type.items.extends.items) : IsUnknown(type.items.extends) ? Inferrable(type.items.name, type.items.extends) : void 0 : Unreachable() : void 0;
}
function TryInferable(type) {
  return IsInfer(type) ? Inferrable(type.name, type.extends) : void 0;
}
function TryInferResults(rest, right, result2 = []) {
  return guard_exports.ShiftLeft(rest, (head, tail) => Match3(ExtendsLeft({}, head, right), () => TryInferResults(tail, right, [...result2, head]), () => void 0), () => result2);
}
function InferTupleResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Tuple(results) })) : ExtendsFalse();
}
function InferUnionResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Union(results) })) : ExtendsFalse();
}
var init_inference = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/inference.mjs"() {
    init_unreachable2();
    init_memory2();
    init_guard2();
    init_array();
    init_unknown();
    init_tuple();
    init_extends_left();
    init_union();
    init_infer();
    init_rest();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/tuple.mjs
function Reverse(types) {
  return [...types].reverse();
}
function ApplyReverse(types, reversed) {
  return reversed ? Reverse(types) : types;
}
function Reversed(types) {
  const first = types.length > 0 ? types[0] : void 0;
  const inferrable = IsSchema(first) ? TryRestInferable(first) : void 0;
  return IsSchema(inferrable);
}
function ElementsCompare(inferred, reversed, left, leftRest, right, rightRest) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => Elements(checkInferred, reversed, leftRest, rightRest), () => ExtendsFalse());
}
function ElementsLeft(inferred, reversed, leftRest, right, rightRest) {
  const inferable = TryRestInferable(right);
  return (
    // Rest Inferrable Right Means we delegate to TInferTupleResult to Generate a Result
    IsInferable(inferable) ? InferTupleResult(inferred, inferable["name"], ApplyReverse(leftRest, reversed), inferable["type"]) : guard_exports.ShiftLeft(leftRest, (head, tail) => ElementsCompare(inferred, reversed, head, tail, right, rightRest), () => ExtendsFalse())
  );
}
function ElementsRight(inferred, reversed, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ElementsLeft(inferred, reversed, leftRest, head, tail), () => guard_exports.IsEqual(leftRest.length, 0) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function Elements(inferred, reversed, leftRest, rightRest) {
  return ElementsRight(inferred, reversed, leftRest, rightRest);
}
function ExtendsTupleToTuple(inferred, left, right) {
  const instantiatedRight = InstantiateElements(inferred, State([], []), right);
  const reversed = Reversed(instantiatedRight);
  return Elements(inferred, reversed, ApplyReverse(left, reversed), ApplyReverse(instantiatedRight, reversed));
}
function ExtendsTupleToArray(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable["name"], left, inferrable["type"]) : guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsLeft(inferred, head, right), (inferred2) => ExtendsTupleToArray(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsTuple(inferred, left, right) {
  const instantiatedLeft = InstantiateElements(inferred, State([], []), left);
  return IsTuple(right) ? ExtendsTupleToTuple(inferred, instantiatedLeft, right.items) : IsArray2(right) ? ExtendsTupleToArray(inferred, instantiatedLeft, right.items) : ExtendsRight(inferred, Tuple(instantiatedLeft), right);
}
var init_tuple2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/tuple.mjs"() {
    init_guard2();
    init_schema();
    init_array();
    init_tuple();
    init_extends_left();
    init_extends_right();
    init_result();
    init_instantiate27();
    init_instantiate27();
    init_inference();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/undefined.mjs
function ExtendsUndefined(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : IsUndefined2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}
var init_undefined2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/undefined.mjs"() {
    init_undefined();
    init_void();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/union.mjs
function ExtendsUnionSome(inferred, type, unionTypes) {
  return guard_exports.ShiftLeft(unionTypes, (head, tail) => Match3(ExtendsLeft(inferred, type, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsUnionSome(inferred, type, tail)), () => ExtendsFalse());
}
function ExtendsUnionLeft(inferred, left, right) {
  return guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsUnionSome(inferred, head, right), (inferred2) => ExtendsUnionLeft(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsUnion2(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable.name, left, inferrable.type) : IsUnion(right) ? ExtendsUnionLeft(inferred, left, right.anyOf) : ExtendsUnionLeft(inferred, left, [right]);
}
var init_union2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/union.mjs"() {
    init_guard2();
    init_union();
    init_extends_left();
    init_result();
    init_inference();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/unknown.mjs
function ExtendsUnknown(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}
var init_unknown2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/unknown.mjs"() {
    init_any();
    init_unknown();
    init_infer();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/void.mjs
function ExtendsVoid(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}
var init_void2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/void.mjs"() {
    init_void();
    init_extends_right();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/extends_left.mjs
function ExtendsLeft(inferred, left, right) {
  return IsAny(left) ? ExtendsAny(inferred, left, right) : IsArray2(left) ? ExtendsArray(inferred, left, left.items, right) : IsBigInt2(left) ? ExtendsBigInt(inferred, left, right) : IsBoolean3(left) ? ExtendsBoolean(inferred, left, right) : IsConstructor2(left) ? ExtendsConstructor(inferred, left.parameters, left.instanceType, right) : IsDependent(left) ? ExtendsDependent(inferred, left.if, left.then, left.else, right) : IsEnum(left) ? ExtendsEnum(inferred, left.enum, right) : IsFunction2(left) ? ExtendsFunction(inferred, left.parameters, left.returnType, right) : IsInteger2(left) ? ExtendsInteger(inferred, left, right) : IsIntersect(left) ? ExtendsIntersect(inferred, left.allOf, right) : IsLiteral(left) ? ExtendsLiteral(inferred, left, right) : IsNever(left) ? ExtendsNever(inferred, left, right) : IsNull2(left) ? ExtendsNull(inferred, left, right) : IsNumber3(left) ? ExtendsNumber(inferred, left, right) : IsObject2(left) ? ExtendsObject(inferred, left.properties, right) : IsRecord(left) ? ExtendsRecord(inferred, RecordPattern(left), RecordValue(left), right) : IsString3(left) ? ExtendsString(inferred, left, right) : IsSymbol2(left) ? ExtendsSymbol(inferred, left, right) : IsTemplateLiteral(left) ? ExtendsTemplateLiteral(inferred, left.pattern, right) : IsTuple(left) ? ExtendsTuple(inferred, left.items, right) : IsUndefined2(left) ? ExtendsUndefined(inferred, left, right) : IsUnion(left) ? ExtendsUnion2(inferred, left.anyOf, right) : IsUnknown(left) ? ExtendsUnknown(inferred, left, right) : IsVoid(left) ? ExtendsVoid(inferred, left, right) : ExtendsFalse();
}
var init_extends_left = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/extends_left.mjs"() {
    init_any2();
    init_array2();
    init_bigint3();
    init_boolean2();
    init_constructor2();
    init_dependent2();
    init_enum2();
    init_function2();
    init_integer3();
    init_intersect2();
    init_literal2();
    init_never2();
    init_null2();
    init_number3();
    init_object2();
    init_record2();
    init_string4();
    init_symbol2();
    init_template_literal2();
    init_tuple2();
    init_undefined2();
    init_union2();
    init_unknown2();
    init_void2();
    init_any();
    init_array();
    init_bigint();
    init_boolean();
    init_constructor();
    init_dependent();
    init_enum();
    init_function();
    init_integer();
    init_intersect();
    init_literal();
    init_never();
    init_null();
    init_number();
    init_object();
    init_record();
    init_string2();
    init_symbol();
    init_template_literal();
    init_tuple();
    init_undefined();
    init_unknown();
    init_union();
    init_void();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/interface/instantiate.mjs
function InterfaceOperation(heritage, properties) {
  const result2 = EvaluateIntersect([...heritage, _Object_(properties)]);
  return result2;
}
function InterfaceAction(heritage, properties, options) {
  const result2 = CanInstantiate(heritage) ? memory_exports.Update(InterfaceOperation(heritage, properties), {}, options) : InterfaceDeferred(heritage, properties, options);
  return result2;
}
function InterfaceInstantiate(context, state, heritage, properties, options) {
  const instantiatedHeritage = InstantiateTypes(context, state, heritage);
  const instantiatedProperties = InstantiateProperties(context, state, properties);
  return InterfaceAction(instantiatedHeritage, instantiatedProperties, options);
}
var init_instantiate3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/interface/instantiate.mjs"() {
    init_memory2();
    init_object();
    init_evaluate2();
    init_action();
    init_instantiate27();
    init_instantiate27();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/interface.mjs
function InterfaceDeferred(heritage, properties, options = {}) {
  return Deferred("Interface", [heritage, properties], options);
}
function IsInterfaceDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "Interface");
}
function Interface(heritage, properties, options = {}) {
  return InterfaceAction(heritage, properties, options);
}
var init_interface = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/interface.mjs"() {
    init_guard2();
    init_schema();
    init_deferred();
    init_instantiate3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/check.mjs
function FromRef(stack, context, ref) {
  return stack.includes(ref) ? true : FromType3([...stack, ref], context, context[ref]);
}
function FromProperties(stack, context, properties) {
  const types = PropertyValues(properties);
  return FromTypes2(stack, context, types);
}
function FromTypes2(stack, context, types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType3(stack, context, left) ? true : FromTypes2(stack, context, right), () => false);
}
function FromType3(stack, context, type) {
  return IsRef(type) ? FromRef(stack, context, type.$ref) : IsArray2(type) ? FromType3(stack, context, type.items) : IsConstructor2(type) ? FromTypes2(stack, context, [...type.parameters, type.instanceType]) : IsFunction2(type) ? FromTypes2(stack, context, [...type.parameters, type.returnType]) : IsInterfaceDeferred(type) ? FromProperties(stack, context, type.parameters[1]) : IsIntersect(type) ? FromTypes2(stack, context, type.allOf) : IsObject2(type) ? FromProperties(stack, context, type.properties) : IsUnion(type) ? FromTypes2(stack, context, type.anyOf) : IsTuple(type) ? FromTypes2(stack, context, type.items) : IsRecord(type) ? FromType3(stack, context, RecordValue(type)) : false;
}
function CyclicCheck(stack, context, type) {
  const result2 = FromType3(stack, context, type);
  return result2;
}
var init_check = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/check.mjs"() {
    init_guard2();
    init_array();
    init_constructor();
    init_function();
    init_intersect();
    init_object();
    init_properties();
    init_record();
    init_tuple();
    init_union();
    init_ref();
    init_interface();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/candidates.mjs
function ResolveCandidateKeys(context, keys) {
  return keys.reduce((result2, left) => {
    return CyclicCheck([left], context, context[left]) ? [...result2, left] : result2;
  }, []);
}
function CyclicCandidates(context) {
  const keys = PropertyKeys(context);
  const result2 = ResolveCandidateKeys(context, keys);
  return result2;
}
var init_candidates = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/candidates.mjs"() {
    init_properties();
    init_check();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/dependencies.mjs
function FromRef2(context, ref, result2) {
  return result2.includes(ref) ? result2 : ref in context ? FromType4(context, context[ref], [...result2, ref]) : Unreachable();
}
function FromProperties2(context, properties, result2) {
  const types = PropertyValues(properties);
  return FromTypes3(context, types, result2);
}
function FromTypes3(context, types, result2) {
  return types.reduce((result3, left) => {
    return FromType4(context, left, result3);
  }, result2);
}
function FromType4(context, type, result2) {
  return IsRef(type) ? FromRef2(context, type.$ref, result2) : IsArray2(type) ? FromType4(context, type.items, result2) : IsConstructor2(type) ? FromTypes3(context, [...type.parameters, type.instanceType], result2) : IsFunction2(type) ? FromTypes3(context, [...type.parameters, type.returnType], result2) : IsInterfaceDeferred(type) ? FromProperties2(context, type.parameters[1], result2) : IsIntersect(type) ? FromTypes3(context, type.allOf, result2) : IsObject2(type) ? FromProperties2(context, type.properties, result2) : IsUnion(type) ? FromTypes3(context, type.anyOf, result2) : IsTuple(type) ? FromTypes3(context, type.items, result2) : IsRecord(type) ? FromType4(context, RecordValue(type), result2) : result2;
}
function CyclicDependencies(context, key, type) {
  const result2 = FromType4(context, type, [key]);
  return result2;
}
var init_dependencies = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/dependencies.mjs"() {
    init_unreachable2();
    init_array();
    init_constructor();
    init_function();
    init_intersect();
    init_object();
    init_properties();
    init_record();
    init_tuple();
    init_union();
    init_ref();
    init_interface();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/extends.mjs
function FromRef3(_ref) {
  return Any();
}
function FromProperties3(properties) {
  return guard_exports.Keys(properties).reduce((result2, key) => {
    return { ...result2, [key]: FromType5(properties[key]) };
  }, {});
}
function FromTypes4(types) {
  return types.reduce((result2, left) => {
    return [...result2, FromType5(left)];
  }, []);
}
function FromType5(type) {
  return IsRef(type) ? FromRef3(type.$ref) : IsArray2(type) ? _Array_(FromType5(type.items), ArrayOptions(type)) : IsConstructor2(type) ? Constructor(FromTypes4(type.parameters), FromType5(type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes4(type.parameters), FromType5(type.returnType)) : IsIntersect(type) ? Intersect(FromTypes4(type.allOf)) : IsObject2(type) ? _Object_(FromProperties3(type.properties)) : IsRecord(type) ? Record(RecordKey(type), FromType5(RecordValue(type))) : IsUnion(type) ? Union(FromTypes4(type.anyOf)) : IsTuple(type) ? Tuple(FromTypes4(type.items)) : type;
}
function CyclicAnyFromParameters(defs, ref) {
  return ref in defs ? FromType5(defs[ref]) : Unknown();
}
function CyclicExtends(type) {
  return CyclicAnyFromParameters(type.$defs, type.$ref);
}
var init_extends = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/extends.mjs"() {
    init_guard2();
    init_any();
    init_array();
    init_constructor();
    init_function();
    init_intersect();
    init_object();
    init_record();
    init_ref();
    init_tuple();
    init_union();
    init_unknown();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/instantiate.mjs
function CyclicInterface(context, heritage, properties) {
  const instantiatedHeritage = InstantiateTypes(context, State([], []), heritage);
  const instantiatedProperties = InstantiateProperties({}, State([], []), properties);
  const evaluatedInterface = EvaluateIntersect([...instantiatedHeritage, _Object_(instantiatedProperties)]);
  return evaluatedInterface;
}
function CyclicDefinitions(context, dependencies) {
  const keys = guard_exports.Keys(context).filter((key) => dependencies.includes(key));
  return keys.reduce((result2, key) => {
    const type = context[key];
    const instantiatedType = IsInterfaceDeferred(type) ? CyclicInterface(context, type.parameters[0], type.parameters[1]) : type;
    return { ...result2, [key]: instantiatedType };
  }, {});
}
function InstantiateCyclic(context, ref, type) {
  const dependencies = CyclicDependencies(context, ref, type);
  const definitions = CyclicDefinitions(context, dependencies);
  const result2 = Cyclic(definitions, ref);
  return result2;
}
var init_instantiate4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/instantiate.mjs"() {
    init_guard2();
    init_cyclic();
    init_object();
    init_dependencies();
    init_action();
    init_instantiate27();
    init_instantiate27();
    init_instantiate27();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/target.mjs
function Resolve(defs, ref) {
  return ref in defs ? IsRef(defs[ref]) ? Resolve(defs, defs[ref].$ref) : defs[ref] : Never();
}
function CyclicTarget(defs, ref) {
  const result2 = Resolve(defs, ref);
  return result2;
}
var init_target = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/target.mjs"() {
    init_never();
    init_ref();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/index.mjs
var init_cyclic2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/cyclic/index.mjs"() {
    init_candidates();
    init_check();
    init_dependencies();
    init_extends();
    init_instantiate4();
    init_target();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/extends.mjs
function Canonical(type) {
  return IsCyclic(type) ? CyclicExtends(type) : IsUnsafe(type) ? Unknown() : type;
}
function Extends(inferred, left, right) {
  const canonicalLeft = Canonical(left);
  const canonicalRight = Canonical(right);
  return ExtendsLeft(inferred, canonicalLeft, canonicalRight);
}
var init_extends2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/extends.mjs"() {
    init_cyclic();
    init_unknown();
    init_unsafe();
    init_extends_left();
    init_cyclic2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/index.mjs
var init_extends3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/extends/index.mjs"() {
    init_extends2();
    init_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/compare.mjs
function Compare(left, right) {
  const extendsCheck = [
    IsUnknown(left) ? result_exports.ExtendsFalse() : Extends({}, left, right),
    IsUnknown(left) ? result_exports.ExtendsTrue({}) : Extends({}, right, left)
  ];
  return result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? ResultEqual : result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsFalse(extendsCheck[1]) ? ResultLeftInside : result_exports.IsExtendsFalse(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? ResultRightInside : ResultDisjoint;
}
var ResultEqual, ResultDisjoint, ResultLeftInside, ResultRightInside;
var init_compare = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/compare.mjs"() {
    init_unknown();
    init_extends3();
    ResultEqual = "equal";
    ResultDisjoint = "disjoint";
    ResultLeftInside = "left-inside";
    ResultRightInside = "right-inside";
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/broaden.mjs
function BroadFilter(type, types) {
  return types.filter((left) => {
    return Compare(type, left) === ResultRightInside ? false : true;
  });
}
function IsBroadestType(type, types) {
  const result2 = types.some((left) => {
    const result3 = Compare(type, left);
    return guard_exports.IsEqual(result3, ResultLeftInside) || guard_exports.IsEqual(result3, ResultEqual);
  });
  return guard_exports.IsEqual(result2, false);
}
function BroadenType(type, types) {
  const evaluated = EvaluateType(type);
  return IsAny(evaluated) ? [evaluated] : IsBroadestType(evaluated, types) ? [...BroadFilter(evaluated, types), evaluated] : types;
}
function BroadenTypes(types) {
  return types.reduce((result2, left) => {
    return IsObject2(left) ? [...result2, left] : (
      // push
      IsNever(left) ? result2 : (
        // ignore
        BroadenType(left, result2)
      )
    );
  }, []);
}
function Broaden(types) {
  const broadened = BroadenTypes(types);
  const flattened = Flatten(broadened);
  return flattened;
}
var init_broaden = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/broaden.mjs"() {
    init_guard2();
    init_any();
    init_never();
    init_object();
    init_compare();
    init_flatten();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/instantiate.mjs
function EvaluateAction(type, options) {
  const result2 = memory_exports.Update(EvaluateType(type), {}, options);
  return result2;
}
function EvaluateInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return EvaluateAction(instantiatedType, options);
}
var init_instantiate5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/instantiate.mjs"() {
    init_memory2();
    init_instantiate27();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/index.mjs
var init_evaluate3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/evaluate/index.mjs"() {
    init_broaden();
    init_compare();
    init_composite();
    init_distribute();
    init_evaluate2();
    init_flatten();
    init_instantiate5();
    init_narrow();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/call/distribute_arguments.mjs
function CollectDistributionNames(expression, result2 = []) {
  return (
    // Conditional
    IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? IsRef(expression.parameters[0]) ? CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], [...result2, expression.parameters[0]["$ref"]])) : CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], result2)) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? IsDeferred(expression.parameters[1]) && guard_exports.IsEqual(expression.parameters[1].action, "KeyOf") && IsRef(expression.parameters[1].parameters[0]) ? [...result2, expression.parameters[1].parameters[0]["$ref"]] : result2 : result2
  );
}
function BuildDistributionArray(parameters, names) {
  return parameters.reduce((result2, left) => [...result2, names.includes(left.name)], []);
}
function ZipDistributionArray(arguments_, distributionArray, result2 = []) {
  return guard_exports.ShiftLeft(arguments_, (argumentLeft, argumentRight) => guard_exports.ShiftLeft(distributionArray, (booleanLeft, booleanRight) => ZipDistributionArray(argumentRight, booleanRight, [...result2, [booleanLeft, argumentLeft]]), () => result2), () => result2);
}
function Expand(type) {
  return IsUnion(type) ? [...type.anyOf] : [type];
}
function Append(current, type) {
  return current.reduce((result2, left) => [...result2, [...left, type]], []);
}
function Cross(current, variants) {
  return variants.reduce((result2, left) => {
    return [...result2, ...Append(current, left)];
  }, []);
}
function Distribute2(zipped) {
  return zipped.reduce((result2, left) => {
    return guard_exports.IsEqual(left[0], true) ? Cross(result2, Expand(left[1])) : Cross(result2, [left[1]]);
  }, [[]]);
}
function DistributeArguments(parameters, arguments_, expression) {
  const distributionNames = CollectDistributionNames(expression);
  const distributionArray = BuildDistributionArray(parameters, distributionNames);
  const zippedArguments = ZipDistributionArray(arguments_, distributionArray);
  return IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? Distribute2(zippedArguments) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? Distribute2(zippedArguments) : [arguments_];
}
var init_distribute_arguments = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/call/distribute_arguments.mjs"() {
    init_guard2();
    init_union();
    init_deferred();
    init_ref();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/call/resolve_target.mjs
function FromNotResolvable() {
  return ["(not-resolvable)", Never()];
}
function FromNotGeneric() {
  return ["(not-generic)", Never()];
}
function FromGeneric(name, parameters, expression) {
  return [name, Generic(parameters, expression)];
}
function FromRef4(context, ref, arguments_) {
  return ref in context ? FromType6(context, ref, context[ref], arguments_) : FromNotResolvable();
}
function FromType6(context, name, target, arguments_) {
  return IsGeneric(target) ? FromGeneric(name, target.parameters, target.expression) : IsRef(target) ? FromRef4(context, target.$ref, arguments_) : FromNotGeneric();
}
function ResolveTarget(context, target, arguments_) {
  return FromType6(context, "(anonymous)", target, arguments_);
}
var init_resolve_target = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/call/resolve_target.mjs"() {
    init_generic();
    init_ref();
    init_never();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/call/resolve_arguments.mjs
function AssertArgumentExtends(name, type, extends_) {
  if (IsInfer(type) || IsCall(type) || result_exports.IsExtendsTrueLike(Extends({}, type, extends_)))
    return;
  const cause = { parameter: name, expect: extends_, actual: type };
  throw new Error(`Argument for parameter ${name} does not satisfy constraint`, { cause });
}
function BindArgument(context, state, name, extends_, type) {
  const instantiatedArgument = InstantiateType(context, state, type);
  AssertArgumentExtends(name, instantiatedArgument, extends_);
  return memory_exports.Assign(context, { [name]: instantiatedArgument });
}
function BindArguments(context, state, parameterLeft, parameterRight, arguments_) {
  const instantiatedExtends = InstantiateType(context, state, parameterLeft.extends);
  const instantiatedEquals = InstantiateType(context, state, parameterLeft.equals);
  return guard_exports.ShiftLeft(arguments_, (left, right) => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, left), state, parameterRight, right), () => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, instantiatedEquals), state, parameterRight, []));
}
function BindParameters(context, state, parameters, arguments_) {
  return guard_exports.ShiftLeft(parameters, (left, right) => BindArguments(context, state, left, right, arguments_), () => context);
}
function ResolveArgumentsContext(context, state, parameters, arguments_) {
  return BindParameters(context, state, parameters, arguments_);
}
var init_resolve_arguments = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/call/resolve_arguments.mjs"() {
    init_guard2();
    init_memory2();
    init_instantiate27();
    init_extends3();
    init_infer();
    init_call();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/call/instantiate.mjs
function Peek(state) {
  const result2 = guard_exports.IsGreaterThan(state.callstack.length, 0) ? state.callstack[state.callstack.length - 1] : "";
  return result2;
}
function IsTailCall(state, name) {
  const result2 = guard_exports.IsEqual(Peek(state), name);
  return result2;
}
function CallDispatch(context, state, target, parameters, expression, arguments_) {
  const argumentsContext = ResolveArgumentsContext(context, state, parameters, arguments_);
  const returnType = InstantiateType(argumentsContext, State([...state["callstack"], target["$ref"]], state["visited"]), expression);
  return InstantiateType(argumentsContext, State([], []), returnType);
}
function CallDistributed(context, state, target, parameters, expression, distributedArguments) {
  return distributedArguments.reduce((result2, arguments_) => [...result2, CallDispatch(context, state, target, parameters, expression, arguments_)], []);
}
function CallImmediate(context, state, target, parameters, expression, arguments_) {
  const distributedArguments = DistributeArguments(parameters, arguments_, expression);
  const returnTypes = CallDistributed(context, state, target, parameters, expression, distributedArguments);
  const result2 = guard_exports.IsEqual(returnTypes.length, 1) ? returnTypes[0] : EvaluateUnion(returnTypes);
  return result2;
}
function CallInstantiate(context, state, target, arguments_) {
  const instantiatedArguments = InstantiateTypes(context, state, arguments_);
  const resolved = ResolveTarget(context, target, arguments_);
  const name = resolved[0];
  const type = resolved[1];
  const result2 = IsGeneric(type) ? IsTailCall(state, name) ? CallConstruct(Ref(name), instantiatedArguments) : CallImmediate(context, state, Ref(name), type.parameters, type.expression, instantiatedArguments) : CallConstruct(target, instantiatedArguments);
  return result2;
}
var init_instantiate6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/call/instantiate.mjs"() {
    init_guard2();
    init_call();
    init_ref();
    init_generic();
    init_evaluate3();
    init_instantiate27();
    init_instantiate27();
    init_instantiate27();
    init_distribute_arguments();
    init_resolve_target();
    init_resolve_arguments();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/call.mjs
function CallConstruct(target, arguments_) {
  return memory_exports.Create({ ["~kind"]: "Call" }, { type: "call", target, arguments: arguments_ }, {});
}
function Call(target, arguments_) {
  return CallInstantiate({}, State([], []), target, arguments_);
}
function IsCall(value) {
  return IsKind(value, "Call");
}
var init_call = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/types/call.mjs"() {
    init_memory2();
    init_schema();
    init_instantiate6();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/immutable/instantiate_remove.mjs
function RemoveImmutableOperation(type) {
  return memory_exports.Discard(type, ["~immutable"]);
}
function RemoveImmutableAction(type, options) {
  const result2 = memory_exports.Update(RemoveImmutableOperation(type), {}, options);
  return result2;
}
function RemoveImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveImmutableAction(instantiatedType, options);
}
var init_instantiate_remove3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/immutable/instantiate_remove.mjs"() {
    init_memory2();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/mapping.mjs
function ApplyMapping(mapping, value) {
  return mapping(value);
}
var init_mapping2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/mapping.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/from_literal.mjs
function FromLiteral3(mapping, value) {
  return guard_exports.IsString(value) ? Literal(ApplyMapping(mapping, value)) : Literal(value);
}
var init_from_literal = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/from_literal.mjs"() {
    init_guard2();
    init_literal();
    init_mapping2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/from_template_literal.mjs
function FromTemplateLiteral(mapping, pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result2 = FromType7(mapping, evaluated);
  return result2;
}
var init_from_template_literal = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/from_template_literal.mjs"() {
    init_from_type();
    init_evaluate3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/from_union.mjs
function FromUnion2(mapping, types) {
  const result2 = types.map((type) => FromType7(mapping, type));
  return Union(result2);
}
var init_from_union = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/from_union.mjs"() {
    init_union();
    init_from_type();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/from_type.mjs
function FromType7(mapping, type) {
  return IsLiteral(type) ? FromLiteral3(mapping, type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral(mapping, type.pattern) : IsUnion(type) ? FromUnion2(mapping, type.anyOf) : type;
}
var init_from_type = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/from_type.mjs"() {
    init_literal();
    init_template_literal();
    init_union();
    init_from_literal();
    init_from_template_literal();
    init_from_union();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/capitalize.mjs
function CapitalizeDeferred(type, options = {}) {
  return Deferred("Capitalize", [type], options);
}
function Capitalize(type, options = {}) {
  return CapitalizeAction(type, options);
}
var init_capitalize = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/capitalize.mjs"() {
    init_deferred();
    init_instantiate7();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/lowercase.mjs
function LowercaseDeferred(type, options = {}) {
  return Deferred("Lowercase", [type], options);
}
function Lowercase(type, options = {}) {
  return LowercaseAction(type, options);
}
var init_lowercase = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/lowercase.mjs"() {
    init_deferred();
    init_instantiate7();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/uncapitalize.mjs
function UncapitalizeDeferred(type, options = {}) {
  return Deferred("Uncapitalize", [type], options);
}
function Uncapitalize(type, options = {}) {
  return UncapitalizeAction(type, options);
}
var init_uncapitalize = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/uncapitalize.mjs"() {
    init_deferred();
    init_instantiate7();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/uppercase.mjs
function UppercaseDeferred(type, options = {}) {
  return Deferred("Uppercase", [type], options);
}
function Uppercase(type, options = {}) {
  return UppercaseAction(type, options);
}
var init_uppercase = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/uppercase.mjs"() {
    init_deferred();
    init_instantiate7();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/instantiate.mjs
function CapitalizeAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(FromType7(CapitalizeMapping, type), {}, options) : CapitalizeDeferred(type, options);
  return result2;
}
function LowercaseAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(FromType7(LowercaseMapping, type), {}, options) : LowercaseDeferred(type, options);
  return result2;
}
function UncapitalizeAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(FromType7(UncapitalizeMapping, type), {}, options) : UncapitalizeDeferred(type, options);
  return result2;
}
function UppercaseAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(FromType7(UppercaseMapping, type), {}, options) : UppercaseDeferred(type, options);
  return result2;
}
function CapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return CapitalizeAction(instantiatedType, options);
}
function LowercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return LowercaseAction(instantiatedType, options);
}
function UncapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UncapitalizeAction(instantiatedType, options);
}
function UppercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UppercaseAction(instantiatedType, options);
}
var CapitalizeMapping, LowercaseMapping, UncapitalizeMapping, UppercaseMapping;
var init_instantiate7 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/instantiate.mjs"() {
    init_memory2();
    init_from_type();
    init_instantiate27();
    init_capitalize();
    init_lowercase();
    init_uncapitalize();
    init_uppercase();
    CapitalizeMapping = (input) => input[0].toUpperCase() + input.slice(1);
    LowercaseMapping = (input) => input.toLowerCase();
    UncapitalizeMapping = (input) => input[0].toLowerCase() + input.slice(1);
    UppercaseMapping = (input) => input.toUpperCase();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/conditional.mjs
function ConditionalDeferred(left, right, true_, false_, options = {}) {
  return Deferred("Conditional", [left, right, true_, false_], options);
}
function Conditional(left, right, true_, false_, options = {}) {
  return ConditionalAction({}, State([], []), left, right, true_, false_, options);
}
var init_conditional = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/conditional.mjs"() {
    init_deferred();
    init_instantiate8();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/conditional/instantiate.mjs
function ConditionalOperation(context, state, left, right, true_, false_) {
  const extendsResult = Extends(context, left, right);
  return result_exports.IsExtendsUnion(extendsResult) ? Union([InstantiateType(extendsResult.inferred, state, true_), InstantiateType(context, state, false_)]) : result_exports.IsExtendsTrue(extendsResult) ? InstantiateType(extendsResult.inferred, state, true_) : InstantiateType(context, state, false_);
}
function ConditionalAction(context, state, left, right, true_, false_, options) {
  const result2 = CanInstantiate([left, right]) ? memory_exports.Update(ConditionalOperation(context, state, left, right, true_, false_), {}, options) : ConditionalDeferred(left, right, true_, false_, options);
  return result2;
}
function ConditionalInstantiate(context, state, left, right, true_, false_, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ConditionalAction(context, state, instantiatedLeft, instantiatedRight, true_, false_, options);
}
var init_instantiate8 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/conditional/instantiate.mjs"() {
    init_memory2();
    init_union();
    init_extends3();
    init_instantiate27();
    init_conditional();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/conditional/index.mjs
var init_conditional2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/conditional/index.mjs"() {
    init_instantiate8();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/constructor_parameters.mjs
function ConstructorParametersDeferred(type, options = {}) {
  return Deferred("ConstructorParameters", [type], options);
}
function ConstructorParameters(type, options = {}) {
  return ConstructorParametersAction(type, options);
}
var init_constructor_parameters = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/constructor_parameters.mjs"() {
    init_deferred();
    init_instantiate9();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/constructor_parameters/instantiate.mjs
function ConstructorParametersOperation(type) {
  const parameters = IsConstructor2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result2 = Tuple(instantiatedParameters);
  return result2;
}
function ConstructorParametersAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(ConstructorParametersOperation(type), {}, options) : ConstructorParametersDeferred(type, options);
  return result2;
}
function ConstructorParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ConstructorParametersAction(instantiatedType, options);
}
var init_instantiate9 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/constructor_parameters/instantiate.mjs"() {
    init_memory2();
    init_constructor();
    init_tuple();
    init_constructor_parameters();
    init_instantiate27();
    init_instantiate27();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/exclude.mjs
function ExcludeDeferred(left, right, options = {}) {
  return Deferred("Exclude", [left, right], options);
}
function Exclude(left, right, options = {}) {
  return ExcludeAction(left, right, options);
}
var init_exclude = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/exclude.mjs"() {
    init_deferred();
    init_instantiate10();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/exclude/instantiate.mjs
function ExcludeAction(left, right, options) {
  const result2 = CanInstantiate([left, right]) ? memory_exports.Update(ExcludeOperation(left, right), {}, options) : ExcludeDeferred(left, right, options);
  return result2;
}
function ExcludeInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExcludeAction(instantiatedLeft, instantiatedRight, options);
}
var init_instantiate10 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/exclude/instantiate.mjs"() {
    init_memory2();
    init_instantiate27();
    init_exclude();
    init_operation();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/extract.mjs
function ExtractDeferred(left, right, options = {}) {
  return Deferred("Extract", [left, right], options);
}
function Extract(left, right, options = {}) {
  return ExtractAction(left, right, options);
}
var init_extract = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/extract.mjs"() {
    init_deferred();
    init_instantiate11();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/extract/operation.mjs
function ExtractType(left, right) {
  const check = Extends({}, left, right);
  const result2 = result_exports.IsExtendsTrueLike(check) ? [left] : [];
  return result2;
}
function ExtractUnion(types, right) {
  return types.reduce((result2, head) => {
    return [...result2, ...ExtractType(head, right)];
  }, []);
}
function ExtractOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExtractUnion(canonical, right);
  const result2 = EvaluateUnion(remaining);
  return result2;
}
var init_operation2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/extract/operation.mjs"() {
    init_union();
    init_extends3();
    init_evaluate2();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/extract/instantiate.mjs
function ExtractAction(left, right, options) {
  const result2 = CanInstantiate([left, right]) ? memory_exports.Update(ExtractOperation(left, right), {}, options) : ExtractDeferred(left, right, options);
  return result2;
}
function ExtractInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExtractAction(instantiatedLeft, instantiatedRight, options);
}
var init_instantiate11 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/extract/instantiate.mjs"() {
    init_memory2();
    init_instantiate27();
    init_extract();
    init_operation2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/helpers/keys_to_indexer.mjs
function KeysToLiterals(keys) {
  return keys.reduce((result2, left) => {
    return IsLiteralValue(left) ? [...result2, Literal(left)] : result2;
  }, []);
}
function KeysToIndexer(keys) {
  const literals = KeysToLiterals(keys);
  const result2 = Union(literals);
  return result2;
}
var init_keys_to_indexer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/helpers/keys_to_indexer.mjs"() {
    init_literal();
    init_union();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/indexed.mjs
function IndexDeferred(type, indexer, options = {}) {
  return Deferred("Index", [type, indexer], options);
}
function Index(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return IndexAction(type, indexer, options);
}
var init_indexed = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/indexed.mjs"() {
    init_guard2();
    init_deferred();
    init_keys_to_indexer();
    init_instantiate12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_cyclic.mjs
function FromCyclic(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result2 = FromType8(target);
  return result2;
}
var init_from_cyclic = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_cyclic.mjs"() {
    init_from_type2();
    init_target();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_dependent.mjs
function FromDependent(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result2 = FromType8(evaluated);
  return result2;
}
var init_from_dependent = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_dependent.mjs"() {
    init_from_type2();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_intersect.mjs
function CollapseIntersectProperties(left, right) {
  const leftKeys = guard_exports.Keys(left).filter((key) => !guard_exports.HasPropertyKey(right, key));
  const rightKeys = guard_exports.Keys(right).filter((key) => !guard_exports.HasPropertyKey(left, key));
  const sharedKeys = guard_exports.Keys(left).filter((key) => guard_exports.HasPropertyKey(right, key));
  const leftProperties = leftKeys.reduce((result2, key) => ({ ...result2, [key]: left[key] }), {});
  const rightProperties = rightKeys.reduce((result2, key) => ({ ...result2, [key]: right[key] }), {});
  const sharedProperties = sharedKeys.reduce((result2, key) => ({ ...result2, [key]: EvaluateIntersect([left[key], right[key]]) }), {});
  const unique = memory_exports.Assign(leftProperties, rightProperties);
  const shared = memory_exports.Assign(unique, sharedProperties);
  return shared;
}
function FromIntersect(types) {
  return types.reduce((result2, left) => {
    return CollapseIntersectProperties(result2, FromType8(left));
  }, {});
}
var init_from_intersect = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_intersect.mjs"() {
    init_memory2();
    init_guard2();
    init_from_type2();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_object.mjs
function FromObject4(properties) {
  return properties;
}
var init_from_object = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_object.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_tuple.mjs
function FromTuple(types) {
  const object = TupleToObject(Tuple(types));
  const result2 = FromType8(object);
  return result2;
}
var init_from_tuple = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_tuple.mjs"() {
    init_tuple();
    init_to_object();
    init_from_type2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_union.mjs
function CollapseUnionProperties(left, right) {
  const sharedKeys = guard_exports.Keys(left).filter((key) => key in right);
  const result2 = sharedKeys.reduce((result3, key) => {
    return { ...result3, [key]: EvaluateUnion([left[key], right[key]]) };
  }, {});
  return result2;
}
function ReduceVariants(types, result2) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, CollapseUnionProperties(result2, FromType8(left))), () => result2);
}
function FromUnion3(types) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, FromType8(left)), () => Unreachable());
}
var init_from_union2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_union.mjs"() {
    init_guard2();
    init_unreachable2();
    init_evaluate2();
    init_from_type2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_type.mjs
function FromType8(type) {
  return IsCyclic(type) ? FromCyclic(type.$defs, type.$ref) : IsDependent(type) ? FromDependent(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect(type.allOf) : IsUnion(type) ? FromUnion3(type.anyOf) : IsTuple(type) ? FromTuple(type.items) : IsObject2(type) ? FromObject4(type.properties) : {};
}
var init_from_type2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/from_type.mjs"() {
    init_cyclic();
    init_dependent();
    init_intersect();
    init_object();
    init_tuple();
    init_union();
    init_from_cyclic();
    init_from_dependent();
    init_from_intersect();
    init_from_object();
    init_from_tuple();
    init_from_union2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/collapse.mjs
function CollapseToObject(type) {
  const properties = FromType8(type);
  const result2 = _Object_(properties);
  return result2;
}
var init_collapse = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/collapse.mjs"() {
    init_object();
    init_from_type2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/index.mjs
var init_object3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/object/index.mjs"() {
    init_collapse();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/helpers/keys.mjs
function ConvertToIntegerKey(value) {
  const normal = `${value}`;
  return integerKeyPattern.test(normal) ? parseInt(normal) : value;
}
var integerKeyPattern;
var init_keys = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/helpers/keys.mjs"() {
    integerKeyPattern = new RegExp("^(?:0|[1-9][0-9]*)$");
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/from_array.mjs
function NormalizeLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function NormalizeIndexerTypes(types) {
  return types.map((type) => NormalizeIndexer(type));
}
function NormalizeIndexer(type) {
  return IsIntersect(type) ? Intersect(NormalizeIndexerTypes(type.allOf)) : IsUnion(type) ? Union(NormalizeIndexerTypes(type.anyOf)) : IsLiteral(type) ? NormalizeLiteral(type.const) : type;
}
function FromArray3(type, indexer) {
  const normalizedIndexer = NormalizeIndexer(indexer);
  const check = Extends({}, normalizedIndexer, Number2());
  const result2 = (
    // indexer
    result_exports.IsExtendsTrueLike(check) ? type : IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Number2() : Never()
  );
  return result2;
}
var init_from_array = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/from_array.mjs"() {
    init_guard2();
    init_intersect();
    init_union();
    init_literal();
    init_number();
    init_never();
    init_extends3();
    init_keys();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_cyclic.mjs
function FromCyclic2(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result2 = FromType9(target);
  return result2;
}
var init_from_cyclic2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_cyclic.mjs"() {
    init_from_type3();
    init_target();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_dependent.mjs
function FromDependent2(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result2 = FromType9(evaluated);
  return result2;
}
var init_from_dependent2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_dependent.mjs"() {
    init_from_type3();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_enum.mjs
function FromEnum(values) {
  const evaluated = EvaluateEnum(values);
  const result2 = FromType9(evaluated);
  return result2;
}
var init_from_enum = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_enum.mjs"() {
    init_from_type3();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_intersect.mjs
function FromIntersect2(types) {
  const evaluated = EvaluateIntersect(types);
  const result2 = FromType9(evaluated);
  return result2;
}
var init_from_intersect2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_intersect.mjs"() {
    init_evaluate2();
    init_from_type3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_literal.mjs
function FromLiteral4(value) {
  const result2 = [`${value}`];
  return result2;
}
var init_from_literal2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_literal.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_template_literal.mjs
function FromTemplateLiteral2(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result2 = FromType9(evaluated);
  return result2;
}
var init_from_template_literal2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_template_literal.mjs"() {
    init_from_type3();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_union.mjs
function FromUnion4(types) {
  return types.reduce((result2, left) => {
    return [...result2, ...FromType9(left)];
  }, []);
}
var init_from_union3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_union.mjs"() {
    init_from_type3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_type.mjs
function FromType9(type) {
  return IsCyclic(type) ? FromCyclic2(type.$defs, type.$ref) : IsDependent(type) ? FromDependent2(type.if, type.then, type.else) : IsEnum(type) ? FromEnum(type.enum) : IsIntersect(type) ? FromIntersect2(type.allOf) : IsLiteral(type) ? FromLiteral4(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral2(type.pattern) : IsUnion(type) ? FromUnion4(type.anyOf) : [];
}
var init_from_type3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/from_type.mjs"() {
    init_cyclic();
    init_dependent();
    init_enum();
    init_intersect();
    init_literal();
    init_template_literal();
    init_union();
    init_from_cyclic2();
    init_from_dependent2();
    init_from_enum();
    init_from_intersect2();
    init_from_literal2();
    init_from_template_literal2();
    init_from_union3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/to_indexable_keys.mjs
function ToIndexableKeys(type) {
  const result2 = FromType9(type);
  return result2;
}
var init_to_indexable_keys = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/to_indexable_keys.mjs"() {
    init_from_type3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/this/expand_this.mjs
function FromTypes5(properties, types) {
  return types.map((type) => FromType10(properties, type));
}
function FromType10(properties, type) {
  return IsArray2(type) ? _Array_(FromType10(properties, type.items)) : IsConstructor2(type) ? Constructor(FromTypes5(properties, type.parameters), FromType10(properties, type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes5(properties, type.parameters), FromType10(properties, type.returnType)) : IsTuple(type) ? Tuple(FromTypes5(properties, type.items)) : IsUnion(type) ? Union(FromTypes5(properties, type.anyOf)) : IsIntersect(type) ? Intersect(FromTypes5(properties, type.allOf)) : IsThis(type) ? _Object_(properties) : type;
}
function ExpandThis(properties, type) {
  const result2 = FromType10(properties, type);
  return result2;
}
var init_expand_this = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/this/expand_this.mjs"() {
    init_array();
    init_constructor();
    init_function();
    init_intersect();
    init_object();
    init_tuple();
    init_this();
    init_union();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/from_object.mjs
function IndexProperty(properties, key) {
  const selectedType = key in properties ? properties[key] : Never();
  const result2 = ExpandThis(properties, selectedType);
  return result2;
}
function IndexProperties(properties, keys) {
  return keys.reduce((result2, left) => {
    return [...result2, IndexProperty(properties, left)];
  }, []);
}
function FromIndexer(properties, indexer) {
  const keys = ToIndexableKeys(indexer);
  const variants = IndexProperties(properties, keys);
  const result2 = EvaluateUnion(variants);
  return result2;
}
function NumericKeys(keys) {
  const result2 = keys.filter((key) => NumericKeyPattern.test(key));
  return result2;
}
function FromIndexerNumber(properties) {
  const keys = PropertyKeys(properties);
  const numericKeys = NumericKeys(keys);
  const variants = IndexProperties(properties, numericKeys);
  const result2 = EvaluateUnion(variants);
  return result2;
}
function FromObject5(properties, indexer) {
  const result2 = IsNumber3(indexer) ? FromIndexerNumber(properties) : FromIndexer(properties, indexer);
  return result2;
}
var NumericKeyPattern;
var init_from_object2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/from_object.mjs"() {
    init_number();
    init_never();
    init_properties();
    init_evaluate2();
    init_to_indexable_keys();
    init_record();
    init_expand_this();
    NumericKeyPattern = new RegExp(IntegerKey);
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/array_indexer.mjs
function ConvertLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function ArrayIndexerTypes(types) {
  return types.map((type) => FormatArrayIndexer(type));
}
function FormatArrayIndexer(type) {
  return IsIntersect(type) ? Intersect(ArrayIndexerTypes(type.allOf)) : IsUnion(type) ? Union(ArrayIndexerTypes(type.anyOf)) : IsLiteral(type) ? ConvertLiteral(type.const) : type;
}
var init_array_indexer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/array_indexer.mjs"() {
    init_union();
    init_intersect();
    init_literal();
    init_keys();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/from_tuple.mjs
function IndexElementsWithIndexer(types, indexer) {
  return types.reduceRight((result2, right, index) => {
    const check = Extends({}, Literal(index), indexer);
    return result_exports.IsExtendsTrueLike(check) ? [right, ...result2] : result2;
  }, []);
}
function FromTupleWithIndexer(types, indexer) {
  const formattedArrayIndexer = FormatArrayIndexer(indexer);
  const elements = IndexElementsWithIndexer(types, formattedArrayIndexer);
  return EvaluateUnionFast(elements);
}
function FromTupleWithoutIndexer(types) {
  return EvaluateUnionFast(types);
}
function FromTuple2(types, indexer) {
  return (
    // length (intrinsic)
    IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Literal(types.length) : IsNumber3(indexer) || IsInteger2(indexer) ? FromTupleWithoutIndexer(types) : FromTupleWithIndexer(types, indexer)
  );
}
var init_from_tuple2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/from_tuple.mjs"() {
    init_guard2();
    init_literal();
    init_number();
    init_integer();
    init_evaluate2();
    init_extends3();
    init_array_indexer();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/from_type.mjs
function FromType11(type, indexer) {
  return IsArray2(type) ? FromArray3(type.items, indexer) : IsObject2(type) ? FromObject5(type.properties, indexer) : IsTuple(type) ? FromTuple2(type.items, indexer) : Never();
}
var init_from_type4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/from_type.mjs"() {
    init_array();
    init_never();
    init_object();
    init_tuple();
    init_from_array();
    init_from_object2();
    init_from_tuple2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/instantiate.mjs
function NormalizeType(type) {
  const result2 = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result2;
}
function IndexAction(type, indexer, options) {
  const result2 = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType11(NormalizeType(type), indexer), {}, options) : IndexDeferred(type, indexer, options);
  return result2;
}
function IndexInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return IndexAction(instantiatedType, instantiatedIndexer, options);
}
var init_instantiate12 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/instantiate.mjs"() {
    init_memory2();
    init_cyclic();
    init_dependent();
    init_intersect();
    init_union();
    init_instantiate27();
    init_indexed();
    init_object3();
    init_from_type4();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/instance_type.mjs
function InstanceTypeDeferred(type, options = {}) {
  return Deferred("InstanceType", [type], options);
}
function InstanceType(type, options = {}) {
  return InstanceTypeAction(type, options);
}
var init_instance_type = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/instance_type.mjs"() {
    init_deferred();
    init_instantiate13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/instance_type/instantiate.mjs
function InstanceTypeOperation(type) {
  return IsConstructor2(type) ? type["instanceType"] : Never();
}
function InstanceTypeAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(InstanceTypeOperation(type), {}, options) : InstanceTypeDeferred(type, options);
  return result2;
}
function InstanceTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return InstanceTypeAction(instantiatedType, options);
}
var init_instantiate13 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/instance_type/instantiate.mjs"() {
    init_memory2();
    init_constructor();
    init_never();
    init_instance_type();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/keyof.mjs
function KeyOfDeferred(type, options = {}) {
  return Deferred("KeyOf", [type], options);
}
function KeyOf2(type, options = {}) {
  return KeyOfAction(type, options);
}
var init_keyof = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/keyof.mjs"() {
    init_deferred();
    init_instantiate14();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_any.mjs
function FromAny() {
  return Union([Number2(), String2(), Symbol2()]);
}
var init_from_any = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_any.mjs"() {
    init_number();
    init_string2();
    init_symbol();
    init_union();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_array.mjs
function FromArray4(_type) {
  return Number2();
}
var init_from_array2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_array.mjs"() {
    init_number();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_object.mjs
function FromPropertyKeys(keys) {
  const result2 = keys.reduce((result3, left) => {
    return IsLiteralValue(left) ? [...result3, Literal(ConvertToIntegerKey(left))] : Unreachable();
  }, []);
  return result2;
}
function FromObject6(properties) {
  const propertyKeys = guard_exports.Keys(properties);
  const variants = FromPropertyKeys(propertyKeys);
  const result2 = EvaluateUnionFast(variants);
  return result2;
}
var init_from_object3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_object.mjs"() {
    init_unreachable2();
    init_guard2();
    init_literal();
    init_keys();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_record.mjs
function FromRecord2(type) {
  return RecordKey(type);
}
var init_from_record = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_record.mjs"() {
    init_record();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_tuple.mjs
function FromTuple3(types) {
  const result2 = types.map((_, index) => Literal(index));
  return EvaluateUnionFast(result2);
}
var init_from_tuple3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_tuple.mjs"() {
    init_literal();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_type.mjs
function FromType12(type) {
  return IsAny(type) ? FromAny() : IsArray2(type) ? FromArray4(type.items) : IsObject2(type) ? FromObject6(type.properties) : IsRecord(type) ? FromRecord2(type) : IsTuple(type) ? FromTuple3(type.items) : Never();
}
var init_from_type5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/from_type.mjs"() {
    init_any();
    init_array();
    init_never();
    init_object();
    init_record();
    init_tuple();
    init_from_any();
    init_from_array2();
    init_from_object3();
    init_from_record();
    init_from_tuple3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/instantiate.mjs
function NormalizeType2(type) {
  const result2 = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result2;
}
function KeyOfAction(type, options) {
  return CanInstantiate([type]) ? memory_exports.Update(FromType12(NormalizeType2(type)), {}, options) : KeyOfDeferred(type, options);
}
function KeyOfInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return KeyOfAction(instantiatedType, options);
}
var init_instantiate14 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/instantiate.mjs"() {
    init_memory2();
    init_cyclic();
    init_dependent();
    init_intersect();
    init_union();
    init_keyof();
    init_instantiate27();
    init_object3();
    init_from_type5();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/mapped.mjs
function MappedDeferred(identifier, type, as, property, options = {}) {
  return Deferred("Mapped", [identifier, type, as, property], options);
}
function Mapped(identifier, type, as, property, options = {}) {
  return MappedAction({}, State([], []), identifier, type, as, property, options);
}
var init_mapped = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/mapped.mjs"() {
    init_deferred();
    init_instantiate15();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/mapped/mapped_variants.mjs
function FromTemplateLiteral3(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result2 = FromType13(evaluated);
  return result2;
}
function FromUnion5(types) {
  return types.reduce((result2, left) => {
    return [...result2, ...FromType13(left)];
  }, []);
}
function FromEnum2(values) {
  const evaluated = EvaluateEnum(values);
  const result2 = FromType13(evaluated);
  return result2;
}
function FromLiteral5(value) {
  const result2 = guard_exports.IsNumber(value) ? [Literal(`${value}`)] : [Literal(value)];
  return result2;
}
function FromType13(type) {
  const result2 = IsEnum(type) ? FromEnum2(type.enum) : IsLiteral(type) ? FromLiteral5(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral3(type.pattern) : IsUnion(type) ? FromUnion5(type.anyOf) : [type];
  return result2;
}
function MappedVariants(type) {
  const result2 = FromType13(type);
  return result2;
}
var init_mapped_variants = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/mapped/mapped_variants.mjs"() {
    init_guard2();
    init_literal();
    init_enum();
    init_template_literal();
    init_union();
    init_evaluate2();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/mapped/mapped_operation.mjs
function CanonicalAs(instantiatedAs) {
  const result2 = IsTemplateLiteral(instantiatedAs) ? EvaluateTemplateLiteral(instantiatedAs.pattern) : instantiatedAs;
  return result2;
}
function MappedVariant(context, state, identifier, variant, as, property) {
  const variantContext = memory_exports.Assign(context, { [identifier["name"]]: variant });
  const instantiatedAs = InstantiateType(variantContext, state, as);
  const canonicalAs = CanonicalAs(instantiatedAs);
  const instantiatedProperty = InstantiateType(variantContext, state, property);
  return IsLiteralNumber(canonicalAs) || IsLiteralString(canonicalAs) ? { [canonicalAs.const]: instantiatedProperty } : {};
}
function MappedProperties(context, state, identifier, variants, as, property) {
  return variants.reduce((result2, left) => {
    return [...result2, MappedVariant(context, state, identifier, left, as, property)];
  }, []);
}
function MappedObjects(properties) {
  return properties.reduce((result2, left) => {
    return [...result2, _Object_(left)];
  }, []);
}
function MappedOperation(context, state, identifier, type, as, property) {
  const variants = MappedVariants(type);
  const mappedProperties = MappedProperties(context, state, identifier, variants, as, property);
  const mappedObjects = MappedObjects(mappedProperties);
  const result2 = EvaluateIntersect(mappedObjects);
  return result2;
}
var init_mapped_operation = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/mapped/mapped_operation.mjs"() {
    init_memory2();
    init_literal();
    init_object();
    init_template_literal();
    init_instantiate27();
    init_evaluate2();
    init_evaluate2();
    init_mapped_variants();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/mapped/instantiate.mjs
function MappedAction(context, state, identifier, type, as, property, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(MappedOperation(context, state, identifier, type, as, property), {}, options) : MappedDeferred(identifier, type, as, property, options);
  return result2;
}
function MappedInstantiate(context, state, identifier, type, as, property, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return MappedAction(context, state, identifier, instantiatedType, as, property, options);
}
var init_instantiate15 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/mapped/instantiate.mjs"() {
    init_memory2();
    init_mapped();
    init_instantiate27();
    init_mapped_operation();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/module/instantiate.mjs
function InstantiateCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => cyclicKeys.includes(key));
  return declarationKeys.reduce((result2, key) => {
    return { ...result2, [key]: InstantiateCyclic(declarationContext, key, declarations[key]) };
  }, {});
}
function InstantiateNonCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => !cyclicKeys.includes(key));
  return declarationKeys.reduce((result2, key) => {
    return { ...result2, [key]: InstantiateType(declarationContext, State([], []), declarations[key]) };
  }, {});
}
function InstantiateModule(context, declarations, options) {
  const cyclicCandidates = CyclicCandidates(declarations);
  const instantiatedCyclics = InstantiateCyclics(context, declarations, cyclicCandidates);
  const instantiatedNonCyclics = InstantiateNonCyclics(context, declarations, cyclicCandidates);
  const instantiatedModule = { ...instantiatedCyclics, ...instantiatedNonCyclics };
  return memory_exports.Update(instantiatedModule, {}, options);
}
function ModuleInstantiate(context, _state, declarations, options) {
  const instantiatedModule = InstantiateModule(context, declarations, options);
  return instantiatedModule;
}
var init_instantiate16 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/module/instantiate.mjs"() {
    init_guard2();
    init_memory2();
    init_instantiate27();
    init_candidates();
    init_instantiate4();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/non_nullable.mjs
function NonNullableDeferred(type, options = {}) {
  return Deferred("NonNullable", [type], options);
}
function NonNullable(type, options = {}) {
  return NonNullableAction(type, options);
}
var init_non_nullable = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/non_nullable.mjs"() {
    init_deferred();
    init_instantiate17();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/non_nullable/instantiate.mjs
function NonNullableOperation(type) {
  const excluded = Union([Null(), Undefined()]);
  return ExcludeAction(type, excluded, {});
}
function NonNullableAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(NonNullableOperation(type), {}, options) : NonNullableDeferred(type, options);
  return result2;
}
function NonNullableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return NonNullableAction(instantiatedType, options);
}
var init_instantiate17 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/non_nullable/instantiate.mjs"() {
    init_memory2();
    init_null();
    init_undefined();
    init_union();
    init_instantiate10();
    init_non_nullable();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/omit.mjs
function OmitDeferred(type, indexer, options = {}) {
  return Deferred("Omit", [type, indexer], options);
}
function Omit(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return OmitAction(type, indexer, options);
}
var init_omit = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/omit.mjs"() {
    init_guard2();
    init_deferred();
    init_keys_to_indexer();
    init_instantiate18();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/to_indexable.mjs
function ToIndexable(type) {
  const collapsed = CollapseToObject(type);
  const result2 = IsObject2(collapsed) ? collapsed.properties : Unreachable();
  return result2;
}
var init_to_indexable = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexable/to_indexable.mjs"() {
    init_unreachable2();
    init_object();
    init_object3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/omit/from_type.mjs
function FromKeys(properties, keys) {
  const result2 = guard_exports.Keys(properties).reduce((result3, key) => {
    return keys.includes(key) ? result3 : { ...result3, [key]: properties[key] };
  }, {});
  return result2;
}
function FromType14(type, indexer) {
  const indexable = ToIndexable(type);
  const indexableKeys = ToIndexableKeys(indexer);
  const omitted = FromKeys(indexable, indexableKeys);
  const result2 = _Object_(omitted);
  return result2;
}
var init_from_type6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/omit/from_type.mjs"() {
    init_guard2();
    init_object();
    init_to_indexable_keys();
    init_to_indexable();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/omit/instantiate.mjs
function OmitAction(type, indexer, options) {
  const result2 = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType14(type, indexer), {}, options) : OmitDeferred(type, indexer, options);
  return result2;
}
function OmitInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return OmitAction(instantiatedType, instantiatedIndexer, options);
}
var init_instantiate18 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/omit/instantiate.mjs"() {
    init_memory2();
    init_omit();
    init_instantiate27();
    init_from_type6();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/parameters.mjs
function ParametersDeferred(type, options = {}) {
  return Deferred("Parameters", [type], options);
}
function Parameters(type, options = {}) {
  return ParametersAction(type, options);
}
var init_parameters2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/parameters.mjs"() {
    init_deferred();
    init_instantiate19();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/parameters/instantiate.mjs
function ParametersOperation(type) {
  const parameters = IsFunction2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result2 = Tuple(instantiatedParameters);
  return result2;
}
function ParametersAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(ParametersOperation(type), {}, options) : ParametersDeferred(type, options);
  return result2;
}
function ParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ParametersAction(instantiatedType, options);
}
var init_instantiate19 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/parameters/instantiate.mjs"() {
    init_memory2();
    init_function();
    init_tuple();
    init_parameters2();
    init_instantiate27();
    init_instantiate27();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/partial.mjs
function PartialDeferred(type, options = {}) {
  return Deferred("Partial", [type], options);
}
function Partial(type, options = {}) {
  return PartialAction(type, options);
}
var init_partial = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/partial.mjs"() {
    init_deferred();
    init_instantiate20();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_cyclic.mjs
function FromCyclic3(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType15(target);
  const result2 = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result2;
}
var init_from_cyclic3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_cyclic.mjs"() {
    init_memory2();
    init_cyclic();
    init_from_type7();
    init_target();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_dependent.mjs
function FromDependent3(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result2 = FromType15(evaluated);
  return result2;
}
var init_from_dependent3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_dependent.mjs"() {
    init_from_type7();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_intersect.mjs
function FromIntersect3(types) {
  const evaluated = EvaluateIntersect(types);
  const result2 = FromType15(evaluated);
  return result2;
}
var init_from_intersect3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_intersect.mjs"() {
    init_from_type7();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_union.mjs
function FromUnion6(types) {
  const result2 = types.map((type) => FromType15(type));
  return Union(result2);
}
var init_from_union4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_union.mjs"() {
    init_union();
    init_from_type7();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_object.mjs
function FromObject7(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result3, left) => {
    return { ...result3, [left]: AddOptional(properties[left]) };
  }, {});
  const result2 = _Object_(mapped);
  return result2;
}
var init_from_object4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_object.mjs"() {
    init_guard2();
    init_object();
    init_add_optional();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_type.mjs
function FromType15(type) {
  return IsCyclic(type) ? FromCyclic3(type.$defs, type.$ref) : IsDependent(type) ? FromDependent3(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect3(type.allOf) : IsUnion(type) ? FromUnion6(type.anyOf) : IsObject2(type) ? FromObject7(type.properties) : _Object_({});
}
var init_from_type7 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/from_type.mjs"() {
    init_cyclic();
    init_dependent();
    init_intersect();
    init_object();
    init_union();
    init_from_cyclic3();
    init_from_dependent3();
    init_from_intersect3();
    init_from_union4();
    init_from_object4();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/instantiate.mjs
function PartialAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(FromType15(type), {}, options) : PartialDeferred(type, options);
  return result2;
}
function PartialInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return PartialAction(instantiatedType, options);
}
var init_instantiate20 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/instantiate.mjs"() {
    init_memory2();
    init_partial();
    init_from_type7();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/pick.mjs
function PickDeferred(type, indexer, options = {}) {
  return Deferred("Pick", [type, indexer], options);
}
function Pick(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return PickAction(type, indexer, options);
}
var init_pick = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/pick.mjs"() {
    init_guard2();
    init_deferred();
    init_keys_to_indexer();
    init_instantiate21();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/pick/from_type.mjs
function FromKeys2(properties, keys) {
  const result2 = guard_exports.Keys(properties).reduce((result3, key) => {
    return keys.includes(key) ? memory_exports.Assign(result3, { [key]: properties[key] }) : result3;
  }, {});
  return result2;
}
function FromType16(type, indexer) {
  const indexable = ToIndexable(type);
  const keys = ToIndexableKeys(indexer);
  const applied = FromKeys2(indexable, keys);
  const result2 = _Object_(applied);
  return result2;
}
var init_from_type8 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/pick/from_type.mjs"() {
    init_memory2();
    init_guard2();
    init_object();
    init_to_indexable_keys();
    init_to_indexable();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/pick/instantiate.mjs
function PickAction(type, indexer, options) {
  const result2 = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType16(type, indexer), {}, options) : PickDeferred(type, indexer, options);
  return result2;
}
function PickInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return PickAction(instantiatedType, instantiatedIndexer, options);
}
var init_instantiate21 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/pick/instantiate.mjs"() {
    init_memory2();
    init_pick();
    init_instantiate27();
    init_from_type8();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/readonly_object.mjs
function ReadonlyObjectDeferred(type, options = {}) {
  return Deferred("ReadonlyObject", [type], options);
}
function ReadonlyObject(type, options = {}) {
  return ReadonlyObjectAction(type, options);
}
var ReadonlyType;
var init_readonly_object = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/readonly_object.mjs"() {
    init_deferred();
    init_instantiate22();
    ReadonlyType = ReadonlyObject;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_array.mjs
function FromArray5(type) {
  const result2 = AddImmutable(_Array_(type));
  return result2;
}
var init_from_array3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_array.mjs"() {
    init_array();
    init_add_immutable();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_cyclic.mjs
function FromCyclic4(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType17(target);
  const result2 = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result2;
}
var init_from_cyclic4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_cyclic.mjs"() {
    init_memory2();
    init_cyclic();
    init_from_type9();
    init_target();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_dependent.mjs
function FromDependent4(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result2 = FromType17(evaluated);
  return result2;
}
var init_from_dependent4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_dependent.mjs"() {
    init_from_type9();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_intersect.mjs
function FromIntersect4(types) {
  const evaluated = EvaluateIntersect(types);
  const result2 = FromType17(evaluated);
  return result2;
}
var init_from_intersect4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_intersect.mjs"() {
    init_from_type9();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_object.mjs
function FromObject8(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result3, left) => {
    return { ...result3, [left]: AddReadonly(properties[left]) };
  }, {});
  const result2 = _Object_(mapped);
  return result2;
}
var init_from_object5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_object.mjs"() {
    init_guard2();
    init_object();
    init_add_readonly();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_tuple.mjs
function FromTuple4(types) {
  const result2 = AddImmutable(Tuple(types));
  return result2;
}
var init_from_tuple4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_tuple.mjs"() {
    init_tuple();
    init_add_immutable();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_union.mjs
function FromUnion7(types) {
  const result2 = types.map((type) => FromType17(type));
  return Union(result2);
}
var init_from_union5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_union.mjs"() {
    init_union();
    init_from_type9();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_type.mjs
function FromType17(type) {
  return IsArray2(type) ? FromArray5(type.items) : IsCyclic(type) ? FromCyclic4(type.$defs, type.$ref) : IsDependent(type) ? FromDependent4(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect4(type.allOf) : IsObject2(type) ? FromObject8(type.properties) : IsTuple(type) ? FromTuple4(type.items) : IsUnion(type) ? FromUnion7(type.anyOf) : type;
}
var init_from_type9 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/from_type.mjs"() {
    init_array();
    init_cyclic();
    init_dependent();
    init_intersect();
    init_object();
    init_tuple();
    init_union();
    init_from_array3();
    init_from_cyclic4();
    init_from_dependent4();
    init_from_intersect4();
    init_from_object5();
    init_from_tuple4();
    init_from_union5();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/instantiate.mjs
function ReadonlyObjectAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(FromType17(type), {}, options) : ReadonlyObjectDeferred(type);
  return result2;
}
function ReadonlyObjectInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReadonlyObjectAction(instantiatedType, options);
}
var init_instantiate22 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/instantiate.mjs"() {
    init_memory2();
    init_readonly_object();
    init_from_type9();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/ref/instantiate.mjs
function RefInstantiate(context, state, type, ref) {
  return state.visited.includes(ref) ? type : ref in context ? InstantiateType(context, State(state["callstack"], [...state["visited"], ref]), context[ref]) : type;
}
var init_instantiate23 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/ref/instantiate.mjs"() {
    init_instantiate27();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_cyclic.mjs
function FromCyclic5(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType18(target);
  const result2 = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result2;
}
var init_from_cyclic5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_cyclic.mjs"() {
    init_memory2();
    init_cyclic();
    init_from_type10();
    init_target();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_dependent.mjs
function FromDependent5(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result2 = FromType18(evaluated);
  return result2;
}
var init_from_dependent5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_dependent.mjs"() {
    init_from_type10();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_intersect.mjs
function FromIntersect5(types) {
  const evaluated = EvaluateIntersect(types);
  const result2 = FromType18(evaluated);
  return result2;
}
var init_from_intersect5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_intersect.mjs"() {
    init_from_type10();
    init_evaluate2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_union.mjs
function FromUnion8(types) {
  const result2 = types.map((type) => FromType18(type));
  return Union(result2);
}
var init_from_union6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_union.mjs"() {
    init_union();
    init_from_type10();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_object.mjs
function FromObject9(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result3, left) => {
    return { ...result3, [left]: RemoveOptional(properties[left]) };
  }, {});
  const result2 = _Object_(mapped);
  return result2;
}
var init_from_object6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_object.mjs"() {
    init_guard2();
    init_object();
    init_remove_optional();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_type.mjs
function FromType18(type) {
  return IsCyclic(type) ? FromCyclic5(type.$defs, type.$ref) : IsDependent(type) ? FromDependent5(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect5(type.allOf) : IsUnion(type) ? FromUnion8(type.anyOf) : IsObject2(type) ? FromObject9(type.properties) : _Object_({});
}
var init_from_type10 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/from_type.mjs"() {
    init_cyclic();
    init_dependent();
    init_intersect();
    init_object();
    init_union();
    init_from_cyclic5();
    init_from_dependent5();
    init_from_intersect5();
    init_from_union6();
    init_from_object6();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/required.mjs
function RequiredDeferred(type, options = {}) {
  return Deferred("Required", [type], options);
}
function Required(type, options = {}) {
  return RequiredAction(type, options);
}
var init_required = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/required.mjs"() {
    init_deferred();
    init_instantiate24();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/instantiate.mjs
function RequiredAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(FromType18(type), {}, options) : RequiredDeferred(type, options);
  return result2;
}
function RequiredInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return RequiredAction(instaniatedType, options);
}
var init_instantiate24 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/instantiate.mjs"() {
    init_memory2();
    init_from_type10();
    init_required();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/return_type.mjs
function ReturnTypeDeferred(type, options = {}) {
  return Deferred("ReturnType", [type], options);
}
function ReturnType(type, options = {}) {
  return ReturnTypeAction(type, options);
}
var init_return_type2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/return_type.mjs"() {
    init_deferred();
    init_instantiate25();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/return_type/instantiate.mjs
function ReturnTypeOperation(type) {
  return IsFunction2(type) ? type["returnType"] : Never();
}
function ReturnTypeAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(ReturnTypeOperation(type), {}, options) : ReturnTypeDeferred(type, options);
  return result2;
}
function ReturnTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReturnTypeAction(instantiatedType, options);
}
var init_instantiate25 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/return_type/instantiate.mjs"() {
    init_memory2();
    init_function();
    init_never();
    init_return_type2();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/with.mjs
function WithDeferred(type, options) {
  return Deferred("With", [type, options], {});
}
function With2(type, options) {
  return WithAction(type, options);
}
var init_with = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/with.mjs"() {
    init_deferred();
    init_instantiate26();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/with/instantiate.mjs
function WithAction(type, options) {
  const result2 = CanInstantiate([type]) ? memory_exports.Update(type, {}, options) : WithDeferred(type, options);
  return result2;
}
function WithInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return WithAction(instaniatedType, options);
}
var init_instantiate26 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/with/instantiate.mjs"() {
    init_memory2();
    init_instantiate27();
    init_with();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/rest/spread.mjs
function SpreadElement(type) {
  const result2 = IsRest(type) ? IsTuple(type.items) ? RestSpread(type.items.items) : IsInfer(type.items) ? [type] : IsRef(type.items) ? [type] : [Never()] : [type];
  return result2;
}
function RestSpread(types) {
  const result2 = types.reduce((result3, left) => {
    return [...result3, ...SpreadElement(left)];
  }, []);
  return result2;
}
var init_spread = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/rest/spread.mjs"() {
    init_infer();
    init_never();
    init_rest();
    init_ref();
    init_tuple();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/rest/index.mjs
var init_rest3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/rest/index.mjs"() {
    init_spread();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/instantiate.mjs
function State(callstack, visited2) {
  return { callstack, visited: visited2 };
}
function CanInstantiate(types) {
  return guard_exports.ShiftLeft(types, (left, right) => IsRef(left) ? false : CanInstantiate(right), () => true);
}
function InstantiateProperties(context, state, properties) {
  return guard_exports.Keys(properties).reduce((result2, key) => {
    return { ...result2, [key]: InstantiateType(context, state, properties[key]) };
  }, {});
}
function InstantiateElements(context, state, types) {
  const elements = InstantiateTypes(context, state, types);
  const result2 = RestSpread(elements);
  return result2;
}
function InstantiateTypes(context, state, types) {
  return types.map((type) => InstantiateType(context, state, type));
}
function WithModifiers(type, instantiatedType) {
  const withOptional = IsOptional(type) ? AddOptionalAction(instantiatedType, {}) : instantiatedType;
  const withReadonly = IsReadonly(type) ? AddReadonlyAction(withOptional, {}) : withOptional;
  const withImmutable = IsImmutable(type) ? AddImmutableAction(withReadonly, {}) : withReadonly;
  return withImmutable;
}
function InstantiateDeferred(context, state, action, parameters, options) {
  return (
    // Modifiers
    guard_exports.IsEqual(action, "AddImmutable") ? AddImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveImmutable") ? RemoveImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddReadonly") ? AddReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveReadonly") ? RemoveReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddOptional") ? AddOptionalInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveOptional") ? RemoveOptionalInstantiate(context, state, parameters[0], options) : (
      // Actions
      guard_exports.IsEqual(action, "Capitalize") ? CapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Conditional") ? ConditionalInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "ConstructorParameters") ? ConstructorParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Evaluate") ? EvaluateInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Exclude") ? ExcludeInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Extract") ? ExtractInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Index") ? IndexInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "InstanceType") ? InstanceTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Interface") ? InterfaceInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "KeyOf") ? KeyOfInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Lowercase") ? LowercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Mapped") ? MappedInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "Module") ? ModuleInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "NonNullable") ? NonNullableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Pick") ? PickInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Parameters") ? ParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Partial") ? PartialInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Omit") ? OmitInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "ReadonlyObject") ? ReadonlyObjectInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Record") ? RecordInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Required") ? RequiredInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "ReturnType") ? ReturnTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "TemplateLiteral") ? TemplateLiteralInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uncapitalize") ? UncapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uppercase") ? UppercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "With") ? WithInstantiate(context, state, parameters[0], parameters[1]) : Deferred(action, parameters, options)
    )
  );
}
function InstantiateImmediate(context, state, type) {
  const instantiatedType = IsRef(type) ? RefInstantiate(context, state, type, type.$ref) : IsArray2(type) ? _Array_(InstantiateType(context, state, type.items), ArrayOptions(type)) : IsCall(type) ? CallInstantiate(context, state, type.target, type.arguments) : IsConstructor2(type) ? Constructor(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.instanceType), ConstructorOptions(type)) : IsFunction2(type) ? _Function_(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.returnType), FunctionOptions(type)) : IsDependent(type) ? Dependent(InstantiateType(context, state, type.if), InstantiateType(context, state, type.then), InstantiateType(context, state, type.else), DependentOptions(type)) : IsIntersect(type) ? Intersect(InstantiateTypes(context, state, type.allOf), IntersectOptions(type)) : IsObject2(type) ? _Object_(InstantiateProperties(context, state, type.properties), ObjectOptions(type)) : IsRecord(type) ? RecordFromPattern(RecordPattern(type), InstantiateType(context, state, RecordValue(type))) : IsRest(type) ? Rest(InstantiateType(context, state, type.items)) : IsTuple(type) ? Tuple(InstantiateElements(context, state, type.items), TupleOptions(type)) : IsUnion(type) ? Union(InstantiateTypes(context, state, type.anyOf), UnionOptions(type)) : type;
  const withModifiers = WithModifiers(type, instantiatedType);
  return withModifiers;
}
function InstantiateType(context, state, type) {
  const result2 = IsDeferred(type) ? InstantiateDeferred(context, state, type.action, type.parameters, type.options) : InstantiateImmediate(context, state, type);
  return result2;
}
function Instantiate(context, type) {
  return InstantiateType(context, State([], []), type);
}
var init_instantiate27 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/instantiate.mjs"() {
    init_guard2();
    init_instantiate_add3();
    init_instantiate_add();
    init_instantiate_add2();
    init_array();
    init_constructor();
    init_deferred();
    init_function();
    init_call();
    init_dependent();
    init_intersect();
    init_object();
    init_record();
    init_tuple();
    init_union();
    init_ref();
    init_rest();
    init_instantiate_add3();
    init_instantiate_remove3();
    init_instantiate_add();
    init_instantiate_remove();
    init_instantiate_add2();
    init_instantiate_remove2();
    init_optional();
    init_immutable();
    init_readonly();
    init_instantiate6();
    init_instantiate7();
    init_conditional2();
    init_instantiate9();
    init_instantiate5();
    init_instantiate10();
    init_instantiate11();
    init_instantiate12();
    init_instantiate13();
    init_instantiate3();
    init_instantiate14();
    init_instantiate7();
    init_instantiate15();
    init_instantiate16();
    init_instantiate17();
    init_instantiate18();
    init_instantiate19();
    init_instantiate20();
    init_instantiate21();
    init_instantiate22();
    init_instantiate();
    init_instantiate23();
    init_instantiate24();
    init_instantiate25();
    init_instantiate2();
    init_instantiate7();
    init_instantiate7();
    init_instantiate26();
    init_rest3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/immutable/instantiate_add.mjs
function AddImmutableOperation(type) {
  return memory_exports.Update(type, { "~immutable": true }, {});
}
function AddImmutableAction(type, options) {
  const result2 = memory_exports.Update(AddImmutableOperation(type), {}, options);
  return result2;
}
function AddImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddImmutableAction(instantiatedType, options);
}
var init_instantiate_add3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/immutable/instantiate_add.mjs"() {
    init_memory2();
    init_instantiate27();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_add_immutable.mjs
function AddImmutableDeferred(type, options = {}) {
  return Deferred("AddImmutable", [type], options);
}
function AddImmutable(type, options = {}) {
  return AddImmutableAction(type, options);
}
var init_add_immutable = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_add_immutable.mjs"() {
    init_deferred();
    init_instantiate_add3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_remove_immutable.mjs
var init_remove_immutable = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/_remove_immutable.mjs"() {
    init_deferred();
    init_instantiate_remove3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/evaluate.mjs
function EvaluateDeferred(type, options = {}) {
  return Deferred("Evaluate", [type], options);
}
function Evaluate(type, options = {}) {
  return EvaluateAction(type, options);
}
var init_evaluate4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/evaluate.mjs"() {
    init_deferred();
    init_instantiate5();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/module.mjs
function ModuleDeferred(declarations, options = {}) {
  return Deferred("Module", [declarations], options);
}
function Module2(declarations, options = {}) {
  return ModuleInstantiate({}, State([], []), declarations, options);
}
var init_module = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/module.mjs"() {
    init_deferred();
    init_instantiate27();
    init_instantiate16();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/index.mjs
var init_action = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/action/index.mjs"() {
    init_add_immutable();
    init_add_readonly();
    init_add_optional();
    init_remove_immutable();
    init_remove_readonly();
    init_remove_optional();
    init_capitalize();
    init_conditional();
    init_constructor_parameters();
    init_evaluate4();
    init_exclude();
    init_extract();
    init_indexed();
    init_instance_type();
    init_interface();
    init_keyof();
    init_lowercase();
    init_mapped();
    init_module();
    init_non_nullable();
    init_omit();
    init_parameters2();
    init_partial();
    init_pick();
    init_readonly_object();
    init_required();
    init_return_type2();
    init_uncapitalize();
    init_uppercase();
    init_with();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/constructor_parameters/index.mjs
var init_constructor_parameters2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/constructor_parameters/index.mjs"() {
    init_instantiate9();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/enum/index.mjs
var init_enum3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/enum/index.mjs"() {
    init_typescript_enum_to_enum_values();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/exclude/index.mjs
var init_exclude2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/exclude/index.mjs"() {
    init_instantiate10();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/extract/index.mjs
var init_extract2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/extract/index.mjs"() {
    init_instantiate11();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/helpers/union.mjs
var init_union3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/helpers/union.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/helpers/index.mjs
var init_helpers = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/helpers/index.mjs"() {
    init_keys_to_indexer();
    init_keys();
    init_union3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/index.mjs
var init_indexed2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/indexed/index.mjs"() {
    init_instantiate12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/instance_type/index.mjs
var init_instance_type2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/instance_type/index.mjs"() {
    init_instantiate13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/interface/index.mjs
var init_interface2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/interface/index.mjs"() {
    init_instantiate3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/index.mjs
var init_intrinsics = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/intrinsics/index.mjs"() {
    init_instantiate7();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/index.mjs
var init_keyof2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/keyof/index.mjs"() {
    init_instantiate14();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/mapped/index.mjs
var init_mapped2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/mapped/index.mjs"() {
    init_instantiate15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/module/index.mjs
var init_module2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/module/index.mjs"() {
    init_instantiate16();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/non_nullable/index.mjs
var init_non_nullable2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/non_nullable/index.mjs"() {
    init_instantiate17();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/omit/index.mjs
var init_omit2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/omit/index.mjs"() {
    init_instantiate18();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/parameters/index.mjs
var init_parameters3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/parameters/index.mjs"() {
    init_instantiate19();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/patterns/index.mjs
var init_patterns = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/patterns/index.mjs"() {
    init_pattern();
    init_template();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/index.mjs
var init_partial2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/partial/index.mjs"() {
    init_instantiate20();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/pick/index.mjs
var init_pick2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/pick/index.mjs"() {
    init_instantiate21();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/priority/priority.mjs
function Comparer(left, right) {
  const compareResult = Compare(left, right);
  const result2 = guard_exports.IsEqual(compareResult, "right-inside") ? 1 : guard_exports.IsEqual(compareResult, "disjoint") ? 1 : 0;
  return result2;
}
function Insert(type, types, result2 = []) {
  return guard_exports.ShiftLeft(types, (left, right) => guard_exports.IsEqual(Comparer(type, left), 1) ? Insert(type, right, [...result2, left]) : [...result2, type, ...types], () => [...result2, type]);
}
function Sort(types, result2 = []) {
  return guard_exports.ShiftLeft(types, (left, right) => Sort(right, Insert(left, result2)), () => result2);
}
function Priority(types) {
  const result2 = Sort(types);
  return result2;
}
var init_priority = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/priority/priority.mjs"() {
    init_guard2();
    init_compare();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/priority/index.mjs
var init_priority2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/priority/index.mjs"() {
    init_priority();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/index.mjs
var init_readonly_object2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/readonly_object/index.mjs"() {
    init_instantiate22();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/index.mjs
var init_record3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/record/index.mjs"() {
    init_instantiate();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/ref/index.mjs
var init_ref2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/ref/index.mjs"() {
    init_instantiate23();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/index.mjs
var init_required2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/required/index.mjs"() {
    init_instantiate24();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/return_type/index.mjs
var init_return_type3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/return_type/index.mjs"() {
    init_instantiate25();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/static.mjs
var init_static2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/static.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/is_pattern.mjs
var init_is_pattern = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/is_pattern.mjs"() {
    init_guard2();
    init_pattern();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/index.mjs
var init_template_literal3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/template_literal/index.mjs"() {
    init_create2();
    init_decode();
    init_encode();
    init_static2();
    init_is_finite();
    init_is_pattern();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/with/index.mjs
var init_with2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/with/index.mjs"() {
    init_instantiate26();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/index.mjs
var init_engine = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/engine/index.mjs"() {
    init_instantiate27();
    init_conditional2();
    init_constructor_parameters2();
    init_cyclic2();
    init_enum3();
    init_evaluate3();
    init_exclude2();
    init_extract2();
    init_helpers();
    init_indexed2();
    init_instance_type2();
    init_interface2();
    init_intrinsics();
    init_keyof2();
    init_mapped2();
    init_module2();
    init_non_nullable2();
    init_object3();
    init_omit2();
    init_parameters3();
    init_patterns();
    init_partial2();
    init_pick2();
    init_priority2();
    init_readonly_object2();
    init_record3();
    init_ref2();
    init_required2();
    init_return_type3();
    init_template_literal3();
    init_with2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/script.mjs
function Script2(...args) {
  const [context, input, options] = arguments_exports.Match(args, {
    2: (script, options2) => guard_exports.IsString(script) ? [{}, script, options2] : [script, options2, {}],
    3: (context2, script, options2) => [context2, script, options2],
    1: (script) => [{}, script, {}]
  });
  const result2 = Script(input);
  const parsed = guard_exports.IsArray(result2) && guard_exports.IsEqual(result2.length, 2) ? InstantiateType(context, State([], []), result2[0]) : Never();
  return memory_exports.Update(parsed, {}, options);
}
var init_script = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/script.mjs"() {
    init_arguments2();
    init_memory2();
    init_guard2();
    init_types();
    init_instantiate27();
    init_instantiate27();
    init_parser();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/index.mjs
var init_script2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/script/index.mjs"() {
    init_script();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/typebox.mjs
var typebox_exports = {};
__export(typebox_exports, {
  Any: () => Any,
  Array: () => _Array_,
  BigInt: () => BigInt2,
  Boolean: () => Boolean2,
  Call: () => Call,
  Capitalize: () => Capitalize,
  Codec: () => Codec,
  Conditional: () => Conditional,
  Constructor: () => Constructor,
  ConstructorParameters: () => ConstructorParameters,
  Cyclic: () => Cyclic,
  Decode: () => Decode,
  DecodeBuilder: () => DecodeBuilder,
  Dependent: () => Dependent,
  Encode: () => Encode,
  EncodeBuilder: () => EncodeBuilder,
  Enum: () => Enum,
  Evaluate: () => Evaluate,
  Exclude: () => Exclude,
  Extends: () => Extends,
  ExtendsResult: () => result_exports,
  Extract: () => Extract,
  Function: () => _Function_,
  Generic: () => Generic,
  Identifier: () => Identifier,
  Immutable: () => Immutable,
  Index: () => Index,
  Infer: () => Infer,
  InstanceType: () => InstanceType,
  Instantiate: () => Instantiate,
  Integer: () => Integer,
  Interface: () => Interface,
  Intersect: () => Intersect,
  IsAny: () => IsAny,
  IsArray: () => IsArray2,
  IsBigInt: () => IsBigInt2,
  IsBoolean: () => IsBoolean3,
  IsCall: () => IsCall,
  IsCodec: () => IsCodec,
  IsConstructor: () => IsConstructor2,
  IsCyclic: () => IsCyclic,
  IsDependent: () => IsDependent,
  IsEnum: () => IsEnum,
  IsEnumValue: () => IsEnumValue,
  IsFunction: () => IsFunction2,
  IsGeneric: () => IsGeneric,
  IsIdentifier: () => IsIdentifier,
  IsImmutable: () => IsImmutable,
  IsInfer: () => IsInfer,
  IsInteger: () => IsInteger2,
  IsIntersect: () => IsIntersect,
  IsKind: () => IsKind,
  IsLiteral: () => IsLiteral,
  IsNever: () => IsNever,
  IsNull: () => IsNull2,
  IsNumber: () => IsNumber3,
  IsObject: () => IsObject2,
  IsOptional: () => IsOptional,
  IsParameter: () => IsParameter,
  IsReadonly: () => IsReadonly,
  IsRecord: () => IsRecord,
  IsRef: () => IsRef,
  IsRefine: () => IsRefine,
  IsRest: () => IsRest,
  IsSchema: () => IsSchema,
  IsString: () => IsString3,
  IsSymbol: () => IsSymbol2,
  IsTemplateLiteral: () => IsTemplateLiteral,
  IsThis: () => IsThis,
  IsTuple: () => IsTuple,
  IsUndefined: () => IsUndefined2,
  IsUnion: () => IsUnion,
  IsUnknown: () => IsUnknown,
  IsUnsafe: () => IsUnsafe,
  IsVoid: () => IsVoid,
  KeyOf: () => KeyOf2,
  Literal: () => Literal,
  Lowercase: () => Lowercase,
  Mapped: () => Mapped,
  Module: () => Module2,
  Never: () => Never,
  NonNullable: () => NonNullable,
  Null: () => Null,
  Number: () => Number2,
  Object: () => _Object_,
  Omit: () => Omit,
  Optional: () => Optional,
  Parameter: () => Parameter,
  Parameters: () => Parameters,
  Partial: () => Partial,
  Pick: () => Pick,
  Readonly: () => Readonly,
  ReadonlyObject: () => ReadonlyObject,
  ReadonlyType: () => ReadonlyType,
  Record: () => Record,
  RecordKey: () => RecordKey,
  RecordPattern: () => RecordPattern,
  RecordValue: () => RecordValue,
  Ref: () => Ref,
  Refine: () => Refine,
  Required: () => Required,
  Rest: () => Rest,
  ReturnType: () => ReturnType,
  Script: () => Script2,
  String: () => String2,
  Symbol: () => Symbol2,
  TemplateLiteral: () => TemplateLiteral2,
  This: () => This,
  Tuple: () => Tuple,
  Uncapitalize: () => Uncapitalize,
  Undefined: () => Undefined,
  Union: () => Union,
  Unknown: () => Unknown,
  Unsafe: () => Unsafe,
  Uppercase: () => Uppercase,
  Void: () => Void,
  With: () => With2
});
var init_typebox = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/typebox.mjs"() {
    init_instantiate27();
    init_extends3();
    init_script2();
    init_capitalize();
    init_conditional();
    init_constructor_parameters();
    init_evaluate4();
    init_exclude();
    init_extract();
    init_action();
    init_instance_type();
    init_interface();
    init_keyof();
    init_lowercase();
    init_mapped();
    init_module();
    init_non_nullable();
    init_omit();
    init_parameters2();
    init_partial();
    init_pick();
    init_readonly_object();
    init_required();
    init_return_type2();
    init_uncapitalize();
    init_uppercase();
    init_with();
    init_codec();
    init_immutable();
    init_optional();
    init_readonly();
    init_refine();
    init_any();
    init_array();
    init_bigint();
    init_boolean();
    init_call();
    init_constructor();
    init_cyclic();
    init_enum();
    init_function();
    init_generic();
    init_identifier();
    init_dependent();
    init_infer();
    init_integer();
    init_intersect();
    init_literal();
    init_never();
    init_null();
    init_number();
    init_object();
    init_parameter();
    init_record();
    init_ref();
    init_rest();
    init_schema();
    init_string2();
    init_symbol();
    init_template_literal();
    init_this();
    init_tuple();
    init_undefined();
    init_union();
    init_unknown();
    init_unsafe();
    init_void();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/index.mjs
var init_build = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/index.mjs"() {
    init_action();
    init_engine();
    init_extends3();
    init_script2();
    init_types();
    init_typebox();
    init_typebox();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/_refine.mjs
function IsRefine2(value) {
  return guard_exports.HasPropertyKey(value, "~refine") && guard_exports.IsArray(value["~refine"]) && guard_exports.Every(value["~refine"], 0, (value2) => guard_exports.IsObject(value2) && guard_exports.HasPropertyKey(value2, "check") && guard_exports.HasPropertyKey(value2, "error") && guard_exports.IsFunction(value2.check) && guard_exports.IsFunction(value2.error));
}
var init_refine2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/_refine.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/schema.mjs
function IsSchemaObject(value) {
  return guard_exports.IsObject(value) && !guard_exports.IsArray(value);
}
function IsSchemaBoolean(value) {
  return guard_exports.IsBoolean(value);
}
function IsSchema2(value) {
  return IsSchemaObject(value) || IsSchemaBoolean(value);
}
var init_schema2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/schema.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/additionalItems.mjs
function IsAdditionalItems(schema) {
  return guard_exports.HasPropertyKey(schema, "additionalItems") && IsSchema2(schema.additionalItems);
}
var init_additionalItems = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/additionalItems.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/additionalProperties.mjs
function IsAdditionalProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "additionalProperties") && IsSchema2(schema.additionalProperties);
}
var init_additionalProperties = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/additionalProperties.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/allOf.mjs
function IsAllOf(schema) {
  return guard_exports.HasPropertyKey(schema, "allOf") && guard_exports.IsArray(schema.allOf) && schema.allOf.every((value) => IsSchema2(value));
}
var init_allOf = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/allOf.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/anchor.mjs
function IsAnchor(schema) {
  return guard_exports.HasPropertyKey(schema, "$anchor") && guard_exports.IsString(schema.$anchor);
}
var init_anchor = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/anchor.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/anyOf.mjs
function IsAnyOf(schema) {
  return guard_exports.HasPropertyKey(schema, "anyOf") && guard_exports.IsArray(schema.anyOf) && schema.anyOf.every((value) => IsSchema2(value));
}
var init_anyOf = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/anyOf.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/const.mjs
function IsConst(value) {
  return guard_exports.HasPropertyKey(value, "const");
}
var init_const2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/const.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/contains.mjs
function IsContains(schema) {
  return guard_exports.HasPropertyKey(schema, "contains") && IsSchema2(schema.contains);
}
var init_contains = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/contains.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/contentEncoding.mjs
var init_contentEncoding = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/contentEncoding.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/contentMediaType.mjs
var init_contentMediaType = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/contentMediaType.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/default.mjs
function IsDefault(schema) {
  return guard_exports.HasPropertyKey(schema, "default");
}
var init_default = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/default.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/defs.mjs
var init_defs = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/defs.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dependencies.mjs
function IsDependencies(schema) {
  return guard_exports.HasPropertyKey(schema, "dependencies") && guard_exports.IsObject(schema.dependencies) && Object.values(schema.dependencies).every((value) => IsSchema2(value) || guard_exports.IsArray(value) && value.every((value2) => guard_exports.IsString(value2)));
}
var init_dependencies2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dependencies.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dependentRequired.mjs
function IsDependentRequired(schema) {
  return guard_exports.HasPropertyKey(schema, "dependentRequired") && guard_exports.IsObject(schema.dependentRequired) && Object.values(schema.dependentRequired).every((value) => guard_exports.IsArray(value) && value.every((value2) => guard_exports.IsString(value2)));
}
var init_dependentRequired = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dependentRequired.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dependentSchemas.mjs
function IsDependentSchemas(schema) {
  return guard_exports.HasPropertyKey(schema, "dependentSchemas") && guard_exports.IsObject(schema.dependentSchemas) && Object.values(schema.dependentSchemas).every((value) => IsSchema2(value));
}
var init_dependentSchemas = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dependentSchemas.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dynamicAnchor.mjs
function IsDynamicAnchor(schema) {
  return guard_exports.HasPropertyKey(schema, "$dynamicAnchor") && guard_exports.IsString(schema.$dynamicAnchor);
}
var init_dynamicAnchor = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dynamicAnchor.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dynamicRef.mjs
function IsDynamicRef(schema) {
  return guard_exports.HasPropertyKey(schema, "$dynamicRef") && guard_exports.IsString(schema.$dynamicRef);
}
var init_dynamicRef = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/dynamicRef.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/else.mjs
function IsElse(schema) {
  return guard_exports.HasPropertyKey(schema, "else") && IsSchema2(schema.else);
}
var init_else = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/else.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/enum.mjs
function IsEnum2(schema) {
  return guard_exports.HasPropertyKey(schema, "enum") && guard_exports.IsArray(schema.enum);
}
var init_enum4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/enum.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/exclusiveMaximum.mjs
function IsExclusiveMaximum(schema) {
  return guard_exports.HasPropertyKey(schema, "exclusiveMaximum") && (guard_exports.IsNumber(schema.exclusiveMaximum) || guard_exports.IsBigInt(schema.exclusiveMaximum));
}
var init_exclusiveMaximum = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/exclusiveMaximum.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/exclusiveMinimum.mjs
function IsExclusiveMinimum(schema) {
  return guard_exports.HasPropertyKey(schema, "exclusiveMinimum") && (guard_exports.IsNumber(schema.exclusiveMinimum) || guard_exports.IsBigInt(schema.exclusiveMinimum));
}
var init_exclusiveMinimum = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/exclusiveMinimum.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/format.mjs
function IsFormat(schema) {
  return guard_exports.HasPropertyKey(schema, "format") && guard_exports.IsString(schema.format);
}
var init_format = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/format.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/id.mjs
function IsId(schema) {
  return guard_exports.HasPropertyKey(schema, "$id") && guard_exports.IsString(schema.$id);
}
var init_id = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/id.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/if.mjs
function IsIf(schema) {
  return guard_exports.HasPropertyKey(schema, "if") && IsSchema2(schema.if);
}
var init_if = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/if.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/items.mjs
function IsItems(schema) {
  return guard_exports.HasPropertyKey(schema, "items") && (IsSchema2(schema.items) || guard_exports.IsArray(schema.items) && schema.items.every((value) => {
    return IsSchema2(value);
  }));
}
function IsItemsSized(schema) {
  return IsItems(schema) && guard_exports.IsArray(schema.items);
}
var init_items = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/items.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maximum.mjs
function IsMaximum(schema) {
  return guard_exports.HasPropertyKey(schema, "maximum") && (guard_exports.IsNumber(schema.maximum) || guard_exports.IsBigInt(schema.maximum));
}
var init_maximum = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maximum.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maxContains.mjs
function IsMaxContains(schema) {
  return guard_exports.HasPropertyKey(schema, "maxContains") && guard_exports.IsNumber(schema.maxContains);
}
var init_maxContains = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maxContains.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maxItems.mjs
function IsMaxItems(schema) {
  return guard_exports.HasPropertyKey(schema, "maxItems") && guard_exports.IsNumber(schema.maxItems);
}
var init_maxItems = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maxItems.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maxLength.mjs
function IsMaxLength3(schema) {
  return guard_exports.HasPropertyKey(schema, "maxLength") && guard_exports.IsNumber(schema.maxLength);
}
var init_maxLength = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maxLength.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maxProperties.mjs
function IsMaxProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "maxProperties") && guard_exports.IsNumber(schema.maxProperties);
}
var init_maxProperties = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/maxProperties.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minimum.mjs
function IsMinimum(schema) {
  return guard_exports.HasPropertyKey(schema, "minimum") && (guard_exports.IsNumber(schema.minimum) || guard_exports.IsBigInt(schema.minimum));
}
var init_minimum = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minimum.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minContains.mjs
function IsMinContains(schema) {
  return guard_exports.HasPropertyKey(schema, "minContains") && guard_exports.IsNumber(schema.minContains);
}
var init_minContains = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minContains.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minItems.mjs
function IsMinItems(schema) {
  return guard_exports.HasPropertyKey(schema, "minItems") && guard_exports.IsNumber(schema.minItems);
}
var init_minItems = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minItems.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minLength.mjs
function IsMinLength3(schema) {
  return guard_exports.HasPropertyKey(schema, "minLength") && guard_exports.IsNumber(schema.minLength);
}
var init_minLength = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minLength.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minProperties.mjs
function IsMinProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "minProperties") && guard_exports.IsNumber(schema.minProperties);
}
var init_minProperties = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/minProperties.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/multipleOf.mjs
function IsMultipleOf2(schema) {
  return guard_exports.HasPropertyKey(schema, "multipleOf") && (guard_exports.IsNumber(schema.multipleOf) || guard_exports.IsBigInt(schema.multipleOf));
}
var init_multipleOf = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/multipleOf.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/not.mjs
function IsNot(schema) {
  return guard_exports.HasPropertyKey(schema, "not") && IsSchema2(schema.not);
}
var init_not = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/not.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/oneOf.mjs
function IsOneOf(schema) {
  return guard_exports.HasPropertyKey(schema, "oneOf") && guard_exports.IsArray(schema.oneOf) && schema.oneOf.every((value) => IsSchema2(value));
}
var init_oneOf = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/oneOf.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/pattern.mjs
function IsPattern(schema) {
  return guard_exports.HasPropertyKey(schema, "pattern") && (guard_exports.IsString(schema.pattern) || schema.pattern instanceof RegExp);
}
var init_pattern2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/pattern.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/patternProperties.mjs
function IsPatternProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "patternProperties") && guard_exports.IsObject(schema.patternProperties) && Object.values(schema.patternProperties).every((value) => IsSchema2(value));
}
var init_patternProperties = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/patternProperties.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/prefixItems.mjs
function IsPrefixItems(schema) {
  return guard_exports.HasPropertyKey(schema, "prefixItems") && guard_exports.IsArray(schema.prefixItems) && schema.prefixItems.every((schema2) => IsSchema2(schema2));
}
var init_prefixItems = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/prefixItems.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/properties.mjs
function IsProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "properties") && guard_exports.IsObject(schema.properties) && Object.values(schema.properties).every((value) => IsSchema2(value));
}
var init_properties2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/properties.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/propertyNames.mjs
function IsPropertyNames(schema) {
  return guard_exports.HasPropertyKey(schema, "propertyNames") && (guard_exports.IsObject(schema.propertyNames) || IsSchema2(schema.propertyNames));
}
var init_propertyNames = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/propertyNames.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/recursiveAnchor.mjs
function IsRecursiveAnchor(schema) {
  return guard_exports.HasPropertyKey(schema, "$recursiveAnchor") && guard_exports.IsBoolean(schema.$recursiveAnchor);
}
function IsRecursiveAnchorTrue(schema) {
  return IsRecursiveAnchor(schema) && guard_exports.IsEqual(schema.$recursiveAnchor, true);
}
var init_recursiveAnchor = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/recursiveAnchor.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/recursiveRef.mjs
function IsRecursiveRef(schema) {
  return guard_exports.HasPropertyKey(schema, "$recursiveRef") && guard_exports.IsString(schema.$recursiveRef);
}
var init_recursiveRef = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/recursiveRef.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/ref.mjs
function IsRef2(schema) {
  return guard_exports.HasPropertyKey(schema, "$ref") && guard_exports.IsString(schema.$ref);
}
var init_ref3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/ref.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/required.mjs
function IsRequired(schema) {
  return guard_exports.HasPropertyKey(schema, "required") && guard_exports.IsArray(schema.required) && schema.required.every((value) => guard_exports.IsString(value));
}
var init_required3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/required.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/then.mjs
function IsThen(schema) {
  return guard_exports.HasPropertyKey(schema, "then") && IsSchema2(schema.then);
}
var init_then = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/then.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/type.mjs
function IsType(schema) {
  return guard_exports.HasPropertyKey(schema, "type") && (guard_exports.IsString(schema.type) || guard_exports.IsArray(schema.type) && schema.type.every((value) => guard_exports.IsString(value)));
}
var init_type = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/type.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/uniqueItems.mjs
function IsUniqueItems(schema) {
  return guard_exports.HasPropertyKey(schema, "uniqueItems") && guard_exports.IsBoolean(schema.uniqueItems);
}
var init_uniqueItems = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/uniqueItems.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/unevaluatedItems.mjs
function IsUnevaluatedItems(schema) {
  return guard_exports.HasPropertyKey(schema, "unevaluatedItems") && IsSchema2(schema.unevaluatedItems);
}
var init_unevaluatedItems = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/unevaluatedItems.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/unevaluatedProperties.mjs
function IsUnevaluatedProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "unevaluatedProperties") && IsSchema2(schema.unevaluatedProperties);
}
var init_unevaluatedProperties = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/unevaluatedProperties.mjs"() {
    init_guard2();
    init_schema2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/index.mjs
var init_types2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/types/index.mjs"() {
    init_refine2();
    init_additionalItems();
    init_additionalProperties();
    init_allOf();
    init_anchor();
    init_anyOf();
    init_const2();
    init_contains();
    init_contentEncoding();
    init_contentMediaType();
    init_default();
    init_defs();
    init_dependencies2();
    init_dependentRequired();
    init_dependentSchemas();
    init_dynamicAnchor();
    init_dynamicRef();
    init_else();
    init_enum4();
    init_exclusiveMaximum();
    init_exclusiveMinimum();
    init_format();
    init_id();
    init_if();
    init_items();
    init_maximum();
    init_maxContains();
    init_maxItems();
    init_maxLength();
    init_maxProperties();
    init_minimum();
    init_minContains();
    init_minItems();
    init_minLength();
    init_minProperties();
    init_multipleOf();
    init_not();
    init_oneOf();
    init_pattern2();
    init_patternProperties();
    init_prefixItems();
    init_properties2();
    init_propertyNames();
    init_recursiveAnchor();
    init_recursiveRef();
    init_ref3();
    init_required3();
    init_schema2();
    init_then();
    init_type();
    init_uniqueItems();
    init_unevaluatedItems();
    init_unevaluatedProperties();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_context.mjs
var CheckContext, ErrorContext, AccumulatedErrorContext;
var init_context = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_context.mjs"() {
    init_types2();
    init_guard2();
    CheckContext = class {
      constructor() {
        const indices = /* @__PURE__ */ new Set();
        const keys = /* @__PURE__ */ new Set();
        this.stack = [{ indices, keys }];
      }
      // ----------------------------------------------------------------
      // Stack
      // ----------------------------------------------------------------
      Push() {
        const indices = /* @__PURE__ */ new Set();
        const keys = /* @__PURE__ */ new Set();
        this.stack.push({ indices, keys });
        return true;
      }
      Pop() {
        this.stack.pop();
        return true;
      }
      // ----------------------------------------------------------------
      // Top
      // ----------------------------------------------------------------
      AddIndex(index) {
        this.GetIndices().add(index);
        return true;
      }
      AddKey(key) {
        this.GetKeys().add(key);
        return true;
      }
      GetIndices() {
        const top = this.stack[this.stack.length - 1];
        return top.indices;
      }
      GetKeys() {
        const top = this.stack[this.stack.length - 1];
        return top.keys;
      }
      Merge(results) {
        for (const context of results) {
          context.GetIndices().forEach((value) => this.GetIndices().add(value));
          context.GetKeys().forEach((value) => this.GetKeys().add(value));
        }
        return true;
      }
    };
    ErrorContext = class extends CheckContext {
      constructor(callback) {
        super();
        this.callback = callback;
      }
      AddError(error) {
        this.callback(error);
        return false;
      }
    };
    AccumulatedErrorContext = class extends ErrorContext {
      constructor() {
        super((error) => this.errors.push(error));
        this.errors = [];
      }
      AddError(error) {
        this.errors.push(error);
        return false;
      }
      GetErrors() {
        return this.errors;
      }
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_externals.mjs
var init_externals = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_externals.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_refine.mjs
function CheckRefine(_stack, _context, schema, value) {
  return guard_exports.Every(schema["~refine"], 0, (refinement, _) => refinement.check(value));
}
function ErrorRefine(_stack, context, schemaPath, instancePath, schema, value) {
  return guard_exports.EveryAll(schema["~refine"], 0, (refinement, index) => {
    return refinement.check(value) || context.AddError({
      keyword: "~refine",
      schemaPath,
      instancePath,
      params: { index, message: refinement.error(value) }
    });
  });
}
var init_refine3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_refine.mjs"() {
    init_externals();
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_unique.mjs
var init_unique = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_unique.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/additionalItems.mjs
function IsValid(schema) {
  return IsItems(schema) && guard_exports.IsArray(schema.items);
}
function CheckAdditionalItems(stack, context, schema, value) {
  if (!IsValid(schema))
    return true;
  const isAdditionalItems = guard_exports.Every(value, 0, (item, index) => {
    return guard_exports.IsLessThan(index, schema.items.length) || CheckSchemaPushStack(stack, context, schema.additionalItems, item) && context.AddIndex(index);
  });
  return isAdditionalItems;
}
function ErrorAdditionalItems(stack, context, schemaPath, instancePath, schema, value) {
  if (!IsValid(schema))
    return true;
  const isAdditionalItems = guard_exports.Every(value, 0, (item, index) => {
    const nextSchemaPath = `${schemaPath}/additionalItems`;
    const nextInstancePath = `${instancePath}/${index}`;
    return guard_exports.IsLessThan(index, schema.items.length) || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema.additionalItems, item) && context.AddIndex(index);
  });
  return isAdditionalItems;
}
var init_additionalItems2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/additionalItems.mjs"() {
    init_types2();
    init_unique();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/additionalProperties.mjs
function GetPropertyKeyAsPattern(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped}$`;
}
function GetPropertiesPattern(schema) {
  const patterns = [];
  if (IsPatternProperties(schema))
    patterns.push(...guard_exports.Keys(schema.patternProperties));
  if (IsProperties(schema))
    patterns.push(...guard_exports.Keys(schema.properties).map(GetPropertyKeyAsPattern));
  return guard_exports.IsEqual(patterns.length, 0) ? "(?!)" : `(${patterns.join("|")})`;
}
function CheckAdditionalProperties(stack, context, schema, value) {
  const regexp = new RegExp(GetPropertiesPattern(schema));
  const isAdditionalProperties = guard_exports.Every(guard_exports.Keys(value), 0, (key, _index) => {
    return regexp.test(key) || CheckSchemaPushStack(stack, context, schema.additionalProperties, value[key]) && context.AddKey(key);
  });
  return isAdditionalProperties;
}
function ErrorAdditionalProperties(stack, context, schemaPath, instancePath, schema, value) {
  const regexp = new RegExp(GetPropertiesPattern(schema));
  const additionalProperties = [];
  const isAdditionalProperties = guard_exports.EveryAll(guard_exports.Keys(value), 0, (key, _index) => {
    const nextSchemaPath = `${schemaPath}/additionalProperties`;
    const nextInstancePath = `${instancePath}/${key}`;
    const nextContext = new AccumulatedErrorContext();
    const isAdditionalProperty = regexp.test(key) || ErrorSchemaPushStack(stack, nextContext, nextSchemaPath, nextInstancePath, schema.additionalProperties, value[key]) && context.AddKey(key);
    if (!isAdditionalProperty)
      additionalProperties.push(key);
    return isAdditionalProperty;
  });
  return isAdditionalProperties || context.AddError({
    keyword: "additionalProperties",
    schemaPath,
    instancePath,
    params: { additionalProperties }
  });
}
var init_additionalProperties2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/additionalProperties.mjs"() {
    init_types2();
    init_externals();
    init_unique();
    init_context();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_reducer.mjs
var init_reducer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_reducer.mjs"() {
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/allOf.mjs
function CheckAllOf(stack, context, schema, value) {
  const results = schema.allOf.reduce((result2, schema2) => {
    const nextContext = new CheckContext();
    return CheckSchema(stack, nextContext, schema2, value) ? [...result2, nextContext] : result2;
  }, []);
  return guard_exports.IsEqual(results.length, schema.allOf.length) && context.Merge(results);
}
function ErrorAllOf(stack, context, schemaPath, instancePath, schema, value) {
  const failedContexts = [];
  const results = schema.allOf.reduce((result2, schema2, index) => {
    const nextSchemaPath = `${schemaPath}/allOf/${index}`;
    const nextContext = new AccumulatedErrorContext();
    const isSchema = ErrorSchema(stack, nextContext, nextSchemaPath, instancePath, schema2, value);
    if (!isSchema)
      failedContexts.push(nextContext);
    return isSchema ? [...result2, nextContext] : result2;
  }, []);
  const isAllOf = guard_exports.IsEqual(results.length, schema.allOf.length) && context.Merge(results);
  if (!isAllOf)
    failedContexts.forEach((failed) => failed.GetErrors().forEach((error) => context.AddError(error)));
  return isAllOf;
}
var init_allOf2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/allOf.mjs"() {
    init_context();
    init_reducer();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/anyOf.mjs
function CheckAnyOf(stack, context, schema, value) {
  const results = schema.anyOf.reduce((result2, schema2) => {
    const nextContext = new CheckContext();
    return CheckSchema(stack, nextContext, schema2, value) ? [...result2, nextContext] : result2;
  }, []);
  return guard_exports.IsGreaterThan(results.length, 0) && context.Merge(results);
}
function ErrorAnyOf(stack, context, schemaPath, instancePath, schema, value) {
  const failedContexts = [];
  const results = schema.anyOf.reduce((result2, schema2, index) => {
    const nextContext = new AccumulatedErrorContext();
    const nextSchemaPath = `${schemaPath}/anyOf/${index}`;
    const isSchema = ErrorSchema(stack, nextContext, nextSchemaPath, instancePath, schema2, value);
    if (!isSchema)
      failedContexts.push(nextContext);
    return isSchema ? [...result2, nextContext] : result2;
  }, []);
  const isAnyOf = guard_exports.IsGreaterThan(results.length, 0) && context.Merge(results);
  if (!isAnyOf)
    failedContexts.forEach((failed) => failed.GetErrors().forEach((error) => context.AddError(error)));
  return isAnyOf || context.AddError({
    keyword: "anyOf",
    schemaPath,
    instancePath,
    params: {}
  });
}
var init_anyOf2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/anyOf.mjs"() {
    init_context();
    init_reducer();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/boolean.mjs
function CheckSchemaBoolean(_stack, _context, schema, _value) {
  return schema;
}
function ErrorSchemaBoolean(stack, context, schemaPath, instancePath, schema, value) {
  return CheckSchemaBoolean(stack, context, schema, value) || context.AddError({
    keyword: "boolean",
    schemaPath,
    instancePath,
    params: {}
  });
}
var init_boolean3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/boolean.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/const.mjs
function CheckConst(_stack, _context, schema, value) {
  return guard_exports.IsValueLike(schema.const) ? guard_exports.IsEqual(value, schema.const) : guard_exports.IsDeepEqual(value, schema.const);
}
function ErrorConst(stack, context, schemaPath, instancePath, schema, value) {
  return CheckConst(stack, context, schema, value) || context.AddError({
    keyword: "const",
    schemaPath,
    instancePath,
    params: { allowedValue: schema.const }
  });
}
var init_const3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/const.mjs"() {
    init_externals();
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/contains.mjs
function IsValid2(schema) {
  return !(IsMinContains(schema) && guard_exports.IsEqual(schema.minContains, 0));
}
function CheckContains(stack, context, schema, value) {
  if (!IsValid2(schema))
    return true;
  return !guard_exports.IsEqual(value.length, 0) && guard_exports.SomeAll(value, (item, index) => {
    return CheckSchema(stack, context, schema.contains, item) && context.AddIndex(index);
  });
}
function ErrorContains(stack, context, schemaPath, instancePath, schema, value) {
  return CheckContains(stack, context, schema, value) || context.AddError({
    keyword: "contains",
    schemaPath,
    instancePath,
    params: { minContains: 1 }
  });
}
var init_contains2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/contains.mjs"() {
    init_types2();
    init_unique();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/dependencies.mjs
function CheckDependencies(stack, context, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.Every(guard_exports.Entries(schema.dependencies), 0, ([key, schema2]) => {
    return !guard_exports.HasPropertyKey(value, key) || (guard_exports.IsArray(schema2) ? schema2.every((key2) => guard_exports.HasPropertyKey(value, key2)) : CheckSchema(stack, context, schema2, value));
  });
  return isLength || isEvery;
}
function ErrorDependencies(stack, context, schemaPath, instancePath, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.EveryAll(guard_exports.Entries(schema.dependencies), 0, ([key, schema2]) => {
    const nextSchemaPath = `${schemaPath}/dependencies/${key}`;
    return !guard_exports.HasPropertyKey(value, key) || (guard_exports.IsArray(schema2) ? schema2.every((dependency) => guard_exports.HasPropertyKey(value, dependency) || context.AddError({
      keyword: "dependencies",
      schemaPath,
      instancePath,
      params: { property: key, dependencies: schema2 }
    })) : ErrorSchema(stack, context, nextSchemaPath, instancePath, schema2, value));
  });
  return isLength || isEvery;
}
var init_dependencies3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/dependencies.mjs"() {
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/dependentRequired.mjs
function CheckDependentRequired(_stack, _context, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.Every(guard_exports.Entries(schema.dependentRequired), 0, ([key, keys]) => {
    return !guard_exports.HasPropertyKey(value, key) || keys.every((key2) => guard_exports.HasPropertyKey(value, key2));
  });
  return isLength || isEvery;
}
function ErrorDependentRequired(_stack, context, schemaPath, instancePath, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEveryEntry = guard_exports.EveryAll(guard_exports.Entries(schema.dependentRequired), 0, ([key, keys]) => {
    return !guard_exports.HasPropertyKey(value, key) || guard_exports.EveryAll(keys, 0, (dependency) => guard_exports.HasPropertyKey(value, dependency) || context.AddError({
      keyword: "dependentRequired",
      schemaPath,
      instancePath,
      params: { property: key, dependencies: keys }
    }));
  });
  return isLength || isEveryEntry;
}
var init_dependentRequired2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/dependentRequired.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/dependentSchemas.mjs
function CheckDependentSchemas(stack, context, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.Every(guard_exports.Entries(schema.dependentSchemas), 0, ([key, schema2]) => {
    return !guard_exports.HasPropertyKey(value, key) || CheckSchema(stack, context, schema2, value);
  });
  return isLength || isEvery;
}
function ErrorDependentSchemas(stack, context, schemaPath, instancePath, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.EveryAll(guard_exports.Entries(schema.dependentSchemas), 0, ([key, schema2]) => {
    const nextSchemaPath = `${schemaPath}/dependentSchemas/${key}`;
    return !guard_exports.HasPropertyKey(value, key) || ErrorSchema(stack, context, nextSchemaPath, instancePath, schema2, value);
  });
  return isLength || isEvery;
}
var init_dependentSchemas2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/dependentSchemas.mjs"() {
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/dynamicRef.mjs
function CheckDynamicRef(stack, context, schema, value) {
  const target = stack.DynamicRef(schema) ?? false;
  return IsSchema2(target) && CheckSchema(stack, context, target, value);
}
function ErrorDynamicRef(stack, context, _schemaPath, instancePath, schema, value) {
  const target = stack.DynamicRef(schema) ?? false;
  return IsSchema2(target) && ErrorSchema(stack, context, "#", instancePath, target, value);
}
var init_dynamicRef2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/dynamicRef.mjs"() {
    init_functions();
    init_types2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/enum.mjs
function CheckEnum(_stack, _context, schema, value) {
  return guard_exports.Some(schema.enum, (option) => guard_exports.IsValueLike(option) ? guard_exports.IsEqual(value, option) : guard_exports.IsDeepEqual(value, option));
}
function ErrorEnum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckEnum(stack, context, schema, value) || context.AddError({
    keyword: "enum",
    schemaPath,
    instancePath,
    params: { allowedValues: schema.enum }
  });
}
var init_enum5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/enum.mjs"() {
    init_externals();
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/exclusiveMaximum.mjs
function CheckExclusiveMaximum(_stack, _context, schema, value) {
  return guard_exports.IsLessThan(value, schema.exclusiveMaximum);
}
function ErrorExclusiveMaximum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckExclusiveMaximum(stack, context, schema, value) || context.AddError({
    keyword: "exclusiveMaximum",
    schemaPath,
    instancePath,
    params: { comparison: "<", limit: schema.exclusiveMaximum }
  });
}
var init_exclusiveMaximum2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/exclusiveMaximum.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/exclusiveMinimum.mjs
function CheckExclusiveMinimum(_stack, _context, schema, value) {
  return guard_exports.IsGreaterThan(value, schema.exclusiveMinimum);
}
function ErrorExclusiveMinimum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckExclusiveMinimum(stack, context, schema, value) || context.AddError({
    keyword: "exclusiveMinimum",
    schemaPath,
    instancePath,
    params: { comparison: ">", limit: schema.exclusiveMinimum }
  });
}
var init_exclusiveMinimum2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/exclusiveMinimum.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/date.mjs
function IsLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function IsDate2(value) {
  const matches = DATE.exec(value);
  if (!matches)
    return false;
  const year = +matches[1];
  const month = +matches[2];
  const day = +matches[3];
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && IsLeapYear(year) ? 29 : DAYS[month]);
}
var DAYS, DATE;
var init_date = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/date.mjs"() {
    DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/time.mjs
function IsTime(value, strictTimeZone = true) {
  const matches = TIME.exec(value);
  if (!matches)
    return false;
  const hr = +matches[1];
  const min = +matches[2];
  const sec = +matches[3];
  const tzSign = matches[4] === "-" ? -1 : 1;
  const tzH = +(matches[5] || 0);
  const tzM = +(matches[6] || 0);
  if (tzH > 23 || tzM > 59)
    return false;
  if (strictTimeZone && !matches[4] && value.toLowerCase().indexOf("z") === -1) {
    return false;
  }
  if (hr <= 23 && min <= 59 && sec < 60)
    return true;
  const utcMin = min - tzM * tzSign;
  const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
  return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
}
var TIME;
var init_time = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/time.mjs"() {
    TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(?:Z|([+-])(\d\d):(\d\d))?$/i;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/date_time.mjs
function IsDateTime(value, strictTimeZone = true) {
  const dateTime = value.split(/T/i);
  return dateTime.length === 2 && IsDate2(dateTime[0]) && IsTime(dateTime[1], strictTimeZone);
}
var init_date_time = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/date_time.mjs"() {
    init_date();
    init_time();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/duration.mjs
function IsDuration(value) {
  return Duration.test(value);
}
var Duration;
var init_duration = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/duration.mjs"() {
    Duration = /^P((\d+Y(\d+M(\d+D)?)?|\d+M(\d+D)?|\d+D)(T(\d+H(\d+M(\d+S)?)?|\d+M(\d+S)?|\d+S))?|T(\d+H(\d+M(\d+S)?)?|\d+M(\d+S)?|\d+S)|\d+W)$/;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/email.mjs
function IsEmail(value) {
  return Email.test(value);
}
var Email;
var init_email = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/email.mjs"() {
    Email = /^(?!.*\.\.)[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/_puny.mjs
function Adapt(delta, numPoints, firstTime) {
  delta = firstTime ? Math.floor(delta / PUNYCODE_DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > (PUNYCODE_BASE - PUNYCODE_TMIN) * PUNYCODE_TMAX >> 1) {
    delta = Math.floor(delta / (PUNYCODE_BASE - PUNYCODE_TMIN));
    k += PUNYCODE_BASE;
  }
  return k + Math.floor((PUNYCODE_BASE - PUNYCODE_TMIN + 1) * delta / (delta + PUNYCODE_SKEW));
}
function Decode2(value) {
  const output = [];
  let n = PUNYCODE_INITIAL_N;
  let i = 0;
  let bias = PUNYCODE_INITIAL_BIAS;
  const delimIdx = value.lastIndexOf("-");
  if (delimIdx > 0) {
    for (let j = 0; j < delimIdx; j++) {
      const cp = value.charCodeAt(j);
      if (cp >= 128)
        throw new Error("Invalid punycode: non-basic before delimiter");
      output.push(cp);
    }
  }
  let inIdx = delimIdx < 0 ? 0 : delimIdx + 1;
  while (inIdx < value.length) {
    const oldi = i;
    let w = 1;
    let k = PUNYCODE_BASE;
    while (true) {
      if (inIdx >= value.length)
        throw new Error("Invalid punycode: unexpected end of input");
      const ch = value.charCodeAt(inIdx++);
      let digit;
      if (ch >= 97 && ch <= 122)
        digit = ch - 97;
      else if (ch >= 48 && ch <= 57)
        digit = ch - 48 + 26;
      else if (ch >= 65 && ch <= 90)
        Unreachable();
      else
        throw new Error("Invalid punycode: bad digit character");
      i += digit * w;
      const t = k <= bias ? PUNYCODE_TMIN : k >= bias + PUNYCODE_TMAX ? PUNYCODE_TMAX : k - bias;
      if (digit < t)
        break;
      w *= PUNYCODE_BASE - t;
      k += PUNYCODE_BASE;
    }
    const outLen = output.length + 1;
    bias = Adapt(i - oldi, outLen, oldi === 0);
    n += Math.floor(i / outLen);
    i %= outLen;
    output.splice(i, 0, n);
    i++;
  }
  return globalThis.String.fromCodePoint(...output);
}
var PUNYCODE_BASE, PUNYCODE_TMIN, PUNYCODE_TMAX, PUNYCODE_SKEW, PUNYCODE_DAMP, PUNYCODE_INITIAL_BIAS, PUNYCODE_INITIAL_N;
var init_puny = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/_puny.mjs"() {
    init_unreachable2();
    PUNYCODE_BASE = 36;
    PUNYCODE_TMIN = 1;
    PUNYCODE_TMAX = 26;
    PUNYCODE_SKEW = 38;
    PUNYCODE_DAMP = 700;
    PUNYCODE_INITIAL_BIAS = 72;
    PUNYCODE_INITIAL_N = 128;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/_idna.mjs
function IsNonspacingMark(cp) {
  return new RegExp("\\p{Mn}", "u").test(String.fromCodePoint(cp));
}
function IsSpacingCombiningMark(cp) {
  return new RegExp("\\p{Mc}", "u").test(String.fromCodePoint(cp));
}
function IsEnclosingMark(cp) {
  return new RegExp("\\p{Me}", "u").test(String.fromCodePoint(cp));
}
function IsCombiningMark2(cp) {
  return IsNonspacingMark(cp) || IsSpacingCombiningMark(cp) || IsEnclosingMark(cp);
}
function IsGreek(cp) {
  return new RegExp("\\p{Script=Greek}", "u").test(String.fromCodePoint(cp));
}
function IsHebrew(cp) {
  return new RegExp("\\p{Script=Hebrew}", "u").test(String.fromCodePoint(cp));
}
function IsHiragana(cp) {
  return new RegExp("\\p{Script=Hiragana}", "u").test(String.fromCodePoint(cp));
}
function IsKatakana(cp) {
  return new RegExp("\\p{Script=Katakana}", "u").test(String.fromCodePoint(cp));
}
function IsHan(cp) {
  return new RegExp("\\p{Script=Han}", "u").test(String.fromCodePoint(cp));
}
function IsArabicIndicDigit(cp) {
  return cp >= 1632 && cp <= 1641;
}
function IsExtendedArabicIndicDigit(cp) {
  return cp >= 1776 && cp <= 1785;
}
function IsVirama(cp) {
  return VIRAMA_CPS.has(cp);
}
function IsUnicodeLabel(value) {
  if (value.length === 0)
    return Unreachable();
  const cps = [...value].map((c) => c.codePointAt(0));
  const len = cps.length;
  if (cps[0] === 45 || cps[len - 1] === 45)
    return false;
  if (len >= 4 && cps[2] === 45 && cps[3] === 45)
    return false;
  if (IsCombiningMark2(cps[0]))
    return false;
  let hasJapanese = false;
  let hasArabicIndic = false;
  let hasExtendedArabicIndic = false;
  for (let i = 0; i < len; i++) {
    const cp = cps[i];
    if (RFC5892_DISALLOWED.has(cp))
      return false;
    if (IsHiragana(cp) || IsKatakana(cp) || IsHan(cp))
      hasJapanese = true;
    if (IsArabicIndicDigit(cp))
      hasArabicIndic = true;
    if (IsExtendedArabicIndicDigit(cp))
      hasExtendedArabicIndic = true;
    const prev = cps[i - 1], next = cps[i + 1];
    switch (cp) {
      case 183:
        if (prev !== 108 || next !== 108)
          return false;
        break;
      // MIDDLE DOT (Catalan)
      case 885:
        if (next === void 0 || !IsGreek(next))
          return false;
        break;
      // Greek KERAIA
      case 1523:
      case 1524:
        if (prev === void 0 || !IsHebrew(prev))
          return false;
        break;
      // Hebrew GERESH
      case 8204:
        if (prev === void 0 || prev < 128 && !IsVirama(prev))
          return false;
        break;
      case 8205:
        if (prev === void 0 || !IsVirama(prev))
          return false;
        break;
      case 12539:
        break;
    }
  }
  if (value.includes("\u30FB") && !hasJapanese)
    return false;
  if (hasArabicIndic && hasExtendedArabicIndic)
    return false;
  return true;
}
function IsAsciiLabel(value) {
  if (value.charCodeAt(0) === 45 || value.charCodeAt(value.length - 1) === 45)
    return false;
  if (value.length >= 4 && value.charCodeAt(2) === 45 && value.charCodeAt(3) === 45)
    return false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (!(ch >= 97 && ch <= 122 || // a-z
    ch >= 65 && ch <= 90 || // A-Z
    ch >= 48 && ch <= 57 || // 0-9
    ch === 45))
      return false;
  }
  return true;
}
function IsPuny(value) {
  return value.toLowerCase().startsWith("xn--");
}
function IsPunyLabel(value) {
  try {
    const payload = value.slice(4).toLowerCase();
    const lastHyphen = payload.lastIndexOf("-");
    if (lastHyphen === 0) {
      return false;
    }
    const decoded = Decode2(payload);
    if (!decoded)
      return false;
    return IsUnicodeLabel(decoded);
  } catch {
    return false;
  }
}
function IsIdnLabel(value) {
  if (value.length === 0 || value.length > 63)
    return false;
  return IsPuny(value) ? IsPunyLabel(value) : IsUnicodeLabel(value);
}
function IsLabel(value) {
  if (value.length === 0 || value.length > 63)
    return false;
  return IsPuny(value) ? IsPunyLabel(value) : IsAsciiLabel(value);
}
var RFC5892_DISALLOWED, VIRAMA_CPS;
var init_idna = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/_idna.mjs"() {
    init_unreachable2();
    init_puny();
    RFC5892_DISALLOWED = /* @__PURE__ */ new Set([
      1600,
      // ARABIC TATWEEL
      2042,
      // NKO LAJANYALAN
      12334,
      // HANGUL SINGLE DOT TONE MARK
      12335,
      // HANGUL DOUBLE DOT TONE MARK
      12337,
      // VERTICAL KANA REPEAT MARK
      12338,
      // VERTICAL KANA REPEAT WITH VOICED ITERATION MARK
      12339,
      // VERTICAL KANA REPEAT MARK UPPER HALF
      12340,
      // VERTICAL KANA REPEAT WITH VOICED ITERATION MARK UPPER HALF
      12341,
      // VERTICAL KANA REPEAT MARK LOWER HALF
      12347
      // VERTICAL IDEOGRAPHIC ITERATION MARK
    ]);
    VIRAMA_CPS = /* @__PURE__ */ new Set([
      2381,
      2509,
      2637,
      2765,
      2893,
      3021,
      3149,
      3277,
      3387,
      3388,
      3405,
      3530,
      6980,
      7082,
      7083,
      43456,
      69702,
      69759,
      69817,
      69939,
      69940,
      70080,
      70197,
      70477,
      70722,
      70850,
      71103,
      71231,
      71350,
      72767,
      73028,
      73029
    ]);
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/hostname.mjs
function IsHostname(value) {
  if (value.length === 0 || value.length > 253)
    return false;
  if (value.charCodeAt(value.length - 1) === 46)
    return false;
  for (const label of value.split(".")) {
    if (!IsLabel(label))
      return false;
  }
  return true;
}
var init_hostname = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/hostname.mjs"() {
    init_idna();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/idn_email.mjs
function IsIdnEmail(value) {
  return IdnEmail.test(value);
}
var IdnEmail;
var init_idn_email = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/idn_email.mjs"() {
    IdnEmail = /^(?!.*\.\.)[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+)*@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)*$/iu;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/idn_hostname.mjs
function IsIdnHostname(value) {
  if (value.length === 0 || value.includes(" "))
    return false;
  const canonical = value.normalize("NFC").replace(/[\u002E\u3002\uFF0E\uFF61]/g, ".");
  if (canonical.length > 253)
    return false;
  for (const label of canonical.split(".")) {
    if (!IsIdnLabel(label))
      return false;
  }
  return true;
}
var init_idn_hostname = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/idn_hostname.mjs"() {
    init_idna();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/ipv4.mjs
function IsIPv4Internal(value, start, end) {
  let dots = 0;
  let num = 0;
  let digits = 0;
  let leading = 0;
  for (let i = start; i < end; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 46) {
      if (digits === 0 || num > 255 || leading === 48 && digits > 1)
        return false;
      dots++;
      num = 0;
      digits = 0;
      leading = 0;
    } else if (ch >= 48 && ch <= 57) {
      if (digits === 0)
        leading = ch;
      num = num * 10 + (ch - 48);
      digits++;
    } else {
      return false;
    }
  }
  return dots === 3 && digits > 0 && num <= 255 && !(leading === 48 && digits > 1);
}
function IsIPv4(value) {
  return IsIPv4Internal(value, 0, value.length);
}
var init_ipv4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/ipv4.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/ipv6.mjs
function InRange(ch) {
  return ch >= 48 && ch <= 57 || // 0-9
  ch >= 65 && ch <= 70 || // A-F
  ch >= 97 && ch <= 102;
}
function IsIPv6(value) {
  const length = value.length;
  if (length === 0)
    return false;
  let groups = 0;
  let compressed = false;
  let i = 0;
  if (value.charCodeAt(0) === 58 && value.charCodeAt(1) === 58) {
    if (length === 2)
      return true;
    compressed = true;
    i = 2;
  }
  while (i < length) {
    let digits = 0;
    const start = i;
    while (i < length && InRange(value.charCodeAt(i))) {
      i++;
      digits++;
    }
    if (digits === 0)
      return false;
    const next = value.charCodeAt(i);
    if (next === 46) {
      if (!IsIPv4Internal(value, start, length))
        return false;
      groups += 2;
      i = length;
      break;
    }
    if (digits > 4)
      return false;
    groups++;
    if (i === length)
      break;
    if (next !== 58)
      return false;
    i++;
    if (value.charCodeAt(i) === 58) {
      if (compressed)
        return false;
      if (value.charCodeAt(i + 1) === 58)
        return false;
      compressed = true;
      i++;
      if (i === length)
        break;
    }
  }
  return compressed ? groups <= 7 : groups === 8;
}
var init_ipv6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/ipv6.mjs"() {
    init_ipv4();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/iri_reference.mjs
function TryUrl(value) {
  try {
    new URL(value, "http://example.com");
    return true;
  } catch {
    return false;
  }
}
function IsIriReference(value) {
  if (value.includes(" ")) {
    return false;
  }
  if (value.includes("\\")) {
    return false;
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    return false;
  }
  if (/%(?![0-9a-fA-F]{2})/.test(value)) {
    return false;
  }
  if (value === "") {
    return true;
  }
  const colonIndex = value.indexOf(":");
  const hasValidSchemePrefix = colonIndex > 0 && // Colon must not be at the very beginning (e.g., ":foo")
  /^[a-zA-Z][a-zA-Z0-9+\-.]*$/.test(value.substring(0, colonIndex));
  if (hasValidSchemePrefix) {
    return TryUrl(value);
  } else {
    const looksLikeMalformedSchemeAndAuthority = value.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*)(\/\/)/);
    if (looksLikeMalformedSchemeAndAuthority && colonIndex === -1) {
      return false;
    }
    return TryUrl(value);
  }
}
var init_iri_reference = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/iri_reference.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/iri.mjs
function IsIri(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
var init_iri = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/iri.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/json_pointer_uri_fragment.mjs
function IsJsonPointerUriFragment(value) {
  return JsonPointerUriFragment.test(value);
}
var JsonPointerUriFragment;
var init_json_pointer_uri_fragment = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/json_pointer_uri_fragment.mjs"() {
    JsonPointerUriFragment = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/json_pointer.mjs
function IsJsonPointer(value) {
  return JsonPointer.test(value);
}
var JsonPointer;
var init_json_pointer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/json_pointer.mjs"() {
    JsonPointer = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/regex.mjs
function IsRegex(value) {
  if (value.length === 0) {
    return false;
  }
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}
var init_regex = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/regex.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/relative_json_pointer.mjs
function IsRelativeJsonPointer(value) {
  return RelativeJsonPointer.test(value);
}
var RelativeJsonPointer;
var init_relative_json_pointer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/relative_json_pointer.mjs"() {
    RelativeJsonPointer = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/uri_reference.mjs
function IsUriReference(value) {
  return UriReference.test(value);
}
var UriReference;
var init_uri_reference = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/uri_reference.mjs"() {
    UriReference = /^(?!.*[^\x00-\x7F])(?!.*\\)(?:(?:[a-z][a-z0-9+\-.]*:)?(?:\/\/[^\s[\]{}<>^`|]*)?|[^\s[\]{}<>^`|]*)(?:\?[^\s[\]{}<>^`|]*)?(?:#[^\s[\]{}<>^`|]*)?$/i;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/uri_template.mjs
function IsUriTemplate(value) {
  return UriTemplate.test(value);
}
var UriTemplate;
var init_uri_template = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/uri_template.mjs"() {
    UriTemplate = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/uri.mjs
function IsAlpha(ch) {
  return ch >= 97 && ch <= 122 || ch >= 65 && ch <= 90;
}
function IsAlphaNumeric(ch) {
  return IsAlpha(ch) || ch >= 48 && ch <= 57;
}
function IsHex(ch) {
  return ch >= 48 && ch <= 57 || // 0-9
  ch >= 65 && ch <= 70 || // A-F
  ch >= 97 && ch <= 102;
}
function IsSchemeChar(ch) {
  return IsAlphaNumeric(ch) || ch === 43 || ch === 45 || ch === 46;
}
function IsUnreserved(ch) {
  return IsAlphaNumeric(ch) || ch === 45 || ch === 46 || // '-', '.'
  ch === 95 || ch === 126;
}
function IsSubDelim(ch) {
  return ch === 33 || ch === 36 || ch === 38 || ch === 39 || ch === 40 || ch === 41 || ch === 42 || ch === 43 || ch === 44 || ch === 59 || ch === 61;
}
function IsPchar(ch) {
  return IsUnreserved(ch) || IsSubDelim(ch) || ch === 58 || ch === 64;
}
function IsUri(value) {
  const length = value.length;
  if (length === 0)
    return false;
  if (!IsAlpha(value.charCodeAt(0)))
    return false;
  let i = 1;
  while (i < length) {
    const ch = value.charCodeAt(i);
    if (ch === 58)
      break;
    if (!IsSchemeChar(ch))
      return false;
    i++;
  }
  if (value.charCodeAt(i) !== 58)
    return false;
  i++;
  if (value.charCodeAt(i) === 47 && value.charCodeAt(i + 1) === 47) {
    i += 2;
    const authorityStart = i;
    let atPos = -1;
    for (let j = i; j < length; j++) {
      const ch = value.charCodeAt(j);
      if (ch === 64) {
        atPos = j;
        break;
      }
      if (ch === 47 || ch === 63 || ch === 35)
        break;
    }
    if (atPos !== -1) {
      for (let j = authorityStart; j < atPos; j++) {
        const ch = value.charCodeAt(j);
        if (ch === 91 || ch === 93)
          return false;
        if (ch === 37) {
          if (j + 2 >= atPos || !IsHex(value.charCodeAt(j + 1)) || !IsHex(value.charCodeAt(j + 2)))
            return false;
          j += 2;
        } else if (!IsUnreserved(ch) && !IsSubDelim(ch) && ch !== 58)
          return false;
      }
      i = atPos + 1;
    }
    if (value.charCodeAt(i) === 91) {
      i++;
      while (i < length && value.charCodeAt(i) !== 93)
        i++;
      if (value.charCodeAt(i) !== 93)
        return false;
      i++;
    } else {
      while (i < length) {
        const ch = value.charCodeAt(i);
        if (ch === 47 || ch === 63 || ch === 35 || ch === 58)
          break;
        if (ch < 128 && !IsUnreserved(ch) && !IsSubDelim(ch))
          return false;
        i++;
      }
    }
    if (value.charCodeAt(i) === 58) {
      i++;
      while (i < length) {
        const ch = value.charCodeAt(i);
        if (ch === 47 || ch === 63 || ch === 35)
          break;
        if (ch < 48 || ch > 57)
          return false;
        i++;
      }
    }
  }
  while (i < length) {
    const ch = value.charCodeAt(i);
    if (ch === 37) {
      if (i + 2 >= length || !IsHex(value.charCodeAt(i + 1)) || !IsHex(value.charCodeAt(i + 2)))
        return false;
      i += 2;
    } else if (ch > 127) {
      return false;
    } else if (!(IsPchar(ch) || ch === 47 || ch === 63 || ch === 35)) {
      return false;
    }
    i++;
  }
  return true;
}
var init_uri = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/uri.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/url.mjs
function IsUrl(value) {
  return Url.test(value);
}
var Url;
var init_url = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/url.mjs"() {
    Url = /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/uuid.mjs
function IsUuid(value) {
  return Uuid.test(value);
}
var Uuid;
var init_uuid = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/uuid.mjs"() {
    Uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/_registry.mjs
function Clear() {
  formats.clear();
}
function Entries2() {
  return [...formats.entries()];
}
function Set3(format, check) {
  formats.set(format, check);
}
function Has(format) {
  return formats.has(format);
}
function Get3(format) {
  return formats.get(format);
}
function Test(format, value) {
  return formats.get(format)?.(value) ?? true;
}
function Reset2() {
  Clear();
  formats.set("date-time", IsDateTime);
  formats.set("date", IsDate2);
  formats.set("duration", IsDuration);
  formats.set("email", IsEmail);
  formats.set("hostname", IsHostname);
  formats.set("idn-email", IsIdnEmail);
  formats.set("idn-hostname", IsIdnHostname);
  formats.set("ipv4", IsIPv4);
  formats.set("ipv6", IsIPv6);
  formats.set("iri-reference", IsIriReference);
  formats.set("iri", IsIri);
  formats.set("json-pointer-uri-fragment", IsJsonPointerUriFragment);
  formats.set("json-pointer", IsJsonPointer);
  formats.set("regex", IsRegex);
  formats.set("relative-json-pointer", IsRelativeJsonPointer);
  formats.set("time", IsTime);
  formats.set("uri-reference", IsUriReference);
  formats.set("uri-template", IsUriTemplate);
  formats.set("uri", IsUri);
  formats.set("url", IsUrl);
  formats.set("uuid", IsUuid);
}
var formats;
var init_registry = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/_registry.mjs"() {
    init_date_time();
    init_date();
    init_duration();
    init_email();
    init_hostname();
    init_idn_email();
    init_idn_hostname();
    init_ipv4();
    init_ipv6();
    init_iri_reference();
    init_iri();
    init_json_pointer_uri_fragment();
    init_json_pointer();
    init_regex();
    init_relative_json_pointer();
    init_time();
    init_uri_reference();
    init_uri_template();
    init_uri();
    init_url();
    init_uuid();
    formats = /* @__PURE__ */ new Map();
    Reset2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/format.mjs
var format_exports = {};
__export(format_exports, {
  Clear: () => Clear,
  Entries: () => Entries2,
  Get: () => Get3,
  Has: () => Has,
  IsDate: () => IsDate2,
  IsDateTime: () => IsDateTime,
  IsDuration: () => IsDuration,
  IsEmail: () => IsEmail,
  IsHostname: () => IsHostname,
  IsIPv4: () => IsIPv4,
  IsIPv6: () => IsIPv6,
  IsIdnEmail: () => IsIdnEmail,
  IsIdnHostname: () => IsIdnHostname,
  IsIri: () => IsIri,
  IsIriReference: () => IsIriReference,
  IsJsonPointer: () => IsJsonPointer,
  IsJsonPointerUriFragment: () => IsJsonPointerUriFragment,
  IsRegex: () => IsRegex,
  IsRelativeJsonPointer: () => IsRelativeJsonPointer,
  IsTime: () => IsTime,
  IsUri: () => IsUri,
  IsUriReference: () => IsUriReference,
  IsUriTemplate: () => IsUriTemplate,
  IsUrl: () => IsUrl,
  IsUuid: () => IsUuid,
  Reset: () => Reset2,
  Set: () => Set3,
  Test: () => Test
});
var init_format2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/format.mjs"() {
    init_registry();
    init_date_time();
    init_date();
    init_duration();
    init_email();
    init_hostname();
    init_idn_email();
    init_idn_hostname();
    init_ipv4();
    init_ipv6();
    init_iri_reference();
    init_iri();
    init_json_pointer_uri_fragment();
    init_json_pointer();
    init_regex();
    init_relative_json_pointer();
    init_time();
    init_uri_reference();
    init_uri_template();
    init_uri();
    init_url();
    init_uuid();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/index.mjs
var init_format3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/format/index.mjs"() {
    init_format2();
    init_format2();
    init_format2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/format.mjs
function CheckFormat(_stack, _context, schema, value) {
  return format_exports.Test(schema.format, value);
}
function ErrorFormat(stack, context, schemaPath, instancePath, schema, value) {
  return CheckFormat(stack, context, schema, value) || context.AddError({
    keyword: "format",
    schemaPath,
    instancePath,
    params: { format: schema.format }
  });
}
var init_format4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/format.mjs"() {
    init_format3();
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/if.mjs
function CheckIf(stack, context, schema, value) {
  const thenSchema = IsThen(schema) ? schema.then : true;
  const elseSchema = IsElse(schema) ? schema.else : true;
  return CheckSchema(stack, context, schema.if, value) ? CheckSchema(stack, context, thenSchema, value) : CheckSchema(stack, context, elseSchema, value);
}
function ErrorIf(stack, context, schemaPath, instancePath, schema, value) {
  const thenSchema = IsThen(schema) ? schema.then : true;
  const elseSchema = IsElse(schema) ? schema.else : true;
  const trueContext = new AccumulatedErrorContext();
  const isIf = ErrorSchema(stack, trueContext, `${schemaPath}/if`, instancePath, schema.if, value) ? ErrorSchema(stack, trueContext, `${schemaPath}/then`, instancePath, thenSchema, value) || context.AddError({
    keyword: "if",
    schemaPath,
    instancePath,
    params: { failingKeyword: "then" }
  }) : ErrorSchema(stack, context, `${schemaPath}/else`, instancePath, elseSchema, value) || context.AddError({
    keyword: "if",
    schemaPath,
    instancePath,
    params: { failingKeyword: "else" }
  });
  if (isIf)
    context.Merge([trueContext]);
  return isIf;
}
var init_if2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/if.mjs"() {
    init_types2();
    init_context();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/items.mjs
function CheckItemsSized(stack, context, schema, value) {
  return guard_exports.Every(schema.items, 0, (schema2, index) => {
    return guard_exports.IsLessEqualThan(value.length, index) || CheckSchemaPushStack(stack, context, schema2, value[index]) && context.AddIndex(index);
  });
}
function ErrorItemsSized(stack, context, schemaPath, instancePath, schema, value) {
  return guard_exports.EveryAll(schema.items, 0, (schema2, index) => {
    const nextSchemaPath = `${schemaPath}/items/${index}`;
    const nextInstancePath = `${instancePath}/${index}`;
    return guard_exports.IsLessEqualThan(value.length, index) || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema2, value[index]) && context.AddIndex(index);
  });
}
function CheckItemsUnsized(stack, context, schema, value) {
  const offset = IsPrefixItems(schema) ? schema.prefixItems.length : 0;
  return guard_exports.Every(value, offset, (element, index) => {
    return CheckSchemaPushStack(stack, context, schema.items, element) && context.AddIndex(index);
  });
}
function ErrorItemsUnsized(stack, context, schemaPath, instancePath, schema, value) {
  const offset = IsPrefixItems(schema) ? schema.prefixItems.length : 0;
  return guard_exports.EveryAll(value, offset, (element, index) => {
    const nextSchemaPath = `${schemaPath}/items`;
    const nextInstancePath = `${instancePath}/${index}`;
    return ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema.items, element) && context.AddIndex(index);
  });
}
function CheckItems(stack, context, schema, value) {
  return IsItemsSized(schema) ? CheckItemsSized(stack, context, schema, value) : CheckItemsUnsized(stack, context, schema, value);
}
function ErrorItems(stack, context, schemaPath, instancePath, schema, value) {
  return IsItemsSized(schema) ? ErrorItemsSized(stack, context, schemaPath, instancePath, schema, value) : ErrorItemsUnsized(stack, context, schemaPath, instancePath, schema, value);
}
var init_items2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/items.mjs"() {
    init_types2();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maxContains.mjs
function IsValid3(schema) {
  return IsContains(schema);
}
function CheckMaxContains(stack, context, schema, value) {
  if (!IsValid3(schema))
    return true;
  const count2 = guard_exports.Counted(value, (item) => CheckSchema(stack, context, schema.contains, item));
  return guard_exports.IsLessEqualThan(count2, schema.maxContains);
}
function ErrorMaxContains(stack, context, schemaPath, instancePath, schema, value) {
  const minContains = IsMinContains(schema) ? schema.minContains : 1;
  return CheckMaxContains(stack, context, schema, value) || context.AddError({
    keyword: "contains",
    schemaPath,
    instancePath,
    params: { minContains, maxContains: schema.maxContains }
  });
}
var init_maxContains2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maxContains.mjs"() {
    init_types2();
    init_unique();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maximum.mjs
function CheckMaximum(_stack, _context, schema, value) {
  return guard_exports.IsLessEqualThan(value, schema.maximum);
}
function ErrorMaximum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMaximum(stack, context, schema, value) || context.AddError({
    keyword: "maximum",
    schemaPath,
    instancePath,
    params: { comparison: "<=", limit: schema.maximum }
  });
}
var init_maximum2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maximum.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maxItems.mjs
function CheckMaxItems(_stack, _context, schema, value) {
  return guard_exports.IsLessEqualThan(value.length, schema.maxItems);
}
function ErrorMaxItems(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMaxItems(stack, context, schema, value) || context.AddError({
    keyword: "maxItems",
    schemaPath,
    instancePath,
    params: { limit: schema.maxItems }
  });
}
var init_maxItems2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maxItems.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maxLength.mjs
function CheckMaxLength(_stack, _context, schema, value) {
  return guard_exports.IsMaxLength(value, schema.maxLength);
}
function ErrorMaxLength(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMaxLength(stack, context, schema, value) || context.AddError({
    keyword: "maxLength",
    schemaPath,
    instancePath,
    params: { limit: schema.maxLength }
  });
}
var init_maxLength2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maxLength.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maxProperties.mjs
function CheckMaxProperties(_stack, _context, schema, value) {
  return guard_exports.IsLessEqualThan(guard_exports.Keys(value).length, schema.maxProperties);
}
function ErrorMaxProperties(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMaxProperties(stack, context, schema, value) || context.AddError({
    keyword: "maxProperties",
    schemaPath,
    instancePath,
    params: { limit: schema.maxProperties }
  });
}
var init_maxProperties2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/maxProperties.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minContains.mjs
function IsValid4(schema) {
  return IsContains(schema);
}
function CheckMinContains(stack, context, schema, value) {
  if (!IsValid4(schema))
    return true;
  const count2 = guard_exports.Counted(value, (item, index) => CheckSchema(stack, context, schema.contains, item) && context.AddIndex(index));
  return guard_exports.IsGreaterEqualThan(count2, schema.minContains);
}
function ErrorMinContains(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinContains(stack, context, schema, value) || context.AddError({
    keyword: "contains",
    schemaPath,
    instancePath,
    params: { minContains: schema.minContains }
  });
}
var init_minContains2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minContains.mjs"() {
    init_types2();
    init_unique();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minimum.mjs
function CheckMinimum(_stack, _context, schema, value) {
  return guard_exports.IsGreaterEqualThan(value, schema.minimum);
}
function ErrorMinimum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinimum(stack, context, schema, value) || context.AddError({
    keyword: "minimum",
    schemaPath,
    instancePath,
    params: { comparison: ">=", limit: schema.minimum }
  });
}
var init_minimum2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minimum.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minItems.mjs
function CheckMinItems(_stack, _context, schema, value) {
  return guard_exports.IsGreaterEqualThan(value.length, schema.minItems);
}
function ErrorMinItems(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinItems(stack, context, schema, value) || context.AddError({
    keyword: "minItems",
    schemaPath,
    instancePath,
    params: { limit: schema.minItems }
  });
}
var init_minItems2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minItems.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minLength.mjs
function CheckMinLength(_stack, _context, schema, value) {
  return guard_exports.IsMinLength(value, schema.minLength);
}
function ErrorMinLength(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinLength(stack, context, schema, value) || context.AddError({
    keyword: "minLength",
    schemaPath,
    instancePath,
    params: { limit: schema.minLength }
  });
}
var init_minLength2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minLength.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minProperties.mjs
function CheckMinProperties(_stack, _context, schema, value) {
  return guard_exports.IsGreaterEqualThan(guard_exports.Keys(value).length, schema.minProperties);
}
function ErrorMinProperties(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinProperties(stack, context, schema, value) || context.AddError({
    keyword: "minProperties",
    schemaPath,
    instancePath,
    params: { limit: schema.minProperties }
  });
}
var init_minProperties2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/minProperties.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/multipleOf.mjs
function CheckMultipleOf(_stack, _context, schema, value) {
  return guard_exports.IsMultipleOf(value, schema.multipleOf);
}
function ErrorMultipleOf(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMultipleOf(stack, context, schema, value) || context.AddError({
    keyword: "multipleOf",
    schemaPath,
    instancePath,
    params: { multipleOf: schema.multipleOf }
  });
}
var init_multipleOf2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/multipleOf.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/not.mjs
function CheckNot(stack, context, schema, value) {
  const nextContext = new CheckContext();
  const isSchema = !CheckSchema(stack, nextContext, schema.not, value);
  const isNot = isSchema && context.Merge([nextContext]);
  return isNot;
}
function ErrorNot(stack, context, schemaPath, instancePath, schema, value) {
  return CheckNot(stack, context, schema, value) || context.AddError({
    keyword: "not",
    schemaPath,
    instancePath,
    params: {}
  });
}
var init_not2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/not.mjs"() {
    init_context();
    init_reducer();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/oneOf.mjs
function CheckOneOf(stack, context, schema, value) {
  const passedContexts = schema.oneOf.reduce((result2, schema2) => {
    const nextContext = new CheckContext();
    return CheckSchema(stack, nextContext, schema2, value) ? [...result2, nextContext] : result2;
  }, []);
  return guard_exports.IsEqual(passedContexts.length, 1) && context.Merge(passedContexts);
}
function ErrorOneOf(stack, context, schemaPath, instancePath, schema, value) {
  const failedContexts = [];
  const passingSchemas = [];
  const passedContexts = schema.oneOf.reduce((result2, schema2, index) => {
    const nextContext = new AccumulatedErrorContext();
    const nextSchemaPath = `${schemaPath}/oneOf/${index}`;
    const isSchema = ErrorSchema(stack, nextContext, nextSchemaPath, instancePath, schema2, value);
    if (isSchema)
      passingSchemas.push(index);
    if (!isSchema)
      failedContexts.push(nextContext);
    return isSchema ? [...result2, nextContext] : result2;
  }, []);
  const isOneOf = guard_exports.IsEqual(passedContexts.length, 1) && context.Merge(passedContexts);
  if (!isOneOf && guard_exports.IsEqual(passingSchemas.length, 0))
    failedContexts.forEach((failed) => failed.GetErrors().forEach((error) => context.AddError(error)));
  return isOneOf || context.AddError({
    keyword: "oneOf",
    schemaPath,
    instancePath,
    params: { passingSchemas }
  });
}
var init_oneOf2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/oneOf.mjs"() {
    init_context();
    init_reducer();
    init_guard2();
    init_schema3();
    init_unique();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/pattern.mjs
function CheckPattern(_stack, _context, schema, value) {
  const regexp = guard_exports.IsString(schema.pattern) ? new RegExp(schema.pattern, "u") : schema.pattern;
  return regexp.test(value);
}
function ErrorPattern(stack, context, schemaPath, instancePath, schema, value) {
  return CheckPattern(stack, context, schema, value) || context.AddError({
    keyword: "pattern",
    schemaPath,
    instancePath,
    params: { pattern: schema.pattern }
  });
}
var init_pattern3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/pattern.mjs"() {
    init_externals();
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/patternProperties.mjs
function CheckPatternProperties(stack, context, schema, value) {
  return guard_exports.Every(guard_exports.Entries(schema.patternProperties), 0, ([pattern, schema2]) => {
    const regexp = new RegExp(pattern, "u");
    return guard_exports.Every(guard_exports.Entries(value), 0, ([key, prop]) => {
      return !regexp.test(key) || CheckSchemaPushStack(stack, context, schema2, prop) && context.AddKey(key);
    });
  });
}
function ErrorPatternProperties(stack, context, schemaPath, instancePath, schema, value) {
  return guard_exports.EveryAll(guard_exports.Entries(schema.patternProperties), 0, ([pattern, schema2]) => {
    const nextSchemaPath = `${schemaPath}/patternProperties/${pattern}`;
    const regexp = new RegExp(pattern, "u");
    return guard_exports.EveryAll(guard_exports.Entries(value), 0, ([key, value2]) => {
      const nextInstancePath = `${instancePath}/${key}`;
      const notKey = !regexp.test(key);
      return notKey || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema2, value2) && context.AddKey(key);
    });
  });
}
var init_patternProperties2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/patternProperties.mjs"() {
    init_externals();
    init_unique();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/prefixItems.mjs
function CheckPrefixItems(stack, context, schema, value) {
  return guard_exports.IsEqual(value.length, 0) || guard_exports.Every(schema.prefixItems, 0, (schema2, index) => {
    return guard_exports.IsLessEqualThan(value.length, index) || CheckSchemaPushStack(stack, context, schema2, value[index]) && context.AddIndex(index);
  });
}
function ErrorPrefixItems(stack, context, schemaPath, instancePath, schema, value) {
  return guard_exports.IsEqual(value.length, 0) || guard_exports.EveryAll(schema.prefixItems, 0, (schema2, index) => {
    const nextSchemaPath = `${schemaPath}/prefixItems/${index}`;
    const nextInstancePath = `${instancePath}/${index}`;
    return guard_exports.IsLessEqualThan(value.length, index) || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema2, value[index]) && context.AddIndex(index);
  });
}
var init_prefixItems2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/prefixItems.mjs"() {
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_exact_optional.mjs
function IsExactOptional(required, key) {
  return required.includes(key) || settings_exports.Get().exactOptionalPropertyTypes;
}
function InexactOptionalCheck(value, key) {
  return guard_exports.IsUndefined(value[key]);
}
var init_exact_optional = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_exact_optional.mjs"() {
    init_settings2();
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/properties.mjs
function CheckProperties(stack, context, schema, value) {
  const required = IsRequired(schema) ? schema.required : [];
  const isProperties = guard_exports.Every(guard_exports.Entries(schema.properties), 0, ([key, schema2]) => {
    const isProperty = !guard_exports.HasPropertyKey(value, key) || CheckSchemaPushStack(stack, context, schema2, value[key]) && context.AddKey(key);
    return IsExactOptional(required, key) ? isProperty : InexactOptionalCheck(value, key) || isProperty;
  });
  return isProperties;
}
function ErrorProperties(stack, context, schemaPath, instancePath, schema, value) {
  const required = IsRequired(schema) ? schema.required : [];
  const isProperties = guard_exports.EveryAll(guard_exports.Entries(schema.properties), 0, ([key, schema2]) => {
    const nextSchemaPath = `${schemaPath}/properties/${key}`;
    const nextInstancePath = `${instancePath}/${key}`;
    const isProperty = () => !guard_exports.HasPropertyKey(value, key) || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema2, value[key]) && context.AddKey(key);
    return IsExactOptional(required, key) ? isProperty() : InexactOptionalCheck(value, key) || isProperty();
  });
  return isProperties;
}
var init_properties3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/properties.mjs"() {
    init_types2();
    init_guard2();
    init_schema3();
    init_exact_optional();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/propertyNames.mjs
function CheckPropertyNames(stack, context, schema, value) {
  return guard_exports.Every(guard_exports.Keys(value), 0, (key, _index) => CheckSchema(stack, context, schema.propertyNames, key));
}
function ErrorPropertyNames(stack, context, schemaPath, instancePath, schema, value) {
  const propertyNames = [];
  const isPropertyNames = guard_exports.EveryAll(guard_exports.Keys(value), 0, (key, _index) => {
    const nextInstancePath = `${instancePath}/${key}`;
    const nextSchemaPath = `${schemaPath}/propertyNames`;
    const nextContext = new AccumulatedErrorContext();
    const isPropertyName = ErrorSchema(stack, nextContext, nextSchemaPath, nextInstancePath, schema.propertyNames, key);
    if (!isPropertyName)
      propertyNames.push(key);
    return isPropertyName;
  });
  return isPropertyNames || context.AddError({
    keyword: "propertyNames",
    schemaPath,
    instancePath,
    params: { propertyNames }
  });
}
var init_propertyNames2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/propertyNames.mjs"() {
    init_unique();
    init_context();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/recursiveRef.mjs
function CheckRecursiveRef(stack, context, schema, value) {
  const target = stack.RecursiveRef(schema) ?? false;
  return IsSchema2(target) && CheckSchema(stack, context, target, value);
}
function ErrorRecursiveRef(stack, context, _schemaPath, instancePath, schema, value) {
  const target = stack.RecursiveRef(schema) ?? false;
  return IsSchema2(target) && ErrorSchema(stack, context, "#", instancePath, target, value);
}
var init_recursiveRef2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/recursiveRef.mjs"() {
    init_functions();
    init_types2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/ref.mjs
function CheckRef(stack, context, schema, value) {
  const target = stack.Ref(schema) ?? false;
  const nextContext = new CheckContext();
  const result2 = IsSchema2(target) && CheckSchema(stack, nextContext, target, value);
  if (result2)
    context.Merge([nextContext]);
  return result2;
}
function ErrorRef(stack, context, _schemaPath, instancePath, schema, value) {
  const target = stack.Ref(schema) ?? false;
  const nextContext = new AccumulatedErrorContext();
  const result2 = IsSchema2(target) && ErrorSchema(stack, nextContext, "#", instancePath, target, value);
  if (result2)
    context.Merge([nextContext]);
  if (!result2)
    nextContext.GetErrors().forEach((error) => context.AddError(error));
  return result2;
}
var init_ref4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/ref.mjs"() {
    init_functions();
    init_types2();
    init_context();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/required.mjs
function CheckRequired(_stack, _context, schema, value) {
  return guard_exports.Every(schema.required, 0, (key) => guard_exports.HasPropertyKey(value, key));
}
function ErrorRequired(_stack, context, schemaPath, instancePath, schema, value) {
  const requiredProperties = [];
  const isRequired = guard_exports.EveryAll(schema.required, 0, (key) => {
    const hasKey = guard_exports.HasPropertyKey(value, key);
    if (!hasKey)
      requiredProperties.push(key);
    return hasKey;
  });
  return isRequired || context.AddError({
    keyword: "required",
    schemaPath,
    instancePath,
    params: { requiredProperties }
  });
}
var init_required4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/required.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/type.mjs
function CheckTypeName(_stack, _context, type, _schema, value) {
  return (
    // jsonschema
    guard_exports.IsEqual(type, "object") ? guard_exports.IsObjectNotArray(value) : guard_exports.IsEqual(type, "array") ? guard_exports.IsArray(value) : guard_exports.IsEqual(type, "boolean") ? guard_exports.IsBoolean(value) : guard_exports.IsEqual(type, "integer") ? guard_exports.IsInteger(value) : guard_exports.IsEqual(type, "number") ? guard_exports.IsNumber(value) : guard_exports.IsEqual(type, "null") ? guard_exports.IsNull(value) : guard_exports.IsEqual(type, "string") ? guard_exports.IsString(value) : (
      // xschema
      guard_exports.IsEqual(type, "bigint") ? guard_exports.IsBigInt(value) : guard_exports.IsEqual(type, "constructor") ? guard_exports.IsConstructor(value) : guard_exports.IsEqual(type, "function") ? guard_exports.IsFunction(value) : guard_exports.IsEqual(type, "symbol") ? guard_exports.IsSymbol(value) : guard_exports.IsEqual(type, "undefined") ? guard_exports.IsUndefined(value) : guard_exports.IsEqual(type, "void") ? guard_exports.IsUndefined(value) : true
    )
  );
}
function CheckTypeNames(stack, context, types, schema, value) {
  return guard_exports.Some(types, (type) => CheckTypeName(stack, context, type, schema, value));
}
function CheckType(stack, context, schema, value) {
  return guard_exports.IsArray(schema.type) ? CheckTypeNames(stack, context, schema.type, schema, value) : CheckTypeName(stack, context, schema.type, schema, value);
}
function ErrorType(stack, context, schemaPath, instancePath, schema, value) {
  const isType = guard_exports.IsArray(schema.type) ? CheckTypeNames(stack, context, schema.type, schema, value) : CheckTypeName(stack, context, schema.type, schema, value);
  return isType || context.AddError({
    keyword: "type",
    schemaPath,
    instancePath,
    params: { type: schema.type }
  });
}
var init_type2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/type.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/unevaluatedItems.mjs
function CheckUnevaluatedItems(stack, context, schema, value) {
  const indices = context.GetIndices();
  return guard_exports.Every(value, 0, (item, index) => {
    return (indices.has(index) || CheckSchema(stack, context, schema.unevaluatedItems, item)) && context.AddIndex(index);
  });
}
function ErrorUnevaluatedItems(stack, context, schemaPath, instancePath, schema, value) {
  const indices = context.GetIndices();
  const unevaluatedItems = [];
  const isUnevaluatedItems = guard_exports.EveryAll(value, 0, (item, index) => {
    const nextContext = new AccumulatedErrorContext();
    const isEvaluatedItem = (indices.has(index) || ErrorSchema(stack, nextContext, schemaPath, instancePath, schema.unevaluatedItems, item)) && context.AddIndex(index);
    if (!isEvaluatedItem)
      unevaluatedItems.push(index);
    return isEvaluatedItem;
  });
  return isUnevaluatedItems || context.AddError({
    keyword: "unevaluatedItems",
    schemaPath,
    instancePath,
    params: { unevaluatedItems }
  });
}
var init_unevaluatedItems2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/unevaluatedItems.mjs"() {
    init_unique();
    init_context();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/unevaluatedProperties.mjs
function CheckUnevaluatedProperties(stack, context, schema, value) {
  const keys = context.GetKeys();
  return guard_exports.Every(guard_exports.Entries(value), 0, ([key, prop]) => {
    return keys.has(key) || CheckSchema(stack, context, schema.unevaluatedProperties, prop) && context.AddKey(key);
  });
}
function ErrorUnevaluatedProperties(stack, context, schemaPath, instancePath, schema, value) {
  const keys = context.GetKeys();
  const unevaluatedProperties = [];
  const isUnevaluatedProperties = guard_exports.EveryAll(guard_exports.Entries(value), 0, ([key, prop]) => {
    const nextContext = new AccumulatedErrorContext();
    const isEvaluatedProperty = keys.has(key) || ErrorSchema(stack, nextContext, schemaPath, instancePath, schema.unevaluatedProperties, prop) && context.AddKey(key);
    if (!isEvaluatedProperty)
      unevaluatedProperties.push(key);
    return isEvaluatedProperty;
  });
  return isUnevaluatedProperties || context.AddError({
    keyword: "unevaluatedProperties",
    schemaPath,
    instancePath,
    params: { unevaluatedProperties }
  });
}
var init_unevaluatedProperties2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/unevaluatedProperties.mjs"() {
    init_unique();
    init_context();
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/uniqueItems.mjs
function IsValid5(schema) {
  return !guard_exports.IsEqual(schema.uniqueItems, false);
}
function CheckUniqueItems(_stack, _context, schema, value) {
  if (!IsValid5(schema))
    return true;
  const set = new Set(value.map(hash_exports.Hash)).size;
  const isLength = value.length;
  return guard_exports.IsEqual(set, isLength);
}
function ErrorUniqueItems(_stack, context, schemaPath, instancePath, schema, value) {
  if (!IsValid5(schema))
    return true;
  const set = /* @__PURE__ */ new Set();
  const duplicateItems = value.reduce((result2, value2, index) => {
    const hash = hash_exports.Hash(value2);
    if (set.has(hash))
      return [...result2, index];
    set.add(hash);
    return result2;
  }, []);
  const isUniqueItems = guard_exports.IsEqual(duplicateItems.length, 0);
  return isUniqueItems || context.AddError({
    keyword: "uniqueItems",
    schemaPath,
    instancePath,
    params: { duplicateItems }
  });
}
var init_uniqueItems2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/uniqueItems.mjs"() {
    init_hashing();
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/schema.mjs
function CheckSchemaPushStack(stack, context, schema, value) {
  return context.Push() && CheckSchema(stack, context, schema, value) && context.Pop();
}
function CheckSchema(stack, context, schema, value) {
  stack.Push(schema);
  const result2 = IsSchemaBoolean(schema) ? CheckSchemaBoolean(stack, context, schema, value) : (!IsType(schema) || CheckType(stack, context, schema, value)) && (!(guard_exports.IsObject(value) && !guard_exports.IsArray(value)) || (!IsRequired(schema) || CheckRequired(stack, context, schema, value)) && (!IsAdditionalProperties(schema) || CheckAdditionalProperties(stack, context, schema, value)) && (!IsDependencies(schema) || CheckDependencies(stack, context, schema, value)) && (!IsDependentRequired(schema) || CheckDependentRequired(stack, context, schema, value)) && (!IsDependentSchemas(schema) || CheckDependentSchemas(stack, context, schema, value)) && (!IsPatternProperties(schema) || CheckPatternProperties(stack, context, schema, value)) && (!IsProperties(schema) || CheckProperties(stack, context, schema, value)) && (!IsPropertyNames(schema) || CheckPropertyNames(stack, context, schema, value)) && (!IsMinProperties(schema) || CheckMinProperties(stack, context, schema, value)) && (!IsMaxProperties(schema) || CheckMaxProperties(stack, context, schema, value))) && (!guard_exports.IsArray(value) || (!IsAdditionalItems(schema) || CheckAdditionalItems(stack, context, schema, value)) && (!IsContains(schema) || CheckContains(stack, context, schema, value)) && (!IsItems(schema) || CheckItems(stack, context, schema, value)) && (!IsMaxContains(schema) || CheckMaxContains(stack, context, schema, value)) && (!IsMaxItems(schema) || CheckMaxItems(stack, context, schema, value)) && (!IsMinContains(schema) || CheckMinContains(stack, context, schema, value)) && (!IsMinItems(schema) || CheckMinItems(stack, context, schema, value)) && (!IsPrefixItems(schema) || CheckPrefixItems(stack, context, schema, value)) && (!IsUniqueItems(schema) || CheckUniqueItems(stack, context, schema, value))) && (!guard_exports.IsString(value) || (!IsMaxLength3(schema) || CheckMaxLength(stack, context, schema, value)) && (!IsMinLength3(schema) || CheckMinLength(stack, context, schema, value)) && (!IsFormat(schema) || CheckFormat(stack, context, schema, value)) && (!IsPattern(schema) || CheckPattern(stack, context, schema, value))) && (!(guard_exports.IsNumber(value) || guard_exports.IsBigInt(value)) || (!IsExclusiveMaximum(schema) || CheckExclusiveMaximum(stack, context, schema, value)) && (!IsExclusiveMinimum(schema) || CheckExclusiveMinimum(stack, context, schema, value)) && (!IsMaximum(schema) || CheckMaximum(stack, context, schema, value)) && (!IsMinimum(schema) || CheckMinimum(stack, context, schema, value)) && (!IsMultipleOf2(schema) || CheckMultipleOf(stack, context, schema, value))) && (!IsRef2(schema) || CheckRef(stack, context, schema, value)) && (!IsRecursiveRef(schema) || CheckRecursiveRef(stack, context, schema, value)) && (!IsDynamicRef(schema) || CheckDynamicRef(stack, context, schema, value)) && (!IsConst(schema) || CheckConst(stack, context, schema, value)) && (!IsEnum2(schema) || CheckEnum(stack, context, schema, value)) && (!IsIf(schema) || CheckIf(stack, context, schema, value)) && (!IsNot(schema) || CheckNot(stack, context, schema, value)) && (!IsAllOf(schema) || CheckAllOf(stack, context, schema, value)) && (!IsAnyOf(schema) || CheckAnyOf(stack, context, schema, value)) && (!IsOneOf(schema) || CheckOneOf(stack, context, schema, value)) && (!IsUnevaluatedItems(schema) || (!guard_exports.IsArray(value) || CheckUnevaluatedItems(stack, context, schema, value))) && (!IsUnevaluatedProperties(schema) || (!guard_exports.IsObject(value) || CheckUnevaluatedProperties(stack, context, schema, value))) && (!IsRefine2(schema) || CheckRefine(stack, context, schema, value));
  stack.Pop(schema);
  return result2;
}
function ErrorSchemaPushStack(stack, context, schemaPath, instancePath, schema, value) {
  return context.Push() && ErrorSchema(stack, context, schemaPath, instancePath, schema, value) && context.Pop();
}
function ErrorSchema(stack, context, schemaPath, instancePath, schema, value) {
  stack.Push(schema);
  const result2 = IsSchemaBoolean(schema) ? ErrorSchemaBoolean(stack, context, schemaPath, instancePath, schema, value) : !!(+(!IsType(schema) || ErrorType(stack, context, schemaPath, instancePath, schema, value)) & +(!(guard_exports.IsObject(value) && !guard_exports.IsArray(value)) || !!(+(!IsRequired(schema) || ErrorRequired(stack, context, schemaPath, instancePath, schema, value)) & +(!IsAdditionalProperties(schema) || ErrorAdditionalProperties(stack, context, schemaPath, instancePath, schema, value)) & +(!IsDependencies(schema) || ErrorDependencies(stack, context, schemaPath, instancePath, schema, value)) & +(!IsDependentRequired(schema) || ErrorDependentRequired(stack, context, schemaPath, instancePath, schema, value)) & +(!IsDependentSchemas(schema) || ErrorDependentSchemas(stack, context, schemaPath, instancePath, schema, value)) & +(!IsPatternProperties(schema) || ErrorPatternProperties(stack, context, schemaPath, instancePath, schema, value)) & +(!IsProperties(schema) || ErrorProperties(stack, context, schemaPath, instancePath, schema, value)) & +(!IsPropertyNames(schema) || ErrorPropertyNames(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinProperties(schema) || ErrorMinProperties(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMaxProperties(schema) || ErrorMaxProperties(stack, context, schemaPath, instancePath, schema, value)))) & +(!guard_exports.IsArray(value) || !!(+(!IsAdditionalItems(schema) || ErrorAdditionalItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsContains(schema) || ErrorContains(stack, context, schemaPath, instancePath, schema, value)) & +(!IsItems(schema) || ErrorItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMaxContains(schema) || ErrorMaxContains(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMaxItems(schema) || ErrorMaxItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinContains(schema) || ErrorMinContains(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinItems(schema) || ErrorMinItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsPrefixItems(schema) || ErrorPrefixItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsUniqueItems(schema) || ErrorUniqueItems(stack, context, schemaPath, instancePath, schema, value)))) & +(!guard_exports.IsString(value) || !!(+(!IsMaxLength3(schema) || ErrorMaxLength(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinLength3(schema) || ErrorMinLength(stack, context, schemaPath, instancePath, schema, value)) & +(!IsFormat(schema) || ErrorFormat(stack, context, schemaPath, instancePath, schema, value)) & +(!IsPattern(schema) || ErrorPattern(stack, context, schemaPath, instancePath, schema, value)))) & +(!(guard_exports.IsNumber(value) || guard_exports.IsBigInt(value)) || !!(+(!IsExclusiveMaximum(schema) || ErrorExclusiveMaximum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsExclusiveMinimum(schema) || ErrorExclusiveMinimum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMaximum(schema) || ErrorMaximum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinimum(schema) || ErrorMinimum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMultipleOf2(schema) || ErrorMultipleOf(stack, context, schemaPath, instancePath, schema, value)))) & +(!IsRef2(schema) || ErrorRef(stack, context, schemaPath, instancePath, schema, value)) & +(!IsRecursiveRef(schema) || ErrorRecursiveRef(stack, context, schemaPath, instancePath, schema, value)) & +(!IsDynamicRef(schema) || ErrorDynamicRef(stack, context, schemaPath, instancePath, schema, value)) & +(!IsConst(schema) || ErrorConst(stack, context, schemaPath, instancePath, schema, value)) & +(!IsEnum2(schema) || ErrorEnum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsIf(schema) || ErrorIf(stack, context, schemaPath, instancePath, schema, value)) & +(!IsNot(schema) || ErrorNot(stack, context, schemaPath, instancePath, schema, value)) & +(!IsAllOf(schema) || ErrorAllOf(stack, context, schemaPath, instancePath, schema, value)) & +(!IsAnyOf(schema) || ErrorAnyOf(stack, context, schemaPath, instancePath, schema, value)) & +(!IsOneOf(schema) || ErrorOneOf(stack, context, schemaPath, instancePath, schema, value)) & +(!IsUnevaluatedItems(schema) || (!guard_exports.IsArray(value) || ErrorUnevaluatedItems(stack, context, schemaPath, instancePath, schema, value))) & +(!IsUnevaluatedProperties(schema) || (!guard_exports.IsObject(value) || ErrorUnevaluatedProperties(stack, context, schemaPath, instancePath, schema, value)))) && (!IsRefine2(schema) || ErrorRefine(stack, context, schemaPath, instancePath, schema, value));
  stack.Pop(schema);
  return result2;
}
var init_schema3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/schema.mjs"() {
    init_types2();
    init_refine3();
    init_guard2();
    init_additionalItems2();
    init_additionalProperties2();
    init_allOf2();
    init_anyOf2();
    init_boolean3();
    init_const3();
    init_contains2();
    init_dependencies3();
    init_dependentRequired2();
    init_dependentSchemas2();
    init_dynamicRef2();
    init_enum5();
    init_exclusiveMaximum2();
    init_exclusiveMinimum2();
    init_format4();
    init_if2();
    init_items2();
    init_maxContains2();
    init_maximum2();
    init_maxItems2();
    init_maxLength2();
    init_maxProperties2();
    init_minContains2();
    init_minimum2();
    init_minItems2();
    init_minLength2();
    init_minProperties2();
    init_multipleOf2();
    init_not2();
    init_oneOf2();
    init_pattern3();
    init_patternProperties2();
    init_prefixItems2();
    init_properties3();
    init_propertyNames2();
    init_recursiveRef2();
    init_ref4();
    init_required4();
    init_type2();
    init_unevaluatedItems2();
    init_unevaluatedProperties2();
    init_uniqueItems2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_functions.mjs
var init_functions = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_functions.mjs"() {
    init_guard2();
    init_schema3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/pointer/pointer_get.mjs
var init_pointer_get = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/pointer/pointer_get.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/pointer/pointer.mjs
var pointer_exports = {};
__export(pointer_exports, {
  Delete: () => Delete,
  Get: () => Get4,
  Has: () => Has2,
  Indices: () => Indices,
  Set: () => Set4
});
function AssertNotRoot(indices) {
  if (indices.length === 0)
    throw Error("Cannot set root");
}
function AssertCanSet(value) {
  if (!guard_exports.IsObject(value))
    throw Error("Cannot set value");
}
function AssertIndex(index) {
  if (guard_exports.IsUnsafePropertyKey(index))
    throw Error("Pointer contains unsafe property key");
}
function AssertIndices(indices) {
  for (const index of indices)
    AssertIndex(index);
}
function IsNumericIndex(index) {
  return /^(0|[1-9]\d*)$/.test(index);
}
function TakeIndexRight(indices) {
  return [
    indices.slice(0, indices.length - 1),
    indices.slice(indices.length - 1)[0]
  ];
}
function HasIndex(index, value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, index);
}
function GetIndex(index, value) {
  return guard_exports.IsObject(value) && !guard_exports.IsUnsafePropertyKey(index) ? value[index] : void 0;
}
function GetIndices(indices, value) {
  return indices.reduce((value2, index) => GetIndex(index, value2), value);
}
function Indices(pointer) {
  if (guard_exports.IsEqual(pointer.length, 0))
    return [];
  const indices = pointer.split("/").map((index) => index.replace(/~1/g, "/").replace(/~0/g, "~"));
  return indices.length > 0 && indices[0] === "" ? indices.slice(1) : indices;
}
function Has2(value, pointer) {
  let current = value;
  return Indices(pointer).every((index) => {
    if (!HasIndex(index, current))
      return false;
    current = current[index];
    return true;
  });
}
function Get4(value, pointer) {
  const indices = Indices(pointer);
  return GetIndices(indices, value);
}
function Set4(value, pointer, next) {
  const indices = Indices(pointer);
  AssertNotRoot(indices);
  AssertIndices(indices);
  const [head, index] = TakeIndexRight(indices);
  const parent = GetIndices(head, value);
  AssertCanSet(parent);
  parent[index] = next;
  return value;
}
function Delete(value, pointer) {
  const indices = Indices(pointer);
  AssertNotRoot(indices);
  AssertIndices(indices);
  const [head, index] = TakeIndexRight(indices);
  const parent = GetIndices(head, value);
  AssertCanSet(parent);
  if (guard_exports.IsArray(parent) && IsNumericIndex(index)) {
    parent.splice(+index, 1);
  } else {
    delete parent[index];
  }
  return value;
}
var init_pointer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/pointer/pointer.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/pointer/index.mjs
var init_pointer2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/pointer/index.mjs"() {
    init_pointer_get();
    init_pointer();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/resolve/ref.mjs
function MatchId(schema, base, ref) {
  if (schema.$id === ref.hash)
    return schema;
  const absoluteId = new URL(schema.$id, base.href);
  const absoluteRef = new URL(ref.href, base.href);
  if (guard_exports.IsEqual(absoluteId.pathname, absoluteRef.pathname)) {
    return ref.hash.startsWith("#") ? MatchHash(schema, base, ref) : schema;
  }
  return void 0;
}
function MatchAnchor(schema, base, ref) {
  const absoluteAnchor = new URL(`#${schema.$anchor}`, base.href);
  const absoluteRef = new URL(ref.href, base.href);
  return guard_exports.IsEqual(absoluteAnchor.href, absoluteRef.href) ? schema : void 0;
}
function MatchDynamicAnchor(schema, base, ref) {
  const absoluteAnchor = new URL(`#${schema.$dynamicAnchor}`, base.href);
  const absoluteRef = new URL(ref.href, base.href);
  return guard_exports.IsEqual(absoluteAnchor.href, absoluteRef.href) ? schema : void 0;
}
function MatchHash(schema, _base, ref) {
  if (ref.href.endsWith("#"))
    return schema;
  if (!ref.hash.startsWith("#"))
    return void 0;
  const fragment = decodeURIComponent(ref.hash.slice(1));
  if (!fragment.startsWith("/"))
    return void 0;
  return pointer_exports.Get(schema, fragment);
}
function Match4(schema, base, ref) {
  if (IsId(schema)) {
    const result2 = MatchId(schema, base, ref);
    if (!guard_exports.IsUndefined(result2))
      return result2;
  }
  if (IsAnchor(schema)) {
    const result2 = MatchAnchor(schema, base, ref);
    if (!guard_exports.IsUndefined(result2))
      return result2;
  }
  if (IsDynamicAnchor(schema)) {
    const result2 = MatchDynamicAnchor(schema, base, ref);
    if (!guard_exports.IsUndefined(result2))
      return result2;
  }
  return MatchHash(schema, base, ref);
}
function FromArray6(schema, base, ref) {
  return schema.reduce((result2, item) => {
    const match = FromValue3(item, base, ref);
    return !guard_exports.IsUndefined(match) ? match : result2;
  }, void 0);
}
function FromObject10(schema, base, ref) {
  return guard_exports.Keys(schema).reduce((result2, key) => {
    const match = FromValue3(schema[key], base, ref);
    return !guard_exports.IsUndefined(match) ? match : result2;
  }, void 0);
}
function FromValue3(schema, base, ref) {
  const nextBase = IsSchemaObject(schema) && IsId(schema) ? new URL(schema.$id, base.href) : base;
  if (IsSchemaObject(schema)) {
    const result2 = Match4(schema, nextBase, ref);
    if (!guard_exports.IsUndefined(result2))
      return result2;
  }
  if (guard_exports.IsArray(schema))
    return FromArray6(schema, nextBase, ref);
  if (guard_exports.IsObject(schema))
    return FromObject10(schema, nextBase, ref);
  return void 0;
}
function Ref2(schema, ref) {
  const defaultBase = new URL("http://unknown/");
  const initialBase = IsId(schema) ? new URL(schema.$id, defaultBase.href) : defaultBase;
  const initialRef = new URL(ref, initialBase.href);
  return FromValue3(schema, initialBase, initialRef);
}
function DynamicRef(root, base, dynamicRef, dynamicAnchors) {
  const fragmentTarget = dynamicRef.$dynamicRef.startsWith("#") ? Ref2(base, dynamicRef.$dynamicRef) : Ref2(root, dynamicRef.$dynamicRef);
  if (guard_exports.IsUndefined(fragmentTarget))
    return void 0;
  if (!IsSchemaObject(fragmentTarget) || !IsDynamicAnchor(fragmentTarget))
    return fragmentTarget;
  const fragment = new URL(dynamicRef.$dynamicRef, "http://unknown/").hash;
  if (fragment.startsWith("#/"))
    return fragmentTarget;
  const anchorTarget = dynamicAnchors.find((anchor) => anchor.$dynamicAnchor === fragmentTarget.$dynamicAnchor);
  return anchorTarget ?? fragmentTarget;
}
var init_ref5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/resolve/ref.mjs"() {
    init_guard2();
    init_pointer2();
    init_types2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/resolve/resolve.mjs
var resolve_exports = {};
__export(resolve_exports, {
  DynamicRef: () => DynamicRef,
  Ref: () => Ref2
});
var init_resolve = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/resolve/resolve.mjs"() {
    init_ref5();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/resolve/index.mjs
var init_resolve2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/resolve/index.mjs"() {
    init_resolve();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_stack.mjs
var __classPrivateFieldGet, _Stack_instances, _Stack_PushResourceAnchors, _Stack_PopResourceAnchors, _Stack_FromContext, _Stack_FromRef, Stack;
var init_stack = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/_stack.mjs"() {
    init_types2();
    init_guard2();
    init_resolve2();
    __classPrivateFieldGet = function(receiver, state, kind, f) {
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
      return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
    };
    Stack = class {
      constructor(context, schema) {
        _Stack_instances.add(this);
        this.context = context;
        this.schema = schema;
        this.ids = [];
        this.anchors = [];
        this.recursiveAnchors = [];
        this.dynamicAnchors = [];
      }
      // ----------------------------------------------------------------
      // Base
      // ----------------------------------------------------------------
      BaseURL() {
        return this.ids.reduce((result2, schema) => new URL(schema.$id, result2), new URL("http://unknown"));
      }
      Base() {
        return this.ids[this.ids.length - 1] ?? this.schema;
      }
      // ----------------------------------------------------------------
      // Stack
      // ----------------------------------------------------------------
      Push(schema) {
        if (!IsSchemaObject(schema))
          return;
        if (IsId(schema)) {
          this.ids.push(schema);
          __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_PushResourceAnchors).call(this, schema);
        }
        if (IsAnchor(schema))
          this.anchors.push(schema);
        if (IsRecursiveAnchorTrue(schema))
          this.recursiveAnchors.push(schema);
        if (IsDynamicAnchor(schema))
          this.dynamicAnchors.push(schema);
      }
      Pop(schema) {
        if (!IsSchemaObject(schema))
          return;
        if (IsId(schema)) {
          this.ids.pop();
          __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_PopResourceAnchors).call(this, schema);
        }
        if (IsAnchor(schema))
          this.anchors.pop();
        if (IsRecursiveAnchorTrue(schema))
          this.recursiveAnchors.pop();
        if (IsDynamicAnchor(schema))
          this.dynamicAnchors.pop();
      }
      Ref(ref) {
        return __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_FromContext).call(this, ref) ?? __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_FromRef).call(this, ref);
      }
      // ----------------------------------------------------------------
      // RecursiveRef
      // ----------------------------------------------------------------
      RecursiveRef(recursiveRef) {
        return IsRecursiveAnchorTrue(this.Base()) ? resolve_exports.Ref(this.recursiveAnchors[0], recursiveRef.$recursiveRef) : resolve_exports.Ref(this.Base(), recursiveRef.$recursiveRef);
      }
      // ----------------------------------------------------------------
      // DynamicRef
      // ----------------------------------------------------------------
      DynamicRef(dynamicRef) {
        const root = this.schema;
        return resolve_exports.DynamicRef(root, this.Base(), dynamicRef, this.dynamicAnchors);
      }
    };
    _Stack_instances = /* @__PURE__ */ new WeakSet(), _Stack_PushResourceAnchors = function _Stack_PushResourceAnchors2(schema, isRoot = true) {
      if (!IsSchemaObject(schema))
        return;
      const current = schema;
      if (!isRoot && IsId(current))
        return;
      if (!isRoot && IsDynamicAnchor(current))
        this.dynamicAnchors.push(current);
      for (const key of guard_exports.Keys(current))
        __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_PushResourceAnchors2).call(this, current[key], false);
    }, _Stack_PopResourceAnchors = function _Stack_PopResourceAnchors2(schema, isRoot = true) {
      if (!IsSchemaObject(schema))
        return;
      const current = schema;
      if (!isRoot && IsId(current))
        return;
      if (!isRoot && IsDynamicAnchor(current))
        this.dynamicAnchors.pop();
      for (const key of guard_exports.Keys(current))
        __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_PopResourceAnchors2).call(this, current[key], false);
    }, _Stack_FromContext = function _Stack_FromContext2(ref) {
      return guard_exports.HasPropertyKey(this.context, ref.$ref) ? this.context[ref.$ref] : void 0;
    }, _Stack_FromRef = function _Stack_FromRef2(ref) {
      const root = this.schema;
      return !ref.$ref.startsWith("#") ? resolve_exports.Ref(root, ref.$ref) : resolve_exports.Ref(this.Base(), ref.$ref);
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/index.mjs
var init_engine2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/engine/index.mjs"() {
    init_context();
    init_externals();
    init_functions();
    init_reducer();
    init_refine3();
    init_stack();
    init_additionalItems2();
    init_additionalProperties2();
    init_allOf2();
    init_anyOf2();
    init_boolean3();
    init_const3();
    init_contains2();
    init_dependencies3();
    init_dependentRequired2();
    init_dependentSchemas2();
    init_enum5();
    init_exclusiveMaximum2();
    init_exclusiveMinimum2();
    init_format4();
    init_if2();
    init_items2();
    init_maxContains2();
    init_maxItems2();
    init_maxLength2();
    init_maxProperties2();
    init_maximum2();
    init_minContains2();
    init_minItems2();
    init_minLength2();
    init_minProperties2();
    init_minimum2();
    init_multipleOf2();
    init_not2();
    init_oneOf2();
    init_pattern3();
    init_patternProperties2();
    init_prefixItems2();
    init_properties3();
    init_propertyNames2();
    init_recursiveRef2();
    init_ref4();
    init_required4();
    init_schema3();
    init_type2();
    init_unevaluatedItems2();
    init_unevaluatedProperties2();
    init_uniqueItems2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/static/index.mjs
var init_static3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/static/index.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/build.mjs
var init_build2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/build.mjs"() {
    init_arguments2();
    init_environment2();
    init_hashing();
    init_guard2();
    init_format3();
    init_engine2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/errors.mjs
function Errors(...args) {
  const [context, schema, value] = arguments_exports.Match(args, {
    3: (context2, schema2, value2) => [context2, schema2, value2],
    2: (schema2, value2) => [{}, schema2, value2]
  });
  const settings2 = settings_exports.Get();
  const locale2 = Get2();
  const errors = [];
  const stack = new Stack(context, schema);
  const errorContext = new ErrorContext((error) => {
    if (guard_exports.IsGreaterEqualThan(errors.length, settings2.maxErrors))
      return;
    return errors.push({ ...error, message: locale2(error) });
  });
  const result2 = ErrorSchema(stack, errorContext, "#", "", schema, value);
  return [result2, errors];
}
var init_errors = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/errors.mjs"() {
    init_arguments2();
    init_settings2();
    init_config();
    init_guard2();
    init_engine2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/check.mjs
function Check(...args) {
  const [context, schema, value] = arguments_exports.Match(args, {
    3: (context2, schema2, value2) => [context2, schema2, value2],
    2: (schema2, value2) => [{}, schema2, value2]
  });
  const stack = new Stack(context, schema);
  const checkContext = new CheckContext();
  return CheckSchema(stack, checkContext, schema, value);
}
var init_check2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/check.mjs"() {
    init_arguments2();
    init_engine2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/parse.mjs
var init_parse = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/parse.mjs"() {
    init_arguments2();
    init_check2();
    init_errors();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/compile.mjs
var init_compile = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/compile.mjs"() {
    init_arguments2();
    init_build2();
    init_errors();
    init_parse();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/schema.mjs
var init_schema4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/schema.mjs"() {
    init_engine2();
    init_pointer2();
    init_resolve2();
    init_static3();
    init_types2();
    init_build2();
    init_compile();
    init_check2();
    init_parse();
    init_errors();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/index.mjs
var init_schema5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/schema/index.mjs"() {
    init_schema4();
    init_schema4();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/check/check.mjs
function Check2(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return Check(context, type, value);
}
var init_check3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/check/check.mjs"() {
    init_arguments2();
    init_schema5();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/check/index.mjs
var init_check4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/check/index.mjs"() {
    init_check3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/errors/errors.mjs
function Errors2(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const [_, errors] = Errors(context, type, value);
  return errors;
}
var init_errors2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/errors/errors.mjs"() {
    init_arguments2();
    init_schema5();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/errors/index.mjs
var init_errors3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/errors/index.mjs"() {
    init_errors2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/assert/assert.mjs
function Assert(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const check = Check2(context, type, value);
  if (!check)
    throw new AssertError("Assert", value, Errors2(context, type, value));
}
var AssertError;
var init_assert = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/assert/assert.mjs"() {
    init_arguments2();
    init_check4();
    init_errors3();
    AssertError = class extends Error {
      constructor(source, value, errors) {
        super(source);
        Object.defineProperty(this, "cause", {
          value: { source, errors, value },
          writable: false,
          configurable: false,
          enumerable: false
        });
      }
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/assert/index.mjs
var init_assert2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/assert/index.mjs"() {
    init_assert();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/index.mjs
var init_type3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/type/index.mjs"() {
    init_action();
    init_engine();
    init_extends3();
    init_script2();
    init_types();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_array.mjs
function FromArray7(context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  return value.map((value2) => FromType19(context, type.items, value2));
}
var init_from_array4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_array.mjs"() {
    init_guard2();
    init_from_type11();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_cyclic.mjs
function FromCyclic6(context, type, value) {
  return FromType19({ ...context, ...type.$defs }, Ref(type.$ref), value);
}
var init_from_cyclic6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_cyclic.mjs"() {
    init_type3();
    init_from_type11();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_intersect.mjs
function EvaluateIntersection(context, type) {
  const additionalProperties = guard_exports.HasPropertyKey(type, "unevaluatedProperties") ? { additionalProperties: type.unevaluatedProperties } : {};
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return IsObject2(evaluated) ? With2(evaluated, additionalProperties) : evaluated;
}
function FromIntersect6(context, type, value) {
  const evaluated = EvaluateIntersection(context, type);
  return FromType19(context, evaluated, value);
}
var init_from_intersect6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_intersect.mjs"() {
    init_type3();
    init_guard2();
    init_from_type11();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/additional.mjs
function GetAdditionalProperties(type) {
  const additionalProperties = guard_exports.HasPropertyKey(type, "additionalProperties") ? type.additionalProperties : void 0;
  return additionalProperties;
}
var init_additional = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/additional.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_object.mjs
function FromObject11(context, type, value) {
  if (!guard_exports.IsObject(value) || guard_exports.IsArray(value))
    return value;
  const additionalProperties = GetAdditionalProperties(type);
  for (const key of guard_exports.Keys(value)) {
    if (guard_exports.HasPropertyKey(type.properties, key)) {
      value[key] = FromType19(context, type.properties[key], value[key]);
      continue;
    }
    const unknownCheck = (
      // 1. additionalProperties: true
      guard_exports.IsBoolean(additionalProperties) && guard_exports.IsEqual(additionalProperties, true) || IsSchema(additionalProperties) && Check2(context, additionalProperties, value[key])
    );
    if (unknownCheck) {
      value[key] = FromType19(context, additionalProperties, value[key]);
      continue;
    }
    delete value[key];
  }
  return value;
}
var init_from_object7 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_object.mjs"() {
    init_type3();
    init_guard2();
    init_from_type11();
    init_check4();
    init_additional();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_record.mjs
function FromRecord3(context, type, value) {
  if (!guard_exports.IsObject(value))
    return value;
  const additionalProperties = GetAdditionalProperties(type);
  const [recordPattern, recordValue] = [new RegExp(RecordPattern(type)), RecordValue(type)];
  for (const key of guard_exports.Keys(value)) {
    if (recordPattern.test(key)) {
      value[key] = FromType19(context, recordValue, value[key]);
      continue;
    }
    const unknownCheck = (
      // 1. additionalProperties: true
      guard_exports.IsBoolean(additionalProperties) && guard_exports.IsEqual(additionalProperties, true) || IsSchema(additionalProperties) && Check2(context, additionalProperties, value[key])
    );
    if (unknownCheck) {
      value[key] = FromType19(context, additionalProperties, value[key]);
      continue;
    }
    delete value[key];
  }
  return value;
}
var init_from_record2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_record.mjs"() {
    init_type3();
    init_guard2();
    init_from_type11();
    init_check4();
    init_additional();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_ref.mjs
function FromRef5(context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType19(context, context[type.$ref], value) : value;
}
var init_from_ref = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_ref.mjs"() {
    init_guard2();
    init_from_type11();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_tuple.mjs
function FromTuple5(context, schema, value) {
  if (!guard_exports.IsArray(value))
    return value;
  const length = Math.min(value.length, schema.items.length);
  for (let index = 0; index < length; index++) {
    value[index] = FromType19(context, schema.items[index], value[index]);
  }
  return guard_exports.IsGreaterThan(value.length, length) ? value.slice(0, length) : value;
}
var init_from_tuple5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_tuple.mjs"() {
    init_guard2();
    init_from_type11();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clone/clone.mjs
function Clone2(value) {
  return Clone(value);
}
var init_clone2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clone/clone.mjs"() {
    init_clone();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clone/index.mjs
var init_clone3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clone/index.mjs"() {
    init_clone2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_union.mjs
function FromUnion9(context, type, value) {
  for (const schema of type.anyOf) {
    const clean = FromType19(context, schema, Clone2(value));
    if (Check2(context, schema, clean))
      return clean;
  }
  return value;
}
var init_from_union7 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_union.mjs"() {
    init_check4();
    init_clone3();
    init_from_type11();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_type.mjs
function FromType19(context, type, value) {
  return IsArray2(type) ? FromArray7(context, type, value) : IsCyclic(type) ? FromCyclic6(context, type, value) : IsIntersect(type) ? FromIntersect6(context, type, value) : IsObject2(type) ? FromObject11(context, type, value) : IsRecord(type) ? FromRecord3(context, type, value) : IsRef(type) ? FromRef5(context, type, value) : IsTuple(type) ? FromTuple5(context, type, value) : IsUnion(type) ? FromUnion9(context, type, value) : value;
}
var init_from_type11 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/from_type.mjs"() {
    init_type3();
    init_from_array4();
    init_from_cyclic6();
    init_from_intersect6();
    init_from_object7();
    init_from_record2();
    init_from_ref();
    init_from_tuple5();
    init_from_union7();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/shared/union_priority_sort.mjs
function Modifiers(type, next) {
  for (const key of guard_default.Keys(type)) {
    if (guard_default.HasPropertyKey(next, key))
      continue;
    next[key] = type[key];
  }
  return next;
}
function FromProperties4(properties) {
  const result2 = {};
  for (const key of guard_default.Keys(properties))
    result2[key] = FromType20(properties[key]);
  return result2;
}
function FromPriorityTypes(types) {
  return FromTypes6(Priority(types));
}
function FromTypes6(types) {
  return types.map((type) => FromType20(type));
}
function FromType20(type) {
  const next = IsArray2(type) ? _Array_(FromType20(type.items), ArrayOptions(type)) : IsIntersect(type) ? Intersect(FromTypes6(type.allOf)) : IsUnion(type) ? Union(FromPriorityTypes(type.anyOf)) : IsObject2(type) ? _Object_(FromProperties4(type.properties)) : IsRecord(type) ? Record(RecordKey(type), FromType20(RecordValue(type))) : IsTuple(type) ? Tuple(FromTypes6(type.items)) : type;
  return Modifiers(type, next);
}
function UnionPrioritySort(type) {
  const result2 = FromType20(type);
  return result2;
}
var init_union_priority_sort = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/shared/union_priority_sort.mjs"() {
    init_guard2();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/clean.mjs
function Clean(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const sorted = settings_exports.Get().unionPrioritySort ? UnionPrioritySort(type) : type;
  return FromType19(context, sorted, value);
}
var init_clean = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/clean.mjs"() {
    init_system2();
    init_from_type11();
    init_union_priority_sort();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/index.mjs
var init_clean2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/clean/index.mjs"() {
    init_clean();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_result.mjs
function IsOk(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "value");
}
function Ok(value) {
  return { value };
}
function Fail() {
  return void 0;
}
var init_try_result = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_result.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_array.mjs
function TryArray(value) {
  return guard_exports.IsArray(value) ? Ok(value) : Ok([value]);
}
var init_try_array = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_array.mjs"() {
    init_guard2();
    init_try_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_bigint.mjs
function FromBoolean2(value) {
  return guard_exports.IsEqual(value, true) ? Ok(BigInt(1)) : Ok(BigInt(0));
}
function IsStringBigIntLike(value) {
  return bigintPattern.test(value);
}
function IsStringDecimalLike(value) {
  return decimalPattern.test(value);
}
function IsStringIntegerLike(value) {
  return integerPattern.test(value);
}
function FromString2(value) {
  const lowercase = value.toLowerCase();
  return IsStringBigIntLike(value) ? Ok(BigInt(value.slice(0, value.length - 1))) : IsStringDecimalLike(value) ? Ok(BigInt(value.split(".")[0])) : IsStringIntegerLike(value) ? Ok(BigInt(value)) : guard_exports.IsEqual(lowercase, "false") ? Ok(BigInt(0)) : guard_exports.IsEqual(lowercase, "true") ? Ok(BigInt(1)) : Fail();
}
function TryBigInt(value) {
  return guard_exports.IsBigInt(value) ? Ok(value) : guard_exports.IsBoolean(value) ? FromBoolean2(value) : guard_exports.IsNumber(value) ? Ok(BigInt(Math.trunc(value))) : guard_exports.IsNull(value) ? Ok(BigInt(0)) : guard_exports.IsString(value) ? FromString2(value) : guard_exports.IsUndefined(value) ? Ok(BigInt(0)) : Fail();
}
var bigintPattern, decimalPattern, integerPattern;
var init_try_bigint = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_bigint.mjs"() {
    init_guard2();
    init_try_result();
    bigintPattern = /^-?(0|[1-9]\d*)n$/;
    decimalPattern = /^-?(0|[1-9]\d*)\.\d+$/;
    integerPattern = /^-?(0|[1-9]\d*)$/;
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_boolean.mjs
function FromBigInt2(value) {
  return guard_exports.IsEqual(value, BigInt(0)) ? Ok(false) : guard_exports.IsEqual(value, BigInt(1)) ? Ok(true) : Fail();
}
function FromNumber2(value) {
  return guard_exports.IsEqual(value, 0) ? Ok(false) : guard_exports.IsEqual(value, 1) ? Ok(true) : Fail();
}
function FromString3(value) {
  return guard_exports.IsEqual(value.toLowerCase(), "false") ? Ok(false) : guard_exports.IsEqual(value.toLowerCase(), "true") ? Ok(true) : guard_exports.IsEqual(value, "0") ? Ok(false) : guard_exports.IsEqual(value, "1") ? Ok(true) : Fail();
}
function TryBoolean(value) {
  return guard_exports.IsBigInt(value) ? FromBigInt2(value) : guard_exports.IsBoolean(value) ? Ok(value) : guard_exports.IsNumber(value) ? FromNumber2(value) : guard_exports.IsNull(value) ? Ok(false) : guard_exports.IsString(value) ? FromString3(value) : guard_exports.IsUndefined(value) ? Ok(false) : Fail();
}
var init_try_boolean = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_boolean.mjs"() {
    init_guard2();
    init_try_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_null.mjs
function FromBigInt3(value) {
  return guard_exports.IsEqual(value, BigInt(0)) ? Ok(null) : Fail();
}
function FromBoolean3(value) {
  return guard_exports.IsEqual(value, false) ? Ok(null) : Fail();
}
function FromNumber3(value) {
  return guard_exports.IsEqual(value, 0) ? Ok(null) : Fail();
}
function FromString4(value) {
  const lowercase = value.toLowerCase();
  const predicate = guard_exports.IsEqual(lowercase, "undefined") || guard_exports.IsEqual(lowercase, "null") || guard_exports.IsEqual(value, "") || guard_exports.IsEqual(value, "0");
  return predicate ? Ok(null) : Fail();
}
function TryNull(value) {
  return guard_exports.IsBigInt(value) ? FromBigInt3(value) : guard_exports.IsBoolean(value) ? FromBoolean3(value) : guard_exports.IsNumber(value) ? FromNumber3(value) : guard_exports.IsNull(value) ? Ok(null) : guard_exports.IsString(value) ? FromString4(value) : guard_exports.IsUndefined(value) ? Ok(null) : Fail();
}
var init_try_null = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_null.mjs"() {
    init_guard2();
    init_try_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_number.mjs
function FromBigInt4(value) {
  return value <= maxBigInt && value >= minBigInt ? Ok(Number(value)) : Fail();
}
function FromBoolean4(value) {
  return Ok(value ? 1 : 0);
}
function FromString5(value) {
  const coerced = +value;
  if (guard_exports.IsNumber(coerced))
    return Ok(coerced);
  const lowercase = value.toLowerCase();
  if (guard_exports.IsEqual(lowercase, "false"))
    return Ok(0);
  if (guard_exports.IsEqual(lowercase, "true"))
    return Ok(1);
  const result2 = TryBigInt(value);
  if (IsOk(result2))
    return result2.value <= maxBigInt && result2.value >= minBigInt ? Ok(Number(result2.value)) : Fail();
  return Fail();
}
function TryNumber(value) {
  return guard_exports.IsBigInt(value) ? FromBigInt4(value) : guard_exports.IsBoolean(value) ? FromBoolean4(value) : guard_exports.IsNumber(value) ? Ok(value) : guard_exports.IsNull(value) ? Ok(0) : guard_exports.IsString(value) ? FromString5(value) : guard_exports.IsUndefined(value) ? Ok(0) : Fail();
}
var maxBigInt, minBigInt;
var init_try_number = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_number.mjs"() {
    init_guard2();
    init_try_result();
    init_try_bigint();
    maxBigInt = BigInt(Number.MAX_SAFE_INTEGER);
    minBigInt = BigInt(Number.MIN_SAFE_INTEGER);
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_string.mjs
function TryString(value) {
  return guard_exports.IsBigInt(value) ? Ok(value.toString()) : guard_exports.IsBoolean(value) ? Ok(value.toString()) : guard_exports.IsNumber(value) ? Ok(value.toString()) : guard_exports.IsNull(value) ? Ok("null") : guard_exports.IsString(value) ? Ok(value) : guard_exports.IsUndefined(value) ? Ok("") : Fail();
}
var init_try_string = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_string.mjs"() {
    init_guard2();
    init_try_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_undefined.mjs
function FromBigInt5(value) {
  return guard_exports.IsEqual(value, BigInt(0)) ? Ok(void 0) : Fail();
}
function FromBoolean5(value) {
  return guard_exports.IsEqual(value, false) ? Ok(void 0) : Fail();
}
function FromNumber4(value) {
  return guard_exports.IsEqual(value, 0) ? Ok(void 0) : Fail();
}
function FromString6(value) {
  const lowercase = value.toLowerCase();
  const predicate = guard_exports.IsEqual(lowercase, "undefined") || guard_exports.IsEqual(lowercase, "null") || guard_exports.IsEqual(value, "") || guard_exports.IsEqual(value, "0");
  return predicate ? Ok(void 0) : Fail();
}
function TryUndefined(value) {
  return guard_exports.IsBigInt(value) ? FromBigInt5(value) : guard_exports.IsBoolean(value) ? FromBoolean5(value) : guard_exports.IsNumber(value) ? FromNumber4(value) : guard_exports.IsNull(value) ? Ok(void 0) : guard_exports.IsString(value) ? FromString6(value) : guard_exports.IsUndefined(value) ? Ok(value) : Fail();
}
var init_try_undefined = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try_undefined.mjs"() {
    init_guard2();
    init_try_result();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try.mjs
var try_exports = {};
__export(try_exports, {
  Fail: () => Fail,
  IsOk: () => IsOk,
  Ok: () => Ok,
  TryArray: () => TryArray,
  TryBigInt: () => TryBigInt,
  TryBoolean: () => TryBoolean,
  TryNull: () => TryNull,
  TryNumber: () => TryNumber,
  TryString: () => TryString,
  TryUndefined: () => TryUndefined
});
var init_try = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/try.mjs"() {
    init_try_array();
    init_try_bigint();
    init_try_boolean();
    init_try_null();
    init_try_number();
    init_try_result();
    init_try_string();
    init_try_undefined();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/index.mjs
var init_try2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/try/index.mjs"() {
    init_try();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_array.mjs
function FromArray8(context, type, value) {
  const result2 = try_exports.TryArray(value);
  return result2.value.map((value2) => FromType21(context, type.items, value2));
}
var init_from_array5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_array.mjs"() {
    init_from_type12();
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_bigint.mjs
function FromBigInt6(_context, _type, value) {
  const result2 = try_exports.TryBigInt(value);
  return try_exports.IsOk(result2) ? result2.value : value;
}
var init_from_bigint = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_bigint.mjs"() {
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_boolean.mjs
function FromBoolean6(_context, _type, value) {
  const result2 = try_exports.TryBoolean(value);
  return try_exports.IsOk(result2) ? result2.value : value;
}
var init_from_boolean = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_boolean.mjs"() {
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_cyclic.mjs
function FromCyclic7(context, type, value) {
  return FromType21({ ...context, ...type.$defs }, Ref(type.$ref), value);
}
var init_from_cyclic7 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_cyclic.mjs"() {
    init_type3();
    init_from_type12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_enum.mjs
function FromEnum3(context, type, value) {
  return FromType21(context, Evaluate(type), value);
}
var init_from_enum2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_enum.mjs"() {
    init_type3();
    init_from_type12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_integer.mjs
function FromInteger(_context, _type, value) {
  const result2 = try_exports.TryNumber(value);
  return try_exports.IsOk(result2) ? Math.trunc(result2.value) : value;
}
var init_from_integer = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_integer.mjs"() {
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_intersect.mjs
function FromIntersect7(context, type, value) {
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return FromType21(context, evaluated, value);
}
var init_from_intersect7 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_intersect.mjs"() {
    init_type3();
    init_from_type12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_literal.mjs
function FromLiteralBigInt(_context, type, value) {
  const result2 = try_exports.TryBigInt(value);
  return try_exports.IsOk(result2) && guard_exports.IsEqual(type.const, result2.value) ? result2.value : value;
}
function FromLiteralBoolean(_context, type, value) {
  const result2 = try_exports.TryBoolean(value);
  return try_exports.IsOk(result2) && guard_exports.IsEqual(type.const, result2.value) ? result2.value : value;
}
function FromLiteralNumber(_context, type, value) {
  const result2 = try_exports.TryNumber(value);
  return try_exports.IsOk(result2) && guard_exports.IsEqual(type.const, result2.value) ? result2.value : value;
}
function FromLiteralString(_context, type, value) {
  const result2 = try_exports.TryString(value);
  return try_exports.IsOk(result2) && guard_exports.IsEqual(type.const, result2.value) ? result2.value : value;
}
function FromLiteral6(context, type, value) {
  if (guard_exports.IsEqual(type.const, value))
    return value;
  return IsLiteralBigInt(type) ? FromLiteralBigInt(context, type, value) : IsLiteralBoolean(type) ? FromLiteralBoolean(context, type, value) : IsLiteralNumber(type) ? FromLiteralNumber(context, type, value) : IsLiteralString(type) ? FromLiteralString(context, type, value) : Unreachable();
}
var init_from_literal3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_literal.mjs"() {
    init_unreachable2();
    init_guard2();
    init_type3();
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_null.mjs
function FromNull2(_context, _type, value) {
  const result2 = try_exports.TryNull(value);
  return try_exports.IsOk(result2) ? result2.value : value;
}
var init_from_null = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_null.mjs"() {
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_number.mjs
function FromNumber5(_context, _type, value) {
  const result2 = try_exports.TryNumber(value);
  return try_exports.IsOk(result2) ? result2.value : value;
}
var init_from_number = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_number.mjs"() {
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_additional.mjs
function FromAdditionalProperties(context, entries, additionalProperties, value) {
  const keys = guard_exports.Keys(value);
  for (const [regexp, _] of entries) {
    for (const key of keys) {
      if (!regexp.test(key)) {
        value[key] = FromType21(context, additionalProperties, value[key]);
      }
    }
  }
  return value;
}
var init_from_additional = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_additional.mjs"() {
    init_guard2();
    init_from_type12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/shared/optional_undefined.mjs
function IsOptionalUndefined(property, key, value) {
  return IsOptional(property) && guard_exports.IsUndefined(value[key]);
}
var init_optional_undefined = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/shared/optional_undefined.mjs"() {
    init_guard2();
    init_type3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_object.mjs
function FromProperties5(context, type, value) {
  const entries = guard_exports.EntriesRegExp(type.properties);
  const keys = guard_exports.Keys(value);
  for (const [regexp, property] of entries) {
    for (const key of keys) {
      if (!regexp.test(key) || IsOptionalUndefined(property, key, value))
        continue;
      value[key] = FromType21(context, property, value[key]);
    }
  }
  return guard_exports.HasPropertyKey(type, "additionalProperties") && guard_exports.IsObject(type.additionalProperties) ? FromAdditionalProperties(context, entries, type.additionalProperties, value) : value;
}
function FromObject12(context, type, value) {
  return guard_exports.IsObjectNotArray(value) ? FromProperties5(context, type, value) : value;
}
var init_from_object8 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_object.mjs"() {
    init_guard2();
    init_from_type12();
    init_from_additional();
    init_optional_undefined();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_record.mjs
function FromPatternProperties(context, type, value) {
  const entries = guard_exports.EntriesRegExp(type.patternProperties);
  const keys = guard_exports.Keys(value);
  for (const [regexp, schema] of entries) {
    for (const key of keys) {
      if (regexp.test(key)) {
        value[key] = FromType21(context, schema, value[key]);
      }
    }
  }
  return guard_exports.HasPropertyKey(type, "additionalProperties") && guard_exports.IsObject(type.additionalProperties) ? FromAdditionalProperties(context, entries, type.additionalProperties, value) : value;
}
function FromRecord4(context, type, value) {
  return guard_exports.IsObjectNotArray(value) ? FromPatternProperties(context, type, value) : value;
}
var init_from_record3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_record.mjs"() {
    init_guard2();
    init_from_type12();
    init_from_additional();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_ref.mjs
function FromRef6(context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType21(context, context[type.$ref], value) : value;
}
var init_from_ref2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_ref.mjs"() {
    init_from_type12();
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_string.mjs
function FromString7(_context, _type, value) {
  const result2 = try_exports.TryString(value);
  return try_exports.IsOk(result2) ? result2.value : value;
}
var init_from_string = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_string.mjs"() {
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_template_literal.mjs
function FromTemplateLiteral4(context, type, value) {
  return FromType21(context, Evaluate(type), value);
}
var init_from_template_literal3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_template_literal.mjs"() {
    init_type3();
    init_from_type12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_tuple.mjs
function FromTuple6(context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  for (let index = 0; index < Math.min(type.items.length, value.length); index++) {
    value[index] = FromType21(context, type.items[index], value[index]);
  }
  return value;
}
var init_from_tuple6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_tuple.mjs"() {
    init_guard2();
    init_from_type12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_undefined.mjs
function FromUndefined2(_context, _type, value) {
  const result2 = try_exports.TryUndefined(value);
  return try_exports.IsOk(result2) ? result2.value : value;
}
var init_from_undefined = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_undefined.mjs"() {
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_union.mjs
function FromUnion10(context, type, value) {
  const matched = type.anyOf.some((type2) => Check2(context, type2, value));
  if (matched)
    return value;
  const candidates = type.anyOf.map((type2) => FromType21(context, type2, Clone2(value)));
  const selected = candidates.find((value2) => Check2(context, type, value2));
  return guard_exports.IsUndefined(selected) ? value : selected;
}
var init_from_union8 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_union.mjs"() {
    init_guard2();
    init_check4();
    init_clone3();
    init_from_type12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_void.mjs
function FromVoid(_context, _type, value) {
  const result2 = try_exports.TryUndefined(value);
  return try_exports.IsOk(result2) ? void 0 : value;
}
var init_from_void = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_void.mjs"() {
    init_try2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_type.mjs
function FromType21(context, type, value) {
  return IsArray2(type) ? FromArray8(context, type, value) : IsBigInt2(type) ? FromBigInt6(context, type, value) : IsBoolean3(type) ? FromBoolean6(context, type, value) : IsCyclic(type) ? FromCyclic7(context, type, value) : IsEnum(type) ? FromEnum3(context, type, value) : IsInteger2(type) ? FromInteger(context, type, value) : IsIntersect(type) ? FromIntersect7(context, type, value) : IsLiteral(type) ? FromLiteral6(context, type, value) : IsNull2(type) ? FromNull2(context, type, value) : IsNumber3(type) ? FromNumber5(context, type, value) : IsObject2(type) ? FromObject12(context, type, value) : IsRecord(type) ? FromRecord4(context, type, value) : IsRef(type) ? FromRef6(context, type, value) : IsString3(type) ? FromString7(context, type, value) : IsTemplateLiteral(type) ? FromTemplateLiteral4(context, type, value) : IsTuple(type) ? FromTuple6(context, type, value) : IsUndefined2(type) ? FromUndefined2(context, type, value) : IsUnion(type) ? FromUnion10(context, type, value) : IsVoid(type) ? FromVoid(context, type, value) : value;
}
var init_from_type12 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/from_type.mjs"() {
    init_type3();
    init_from_array5();
    init_from_bigint();
    init_from_boolean();
    init_from_cyclic7();
    init_from_enum2();
    init_from_integer();
    init_from_intersect7();
    init_from_literal3();
    init_from_null();
    init_from_number();
    init_from_object8();
    init_from_record3();
    init_from_ref2();
    init_from_string();
    init_from_template_literal3();
    init_from_tuple6();
    init_from_undefined();
    init_from_union8();
    init_from_void();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/convert.mjs
function Convert(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return FromType21(context, type, value);
}
var init_convert = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/convert.mjs"() {
    init_arguments2();
    init_from_type12();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/index.mjs
var init_convert2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/convert/index.mjs"() {
    init_convert();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_array.mjs
function FromArray9(context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  for (let i = 0; i < value.length; i++) {
    value[i] = FromType22(context, type.items, value[i]);
  }
  return value;
}
var init_from_array6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_array.mjs"() {
    init_guard2();
    init_from_type13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_cyclic.mjs
function FromCyclic8(context, type, value) {
  return FromType22({ ...context, ...type.$defs }, Ref(type.$ref), value);
}
var init_from_cyclic8 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_cyclic.mjs"() {
    init_type3();
    init_from_type13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_default.mjs
function FromDefault(type, value) {
  if (!guard_exports.IsUndefined(value))
    return value;
  return guard_exports.IsFunction(type.default) ? type.default() : Clone2(type.default);
}
var init_from_default = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_default.mjs"() {
    init_guard2();
    init_clone3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_intersect.mjs
function FromIntersect8(context, type, value) {
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return FromType22(context, evaluated, value);
}
var init_from_intersect8 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_intersect.mjs"() {
    init_type3();
    init_from_type13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_object.mjs
function FromObject13(context, type, value) {
  if (!guard_exports.IsObject(value))
    return value;
  const knownPropertyKeys = guard_exports.Keys(type.properties);
  for (const key of knownPropertyKeys) {
    const propertyValue = FromType22(context, type.properties[key], value[key]);
    const isUnassignableUndefined = guard_exports.IsUndefined(propertyValue) && (IsOptional(type.properties[key]) || !guard_exports.HasPropertyKey(type.properties[key], "default"));
    if (isUnassignableUndefined)
      continue;
    value[key] = propertyValue;
  }
  if (!IsAdditionalProperties(type) || guard_exports.IsBoolean(type.additionalProperties))
    return value;
  for (const key of guard_exports.Keys(value)) {
    if (knownPropertyKeys.includes(key))
      continue;
    value[key] = FromType22(context, type.additionalProperties, value[key]);
  }
  return value;
}
var init_from_object9 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_object.mjs"() {
    init_type3();
    init_guard2();
    init_from_type13();
    init_types2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_record.mjs
function FromRecord5(context, type, value) {
  if (!guard_exports.IsObject(value))
    return value;
  const [recordKey, recordValue] = [new RegExp(RecordPattern(type)), RecordValue(type)];
  for (const key of guard_exports.Keys(value)) {
    if (!(recordKey.test(key) && IsDefault(recordValue)))
      continue;
    value[key] = FromType22(context, recordValue, value[key]);
  }
  if (!IsAdditionalProperties(type))
    return value;
  for (const key of guard_exports.Keys(value)) {
    if (recordKey.test(key))
      continue;
    value[key] = FromType22(context, type.additionalProperties, value[key]);
  }
  return value;
}
var init_from_record4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_record.mjs"() {
    init_type3();
    init_types2();
    init_guard2();
    init_from_type13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_ref.mjs
function FromRef7(context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType22(context, context[type.$ref], value) : value;
}
var init_from_ref3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_ref.mjs"() {
    init_guard2();
    init_from_type13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_tuple.mjs
function FromTuple7(context, schema, value) {
  if (!guard_exports.IsArray(value))
    return value;
  const [items, max] = [schema.items, Math.max(schema.items.length, value.length)];
  for (let i = 0; i < max; i++) {
    if (i < items.length)
      value[i] = FromType22(context, items[i], value[i]);
  }
  return value;
}
var init_from_tuple7 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_tuple.mjs"() {
    init_guard2();
    init_from_type13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_union.mjs
function FromUnion11(context, schema, value) {
  for (const inner of schema.anyOf) {
    const result2 = FromType22(context, inner, Clone2(value));
    if (Check2(context, inner, result2)) {
      return result2;
    }
  }
  return value;
}
var init_from_union9 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_union.mjs"() {
    init_check4();
    init_clone3();
    init_from_type13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_type.mjs
function FromType22(context, type, value) {
  const defaulted = IsDefault(type) ? FromDefault(type, value) : value;
  return IsArray2(type) ? FromArray9(context, type, defaulted) : IsCyclic(type) ? FromCyclic8(context, type, defaulted) : IsIntersect(type) ? FromIntersect8(context, type, defaulted) : IsObject2(type) ? FromObject13(context, type, defaulted) : IsRecord(type) ? FromRecord5(context, type, defaulted) : IsRef(type) ? FromRef7(context, type, defaulted) : IsTuple(type) ? FromTuple7(context, type, defaulted) : IsUnion(type) ? FromUnion11(context, type, defaulted) : defaulted;
}
var init_from_type13 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/from_type.mjs"() {
    init_schema5();
    init_type3();
    init_from_array6();
    init_from_cyclic8();
    init_from_default();
    init_from_intersect8();
    init_from_object9();
    init_from_record4();
    init_from_ref3();
    init_from_tuple7();
    init_from_union9();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/default.mjs
function Default(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return FromType22(context, type, value);
}
var init_default2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/default.mjs"() {
    init_arguments2();
    init_from_type13();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/index.mjs
var init_default3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/default/index.mjs"() {
    init_default2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/pipeline/pipeline.mjs
function Pipeline(pipeline) {
  return (...args) => {
    const [context, type, value] = arguments_exports.Match(args, {
      3: (context2, type2, value2) => [context2, type2, value2],
      2: (type2, value2) => [{}, type2, value2]
    });
    return pipeline.reduce((result2, func) => func(context, type, result2), value);
  };
}
var init_pipeline = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/pipeline/pipeline.mjs"() {
    init_arguments2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/pipeline/index.mjs
var init_pipeline2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/pipeline/index.mjs"() {
    init_pipeline();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/callback.mjs
function Decode3(_context, type, value) {
  return type["~codec"].decode(value);
}
function Encode2(_context, type, value) {
  return type["~codec"].encode(value);
}
function Callback(direction, context, type, value) {
  if (!IsCodec(type))
    return value;
  return guard_exports.IsEqual(direction, "Decode") ? Decode3(context, type, value) : Encode2(context, type, value);
}
var init_callback = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/callback.mjs"() {
    init_guard2();
    init_type3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_array.mjs
function Decode4(direction, context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  for (let i = 0; i < value.length; i++) {
    value[i] = FromType23(direction, context, type.items, value[i]);
  }
  return Callback(direction, context, type, value);
}
function Encode3(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  if (!guard_exports.IsArray(exterior))
    return exterior;
  for (let i = 0; i < exterior.length; i++) {
    exterior[i] = FromType23(direction, context, type.items, exterior[i]);
  }
  return exterior;
}
function FromArray10(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode4(direction, context, type, value) : Encode3(direction, context, type, value);
}
var init_from_array7 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_array.mjs"() {
    init_guard2();
    init_from_type14();
    init_callback();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_cyclic.mjs
function FromCyclic9(direction, context, type, value) {
  value = FromType23(direction, { ...context, ...type.$defs }, Ref(type.$ref), value);
  return Callback(direction, context, type, value);
}
var init_from_cyclic9 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_cyclic.mjs"() {
    init_type3();
    init_from_type14();
    init_callback();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_intersect.mjs
function MergeInteriors(interiors) {
  return interiors.reduce((results, interior) => ({ ...results, ...interior }), {});
}
function NonMatchingInterior(value, interiors) {
  for (const interior of interiors)
    if (!guard_exports.IsDeepEqual(value, interior))
      return interior;
  return value;
}
function Decode5(direction, context, type, value) {
  if (guard_exports.IsEqual(type.allOf.length, 0))
    return Callback(direction, context, type, value);
  const interiors = type.allOf.map((schema) => FromType23(direction, context, schema, Clean(schema, Clone2(value))));
  const structural = interiors.every((result2) => guard_exports.IsObject(result2));
  const exterior = structural ? MergeInteriors(interiors) : NonMatchingInterior(value, interiors);
  return Callback(direction, context, type, exterior);
}
function Encode4(direction, context, type, value) {
  if (guard_exports.IsEqual(type.allOf.length, 0))
    return Callback(direction, context, type, value);
  const exterior = Callback(direction, context, type, value);
  const interiors = type.allOf.map((schema) => FromType23(direction, context, schema, Clean(schema, Clone2(exterior))));
  const structural = interiors.every((result2) => guard_exports.IsObject(result2));
  if (structural)
    return MergeInteriors(interiors);
  return NonMatchingInterior(exterior, interiors);
}
function FromIntersect9(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode5(direction, context, type, value) : Encode4(direction, context, type, value);
}
var init_from_intersect9 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_intersect.mjs"() {
    init_guard2();
    init_from_type14();
    init_callback();
    init_clone3();
    init_clean2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_object.mjs
function Decode6(direction, context, type, value) {
  if (!guard_exports.IsObjectNotArray(value))
    return value;
  for (const key of guard_exports.Keys(type.properties)) {
    if (!guard_exports.HasPropertyKey(value, key) || IsOptionalUndefined(type.properties[key], key, value))
      continue;
    value[key] = FromType23(direction, context, type.properties[key], value[key]);
  }
  return Callback(direction, context, type, value);
}
function Encode5(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  if (!guard_exports.IsObjectNotArray(exterior))
    return exterior;
  for (const key of guard_exports.Keys(type.properties)) {
    if (!guard_exports.HasPropertyKey(exterior, key) || IsOptionalUndefined(type.properties[key], key, exterior))
      continue;
    exterior[key] = FromType23(direction, context, type.properties[key], exterior[key]);
  }
  return exterior;
}
function FromObject14(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode6(direction, context, type, value) : Encode5(direction, context, type, value);
}
var init_from_object10 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_object.mjs"() {
    init_guard2();
    init_from_type14();
    init_callback();
    init_optional_undefined();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_record.mjs
function Decode7(direction, context, type, value) {
  if (!guard_exports.IsObjectNotArray(value))
    return value;
  const regexp = new RegExp(RecordPattern(type));
  for (const key of guard_exports.Keys(value)) {
    if (!regexp.test(key))
      continue;
    value[key] = FromType23(direction, context, RecordValue(type), value[key]);
  }
  return Callback(direction, context, type, value);
}
function Encode6(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  if (!guard_exports.IsObjectNotArray(exterior))
    return exterior;
  const regexp = new RegExp(RecordPattern(type));
  for (const key of guard_exports.Keys(exterior)) {
    if (!regexp.test(key))
      continue;
    exterior[key] = FromType23(direction, context, RecordValue(type), exterior[key]);
  }
  return exterior;
}
function FromRecord6(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode7(direction, context, type, value) : Encode6(direction, context, type, value);
}
var init_from_record5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_record.mjs"() {
    init_guard2();
    init_type3();
    init_from_type14();
    init_callback();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_ref.mjs
function ResolveRef(direction, context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType23(direction, context, context[type.$ref], value) : value;
}
function FromRef8(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Callback(direction, context, type, ResolveRef(direction, context, type, value)) : ResolveRef(direction, context, type, Callback(direction, context, type, value));
}
var init_from_ref4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_ref.mjs"() {
    init_guard2();
    init_from_type14();
    init_callback();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_tuple.mjs
function Decode8(direction, context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  for (let i = 0; i < Math.min(type.items.length, value.length); i++) {
    value[i] = FromType23(direction, context, type.items[i], value[i]);
  }
  return Callback(direction, context, type, value);
}
function Encode7(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  if (!guard_exports.IsArray(exterior))
    return value;
  for (let i = 0; i < Math.min(type.items.length, exterior.length); i++) {
    exterior[i] = FromType23(direction, context, type.items[i], exterior[i]);
  }
  return exterior;
}
function FromTuple8(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode8(direction, context, type, value) : Encode7(direction, context, type, value);
}
var init_from_tuple8 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_tuple.mjs"() {
    init_guard2();
    init_from_type14();
    init_callback();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_union.mjs
function Decode9(direction, context, type, value) {
  for (const schema of type.anyOf) {
    if (!Check2(context, schema, value))
      continue;
    const variant = FromType23(direction, context, schema, value);
    return Callback(direction, context, type, variant);
  }
  return value;
}
function Encode8(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  for (const schema of type.anyOf) {
    const variant = FromType23(direction, context, schema, Clone2(exterior));
    if (!Check2(context, schema, variant))
      continue;
    return variant;
  }
  return exterior;
}
function FromUnion12(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode9(direction, context, type, value) : Encode8(direction, context, type, value);
}
var init_from_union10 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_union.mjs"() {
    init_guard2();
    init_callback();
    init_from_type14();
    init_clone3();
    init_check4();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_type.mjs
function FromType23(direction, context, type, value) {
  return IsArray2(type) ? FromArray10(direction, context, type, value) : IsCyclic(type) ? FromCyclic9(direction, context, type, value) : IsIntersect(type) ? FromIntersect9(direction, context, type, value) : IsObject2(type) ? FromObject14(direction, context, type, value) : IsRecord(type) ? FromRecord6(direction, context, type, value) : IsRef(type) ? FromRef8(direction, context, type, value) : IsTuple(type) ? FromTuple8(direction, context, type, value) : IsUnion(type) ? FromUnion12(direction, context, type, value) : Callback(direction, context, type, value);
}
var init_from_type14 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/from_type.mjs"() {
    init_type3();
    init_from_array7();
    init_from_cyclic9();
    init_from_intersect9();
    init_from_object10();
    init_from_record5();
    init_from_ref4();
    init_from_tuple8();
    init_from_union10();
    init_callback();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/decode.mjs
function Assert2(context, type, value) {
  if (!Check2(context, type, value))
    throw new DecodeError(value, Errors2(context, type, value));
  return value;
}
function DecodeUnsafe(context, type, value) {
  const sorted = settings_exports.Get().unionPrioritySort ? UnionPrioritySort(type) : type;
  return FromType23("Decode", context, sorted, value);
}
function Decode10(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return Decoder(context, type, value);
}
var DecodeError, Decoder;
var init_decode2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/decode.mjs"() {
    init_system2();
    init_assert2();
    init_check4();
    init_errors3();
    init_clean2();
    init_clone3();
    init_convert2();
    init_default3();
    init_pipeline2();
    init_from_type14();
    init_union_priority_sort();
    DecodeError = class extends AssertError {
      constructor(value, errors) {
        super("Decode", value, errors);
      }
    };
    Decoder = Pipeline([
      (_context, _type, value) => Clone2(value),
      (context, type, value) => Default(context, type, value),
      (context, type, value) => Convert(context, type, value),
      (context, type, value) => Clean(context, type, value),
      (context, type, value) => Assert2(context, type, value),
      (context, type, value) => DecodeUnsafe(context, type, value)
    ]);
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/encode.mjs
function Assert3(context, type, value) {
  if (!Check2(context, type, value))
    throw new EncodeError(value, Errors2(context, type, value));
  return value;
}
function EncodeUnsafe(context, type, value) {
  const sorted = settings_exports.Get().unionPrioritySort ? UnionPrioritySort(type) : type;
  return FromType23("Encode", context, sorted, value);
}
function Encode9(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return Encoder(context, type, value);
}
var EncodeError, Encoder;
var init_encode2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/encode.mjs"() {
    init_system2();
    init_assert2();
    init_check4();
    init_errors3();
    init_clean2();
    init_clone3();
    init_convert2();
    init_default3();
    init_pipeline2();
    init_from_type14();
    init_union_priority_sort();
    EncodeError = class extends AssertError {
      constructor(value, errors) {
        super("Encode", value, errors);
      }
    };
    Encoder = Pipeline([
      (_context, _type, value) => Clone2(value),
      (context, type, value) => EncodeUnsafe(context, type, value),
      (context, type, value) => Default(context, type, value),
      (context, type, value) => Convert(context, type, value),
      (context, type, value) => Clean(context, type, value),
      (context, type, value) => Assert3(context, type, value)
    ]);
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/has.mjs
function FromArray11(context, type) {
  return IsCodec(type) || FromType24(context, type.items);
}
function FromCyclic10(context, type) {
  return IsCodec(type) || FromRef9({ ...context, ...type.$defs }, Ref(type.$ref));
}
function FromIntersect10(context, type) {
  return IsCodec(type) || type.allOf.some((type2) => FromType24(context, type2));
}
function FromObject15(context, type) {
  return IsCodec(type) || guard_exports.Keys(type.properties).some((key) => {
    return FromType24(context, type.properties[key]);
  });
}
function FromRecord7(context, type) {
  return IsCodec(type) || FromType24(context, RecordValue(type));
}
function FromRef9(context, type) {
  if (visited.has(type.$ref))
    return false;
  visited.add(type.$ref);
  return IsCodec(type) || guard_exports.HasPropertyKey(context, type.$ref) && FromType24(context, context[type.$ref]);
}
function FromTuple9(context, type) {
  return IsCodec(type) || type.items.some((type2) => FromType24(context, type2));
}
function FromUnion13(context, type) {
  return IsCodec(type) || type.anyOf.some((type2) => FromType24(context, type2));
}
function FromType24(context, type) {
  return IsArray2(type) ? FromArray11(context, type) : IsCyclic(type) ? FromCyclic10(context, type) : IsIntersect(type) ? FromIntersect10(context, type) : IsObject2(type) ? FromObject15(context, type) : IsRecord(type) ? FromRecord7(context, type) : IsRef(type) ? FromRef9(context, type) : IsTuple(type) ? FromTuple9(context, type) : IsUnion(type) ? FromUnion13(context, type) : IsCodec(type);
}
function HasCodec(...args) {
  const [context, type] = arguments_exports.Match(args, {
    2: (context2, type2) => [context2, type2],
    1: (type2) => [{}, type2]
  });
  visited.clear();
  return FromType24(context, type);
}
var visited;
var init_has = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/has.mjs"() {
    init_arguments2();
    init_guard2();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
    init_type3();
    visited = /* @__PURE__ */ new Set();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/index.mjs
var init_codec2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/codec/index.mjs"() {
    init_decode2();
    init_encode2();
    init_has();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/error.mjs
var CreateError;
var init_error = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/error.mjs"() {
    CreateError = class extends Error {
      constructor(type, message) {
        super(message);
        this.type = type;
      }
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_default.mjs
function FromDefault2(_context, schema) {
  return guard_exports.IsFunction(schema.default) ? schema.default(schema) : guard_exports.IsObject(schema.default) ? Clone2(schema.default) : schema.default;
}
var init_from_default2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_default.mjs"() {
    init_guard2();
    init_clone3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_array.mjs
function FromArray12(context, type) {
  if (IsUniqueItems(type) && !IsDefault(type))
    throw new CreateError(type, "Arrays with uniqueItems constraints must specify a default annotation");
  const length = IsMinItems(type) ? type.minItems : 0;
  return Array.from({ length }, () => FromType25(context, type.items));
}
var init_from_array8 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_array.mjs"() {
    init_types2();
    init_from_type15();
    init_error();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_bigint.mjs
function FromBigInt7(_context, type) {
  return IsExclusiveMinimum(type) ? BigInt(type.exclusiveMinimum) + BigInt(1) : IsMinimum(type) ? BigInt(type.minimum) : BigInt(0);
}
var init_from_bigint2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_bigint.mjs"() {
    init_types2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_boolean.mjs
function FromBoolean7(_context, _type) {
  return false;
}
var init_from_boolean2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_boolean.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_constructor.mjs
function FromConstructor2(context, type) {
  const instanceType = FromType25(context, type.instanceType);
  return class {
    constructor() {
      Object.assign(this, instanceType);
    }
  };
}
var init_from_constructor = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_constructor.mjs"() {
    init_from_type15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_cyclic.mjs
function FromCyclic11(context, type) {
  return FromType25({ ...context, ...type.$defs }, Ref(type.$ref));
}
var init_from_cyclic10 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_cyclic.mjs"() {
    init_type3();
    init_from_type15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_enum.mjs
function FromEnum4(context, type) {
  return FromType25(context, Evaluate(type));
}
var init_from_enum3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_enum.mjs"() {
    init_type3();
    init_from_type15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_function.mjs
function FromFunction2(context, type) {
  const returnType = FromType25(context, type.returnType);
  return () => returnType;
}
var init_from_function = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_function.mjs"() {
    init_from_type15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_integer.mjs
function FromInteger2(_context, type) {
  return IsExclusiveMinimum(type) && guard_exports.IsNumber(type.exclusiveMinimum) ? type.exclusiveMinimum + 1 : IsMinimum(type) ? type.minimum : 0;
}
var init_from_integer2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_integer.mjs"() {
    init_guard2();
    init_types2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_intersect.mjs
function FromIntersect11(context, type) {
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return FromType25(context, evaluated);
}
var init_from_intersect10 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_intersect.mjs"() {
    init_type3();
    init_from_type15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_literal.mjs
function FromLiteral7(_context, type) {
  return type.const;
}
var init_from_literal4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_literal.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_never.mjs
function FromNever(_context, type) {
  throw new CreateError(type, "Cannot create TNever types");
}
var init_from_never = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_never.mjs"() {
    init_error();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_null.mjs
function FromNull3(_context, _type) {
  return null;
}
var init_from_null2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_null.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_number.mjs
function FromNumber6(_context, type) {
  return IsExclusiveMinimum(type) && guard_exports.IsNumber(type.exclusiveMinimum) ? type.exclusiveMinimum + 1 : IsMinimum(type) ? type.minimum : 0;
}
var init_from_number2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_number.mjs"() {
    init_guard2();
    init_types2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_object.mjs
function FromObject16(context, type) {
  const required = guard_exports.IsUndefined(type.required) ? [] : type.required;
  return required.reduce((result2, key) => {
    return { ...result2, [key]: FromType25(context, type.properties[key]) };
  }, {});
}
var init_from_object11 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_object.mjs"() {
    init_guard2();
    init_from_type15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_record.mjs
function FromRecord8(_context, type) {
  if (IsMinProperties(type) && !IsDefault(type))
    throw new CreateError(type, "Record with the minProperties constraint must have a default annotation");
  return {};
}
var init_from_record6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_record.mjs"() {
    init_types2();
    init_error();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_ref.mjs
function FromRef10(context, type) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType25(context, context[type.$ref]) : (() => {
    throw new CreateError(type, "Unable to deref Ref");
  })();
}
var init_from_ref5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_ref.mjs"() {
    init_guard2();
    init_from_type15();
    init_error();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_string.mjs
function FromString8(_context, type) {
  const needsDefault = (IsPattern(type) || IsFormat(type)) && !IsDefault(type);
  if (needsDefault)
    throw Error("Strings with format or pattern constraints must specify default");
  const minLength = IsMinLength3(type) ? type.minLength : 0;
  return "".padEnd(minLength);
}
var init_from_string2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_string.mjs"() {
    init_types2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_symbol.mjs
function FromSymbol2(_context, _type) {
  return /* @__PURE__ */ Symbol();
}
var init_from_symbol = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_symbol.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_template_literal.mjs
function FromTemplateLiteral5(context, type) {
  const decoded = TemplateLiteralDecode(type.pattern);
  if (IsString3(decoded))
    throw new CreateError(type, "Unable to create TemplateLiteral due to infinite type expansion");
  return FromType25(context, decoded);
}
var init_from_template_literal4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_template_literal.mjs"() {
    init_type3();
    init_template_literal3();
    init_from_type15();
    init_error();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_tuple.mjs
function FromTuple10(context, type) {
  return Array.from({ length: type.minItems }, (_, i) => FromType25(context, type.items[i]));
}
var init_from_tuple9 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_tuple.mjs"() {
    init_from_type15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_undefined.mjs
function FromUndefined3(_context, _type) {
  return void 0;
}
var init_from_undefined2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_undefined.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_union.mjs
function FromUnion14(context, type) {
  if (guard_exports.IsEqual(type.anyOf.length, 0)) {
    throw Error("Unable to create Union with no variants");
  }
  return FromType25(context, type.anyOf[0]);
}
var init_from_union11 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_union.mjs"() {
    init_guard2();
    init_from_type15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_void.mjs
function FromVoid2(_context, _type) {
  return void 0;
}
var init_from_void2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_void.mjs"() {
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_type.mjs
function FromType25(context, type) {
  return (
    // -----------------------------------------------------
    // Default
    // -----------------------------------------------------
    IsDefault(type) ? FromDefault2(context, type) : (
      // -----------------------------------------------------
      // Types
      // -----------------------------------------------------
      IsArray2(type) ? FromArray12(context, type) : IsBigInt2(type) ? FromBigInt7(context, type) : IsBoolean3(type) ? FromBoolean7(context, type) : IsConstructor2(type) ? FromConstructor2(context, type) : IsCyclic(type) ? FromCyclic11(context, type) : IsEnum(type) ? FromEnum4(context, type) : IsFunction2(type) ? FromFunction2(context, type) : IsInteger2(type) ? FromInteger2(context, type) : IsIntersect(type) ? FromIntersect11(context, type) : IsLiteral(type) ? FromLiteral7(context, type) : IsNever(type) ? FromNever(context, type) : IsNull2(type) ? FromNull3(context, type) : IsNumber3(type) ? FromNumber6(context, type) : IsObject2(type) ? FromObject16(context, type) : IsRecord(type) ? FromRecord8(context, type) : IsRef(type) ? FromRef10(context, type) : IsString3(type) ? FromString8(context, type) : IsSymbol2(type) ? FromSymbol2(context, type) : IsTemplateLiteral(type) ? FromTemplateLiteral5(context, type) : IsTuple(type) ? FromTuple10(context, type) : IsUndefined2(type) ? FromUndefined3(context, type) : IsUnion(type) ? FromUnion14(context, type) : IsVoid(type) ? FromVoid2(context, type) : void 0
    )
  );
}
var init_from_type15 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/from_type.mjs"() {
    init_type3();
    init_types2();
    init_from_default2();
    init_from_array8();
    init_from_bigint2();
    init_from_boolean2();
    init_from_constructor();
    init_from_cyclic10();
    init_from_enum3();
    init_from_function();
    init_from_integer2();
    init_from_intersect10();
    init_from_literal4();
    init_from_never();
    init_from_null2();
    init_from_number2();
    init_from_object11();
    init_from_record6();
    init_from_ref5();
    init_from_string2();
    init_from_symbol();
    init_from_template_literal4();
    init_from_tuple9();
    init_from_undefined2();
    init_from_union11();
    init_from_void2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/create.mjs
function Create2(...args) {
  const [context, type] = arguments_exports.Match(args, {
    2: (context2, type2) => [context2, type2],
    1: (type2) => [{}, type2]
  });
  return FromType25(context, type);
}
var init_create3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/create.mjs"() {
    init_arguments2();
    init_from_type15();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/index.mjs
var init_create4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/create/index.mjs"() {
    init_error();
    init_create3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/equal/equal.mjs
function Equal(left, right) {
  return guard_exports.IsDeepEqual(left, right);
}
var init_equal = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/equal/equal.mjs"() {
    init_guard2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/equal/index.mjs
var init_equal2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/equal/index.mjs"() {
    init_equal();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/hash/hash.mjs
function Hash2(value) {
  return hash_exports.Hash(value);
}
var init_hash2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/hash/hash.mjs"() {
    init_hashing();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/hash/index.mjs
var init_hash3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/hash/index.mjs"() {
    init_hash2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/parse/parse.mjs
function Assert4(context, type, value) {
  if (!Check2(context, type, value))
    throw new ParseError2(value, Errors2(context, type, value));
  return value;
}
function Parse(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const checked = Check2(context, type, value);
  if (checked)
    return value;
  if (settings_exports.Get().correctiveParse)
    return Parser(context, type, value);
  throw new ParseError2(value, Errors2(context, type, value));
}
var ParseError2, Parser;
var init_parse2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/parse/parse.mjs"() {
    init_system();
    init_arguments2();
    init_assert2();
    init_check4();
    init_errors3();
    init_clean2();
    init_clone3();
    init_convert2();
    init_default3();
    init_pipeline2();
    ParseError2 = class extends AssertError {
      constructor(value, errors) {
        super("Parse", value, errors);
      }
    };
    Parser = Pipeline([
      (_context, _type, value) => Clone2(value),
      (context, type, value) => Default(context, type, value),
      (context, type, value) => Convert(context, type, value),
      (context, type, value) => Clean(context, type, value),
      (context, type, value) => Assert4(context, type, value)
    ]);
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/parse/index.mjs
var init_parse3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/parse/index.mjs"() {
    init_parse2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/delta/diff.mjs
function CreateUpdate(path, value) {
  return { type: "update", path, value };
}
function CreateInsert(path, value) {
  return { type: "insert", path, value };
}
function CreateDelete(path) {
  return { type: "delete", path };
}
function AssertCanDiffObject(value) {
  if (guard_exports.IsObject(value) && guard_exports.IsEqual(guard_exports.Symbols(value).length, 0))
    return;
  throw new Error("Cannot create diffs for objects with symbols keys");
}
function* FromObject17(path, left, right) {
  if (!guard_exports.IsObject(right) || guard_exports.IsArray(right))
    return yield CreateUpdate(path, right);
  AssertCanDiffObject(left);
  AssertCanDiffObject(right);
  const leftKeys = guard_exports.Keys(left);
  const rightKeys = guard_exports.Keys(right);
  for (const key of rightKeys) {
    if (guard_exports.HasPropertyKey(left, key))
      continue;
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    yield CreateInsert(`${path}/${key}`, right[key]);
  }
  for (const key of leftKeys) {
    if (!guard_exports.HasPropertyKey(right, key))
      continue;
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    if (Equal(left, right))
      continue;
    yield* FromValue4(`${path}/${key}`, left[key], right[key]);
  }
  for (const key of leftKeys) {
    if (guard_exports.HasPropertyKey(right, key))
      continue;
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    yield CreateDelete(`${path}/${key}`);
  }
}
function* FromArray13(path, left, right) {
  if (!guard_exports.IsArray(right))
    return yield CreateUpdate(path, right);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    yield* FromValue4(`${path}/${i}`, left[i], right[i]);
  }
  for (let i = 0; i < right.length; i++) {
    if (i < left.length)
      continue;
    yield CreateInsert(`${path}/${i}`, right[i]);
  }
  for (let i = left.length - 1; i >= 0; i--) {
    if (i < right.length)
      continue;
    yield CreateDelete(`${path}/${i}`);
  }
}
function* FromTypedArray2(path, left, right) {
  const typeLeft = globalThis.Object.getPrototypeOf(left).constructor.name;
  const typeRight = globalThis.Object.getPrototypeOf(right).constructor.name;
  const predicate = globals_exports.IsTypeArray(right) && guard_exports.IsEqual(left.length, right.length) && guard_exports.IsEqual(typeLeft, typeRight);
  if (predicate) {
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      yield* FromValue4(`${path}/${index}`, left[index], right[index]);
    }
  } else {
    return yield CreateUpdate(path, right);
  }
}
function* FromUnknown(path, left, right) {
  if (left === right)
    return;
  yield CreateUpdate(path, right);
}
function* FromValue4(path, left, right) {
  return globals_exports.IsTypeArray(left) ? yield* FromTypedArray2(path, left, right) : guard_exports.IsArray(left) ? yield* FromArray13(path, left, right) : guard_exports.IsObject(left) ? yield* FromObject17(path, left, right) : yield* FromUnknown(path, left, right);
}
function Diff(current, next) {
  return [...FromValue4("", current, next)];
}
var init_diff = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/delta/diff.mjs"() {
    init_guard2();
    init_equal2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/delta/edit.mjs
var Insert2, Update2, Delete2, Edit;
var init_edit = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/delta/edit.mjs"() {
    init_type3();
    Insert2 = _Object_({
      type: Literal("insert"),
      path: String2(),
      value: Unknown()
    });
    Update2 = Object({
      type: Literal("update"),
      path: String2(),
      value: Unknown()
    });
    Delete2 = _Object_({
      type: Literal("delete"),
      path: String2()
    });
    Edit = Union([Insert2, Update2, Delete2]);
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/pointer/index.mjs
var init_pointer3 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/pointer/index.mjs"() {
    init_pointer2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/delta/patch.mjs
function IsRoot(edits) {
  return edits.length > 0 && edits[0].path === "" && edits[0].type === "update";
}
function IsEmpty(edits) {
  return edits.length === 0;
}
function Patch(current, edits) {
  if (IsRoot(edits))
    return Clone2(edits[0].value);
  if (IsEmpty(edits))
    return Clone2(current);
  const clone = Clone2(current);
  for (const edit of edits) {
    switch (edit.type) {
      case "insert": {
        pointer_exports.Set(clone, edit.path, edit.value);
        break;
      }
      case "update": {
        pointer_exports.Set(clone, edit.path, edit.value);
        break;
      }
      case "delete": {
        pointer_exports.Delete(clone, edit.path);
        break;
      }
    }
  }
  return clone;
}
var init_patch = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/delta/patch.mjs"() {
    init_clone3();
    init_pointer3();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/delta/index.mjs
var init_delta = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/delta/index.mjs"() {
    init_diff();
    init_edit();
    init_patch();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/error.mjs
var RepairError;
var init_error2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/error.mjs"() {
    RepairError = class extends Error {
      constructor(context, type, value, message) {
        super(message);
        this.context = context;
        this.type = type;
        this.value = value;
      }
    };
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_array.mjs
function MakeUnique(values) {
  const [hashes, result2] = [/* @__PURE__ */ new Set(), []];
  for (const value of values) {
    const hash = Hash2(value);
    if (hashes.has(hash))
      continue;
    hashes.add(hash);
    result2.push(value);
  }
  return result2;
}
function FromArray14(context, type, value) {
  if (Check2(context, type, value))
    return value;
  const created = guard_exports.IsArray(value) ? value : Create2(context, type);
  const minimum = IsMinItems(type) && created.length < type.minItems ? [...created, ...Array.from({ length: type.minItems - created.length }, () => Create2(context, type))] : created;
  const maximum = IsMaxItems(type) && minimum.length > type.maxItems ? minimum.slice(0, type.maxItems) : minimum;
  const repaired = maximum.map((value2) => FromType26(context, type.items, value2));
  if (!IsUniqueItems(type) || IsUniqueItems(type) && !guard_exports.IsEqual(type.uniqueItems, true))
    return repaired;
  const unique = MakeUnique(repaired);
  if (!Check2(context, type, unique))
    throw new RepairError(context, type, value, "Failed to repair Array due to uniqueItems constraint");
  return unique;
}
var init_from_array9 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_array.mjs"() {
    init_types2();
    init_guard2();
    init_check4();
    init_create4();
    init_hash3();
    init_from_type16();
    init_error2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_enum.mjs
function FromEnum5(context, type, value) {
  return FromType26(context, Evaluate(type), value);
}
var init_from_enum4 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_enum.mjs"() {
    init_type3();
    init_from_type16();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_intersect.mjs
function FromIntersect12(context, type, value) {
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return FromType26(context, evaluated, value);
}
var init_from_intersect11 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_intersect.mjs"() {
    init_type3();
    init_from_type16();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_object.mjs
function FromObject18(context, type, value) {
  if (Check2(context, type, value))
    return value;
  if (!guard_exports.IsObjectNotArray(value))
    return Create2(context, type);
  const required = new Set(guard_exports.IsUndefined(type.required) ? [] : type.required);
  const result2 = {};
  for (const [key, schema] of guard_exports.Entries(type.properties)) {
    if (!required.has(key) && guard_exports.IsUndefined(value[key]))
      continue;
    result2[key] = key in value ? FromType26(context, schema, value[key]) : Create2(context, schema);
  }
  const evaluatedKeys = guard_exports.Keys(type.properties);
  if (IsAdditionalProperties(type) && guard_exports.IsObject(type.additionalProperties)) {
    for (const key of guard_exports.Keys(value)) {
      if (evaluatedKeys.includes(key))
        continue;
      result2[key] = FromType26(context, type.additionalProperties, value[key]);
    }
  }
  return result2;
}
var init_from_object12 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_object.mjs"() {
    init_guard2();
    init_check4();
    init_create4();
    init_types2();
    init_from_type16();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_record.mjs
function FromRecord9(context, type, value) {
  if (Check2(context, type, value))
    return value;
  if (guard_exports.IsNull(value) || !guard_exports.IsObject(value) || guard_exports.IsArray(value))
    return Create2(context, type);
  const recordKey = new RegExp(RecordPattern(type));
  const recordValue = RecordValue(type);
  const evaluatedKeys = /* @__PURE__ */ new Set();
  const result2 = {};
  for (const [key, value_] of guard_exports.Entries(value)) {
    if (!recordKey.test(key))
      continue;
    result2[key] = FromType26(context, recordValue, value_);
    evaluatedKeys.add(key);
  }
  if (IsAdditionalProperties(type)) {
    for (const key of guard_exports.Keys(value)) {
      if (evaluatedKeys.has(key))
        continue;
      result2[key] = FromType26(context, type.additionalProperties, value[key]);
    }
  }
  return result2;
}
var init_from_record7 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_record.mjs"() {
    init_types2();
    init_type3();
    init_guard2();
    init_create4();
    init_check4();
    init_from_type16();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_ref.mjs
function FromRef11(context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType26(context, context[type.$ref], value) : (() => {
    throw new RepairError(context, type, value, "Unable to de-reference target type");
  })();
}
var init_from_ref6 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_ref.mjs"() {
    init_guard2();
    init_from_type16();
    init_error2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_template_literal.mjs
function FromTemplateLiteral6(context, type, value) {
  const decoded = TemplateLiteralDecode(type.pattern);
  return FromType26(context, decoded, value);
}
var init_from_template_literal5 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_template_literal.mjs"() {
    init_template_literal3();
    init_from_type16();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_tuple.mjs
function FromTuple11(context, schema, value) {
  if (Check2(context, schema, value))
    return value;
  if (!guard_exports.IsArray(value))
    return Create2(context, schema);
  return schema.items.map((schema2, index) => FromType26(context, schema2, value[index]));
}
var init_from_tuple10 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_tuple.mjs"() {
    init_guard2();
    init_check4();
    init_create4();
    init_from_type16();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/shared/union_score_select.mjs
function Deref(context, type, value) {
  return IsRef(type) ? guard_exports.HasPropertyKey(context, type.$ref) ? Deref(context, context[type.$ref], value) : (() => {
    throw new Error("Unable to Deref target");
  })() : type;
}
function ScoreVariant(context, type, value) {
  if (!(IsObject2(type) && guard_exports.IsObject(value)))
    return 0;
  const keys = guard_exports.Keys(value);
  const entries = guard_exports.Entries(type.properties);
  return entries.reduce((result2, [key, schema]) => {
    const literal = IsLiteral(schema) && guard_exports.IsEqual(schema.const, value[key]) ? 100 : 0;
    const checks = Check2(context, schema, value[key]) ? 10 : 0;
    const exists = keys.includes(key) ? 1 : 0;
    return result2 + (literal + checks + exists);
  }, 0);
}
function UnionScoreSelect(context, type, value) {
  const schemas = type.anyOf.map((schema) => Deref(context, schema, value));
  let [select, best] = [schemas[0], 0];
  for (const schema of schemas) {
    const score = ScoreVariant(context, schema, value);
    if (score > best) {
      select = schema;
      best = score;
    }
  }
  return select;
}
var init_union_score_select = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/shared/union_score_select.mjs"() {
    init_type3();
    init_guard2();
    init_check4();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_union.mjs
function RepairUnion(context, type, value) {
  const union = Union(Flatten(type.anyOf));
  const schema = UnionScoreSelect(context, union, value);
  return FromType26(context, schema, value);
}
function FromUnion15(context, type, value) {
  if (Check2(context, type, value))
    return Clone2(value);
  if (IsDefault(type))
    return Create2(context, type);
  return RepairUnion(context, type, value);
}
var init_from_union12 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_union.mjs"() {
    init_types2();
    init_type3();
    init_evaluate3();
    init_check4();
    init_clone3();
    init_create4();
    init_from_type16();
    init_union_score_select();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_unknown.mjs
function FromUnknown2(context, type, value) {
  if (Check2(context, type, value))
    return value;
  const converted = Convert(context, type, value);
  if (Check2(context, type, converted))
    return converted;
  return Create2(context, type);
}
var init_from_unknown = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_unknown.mjs"() {
    init_check4();
    init_create4();
    init_convert2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_type.mjs
function AssertRepairableValue(context, type, value) {
  const unsupported = globals_exports.IsDate(value) || globals_exports.IsMap(value) || globals_exports.IsSet(value) || globals_exports.IsTypeArray(value) || guard_exports.IsConstructor(value) || guard_exports.IsFunction(value);
  if (unsupported) {
    throw new RepairError(context, type, value, "Value is not repairable");
  }
}
function AssertRepairableType(context, type, value) {
  const unsupported = IsConstructor2(type) || IsFunction2(type) || IsNever(type);
  if (unsupported) {
    throw new RepairError(context, type, value, "Type is not repairable");
  }
}
function CreateWhenUndefined(context, type, value) {
  return guard_exports.IsUndefined(value) && !IsUndefined2(type) ? Create2(context, type) : value;
}
function FinalizeRepair(context, type, repaired) {
  return IsRefine(type) ? Check2(context, type, repaired) ? repaired : Create2(context, type) : repaired;
}
function FromType26(context, type, value) {
  AssertRepairableValue(context, type, value);
  AssertRepairableType(context, type, value);
  const candidate = CreateWhenUndefined(context, type, value);
  const repaired = IsArray2(type) ? FromArray14(context, type, candidate) : IsEnum(type) ? FromEnum5(context, type, candidate) : IsIntersect(type) ? FromIntersect12(context, type, candidate) : IsObject2(type) ? FromObject18(context, type, candidate) : IsRecord(type) ? FromRecord9(context, type, candidate) : IsRef(type) ? FromRef11(context, type, candidate) : IsTemplateLiteral(type) ? FromTemplateLiteral6(context, type, candidate) : IsTuple(type) ? FromTuple11(context, type, candidate) : IsUnion(type) ? FromUnion15(context, type, candidate) : FromUnknown2(context, type, candidate);
  return FinalizeRepair(context, type, repaired);
}
var init_from_type16 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/from_type.mjs"() {
    init_guard2();
    init_type3();
    init_check4();
    init_create4();
    init_from_array9();
    init_from_enum4();
    init_from_intersect11();
    init_from_object12();
    init_from_record7();
    init_from_ref6();
    init_from_template_literal5();
    init_from_tuple10();
    init_from_union12();
    init_from_unknown();
    init_error2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/repair.mjs
function Repair(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const repaired = FromType26(context, type, value);
  Assert(context, type, repaired);
  return repaired;
}
var init_repair = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/repair.mjs"() {
    init_arguments2();
    init_from_type16();
    init_assert2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/index.mjs
var init_repair2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/repair/index.mjs"() {
    init_repair();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/shared/index.mjs
var init_shared = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/shared/index.mjs"() {
    init_optional_undefined();
    init_union_priority_sort();
    init_union_score_select();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/value.mjs
var value_exports = {};
__export(value_exports, {
  Assert: () => Assert,
  Check: () => Check2,
  Clean: () => Clean,
  Clone: () => Clone2,
  Convert: () => Convert,
  Create: () => Create2,
  Decode: () => Decode10,
  Default: () => Default,
  Diff: () => Diff,
  Encode: () => Encode9,
  Equal: () => Equal,
  Errors: () => Errors2,
  HasCodec: () => HasCodec,
  Hash: () => Hash2,
  Parse: () => Parse,
  Patch: () => Patch,
  Pointer: () => pointer_exports,
  Repair: () => Repair
});
var init_value = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/value.mjs"() {
    init_assert2();
    init_check4();
    init_clean2();
    init_clone3();
    init_codec2();
    init_convert2();
    init_create4();
    init_default3();
    init_equal2();
    init_errors3();
    init_hash3();
    init_parse3();
    init_delta();
    init_pointer3();
    init_repair2();
  }
});

// node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/index.mjs
var init_value2 = __esm({
  "node_modules/.pnpm/typebox@1.3.8/node_modules/typebox/build/value/index.mjs"() {
    init_assert2();
    init_check4();
    init_clean2();
    init_clone3();
    init_codec2();
    init_convert2();
    init_create4();
    init_errors3();
    init_default3();
    init_equal2();
    init_hash3();
    init_parse3();
    init_delta();
    init_pipeline2();
    init_pointer3();
    init_repair2();
    init_shared();
    init_value();
    init_value();
  }
});

// src/package-contracts/fixer-packet.ts
function causeMessage(cause) {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}
function fail(cause) {
  throw new FixerPacketValidationError(cause);
}
function parseFailure(value) {
  if (!Array.isArray(value)) fail(new Error("Fixer prerequisites must be a JSON array"));
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(new Error("Fixer prerequisite entry must be an object with id and requirement fields"));
    }
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("requirement")) {
      fail(new Error("Fixer prerequisite entry fields must be exactly id and requirement"));
    }
    if (typeof entry.id !== "string" || !new RegExp(FIXER_PREREQUISITE_ID_PATTERN).test(entry.id)) {
      fail(new Error(`Fixer prerequisite id violates pattern ${FIXER_PREREQUISITE_ID_PATTERN}`));
    }
    if (typeof entry.requirement !== "string" || !/\S/.test(entry.requirement)) {
      fail(new Error("Fixer prerequisite requirement must be nonblank"));
    }
  }
  fail(new Error("Fixer prerequisites violate the attachment schema"));
}
function validateFixerPrerequisites(value) {
  if (!value_exports.Check(fixerPrerequisitesSchema, value)) parseFailure(value);
  const entries = value;
  const ids = /* @__PURE__ */ new Set();
  const prerequisites = entries.map((entry) => {
    if (ids.has(entry.id)) {
      fail(new Error(`Fixer prerequisites contain duplicate id: ${entry.id}`));
    }
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, requirement: entry.requirement });
  });
  return Object.freeze(prerequisites);
}
function parseFixerPrerequisites(source) {
  let decoded;
  try {
    decoded = JSON.parse(source);
  } catch (error) {
    fail(error);
  }
  return validateFixerPrerequisites(decoded);
}
var FIXER_PREREQUISITE_ID_PATTERN, fixerPrerequisiteSchema, fixerPrerequisitesSchema, FixerPacketValidationError;
var init_fixer_packet = __esm({
  "src/package-contracts/fixer-packet.ts"() {
    "use strict";
    init_build();
    init_value2();
    FIXER_PREREQUISITE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
    fixerPrerequisiteSchema = typebox_exports.Object({
      id: typebox_exports.String({ pattern: FIXER_PREREQUISITE_ID_PATTERN }),
      requirement: typebox_exports.String({ pattern: "\\S" })
    }, { additionalProperties: false });
    fixerPrerequisitesSchema = typebox_exports.Array(fixerPrerequisiteSchema);
    FixerPacketValidationError = class extends Error {
      code = "AK_INVALID_FIX_PACKET";
      constructor(cause) {
        const prefix = "Fixer prerequisites or instructions violate the invocation contract";
        super(
          cause === void 0 ? prefix : `${prefix}: ${causeMessage(cause)}`,
          cause === void 0 ? void 0 : { cause }
        );
        this.name = "FixerPacketValidationError";
      }
    };
  }
});

// src/open-tool-schema.ts
function described(name, schema) {
  if (typeof schema.description === "string") return schema;
  throw new Error(`Tool field ${name} has no semantic description at its schema owner`);
}
function declarationIdentity(schema) {
  const { description: _description, ...semantic } = schema;
  return JSON.stringify(semantic);
}
function openToolObjectFromUnion(schema) {
  const declarations = /* @__PURE__ */ new Map();
  for (const variant of schema.anyOf) {
    for (const [name, declaration] of Object.entries(variant.properties ?? {})) {
      const entries = declarations.get(name) ?? [];
      const identity = declarationIdentity(declaration);
      if (!entries.some((entry) => declarationIdentity(entry) === identity)) entries.push(declaration);
      declarations.set(name, entries);
    }
  }
  const properties = Object.fromEntries([...declarations].map(([name, entries]) => {
    const descriptions = [...new Set(entries.map((entry) => entry.description).filter((value) => typeof value === "string"))].join(" ");
    const declaration = entries.length === 1 ? entries[0] : typebox_exports.Union(entries, descriptions === "" ? {} : { description: descriptions });
    return [name, typebox_exports.Optional(described(name, declaration))];
  }));
  const object = typebox_exports.Object(properties, { additionalProperties: true });
  object.required = [];
  return object;
}
var init_open_tool_schema = __esm({
  "src/open-tool-schema.ts"() {
    "use strict";
    init_build();
  }
});

// src/package-contracts/fixer-output.ts
function validateFixerOutput(value, _phase) {
  return value;
}
var FIXER_OUTPUT_TOOL_NAME, nonblankTransportString, authorityBlockerSchema, prerequisiteBlockerSchema, blockerSchema, exceptionSchema, testEvidenceSchema, completedClassResultSchema, refusedClassResultSchema, classResultSchema, completedClassResultsSchema, fixerOutputVariants, fixerOutputSchema;
var init_fixer_output = __esm({
  "src/package-contracts/fixer-output.ts"() {
    "use strict";
    init_build();
    init_fixer_packet();
    init_open_tool_schema();
    FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";
    nonblankTransportString = typebox_exports.String({ minLength: 1 });
    authorityBlockerSchema = typebox_exports.Object({ cause: typebox_exports.Literal("authority_violation"), evidence: nonblankTransportString });
    prerequisiteBlockerSchema = typebox_exports.Object({ cause: typebox_exports.Literal("prerequisite_unmet"), prerequisiteId: typebox_exports.String({ pattern: FIXER_PREREQUISITE_ID_PATTERN }), evidence: nonblankTransportString });
    blockerSchema = typebox_exports.Union([authorityBlockerSchema, prerequisiteBlockerSchema]);
    exceptionSchema = typebox_exports.Object({ where: nonblankTransportString, reason: nonblankTransportString });
    testEvidenceSchema = typebox_exports.Object({
      contract: typebox_exports.String({ minLength: 1, description: "Contract the test change proves." }),
      minimumNecessaryCost: typebox_exports.String({ minLength: 1, description: "One-line minimum necessary cost of the test change." }),
      measuredDuration: typebox_exports.String({ minLength: 1, description: "Measured duration of the focused verification run." })
    }, { description: "Test evidence slip (submit when diff includes test changes; machine does not verify)." });
    completedClassResultSchema = typebox_exports.Object({
      name: nonblankTransportString,
      disposition: typebox_exports.Literal("completed"),
      searchScope: nonblankTransportString,
      exceptions: typebox_exports.Array(exceptionSchema),
      commitSha: nonblankTransportString
    });
    refusedClassResultSchema = typebox_exports.Object({
      name: nonblankTransportString,
      disposition: typebox_exports.Literal("refused"),
      remainingScope: nonblankTransportString,
      blocker: blockerSchema
    });
    classResultSchema = typebox_exports.Union([completedClassResultSchema, refusedClassResultSchema]);
    completedClassResultsSchema = typebox_exports.Array(completedClassResultSchema, { minItems: 1 });
    fixerOutputVariants = typebox_exports.Union([
      typebox_exports.Object({ status: typebox_exports.Literal("planned", { description: "Plan-phase proposal outcome." }), report: typebox_exports.String({ minLength: 1, description: "Truthful Fixer outcome report." }) }),
      typebox_exports.Object({ status: typebox_exports.Literal("refused", { description: "Lawfully refused outcome." }), report: typebox_exports.String({ minLength: 1, description: "Truthful Fixer outcome report." }), remainingScope: typebox_exports.String({ minLength: 1, description: "Work that cannot lawfully be performed." }), blocker: typebox_exports.Unsafe({ ...blockerSchema, description: "Lawful blocker preventing completion." }) }),
      typebox_exports.Object({ status: typebox_exports.Literal("unfinished", { description: "Honest unfinished apply outcome." }), report: typebox_exports.String({ minLength: 1, description: "Truthful Fixer outcome report." }), remainingScope: typebox_exports.String({ minLength: 1, description: "Work remaining after this invocation." }), classResults: typebox_exports.Optional(typebox_exports.Unsafe({ ...completedClassResultsSchema, description: "Completed class settlements from this invocation." })), testEvidence: typebox_exports.Optional(testEvidenceSchema) }),
      typebox_exports.Object({ status: typebox_exports.Literal("completed", { description: "All assigned classes completed." }), report: typebox_exports.String({ minLength: 1, description: "Truthful Fixer outcome report." }), classResults: typebox_exports.Array(classResultSchema, { minItems: 1, description: "Completed class settlements." }), testEvidence: typebox_exports.Optional(testEvidenceSchema) }),
      typebox_exports.Object({ status: typebox_exports.Literal("refused", { description: "All assigned classes lawfully refused." }), report: typebox_exports.String({ minLength: 1, description: "Truthful Fixer outcome report." }), classResults: typebox_exports.Array(classResultSchema, { minItems: 1, description: "Per-class refusal settlements." }) }),
      typebox_exports.Object({ status: typebox_exports.Literal("partially_completed", { description: "Assigned classes include completions and lawful refusals." }), report: typebox_exports.String({ minLength: 1, description: "Truthful Fixer outcome report." }), classResults: typebox_exports.Array(classResultSchema, { minItems: 1, description: "Per-class completion or refusal settlements." }), testEvidence: typebox_exports.Optional(testEvidenceSchema) })
    ]);
    fixerOutputSchema = openToolObjectFromUnion(fixerOutputVariants);
  }
});

// src/package-contracts/worker-output.ts
function validateAcceptedCoderDetails(output) {
  return output;
}
function validateAcceptedWorkerDetails(output, roleLabel = "Coder") {
  return roleLabel === "Fixer" ? validateFixerOutput(output) : validateAcceptedCoderDetails(output);
}
var CODER_OUTPUT_TOOL_NAME;
var init_worker_output = __esm({
  "src/package-contracts/worker-output.ts"() {
    "use strict";
    init_fixer_output();
    init_fixer_packet();
    init_fixer_output();
    CODER_OUTPUT_TOOL_NAME = "ak_coder_output";
  }
});

// src/canonical-json.ts
var init_canonical_json = __esm({
  "src/canonical-json.ts"() {
    "use strict";
  }
});

// src/doctor-contracts.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function read2(value, key) {
  if (!isRecord2(value)) return void 0;
  try {
    return value[key];
  } catch {
    return void 0;
  }
}
function validateDoctorSubmissionShape(value) {
  const status = read2(value, "status");
  if (status !== "completed" && status !== "refused") throw new DoctorSubmissionContractError("Doctor submission has no recognized execution status");
  return value;
}
function validateRecordedDoctorOutput(value) {
  const output = validateDoctorSubmissionShape(value);
  if (read2(output, "status") === "completed" && read2(output, "cost") === void 0) throw new Error("Completed Doctor receipt has no runtime-owned cost testimony");
  return output;
}
var DOCTOR_OUTPUT_TOOL_NAME, DOCTOR_TARGET_KINDS, nonblank, count, evidenceIds, guardrail, lastRealBite, assetKinds, findingBody, finding, caseIdentity, cost, doctorSubmissionVariants, doctorSubmissionSchema, doctorOutputSchema, doctorEvidenceReadSchema, DoctorSubmissionContractError;
var init_doctor_contracts = __esm({
  "src/doctor-contracts.ts"() {
    "use strict";
    init_build();
    init_canonical_json();
    init_open_tool_schema();
    DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
    DOCTOR_TARGET_KINDS = ["law", "gate", "template", "station", "seat"];
    nonblank = typebox_exports.String({ minLength: 1, pattern: "\\S" });
    count = typebox_exports.Object({ count: typebox_exports.Integer({ minimum: 0 }), sources: typebox_exports.Array(nonblank) }, { additionalProperties: false });
    evidenceIds = typebox_exports.Array(nonblank, { minItems: 1 });
    guardrail = typebox_exports.Object({ answer: typebox_exports.Boolean(), evidenceIds, explanation: nonblank }, { additionalProperties: false });
    lastRealBite = typebox_exports.Union([
      typebox_exports.Object({ kind: typebox_exports.Literal("actual"), targetKey: nonblank, evidenceId: nonblank }, { additionalProperties: false }),
      typebox_exports.Object({ kind: typebox_exports.Literal("noRealBite"), targetKey: nonblank, eligibleEvidenceIds: evidenceIds }, { additionalProperties: false })
    ]);
    assetKinds = DOCTOR_TARGET_KINDS;
    findingBody = {
      evidenceIds,
      disposition: typebox_exports.Union([typebox_exports.Literal("keep"), typebox_exports.Literal("thin"), typebox_exports.Literal("delete")]),
      guardrails: typebox_exports.Object({ reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: guardrail }, { additionalProperties: true }),
      prescription: typebox_exports.Object({ kind: typebox_exports.Union([typebox_exports.Literal("retain"), typebox_exports.Literal("delete"), typebox_exports.Literal("simplify"), typebox_exports.Literal("patch"), typebox_exports.Literal("addMechanism")]), recommendation: nonblank, necessityExplanation: typebox_exports.Optional(nonblank) }, { additionalProperties: false }),
      lastRealBite
    };
    finding = typebox_exports.Union([
      typebox_exports.Object({ targetKey: nonblank, observation: nonblank, evidenceIds }, { additionalProperties: false }),
      typebox_exports.Object({ targetKey: nonblank, targetKind: typebox_exports.Union(assetKinds.map((kind) => typebox_exports.Literal(kind))), assetEvidence: typebox_exports.Object({ targetKey: nonblank, targetKind: typebox_exports.Union(assetKinds.map((kind) => typebox_exports.Literal(kind))), evidenceId: nonblank }, { additionalProperties: false }), ...findingBody }, { additionalProperties: false })
    ]);
    caseIdentity = typebox_exports.Object({ issueNumber: typebox_exports.Integer({ minimum: 1 }), runsPath: nonblank }, { additionalProperties: false });
    cost = typebox_exports.Object({
      invocations: count,
      legs: count,
      modelApiTurns: count,
      outputTokens: count,
      toolCalls: count,
      retries: typebox_exports.Object({ count: typebox_exports.Integer({ minimum: 0 }), sources: typebox_exports.Array(nonblank), evidence: typebox_exports.Literal("literal run-dir naming") }, { additionalProperties: false }),
      statuses: typebox_exports.Array(typebox_exports.Object({ source: nonblank, status: nonblank }, { additionalProperties: false })),
      commits: typebox_exports.Array(typebox_exports.Object({ source: nonblank, commit: nonblank }, { additionalProperties: false })),
      sessions: typebox_exports.Array(typebox_exports.Union([
        typebox_exports.Object({ source: nonblank, startedAt: nonblank, endedAt: nonblank, wallMilliseconds: typebox_exports.Number({ minimum: 0 }), completion: typebox_exports.Literal("accepted") }, { additionalProperties: false }),
        typebox_exports.Object({ source: nonblank, startedAt: typebox_exports.Optional(nonblank), endedAt: typebox_exports.Optional(nonblank), wallMilliseconds: typebox_exports.Optional(typebox_exports.Number({ minimum: 0 })), completion: typebox_exports.Literal("incomplete"), degradationReason: typebox_exports.Optional(nonblank) }, { additionalProperties: false })
      ])),
      outputBytes: typebox_exports.Object({ count: typebox_exports.Integer({ minimum: 0 }), sources: typebox_exports.Array(nonblank), payload: typebox_exports.Literal("raw JSONL bytes"), providerWireBytes: typebox_exports.Literal("unavailable") }, { additionalProperties: false })
    }, { additionalProperties: false });
    doctorSubmissionVariants = typebox_exports.Union([
      typebox_exports.Object({
        status: typebox_exports.Literal("completed", { description: "Truthful single-case testimony was completed; the runtime adds derived cost to the receipt." }),
        case: typebox_exports.Unsafe({ ...caseIdentity, description: "Identity of the retained Doctor case." }),
        findings: typebox_exports.Array(finding, { description: "May be empty or contain non-prescriptive case observations. Missing reusable-asset or bounded-bite evidence excludes only the corresponding asset prescription." })
      }, { additionalProperties: false, description: "Single-case testimony, without requiring any prescription or reusable finding." }),
      typebox_exports.Object({
        status: typebox_exports.Literal("refused", { description: "Reserved for inability to support truthful case testimony, not for an unavailable prescription axis." }),
        reason: typebox_exports.String({ minLength: 1, description: "Reason evidence is insufficient for truthful testimony." }),
        missingEvidence: typebox_exports.Array(typebox_exports.Object({ need: nonblank, targetKeys: typebox_exports.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false }), { minItems: 1, description: "Evidence required before truthful testimony is possible." })
      }, { additionalProperties: false, description: "Evidence is insufficient for truthful case testimony." })
    ]);
    doctorSubmissionSchema = openToolObjectFromUnion(doctorSubmissionVariants);
    doctorOutputSchema = typebox_exports.Union([
      typebox_exports.Object({ status: typebox_exports.Literal("completed"), case: caseIdentity, findings: typebox_exports.Array(finding), cost }, { additionalProperties: false }),
      doctorSubmissionVariants.anyOf[1]
    ]);
    doctorEvidenceReadSchema = typebox_exports.Object({ evidenceId: typebox_exports.String({ minLength: 1, description: "Identifier of the retained evidence to read." }), offset: typebox_exports.Optional(typebox_exports.Integer({ minimum: 0, description: "Zero-based byte offset at which to begin reading." })), limit: typebox_exports.Optional(typebox_exports.Integer({ minimum: 1, maximum: 4096, description: "Maximum number of bytes to return." })) }, { additionalProperties: false });
    DoctorSubmissionContractError = class extends Error {
      name = "DoctorSubmissionContractError";
    };
  }
});

// src/git-object-id.ts
function isFullGitObjectId(value) {
  return typeof value === "string" && FULL_GIT_OBJECT_ID_RE.test(value);
}
var FULL_GIT_OBJECT_ID_RE;
var init_git_object_id = __esm({
  "src/git-object-id.ts"() {
    "use strict";
    FULL_GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  }
});

// src/exact-utf8.ts
function exactUtf8(bytes, label) {
  let text;
  try {
    text = decoder.decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  return text;
}
var decoder;
var init_exact_utf8 = __esm({
  "src/exact-utf8.ts"() {
    "use strict";
    decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  }
});

// src/sha256.ts
import { createHash } from "node:crypto";
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
var init_sha256 = __esm({
  "src/sha256.ts"() {
    "use strict";
  }
});

// src/merger-contracts.ts
function fail2(message = "Merger input violates its exact contract") {
  throw new MergerInputContractError(message);
}
function canonicalPath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\0") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function validatePathSet(value, label) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(canonicalPath)) fail2(`Merger ${label} must be a non-empty canonical path set`);
  return value;
}
function validateMaterial(value, label) {
  if (!record(value) || typeof value.bytesBase64 !== "string" || typeof value.sha256 !== "string") fail2(`Merger ${label} material is malformed`);
  const bytes = Buffer.from(value.bytesBase64, "base64");
  exactUtf8(bytes, `Merger ${label} material`);
  if (sha256Hex(bytes) !== value.sha256) fail2(`Merger ${label} material digest mismatch`);
}
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function validateMergerInput(value) {
  if (!record(value) || blank(value.attemptId) || !isFullGitObjectId(value.targetObjectId) || !isFullGitObjectId(value.sourceObjectId) || value.targetObjectId.length !== value.sourceObjectId.length) fail2("Merger input has invalid identity or object ID");
  if (!record(value.materials)) fail2();
  for (const key of ["task", "authority", "targetIntent", "sourceIntent"]) validateMaterial(value.materials[key], key);
  const conflicts = validatePathSet(value.expectedConflictPaths, "expected conflict paths");
  const scope = validatePathSet(value.resolutionScope, "resolution scope");
  if (!conflicts.every((path) => scope.includes(path))) fail2("Merger resolution scope must contain the complete conflict set");
  if (!Array.isArray(value.authorizedChecks)) fail2("Merger authorized checks are malformed");
  for (const check of value.authorizedChecks) {
    if (!record(check) || !Array.isArray(check.argv) || check.argv.length === 0 || check.argv.some(blank)) fail2("Merger authorized check is malformed");
  }
  return deepFreeze(structuredClone(value));
}
function validateMergerOutput(value, expectedAttemptId) {
  if (!record(value) || expectedAttemptId !== void 0 && value.attemptId !== expectedAttemptId) throw new Error("Merger output attempt mismatch");
  if (value.status === "completed" && isFullGitObjectId(value.mergeCommitId)) return structuredClone(value);
  if (value.status === "escalate") return structuredClone(value);
  throw new Error("Merger output has no recognized execution discriminator");
}
var oidPattern, materialSchema, checkSchema, mergerInputSchema, mergerOutputVariants, mergerOutputSchema, MERGER_OUTPUT_TOOL_NAME, record, blank, MergerInputContractError;
var init_merger_contracts = __esm({
  "src/merger-contracts.ts"() {
    "use strict";
    init_build();
    init_git_object_id();
    init_exact_utf8();
    init_sha256();
    init_open_tool_schema();
    oidPattern = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
    materialSchema = typebox_exports.Object({ bytesBase64: typebox_exports.String(), sha256: typebox_exports.String() }, { additionalProperties: false });
    checkSchema = typebox_exports.Object({ name: typebox_exports.String({ minLength: 1 }), argv: typebox_exports.Array(typebox_exports.String({ minLength: 1 }), { minItems: 1 }) }, { additionalProperties: false });
    mergerInputSchema = typebox_exports.Object({
      version: typebox_exports.Literal(1),
      attemptId: typebox_exports.String({ minLength: 1 }),
      targetObjectId: typebox_exports.String({ pattern: oidPattern }),
      sourceObjectId: typebox_exports.String({ pattern: oidPattern }),
      materials: typebox_exports.Object({ task: materialSchema, authority: materialSchema, targetIntent: materialSchema, sourceIntent: materialSchema }, { additionalProperties: false }),
      expectedConflictPaths: typebox_exports.Array(typebox_exports.String({ minLength: 1 }), { minItems: 1 }),
      resolutionScope: typebox_exports.Array(typebox_exports.String({ minLength: 1 }), { minItems: 1 }),
      authorizedChecks: typebox_exports.Array(checkSchema)
    }, { additionalProperties: false });
    mergerOutputVariants = typebox_exports.Union([
      typebox_exports.Object({ status: typebox_exports.Literal("completed", { description: "Merge attempt completed." }), attemptId: typebox_exports.String({ minLength: 1, description: "Identity of the admitted merge attempt." }), report: typebox_exports.String({ minLength: 1, description: "Truthful merge outcome report." }), mergeCommitId: typebox_exports.String({ pattern: oidPattern, description: "Verified completed merge commit object ID." }) }, { additionalProperties: false }),
      typebox_exports.Object({ status: typebox_exports.Literal("escalate", { description: "Merge attempt requires human authority." }), attemptId: typebox_exports.String({ minLength: 1, description: "Identity of the admitted merge attempt." }), diagnosis: typebox_exports.String({ minLength: 1, description: "Reason merge completion requires escalation." }), report: typebox_exports.String({ minLength: 1, description: "Truthful merge outcome report." }) }, { additionalProperties: false })
    ]);
    mergerOutputSchema = openToolObjectFromUnion(mergerOutputVariants);
    MERGER_OUTPUT_TOOL_NAME = "ak_merger_output";
    record = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    blank = (v) => typeof v !== "string" || v.trim().length === 0;
    MergerInputContractError = class extends Error {
      constructor(message = "Merger input violates its exact contract") {
        super(message);
        this.name = "MergerInputContractError";
      }
    };
  }
});

// src/packaged-role-registry.ts
function packagedRoleMetadata(role) {
  return PACKAGED_ROLE_REGISTRY.find((entry) => entry.role === role);
}
var PACKAGED_ROLE_REGISTRY;
var init_packaged_role_registry = __esm({
  "src/packaged-role-registry.ts"() {
    "use strict";
    init_collector_output();
    init_judge_output();
    init_reviewer_output();
    init_worker_output();
    init_doctor_contracts();
    init_merger_contracts();
    PACKAGED_ROLE_REGISTRY = [
      { role: "judge", phases: [null], outputTool: JUDGE_OUTPUT_TOOL_NAME, inputFlag: void 0, phaseFlag: void 0, activationStage: "load-and-install" },
      { role: "fixer", phases: ["plan", "apply"], outputTool: FIXER_OUTPUT_TOOL_NAME, inputFlag: "ak-fix-packet", phaseFlag: "ak-fixer-phase", activationStage: "load-and-install" },
      { role: "coder", phases: ["plan", "apply"], outputTool: CODER_OUTPUT_TOOL_NAME, inputFlag: "ak-coder-task", phaseFlag: "ak-coder-phase", activationStage: "load-and-install" },
      { role: "reviewer", phases: [null], outputTool: REVIEWER_OUTPUT_TOOL_NAME, inputFlag: void 0, phaseFlag: void 0, activationStage: "load-and-install" },
      { role: "collector", phases: [null], outputTool: COLLECTOR_OUTPUT_TOOL, inputFlag: "ak-collector-repo", phaseFlag: void 0, activationStage: "load-and-install" },
      { role: "doctor", phases: [null], outputTool: DOCTOR_OUTPUT_TOOL_NAME, inputFlag: "ak-doctor-case", phaseFlag: void 0, activationStage: "load-and-install" },
      { role: "merger", phases: [null], outputTool: MERGER_OUTPUT_TOOL_NAME, inputFlag: "ak-merger-input", phaseFlag: void 0, activationStage: "prepare-git-and-install" }
    ];
  }
});

// src/public-cli/registry.ts
function publicStartupCandidates(seat) {
  return STARTUP_CANDIDATES[seat];
}
function listHelpCapabilities() {
  const support = PUBLIC_CLI_SUPPORT_COMMANDS.map((name) => ({
    kind: "support",
    name
  }));
  const roles = PACKAGED_ROLE_REGISTRY.map((entry) => {
    const phases = entry.phases;
    const defaultPhase = phases.length === 1 && phases[0] === null ? null : phases.includes("apply") ? "apply" : phases[0] ?? null;
    return {
      kind: "role",
      name: entry.role,
      phases,
      defaultPhase
    };
  });
  return [...support, ...roles];
}
function isPublicConfigurableSeat(value) {
  return PUBLIC_CONFIGURABLE_SEATS.includes(value);
}
function isPublicCliSupportCommand(value) {
  return PUBLIC_CLI_SUPPORT_COMMANDS.includes(value);
}
var INTERNAL_ROLE_ENTRYPOINT_RELATIVE, PUBLIC_CALLABLE_ROLES, AUTOMATIC_NAVIGATOR_SEAT, PUBLIC_CONFIGURABLE_SEATS, PUBLIC_CLI_SUPPORT_COMMANDS, STARTUP_CANDIDATES;
var init_registry2 = __esm({
  "src/public-cli/registry.ts"() {
    "use strict";
    init_packaged_role_registry();
    INTERNAL_ROLE_ENTRYPOINT_RELATIVE = "extensions/role-runtime.ts";
    PUBLIC_CALLABLE_ROLES = PACKAGED_ROLE_REGISTRY.map(
      (entry) => entry.role
    );
    AUTOMATIC_NAVIGATOR_SEAT = "navigator";
    PUBLIC_CONFIGURABLE_SEATS = [
      ...PUBLIC_CALLABLE_ROLES,
      AUTOMATIC_NAVIGATOR_SEAT
    ];
    PUBLIC_CLI_SUPPORT_COMMANDS = [
      "roles",
      "config",
      "help",
      "resume"
    ];
    STARTUP_CANDIDATES = {
      judge: [
        { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
        { provider: "xai", model: "grok-4.5", thinking: "high" }
      ],
      reviewer: [
        { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
        { provider: "xai", model: "grok-4.5", thinking: "high" }
      ],
      coder: [
        { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
        { provider: "xai", model: "grok-4.5", thinking: "high" }
      ],
      fixer: [
        { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
        { provider: "xai", model: "grok-4.5", thinking: "high" }
      ],
      collector: [
        { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
        { provider: "xai", model: "grok-4.5", thinking: "high" }
      ],
      doctor: [
        { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
        { provider: "xai", model: "grok-4.5", thinking: "high" }
      ],
      merger: [
        { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
        { provider: "xai", model: "grok-4.5", thinking: "high" }
      ],
      navigator: [
        { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" },
        { provider: "xai", model: "grok-4.5", thinking: "high" }
      ]
    };
  }
});

// src/public-cli/config.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
function publicCliConfigPath(home = homedir()) {
  return join2(home, ".ak-roles", "public-cli.json");
}
async function loadPublicCliConfig(home = homedir()) {
  const path = publicCliConfigPath(home);
  try {
    const raw = await readFile(path, "utf8");
    return parsePublicCliConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { seats: {} };
    }
    throw error;
  }
}
async function savePublicCliConfig(config, home = homedir()) {
  const path = publicCliConfigPath(home);
  await mkdir(dirname2(path), { recursive: true });
  const normalized = parsePublicCliConfig(config);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}
`, "utf8");
}
function setPersistentSeatConfig(config, seat, selection) {
  return {
    seats: {
      ...config.seats,
      [seat]: { ...selection }
    }
  };
}
function parseModelSpec(spec, fallbackThinking) {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("model specification must be non-empty");
  }
  const thinkingSplit = trimmed.lastIndexOf(":");
  let modelPart = trimmed;
  let thinking = fallbackThinking;
  if (thinkingSplit > 0) {
    const maybeThinking = trimmed.slice(thinkingSplit + 1);
    if (THINKING_LEVELS.has(maybeThinking)) {
      thinking = maybeThinking;
      modelPart = trimmed.slice(0, thinkingSplit);
    }
  }
  const slash = modelPart.indexOf("/");
  if (slash <= 0 || slash === modelPart.length - 1) {
    throw new Error(
      `model specification must be provider/model[:thinking], got ${spec}`
    );
  }
  const provider = modelPart.slice(0, slash);
  const model = modelPart.slice(slash + 1);
  if (!thinking) {
    throw new Error(
      `model specification requires a thinking level (provider/model:thinking), got ${spec}`
    );
  }
  return { provider, model, thinking };
}
function formatModelSpec(selection) {
  return `${selection.provider}/${selection.model}:${selection.thinking}`;
}
function parsePublicCliConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("public CLI config must be an object");
  }
  const record4 = value;
  if (record4.seats === void 0) {
    return { seats: {} };
  }
  if (record4.seats === null || typeof record4.seats !== "object" || Array.isArray(record4.seats)) {
    throw new Error("public CLI config.seats must be an object");
  }
  const seats = {};
  for (const [key, raw] of Object.entries(
    record4.seats
  )) {
    if (!PUBLIC_CONFIGURABLE_SEATS.includes(key)) {
      throw new Error(`unknown configurable seat in config: ${key}`);
    }
    seats[key] = parseSeatModelConfig(raw, key);
  }
  return { seats };
}
function parseSeatModelConfig(value, seat) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`config seat ${seat} must be an object`);
  }
  const raw = value;
  if (typeof raw.provider !== "string" || raw.provider.trim() === "") {
    throw new Error(`config seat ${seat} requires provider`);
  }
  if (typeof raw.model !== "string" || raw.model.trim() === "") {
    throw new Error(`config seat ${seat} requires model`);
  }
  if (typeof raw.thinking !== "string" || !THINKING_LEVELS.has(raw.thinking)) {
    throw new Error(`config seat ${seat} requires a valid thinking level`);
  }
  return {
    provider: raw.provider,
    model: raw.model,
    thinking: raw.thinking
  };
}
function providerConfigured(credentials, provider) {
  if (provider === "openai-codex") return credentials["openai-codex"] === true;
  if (provider === "xai") return credentials.xai === true;
  return false;
}
function missingPublicProviderCredential(provider, credentials) {
  if (provider !== "openai-codex" && provider !== "xai") return false;
  return !providerConfigured(credentials, provider);
}
function pickStartupCandidate(seat, credentials) {
  for (const candidate of publicStartupCandidates(seat)) {
    if (providerConfigured(credentials, candidate.provider)) {
      return { ...candidate };
    }
  }
  return void 0;
}
function resolveBaseSeat(config, seat, credentials) {
  const automatic = seat === AUTOMATIC_NAVIGATOR_SEAT;
  const persistent = config.seats[seat];
  if (persistent !== void 0) {
    return {
      seat,
      automatic,
      source: "persistent",
      selection: { ...persistent }
    };
  }
  const startup = pickStartupCandidate(seat, credentials);
  if (startup !== void 0) {
    return {
      seat,
      automatic,
      source: "startup",
      selection: startup
    };
  }
  return { seat, automatic, source: "unconfigured" };
}
function resolveEffectiveSeat(config, seat, credentials, invocation) {
  const automatic = seat === AUTOMATIC_NAVIGATOR_SEAT;
  const hasInvocation = invocation !== void 0 && (invocation.model !== void 0 || invocation.thinking !== void 0);
  if (!hasInvocation || invocation === void 0) {
    return resolveBaseSeat(config, seat, credentials);
  }
  if (invocation.model !== void 0) {
    const spec = invocation.model.includes(":") || invocation.thinking === void 0 ? invocation.model : `${invocation.model}:${invocation.thinking}`;
    return {
      seat,
      automatic,
      source: "invocation",
      selection: parseModelSpec(spec)
    };
  }
  const base = resolveBaseSeat(config, seat, credentials);
  if (base.selection === void 0 || invocation.thinking === void 0) {
    return { seat, automatic, source: "unconfigured" };
  }
  return {
    seat,
    automatic,
    source: "invocation",
    selection: { ...base.selection, thinking: invocation.thinking }
  };
}
function effectiveSeatConfigurations(config, credentials, invocation) {
  return PUBLIC_CONFIGURABLE_SEATS.map(
    (seat) => resolveEffectiveSeat(config, seat, credentials, invocation)
  );
}
function credentialProvidersFromAuthData(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { "openai-codex": false, xai: false };
  }
  const record4 = data;
  return {
    "openai-codex": Object.prototype.hasOwnProperty.call(record4, "openai-codex"),
    xai: Object.prototype.hasOwnProperty.call(record4, "xai")
  };
}
async function loadCredentialProviders(agentDir) {
  try {
    const raw = await readFile(join2(agentDir, "auth.json"), "utf8");
    return credentialProvidersFromAuthData(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { "openai-codex": false, xai: false };
    }
    throw error;
  }
}
var THINKING_LEVELS;
var init_config2 = __esm({
  "src/public-cli/config.ts"() {
    "use strict";
    init_registry2();
    THINKING_LEVELS = /* @__PURE__ */ new Set([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
  }
});

// src/public-cli/cli-errors.ts
var CliUsageError;
var init_cli_errors = __esm({
  "src/public-cli/cli-errors.ts"() {
    "use strict";
    CliUsageError = class extends Error {
      code = "AK_ROLE_USAGE";
      constructor(message, options) {
        super(
          message,
          options?.cause === void 0 ? void 0 : { cause: options.cause }
        );
        this.name = "CliUsageError";
      }
    };
  }
});

// src/activation-ledger-topology.ts
import {
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  realpathSync as realpathSync2,
  statSync
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename, dirname as dirname3, isAbsolute, join as join3, relative, resolve, sep } from "node:path";
function resolveActivationLedgerHome(home = homedir2) {
  const processHome = home();
  if (typeof processHome !== "string" || processHome.length === 0 || !isAbsolute(processHome)) {
    throw new ActivationLedgerError(
      `activation ledger process home must be absolute, got ${JSON.stringify(processHome)}`
    );
  }
  return resolve(processHome, ".ak-roles");
}
function activationBookDirectory(ledgerHome, bookKey) {
  return join3(ledgerHome, "books", bookKey);
}
function pathContainedIn(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function physicalPathIdentity(path) {
  const absolute = resolve(path);
  const missing = [];
  let cursor = absolute;
  while (true) {
    try {
      const real = realpathSync2(cursor);
      return missing.length === 0 ? real : join3(real, ...missing);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        return absolute;
      }
      const parent = dirname3(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}
function physicallyContainedIn(root, candidate) {
  return pathContainedIn(physicalPathIdentity(root), physicalPathIdentity(candidate));
}
function errnoCode(error) {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : void 0;
}
function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  return error.message;
}
function assertPhysicalLedgerRoot(absoluteRoot) {
  let st;
  try {
    st = lstatSync2(absoluteRoot);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw new ActivationLedgerError(
        `activation ledger failed to stat home (${absoluteRoot}): ${errorText(error)}`,
        { cause: error }
      );
    }
  }
  if (st === void 0) {
    try {
      mkdirSync2(absoluteRoot, { recursive: true });
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") {
        throw new ActivationLedgerError(
          `activation ledger failed to create home (${absoluteRoot}): ${errorText(error)}`,
          { cause: error }
        );
      }
    }
    try {
      st = lstatSync2(absoluteRoot);
    } catch (error) {
      throw new ActivationLedgerError(
        `activation ledger failed to stat home (${absoluteRoot}): ${errorText(error)}`,
        { cause: error }
      );
    }
  }
  if (st.isSymbolicLink()) {
    throw new ActivationLedgerError(
      `activation ledger home is a symbolic link: ${absoluteRoot}`
    );
  }
  if (!st.isDirectory()) {
    throw new ActivationLedgerError(`activation ledger home is not a directory: ${absoluteRoot}`);
  }
}
function ensureRealDirectoryTree(root, targetDir) {
  if (!isAbsolute(root)) {
    throw new ActivationLedgerError(`activation ledger home must be absolute: ${root}`);
  }
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(targetDir);
  if (absoluteTarget !== absoluteRoot && !pathContainedIn(absoluteRoot, absoluteTarget)) {
    throw new ActivationLedgerError(
      `activation ledger path escapes ledger home (${absoluteRoot}): ${absoluteTarget}`
    );
  }
  assertPhysicalLedgerRoot(absoluteRoot);
  let realRoot;
  try {
    realRoot = realpathSync2(absoluteRoot);
  } catch (error) {
    throw new ActivationLedgerError(
      `activation ledger home is not resolvable (${absoluteRoot}): ${errorText(error)}`,
      { cause: error }
    );
  }
  if (!statSync(realRoot).isDirectory()) {
    throw new ActivationLedgerError(`activation ledger home is not a directory: ${realRoot}`);
  }
  const rel = absoluteTarget === absoluteRoot ? "" : relative(absoluteRoot, absoluteTarget);
  if (rel === "") return realRoot;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new ActivationLedgerError(
      `activation ledger path escapes ledger home (${absoluteRoot}): ${absoluteTarget}`
    );
  }
  let lexicalCursor = absoluteRoot;
  for (const part of rel.split(sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new ActivationLedgerError(`activation ledger path contains '..': ${absoluteTarget}`);
    }
    lexicalCursor = join3(lexicalCursor, part);
    let st;
    try {
      st = lstatSync2(lexicalCursor);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw new ActivationLedgerError(
          `activation ledger failed to stat path component (${lexicalCursor}): ${errorText(error)}`,
          { cause: error }
        );
      }
      try {
        mkdirSync2(lexicalCursor);
      } catch (mkdirError) {
        if (errnoCode(mkdirError) !== "EEXIST") {
          throw new ActivationLedgerError(
            `activation ledger failed to create directory (${lexicalCursor}): ${errorText(mkdirError)}`,
            { cause: mkdirError }
          );
        }
      }
      try {
        st = lstatSync2(lexicalCursor);
      } catch (statError) {
        throw new ActivationLedgerError(
          `activation ledger failed to stat path component (${lexicalCursor}): ${errorText(statError)}`,
          { cause: statError }
        );
      }
    }
    if (st.isSymbolicLink()) {
      throw new ActivationLedgerError(
        `activation ledger path component is a symbolic link: ${lexicalCursor}`
      );
    }
    if (!st.isDirectory()) {
      throw new ActivationLedgerError(`activation ledger path component is not a directory: ${lexicalCursor}`);
    }
    let realCursor;
    try {
      realCursor = realpathSync2(lexicalCursor);
    } catch (error) {
      throw new ActivationLedgerError(
        `activation ledger path component is not resolvable (${lexicalCursor}): ${errorText(error)}`,
        { cause: error }
      );
    }
    if (realCursor !== realRoot && !pathContainedIn(realRoot, realCursor)) {
      throw new ActivationLedgerError(
        `activation ledger path component escapes ledger home (${lexicalCursor} -> ${realCursor})`
      );
    }
  }
  try {
    return realpathSync2(absoluteTarget);
  } catch (error) {
    throw new ActivationLedgerError(
      `activation ledger directory is not resolvable (${absoluteTarget}): ${errorText(error)}`,
      { cause: error }
    );
  }
}
var ActivationLedgerError;
var init_activation_ledger_topology = __esm({
  "src/activation-ledger-topology.ts"() {
    "use strict";
    ActivationLedgerError = class extends Error {
      code = "AK_ACTIVATION_LEDGER";
      constructor(message, options) {
        super(
          message,
          options?.cause === void 0 ? void 0 : { cause: options.cause }
        );
        this.name = "ActivationLedgerError";
      }
    };
  }
});

// src/activation-ledger-git.ts
import { execFileSync } from "node:child_process";
import { basename as basename2, dirname as dirname4, isAbsolute as isAbsolute2, resolve as resolve2 } from "node:path";
function envWithoutGitDiscovery(base = process.env) {
  const env = { ...base };
  for (const key of GIT_DISCOVERY_ENV_KEYS) {
    delete env[key];
  }
  return env;
}
function isGitSpawnInfrastructureError(error) {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}
function gitChildExitedNonzero(error) {
  if (error === null || typeof error !== "object" || !("status" in error)) return false;
  const status = error.status;
  return typeof status === "number" && status !== 0;
}
function resolveBookKeyFromGit(cwd) {
  let commonDir;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: envWithoutGitDiscovery()
    }).trim();
  } catch (error) {
    if (isGitSpawnInfrastructureError(error) || !gitChildExitedNonzero(error)) {
      throw error;
    }
    const err = error;
    const detail = typeof err.stderr === "string" ? err.stderr.trim() : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8").trim() : typeof err.message === "string" ? err.message : "";
    throw new ActivationGitRepositoryRequiredError(detail || "unknown git error", { cause: error });
  }
  if (commonDir.length === 0) {
    throw new Error("git rev-parse --git-common-dir returned an empty path");
  }
  const absoluteCommon = isAbsolute2(commonDir) ? commonDir : resolve2(cwd, commonDir);
  const hostDirectory = basename2(absoluteCommon) === ".git" ? dirname4(absoluteCommon) : absoluteCommon;
  const bookKey = basename2(hostDirectory);
  if (bookKey.length === 0 || bookKey === "." || bookKey === "/") {
    throw new Error(`Unable to derive activation book key from git common dir: ${absoluteCommon}`);
  }
  return bookKey;
}
var GIT_DISCOVERY_ENV_KEYS, ActivationGitRepositoryRequiredError;
var init_activation_ledger_git = __esm({
  "src/activation-ledger-git.ts"() {
    "use strict";
    GIT_DISCOVERY_ENV_KEYS = [
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_WORK_TREE",
      "GIT_CEILING_DIRECTORIES",
      "GIT_DISCOVERY_ACROSS_FILESYSTEM"
    ];
    ActivationGitRepositoryRequiredError = class extends Error {
      code = "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED";
      constructor(detail, options) {
        super(
          `Workflow role activation requires a git repository cwd (git rev-parse --git-common-dir failed): ${detail || "unknown git error"}`,
          options?.cause === void 0 ? void 0 : { cause: options.cause }
        );
        this.name = "ActivationGitRepositoryRequiredError";
      }
    };
  }
});

// src/audit-escalation.ts
function isAuditEscalationResult(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return value.kind === AUDIT_ESCALATION_KIND;
}
var AUDIT_ESCALATION_KIND;
var init_audit_escalation = __esm({
  "src/audit-escalation.ts"() {
    "use strict";
    AUDIT_ESCALATION_KIND = "audit_escalation";
  }
});

// src/package-contracts/terminating-tools.ts
function isTerminatingToolName(name) {
  return TERMINATING_TOOL_NAMES.includes(name);
}
function safeProperty(candidate, property) {
  try {
    return candidate?.[property];
  } catch {
    return void 0;
  }
}
function validateAcceptedDetails(toolName, details) {
  const candidate = details !== null && typeof details === "object" && !Array.isArray(details) ? details : void 0;
  let auditEscalation = false;
  try {
    auditEscalation = isAuditEscalationResult(details);
  } catch {
  }
  if (auditEscalation || safeProperty(candidate, "kind") === "audit_escalation") {
    throw new AcceptedDetailsContractError(
      "audit escalation is not an accepted role receipt"
    );
  }
  const discriminator = safeProperty(candidate, toolName === JUDGE_OUTPUT_TOOL_NAME ? "judgeStatus" : "status");
  const lawfulStatuses = {
    [CODER_OUTPUT_TOOL_NAME]: ["planned", "completed", "refused", "unfinished"],
    [FIXER_OUTPUT_TOOL_NAME]: ["planned", "completed", "refused", "partially_completed", "unfinished"],
    [REVIEWER_OUTPUT_TOOL_NAME]: ["completed", "refused"],
    [JUDGE_OUTPUT_TOOL_NAME]: ["converged", "continue", "escalate"],
    [COLLECTOR_OUTPUT_TOOL]: [],
    [DOCTOR_OUTPUT_TOOL_NAME]: ["completed", "refused"],
    [MERGER_OUTPUT_TOOL_NAME]: ["completed", "escalate"]
  };
  const collectorDiscriminator = toolName === COLLECTOR_OUTPUT_TOOL && Array.isArray(candidate?.groups);
  const runtimeBindingMissing = toolName === DOCTOR_OUTPUT_TOOL_NAME && discriminator === "completed" && !(candidate?.cost !== null && typeof candidate?.cost === "object") || toolName === REVIEWER_OUTPUT_TOOL_NAME && candidate?.version !== 2;
  if (runtimeBindingMissing || !collectorDiscriminator && (typeof discriminator !== "string" || !lawfulStatuses[toolName].includes(discriminator))) {
    throw new AcceptedDetailsContractError("terminating receipt has no recognized execution discriminator");
  }
  try {
    switch (toolName) {
      case CODER_OUTPUT_TOOL_NAME:
        return validateAcceptedWorkerDetails(details, "Coder");
      case FIXER_OUTPUT_TOOL_NAME:
        return validateAcceptedWorkerDetails(details, "Fixer");
      case REVIEWER_OUTPUT_TOOL_NAME:
        return validateRuntimeReviewerReceipt(details);
      case JUDGE_OUTPUT_TOOL_NAME:
        return validateAcceptedJudgeDetails(details);
      case COLLECTOR_OUTPUT_TOOL:
        return validateAcceptedCollectorReceipt(details);
      case DOCTOR_OUTPUT_TOOL_NAME:
        return validateRecordedDoctorOutput(details);
      case MERGER_OUTPUT_TOOL_NAME:
        return validateMergerOutput(details);
    }
  } catch (error) {
    if (error instanceof Error && error.constructor === Error) throw new AcceptedDetailsContractError(error.message, { cause: error });
    throw error;
  }
}
function acceptedFacts(toolName, details) {
  switch (toolName) {
    case CODER_OUTPUT_TOOL_NAME:
    case FIXER_OUTPUT_TOOL_NAME:
    case REVIEWER_OUTPUT_TOOL_NAME:
    case DOCTOR_OUTPUT_TOOL_NAME:
      return { status: details.status };
    case JUDGE_OUTPUT_TOOL_NAME:
      return { status: details.judgeStatus };
    case MERGER_OUTPUT_TOOL_NAME: {
      const output = details;
      return { status: output.status, ...output.status === "completed" && typeof output.mergeCommitId === "string" ? { commit: output.mergeCommitId } : {} };
    }
    case COLLECTOR_OUTPUT_TOOL:
      return { status: "collected" };
  }
}
var TERMINATING_TOOL_NAMES, AcceptedDetailsContractError;
var init_terminating_tools = __esm({
  "src/package-contracts/terminating-tools.ts"() {
    "use strict";
    init_collector_output();
    init_judge_output();
    init_reviewer_output();
    init_audit_escalation();
    init_doctor_contracts();
    init_merger_contracts();
    init_worker_output();
    TERMINATING_TOOL_NAMES = [
      CODER_OUTPUT_TOOL_NAME,
      FIXER_OUTPUT_TOOL_NAME,
      REVIEWER_OUTPUT_TOOL_NAME,
      JUDGE_OUTPUT_TOOL_NAME,
      COLLECTOR_OUTPUT_TOOL,
      DOCTOR_OUTPUT_TOOL_NAME,
      MERGER_OUTPUT_TOOL_NAME
    ];
    AcceptedDetailsContractError = class extends Error {
      constructor(message, options) {
        super(message, options);
        this.name = "AcceptedDetailsContractError";
      }
    };
  }
});

// src/doctor-evidence.ts
import { readdir, readFile as readFile2, realpath, stat } from "node:fs/promises";
import { dirname as dirname5, relative as relative2, resolve as resolve3, sep as sep2 } from "node:path";
function record2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function discoverCaseFiles(root) {
  const found = [];
  async function walk(dir, depth) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = resolve3(dir, item.name);
      if (item.isDirectory()) await walk(path, depth + 1);
      else if (item.isFile() && (item.name.endsWith(".jsonl") || item.name === "stderr.log" && depth === 1)) found.push(path);
    }
  }
  await walk(root, 0);
  return found.sort();
}
function sourceList(count2, sources) {
  return { count: count2, sources: [...new Set(sources)].sort() };
}
function accumulate(metric, value, source) {
  metric.count += value;
  if (value) metric.sources.push(source);
}
function timestamp(row) {
  return typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : void 0;
}
function isMissingPathError(error) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
async function stableRunsIdentity(root) {
  let cursor = root;
  while (true) {
    try {
      const git2 = await stat(resolve3(cursor, ".git"));
      if (git2.isDirectory() || git2.isFile()) return relative2(cursor, root).split(sep2).join("/");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parent = dirname5(cursor);
    if (parent === cursor) return root;
    cursor = parent;
  }
}
function deriveSession(content, id) {
  const rows = [];
  const degradationReasons = [];
  for (const line2 of content.split("\n")) if (line2.trim()) {
    try {
      const row = JSON.parse(line2);
      if (!record2(row)) {
        degradationReasons.push(`non-object session row in ${id}`);
        break;
      }
      rows.push(row);
    } catch (error) {
      if (error instanceof SyntaxError) {
        degradationReasons.push(`malformed JSON tail in ${id}: ${error.message}`);
        break;
      }
      throw error;
    }
  }
  const started = rows.find((row) => row.type === "session");
  const startedAt = started && timestamp(started);
  if (!startedAt) degradationReasons.push(`Pi session header is missing: ${id}`);
  let accepted, observedCommit, turns = 0, calls = 0, tokens = 0;
  const statuses = [], commits = [];
  for (const row of rows) {
    const message = record2(row.message) ? row.message : void 0;
    if (message?.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) if (record2(part) && part.type === "toolCall") calls++;
      if (typeof message.responseId === "string") {
        turns++;
        const usage = record2(message.usage) ? message.usage : void 0;
        if (usage && typeof usage.output === "number") tokens += usage.output;
      }
    }
    if (message?.role === "toolResult" && message.isError !== true && typeof message.toolName === "string" && isTerminatingToolName(message.toolName) && record2(message.details)) {
      let details;
      try {
        details = validateAcceptedDetails(message.toolName, message.details);
      } catch (error) {
        if (error instanceof AcceptedDetailsContractError) continue;
        throw error;
      }
      accepted = row;
      const facts = acceptedFacts(message.toolName, details);
      if (facts.commit && facts.commit !== observedCommit) {
        commits.push({ source: id, commit: facts.commit });
        observedCommit = facts.commit;
      }
      statuses.length = 0;
      if (facts.status !== void 0) {
        statuses.push({ source: id, status: facts.status });
      } else {
        statuses.push({ source: id, status: "terminating receipt has no receipt-level status" });
      }
    }
  }
  const acceptedAt = accepted && timestamp(accepted);
  const final = acceptedAt ? accepted : rows.at(-1);
  const endedAt = final && timestamp(final);
  const wall = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : void 0;
  if (wall !== void 0 && wall < 0) degradationReasons.push(`non-monotonic session timestamps in ${id}`);
  const degradationReason = degradationReasons.length ? degradationReasons.join("; ") : void 0;
  const complete = !!acceptedAt && !degradationReason && wall !== void 0 && wall >= 0;
  const session = complete ? { source: id, startedAt, endedAt, wallMilliseconds: wall, completion: "accepted" } : { source: id, ...startedAt ? { startedAt } : {}, ...endedAt ? { endedAt } : {}, ...wall !== void 0 && wall >= 0 ? { wallMilliseconds: wall } : {}, completion: "incomplete", ...degradationReason ? { degradationReason } : {} };
  return { session, turns, calls, tokens, statuses, commits };
}
async function loadDoctorCase(runsPath) {
  const root = await realpath(runsPath);
  const match = root.split(sep2).join("/").match(/\/\.ak-roles\/books\/[^/]+\/issues\/([1-9]\d*)\/runs$/);
  if (!match) throw new Error("Doctor case must be an .ak-roles/books/<book>/issues/<n>/runs directory");
  const evidence = [], sessions = [], statuses = [], commits = [];
  const turns = { count: 0, sources: [] }, calls = { count: 0, sources: [] }, tokens = { count: 0, sources: [] };
  for (const path of await discoverCaseFiles(root)) {
    const id = relative2(root, path).split(sep2).join("/");
    const bytes = await readFile2(path);
    const content = bytes.toString("utf8");
    const kind = id.endsWith(".jsonl") ? "session" : "stderr";
    evidence.push({ id, kind, byteLength: bytes.byteLength, contentLength: content.length, sha256: sha256Hex(bytes), content });
    if (kind === "stderr") continue;
    const result2 = deriveSession(content, id);
    sessions.push(result2.session);
    statuses.push(...result2.statuses);
    commits.push(...result2.commits);
    accumulate(turns, result2.turns, id);
    accumulate(calls, result2.calls, id);
    accumulate(tokens, result2.tokens, id);
  }
  const runDirs = (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
  const legs = evidence.filter((entry) => entry.kind === "session").map((entry) => entry.id);
  const retryDirs = runDirs.filter((name) => /(?:^|[-_])retry(?:[-_]|$)/i.test(name));
  const rawBytes = evidence.filter((entry) => entry.kind === "session").reduce((sum, entry) => sum + entry.byteLength, 0);
  const cost2 = { invocations: sourceList(runDirs.length, runDirs), legs: sourceList(legs.length, legs), modelApiTurns: sourceList(turns.count, turns.sources), outputTokens: sourceList(tokens.count, tokens.sources), toolCalls: sourceList(calls.count, calls.sources), retries: { ...sourceList(retryDirs.length, retryDirs), evidence: "literal run-dir naming" }, statuses, commits, sessions, outputBytes: { ...sourceList(rawBytes, legs), payload: "raw JSONL bytes", providerWireBytes: "unavailable" } };
  return { version: 1, identity: { issueNumber: Number(match[1]), runsPath: await stableRunsIdentity(root) }, evidence, cost: cost2 };
}
var init_doctor_evidence = __esm({
  "src/doctor-evidence.ts"() {
    "use strict";
    init_sha256();
    init_terminating_tools();
  }
});

// src/collector-config.ts
import { createHash as createHash2 } from "node:crypto";
import { readFile as readFile3 } from "node:fs/promises";
function fail3(message, cause) {
  throw new Error(message, cause === void 0 ? void 0 : { cause });
}
function conservativeAscii(input) {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code <= 31 || code === 127 || code > 127) return false;
  }
  return true;
}
function parseCollectorRepository(raw) {
  if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) fail3("Collector repository must be a string owner/repo");
  if (!conservativeAscii(raw) || raw.includes("://") || /[?#@%\\ ]/.test(raw)) fail3("Collector repository rejects URL syntax and non-identity bytes");
  const parts = raw.split("/");
  if (parts.length !== 2) fail3("Collector repository must contain exactly one '/' separating owner and repo");
  const [ownerDisplay, repoDisplay] = parts;
  if (!COLLECTOR_OWNER_PATTERN.test(ownerDisplay) || !COLLECTOR_REPO_PATTERN.test(repoDisplay)) fail3("Collector repository does not match the conservative owner/repo grammar");
  const owner = ownerDisplay.toLowerCase();
  const repo = repoDisplay.toLowerCase();
  return { display: raw, canonical: `${owner}/${repo}`, owner, repo };
}
function parseCollectorPrNumber(raw) {
  if (typeof raw === "string" && !/^[1-9][0-9]*$/.test(raw)) fail3("Collector pull request number must be a positive safe integer string");
  if (typeof raw !== "string" && typeof raw !== "number") fail3("Collector pull request number is required");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) fail3("Collector pull request number must be a positive safe integer");
  return value;
}
function record3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalManifest(requests) {
  return `${JSON.stringify({ requests: requests.map((request) => ({ id: request.id, body: request.requestBody })) })}
`;
}
function emptyCollectorManifest() {
  const canonicalJson2 = canonicalManifest([]);
  return { requests: [], canonicalJson: canonicalJson2, digest: createHash2("sha256").update(canonicalJson2).digest("hex") };
}
async function loadCollectorManifest(path) {
  let bytes;
  try {
    bytes = await readFile3(path);
  } catch (error) {
    fail3(`Collector request manifest is unreadable at ${path}`, error);
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail3("Collector request manifest must be UTF-8 JSON", error);
  }
  if (!record3(parsed)) fail3("Collector request manifest must be an object");
  const rawRequests = parsed.requests ?? [];
  if (!Array.isArray(rawRequests)) fail3("Collector request manifest requests must be an array");
  const requests = [];
  const ids = /* @__PURE__ */ new Set();
  for (const [index, item] of rawRequests.entries()) {
    if (!record3(item) || typeof item.id !== "string" || item.id.length === 0 || typeof item.body !== "string" || item.body.trim() === "") fail3(`Collector request manifest requests[${index}] is invalid`);
    if (ids.has(item.id)) fail3(`Collector request manifest has duplicate request id "${item.id}"`);
    ids.add(item.id);
    requests.push({ id: item.id, requestBody: item.body });
  }
  const canonicalJson2 = canonicalManifest(requests);
  return { requests, canonicalJson: canonicalJson2, digest: createHash2("sha256").update(canonicalJson2).digest("hex"), sourcePath: path };
}
var COLLECTOR_OWNER_PATTERN, COLLECTOR_REPO_PATTERN, COLLECTOR_FIXED_KICKOFF;
var init_collector_config = __esm({
  "src/collector-config.ts"() {
    "use strict";
    COLLECTOR_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
    COLLECTOR_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
    COLLECTOR_FIXED_KICKOFF = "Start collection for the validated runtime-owned target. Observe GitHub materials and submit exactly one ak_collector_output when observation is complete.";
  }
});

// src/merger-git-state.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  return new Uint8Array(stdout);
}
function line(bytes, label) {
  const value = exactUtf8(bytes, label).trim();
  if (!value) throw new Error(`${label} is empty`);
  return value;
}
function nulPaths(bytes, label) {
  const raw = exactUtf8(bytes, label);
  if (raw.length > 0 && !raw.endsWith("\0")) throw new Error(`${label} is not NUL terminated`);
  return raw.split("\0").filter(Boolean).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
async function unmerged(cwd) {
  const raw = exactUtf8(await git(cwd, ["ls-files", "-u", "-z"]), "Git unmerged index");
  const paths = /* @__PURE__ */ new Set();
  for (const row of raw.split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("	");
    if (tab < 0 || tab === row.length - 1) throw new Error("Git returned a malformed unmerged index row");
    paths.add(row.slice(tab + 1));
  }
  return [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
function createProductionMergerGitState(repositoryRoot = process.cwd()) {
  return {
    async activeMerge() {
      const targetObjectId = line(await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]), "Git HEAD");
      let mergeHeadRaw;
      try {
        mergeHeadRaw = await git(repositoryRoot, ["rev-parse", "--verify", "MERGE_HEAD"]);
      } catch {
        throw new Error("Assigned repository does not have one ordinary in-progress merge");
      }
      const mergeHeads = exactUtf8(mergeHeadRaw, "Git MERGE_HEAD").trim().split(/\r?\n/).filter(Boolean);
      if (mergeHeads.length !== 1 || !isFullGitObjectId(targetObjectId) || !isFullGitObjectId(mergeHeads[0]) || targetObjectId.length !== mergeHeads[0].length) throw new Error("Assigned repository does not have one ordinary in-progress merge");
      let automaticMergeTreeRaw;
      try {
        automaticMergeTreeRaw = await git(repositoryRoot, ["rev-parse", "--verify", "AUTO_MERGE^{tree}"]);
      } catch {
        throw new Error("Git automatic merge tree identity is unavailable or invalid");
      }
      const automaticMergeTreeId = line(automaticMergeTreeRaw, "Git automatic merge tree");
      if (!isFullGitObjectId(automaticMergeTreeId) || automaticMergeTreeId.length !== targetObjectId.length) throw new Error("Git automatic merge tree identity is unavailable or invalid");
      return { targetObjectId, sourceObjectId: mergeHeads[0], unmergedPaths: await unmerged(repositoryRoot), automaticMergeTreeId };
    },
    async completedMerge(mergeCommitId, automaticMergeTreeId) {
      if (!isFullGitObjectId(mergeCommitId) || !isFullGitObjectId(automaticMergeTreeId) || mergeCommitId.length !== automaticMergeTreeId.length) throw new Error("Merger completion object ID is invalid");
      const identity = exactUtf8(await git(repositoryRoot, ["show", "-s", "--format=%H%x00%P", mergeCommitId]), "Git merge commit").trimEnd().split("\0");
      if (identity.length !== 2 || identity[0] !== mergeCommitId) throw new Error("Git merge completion identity drifted");
      const parentObjectIds = identity[1].split(" ").filter(Boolean);
      const currentHead = line(await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]), "Git HEAD");
      const status = await git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const frozenTree = line(await git(repositoryRoot, ["rev-parse", "--verify", `${automaticMergeTreeId}^{tree}`]), "Git frozen automatic merge tree");
      if (frozenTree !== automaticMergeTreeId) throw new Error("Git frozen automatic merge tree identity drifted");
      const mergeTree = line(await git(repositoryRoot, ["rev-parse", "--verify", `${mergeCommitId}^{tree}`]), "Git completed merge tree");
      const resolutionChangedPaths = nulPaths(await git(repositoryRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", automaticMergeTreeId, mergeTree]), "Git resolution path delta");
      return { mergeCommitId: currentHead, parentObjectIds, unmergedPaths: await unmerged(repositoryRoot), worktreeClean: status.byteLength === 0 && currentHead === mergeCommitId, resolutionChangedPaths };
    }
  };
}
var execFileAsync;
var init_merger_git_state = __esm({
  "src/merger-git-state.ts"() {
    "use strict";
    init_exact_utf8();
    init_git_object_id();
    execFileAsync = promisify(execFile);
  }
});

// src/uuidv7.ts
import { randomBytes } from "node:crypto";
function isUuidV7(value) {
  return typeof value === "string" && UUIDV7.test(value);
}
function uuidv7(now = Date.now()) {
  const b = randomBytes(16);
  let n = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(n & 255n);
    n >>= 8n;
  }
  b[6] = b[6] & 15 | 112;
  b[8] = b[8] & 63 | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
var UUIDV7;
var init_uuidv7 = __esm({
  "src/uuidv7.ts"() {
    "use strict";
    UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  }
});

// src/public-cli/invocation.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import {
  lstat,
  mkdir as mkdir2,
  readFile as readFile4,
  realpath as realpath2,
  writeFile as writeFile2
} from "node:fs/promises";
import { basename as basename3, isAbsolute as isAbsolute3, join as join4, resolve as resolve4, sep as sep3 } from "node:path";
function roleRunSessionFile(sessionDirectory) {
  return join4(sessionDirectory, ROLE_RUN_SESSION_FILE_NAME);
}
async function writeRoleInvocationLedger(source, role) {
  const identity = {
    role,
    runId: source.runId,
    bookKey: source.bookKey,
    projectRoot: source.projectRoot,
    runDirectory: source.runDirectory,
    sessionDirectory: source.sessionDirectory,
    sessionFile: source.sessionFile
  };
  await writeFile2(
    join4(source.runDirectory, "invocation.json"),
    `${JSON.stringify(identity, null, 2)}
`,
    "utf8"
  );
}
async function mergeInvocationIdentityPage(runDirectory, fields) {
  const ledgerPath = join4(runDirectory, "invocation.json");
  const current = JSON.parse(await readFile4(ledgerPath, "utf8"));
  await writeFile2(
    ledgerPath,
    `${JSON.stringify({
      ...current,
      ...fields
    }, null, 2)}
`,
    "utf8"
  );
}
async function recordLaunchedPiIdentity(runDirectory, identity) {
  await mergeInvocationIdentityPage(runDirectory, {
    piExecutable: identity.executable,
    piVersion: identity.version
  });
}
async function observeLaunchedRolePackageIdentity(packageRoot2, selectedRoleEntry) {
  const rolePackageRoot = await realpath2(packageRoot2);
  const raw = JSON.parse(
    await readFile4(join4(rolePackageRoot, "package.json"), "utf8")
  );
  if (typeof raw.version !== "string" || raw.version.trim() === "") {
    throw new Error(
      `role package.json at ${rolePackageRoot} does not declare a nonblank version`
    );
  }
  return {
    roleEntry: selectedRoleEntry,
    rolePackageRoot,
    rolePackageVersion: raw.version,
    entryMode: "public-cli"
  };
}
async function recordLaunchedRolePackageIdentity(runDirectory, identity) {
  await mergeInvocationIdentityPage(runDirectory, {
    roleEntry: identity.roleEntry,
    rolePackageRoot: identity.rolePackageRoot,
    rolePackageVersion: identity.rolePackageVersion,
    entryMode: identity.entryMode
  });
}
function requireOptionPath(flag, value) {
  if (value === void 0 || value.trim() === "") {
    throw new CliUsageError(
      flag === "--base" ? `${flag} requires a nonempty revision` : `${flag} requires a path`
    );
  }
  return value;
}
function parseJudgeArgv(args) {
  const attachmentPaths = [];
  let project;
  const positional = [];
  const tokens = [...args];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--") {
      positional.push(...tokens);
      break;
    }
    if (token === "--attach") {
      attachmentPaths.push(requireOptionPath("--attach", tokens.shift()));
      continue;
    }
    if (token.startsWith("--attach=")) {
      attachmentPaths.push(
        requireOptionPath("--attach", token.slice("--attach=".length))
      );
      continue;
    }
    if (token === "--project") {
      project = requireOptionPath("--project", tokens.shift());
      continue;
    }
    if (token.startsWith("--project=")) {
      project = requireOptionPath("--project", token.slice("--project=".length));
      continue;
    }
    if (token === "--burden" || token.startsWith("--burden=") || token === "--ak-judge-burden" || token.startsWith("--ak-judge-burden=") || token === "--judge-burden" || token.startsWith("--judge-burden=")) {
      throw new CliUsageError(
        "judge does not accept a public burden selector; Judge infers its own burden"
      );
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown judge option: ${token}`);
    }
    positional.push(token);
  }
  return {
    instruction: positional.join(" "),
    attachmentPaths,
    ...project === void 0 ? {} : { project }
  };
}
function parseCoderArgv(args) {
  const attachmentPaths = [];
  let project;
  const positional = [];
  const tokens = [...args];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--") {
      positional.push(...tokens);
      break;
    }
    if (token === "--attach") {
      attachmentPaths.push(requireOptionPath("--attach", tokens.shift()));
      continue;
    }
    if (token.startsWith("--attach=")) {
      attachmentPaths.push(
        requireOptionPath("--attach", token.slice("--attach=".length))
      );
      continue;
    }
    if (token === "--project") {
      project = requireOptionPath("--project", tokens.shift());
      continue;
    }
    if (token.startsWith("--project=")) {
      project = requireOptionPath("--project", token.slice("--project=".length));
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown coder option: ${token}`);
    }
    positional.push(token);
  }
  let phase = "apply";
  if (positional[0] === "plan" || positional[0] === "apply") {
    phase = positional.shift();
  }
  return {
    phase,
    instruction: positional.join(" "),
    attachmentPaths,
    ...project === void 0 ? {} : { project }
  };
}
function parseFixerArgv(args) {
  const attachmentPaths = [];
  let project;
  let prerequisitesPath;
  const positional = [];
  const tokens = [...args];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--") {
      positional.push(...tokens);
      break;
    }
    if (token === "--attach") {
      attachmentPaths.push(requireOptionPath("--attach", tokens.shift()));
      continue;
    }
    if (token.startsWith("--attach=")) {
      attachmentPaths.push(
        requireOptionPath("--attach", token.slice("--attach=".length))
      );
      continue;
    }
    if (token === "--project") {
      project = requireOptionPath("--project", tokens.shift());
      continue;
    }
    if (token.startsWith("--project=")) {
      project = requireOptionPath("--project", token.slice("--project=".length));
      continue;
    }
    if (token === "--prerequisites") {
      prerequisitesPath = requireOptionPath("--prerequisites", tokens.shift());
      continue;
    }
    if (token.startsWith("--prerequisites=")) {
      prerequisitesPath = requireOptionPath(
        "--prerequisites",
        token.slice("--prerequisites=".length)
      );
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown fixer option: ${token}`);
    }
    positional.push(token);
  }
  let phase = "apply";
  if (positional[0] === "plan" || positional[0] === "apply") {
    phase = positional.shift();
  }
  return {
    phase,
    instruction: positional.join(" "),
    attachmentPaths,
    ...prerequisitesPath === void 0 ? {} : { prerequisitesPath },
    ...project === void 0 ? {} : { project }
  };
}
async function freezeRegularFileAttachment(sourcePath, destinationDir, index) {
  const absolute = isAbsolute3(sourcePath) ? sourcePath : resolve4(sourcePath);
  let st;
  try {
    st = await lstat(absolute);
  } catch (error) {
    throw new CliUsageError(
      `attachment is not a readable regular file: ${sourcePath}`,
      { cause: error }
    );
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new CliUsageError(
      `attachment must be a regular file (not a directory or symlink): ${sourcePath}`
    );
  }
  const bytes = await readFile4(absolute);
  const name = `${String(index).padStart(2, "0")}-${basename3(absolute)}`;
  const frozenPath = join4(destinationDir, name);
  await writeFile2(frozenPath, bytes);
  return {
    provenancePath: absolute,
    frozenPath,
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    mediaKind: "regular-file"
  };
}
async function admitJudgeInvocation(options) {
  if (options.project !== void 0) {
    requireOptionPath("--project", options.project);
  }
  const projectRoot = resolve4(options.project ?? options.cwd);
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join4(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@judge`
  );
  const sessionDirectory = join4(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join4(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);
  const attachments = [];
  for (let i = 0; i < options.attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        options.attachmentPaths[i],
        attachmentsDirectory,
        i
      )
    );
  }
  const instruction = options.instruction;
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "judge",
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    instruction,
    instructionEmpty,
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind
    }))
  };
  const admittedRequestPath = join4(runDirectory, "admitted-request.json");
  await writeFile2(admittedRequestPath, `${JSON.stringify(admitted, null, 2)}
`, "utf8");
  await writeRoleInvocationLedger(admitted, admitted.role);
  return {
    role: "judge",
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty,
    attachments,
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath
  };
}
function buildJudgeTransportPrompt(admitted) {
  const lines = [admitted.instructionEmpty ? "" : admitted.instruction];
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("Admitted Attachments (frozen snapshot paths; read these bytes):");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return lines.join("\n");
}
async function ensureRunArtifactsDir(runDirectory) {
  const dir = join4(runDirectory, "artifacts");
  await mkdir2(dir, { recursive: true });
  return dir;
}
async function admitCoderInvocation(options) {
  if (options.project !== void 0) {
    requireOptionPath("--project", options.project);
  }
  const instruction = options.instruction;
  if (instruction.trim() === "") {
    throw new CliUsageError(
      "coder requires a nonblank task instruction"
    );
  }
  if (options.phase !== "plan" && options.phase !== "apply") {
    throw new CliUsageError("coder phase must be plan or apply");
  }
  const projectRoot = resolve4(options.project ?? options.cwd);
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join4(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@coder`
  );
  const sessionDirectory = join4(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join4(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);
  const attachments = [];
  for (let i = 0; i < options.attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        options.attachmentPaths[i],
        attachmentsDirectory,
        i
      )
    );
  }
  const taskPath = join4(runDirectory, "task.md");
  await writeFile2(taskPath, instruction, "utf8");
  const admitted = {
    role: "coder",
    phase: options.phase,
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    instruction,
    instructionEmpty: false,
    taskPath,
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind
    }))
  };
  const admittedRequestPath = join4(runDirectory, "admitted-request.json");
  await writeFile2(admittedRequestPath, `${JSON.stringify(admitted, null, 2)}
`, "utf8");
  await writeRoleInvocationLedger(admitted, admitted.role);
  return {
    role: "coder",
    phase: options.phase,
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty: false,
    attachments,
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
    taskPath
  };
}
function buildCoderTransportPrompt(admitted) {
  const lines = [admitted.instruction];
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("Admitted Attachments (frozen snapshot paths; read these bytes):");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return lines.join("\n");
}
async function admitFixerInvocation(options) {
  if (options.project !== void 0) {
    requireOptionPath("--project", options.project);
  }
  const instruction = options.instruction;
  if (instruction.trim() === "") {
    throw new CliUsageError(
      "fixer requires a nonblank repair instruction"
    );
  }
  if (options.phase !== "plan" && options.phase !== "apply") {
    throw new CliUsageError("fixer phase must be plan or apply");
  }
  const projectRoot = resolve4(options.project ?? options.cwd);
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join4(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@fixer`
  );
  const sessionDirectory = join4(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join4(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);
  const attachments = [];
  for (let i = 0; i < options.attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        options.attachmentPaths[i],
        attachmentsDirectory,
        i
      )
    );
  }
  let prerequisites = Object.freeze([]);
  let prerequisitesPath;
  if (options.prerequisitesPath !== void 0) {
    const absolutePrereq = isAbsolute3(options.prerequisitesPath) ? options.prerequisitesPath : resolve4(options.prerequisitesPath);
    let source;
    try {
      source = await readFile4(absolutePrereq, "utf8");
    } catch (error) {
      throw new CliUsageError(
        `fixer prerequisites path is unreadable: ${options.prerequisitesPath}`,
        { cause: error }
      );
    }
    try {
      prerequisites = parseFixerPrerequisites(source);
    } catch (error) {
      if (error instanceof FixerPacketValidationError) {
        throw new CliUsageError(error.message, { cause: error });
      }
      throw error;
    }
    prerequisitesPath = join4(runDirectory, "prerequisites.json");
    await writeFile2(
      prerequisitesPath,
      `${JSON.stringify(prerequisites, null, 2)}
`,
      "utf8"
    );
  }
  const packetPath = join4(runDirectory, "fix-packet.md");
  await writeFile2(packetPath, instruction, "utf8");
  const admitted = {
    role: "fixer",
    phase: options.phase,
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    instruction,
    instructionEmpty: false,
    packetPath,
    ...prerequisitesPath === void 0 ? {} : { prerequisitesPath },
    prerequisites: prerequisites.map((entry) => ({
      id: entry.id,
      requirement: entry.requirement
    })),
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind
    }))
  };
  const admittedRequestPath = join4(runDirectory, "admitted-request.json");
  await writeFile2(admittedRequestPath, `${JSON.stringify(admitted, null, 2)}
`, "utf8");
  await writeRoleInvocationLedger(admitted, admitted.role);
  return {
    role: "fixer",
    phase: options.phase,
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty: false,
    attachments,
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
    packetPath,
    ...prerequisitesPath === void 0 ? {} : { prerequisitesPath },
    prerequisites
  };
}
function buildFixerTransportPrompt(admitted) {
  const lines = [admitted.instruction];
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("Admitted Attachments (frozen snapshot paths; read these bytes):");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return lines.join("\n");
}
function parsePositivePrOption(raw) {
  if (raw === void 0 || raw.trim() === "") throw new CliUsageError("--pr requires a positive pull request number");
  try {
    return parseCollectorPrNumber(raw);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
function parseRepoOption(raw) {
  if (raw === void 0 || raw.trim() === "") throw new CliUsageError("--repo requires owner/repo");
  return raw;
}
function parseCollectorArgv(args) {
  const attachmentPaths = [];
  let project;
  let repo;
  let prNumber;
  let requestManifestPath;
  const positional = [];
  const tokens = [...args];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--") {
      positional.push(...tokens);
      break;
    }
    if (token === "--attach") {
      attachmentPaths.push(requireOptionPath("--attach", tokens.shift()));
      continue;
    }
    if (token.startsWith("--attach=")) {
      attachmentPaths.push(requireOptionPath("--attach", token.slice(9)));
      continue;
    }
    if (token === "--project") {
      project = requireOptionPath("--project", tokens.shift());
      continue;
    }
    if (token.startsWith("--project=")) {
      project = requireOptionPath("--project", token.slice(10));
      continue;
    }
    if (token === "--pr") {
      prNumber = parsePositivePrOption(tokens.shift());
      continue;
    }
    if (token.startsWith("--pr=")) {
      prNumber = parsePositivePrOption(token.slice(5));
      continue;
    }
    if (token === "--repo") {
      repo = parseRepoOption(tokens.shift());
      continue;
    }
    if (token.startsWith("--repo=")) {
      repo = parseRepoOption(token.slice(7));
      continue;
    }
    if (token === "--request-manifest") {
      requestManifestPath = requireOptionPath("--request-manifest", tokens.shift());
      continue;
    }
    if (token.startsWith("--request-manifest=")) {
      requestManifestPath = requireOptionPath("--request-manifest", token.slice(19));
      continue;
    }
    if (token.startsWith("-") && token !== "-") throw new CliUsageError(`unknown collector option: ${token}`);
    positional.push(token);
  }
  if (prNumber === void 0) throw new CliUsageError("collector requires --pr <positive-integer>");
  return { prNumber, instruction: positional.join(" "), attachmentPaths, ...project === void 0 ? {} : { project }, ...repo === void 0 ? {} : { repo }, ...requestManifestPath === void 0 ? {} : { requestManifestPath } };
}
function resolveGitHubRemoteRepository(projectRoot) {
  let remoteUrl;
  try {
    remoteUrl = execFileSync2("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    throw new CliUsageError(
      "collector requires a github.com origin remote or an explicit --repo owner/repo",
      { cause: error }
    );
  }
  if (remoteUrl.length === 0) {
    throw new CliUsageError(
      "collector requires a github.com origin remote or an explicit --repo owner/repo"
    );
  }
  const ownerRepo = ownerRepoFromGitHubRemoteUrl(remoteUrl);
  if (ownerRepo === void 0) {
    throw new CliUsageError(
      `collector origin remote must be a github.com owner/repo URL, got ${remoteUrl}`
    );
  }
  try {
    return parseCollectorRepository(ownerRepo);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(detail, { cause: error });
  }
}
function ownerRepoFromGitHubRemoteUrl(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) {
    return `${scp[1]}/${stripGitSuffix(scp[2])}`;
  }
  const ssh = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    trimmed
  );
  if (ssh) {
    return `${ssh[1]}/${stripGitSuffix(ssh[2])}`;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return void 0;
  }
  if (!/^github\.com$/i.test(parsed.hostname)) return void 0;
  if (parsed.search !== "" || parsed.hash !== "") return void 0;
  const parts = parsed.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) return void 0;
  return `${parts[0]}/${stripGitSuffix(parts[1])}`;
}
function stripGitSuffix(name) {
  return name.toLowerCase().endsWith(".git") ? name.slice(0, -4) : name;
}
async function admitCollectorInvocation(options) {
  if (options.project !== void 0) {
    requireOptionPath("--project", options.project);
  }
  let prNumber;
  try {
    prNumber = parseCollectorPrNumber(options.prNumber);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(detail, { cause: error });
  }
  const projectRoot = resolve4(options.project ?? options.cwd);
  let repository;
  if (options.repo !== void 0) {
    try {
      repository = parseCollectorRepository(options.repo);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliUsageError(detail, { cause: error });
    }
  } else {
    repository = resolveGitHubRemoteRepository(projectRoot);
  }
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join4(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@collector`
  );
  const sessionDirectory = join4(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join4(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);
  const attachments = [];
  const attachmentPaths = options.attachmentPaths ?? [];
  for (let i = 0; i < attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        attachmentPaths[i],
        attachmentsDirectory,
        i
      )
    );
  }
  let manifest = emptyCollectorManifest();
  let requestManifestPath;
  if (options.requestManifestPath !== void 0) {
    try {
      manifest = await loadCollectorManifest(options.requestManifestPath);
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    requestManifestPath = join4(runDirectory, "request-manifest.json");
    await writeFile2(requestManifestPath, manifest.canonicalJson, "utf8");
  }
  const manifestDigest = manifest.digest;
  const instruction = options.instruction ?? "";
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "collector",
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    instruction,
    instructionEmpty,
    prNumber,
    repository: repository.canonical,
    repositoryDisplay: repository.display,
    ...requestManifestPath === void 0 ? {} : { requestManifestPath },
    manifestDigest,
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind
    }))
  };
  const admittedRequestPath = join4(runDirectory, "admitted-request.json");
  await writeFile2(
    admittedRequestPath,
    `${JSON.stringify(admitted, null, 2)}
`,
    "utf8"
  );
  await writeRoleInvocationLedger(admitted, admitted.role);
  return {
    role: "collector",
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty,
    attachments,
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
    prNumber,
    repository,
    ...requestManifestPath === void 0 ? {} : { requestManifestPath },
    manifestDigest
  };
}
function buildCollectorTransportPrompt(_admitted) {
  return COLLECTOR_FIXED_KICKOFF;
}
function parseDoctorIssueNumber(raw) {
  const trimmed = raw.trim();
  if (!DOCTOR_ISSUE_NUMBER_PATTERN.test(trimmed)) {
    throw new CliUsageError(
      `doctor --issue must be a positive integer, got ${raw}`
    );
  }
  return Number(trimmed);
}
function parseDoctorArgv(args) {
  const attachmentPaths = [];
  let project;
  let issueRaw;
  let runs;
  const positional = [];
  const tokens = [...args];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--") {
      positional.push(...tokens);
      break;
    }
    if (token === "--issue") {
      const value = tokens.shift();
      if (value === void 0 || value.trim() === "") {
        throw new CliUsageError("doctor --issue requires a positive integer");
      }
      issueRaw = value;
      continue;
    }
    if (token.startsWith("--issue=")) {
      issueRaw = token.slice("--issue=".length);
      if (issueRaw.trim() === "") {
        throw new CliUsageError("doctor --issue requires a positive integer");
      }
      continue;
    }
    if (token === "--runs") {
      const value = tokens.shift();
      if (value === void 0 || value.trim() === "") {
        throw new CliUsageError("doctor --runs requires a path");
      }
      runs = value;
      continue;
    }
    if (token.startsWith("--runs=")) {
      const value = token.slice("--runs=".length);
      if (value.trim() === "") {
        throw new CliUsageError("doctor --runs requires a path");
      }
      runs = value;
      continue;
    }
    if (token === "--attach") {
      attachmentPaths.push(requireOptionPath("--attach", tokens.shift()));
      continue;
    }
    if (token.startsWith("--attach=")) {
      attachmentPaths.push(
        requireOptionPath("--attach", token.slice("--attach=".length))
      );
      continue;
    }
    if (token === "--project") {
      project = requireOptionPath("--project", tokens.shift());
      continue;
    }
    if (token.startsWith("--project=")) {
      project = requireOptionPath("--project", token.slice("--project=".length));
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown doctor option: ${token}`);
    }
    positional.push(token);
  }
  if (issueRaw === void 0) {
    throw new CliUsageError("doctor requires --issue <positive-integer>");
  }
  const issueNumber = parseDoctorIssueNumber(issueRaw);
  if (runs !== void 0 && runs.trim() === "") {
    throw new CliUsageError("doctor --runs requires a path");
  }
  return {
    issueNumber,
    instruction: positional.join(" "),
    attachmentPaths,
    ...project === void 0 ? {} : { project },
    ...runs === void 0 ? {} : { runs }
  };
}
async function resolveDoctorCaseRunsPath(options) {
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const defaultRuns = join4(
    activationBookDirectory(ledgerHome, options.bookKey),
    "issues",
    String(options.issueNumber),
    "runs"
  );
  if (options.runs === void 0) {
    return defaultRuns;
  }
  const raw = options.runs.trim();
  if (raw === "") {
    throw new CliUsageError("doctor --runs requires a path");
  }
  if (isAbsolute3(raw)) {
    throw new CliUsageError(
      "doctor --runs must be a project-relative path"
    );
  }
  const resolved = resolve4(options.projectRoot, raw);
  if (resolved !== options.projectRoot && !pathContainedIn(options.projectRoot, resolved)) {
    throw new CliUsageError(
      "doctor --runs escapes the project root"
    );
  }
  let real;
  try {
    real = await realpath2(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(
      `doctor --runs is not a readable retained runs root: ${detail}`,
      { cause: error }
    );
  }
  const normalized = real.split(sep3).join("/");
  const match = normalized.match(DOCTOR_CASE_RUNS_PATH_PATTERN);
  if (!match) {
    throw new CliUsageError(
      "doctor --runs must be an .ak-roles/books/<book>/issues/<n>/runs directory"
    );
  }
  if (Number(match[1]) !== options.issueNumber) {
    throw new CliUsageError(
      `doctor --runs issue ${match[1]} does not match --issue ${options.issueNumber}`
    );
  }
  return real;
}
async function admitDoctorInvocation(options) {
  if (options.project !== void 0) {
    requireOptionPath("--project", options.project);
  }
  if (!Number.isInteger(options.issueNumber) || options.issueNumber < 1 || !DOCTOR_ISSUE_NUMBER_PATTERN.test(String(options.issueNumber))) {
    throw new CliUsageError(
      `doctor --issue must be a positive integer, got ${options.issueNumber}`
    );
  }
  const projectRoot = resolve4(options.project ?? options.cwd);
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  let caseRunsPath;
  try {
    caseRunsPath = await resolveDoctorCaseRunsPath({
      home: options.home,
      projectRoot,
      bookKey,
      issueNumber: options.issueNumber,
      ...options.runs === void 0 ? {} : { runs: options.runs }
    });
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(detail, { cause: error });
  }
  if (options.runs === void 0) {
    ensureRealDirectoryTree(ledgerHome, caseRunsPath);
  }
  let caseIdentity2;
  try {
    const patient = await loadDoctorCase(caseRunsPath);
    if (patient.identity.issueNumber !== options.issueNumber) {
      throw new CliUsageError(
        `doctor case issue ${patient.identity.issueNumber} does not match --issue ${options.issueNumber}`
      );
    }
    caseIdentity2 = patient.identity;
    caseRunsPath = await realpath2(caseRunsPath);
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(
      `doctor case could not be constructed from retained evidence: ${detail}`,
      { cause: error }
    );
  }
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join4(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@doctor`
  );
  const sessionDirectory = join4(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join4(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);
  const attachments = [];
  const attachmentPaths = options.attachmentPaths ?? [];
  for (let i = 0; i < attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        attachmentPaths[i],
        attachmentsDirectory,
        i
      )
    );
  }
  const instruction = options.instruction ?? "";
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "doctor",
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    instruction,
    instructionEmpty,
    issueNumber: options.issueNumber,
    caseRunsPath,
    caseIdentity: caseIdentity2,
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind
    }))
  };
  const admittedRequestPath = join4(runDirectory, "admitted-request.json");
  await writeFile2(
    admittedRequestPath,
    `${JSON.stringify(admitted, null, 2)}
`,
    "utf8"
  );
  await writeRoleInvocationLedger(admitted, admitted.role);
  return {
    role: "doctor",
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty,
    attachments,
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
    issueNumber: options.issueNumber,
    caseRunsPath,
    caseIdentity: caseIdentity2
  };
}
function buildDoctorTransportPrompt(admitted) {
  const lines = [admitted.instructionEmpty ? "" : admitted.instruction];
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("Admitted Attachments (frozen snapshot paths; read these bytes):");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return lines.join("\n");
}
function parseReviewerArgv(args) {
  const attachmentPaths = [];
  let project;
  let baseRevision;
  const positional = [];
  const tokens = [...args];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--") {
      positional.push(...tokens);
      break;
    }
    if (token === "--project") {
      project = requireOptionPath("--project", tokens.shift());
      continue;
    }
    if (token.startsWith("--project=")) {
      project = requireOptionPath("--project", token.slice("--project=".length));
      continue;
    }
    if (token === "--base") {
      baseRevision = requireOptionPath("--base", tokens.shift());
      continue;
    }
    if (token.startsWith("--base=")) {
      baseRevision = requireOptionPath("--base", token.slice("--base=".length));
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown reviewer option: ${token}`);
    }
    positional.push(token);
  }
  if (baseRevision === void 0) {
    throw new CliUsageError("reviewer requires --base <revision>; canonical code-review requires the caller to select a fixed point");
  }
  return {
    instruction: positional.join(" "),
    attachmentPaths,
    baseRevision,
    ...project === void 0 ? {} : { project }
  };
}
async function admitReviewerInvocation(options) {
  if (options.project !== void 0) {
    requireOptionPath("--project", options.project);
  }
  if (options.baseRevision.trim() === "") {
    throw new CliUsageError("--base requires a nonempty revision");
  }
  const projectRoot = resolve4(options.project ?? options.cwd);
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join4(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@reviewer`
  );
  const sessionDirectory = join4(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join4(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);
  const attachments = [];
  for (let i = 0; i < options.attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        options.attachmentPaths[i],
        attachmentsDirectory,
        i
      )
    );
  }
  const instruction = options.instruction;
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "reviewer",
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    instruction,
    instructionEmpty,
    baseRevision: options.baseRevision,
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind
    }))
  };
  const admittedRequestPath = join4(runDirectory, "admitted-request.json");
  await writeFile2(
    admittedRequestPath,
    `${JSON.stringify(admitted, null, 2)}
`,
    "utf8"
  );
  await writeRoleInvocationLedger(admitted, admitted.role);
  return {
    role: "reviewer",
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty,
    attachments,
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
    baseRevision: options.baseRevision
  };
}
function buildReviewerTransportPrompt(admitted) {
  return [
    `Base revision for the fixed review target: ${admitted.baseRevision}`,
    "Use this exact revision as the fixed review point."
  ].join("\n");
}
function parseMergerArgv(args) {
  const attachmentPaths = [];
  let project;
  const positional = [];
  const tokens = [...args];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--") {
      positional.push(...tokens);
      break;
    }
    if (token === "--attach") {
      attachmentPaths.push(requireOptionPath("--attach", tokens.shift()));
      continue;
    }
    if (token.startsWith("--attach=")) {
      attachmentPaths.push(
        requireOptionPath("--attach", token.slice("--attach=".length))
      );
      continue;
    }
    if (token === "--project") {
      project = requireOptionPath("--project", tokens.shift());
      continue;
    }
    if (token.startsWith("--project=")) {
      project = requireOptionPath("--project", token.slice("--project=".length));
      continue;
    }
    if (token === "--ak-merger-input" || token.startsWith("--ak-merger-input=") || token === "--targetObjectId" || token.startsWith("--targetObjectId=") || token === "--sourceObjectId" || token.startsWith("--sourceObjectId=") || token === "--expectedConflictPaths" || token.startsWith("--expectedConflictPaths=") || token === "--resolutionScope" || token.startsWith("--resolutionScope=")) {
      throw new CliUsageError(
        "merger does not accept public packet fields; the adapter derives the active-merge envelope"
      );
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown merger option: ${token}`);
    }
    positional.push(token);
  }
  return {
    instruction: positional.join(" "),
    attachmentPaths,
    ...project === void 0 ? {} : { project }
  };
}
function mergerMaterialFromUtf8(text) {
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({
    bytesBase64: bytes.toString("base64"),
    sha256: sha256Hex(bytes)
  });
}
async function deriveMergerEnvelopeFromActiveMerge(projectRoot, gitState = createProductionMergerGitState(projectRoot)) {
  let state;
  try {
    state = await gitState.activeMerge();
  } catch (error) {
    const message = error instanceof Error && error.message.trim() !== "" ? error.message : "Assigned repository does not have one ordinary in-progress merge";
    throw new MergerEnvelopeDerivationError(message, { cause: error });
  }
  if (state.unmergedPaths.length === 0) {
    throw new MergerEnvelopeDerivationError(
      "Assigned repository does not have one ordinary in-progress merge with a complete conflict set"
    );
  }
  const expectedConflictPaths = Object.freeze([...state.unmergedPaths]);
  const resolutionScope = Object.freeze([...state.unmergedPaths]);
  return Object.freeze({
    targetObjectId: state.targetObjectId,
    sourceObjectId: state.sourceObjectId,
    automaticMergeTreeId: state.automaticMergeTreeId,
    expectedConflictPaths,
    resolutionScope
  });
}
async function admitMergerInvocation(options) {
  if (options.project !== void 0) {
    requireOptionPath("--project", options.project);
  }
  const instruction = options.instruction;
  if (instruction.trim() === "") {
    throw new CliUsageError("merger requires a nonblank task instruction");
  }
  const projectRoot = resolve4(options.project ?? options.cwd);
  const derived = await deriveMergerEnvelopeFromActiveMerge(
    projectRoot,
    options.gitState ?? createProductionMergerGitState(projectRoot)
  );
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join4(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@merger`
  );
  const sessionDirectory = join4(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join4(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);
  const attachments = [];
  for (let i = 0; i < options.attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        options.attachmentPaths[i],
        attachmentsDirectory,
        i
      )
    );
  }
  const targetIntent = mergerMaterialFromUtf8(
    `Investigate primary sources for target parent ${derived.targetObjectId}. Do not invent intent.`
  );
  const sourceIntent = mergerMaterialFromUtf8(
    `Investigate primary sources for source parent ${derived.sourceObjectId}. Do not invent intent.`
  );
  const taskMaterial = mergerMaterialFromUtf8(instruction);
  const authorityMaterial = mergerMaterialFromUtf8(instruction);
  const mergerInput = validateMergerInput({
    version: 1,
    attemptId: runId,
    targetObjectId: derived.targetObjectId,
    sourceObjectId: derived.sourceObjectId,
    materials: {
      task: taskMaterial,
      authority: authorityMaterial,
      targetIntent,
      sourceIntent
    },
    expectedConflictPaths: [...derived.expectedConflictPaths],
    resolutionScope: [...derived.resolutionScope],
    // Authorized checks remain available on the assignment; default none.
    authorizedChecks: []
  });
  const mergerInputPath = join4(runDirectory, "merger-input.json");
  await writeFile2(
    mergerInputPath,
    `${JSON.stringify(mergerInput, null, 2)}
`,
    "utf8"
  );
  const admitted = {
    role: "merger",
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    instruction,
    instructionEmpty: false,
    mergerInputPath,
    derived: {
      targetObjectId: derived.targetObjectId,
      sourceObjectId: derived.sourceObjectId,
      automaticMergeTreeId: derived.automaticMergeTreeId,
      expectedConflictPaths: [...derived.expectedConflictPaths],
      resolutionScope: [...derived.resolutionScope]
    },
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind
    }))
  };
  const admittedRequestPath = join4(runDirectory, "admitted-request.json");
  await writeFile2(
    admittedRequestPath,
    `${JSON.stringify(admitted, null, 2)}
`,
    "utf8"
  );
  await writeRoleInvocationLedger(admitted, admitted.role);
  return {
    role: "merger",
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty: false,
    attachments,
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
    mergerInputPath,
    derived: admitted.derived
  };
}
function buildMergerTransportPrompt(admitted) {
  const lines = [
    `/skill:resolving-merge-conflicts ${admitted.instruction}`
  ];
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("Admitted Attachments (frozen snapshot paths; read these bytes):");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return lines.join("\n");
}
var ROLE_RUN_SESSION_FILE_NAME, MergerEnvelopeDerivationError, DOCTOR_ISSUE_NUMBER_PATTERN, DOCTOR_CASE_RUNS_PATH_PATTERN;
var init_invocation = __esm({
  "src/public-cli/invocation.ts"() {
    "use strict";
    init_activation_ledger_topology();
    init_activation_ledger_git();
    init_doctor_evidence();
    init_collector_config();
    init_fixer_packet();
    init_merger_git_state();
    init_merger_contracts();
    init_sha256();
    init_uuidv7();
    init_cli_errors();
    ROLE_RUN_SESSION_FILE_NAME = "session.jsonl";
    MergerEnvelopeDerivationError = class extends Error {
      code = "merger-envelope-derivation";
      /** Typed cause for #107 classifyPostAdmissionFailure (isTypedActivationError). */
      knownCause = "activation";
      constructor(message, options) {
        super(message, options);
        this.name = "MergerEnvelopeDerivationError";
      }
    };
    DOCTOR_ISSUE_NUMBER_PATTERN = /^[1-9]\d*$/;
    DOCTOR_CASE_RUNS_PATH_PATTERN = /\/\.ak-roles\/books\/[^/]+\/issues\/([1-9]\d*)\/runs$/;
  }
});

// src/public-cli/explicit-internal.ts
import { execFile as execFile2, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath as realpath3 } from "node:fs/promises";
import { delimiter as delimiter2, isAbsolute as isAbsolute4, join as join5, resolve as resolve5 } from "node:path";
import { platform } from "node:process";
import { promisify as promisify2 } from "node:util";
function resolveInternalRoleEntrypoint(packageRoot2) {
  return join5(packageRoot2, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
}
function buildExplicitInternalActivationArgs(selectedRoleEntry, extraArgs = []) {
  return ["--no-extensions", "-e", selectedRoleEntry, ...extraArgs];
}
function knownFailureFromProviderStop(input) {
  if (input.stopReason !== "error") return void 0;
  const diagnostic = typeof input.errorMessage === "string" && input.errorMessage.trim() !== "" ? input.errorMessage.trim() : "provider failure";
  const identity = {
    name: "ProviderStopError"
  };
  if (typeof input.provider === "string" && input.provider.trim() !== "") {
    identity.code = input.provider;
  } else if (typeof input.model === "string" && input.model.trim() !== "") {
    identity.code = input.model;
  }
  return {
    cause: "provider",
    identity,
    diagnostic
  };
}
async function resolveSelectedPi(command, cwd, env) {
  const searchPath = env.PATH ?? (platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin");
  const candidates = isAbsolute4(command) || command.includes("/") ? [resolve5(cwd, command)] : searchPath.split(delimiter2).map((dir) => resolve5(cwd, dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") continue;
      throw error;
    }
    return await realpath3(candidate);
  }
  throw new Error(`Pi executable not found: ${command}`);
}
async function selectedPiIdentity(command, cwd, env) {
  const executable = await resolveSelectedPi(command, cwd, env);
  const { stdout } = await execFileAsync2(executable, ["--version"], {
    cwd,
    env,
    encoding: "utf8"
  });
  const version = stdout.trim();
  if (version === "") throw new Error(`Pi executable returned an empty version: ${executable}`);
  return { executable, version };
}
async function runExplicitInternalActivation(options) {
  const roleEntry = await realpath3(
    resolveInternalRoleEntrypoint(options.packageRoot)
  );
  const args = buildExplicitInternalActivationArgs(
    roleEntry,
    options.extraArgs ?? []
  );
  const runner = options.runner ?? defaultExplicitInternalPiRunner;
  const env = {
    ...process.env,
    ...options.env,
    HOME: options.home,
    PI_CODING_AGENT_DIR: options.agentDir
  };
  const runDirectory = env.AK_ROLE_RUN_DIR;
  if (typeof runDirectory === "string" && runDirectory !== "") {
    await recordLaunchedRolePackageIdentity(
      runDirectory,
      await observeLaunchedRolePackageIdentity(options.packageRoot, roleEntry)
    );
  }
  return await runner(args, {
    cwd: options.cwd,
    ...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs },
    env
  });
}
var execFileAsync2, defaultExplicitInternalPiRunner;
var init_explicit_internal = __esm({
  "src/public-cli/explicit-internal.ts"() {
    "use strict";
    init_invocation();
    init_registry2();
    execFileAsync2 = promisify2(execFile2);
    defaultExplicitInternalPiRunner = async (args, options) => {
      const command = options.env.PI_BINARY ?? "pi";
      const piIdentity = await selectedPiIdentity(command, options.cwd, options.env);
      return await new Promise((resolveResult, reject) => {
        const child = spawn(piIdentity.executable, [...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        let timedOut = false;
        let timer;
        const armTimeoutAfterChildReady = () => {
          if (options.timeoutMs === void 0) return;
          timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs);
        };
        let identityRecorded = Promise.resolve();
        child.once("spawn", () => {
          armTimeoutAfterChildReady();
          const runDirectory = options.env.AK_ROLE_RUN_DIR;
          if (typeof runDirectory === "string" && runDirectory !== "") {
            identityRecorded = recordLaunchedPiIdentity(runDirectory, piIdentity);
          }
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (error) => {
          if (timer !== void 0) clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          if (timer !== void 0) clearTimeout(timer);
          void identityRecorded.then(
            () => resolveResult({
              code,
              stderr,
              timedOut,
              args: [...args],
              piIdentity
            }),
            reject
          );
        });
      });
    };
  }
});

// src/package-resources/method-skill.ts
import { createHash as createHash3 } from "node:crypto";
import { readFile as readFile5, realpath as realpath4 } from "node:fs/promises";
import { join as join6 } from "node:path";
function gitBlobOid(bytes) {
  const body = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  const header = Buffer.from(`blob ${body.byteLength}\0`, "utf8");
  return createHash3("sha1").update(header).update(body).digest("hex");
}
function stripSkillFrontmatter(content) {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const after = content.slice(end + "\n---".length);
  return after.replace(/^\r?\n/, "");
}
function packagedMethodSkillRelativeDirectory(name) {
  return `${METHOD_SKILL_RELATIVE_ROOT}/${name}`;
}
function resolvePackagedMethodSkillRoot(packageRoot2, name) {
  return join6(packageRoot2, packagedMethodSkillRelativeDirectory(name));
}
function resolvePackagedMethodSkillPath(packageRoot2, name) {
  return join6(resolvePackagedMethodSkillRoot(packageRoot2, name), "SKILL.md");
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseProvenance(raw, expectedName) {
  if (!isRecord3(raw)) {
    throw new Error(`Packaged method provenance must be an object for ${expectedName}`);
  }
  if (raw.name !== expectedName) {
    throw new Error(
      `Packaged method provenance name mismatch: expected ${expectedName}, got ${String(raw.name)}`
    );
  }
  if (raw.kind !== "role-method-skill") {
    throw new Error(`Packaged method provenance kind must be role-method-skill`);
  }
  if (typeof raw.packageAdaptation !== "string" || raw.packageAdaptation.trim() === "") {
    throw new Error(`Packaged method provenance packageAdaptation must be nonblank`);
  }
  if (!isRecord3(raw.upstream)) {
    throw new Error(`Packaged method provenance upstream must be an object`);
  }
  const upstream = raw.upstream;
  for (const key of [
    "repository",
    "path",
    "license",
    "copyright",
    "attribution"
  ]) {
    if (typeof upstream[key] !== "string" || upstream[key].trim() === "") {
      throw new Error(`Packaged method provenance upstream.${key} must be nonblank`);
    }
  }
  if (typeof upstream.commit !== "string" || !GIT_COMMIT_RE.test(upstream.commit)) {
    throw new Error(
      `Packaged method provenance upstream.commit must be a 40-char lowercase git object id`
    );
  }
  const tag = typeof upstream.tag === "string" && upstream.tag.trim() !== "" ? upstream.tag.trim() : void 0;
  const version = typeof upstream.version === "string" && upstream.version.trim() !== "" ? upstream.version.trim() : void 0;
  if (tag === void 0 && version === void 0) {
    throw new Error(
      `Packaged method provenance upstream must include nonblank tag or version`
    );
  }
  if (!isRecord3(raw.files)) {
    throw new Error(`Packaged method provenance files must be an object`);
  }
  const files = {};
  for (const [rel, entry] of Object.entries(raw.files)) {
    if (!isRecord3(entry)) {
      throw new Error(`Packaged method provenance file entry must be an object: ${rel}`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      throw new Error(`Packaged method provenance file sha256 invalid: ${rel}`);
    }
    if (typeof entry.byteLength !== "number" || !Number.isInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new Error(`Packaged method provenance file byteLength invalid: ${rel}`);
    }
    if (typeof entry.gitBlob !== "string" || !GIT_BLOB_RE.test(entry.gitBlob)) {
      throw new Error(
        `Packaged method provenance file gitBlob must be a 40-char lowercase git object id: ${rel}`
      );
    }
    files[rel] = {
      sha256: entry.sha256,
      byteLength: entry.byteLength,
      gitBlob: entry.gitBlob
    };
  }
  if (files["SKILL.md"] === void 0) {
    throw new Error(`Packaged method provenance must include SKILL.md`);
  }
  return Object.freeze({
    name: expectedName,
    kind: "role-method-skill",
    packageAdaptation: raw.packageAdaptation,
    upstream: Object.freeze({
      repository: upstream.repository,
      path: upstream.path,
      commit: upstream.commit,
      ...tag === void 0 ? {} : { tag },
      ...version === void 0 ? {} : { version },
      license: upstream.license,
      copyright: upstream.copyright,
      attribution: upstream.attribution
    }),
    files: Object.freeze(files)
  });
}
async function loadPackagedMethodSkillMaterial(packageRoot2, name) {
  const rootDirectory = resolvePackagedMethodSkillRoot(packageRoot2, name);
  const skillPathConfigured = join6(rootDirectory, "SKILL.md");
  const provenancePath = join6(rootDirectory, "provenance.json");
  let provenanceRaw;
  try {
    provenanceRaw = await readFile5(provenancePath, "utf8");
  } catch (error) {
    throw new PackagedMethodSkillUnavailableError(name, provenancePath, error);
  }
  let provenanceJson;
  try {
    provenanceJson = JSON.parse(provenanceRaw);
  } catch (error) {
    throw new Error(`Packaged method provenance is not valid JSON at ${provenancePath}`, {
      cause: error
    });
  }
  const provenance = parseProvenance(provenanceJson, name);
  for (const [rel, expected] of Object.entries(provenance.files)) {
    const absolute = join6(rootDirectory, rel);
    let bytes;
    try {
      bytes = await readFile5(absolute);
    } catch (error) {
      throw new PackagedMethodSkillUnavailableError(name, absolute, error);
    }
    const actualSha = sha256Hex(bytes);
    const actualBlob = gitBlobOid(bytes);
    if (actualSha !== expected.sha256 || bytes.byteLength !== expected.byteLength || actualBlob !== expected.gitBlob) {
      throw new Error(
        `Packaged method file digest mismatch for ${name}/${rel}: expected sha256=${expected.sha256} byteLength=${expected.byteLength} gitBlob=${expected.gitBlob}, got sha256=${actualSha} byteLength=${bytes.byteLength} gitBlob=${actualBlob}`
      );
    }
  }
  let skillPath;
  let raw;
  try {
    skillPath = await realpath4(skillPathConfigured);
    raw = await readFile5(skillPath, "utf8");
  } catch (error) {
    throw new PackagedMethodSkillUnavailableError(name, skillPathConfigured, error);
  }
  const body = stripSkillFrontmatter(raw).trim();
  if (body.length === 0) {
    throw new Error(`Canonical ${name} Skill is empty at ${skillPath}`);
  }
  const companionRelativePaths = REQUIRED_COMPANIONS[name].filter(
    (rel) => provenance.files[rel] !== void 0
  );
  for (const rel of REQUIRED_COMPANIONS[name]) {
    if (provenance.files[rel] === void 0) {
      throw new Error(
        `Packaged method ${name} missing required companion in provenance: ${rel}`
      );
    }
  }
  return Object.freeze({
    name,
    rootDirectory,
    skillPath,
    raw,
    body,
    provenance,
    companionRelativePaths: Object.freeze([...companionRelativePaths])
  });
}
function observePackagedMethodSkillInvocation(text, expected) {
  if (!text.startsWith('<skill name="')) return void 0;
  const nameStart = '<skill name="'.length;
  const nameEnd = text.indexOf('"', nameStart);
  if (nameEnd <= nameStart) return void 0;
  const name = text.slice(nameStart, nameEnd);
  if (name !== expected.name) return void 0;
  const locationMarker = '" location="';
  if (!text.startsWith(locationMarker, nameEnd)) return void 0;
  const locationStart = nameEnd + locationMarker.length;
  const locationEnd = text.indexOf('"', locationStart);
  if (locationEnd <= locationStart) return void 0;
  const location = text.slice(locationStart, locationEnd);
  const openTail = ">\n";
  if (!text.startsWith(openTail, locationEnd + 1)) return void 0;
  const closeTag = "\n</skill>";
  const closeAt = text.indexOf(closeTag, locationEnd + 1 + openTail.length);
  if (closeAt === -1) return void 0;
  const afterClose = text.slice(closeAt + closeTag.length);
  if (afterClose.length > 0 && !afterClose.startsWith("\n")) return void 0;
  if (!expected.allowedLocations.includes(location)) return void 0;
  return Object.freeze({ name: expected.name, location });
}
var PackagedMethodSkillUnavailableError, METHOD_SKILL_RELATIVE_ROOT, GIT_COMMIT_RE, GIT_BLOB_RE, SHA256_RE, REQUIRED_COMPANIONS;
var init_method_skill = __esm({
  "src/package-resources/method-skill.ts"() {
    "use strict";
    init_sha256();
    PackagedMethodSkillUnavailableError = class extends Error {
      constructor(skillName, path, cause) {
        super(`Canonical ${skillName} Skill is unavailable at ${path}`, { cause });
        this.skillName = skillName;
        this.name = "CanonicalSkillUnavailableError";
      }
      skillName;
      code = "canonical-skill-unavailable";
    };
    METHOD_SKILL_RELATIVE_ROOT = "resources/methods";
    GIT_COMMIT_RE = /^[0-9a-f]{40}$/;
    GIT_BLOB_RE = /^[0-9a-f]{40}$/;
    SHA256_RE = /^[0-9a-f]{64}$/;
    REQUIRED_COMPANIONS = {
      tdd: ["tests.md", "mocking.md", "agents/openai.yaml"],
      "diagnosing-bugs": ["agents/openai.yaml", "scripts/hitl-loop.template.sh"],
      "code-review": ["agents/openai.yaml"],
      "resolving-merge-conflicts": ["agents/openai.yaml"]
    };
  }
});

// src/public-cli/public-run-credentials.ts
function knownFailureForMissingProviderCredential(model, credentials) {
  if (model === void 0 || credentials === void 0) return void 0;
  if (model.provider !== "openai-codex" && model.provider !== "xai") return void 0;
  if (!missingPublicProviderCredential(model.provider, credentials)) {
    return void 0;
  }
  return {
    cause: "provider",
    identity: {
      name: "MissingProviderCredential",
      code: model.provider
    }
  };
}
function missingCredentialPreDispatchFailure(model, credentials) {
  const knownFailure = knownFailureForMissingProviderCredential(model, credentials);
  if (knownFailure === void 0) return void 0;
  return {
    timedOut: false,
    code: 1,
    stderr: `Missing credential for provider ${String(knownFailure.identity?.code ?? "unknown")}`,
    knownFailure
  };
}
function postRunMissingCredentialFailure(result2, model, credentials) {
  if (!(result2.timedOut || result2.code !== 0)) return void 0;
  return knownFailureForMissingProviderCredential(model, credentials);
}
var init_public_run_credentials = __esm({
  "src/public-cli/public-run-credentials.ts"() {
    "use strict";
    init_config2();
  }
});

// src/public-cli/run-lifecycle.ts
import { lstat as lstat2, open, readdir as readdir2, readFile as readFile6, unlink, writeFile as writeFile3 } from "node:fs/promises";
import { join as join7 } from "node:path";
function isV1ResumableProvider(provider) {
  return V1_RESUMABLE_PROVIDERS.includes(provider);
}
function typedProviderHttpPath(runDirectory) {
  return join7(runDirectory, TYPED_HTTP_FILE);
}
async function clearTypedProviderHttpObservation(runDirectory) {
  try {
    await unlink(typedProviderHttpPath(runDirectory));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
async function readTypedHttp429Observation(runDirectory) {
  try {
    const raw = JSON.parse(
      await readFile6(typedProviderHttpPath(runDirectory), "utf8")
    );
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return void 0;
    }
    const record4 = raw;
    if (record4.httpStatus !== 429) return void 0;
    if (typeof record4.provider !== "string") return void 0;
    if (!isV1ResumableProvider(record4.provider)) return void 0;
    return { httpStatus: 429, provider: record4.provider };
  } catch {
    return void 0;
  }
}
function isV1ResumableFailure(input) {
  if (input.hasLawfulTerminalResult) return false;
  return input.typedHttp429 !== void 0;
}
function renderResumeCommand(runId) {
  return `ak-role resume ${runId}`;
}
async function writeRoleRunState(runDirectory, record4) {
  const payload = { ...record4, runDirectory };
  await writeFile3(
    join7(runDirectory, RUN_STATE_FILE),
    `${JSON.stringify(payload, null, 2)}
`,
    "utf8"
  );
}
async function readRoleRunState(runDirectory) {
  try {
    const raw = JSON.parse(
      await readFile6(join7(runDirectory, RUN_STATE_FILE), "utf8")
    );
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return void 0;
    }
    const record4 = raw;
    if (typeof record4.runId !== "string" || record4.runId.trim() === "") {
      return void 0;
    }
    if (record4.role !== "judge" && record4.role !== "coder" && record4.role !== "fixer" && record4.role !== "collector" && record4.role !== "doctor" && record4.role !== "reviewer" && record4.role !== "merger") {
      return void 0;
    }
    if (record4.state !== "admitted" && record4.state !== "running" && record4.state !== "resumable" && record4.state !== "terminal") {
      return void 0;
    }
    if (typeof record4.bookKey !== "string") return void 0;
    if (typeof record4.projectRoot !== "string") return void 0;
    if (typeof record4.sessionDirectory !== "string") return void 0;
    if (typeof record4.admittedRequestPath !== "string") return void 0;
    const runDir = typeof record4.runDirectory === "string" && record4.runDirectory.trim() !== "" ? record4.runDirectory : runDirectory;
    const sessionFile = typeof record4.sessionFile === "string" && record4.sessionFile.trim() !== "" ? record4.sessionFile : roleRunSessionFile(record4.sessionDirectory);
    let resumable;
    if (record4.resumable !== void 0 && record4.resumable !== null) {
      if (typeof record4.resumable === "object" && !Array.isArray(record4.resumable)) {
        const r = record4.resumable;
        if (r.httpStatus === 429 && typeof r.provider === "string" && isV1ResumableProvider(r.provider)) {
          resumable = { httpStatus: 429, provider: r.provider };
        }
      }
    }
    const phase = record4.phase === "plan" || record4.phase === "apply" ? record4.phase : void 0;
    return {
      runId: record4.runId,
      role: record4.role,
      state: record4.state,
      bookKey: record4.bookKey,
      projectRoot: record4.projectRoot,
      sessionDirectory: record4.sessionDirectory,
      sessionFile,
      runDirectory: runDir,
      admittedRequestPath: record4.admittedRequestPath,
      ...phase === void 0 ? {} : { phase },
      ...resumable === void 0 ? {} : { resumable }
    };
  } catch {
    return void 0;
  }
}
async function markRunAdmitted(admitted) {
  await writeRoleRunState(admitted.runDirectory, {
    runId: admitted.runId,
    role: admitted.role,
    state: "admitted",
    bookKey: admitted.bookKey,
    projectRoot: admitted.projectRoot,
    sessionDirectory: admitted.sessionDirectory,
    sessionFile: admitted.sessionFile,
    admittedRequestPath: admitted.admittedRequestPath,
    ...admitted.role === "coder" || admitted.role === "fixer" ? { phase: admitted.phase } : {}
  });
}
async function markRunRunning(runDirectory) {
  const current = await readRoleRunState(runDirectory);
  if (current === void 0) {
    throw new Error("cannot mark running: run state missing");
  }
  await writeRoleRunState(runDirectory, {
    runId: current.runId,
    role: current.role,
    state: "running",
    bookKey: current.bookKey,
    projectRoot: current.projectRoot,
    sessionDirectory: current.sessionDirectory,
    sessionFile: current.sessionFile,
    admittedRequestPath: current.admittedRequestPath,
    ...current.phase === void 0 ? {} : { phase: current.phase }
  });
}
async function markRunResumable(runDirectory, observation) {
  const current = await readRoleRunState(runDirectory);
  if (current === void 0) {
    throw new Error("cannot mark resumable: run state missing");
  }
  await writeRoleRunState(runDirectory, {
    ...current,
    state: "resumable",
    resumable: observation
  });
}
async function markRunTerminal(runDirectory) {
  const current = await readRoleRunState(runDirectory);
  if (current === void 0) {
    throw new Error("cannot mark terminal: run state missing");
  }
  await writeRoleRunState(runDirectory, {
    runId: current.runId,
    role: current.role,
    state: "terminal",
    bookKey: current.bookKey,
    projectRoot: current.projectRoot,
    sessionDirectory: current.sessionDirectory,
    sessionFile: current.sessionFile,
    admittedRequestPath: current.admittedRequestPath,
    ...current.phase === void 0 ? {} : { phase: current.phase }
  });
}
async function isSessionPrincipalAvailable(sessionFile) {
  if (sessionFile.trim() === "") return false;
  try {
    const st = await lstat2(sessionFile);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}
async function acquireRunWriterLease(runDirectory) {
  const lockPath = join7(runDirectory, WRITER_LOCK_FILE);
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(`${process.pid}
`, "utf8");
    } catch (error) {
      await handle.close().catch(() => void 0);
      await unlink(lockPath).catch(() => void 0);
      throw error;
    }
    let released = false;
    return {
      lockPath,
      async release() {
        if (released) return;
        released = true;
        await handle.close().catch(() => void 0);
        await unlink(lockPath).catch(() => void 0);
      }
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new RunWriterLeaseHeldError();
    }
    throw error;
  }
}
async function findRunDirectoryById(home, runId) {
  if (runId.trim() === "") return void 0;
  const ledgerHome = resolveActivationLedgerHome(() => home);
  const booksRoot = join7(ledgerHome, "books");
  let bookKeys;
  try {
    bookKeys = await readdir2(booksRoot);
  } catch {
    return void 0;
  }
  for (const bookKey of bookKeys) {
    const runsDir = join7(activationBookDirectory(ledgerHome, bookKey), "runs");
    let entries;
    try {
      entries = await readdir2(runsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === `${runId}@judge` || entry.startsWith(`${runId}@`)) {
        return join7(runsDir, entry);
      }
    }
  }
  return void 0;
}
async function loadResumableRunRecord(home, runId) {
  const runDirectory = await findRunDirectoryById(home, runId);
  if (runDirectory === void 0) {
    throw new CliUsageError(`unknown role run id: ${runId}`);
  }
  const run = await readRoleRunState(runDirectory);
  if (run === void 0) {
    throw new CliUsageError(`unknown role run id: ${runId}`);
  }
  if (run.state === "terminal") {
    throw new CliUsageError(`role run is already terminal: ${runId}`);
  }
  if (run.state !== "resumable" || run.resumable === void 0) {
    throw new CliUsageError(`role run is not resumable: ${runId}`);
  }
  if (!await isSessionPrincipalAvailable(run.sessionFile)) {
    throw new CliUsageError(
      `role run Pi session principal is unavailable: ${runId}`
    );
  }
  let instruction = "";
  let instructionEmpty = true;
  let attachments = [];
  let phase;
  let taskPath;
  let packetPath;
  let prerequisitesPath;
  let prerequisites;
  let baseRevision;
  let mergerInputPath;
  let derived;
  try {
    const raw = JSON.parse(
      await readFile6(run.admittedRequestPath, "utf8")
    );
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const record4 = raw;
      if (typeof record4.instruction === "string") {
        instruction = record4.instruction;
      }
      if (typeof record4.instructionEmpty === "boolean") {
        instructionEmpty = record4.instructionEmpty;
      }
      if (Array.isArray(record4.attachments)) {
        attachments = record4.attachments;
      }
      if (record4.phase === "plan" || record4.phase === "apply") {
        phase = record4.phase;
      }
      if (typeof record4.taskPath === "string" && record4.taskPath.trim() !== "") {
        taskPath = record4.taskPath;
      }
      if (typeof record4.packetPath === "string" && record4.packetPath.trim() !== "") {
        packetPath = record4.packetPath;
      }
      if (typeof record4.prerequisitesPath === "string" && record4.prerequisitesPath.trim() !== "") {
        prerequisitesPath = record4.prerequisitesPath;
      }
      if (Array.isArray(record4.prerequisites)) {
        prerequisites = record4.prerequisites;
      }
      if (typeof record4.baseRevision === "string" && record4.baseRevision.trim() !== "") {
        baseRevision = record4.baseRevision;
      }
      if (typeof record4.mergerInputPath === "string" && record4.mergerInputPath.trim() !== "") {
        mergerInputPath = record4.mergerInputPath;
      }
      if (record4.derived !== null && typeof record4.derived === "object" && !Array.isArray(record4.derived)) {
        const d = record4.derived;
        if (typeof d.targetObjectId === "string" && typeof d.sourceObjectId === "string" && typeof d.automaticMergeTreeId === "string" && Array.isArray(d.expectedConflictPaths) && Array.isArray(d.resolutionScope) && d.expectedConflictPaths.every((p) => typeof p === "string") && d.resolutionScope.every((p) => typeof p === "string")) {
          derived = {
            targetObjectId: d.targetObjectId,
            sourceObjectId: d.sourceObjectId,
            automaticMergeTreeId: d.automaticMergeTreeId,
            expectedConflictPaths: d.expectedConflictPaths,
            resolutionScope: d.resolutionScope
          };
        }
      }
    }
  } catch {
    throw new CliUsageError(
      `role run admitted request is unreadable: ${runId}`
    );
  }
  return {
    run,
    observation: run.resumable,
    admittedFields: {
      instruction,
      instructionEmpty,
      attachments,
      ...phase === void 0 ? {} : { phase },
      ...taskPath === void 0 ? {} : { taskPath },
      ...packetPath === void 0 ? {} : { packetPath },
      ...prerequisitesPath === void 0 ? {} : { prerequisitesPath },
      ...prerequisites === void 0 ? {} : { prerequisites },
      ...baseRevision === void 0 ? {} : { baseRevision },
      ...mergerInputPath === void 0 ? {} : { mergerInputPath },
      ...derived === void 0 ? {} : { derived }
    }
  };
}
async function loadResumableJudgeRun(home, runId) {
  const loaded = await loadResumableRunRecord(home, runId);
  if (loaded.run.role !== "judge") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not judge`
    );
  }
  const admitted = {
    role: "judge",
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: loaded.admittedFields.instructionEmpty,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation
  };
}
async function loadResumableCoderRun(home, runId) {
  const loaded = await loadResumableRunRecord(home, runId);
  if (loaded.run.role !== "coder") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not coder`
    );
  }
  const phase = loaded.admittedFields.phase ?? loaded.run.phase;
  if (phase !== "plan" && phase !== "apply") {
    throw new CliUsageError(
      `role run admitted coder phase is missing: ${runId}`
    );
  }
  const taskPath = loaded.admittedFields.taskPath;
  if (taskPath === void 0) {
    throw new CliUsageError(
      `role run admitted coder task path is missing: ${runId}`
    );
  }
  if (loaded.admittedFields.instruction.trim() === "") {
    throw new CliUsageError(
      `role run admitted coder task is blank: ${runId}`
    );
  }
  const admitted = {
    role: "coder",
    phase,
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: false,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath,
    taskPath
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation
  };
}
async function loadResumableFixerRun(home, runId) {
  const loaded = await loadResumableRunRecord(home, runId);
  if (loaded.run.role !== "fixer") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not fixer`
    );
  }
  const phase = loaded.admittedFields.phase ?? loaded.run.phase;
  if (phase !== "plan" && phase !== "apply") {
    throw new CliUsageError(
      `role run admitted fixer phase is missing: ${runId}`
    );
  }
  const packetPath = loaded.admittedFields.packetPath;
  if (packetPath === void 0) {
    throw new CliUsageError(
      `role run admitted fixer packet path is missing: ${runId}`
    );
  }
  if (loaded.admittedFields.instruction.trim() === "") {
    throw new CliUsageError(
      `role run admitted fixer instruction is blank: ${runId}`
    );
  }
  const prerequisites = loaded.admittedFields.prerequisites ?? Object.freeze([]);
  const admitted = {
    role: "fixer",
    phase,
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: false,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath,
    packetPath,
    ...loaded.admittedFields.prerequisitesPath === void 0 ? {} : { prerequisitesPath: loaded.admittedFields.prerequisitesPath },
    prerequisites
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation
  };
}
async function loadResumableReviewerRun(home, runId) {
  const loaded = await loadResumableRunRecord(home, runId);
  if (loaded.run.role !== "reviewer") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not reviewer`
    );
  }
  const baseRevision = loaded.admittedFields.baseRevision;
  if (baseRevision === void 0 || baseRevision.trim() === "") {
    throw new CliUsageError(
      `role run admitted reviewer base revision is missing: ${runId}`
    );
  }
  const admitted = {
    role: "reviewer",
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: loaded.admittedFields.instructionEmpty,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath,
    baseRevision
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation
  };
}
async function loadResumableMergerRun(home, runId) {
  const loaded = await loadResumableRunRecord(home, runId);
  if (loaded.run.role !== "merger") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not merger`
    );
  }
  const mergerInputPath = loaded.admittedFields.mergerInputPath;
  if (mergerInputPath === void 0) {
    throw new CliUsageError(
      `role run admitted merger input path is missing: ${runId}`
    );
  }
  const derived = loaded.admittedFields.derived;
  if (derived === void 0) {
    throw new CliUsageError(
      `role run admitted merger envelope is missing: ${runId}`
    );
  }
  if (loaded.admittedFields.instruction.trim() === "") {
    throw new CliUsageError(
      `role run admitted merger task is blank: ${runId}`
    );
  }
  const admitted = {
    role: "merger",
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: false,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath,
    mergerInputPath,
    derived
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation
  };
}
async function peekRoleRunRole(home, runId) {
  const runDirectory = await findRunDirectoryById(home, runId);
  if (runDirectory === void 0) return void 0;
  const run = await readRoleRunState(runDirectory);
  return run?.role;
}
var V1_RESUMABLE_PROVIDERS, RESUME_TRANSPORT_ENVELOPE, RUN_STATE_FILE, TYPED_HTTP_FILE, WRITER_LOCK_FILE, RunWriterLeaseHeldError;
var init_run_lifecycle = __esm({
  "src/public-cli/run-lifecycle.ts"() {
    "use strict";
    init_activation_ledger_topology();
    init_cli_errors();
    init_invocation();
    V1_RESUMABLE_PROVIDERS = ["openai-codex", "xai"];
    RESUME_TRANSPORT_ENVELOPE = "[ak-role:resume-continue]";
    RUN_STATE_FILE = "run-state.json";
    TYPED_HTTP_FILE = "typed-provider-http.json";
    WRITER_LOCK_FILE = "writer.lock";
    RunWriterLeaseHeldError = class extends Error {
      code = "AK_RUN_WRITER_LEASE_HELD";
      constructor(message = "role run writer lease is already held") {
        super(message);
        this.name = "RunWriterLeaseHeldError";
      }
    };
  }
});

// src/auditor-soul.ts
import { fileURLToPath } from "node:url";
var AUDITOR_SOUL_ROLES, auditorSoulPaths;
var init_auditor_soul = __esm({
  "src/auditor-soul.ts"() {
    "use strict";
    AUDITOR_SOUL_ROLES = [
      "judge",
      "reviewer",
      "doctor"
    ];
    auditorSoulPaths = Object.freeze({
      judge: fileURLToPath(new URL("../souls/judge-auditor.md", import.meta.url)),
      reviewer: fileURLToPath(
        new URL("../souls/reviewer-auditor.md", import.meta.url)
      ),
      doctor: fileURLToPath(new URL("../souls/doctor-auditor.md", import.meta.url))
    });
  }
});

// src/auditor-dossier-tool.ts
var init_auditor_dossier_tool = __esm({
  "src/auditor-dossier-tool.ts"() {
    "use strict";
    init_build();
  }
});

// src/stream-idle-guard.ts
var init_stream_idle_guard = __esm({
  "src/stream-idle-guard.ts"() {
    "use strict";
  }
});

// src/stderr-jsonl.ts
var init_stderr_jsonl = __esm({
  "src/stderr-jsonl.ts"() {
    "use strict";
  }
});

// src/tool-execution-observation.ts
var observationBase, toolExecutionObservationRecordSchema;
var init_tool_execution_observation = __esm({
  "src/tool-execution-observation.ts"() {
    "use strict";
    init_build();
    init_value2();
    init_stderr_jsonl();
    observationBase = {
      role: typebox_exports.String({ minLength: 1 }),
      toolCallId: typebox_exports.String({ minLength: 1 }),
      toolName: typebox_exports.String({ minLength: 1 }),
      timestamp: typebox_exports.String({ format: "date-time" })
    };
    toolExecutionObservationRecordSchema = typebox_exports.Union([
      typebox_exports.Object({
        ...observationBase,
        event: typebox_exports.Literal("tool_execution_start")
      }, { additionalProperties: true }),
      typebox_exports.Object({
        ...observationBase,
        event: typebox_exports.Literal("tool_execution_update")
      }, { additionalProperties: true }),
      typebox_exports.Object({
        ...observationBase,
        event: typebox_exports.Literal("tool_execution_end"),
        isError: typebox_exports.Boolean()
      }, { additionalProperties: true })
    ]);
  }
});

// src/package-owned-tool-idle.ts
var init_package_owned_tool_idle = __esm({
  "src/package-owned-tool-idle.ts"() {
    "use strict";
    init_stream_idle_guard();
    init_tool_execution_observation();
  }
});

// src/evidence-child-executor.ts
var init_evidence_child_executor = __esm({
  "src/evidence-child-executor.ts"() {
    "use strict";
    init_compliance_transport();
    init_package_owned_tool_idle();
    init_stream_idle_guard();
  }
});

// src/compliance-transport.ts
function createComplianceDecisionTool(name, description) {
  return { name, description, parameters: complianceDecisionSchema, async execute(_id, params) {
    return { content: [{ type: "text", text: "Compliance decision received" }], details: params, terminate: true };
  } };
}
function readListField(value) {
  return Array.isArray(value) ? value : value === void 0 ? [] : [value];
}
function readComplianceCandidate(arguments_, usage) {
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) return { status: "audit-incomplete", observation: { kind: "non-object-arguments", type: arguments_ === null ? "null" : Array.isArray(arguments_) ? "array" : typeof arguments_ }, candidate: arguments_, ...usage === void 0 ? {} : { usage } };
  const args = arguments_;
  const status = args.status;
  if (status === "pass") return { status, ...usage === void 0 ? {} : { usage } };
  if (status === "revise") return { status, violations: readListField(args.violations), ...usage === void 0 ? {} : { usage } };
  if (status === "escalate") return { status, ...Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}, ...Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}, ...usage === void 0 ? {} : { usage } };
  return { status: "audit-incomplete", observation: { kind: "object-status-unreadable", status: status === void 0 ? "missing" : "unknown" }, candidate: arguments_, ...usage === void 0 ? {} : { usage } };
}
var nonblank2, decisionGateSchema, complianceDecisionSchema, COMPLIANCE_RESPONSE_ENTRY_TYPE, AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE, AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE;
var init_compliance_transport = __esm({
  "src/compliance-transport.ts"() {
    "use strict";
    init_build();
    init_evidence_child_executor();
    init_auditor_dossier_tool();
    nonblank2 = typebox_exports.String({ minLength: 1, pattern: "\\S" });
    decisionGateSchema = typebox_exports.Object({ question: nonblank2, options: typebox_exports.Array(nonblank2, { minItems: 1 }) }, { additionalProperties: false });
    complianceDecisionSchema = typebox_exports.Object({ status: typebox_exports.Unknown({ description: "Auditor decision status." }), violations: typebox_exports.Array(nonblank2, { description: "Observed compliance violations." }), conflicts: typebox_exports.Array(nonblank2, { description: "Unresolved authority or execution conflicts." }), decisionGate: typebox_exports.Union([decisionGateSchema, typebox_exports.Null()], { description: "Escalation question and available options." }) }, { additionalProperties: true, required: [] });
    COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response";
    AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE = "ak_auditor_parent_attempt_binding";
    AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE = "ak_auditor_compliance_failure";
  }
});

// src/dossier-resolution.ts
var init_dossier_resolution = __esm({
  "src/dossier-resolution.ts"() {
    "use strict";
    init_judge_output();
  }
});

// src/doctor-auditor.ts
var DOCTOR_AUDIT_TOOL_NAME, tool;
var init_doctor_auditor = __esm({
  "src/doctor-auditor.ts"() {
    "use strict";
    init_auditor_dossier_tool();
    init_auditor_soul();
    init_compliance_transport();
    init_dossier_resolution();
    DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";
    tool = createComplianceDecisionTool(
      DOCTOR_AUDIT_TOOL_NAME,
      "Return whether the proposed Doctor testimony demonstrably follows the Doctor Soul and frozen evidence record from the dossier. Completed receipts are later augmented with runtime-owned cost; empty findings are valid."
    );
  }
});

// src/judge-auditor.ts
var JUDGE_AUDIT_TOOL_NAME, auditDecisionTool;
var init_judge_auditor = __esm({
  "src/judge-auditor.ts"() {
    "use strict";
    init_compliance_transport();
    init_auditor_dossier_tool();
    init_auditor_soul();
    init_dossier_resolution();
    JUDGE_AUDIT_TOOL_NAME = "ak_soul_audit_decision";
    auditDecisionTool = createComplianceDecisionTool(
      JUDGE_AUDIT_TOOL_NAME,
      "Return whether the proposed verdict demonstrably follows the judge soul and dossier evidence."
    );
  }
});

// src/reviewer-auditor.ts
var REVIEWER_AUDIT_TOOL_NAME, reviewerDecisionTool;
var init_reviewer_auditor = __esm({
  "src/reviewer-auditor.ts"() {
    "use strict";
    init_auditor_dossier_tool();
    init_auditor_soul();
    init_compliance_transport();
    init_dossier_resolution();
    REVIEWER_AUDIT_TOOL_NAME = "ak_reviewer_audit_decision";
    reviewerDecisionTool = createComplianceDecisionTool(
      REVIEWER_AUDIT_TOOL_NAME,
      "Decide whether the Reviewer receipt demonstrably followed its method and boundaries from the dossier."
    );
  }
});

// src/collector-evidence.ts
var COLLECTOR_ELIGIBILITY_MS;
var init_collector_evidence = __esm({
  "src/collector-evidence.ts"() {
    "use strict";
    COLLECTOR_ELIGIBILITY_MS = 15 * 60 * 1e3;
  }
});

// src/collector-github.ts
var init_collector_github = __esm({
  "src/collector-github.ts"() {
    "use strict";
  }
});

// src/collector-tool-schemas.ts
var collectorObserveArgsSchema, collectorRequestArgsSchema, collectorWaitArgsSchema, collectorOutputArgsSchema;
var init_collector_tool_schemas = __esm({
  "src/collector-tool-schemas.ts"() {
    "use strict";
    init_build();
    init_collector_evidence();
    collectorObserveArgsSchema = typebox_exports.Object({}, { additionalProperties: false });
    collectorRequestArgsSchema = typebox_exports.Object({
      requestId: typebox_exports.String({ minLength: 1, description: "Configured request identity." }),
      snapshotId: typebox_exports.String({ minLength: 1, description: "Latest retained observation snapshot." })
    }, { additionalProperties: false });
    collectorWaitArgsSchema = typebox_exports.Object({
      durationMs: typebox_exports.Integer({ minimum: 1, maximum: COLLECTOR_ELIGIBILITY_MS })
    }, { additionalProperties: false });
    collectorOutputArgsSchema = typebox_exports.Object({}, { additionalProperties: true });
    collectorOutputArgsSchema.required = [];
  }
});

// src/collector-ledger.ts
var COLLECTOR_OBSERVE_TOOL, COLLECTOR_REQUEST_TOOL, COLLECTOR_WAIT_TOOL;
var init_collector_ledger = __esm({
  "src/collector-ledger.ts"() {
    "use strict";
    init_value2();
    init_collector_evidence();
    init_collector_github();
    init_collector_tool_schemas();
    init_collector_output();
    COLLECTOR_OBSERVE_TOOL = "ak_collector_observe";
    COLLECTOR_REQUEST_TOOL = "ak_collector_request";
    COLLECTOR_WAIT_TOOL = "ak_collector_wait";
  }
});

// src/work-subject-identity.ts
import { resolve as resolve6 } from "node:path";
function issueRoot(value) {
  const normalized = value.replaceAll("\\", "/");
  const marker = ".ak/work/issues/";
  const index = normalized.indexOf(marker);
  if (index < 0) return void 0;
  const issue = normalized.slice(index + marker.length).split("/")[0]?.split("#")[0];
  return issue === void 0 || issue === "" ? void 0 : normalized.slice(0, index + marker.length) + issue;
}
function workIdentityFromCwd(cwd) {
  const resolvedCwd = resolve6(cwd, ".");
  const cwdIssue = issueRoot(resolvedCwd);
  if (cwdIssue !== void 0) return cwdIssue;
  if (resolvedCwd.includes("/.ak/work/")) return resolvedCwd;
  return void 0;
}
function isMachineLedgerSessionPath(sessionPath) {
  return physicallyContainedIn(resolveActivationLedgerHome(), sessionPath);
}
function subjectPath(sessionDir, cwd = process.cwd()) {
  if (sessionDir === "") {
    return workIdentityFromCwd(cwd) ?? resolve6(cwd, ".ak/work");
  }
  const resolvedSession = resolve6(cwd, sessionDir || ".ak/work");
  if (isMachineLedgerSessionPath(resolvedSession)) {
    return workIdentityFromCwd(cwd) ?? resolve6(cwd, ".ak/work");
  }
  const issue = issueRoot(resolvedSession);
  if (issue !== void 0) return issue;
  const runsMarker = "/runs/";
  const runsIndex = resolvedSession.indexOf(runsMarker);
  if (runsIndex >= 0) {
    return resolvedSession.slice(0, runsIndex);
  }
  return resolvedSession;
}
function workSubjectKeyFromProjectRoot(projectRoot) {
  return subjectPath("", projectRoot);
}
function workSubjectKeysEqual(left, right) {
  return physicalPathIdentity(left) === physicalPathIdentity(right);
}
var init_work_subject_identity = __esm({
  "src/work-subject-identity.ts"() {
    "use strict";
    init_activation_ledger_topology();
  }
});

// src/navigator-invocation-identity.ts
function isNavigatorInfrastructureFailureFact(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record4 = value;
  const keys = Object.keys(record4);
  if (keys.length !== NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS.length) return false;
  for (const key of NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS) {
    if (!Object.hasOwn(record4, key)) return false;
  }
  return record4.kind === NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND && record4.source === "shared-role-lifecycle" && record4.reasonCode === "host_failure";
}
function invocationPhaseFromUnknown(value) {
  if (value === null || value === "plan" || value === "apply") return value;
  return void 0;
}
function parseInvocationMarkerIdentity(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return void 0;
  const record4 = data;
  const invocationId = record4.invocationId;
  if (typeof invocationId !== "string") return void 0;
  const trimmedId = invocationId.trim();
  if (!isUuidV7(trimmedId)) return void 0;
  if (typeof record4.role !== "string" || record4.role.trim() === "") return void 0;
  const phase = invocationPhaseFromUnknown(record4.phase);
  if (phase === void 0) return void 0;
  if (typeof record4.subjectKey !== "string" || record4.subjectKey.trim() === "") return void 0;
  return {
    invocationId: trimmedId,
    role: record4.role,
    phase,
    subjectKey: record4.subjectKey
  };
}
function markerMatchesExpectedIdentity(marker, expected) {
  if (marker.role !== expected.role) return false;
  if (expected.phase !== void 0) {
    if (marker.phase !== expected.phase) return false;
  } else if (expected.allowedPhases !== void 0) {
    if (!expected.allowedPhases.includes(marker.phase)) return false;
  }
  if (expected.subjectKey !== void 0) {
    if (!workSubjectKeysEqual(marker.subjectKey, expected.subjectKey)) return false;
  }
  return true;
}
function classifyPackagedRoleTerminalResult(message) {
  if (typeof message.toolName !== "string") return { kind: "nonterminal" };
  if (!PACKAGED_ROLE_OUTPUT_TOOLS.has(message.toolName)) return { kind: "nonterminal" };
  const infraFact = isNavigatorInfrastructureFailureFact(message.details) ? message.details : void 0;
  if (message.isError === true) {
    if (infraFact === void 0) return { kind: "nonterminal" };
    return { kind: "infrastructure", fact: infraFact };
  }
  if (message.isError === false) {
    if (infraFact !== void 0) return { kind: "nonterminal" };
    return { kind: "accepted" };
  }
  return { kind: "nonterminal" };
}
function isAcceptedPackagedRoleTerminalResult(message) {
  return classifyPackagedRoleTerminalResult(message).kind === "accepted";
}
function durableTerminalAt(entries, index) {
  const entry = entries[index];
  if (entry?.type !== "message") return void 0;
  const message = entry.message;
  if (message?.role !== "toolResult") return void 0;
  if (typeof message.toolName !== "string") return void 0;
  const role = PACKAGED_ROLE_OUTPUT_TOOLS.get(message.toolName);
  if (role === void 0) return void 0;
  const classification = classifyPackagedRoleTerminalResult(message);
  if (classification.kind !== "accepted" && classification.kind !== "infrastructure") {
    return void 0;
  }
  return {
    index,
    role,
    toolName: message.toolName,
    classification: classification.kind,
    message
  };
}
function isInvocationMarkerEntry(entry) {
  return entry?.type === "custom" && entry.customType === NAVIGATOR_INVOCATION_ENTRY;
}
function findLatestDurablePackagedRoleTerminal(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const terminal = durableTerminalAt(entries, i);
    if (terminal !== void 0) return terminal;
  }
  return void 0;
}
function bindCurrentDurableTerminalToMarker(entries) {
  const terminal = findLatestDurablePackagedRoleTerminal(entries);
  if (terminal === void 0) return { kind: "absent" };
  let markerIndex = -1;
  for (let i = terminal.index - 1; i >= 0; i -= 1) {
    if (isInvocationMarkerEntry(entries[i])) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex < 0) {
    return { kind: "unbound", terminal };
  }
  const marker = parseInvocationMarkerIdentity(entries[markerIndex]?.data);
  if (marker === void 0) {
    return { kind: "unbound", terminal };
  }
  let windowEnd = entries.length;
  for (let i = markerIndex + 1; i < entries.length; i += 1) {
    if (isInvocationMarkerEntry(entries[i])) {
      windowEnd = i;
      break;
    }
  }
  let durableCount = 0;
  for (let i = markerIndex + 1; i < windowEnd; i += 1) {
    if (durableTerminalAt(entries, i) !== void 0) durableCount += 1;
  }
  if (durableCount !== 1) return { kind: "ambiguous" };
  if (terminal.index <= markerIndex || terminal.index >= windowEnd) {
    return { kind: "ambiguous" };
  }
  return {
    kind: "bound",
    terminal,
    marker: { ...marker, index: markerIndex }
  };
}
function isReceiptSettlementBindingClear(entries) {
  return bindCurrentDurableTerminalToMarker(entries).kind !== "ambiguous";
}
var NAVIGATOR_INVOCATION_ENTRY, NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND, NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS, PACKAGED_ROLE_OUTPUT_TOOLS;
var init_navigator_invocation_identity = __esm({
  "src/navigator-invocation-identity.ts"() {
    "use strict";
    init_packaged_role_registry();
    init_uuidv7();
    init_work_subject_identity();
    NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation";
    NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND = "role_infrastructure_failure";
    NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS = [
      "kind",
      "source",
      "reasonCode"
    ];
    PACKAGED_ROLE_OUTPUT_TOOLS = new Map(
      PACKAGED_ROLE_REGISTRY.map((entry) => [entry.outputTool, entry.role])
    );
  }
});

// src/public-command-renderer.ts
function renderPublicAkRoleCommand(target) {
  if (!PUBLIC_CALLABLE_ROLES2.has(target.role)) return void 0;
  const role = target.role;
  if (target.phase === null || target.phase === void 0) {
    return `ak-role ${role}`;
  }
  if (role === "coder" || role === "fixer") {
    return `ak-role ${role} ${target.phase}`;
  }
  return `ak-role ${role}`;
}
var PUBLIC_CALLABLE_ROLES2;
var init_public_command_renderer = __esm({
  "src/public-command-renderer.ts"() {
    "use strict";
    init_packaged_role_registry();
    PUBLIC_CALLABLE_ROLES2 = new Set(
      PACKAGED_ROLE_REGISTRY.map((entry) => entry.role)
    );
  }
});

// src/public-cli/command-renderer.ts
var init_command_renderer = __esm({
  "src/public-cli/command-renderer.ts"() {
    "use strict";
    init_public_command_renderer();
  }
});

// src/public-cli/terminal.ts
function encodeTerminalField(value) {
  return JSON.stringify(value);
}
function jsonSafeComplianceCandidate(value) {
  return value === void 0 ? JSON_SAFE_UNDEFINED_ARGUMENT : value;
}
function isLawfulTypedTerminalOutcome(outcome) {
  return outcome.kind === "accepted" || outcome.kind === "audit_escalation";
}
function exitCodeForTerminalOutcome(outcome) {
  return isLawfulTypedTerminalOutcome(outcome) ? 0 : 1;
}
function buildResidualIncompleteTerminalOutcome(input) {
  return {
    kind: "incomplete",
    role: input.role,
    status: "incomplete",
    decision: "no-usable-result",
    candidate: input.candidate,
    diagnostic: input.diagnostic,
    acceptedReceipt: false,
    decisiveFacts: {
      decision: "no-usable-result",
      candidate: input.candidate,
      diagnostic: input.diagnostic,
      acceptedReceipt: false
    }
  };
}
function buildAuditIncompleteTerminalOutcome(input) {
  const roleCandidate = jsonSafeComplianceCandidate(input.roleCandidate);
  const audit = {
    ...input.audit,
    candidate: jsonSafeComplianceCandidate(input.audit.candidate)
  };
  return {
    kind: "audit_incomplete",
    role: input.role,
    status: "audit-incomplete",
    decision: "no-usable-decision",
    roleCandidate,
    audit,
    acceptedReceipt: false,
    decisiveFacts: {
      decision: "no-usable-decision",
      roleCandidate,
      auditCandidate: audit.candidate,
      auditObservation: audit.observation,
      observationKind: audit.observation.kind,
      observationType: audit.observation.kind === "non-object-arguments" ? audit.observation.type : audit.observation.kind === "object-status-unreadable" ? audit.observation.status : audit.observation.kind === "missing-subject" ? audit.observation.subject : audit.observation.kind,
      acceptedReceipt: false
    }
  };
}
function redactExactRunId(text, runId) {
  if (runId.length === 0) return text;
  if (!text.includes(runId)) return text;
  return text.split(runId).join(REDACTED_RUN_ID_TOKEN);
}
function recommendationNavigatorFact(input) {
  void input.modelCommand;
  const command = renderPublicAkRoleCommand(input.next);
  if (command === void 0) {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: `recommended role is not a public callable seat: ${input.next.role}`
    };
  }
  return {
    disposition: "recommendation",
    next: input.next,
    reason: input.reason,
    command,
    ...input.route === void 0 ? {} : { route: input.route },
    ...input.advisoryDiagnostic === void 0 ? {} : { advisoryDiagnostic: input.advisoryDiagnostic }
  };
}
function formatTerminalResult(result2) {
  const lines = [];
  lines.push("role	outcome	status");
  const outcomeStatus = result2.roleOutcome.kind === "failure" ? result2.roleOutcome.cause : result2.roleOutcome.status;
  lines.push(
    `${result2.roleOutcome.role}	${result2.roleOutcome.kind}	${encodeTerminalField(outcomeStatus)}`
  );
  if (result2.roleOutcome.kind === "failure") {
    lines.push(
      `diagnostic	${encodeTerminalField(result2.roleOutcome.diagnostic)}`
    );
  }
  const facts = result2.roleOutcome.decisiveFacts;
  for (const [key, value] of Object.entries(facts)) {
    if (value === void 0) continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`fact	${encodeTerminalField(key)}	${encodeTerminalField(rendered)}`);
  }
  lines.push(`navigator	${result2.navigator.disposition}`);
  if (result2.navigator.advisoryDiagnostic !== void 0) {
    lines.push(`navigator-advisory	${encodeTerminalField(result2.navigator.advisoryDiagnostic)}`);
  }
  if (result2.navigator.disposition === "recommendation") {
    lines.push(
      `next	${result2.navigator.next.role}	${result2.navigator.next.phase ?? "none"}`
    );
    lines.push(`reason	${encodeTerminalField(result2.navigator.reason)}`);
    lines.push(`command	${encodeTerminalField(result2.navigator.command)}`);
  } else if (result2.navigator.disposition === "unavailable") {
    lines.push(
      `unavailable	${result2.navigator.source}	${encodeTerminalField(result2.navigator.reason)}`
    );
  }
  for (const artifact of result2.artifacts) {
    lines.push(`artifact	${artifact.kind}	${encodeTerminalField(artifact.path)}`);
  }
  if (result2.resume !== void 0) {
    lines.push(`resume	${encodeTerminalField(result2.resume.command)}`);
  } else if (result2.runId !== void 0) {
    lines.push(`run	${encodeTerminalField(result2.runId)}`);
  }
  return `${lines.join("\n")}
`;
}
var JSON_SAFE_UNDEFINED_ARGUMENT, REDACTED_RUN_ID_TOKEN;
var init_terminal = __esm({
  "src/public-cli/terminal.ts"() {
    "use strict";
    init_command_renderer();
    JSON_SAFE_UNDEFINED_ARGUMENT = Object.freeze({
      kind: "json-safe-sentinel",
      type: "undefined"
    });
    REDACTED_RUN_ID_TOKEN = "[run-id]";
  }
});

// src/public-cli/settlement.ts
import { randomUUID } from "node:crypto";
import { lstat as lstat3, mkdir as mkdir3, open as open2, readFile as readFile7, readdir as readdir3, writeFile as writeFile4 } from "node:fs/promises";
import { dirname as dirname6, join as join8 } from "node:path";
function isChildDiagnosticFloodLine(line2) {
  if (/^at\s+/.test(line2)) return true;
  if (line2.startsWith("event:")) return true;
  if (/\btokens?=/.test(line2)) return true;
  if (/\btool_calls?=/.test(line2)) return true;
  if (line2.startsWith("{")) {
    try {
      const parsed = JSON.parse(line2);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && typeof parsed.event === "string") {
        return true;
      }
    } catch {
    }
  }
  return false;
}
function isChildDiagnosticHelpFooterLine(line2) {
  const trimmed = line2.trim();
  if (trimmed.length === 0) return false;
  if (/^\S+\.(md|txt)$/i.test(trimmed)) return true;
  if (/^Use \//i.test(trimmed)) return true;
  if (/^Then use \//i.test(trimmed)) return true;
  if (/^See:\s*$/i.test(trimmed)) return true;
  return false;
}
function boundConciseDiagnostic(diagnostic, maxChars = CONCISE_DIAGNOSTIC_MAX_CHARS) {
  if (diagnostic.length <= maxChars) return diagnostic;
  if (maxChars <= 1) return "\u2026";
  return `${diagnostic.slice(0, maxChars - 1)}\u2026`;
}
function conciseChildDiagnostic(stderr, fallback) {
  const lines = stderr.split(/\r?\n/).map((line2) => line2.trim()).filter((line2) => line2.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line2 = lines[i];
    if (isChildDiagnosticFloodLine(line2)) continue;
    if (isChildDiagnosticHelpFooterLine(line2)) continue;
    return line2.replace(/^Error:\s*/i, "").trim() || fallback;
  }
  return fallback;
}
function formatCliDiagnostic(message) {
  return `ak-role: ${message}
`;
}
function formatFailureStderrDiagnostic(failure) {
  const selected = conciseChildDiagnostic(failure.diagnostic, "failure");
  const oneLine = selected.split(/\r?\n/).map((line2) => line2.trim()).find((line2) => line2.length > 0) ?? "failure";
  return formatCliDiagnostic(boundConciseDiagnostic(oneLine));
}
function presentStructuralRejection(error, io) {
  io.stderr(formatCliDiagnostic(error.message));
}
async function inspectJudgeSession(sessionFile) {
  try {
    await readFile7(sessionFile, "utf8");
    return { state: "present" };
  } catch (error) {
    if (isMissingPathError2(error)) return { state: "missing" };
    return {
      state: "unreadable",
      diagnostic: error instanceof Error ? error.message || error.name : String(error)
    };
  }
}
function thrownIdentity(error) {
  const identity = {
    name: error.name
  };
  const code = error.code;
  if (typeof code === "string" || typeof code === "number") {
    identity.code = code;
  }
  return identity;
}
function isTypedActivationError(error) {
  if (!(error instanceof Error)) return false;
  const cause = error.knownCause;
  return cause === "provider" || cause === "activation" || cause === "session" || cause === "output" || cause === "timeout" || cause === "unrecognized";
}
function classifyPostAdmissionFailure(input) {
  if (Object.hasOwn(input, "thrown")) {
    const error = input.thrown;
    if (isTypedActivationError(error)) {
      const identity = thrownIdentity(error);
      if (error.failureCode !== void 0 && identity.code === void 0) {
        identity.code = error.failureCode;
      }
      return {
        cause: error.knownCause,
        diagnostic: error.message || error.name || "unrecognized exception",
        identity,
        ...error.details === void 0 ? {} : { details: error.details }
      };
    }
    if (error instanceof Error) {
      const identity = thrownIdentity(error);
      return {
        cause: "unrecognized",
        diagnostic: error.message || error.name || "unrecognized exception",
        identity
      };
    }
    return {
      cause: "unrecognized",
      diagnostic: String(error)
    };
  }
  if (input.knownCause !== void 0) {
    const fallback = input.knownCause === "provider" ? "provider failure" : input.knownCause === "session" ? "session unreadable" : input.knownCause === "output" ? "role run completed without a lawful typed terminal result" : `role run failed (${input.knownCause})`;
    const diagnostic = input.knownDiagnostic !== void 0 && input.knownDiagnostic.trim() !== "" ? input.knownDiagnostic : conciseChildDiagnostic(input.stderr, fallback);
    const { code: _knownCode, timedOut: _knownTimedOut, ...knownDetails } = input.knownDetails ?? {};
    return {
      cause: input.knownCause,
      diagnostic,
      details: {
        ...knownDetails,
        code: input.code,
        ...input.timedOut ? { timedOut: true } : {}
      },
      ...input.knownIdentity === void 0 ? {} : { identity: input.knownIdentity }
    };
  }
  if (input.timedOut) {
    return {
      cause: "timeout",
      diagnostic: "role run timed out",
      details: { timedOut: true, code: input.code }
    };
  }
  if (input.code !== 0) {
    const fallback = `role run failed with exit ${input.code ?? "null"}`;
    return {
      cause: "activation",
      diagnostic: conciseChildDiagnostic(input.stderr, fallback),
      details: { code: input.code }
    };
  }
  if (input.session?.state === "missing") {
    return {
      cause: "session",
      diagnostic: "role run left no readable session transcript",
      details: { code: input.code, session: "missing" }
    };
  }
  if (input.session?.state === "unreadable") {
    return {
      cause: "session",
      diagnostic: input.session.diagnostic,
      details: { code: input.code, session: "unreadable" }
    };
  }
  return {
    cause: "output",
    diagnostic: "role run completed without a lawful typed terminal result",
    details: { code: input.code }
  };
}
function explicitInternalKnownFailureClassificationInput(failure) {
  if (failure === void 0) return {};
  return {
    knownCause: failure.cause,
    ...failure.identity === void 0 ? {} : { knownIdentity: failure.identity },
    ...failure.diagnostic === void 0 ? {} : { knownDiagnostic: failure.diagnostic },
    ...failure.details === void 0 ? {} : { knownDetails: failure.details }
  };
}
function isMissingPathError2(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function sessionReadFailure(error, fallbackMessage) {
  if (error instanceof SyntaxError) {
    const failed2 = new SyntaxError(
      error.message || fallbackMessage
    );
    failed2.knownCause = "session";
    return failed2;
  }
  if (error instanceof Error) {
    const failed2 = new Error(
      error.message || error.name || fallbackMessage
    );
    failed2.name = error.name || "Error";
    failed2.knownCause = "session";
    const code = error.code;
    if (typeof code === "string" || typeof code === "number") {
      failed2.failureCode = code;
      failed2.code = code;
    }
    return failed2;
  }
  const failed = new Error(String(error));
  failed.knownCause = "session";
  return failed;
}
async function readBoundSessionEntries(sessionFile) {
  const text = await readFile7(sessionFile, "utf8");
  const entries = [];
  for (const line2 of text.trim().split("\n").filter(Boolean)) {
    try {
      entries.push(JSON.parse(line2));
    } catch (error) {
      throw sessionReadFailure(error, "malformed session JSONL");
    }
  }
  return entries;
}
function extractSessionProviderStop(entries) {
  let attemptStart = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      attemptStart = i;
      break;
    }
  }
  for (let i = entries.length - 1; i >= attemptStart; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== COMPLIANCE_RESPONSE_ENTRY_TYPE) continue;
    const response = isRecord4(entry.data) && isRecord4(entry.data.response) ? entry.data.response : void 0;
    if (response?.role === "assistant" && response.stopReason === "error") {
      return {
        stopReason: "error",
        ...typeof response.errorMessage === "string" && response.errorMessage.trim() !== "" ? { errorMessage: response.errorMessage } : {},
        ...typeof response.provider === "string" && response.provider.trim() !== "" ? { provider: response.provider } : {},
        ...typeof response.model === "string" && response.model.trim() !== "" ? { model: response.model } : {}
      };
    }
    break;
  }
  for (let i = entries.length - 1; i >= attemptStart; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== "error") return void 0;
    return {
      stopReason: "error",
      ...typeof message.errorMessage === "string" && message.errorMessage.trim() !== "" ? { errorMessage: message.errorMessage } : {},
      ...typeof message.provider === "string" && message.provider.trim() !== "" ? { provider: message.provider } : {},
      ...typeof message.model === "string" && message.model.trim() !== "" ? { model: message.model } : {}
    };
  }
  return void 0;
}
async function readSessionProviderStop(sessionFile) {
  try {
    const entries = await readBoundSessionEntries(sessionFile);
    return extractSessionProviderStop(entries);
  } catch {
    return void 0;
  }
}
async function readBoundEvidenceChildKnownFailure(sessionFile) {
  const childDirectory = join8(dirname6(sessionFile), "evidence-children");
  let names;
  try {
    names = await readdir3(childDirectory);
  } catch (error) {
    if (isMissingPathError2(error)) return void 0;
    throw sessionReadFailure(error, "failed to read bound evidence-child session directory");
  }
  for (const file of names.filter((name) => name.endsWith(".jsonl")).sort().reverse()) {
    let entries;
    try {
      entries = await readBoundSessionEntries(join8(childDirectory, file));
    } catch (error) {
      throw sessionReadFailure(error, "failed to read discovered evidence-child session");
    }
    const header = entries.find((entry) => entry.type === "session");
    if (!isRecord4(header) || header.parentSession !== sessionFile) continue;
    const stop = extractSessionProviderStop(entries);
    if (stop === void 0) continue;
    const primary = knownFailureFromProviderStop(stop);
    return {
      ...primary,
      details: {
        ...stop.provider === void 0 ? {} : { provider: stop.provider },
        ...stop.model === void 0 ? {} : { model: stop.model },
        secondaryEvidence: "evidence-child"
      }
    };
  }
  return void 0;
}
async function readBoundAuditorKnownFailure(sessionFile) {
  let parentEntries;
  try {
    parentEntries = await readBoundSessionEntries(sessionFile);
  } catch (error) {
    if (isMissingPathError2(error)) return void 0;
    throw sessionReadFailure(error, "failed to read parent session for auditor binding");
  }
  const parentId = parentEntries.find((entry) => entry.type === "session")?.id;
  if (parentId === void 0) return void 0;
  let latestParentUserIndex = -1;
  for (let i = parentEntries.length - 1; i >= 0; i -= 1) {
    if (parentEntries[i]?.type === "message" && parentEntries[i]?.message?.role === "user") {
      latestParentUserIndex = i;
      break;
    }
  }
  const childDirectory = join8(dirname6(sessionFile), "auditor-roles");
  let names;
  try {
    names = await readdir3(childDirectory);
  } catch (error) {
    if (isMissingPathError2(error)) return void 0;
    throw sessionReadFailure(error, "failed to read bound auditor session directory");
  }
  for (const file of names.filter((name) => name.endsWith(".jsonl")).sort().reverse()) {
    let entries;
    try {
      entries = await readBoundSessionEntries(join8(childDirectory, file));
    } catch (error) {
      throw sessionReadFailure(error, "failed to read discovered auditor session");
    }
    const header = entries.find((entry) => entry.type === "session");
    if (!isRecord4(header) || header.parentSession !== sessionFile) continue;
    const bindingEntry = entries.find((entry) => entry.type === "custom" && entry.customType === AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE);
    const bindingParent = isRecord4(bindingEntry?.data) && isRecord4(bindingEntry.data.parent) ? bindingEntry.data.parent : void 0;
    const attemptEntryId = typeof bindingParent?.attemptEntryId === "string" ? bindingParent.attemptEntryId : void 0;
    const attemptEntryIndex = attemptEntryId === void 0 ? -1 : parentEntries.findIndex((entry) => entry.id === attemptEntryId);
    if (bindingParent?.sessionId !== parentId || bindingParent.sessionFile !== sessionFile || attemptEntryIndex < latestParentUserIndex) continue;
    const stop = extractSessionProviderStop(entries);
    if (stop === void 0) continue;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry.customType !== AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE || !isRecord4(entry.data)) continue;
      const parent = isRecord4(entry.data.parent) ? entry.data.parent : void 0;
      const failure = isRecord4(entry.data.failure) ? entry.data.failure : void 0;
      if (parent?.sessionId !== parentId || parent.sessionFile !== sessionFile || parent.attemptEntryId !== attemptEntryId || failure?.cause !== "provider") continue;
      const identity = isRecord4(failure.identity) ? failure.identity : void 0;
      return {
        cause: "provider",
        ...identity === void 0 ? {} : { identity: {
          ...typeof identity.name === "string" ? { name: identity.name } : {},
          ...typeof identity.code === "string" || typeof identity.code === "number" ? { code: identity.code } : {}
        } },
        ...typeof failure.diagnostic === "string" ? { diagnostic: failure.diagnostic } : {},
        ...isRecord4(failure.details) ? { details: failure.details } : {}
      };
    }
    const primary = knownFailureFromProviderStop(stop);
    return {
      ...primary,
      details: {
        ...stop.provider === void 0 ? {} : { provider: stop.provider },
        ...stop.model === void 0 ? {} : { model: stop.model },
        secondaryEvidence: "unavailable"
      }
    };
  }
  return void 0;
}
function typedFailedTerminatingToolKnownFailure(entries) {
  let attemptStart = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === "message" && entries[i]?.message?.role === "user") {
      attemptStart = i;
      break;
    }
  }
  const attemptEntries = entries.slice(attemptStart);
  for (let i = attemptEntries.length - 1; i >= 0; i -= 1) {
    const message = attemptEntries[i]?.message;
    if (attemptEntries[i]?.type !== "message" || message?.role !== "toolResult") continue;
    const classification = classifyPackagedRoleTerminalResult(message);
    if (classification.kind !== "infrastructure") continue;
    if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") continue;
    if (boundRoleToolCallForResult(attemptEntries, i, message, message.toolName) === void 0) continue;
    const textPart = Array.isArray(message.content) ? message.content.find((part) => isRecord4(part) && part.type === "text" && typeof part.text === "string") : void 0;
    const diagnostic = isRecord4(textPart) ? textPart.text : void 0;
    return {
      cause: "output",
      identity: { name: message.toolName, code: message.toolCallId },
      ...typeof diagnostic === "string" && diagnostic.trim() !== "" ? { diagnostic } : {},
      details: classification.fact
    };
  }
  return void 0;
}
async function resolveAuditedRunnerKnownFailure(input) {
  if (input.runner !== void 0) return input.runner;
  try {
    const auditorFailure = await readBoundAuditorKnownFailure(input.sessionFile);
    if (auditorFailure !== void 0) return auditorFailure;
  } catch (error) {
    const failure = sessionReadFailure(error, "failed to recover bound auditor failure");
    return {
      cause: "session",
      identity: thrownIdentity(failure),
      diagnostic: failure.message || failure.name
    };
  }
  try {
    const terminatingFailure = typedFailedTerminatingToolKnownFailure(
      await readBoundSessionEntries(input.sessionFile)
    );
    if (terminatingFailure !== void 0) return terminatingFailure;
  } catch (error) {
    if (!isMissingPathError2(error)) {
      const failure = sessionReadFailure(error, "failed to recover typed terminating-tool failure");
      return { cause: "session", identity: thrownIdentity(failure), diagnostic: failure.message || failure.name };
    }
  }
  try {
    const evidenceChildFailure = await readBoundEvidenceChildKnownFailure(input.sessionFile);
    if (evidenceChildFailure !== void 0) return evidenceChildFailure;
  } catch (error) {
    const failure = sessionReadFailure(error, "failed to recover bound evidence-child failure");
    return {
      cause: "session",
      identity: thrownIdentity(failure),
      diagnostic: failure.message || failure.name
    };
  }
  const parentStop = await readSessionProviderStop(input.sessionFile);
  return parentStop === void 0 ? input.credential : knownFailureFromProviderStop(parentStop);
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safelyRead(object, key) {
  try {
    return { readable: true, value: object[key] };
  } catch {
    return { readable: false };
  }
}
function judgeDecisiveFacts(verdict, judgeStatus) {
  const facts = { judgeStatus };
  if (judgeStatus === "continue") {
    const fix = safelyRead(verdict, "fix");
    if (fix.readable && isRecord4(fix.value)) {
      const summary = safelyRead(fix.value, "summary");
      if (summary.readable && typeof summary.value === "string") {
        facts.fixSummary = summary.value;
      }
    }
    const classes = safelyRead(verdict, "classes");
    if (classes.readable && Array.isArray(classes.value)) {
      try {
        facts.classes = classes.value.map((entry) => {
          if (!isRecord4(entry)) throw new Error("unreadable Judge class");
          return {
            name: entry.name,
            owner: entry.owner,
            boundary: entry.boundary,
            disposition: entry.disposition
          };
        });
        facts.classCount = classes.value.length;
      } catch {
      }
    }
  }
  if (judgeStatus === "escalate") {
    const gate = safelyRead(verdict, "decisionGate");
    if (gate.readable && isRecord4(gate.value)) {
      const question = safelyRead(gate.value, "question");
      const options = safelyRead(gate.value, "options");
      if (question.readable && typeof question.value === "string") {
        facts.decisionQuestion = question.value;
      }
      if (options.readable && Array.isArray(options.value)) {
        facts.decisionOptions = [...options.value];
      }
    }
  }
  const note = safelyRead(verdict, "note");
  if (note.readable && note.value !== void 0) facts.note = note.value;
  const evidence = safelyRead(verdict, "evidence");
  if (evidence.readable && evidence.value !== void 0) facts.evidence = evidence.value;
  return facts;
}
function coderDecisiveFacts(output) {
  const candidate = output;
  const status = safelyRead(candidate, "status");
  const facts = {};
  if (status.readable && typeof status.value === "string") facts.coderStatus = status.value;
  const remainingScope = safelyRead(candidate, "remainingScope");
  if (status.readable && status.value === "unfinished" && remainingScope.readable && typeof remainingScope.value === "string") facts.remainingScope = remainingScope.value;
  const report = safelyRead(candidate, "report");
  if (report.readable && typeof report.value === "string") facts.reportPresent = report.value.trim().length > 0;
  return facts;
}
function fixerDecisiveFacts(output) {
  const candidate = output;
  const status = safelyRead(candidate, "status");
  const facts = {};
  if (status.readable && typeof status.value === "string") facts.fixerStatus = status.value;
  const remainingScope = safelyRead(candidate, "remainingScope");
  if (status.readable && (status.value === "unfinished" || status.value === "refused") && remainingScope.readable && typeof remainingScope.value === "string") facts.remainingScope = remainingScope.value;
  const blockerRead = safelyRead(candidate, "blocker");
  if (status.readable && status.value === "refused" && blockerRead.readable && isRecord4(blockerRead.value)) {
    const cause = safelyRead(blockerRead.value, "cause");
    if (cause.readable && typeof cause.value === "string") facts.blockerCause = cause.value;
    const prerequisiteId = safelyRead(blockerRead.value, "prerequisiteId");
    if (cause.readable && cause.value === "prerequisite_unmet" && prerequisiteId.readable && typeof prerequisiteId.value === "string") facts.prerequisiteId = prerequisiteId.value;
  }
  const classResults = safelyRead(candidate, "classResults");
  if (classResults.readable && Array.isArray(classResults.value)) {
    const rows = [];
    const blockers = [];
    try {
      for (const entry of classResults.value) {
        if (!isRecord4(entry)) throw new Error("unreadable class result");
        const name = safelyRead(entry, "name");
        const disposition = safelyRead(entry, "disposition");
        if (!name.readable || !disposition.readable) throw new Error("unreadable class result");
        rows.push({ name: name.value, disposition: disposition.value });
        const blocker = safelyRead(entry, "blocker");
        if (disposition.value === "refused" && blocker.readable && isRecord4(blocker.value)) blockers.push(blocker.value);
      }
      facts.classResultCount = rows.length;
      facts.classDispositions = rows;
      const causes = blockers.flatMap((blocker) => {
        const cause = safelyRead(blocker, "cause");
        return cause.readable && typeof cause.value === "string" ? [cause.value] : [];
      });
      if (causes.length > 0) facts.blockerCauses = causes;
      const prerequisiteIds = blockers.flatMap((blocker) => {
        const cause = safelyRead(blocker, "cause");
        const id = safelyRead(blocker, "prerequisiteId");
        return cause.readable && cause.value === "prerequisite_unmet" && id.readable && typeof id.value === "string" ? [id.value] : [];
      });
      if (prerequisiteIds.length > 0) facts.prerequisiteIds = prerequisiteIds;
    } catch {
    }
  }
  const report = safelyRead(candidate, "report");
  if (report.readable && typeof report.value === "string") facts.reportPresent = report.value.trim().length > 0;
  return facts;
}
function collectorDecisiveFacts(receipt) {
  const candidate = receipt;
  const facts = {};
  for (const key of ["repository", "prNumber", "targetHead", "manifestDigest"]) {
    const value = safelyRead(candidate, key);
    if (value.readable && value.value !== void 0) facts[key] = value.value;
  }
  const groups = safelyRead(candidate, "groups");
  if (groups.readable && Array.isArray(groups.value)) {
    try {
      facts.groups = groups.value.map((group) => {
        if (!isRecord4(group)) throw new Error("unreadable Collector group");
        const identity = safelyRead(group, "identity");
        const attendance = safelyRead(group, "attendance");
        const materials = safelyRead(group, "materials");
        const findings = safelyRead(group, "findings");
        if (!identity.readable || !attendance.readable || !materials.readable || !Array.isArray(materials.value) || !findings.readable || !Array.isArray(findings.value)) {
          throw new Error("unreadable Collector group");
        }
        return {
          identity: identity.value,
          attendance: attendance.value,
          materialCount: materials.value.length,
          findingCount: findings.value.length
        };
      });
    } catch {
    }
  }
  return facts;
}
function doctorDecisiveFacts(output) {
  const candidate = output;
  const status = safelyRead(candidate, "status");
  const facts = {};
  if (status.readable && typeof status.value === "string") facts.doctorStatus = status.value;
  if (status.readable && status.value === "refused") {
    const reason = safelyRead(candidate, "reason");
    if (reason.readable && reason.value !== void 0) facts.reason = reason.value;
    const missing = safelyRead(candidate, "missingEvidence");
    if (missing.readable && Array.isArray(missing.value)) facts.missingEvidenceCount = missing.value.length;
    return facts;
  }
  const caseValue = safelyRead(candidate, "case");
  if (caseValue.readable && isRecord4(caseValue.value)) {
    const issueNumber = safelyRead(caseValue.value, "issueNumber");
    const runsPath = safelyRead(caseValue.value, "runsPath");
    if (issueNumber.readable && issueNumber.value !== void 0) facts.issueNumber = issueNumber.value;
    if (runsPath.readable && runsPath.value !== void 0) facts.runsPath = runsPath.value;
  }
  const findings = safelyRead(candidate, "findings");
  if (findings.readable && Array.isArray(findings.value)) facts.findingsCount = findings.value.length;
  return facts;
}
function reviewerAxes(value) {
  if (!isRecord4(value)) return [];
  return ["standards", "spec"].filter((axis) => {
    const projected = safelyRead(value, axis);
    return projected.readable && projected.value !== void 0;
  });
}
function reviewerDecisiveFacts(output) {
  const candidate = output;
  const status = safelyRead(candidate, "status");
  const outcomes = safelyRead(candidate, "outcomes");
  const reports = safelyRead(candidate, "reports");
  const axes = reviewerAxes(outcomes.readable ? outcomes.value : void 0);
  const reportAxes = reviewerAxes(reports.readable ? reports.value : void 0);
  const acceptedBatch = safelyRead(candidate, "acceptedBatch");
  const facts = {
    axes,
    reportAxes,
    acceptedBatchPresent: acceptedBatch.readable && acceptedBatch.value !== void 0
  };
  if (status.readable && typeof status.value === "string") facts.reviewerStatus = status.value;
  const diagnostic = safelyRead(candidate, "diagnostic");
  if (status.readable && status.value === "refused" && diagnostic.readable) {
    facts.diagnosticPresent = typeof diagnostic.value === "string" && diagnostic.value.trim().length > 0;
  }
  return facts;
}
function collectorReceiptBindingFailure(diagnostic) {
  const error = new Error(diagnostic);
  error.name = "CollectorReceiptBindingError";
  error.knownCause = "output";
  return error;
}
function toolResultText(message) {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "object" && part !== null && !Array.isArray(part) && typeof part.text === "string") {
      return part.text;
    }
    return "";
  }).join("").trim();
}
function boundErroredToolCandidate(entries, resultIndex, message, toolName) {
  if (message.toolName !== toolName || message.isError !== true) return void 0;
  const bound = boundRoleToolCallForResult(entries, resultIndex, message, toolName);
  const diagnostic = toolResultText(message);
  return bound === void 0 || diagnostic === "" ? void 0 : { candidate: bound.candidate, diagnostic, callIndex: bound.callIndex };
}
function extractCollectorInfrastructureFailure(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.isError !== true) continue;
    if (typeof message.toolName !== "string" || !COLLECTOR_INFRASTRUCTURE_TOOLS.has(message.toolName)) {
      continue;
    }
    const diagnostic = toolResultText(message);
    if (diagnostic.length === 0) continue;
    return {
      cause: "activation",
      diagnostic,
      identity: { name: "CollectorInfrastructureError" }
    };
  }
  return void 0;
}
async function readCollectorInfrastructureFailure(sessionFile) {
  try {
    const entries = await readBoundSessionEntries(sessionFile);
    return extractCollectorInfrastructureFailure(entries);
  } catch {
    return void 0;
  }
}
function assertCollectorReceiptMatchesAdmitted(receipt, admitted) {
  if (receipt.repository !== admitted.repository.canonical) {
    throw collectorReceiptBindingFailure(
      `Collector receipt repository "${receipt.repository}" does not match admitted repository "${admitted.repository.canonical}"`
    );
  }
  if (receipt.prNumber !== admitted.prNumber) {
    throw collectorReceiptBindingFailure(
      `Collector receipt prNumber ${receipt.prNumber} does not match admitted prNumber ${admitted.prNumber}`
    );
  }
  if (receipt.manifestDigest !== admitted.manifestDigest) {
    throw collectorReceiptBindingFailure(
      `Collector receipt manifestDigest does not match admitted manifestDigest`
    );
  }
}
function isComplianceAuditIncomplete(value) {
  if (!isRecord4(value) || value.status !== "audit-incomplete") return false;
  const observation = value.observation;
  if (!isRecord4(observation)) return false;
  if (observation.kind === "missing-dossier") return true;
  if (observation.kind === "missing-subject") {
    return typeof observation.subject === "string" && observation.subject.length > 0;
  }
  if (observation.kind === "object-status-unreadable") {
    return observation.status === "missing" || observation.status === "unknown";
  }
  return observation.kind === "non-object-arguments" && [
    "null",
    "array",
    "undefined",
    "string",
    "number",
    "boolean",
    "bigint",
    "symbol",
    "function"
  ].includes(observation.type);
}
function auditToolNameForRole(role) {
  switch (role) {
    case "judge":
      return JUDGE_AUDIT_TOOL_NAME;
    case "reviewer":
      return REVIEWER_AUDIT_TOOL_NAME;
    case "doctor":
      return DOCTOR_AUDIT_TOOL_NAME;
  }
}
function outputToolNameForAuditedRole(role) {
  switch (role) {
    case "judge":
      return JUDGE_OUTPUT_TOOL_NAME;
    case "reviewer":
      return REVIEWER_OUTPUT_TOOL_NAME;
    case "doctor":
      return DOCTOR_OUTPUT_TOOL_NAME;
  }
}
function boundRoleToolCallForResult(entries, resultIndex, message, outputToolName) {
  const callId = message.toolCallId;
  if (typeof callId !== "string" || callId.trim() === "") return void 0;
  const calls = [];
  let resultCount = 0;
  let matchingResultIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const candidateMessage = entries[index]?.message;
    if (candidateMessage?.role === "assistant" && Array.isArray(candidateMessage.content)) {
      for (const part of candidateMessage.content) {
        if (!isRecord4(part) || part.type !== "toolCall" || part.id !== callId) {
          continue;
        }
        if (part.name !== outputToolName) return void 0;
        calls.push({ callIndex: index, candidate: part.arguments });
      }
    }
    if (candidateMessage?.role === "toolResult" && candidateMessage.toolCallId === callId) {
      resultCount += 1;
      if (candidateMessage.toolName !== outputToolName) return void 0;
      matchingResultIndex = index;
    }
  }
  return calls.length === 1 && resultCount === 1 && matchingResultIndex === resultIndex && calls[0].callIndex < resultIndex ? calls[0] : void 0;
}
function sameAuditValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every(
      (value, index) => sameAuditValue(value, right[index])
    );
  }
  if (isRecord4(left) && isRecord4(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && sameAuditValue(left[key], right[key]));
  }
  return false;
}
function snapshotAuditDetails(details) {
  const snapshot = /* @__PURE__ */ Object.create(null);
  for (const key of Object.keys(details)) {
    Object.defineProperty(snapshot, key, {
      value: details[key],
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return snapshot;
}
function boundAuditEscalationForResult(entries, resultIndex, message, role, outputToolName) {
  const roleCall = boundRoleToolCallForResult(
    entries,
    resultIndex,
    message,
    outputToolName
  );
  if (roleCall === void 0) return void 0;
  const retained = boundRetainedAuditResponse(
    entries,
    roleCall.callIndex,
    resultIndex,
    auditToolNameForRole(role)
  );
  if (retained === void 0) return void 0;
  try {
    const decision = readComplianceCandidate(retained.candidate);
    if (decision.status !== "escalate") return void 0;
    const details = message.details;
    if (!isAuditEscalationResult(details) || !isRecord4(details)) return void 0;
    const projectedDetails = snapshotAuditDetails(details);
    const hasDecisionConflicts = Object.hasOwn(decision, "conflicts");
    const hasDetailsConflicts = Object.hasOwn(projectedDetails, "conflicts");
    if (hasDecisionConflicts !== hasDetailsConflicts) return void 0;
    if (hasDecisionConflicts && !sameAuditValue(projectedDetails.conflicts, decision.conflicts)) return void 0;
    const hasDecisionGate = Object.hasOwn(decision, "decisionGate");
    const hasDetailsGate = Object.hasOwn(projectedDetails, "auditDecisionGate");
    if (hasDecisionGate !== hasDetailsGate) return void 0;
    if (hasDecisionGate && !sameAuditValue(projectedDetails.auditDecisionGate, decision.decisionGate)) return void 0;
    return { decision, details: projectedDetails };
  } catch {
    return void 0;
  }
}
function isUnboundAuditEscalationFace(details) {
  try {
    if (isAuditEscalationResult(details)) return true;
  } catch {
  }
  if (!isRecord4(details)) return false;
  const kind = safelyRead(details, "kind");
  return kind.readable && kind.value === "audit_escalation";
}
function auditIncompleteFromCandidate(candidate) {
  const decision = readComplianceCandidate(candidate);
  return decision.status === "audit-incomplete" ? decision : void 0;
}
function boundRetainedAuditResponse(entries, callIndex, resultIndex, auditToolName) {
  const matches = [];
  let retainedResponseCount = 0;
  for (let index = callIndex + 1; index < resultIndex; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== COMPLIANCE_RESPONSE_ENTRY_TYPE) {
      continue;
    }
    retainedResponseCount += 1;
    if (!isRecord4(entry.data) || !isRecord4(entry.data.response)) continue;
    const response = entry.data.response;
    if (!Array.isArray(response.content)) continue;
    const calls = response.content.filter(
      (part) => isRecord4(part) && part.type === "toolCall"
    );
    if (calls.length !== 1 || calls[0]?.name !== auditToolName) continue;
    matches.push({ candidate: calls[0]?.arguments });
  }
  return retainedResponseCount === 1 && matches.length === 1 ? matches[0] : void 0;
}
function extractComplianceAuditIncompleteRoleOutcome(entries, role, outputToolName) {
  if (outputToolName !== outputToolNameForAuditedRole(role)) return void 0;
  const auditToolName = auditToolNameForRole(role);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (entries[index]?.type !== "message" || message?.role !== "toolResult" || message.toolName !== outputToolName || message.isError === true || !isComplianceAuditIncomplete(message.details)) {
      continue;
    }
    const roleCall = boundRoleToolCallForResult(
      entries,
      index,
      message,
      outputToolName
    );
    if (roleCall === void 0) continue;
    const details = message.details;
    if (details.observation.kind === "missing-dossier" || details.observation.kind === "missing-subject") {
      return {
        outcome: buildAuditIncompleteTerminalOutcome({
          role,
          roleCandidate: roleCall.candidate,
          audit: details
        })
      };
    }
    const retained = boundRetainedAuditResponse(
      entries,
      roleCall.callIndex,
      index,
      auditToolName
    );
    if (retained === void 0) continue;
    const audit = auditIncompleteFromCandidate(retained.candidate);
    if (audit === void 0) continue;
    return {
      outcome: buildAuditIncompleteTerminalOutcome({
        role,
        roleCandidate: roleCall.candidate,
        audit
      })
    };
  }
  return void 0;
}
function auditArtifactPublicationError(message, code) {
  const error = new Error(message);
  error.name = "ArtifactPublicationError";
  error.code = code;
  return error;
}
async function ensureAuditEvidenceDirectory(runDirectory) {
  const artifactsDir = join8(runDirectory, "artifacts");
  const runStat = await lstat3(runDirectory);
  if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
    throw auditArtifactPublicationError(
      "audit evidence run directory is not a real directory",
      "ELOOP"
    );
  }
  try {
    const existing = await lstat3(artifactsDir);
    if (existing.isSymbolicLink()) {
      throw auditArtifactPublicationError(
        "audit evidence artifacts directory is a symlink",
        "ELOOP"
      );
    }
    if (!existing.isDirectory()) {
      throw auditArtifactPublicationError(
        "audit evidence artifacts path is not a directory",
        "EEXIST"
      );
    }
  } catch (error) {
    if (!isMissingPathError2(error)) throw error;
    await mkdir3(artifactsDir, { recursive: true });
    const created = await lstat3(artifactsDir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw auditArtifactPublicationError(
        "audit evidence artifacts directory is not a real directory",
        "ELOOP"
      );
    }
  }
  return artifactsDir;
}
async function publishComplianceAuditIncompleteEvidence(admitted, outcome) {
  const artifactsDir = await ensureAuditEvidenceDirectory(admitted.runDirectory);
  const evidencePath = join8(artifactsDir, "audit-incomplete.json");
  try {
    const existing = await lstat3(evidencePath);
    throw auditArtifactPublicationError(
      existing.isSymbolicLink() ? "audit evidence destination is a symlink" : "audit evidence destination collision",
      existing.isSymbolicLink() ? "ELOOP" : "EEXIST"
    );
  } catch (error) {
    if (!isMissingPathError2(error)) throw error;
  }
  const handle = await open2(evidencePath, "wx", 384);
  try {
    await handle.writeFile(`${JSON.stringify(outcome, null, 2)}
`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { kind: "evidence", path: evidencePath };
}
function auditPublicationFailureTerminal(admitted, entries, outcome, error) {
  const attempt = publicationAttemptFromError(
    join8(admitted.runDirectory, "artifacts", "audit-incomplete.json"),
    error
  );
  const diagnostic = `audit-incomplete evidence publication failed: ${attempt.diagnostic}`;
  const decisiveFacts = {
    ...outcome.decisiveFacts,
    cause: "unrecognized",
    diagnostic,
    publicationFailure: attempt
  };
  if (attempt.identity?.name !== void 0) decisiveFacts.errorName = attempt.identity.name;
  if (attempt.identity?.code !== void 0) decisiveFacts.errorCode = attempt.identity.code;
  const auditResidual = {
    roleCandidate: outcome.roleCandidate,
    audit: outcome.audit,
    acceptedReceipt: false
  };
  return {
    roleOutcome: {
      kind: "failure",
      role: admitted.role,
      cause: "unrecognized",
      diagnostic,
      decisiveFacts,
      auditResidual
    },
    navigator: extractNavigatorFact(entries),
    artifacts: [],
    runId: admitted.runId
  };
}
async function trySettleComplianceAuditIncompleteTerminalResult(admitted) {
  if (!AUDITOR_SOUL_ROLES.includes(admitted.role)) {
    return void 0;
  }
  const outputToolName = admitted.role === "judge" ? JUDGE_OUTPUT_TOOL_NAME : admitted.role === "reviewer" ? REVIEWER_OUTPUT_TOOL_NAME : DOCTOR_OUTPUT_TOOL_NAME;
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === void 0) return void 0;
  const extracted = extractComplianceAuditIncompleteRoleOutcome(
    entries,
    admitted.role,
    outputToolName
  );
  if (extracted === void 0) return void 0;
  try {
    const evidence = await publishComplianceAuditIncompleteEvidence(
      admitted,
      extracted.outcome
    );
    return {
      roleOutcome: extracted.outcome,
      navigator: extractNavigatorFact(entries),
      artifacts: [evidence],
      runId: admitted.runId
    };
  } catch (error) {
    return auditPublicationFailureTerminal(admitted, entries, extracted.outcome, error);
  }
}
function extractJudgeRoleOutcome(entries) {
  if (!isReceiptSettlementBindingClear(entries)) return void 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== JUDGE_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    const details = message.details;
    const escalation = boundAuditEscalationForResult(
      entries,
      i,
      message,
      "judge",
      JUDGE_OUTPUT_TOOL_NAME
    );
    if (escalation !== void 0) {
      return {
        kind: "audit_escalation",
        role: "judge",
        status: "audit_escalation",
        decisiveFacts: { ...escalation.details }
      };
    }
    if (isUnboundAuditEscalationFace(details)) continue;
    if (!isRecord4(details)) continue;
    const statusRead = safelyRead(details, "judgeStatus");
    if (!statusRead.readable) continue;
    const judgeStatus = statusRead.value;
    if (judgeStatus !== "converged" && judgeStatus !== "continue" && judgeStatus !== "escalate") continue;
    return {
      kind: "accepted",
      role: "judge",
      status: judgeStatus,
      decisiveFacts: judgeDecisiveFacts(details, judgeStatus)
    };
  }
  return void 0;
}
function navigatorPhaseValue(value) {
  if (value === "plan" || value === "apply") return value;
  return null;
}
function attendanceIdentityFromAdmitted(admitted) {
  const subjectKey = workSubjectKeyFromProjectRoot(admitted.projectRoot);
  if (admitted.role === "coder" || admitted.role === "fixer") {
    return { phase: admitted.phase, subjectKey };
  }
  return { phase: null, subjectKey };
}
function independentExpectedIdentity(entries, terminalRole, supplied) {
  let subjectKey;
  for (const entry of entries) {
    if (entry?.type !== "session") continue;
    if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") {
      subjectKey = workSubjectKeyFromProjectRoot(entry.cwd);
    }
    break;
  }
  if (typeof supplied?.subjectKey === "string") {
    subjectKey = supplied.subjectKey;
  }
  let phase;
  let allowedPhases;
  if (supplied !== void 0 && Object.hasOwn(supplied, "phase")) {
    phase = supplied.phase ?? null;
  } else {
    const meta = packagedRoleMetadata(terminalRole);
    if (meta !== void 0) {
      if (meta.phases.length === 1) {
        phase = meta.phases[0];
      } else {
        allowedPhases = meta.phases;
      }
    }
  }
  return {
    role: terminalRole,
    ...phase !== void 0 ? { phase } : {},
    ...allowedPhases !== void 0 ? { allowedPhases } : {},
    ...subjectKey !== void 0 ? { subjectKey } : {}
  };
}
function navigatorAttendanceCorrelatedWithBoundMarker(details, attendanceIndex, terminal, marker) {
  if (attendanceIndex <= terminal.index) return false;
  if (details.version !== 1) return false;
  if (details.role !== terminal.role) return false;
  if (details.role !== marker.role) return false;
  if (details.invocationId !== marker.invocationId) return false;
  if (details.phase !== marker.phase) return false;
  if (typeof details.subjectKey !== "string") return false;
  if (!workSubjectKeysEqual(details.subjectKey, marker.subjectKey)) return false;
  return true;
}
function parseNavigatorAttendanceDetails(details) {
  const disposition = details.disposition;
  const advisoryDiagnostic = typeof details.routePlaybookReadFailure === "string" ? { advisoryDiagnostic: details.routePlaybookReadFailure } : {};
  if (disposition === "recommendation") {
    const next = details.next;
    if (!isRecord4(next) || typeof next.role !== "string") {
      return {
        disposition: "unavailable",
        source: "unknown",
        reason: "navigator recommendation missing typed next role"
      };
    }
    const reason = typeof details.reason === "string" ? details.reason : "";
    const route = Array.isArray(details.route) ? details.route.filter(isRecord4).map((target) => ({
      role: String(target.role),
      phase: navigatorPhaseValue(target.phase)
    })) : void 0;
    return recommendationNavigatorFact({
      ...advisoryDiagnostic,
      next: {
        role: next.role,
        phase: navigatorPhaseValue(next.phase)
      },
      reason,
      ...route === void 0 ? {} : { route },
      ...typeof details.command === "string" ? { modelCommand: details.command } : {}
    });
  }
  if (disposition === "unavailable") {
    return {
      disposition: "unavailable",
      ...advisoryDiagnostic,
      source: typeof details.unavailableSource === "string" ? details.unavailableSource : "unknown",
      reason: typeof details.unavailableReason === "string" ? details.unavailableReason : "Navigator unavailable"
    };
  }
  if (disposition === "no-advice" || disposition === "arrival" || disposition === "silence") {
    return {
      disposition: "no-advice",
      ...advisoryDiagnostic
    };
  }
  return {
    disposition: "unavailable",
    source: "unknown",
    reason: "Navigator attendance disposition is unparseable"
  };
}
function extractNavigatorFact(entries, identity) {
  const binding = bindCurrentDurableTerminalToMarker(entries);
  if (binding.kind === "absent") {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance has no durable packaged role terminal"
    };
  }
  if (binding.kind === "ambiguous") {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is ambiguous across multiple durable role terminals"
    };
  }
  if (binding.kind === "unbound") {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is uncorrelated with session invocation facts"
    };
  }
  const { terminal, marker } = binding;
  if (marker.role !== terminal.role) {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is uncorrelated with session invocation facts"
    };
  }
  const expected = independentExpectedIdentity(entries, terminal.role, identity);
  if (!markerMatchesExpectedIdentity(marker, expected)) {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is uncorrelated with session invocation facts"
    };
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "custom_message" && entry.customType === "ak-navigator-attendance") {
      const details = entry.message?.details ?? entry.details;
      if (!isRecord4(details)) {
        return {
          disposition: "unavailable",
          source: "unknown",
          reason: "Navigator attendance is unparseable"
        };
      }
      if (!navigatorAttendanceCorrelatedWithBoundMarker(
        details,
        i,
        { index: terminal.index, role: terminal.role },
        marker
      )) {
        return {
          disposition: "unavailable",
          source: "unknown",
          reason: "Navigator attendance is uncorrelated with session invocation facts"
        };
      }
      return parseNavigatorAttendanceDetails(details);
    }
  }
  return {
    disposition: "unavailable",
    source: "unknown",
    reason: "Navigator attendance is missing from the session"
  };
}
async function extractNavigatorFactFromAdmittedSession(admitted) {
  try {
    const entries = await readBoundSessionEntries(admitted.sessionFile);
    return extractNavigatorFact(entries, attendanceIdentityFromAdmitted(admitted));
  } catch (error) {
    if (isMissingPathError2(error)) {
      return {
        disposition: "unavailable",
        source: "unknown",
        reason: "Navigator attendance is missing from the session"
      };
    }
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is unavailable because the session could not be read"
    };
  }
}
async function publishJudgeArtifacts(admitted, roleOutcome, sessionDirectory) {
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join8(artifactsDir, "report.json");
  const evidencePath = join8(artifactsDir, "evidence.json");
  await writeFile4(
    reportPath,
    `${JSON.stringify(
      {
        role: "judge",
        runId: admitted.runId,
        outcome: roleOutcome
      },
      null,
      2
    )}
`,
    "utf8"
  );
  await writeFile4(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        sessionDirectory,
        sessionFile: admitted.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength
        }))
      },
      null,
      2
    )}
`,
    "utf8"
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath }
  ];
}
async function publishCoderArtifacts(admitted, roleOutcome, sessionDirectory, options = {}) {
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join8(artifactsDir, "report.json");
  const evidencePath = join8(artifactsDir, "evidence.json");
  await writeFile4(
    reportPath,
    `${JSON.stringify(
      {
        role: "coder",
        runId: admitted.runId,
        phase: admitted.phase,
        outcome: roleOutcome,
        ...options.coderOutput === void 0 ? {} : { receipt: options.coderOutput }
      },
      null,
      2
    )}
`,
    "utf8"
  );
  await writeFile4(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "coder",
        phase: admitted.phase,
        sessionDirectory,
        sessionFile: admitted.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        taskPath: admitted.taskPath,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength
        })),
        ...options.methodProvenance === void 0 ? {} : { methodProvenance: options.methodProvenance }
      },
      null,
      2
    )}
`,
    "utf8"
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath }
  ];
}
function extractCoderRoleOutcome(entries) {
  if (!isReceiptSettlementBindingClear(entries)) return void 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== CODER_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    try {
      validateAcceptedDetails(CODER_OUTPUT_TOOL_NAME, message.details);
      const output = validateAcceptedCoderDetails(message.details);
      const outcome = {
        kind: "accepted",
        role: "coder",
        status: output.status,
        decisiveFacts: coderDecisiveFacts(output)
      };
      return { output, outcome };
    } catch {
      continue;
    }
  }
  return void 0;
}
async function readLawfulSettlementEntries(admitted) {
  try {
    return await readBoundSessionEntries(admitted.sessionFile);
  } catch (error) {
    if (isMissingPathError2(error)) return void 0;
    throw error instanceof Error && error.knownCause === "session" ? error : sessionReadFailure(error, "session unreadable");
  }
}
async function readLawfulJudgeRoleOutcome(admitted) {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === void 0) return void 0;
  return extractJudgeRoleOutcome(entries);
}
async function hasLawfulJudgeTerminalResult(admitted) {
  try {
    const outcome = await readLawfulJudgeRoleOutcome(admitted);
    return outcome !== void 0 && isLawfulTypedTerminalOutcome(outcome);
  } catch {
    return false;
  }
}
async function settleLawfulJudgeTerminalResult(admitted) {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === void 0) return void 0;
  const roleOutcome = extractJudgeRoleOutcome(entries);
  if (roleOutcome === void 0) {
    return void 0;
  }
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted)
  );
  const artifacts = await publishJudgeArtifacts(
    admitted,
    roleOutcome,
    admitted.sessionDirectory
  );
  return {
    roleOutcome,
    navigator,
    artifacts,
    runId: admitted.runId
  };
}
async function trySettleJudgeTerminalResult(admitted) {
  return settleLawfulJudgeTerminalResult(admitted);
}
async function settleLawfulCoderTerminalResult(admitted, options = {}) {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === void 0) return void 0;
  const extracted = extractCoderRoleOutcome(entries);
  if (extracted === void 0) return void 0;
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted)
  );
  const artifacts = await publishCoderArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    {
      coderOutput: extracted.output,
      ...options.methodProvenance === void 0 ? {} : { methodProvenance: options.methodProvenance }
    }
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId
  };
}
function sessionMessageText(message) {
  if (message === void 0) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  for (const part of message.content) {
    if (typeof part === "object" && part !== null && !Array.isArray(part) && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}
function extractFixerMethodInvocations(entries, options) {
  const observed = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "user") continue;
    const text = sessionMessageText(message);
    if (text.length === 0) continue;
    const hit = observePackagedMethodSkillInvocation(text, {
      name: "diagnosing-bugs",
      allowedLocations: options.allowedLocations
    });
    if (hit !== void 0) observed.push(hit);
  }
  return Object.freeze(observed);
}
async function publishFixerArtifacts(admitted, roleOutcome, sessionDirectory, options) {
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join8(artifactsDir, "report.json");
  const evidencePath = join8(artifactsDir, "evidence.json");
  await writeFile4(
    reportPath,
    `${JSON.stringify(
      {
        role: "fixer",
        runId: admitted.runId,
        phase: admitted.phase,
        outcome: roleOutcome,
        ...options.fixerOutput === void 0 ? {} : { receipt: options.fixerOutput }
      },
      null,
      2
    )}
`,
    "utf8"
  );
  await writeFile4(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "fixer",
        phase: admitted.phase,
        sessionDirectory,
        sessionFile: admitted.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        packetPath: admitted.packetPath,
        ...admitted.prerequisitesPath === void 0 ? {} : { prerequisitesPath: admitted.prerequisitesPath },
        prerequisites: admitted.prerequisites,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength
        })),
        methodProvenance: options.methodProvenance,
        // Optional diagnosis: availability is package-bound; invocation only when observed.
        methodInvocationObserved: (options.methodInvocations ?? []).length > 0,
        methodInvocations: options.methodInvocations ?? []
      },
      null,
      2
    )}
`,
    "utf8"
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath }
  ];
}
function extractFixerRoleOutcome(entries) {
  if (!isReceiptSettlementBindingClear(entries)) return void 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== FIXER_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    const details = message.details;
    if (isUnboundAuditEscalationFace(details)) continue;
    try {
      validateAcceptedDetails(FIXER_OUTPUT_TOOL_NAME, details);
      const output = validateFixerOutput(details);
      const outcome = {
        kind: "accepted",
        role: "fixer",
        status: output.status,
        decisiveFacts: fixerDecisiveFacts(output)
      };
      return { output, outcome };
    } catch {
      continue;
    }
  }
  return void 0;
}
async function settleLawfulFixerTerminalResult(admitted, options) {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === void 0) return void 0;
  const extracted = extractFixerRoleOutcome(entries);
  if (extracted === void 0) return void 0;
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted)
  );
  const methodInvocations = extractFixerMethodInvocations(entries, {
    allowedLocations: [
      options.methodSkillPath,
      options.methodSkillConfiguredPath
    ]
  });
  const artifacts = await publishFixerArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    {
      ...extracted.output === void 0 ? {} : { fixerOutput: extracted.output },
      methodProvenance: options.methodProvenance,
      methodInvocations
    }
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId
  };
}
async function publishCollectorArtifacts(admitted, roleOutcome, sessionDirectory, options = {}) {
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join8(artifactsDir, "report.json");
  const evidencePath = join8(artifactsDir, "evidence.json");
  await writeFile4(
    reportPath,
    `${JSON.stringify(
      {
        role: "collector",
        runId: admitted.runId,
        outcome: roleOutcome,
        ...options.collectorReceipt === void 0 ? {} : { receipt: options.collectorReceipt }
      },
      null,
      2
    )}
`,
    "utf8"
  );
  await writeFile4(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "collector",
        prNumber: admitted.prNumber,
        repository: admitted.repository.canonical,
        manifestDigest: admitted.manifestDigest,
        sessionDirectory,
        sessionFile: admitted.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength
        }))
      },
      null,
      2
    )}
`,
    "utf8"
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath }
  ];
}
function extractCollectorRoleOutcome(entries) {
  if (!isReceiptSettlementBindingClear(entries)) return void 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== COLLECTOR_OUTPUT_TOOL) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    try {
      const receipt = validateAcceptedCollectorReceipt(message.details);
      const outcome = {
        kind: "accepted",
        role: "collector",
        status: "collected",
        decisiveFacts: collectorDecisiveFacts(receipt)
      };
      return { receipt, outcome };
    } catch {
      continue;
    }
  }
  return void 0;
}
async function settleLawfulCollectorTerminalResult(admitted) {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === void 0) return void 0;
  const extracted = extractCollectorRoleOutcome(entries);
  if (extracted === void 0) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const message = entries[index]?.message;
      if (message?.role !== "toolResult") continue;
      const residual = boundErroredToolCandidate(entries, index, message, COLLECTOR_WAIT_TOOL);
      if (residual === void 0) continue;
      const candidate = residual.candidate;
      const duration = isRecord4(candidate) ? candidate.durationMs : void 0;
      if (Number.isSafeInteger(duration) && duration >= 1 && duration <= 9e5) {
        continue;
      }
      return {
        roleOutcome: buildResidualIncompleteTerminalOutcome({
          role: "collector",
          candidate,
          diagnostic: residual.diagnostic
        }),
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: admitted.runId
      };
    }
    return void 0;
  }
  assertCollectorReceiptMatchesAdmitted(extracted.receipt, admitted);
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted)
  );
  const artifacts = await publishCollectorArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    { collectorReceipt: extracted.receipt }
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId
  };
}
async function trySettleCollectorTerminalResult(admitted) {
  return settleLawfulCollectorTerminalResult(admitted);
}
async function publishDoctorArtifacts(admitted, roleOutcome, sessionDirectory, options = {}) {
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join8(artifactsDir, "report.json");
  const evidencePath = join8(artifactsDir, "evidence.json");
  await writeFile4(
    reportPath,
    `${JSON.stringify(
      {
        role: "doctor",
        runId: admitted.runId,
        outcome: roleOutcome,
        ...options.doctorOutput === void 0 ? {} : { receipt: options.doctorOutput }
      },
      null,
      2
    )}
`,
    "utf8"
  );
  await writeFile4(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "doctor",
        issueNumber: admitted.issueNumber,
        caseRunsPath: admitted.caseRunsPath,
        caseIdentity: admitted.caseIdentity,
        sessionDirectory,
        sessionFile: admitted.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength
        }))
      },
      null,
      2
    )}
`,
    "utf8"
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath }
  ];
}
function extractDoctorRoleOutcome(entries) {
  if (!isReceiptSettlementBindingClear(entries)) return void 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== DOCTOR_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    const details = message.details;
    const escalation = boundAuditEscalationForResult(
      entries,
      i,
      message,
      "doctor",
      DOCTOR_OUTPUT_TOOL_NAME
    );
    if (escalation !== void 0) {
      return {
        outcome: {
          kind: "audit_escalation",
          role: "doctor",
          status: "audit_escalation",
          decisiveFacts: { ...escalation.details }
        }
      };
    }
    if (isUnboundAuditEscalationFace(details)) continue;
    try {
      const output = validateRecordedDoctorOutput(details);
      const outcome = {
        kind: "accepted",
        role: "doctor",
        status: output.status,
        decisiveFacts: doctorDecisiveFacts(output)
      };
      return { output, outcome };
    } catch {
      continue;
    }
  }
  return void 0;
}
async function settleLawfulDoctorTerminalResult(admitted) {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === void 0) return void 0;
  const extracted = extractDoctorRoleOutcome(entries);
  if (extracted === void 0) return void 0;
  if (extracted.output !== void 0 && extracted.output.status === "completed") {
    if (extracted.output.case.issueNumber !== admitted.caseIdentity.issueNumber || extracted.output.case.runsPath !== admitted.caseIdentity.runsPath) {
      const error = new Error(
        "Doctor receipt case identity does not match admitted case identity"
      );
      error.name = "DoctorReceiptBindingError";
      error.knownCause = "output";
      throw error;
    }
  }
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted)
  );
  const artifacts = await publishDoctorArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    extracted.output === void 0 ? {} : { doctorOutput: extracted.output }
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId
  };
}
async function trySettleDoctorTerminalResult(admitted) {
  return settleLawfulDoctorTerminalResult(admitted);
}
async function trySettleCoderTerminalResult(admitted, options = {}) {
  return settleLawfulCoderTerminalResult(admitted, options);
}
async function hasLawfulCoderTerminalResult(admitted) {
  try {
    const entries = await readLawfulSettlementEntries(admitted);
    if (entries === void 0) return false;
    const extracted = extractCoderRoleOutcome(entries);
    return extracted !== void 0 && isLawfulTypedTerminalOutcome(extracted.outcome);
  } catch {
    return false;
  }
}
async function trySettleFixerTerminalResult(admitted, options) {
  return settleLawfulFixerTerminalResult(admitted, options);
}
async function hasLawfulFixerTerminalResult(admitted) {
  try {
    const entries = await readLawfulSettlementEntries(admitted);
    if (entries === void 0) return false;
    const extracted = extractFixerRoleOutcome(entries);
    return extracted !== void 0 && isLawfulTypedTerminalOutcome(extracted.outcome);
  } catch {
    return false;
  }
}
function extractReviewerMethodInvocations(entries, options) {
  const observed = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "user") continue;
    const text = sessionMessageText(message);
    if (text.length === 0) continue;
    const hit = observePackagedMethodSkillInvocation(text, {
      name: "code-review",
      allowedLocations: options.allowedLocations
    });
    if (hit !== void 0) observed.push(hit);
  }
  return Object.freeze(observed);
}
async function publishReviewerArtifacts(admitted, roleOutcome, sessionDirectory, options) {
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join8(artifactsDir, "report.json");
  const evidencePath = join8(artifactsDir, "evidence.json");
  await writeFile4(
    reportPath,
    `${JSON.stringify(
      {
        role: "reviewer",
        runId: admitted.runId,
        outcome: roleOutcome,
        ...options.reviewerReceipt === void 0 ? {} : { receipt: options.reviewerReceipt }
      },
      null,
      2
    )}
`,
    "utf8"
  );
  await writeFile4(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "reviewer",
        sessionDirectory,
        sessionFile: admitted.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        baseRevision: admitted.baseRevision,
        ...admitted.instructionEmpty ? {} : { callerProvenance: admitted.instruction },
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength
        })),
        methodProvenance: options.methodProvenance,
        // Forced package method: availability is package-bound; expansion only when observed.
        methodInvocationObserved: (options.methodInvocations ?? []).length > 0,
        methodInvocations: options.methodInvocations ?? []
      },
      null,
      2
    )}
`,
    "utf8"
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath }
  ];
}
function extractReviewerRoleOutcome(entries) {
  if (!isReceiptSettlementBindingClear(entries)) return void 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== REVIEWER_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    const escalation = boundAuditEscalationForResult(
      entries,
      i,
      message,
      "reviewer",
      REVIEWER_OUTPUT_TOOL_NAME
    );
    if (escalation !== void 0) {
      return {
        outcome: {
          kind: "audit_escalation",
          role: "reviewer",
          status: "audit_escalation",
          decisiveFacts: { ...escalation.details }
        }
      };
    }
    if (isUnboundAuditEscalationFace(message.details)) continue;
    try {
      const receipt = validateRuntimeReviewerReceipt(message.details);
      const outcome = {
        kind: "accepted",
        role: "reviewer",
        status: receipt.status,
        decisiveFacts: reviewerDecisiveFacts(receipt)
      };
      return { receipt, outcome };
    } catch {
      continue;
    }
  }
  return void 0;
}
async function settleLawfulReviewerTerminalResult(admitted, options) {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === void 0) return void 0;
  const extracted = extractReviewerRoleOutcome(entries);
  if (extracted === void 0) return void 0;
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted)
  );
  const methodInvocations = extractReviewerMethodInvocations(entries, {
    allowedLocations: [
      options.methodSkillPath,
      options.methodSkillConfiguredPath
    ]
  });
  const artifacts = await publishReviewerArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    {
      ...extracted.receipt === void 0 ? {} : { reviewerReceipt: extracted.receipt },
      methodProvenance: options.methodProvenance,
      methodInvocations
    }
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId
  };
}
async function trySettleReviewerTerminalResult(admitted, options) {
  return settleLawfulReviewerTerminalResult(admitted, options);
}
async function hasLawfulReviewerTerminalResult(admitted) {
  try {
    const entries = await readLawfulSettlementEntries(admitted);
    if (entries === void 0) return false;
    const extracted = extractReviewerRoleOutcome(entries);
    return extracted !== void 0 && isLawfulTypedTerminalOutcome(extracted.outcome);
  } catch {
    return false;
  }
}
function mergerDecisiveFacts(output) {
  const candidate = output;
  const facts = {};
  const status = safelyRead(candidate, "status");
  const attemptId = safelyRead(candidate, "attemptId");
  if (status.readable && typeof status.value === "string") facts.mergerStatus = status.value;
  if (attemptId.readable && attemptId.value !== void 0) facts.attemptId = attemptId.value;
  const decisiveKey = status.readable && status.value === "completed" ? "mergeCommitId" : "diagnosis";
  const decisive = safelyRead(candidate, decisiveKey);
  if (decisive.readable && decisive.value !== void 0) facts[decisiveKey] = decisive.value;
  return facts;
}
function extractMergerMethodInvocations(entries, options) {
  const observed = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "user") continue;
    const text = sessionMessageText(message);
    if (text.length === 0) continue;
    const hit = observePackagedMethodSkillInvocation(text, {
      name: "resolving-merge-conflicts",
      allowedLocations: options.allowedLocations
    });
    if (hit !== void 0) observed.push(hit);
  }
  return Object.freeze(observed);
}
async function publishMergerArtifacts(admitted, roleOutcome, sessionDirectory, options) {
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join8(artifactsDir, "report.json");
  const evidencePath = join8(artifactsDir, "evidence.json");
  await writeFile4(
    reportPath,
    `${JSON.stringify(
      {
        role: "merger",
        runId: admitted.runId,
        outcome: roleOutcome,
        ...options.mergerOutput === void 0 ? {} : { receipt: options.mergerOutput }
      },
      null,
      2
    )}
`,
    "utf8"
  );
  await writeFile4(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "merger",
        sessionDirectory,
        sessionFile: admitted.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        mergerInputPath: admitted.mergerInputPath,
        derived: admitted.derived,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength
        })),
        methodProvenance: options.methodProvenance,
        methodInvocationObserved: (options.methodInvocations ?? []).length > 0,
        methodInvocations: options.methodInvocations ?? []
      },
      null,
      2
    )}
`,
    "utf8"
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath }
  ];
}
function extractMergerRoleOutcome(entries) {
  if (!isReceiptSettlementBindingClear(entries)) return void 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== MERGER_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    try {
      const output = validateMergerOutput(message.details);
      const outcome = {
        kind: "accepted",
        role: "merger",
        status: output.status,
        decisiveFacts: mergerDecisiveFacts(output)
      };
      return { output, outcome };
    } catch {
      continue;
    }
  }
  return void 0;
}
async function settleLawfulMergerTerminalResult(admitted, options) {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === void 0) return void 0;
  const extracted = extractMergerRoleOutcome(entries);
  if (extracted === void 0) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const message = entries[index]?.message;
      if (message?.role !== "toolResult") continue;
      const residual = boundErroredToolCandidate(entries, index, message, MERGER_OUTPUT_TOOL_NAME);
      if (residual === void 0) continue;
      const callMessage = entries[residual.callIndex]?.message;
      const calls = callMessage?.role === "assistant" && Array.isArray(callMessage.content) ? callMessage.content.filter((part) => isRecord4(part) && part.type === "toolCall") : [];
      const attemptId = isRecord4(residual.candidate) ? safelyRead(residual.candidate, "attemptId") : { readable: true, value: void 0 };
      if (calls.length !== 1 || calls[0]?.name !== MERGER_OUTPUT_TOOL_NAME || !attemptId.readable || attemptId.value !== admitted.runId) {
        continue;
      }
      try {
        validateMergerOutput(residual.candidate, admitted.runId);
      } catch {
        return {
          roleOutcome: buildResidualIncompleteTerminalOutcome({
            role: "merger",
            candidate: residual.candidate,
            diagnostic: residual.diagnostic
          }),
          navigator: { disposition: "no-advice" },
          artifacts: [],
          runId: admitted.runId
        };
      }
    }
    return void 0;
  }
  const methodInvocations = extractMergerMethodInvocations(entries, {
    allowedLocations: [
      options.methodSkillPath,
      options.methodSkillConfiguredPath
    ]
  });
  if (methodInvocations.length === 0) return void 0;
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted)
  );
  const artifacts = await publishMergerArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    {
      mergerOutput: extracted.output,
      methodProvenance: options.methodProvenance,
      methodInvocations
    }
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId
  };
}
async function trySettleMergerTerminalResult(admitted, options) {
  return settleLawfulMergerTerminalResult(admitted, options);
}
async function hasLawfulMergerTerminalResult(admitted) {
  try {
    const entries = await readLawfulSettlementEntries(admitted);
    if (entries === void 0) return false;
    const extracted = extractMergerRoleOutcome(entries);
    return extracted !== void 0 && isLawfulTypedTerminalOutcome(extracted.outcome);
  } catch {
    return false;
  }
}
function publicationAttemptFromError(path, error) {
  if (error instanceof Error) {
    const identity = {
      name: error.name
    };
    const code = error.code;
    if (typeof code === "string" || typeof code === "number") {
      identity.code = code;
    }
    return {
      path,
      diagnostic: error.message || error.name || "write failed",
      identity
    };
  }
  return { path, diagnostic: String(error) };
}
function uniqueFailureFallbackDirs(runDirectory, baseDir) {
  const dirs = [];
  for (const dir of [baseDir, runDirectory, dirname6(runDirectory)]) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}
async function resolveFailureArtifactsBase(runDirectory) {
  const artifactsDir = join8(runDirectory, "artifacts");
  try {
    await ensureRunArtifactsDir(runDirectory);
    return { baseDir: artifactsDir };
  } catch (error) {
    return {
      baseDir: runDirectory,
      attempt: publicationAttemptFromError(artifactsDir, error)
    };
  }
}
async function writeFailureJsonRetainingCause(preferredCandidates, uniqueFallbackDirs, stem, basePayload, priorIssues) {
  const issues = [...priorIssues];
  const candidates = [
    ...preferredCandidates,
    // One unique name per fallback dir — collisions on fixed names cannot exhaust this.
    ...uniqueFallbackDirs.map((dir) => join8(dir, `${stem}.${randomUUID()}.json`))
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const path = candidates[i];
    const payload = issues.length === 0 ? basePayload : { ...basePayload, publicationIssues: issues };
    try {
      await writeFile4(
        path,
        `${JSON.stringify(payload, null, 2)}
`,
        "utf8"
      );
      return { path, issues };
    } catch (error2) {
      issues.push(publicationAttemptFromError(path, error2));
    }
  }
  const last = issues.at(-1);
  const error = new Error(
    last?.diagnostic ?? "unable to write durable failure artifact"
  );
  if (last?.identity?.name !== void 0 && last.identity.name !== "") {
    error.name = last.identity.name;
  }
  if (last?.identity?.code !== void 0) {
    error.code = last.identity.code;
  }
  error.publicationAttempts = issues;
  throw error;
}
async function publishFailureArtifacts(admitted, failure) {
  const { baseDir, attempt: baseAttempt } = await resolveFailureArtifactsBase(
    admitted.runDirectory
  );
  const priorIssues = baseAttempt === void 0 ? [] : [baseAttempt];
  const underArtifacts = baseDir === join8(admitted.runDirectory, "artifacts");
  const uniqueFallbackDirs = uniqueFailureFallbackDirs(
    admitted.runDirectory,
    baseDir
  );
  const errorCandidates = underArtifacts ? [
    join8(baseDir, "error.json"),
    join8(baseDir, "error.settlement.json"),
    join8(admitted.runDirectory, "error.settlement.json")
  ] : [
    join8(baseDir, "error.settlement.json"),
    join8(baseDir, "error.json")
  ];
  const evidenceCandidates = underArtifacts ? [
    join8(baseDir, "evidence.json"),
    join8(baseDir, "evidence.settlement.json"),
    join8(admitted.runDirectory, "evidence.settlement.json")
  ] : [
    join8(baseDir, "evidence.settlement.json"),
    join8(baseDir, "evidence.json")
  ];
  const errorPayloadBase = {
    kind: "error",
    role: admitted.role,
    runId: admitted.runId,
    cause: failure.cause,
    diagnostic: failure.diagnostic,
    ...failure.identity === void 0 ? {} : { identity: failure.identity },
    ...failure.details === void 0 ? {} : { details: failure.details }
  };
  const errorWrite = await writeFailureJsonRetainingCause(
    errorCandidates,
    uniqueFallbackDirs,
    "error",
    errorPayloadBase,
    priorIssues
  );
  const evidencePayload = {
    runId: admitted.runId,
    sessionDirectory: admitted.sessionDirectory,
    sessionFile: admitted.sessionFile,
    admittedRequestPath: admitted.admittedRequestPath,
    attachments: admitted.attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      sha256: a.sha256,
      byteLength: a.byteLength
    })),
    failureCause: failure.cause
  };
  const evidenceWrite = await writeFailureJsonRetainingCause(
    evidenceCandidates,
    uniqueFallbackDirs,
    "evidence",
    evidencePayload,
    // Evidence records the same publication collisions observed placing the error body.
    errorWrite.issues
  );
  return [
    { kind: "error", path: errorWrite.path },
    { kind: "evidence", path: evidenceWrite.path }
  ];
}
function redactDecisiveFactValue(value, runId) {
  if (typeof value === "string") return redactExactRunId(value, runId);
  if (Array.isArray(value)) {
    return value.map((entry) => redactDecisiveFactValue(entry, runId));
  }
  if (typeof value === "object" && value !== null) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactDecisiveFactValue(child, runId);
    }
    return out;
  }
  return value;
}
function redactDecisiveFactsForPublicTerminal(facts, runId) {
  const out = {};
  for (const [key, value] of Object.entries(facts)) {
    out[key] = redactDecisiveFactValue(value, runId);
  }
  return out;
}
function redactNavigatorFactForPublicTerminal(navigator, runId) {
  const advisoryDiagnostic = navigator.advisoryDiagnostic === void 0 ? {} : { advisoryDiagnostic: redactExactRunId(navigator.advisoryDiagnostic, runId) };
  if (navigator.disposition === "recommendation") {
    return {
      ...navigator,
      ...advisoryDiagnostic,
      reason: redactExactRunId(navigator.reason, runId)
    };
  }
  if (navigator.disposition === "unavailable") {
    return {
      ...navigator,
      ...advisoryDiagnostic,
      reason: redactExactRunId(navigator.reason, runId)
    };
  }
  return { ...navigator, ...advisoryDiagnostic };
}
async function settleFailureTerminalResult(admitted, failure, options = {}) {
  const navigator = await extractNavigatorFactFromAdmittedSession(admitted);
  const artifacts = await publishFailureArtifacts(admitted, failure);
  const decisiveFacts = {
    cause: failure.cause,
    diagnostic: failure.diagnostic
  };
  if (failure.identity?.name !== void 0) {
    decisiveFacts.errorName = failure.identity.name;
  }
  if (failure.identity?.code !== void 0) {
    decisiveFacts.errorCode = failure.identity.code;
  }
  if (failure.details !== void 0) {
    decisiveFacts.secondaryEvidence = failure.details;
  }
  if (options.resume !== void 0) {
    const publicDiagnostic = redactExactRunId(failure.diagnostic, admitted.runId);
    const publicFacts = redactDecisiveFactsForPublicTerminal(
      { ...decisiveFacts, diagnostic: publicDiagnostic },
      admitted.runId
    );
    const roleOutcome2 = {
      kind: "failure",
      role: admitted.role,
      cause: failure.cause,
      diagnostic: publicDiagnostic,
      decisiveFacts: publicFacts
    };
    return {
      roleOutcome: roleOutcome2,
      navigator: redactNavigatorFactForPublicTerminal(navigator, admitted.runId),
      artifacts: [],
      resume: options.resume
    };
  }
  const roleOutcome = {
    kind: "failure",
    role: admitted.role,
    cause: failure.cause,
    diagnostic: failure.diagnostic,
    decisiveFacts
  };
  return {
    roleOutcome,
    navigator,
    artifacts,
    runId: admitted.runId
  };
}
async function settleJudgeFailureTerminalResult(admitted, failure, options = {}) {
  return settleFailureTerminalResult(admitted, failure, options);
}
function presentFailureTerminal(terminal, io) {
  if (terminal.roleOutcome.kind !== "failure") {
    throw new TypeError("presentFailureTerminal requires a failure role outcome");
  }
  io.stdout(formatTerminalResult(terminal));
  io.stderr(
    formatFailureStderrDiagnostic({
      cause: terminal.roleOutcome.cause,
      diagnostic: terminal.roleOutcome.diagnostic
    })
  );
}
var CONCISE_DIAGNOSTIC_MAX_CHARS, COLLECTOR_INFRASTRUCTURE_TOOLS;
var init_settlement = __esm({
  "src/public-cli/settlement.ts"() {
    "use strict";
    init_audit_escalation();
    init_auditor_soul();
    init_doctor_auditor();
    init_judge_auditor();
    init_reviewer_auditor();
    init_explicit_internal();
    init_compliance_transport();
    init_collector_ledger();
    init_judge_output();
    init_collector_output();
    init_worker_output();
    init_terminating_tools();
    init_doctor_contracts();
    init_reviewer_output();
    init_merger_contracts();
    init_method_skill();
    init_navigator_invocation_identity();
    init_packaged_role_registry();
    init_work_subject_identity();
    init_invocation();
    init_terminal();
    CONCISE_DIAGNOSTIC_MAX_CHARS = 480;
    COLLECTOR_INFRASTRUCTURE_TOOLS = /* @__PURE__ */ new Set([
      COLLECTOR_OBSERVE_TOOL,
      COLLECTOR_REQUEST_TOOL,
      COLLECTOR_WAIT_TOOL
    ]);
  }
});

// src/public-cli/coder-run.ts
import { writeFile as writeFile5 } from "node:fs/promises";
import { join as join9 } from "node:path";
function buildModelArgs(model) {
  if (model === void 0) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking
  ];
}
function buildCoderActivationExtraArgs(admitted, options) {
  const prompt = buildCoderTransportPrompt(admitted);
  const skillArgs = admitted.phase === "apply" ? [
    "--skill",
    resolvePackagedMethodSkillPath(options.packageRoot, "tdd")
  ] : [];
  return [
    "--no-skills",
    ...skillArgs,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "coder",
    "--ak-coder-phase",
    admitted.phase,
    "--ak-coder-task",
    admitted.taskPath,
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    prompt
  ];
}
function buildCoderResumeActivationExtraArgs(admitted, options) {
  const skillArgs = admitted.phase === "apply" ? [
    "--skill",
    resolvePackagedMethodSkillPath(options.packageRoot, "tdd")
  ] : [];
  return [
    "--no-skills",
    ...skillArgs,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "coder",
    "--ak-coder-phase",
    admitted.phase,
    "--ak-coder-task",
    admitted.taskPath,
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    RESUME_TRANSPORT_ENVELOPE
  ];
}
async function presentControlledFailure(admitted, failureInput, io) {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session = !hasThrown && !failureInput.timedOut && failureInput.knownFailure === void 0 && failureInput.knownCause === void 0 ? await inspectJudgeSession(admitted.sessionFile) : void 0;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...hasThrown ? { thrown: failureInput.thrown } : {},
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...failureInput.knownCause === void 0 ? {} : { knownCause: failureInput.knownCause },
    ...failureInput.knownIdentity === void 0 ? {} : { knownIdentity: failureInput.knownIdentity },
    ...failureInput.knownDiagnostic === void 0 ? {} : { knownDiagnostic: failureInput.knownDiagnostic },
    ...session === void 0 ? {} : { session }
  });
  const hasLawfulTerminalResult = await hasLawfulCoderTerminalResult(admitted);
  const typedHttp429 = await readTypedHttp429Observation(admitted.runDirectory);
  const sessionPrincipalAvailable = await isSessionPrincipalAvailable(
    admitted.sessionFile
  );
  const resumable = sessionPrincipalAvailable && isV1ResumableFailure({
    hasLawfulTerminalResult,
    ...typedHttp429 === void 0 ? {} : { typedHttp429 }
  });
  if (resumable && typedHttp429 !== void 0) {
    await markRunResumable(admitted.runDirectory, typedHttp429);
  } else {
    await markRunTerminal(admitted.runDirectory).catch(() => void 0);
  }
  const terminal = await settleFailureTerminalResult(
    admitted,
    failure,
    resumable ? { resume: { command: renderResumeCommand(admitted.runId) } } : {}
  );
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal
  };
}
async function dispatchAdmittedCoder(input) {
  const { admitted, env, io, extraArgs, lease, methodProvenance } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials
    );
    if (missingCredential !== void 0) {
      return await presentControlledFailure(
        admitted,
        missingCredential,
        io
      );
    }
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    const childEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory
    };
    if (env.correlationId !== void 0 && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
    }
    let result2;
    try {
      result2 = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs,
        cwd: admitted.projectRoot,
        home: env.home,
        agentDir: env.agentDir,
        env: childEnv,
        timeoutMs: env.timeoutMs,
        ...env.piRunner === void 0 ? {} : { runner: env.piRunner }
      });
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error
        },
        io
      );
    }
    try {
      await writeFile5(
        join9(admitted.runDirectory, "stderr.log"),
        result2.stderr,
        "utf8"
      );
    } catch {
    }
    let lawful;
    try {
      lawful = await trySettleCoderTerminalResult(admitted, {
        ...methodProvenance === void 0 ? {} : { methodProvenance }
      });
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: result2.code,
          stderr: result2.stderr,
          thrown: error
        },
        io
      );
    }
    if (lawful !== void 0 && isLawfulTypedTerminalOutcome(lawful.roleOutcome)) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful
      };
    }
    const credentialFailure = postRunMissingCredentialFailure(
      result2,
      env.model,
      env.credentials
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result2.knownFailure,
      sessionFile: admitted.sessionFile,
      credential: credentialFailure
    });
    return await presentControlledFailure(
      admitted,
      {
        timedOut: result2.timedOut,
        code: result2.code,
        stderr: result2.stderr,
        ...knownFailure === void 0 ? {} : { knownFailure }
      },
      io
    );
  } finally {
    await lease.release();
  }
}
async function runPublicCoder(argv, env, io, parseCoderArgv2) {
  let admitted;
  try {
    const parsed = parseCoderArgv2(argv);
    admitted = await admitCoderInvocation({
      home: env.home,
      cwd: env.cwd,
      phase: parsed.phase,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...parsed.project === void 0 ? {} : { project: parsed.project },
      ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  await markRunAdmitted(admitted);
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  let methodProvenance;
  if (admitted.phase === "apply") {
    try {
      const material = await loadPackagedMethodSkillMaterial(
        env.packageRoot,
        "tdd"
      );
      methodProvenance = material.provenance;
    } catch (error) {
      await lease.release();
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation"
        },
        io
      );
    }
  }
  const extraArgs = buildCoderActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedCoder({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    ...methodProvenance === void 0 ? {} : { methodProvenance }
  });
}
async function runPublicCoderResume(argv, env, io) {
  const runId = argv[0];
  if (runId === void 0 || runId.trim() === "" || runId.startsWith("-")) {
    presentStructuralRejection(
      new CliUsageError("usage: ak-role resume <runId>"),
      io
    );
    return { exitCode: 2 };
  }
  if (argv.length > 1) {
    presentStructuralRejection(
      new CliUsageError("resume takes exactly one run id"),
      io
    );
    return { exitCode: 2 };
  }
  let loaded;
  try {
    loaded = await loadResumableCoderRun(env.home, runId);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  const { admitted } = loaded;
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }
  let methodProvenance;
  if (admitted.phase === "apply") {
    try {
      const material = await loadPackagedMethodSkillMaterial(
        env.packageRoot,
        "tdd"
      );
      methodProvenance = material.provenance;
    } catch (error) {
      await lease.release();
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation"
        },
        io
      );
    }
  }
  const extraArgs = buildCoderResumeActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedCoder({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    ...methodProvenance === void 0 ? {} : { methodProvenance }
  });
}
var init_coder_run = __esm({
  "src/public-cli/coder-run.ts"() {
    "use strict";
    init_method_skill();
    init_explicit_internal();
    init_cli_errors();
    init_invocation();
    init_config2();
    init_public_run_credentials();
    init_run_lifecycle();
    init_settlement();
  }
});

// src/public-cli/collector-run.ts
import { writeFile as writeFile6 } from "node:fs/promises";
import { join as join10 } from "node:path";
function buildModelArgs2(model) {
  if (model === void 0) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking
  ];
}
function buildCollectorActivationExtraArgs(admitted, options = {}) {
  const prompt = buildCollectorTransportPrompt(admitted);
  return [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "collector",
    "--ak-collector-repo",
    admitted.repository.display,
    "--ak-collector-pr",
    String(admitted.prNumber),
    ...admitted.requestManifestPath === void 0 ? [] : ["--ak-collector-request-manifest", admitted.requestManifestPath],
    "--mode",
    "json",
    ...buildModelArgs2(options.model),
    prompt
  ];
}
async function presentControlledFailure2(admitted, failureInput, io) {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session = !hasThrown && !failureInput.timedOut && failureInput.knownFailure === void 0 && failureInput.knownCause === void 0 ? await inspectJudgeSession(admitted.sessionFile) : void 0;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...hasThrown ? { thrown: failureInput.thrown } : {},
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...failureInput.knownCause === void 0 ? {} : { knownCause: failureInput.knownCause },
    ...failureInput.knownIdentity === void 0 ? {} : { knownIdentity: failureInput.knownIdentity },
    ...failureInput.knownDiagnostic === void 0 ? {} : { knownDiagnostic: failureInput.knownDiagnostic },
    ...session === void 0 ? {} : { session }
  });
  await markRunTerminal(admitted.runDirectory).catch(() => void 0);
  const terminal = await settleFailureTerminalResult(admitted, failure);
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal
  };
}
async function dispatchAdmittedCollector(input) {
  const { admitted, env, io, extraArgs, lease } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials
    );
    if (missingCredential !== void 0) {
      return await presentControlledFailure2(
        admitted,
        missingCredential,
        io
      );
    }
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    const childEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory
    };
    if (env.correlationId !== void 0 && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
    }
    let result2;
    try {
      result2 = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs,
        cwd: admitted.projectRoot,
        home: env.home,
        agentDir: env.agentDir,
        env: childEnv,
        timeoutMs: env.timeoutMs,
        ...env.piRunner === void 0 ? {} : { runner: env.piRunner }
      });
    } catch (error) {
      return await presentControlledFailure2(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error
        },
        io
      );
    }
    try {
      await writeFile6(
        join10(admitted.runDirectory, "stderr.log"),
        result2.stderr,
        "utf8"
      );
    } catch {
    }
    let lawful;
    try {
      lawful = await trySettleCollectorTerminalResult(admitted);
    } catch (error) {
      return await presentControlledFailure2(
        admitted,
        {
          timedOut: false,
          code: result2.code,
          stderr: result2.stderr,
          thrown: error
        },
        io
      );
    }
    if (lawful !== void 0) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful
      };
    }
    const infrastructureFailure = await readCollectorInfrastructureFailure(
      admitted.sessionFile
    );
    const credentialFailure = postRunMissingCredentialFailure(
      result2,
      env.model,
      env.credentials
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result2.knownFailure ?? (infrastructureFailure === void 0 ? void 0 : {
        cause: infrastructureFailure.cause,
        diagnostic: infrastructureFailure.diagnostic,
        ...infrastructureFailure.identity === void 0 ? {} : { identity: infrastructureFailure.identity }
      }),
      sessionFile: admitted.sessionFile,
      credential: credentialFailure
    });
    return await presentControlledFailure2(
      admitted,
      {
        timedOut: result2.timedOut,
        code: result2.code,
        stderr: result2.stderr,
        ...knownFailure === void 0 ? {} : { knownFailure }
      },
      io
    );
  } finally {
    await lease.release();
  }
}
async function runPublicCollector(argv, env, io, parseCollectorArgv2) {
  let admitted;
  try {
    const parsed = parseCollectorArgv2(argv);
    admitted = await admitCollectorInvocation({
      home: env.home,
      cwd: env.cwd,
      prNumber: parsed.prNumber,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...parsed.project === void 0 ? {} : { project: parsed.project },
      ...parsed.repo === void 0 ? {} : { repo: parsed.repo },
      ...parsed.requestManifestPath === void 0 ? {} : { requestManifestPath: parsed.requestManifestPath },
      ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  await markRunAdmitted(admitted);
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  const extraArgs = buildCollectorActivationExtraArgs(admitted, {
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedCollector({
    admitted,
    env,
    io,
    extraArgs,
    lease
  });
}
var init_collector_run = __esm({
  "src/public-cli/collector-run.ts"() {
    "use strict";
    init_explicit_internal();
    init_cli_errors();
    init_invocation();
    init_config2();
    init_public_run_credentials();
    init_run_lifecycle();
    init_settlement();
  }
});

// src/public-cli/doctor-run.ts
import { writeFile as writeFile7 } from "node:fs/promises";
import { join as join11 } from "node:path";
function buildModelArgs3(model) {
  if (model === void 0) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking
  ];
}
function buildDoctorActivationExtraArgs(admitted, options = {}) {
  const prompt = buildDoctorTransportPrompt(admitted);
  return [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "doctor",
    "--ak-doctor-case",
    admitted.caseRunsPath,
    "--mode",
    "json",
    ...buildModelArgs3(options.model),
    prompt
  ];
}
async function presentControlledFailure3(admitted, failureInput, io) {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session = !hasThrown && !failureInput.timedOut && failureInput.knownFailure === void 0 ? await inspectJudgeSession(admitted.sessionFile) : void 0;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...hasThrown ? { thrown: failureInput.thrown } : {},
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...session === void 0 ? {} : { session }
  });
  await markRunTerminal(admitted.runDirectory).catch(() => void 0);
  const terminal = await settleFailureTerminalResult(admitted, failure);
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal
  };
}
async function dispatchAdmittedDoctor(input) {
  const { admitted, env, io, extraArgs, lease } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials
    );
    if (missingCredential !== void 0) {
      return await presentControlledFailure3(
        admitted,
        missingCredential,
        io
      );
    }
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    const childEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory
    };
    if (env.correlationId !== void 0 && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
    }
    let result2;
    try {
      result2 = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs,
        cwd: admitted.projectRoot,
        home: env.home,
        agentDir: env.agentDir,
        env: childEnv,
        timeoutMs: env.timeoutMs,
        ...env.piRunner === void 0 ? {} : { runner: env.piRunner }
      });
    } catch (error) {
      return await presentControlledFailure3(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error
        },
        io
      );
    }
    try {
      await writeFile7(
        join11(admitted.runDirectory, "stderr.log"),
        result2.stderr,
        "utf8"
      );
    } catch {
    }
    let lawful;
    try {
      lawful = await trySettleDoctorTerminalResult(admitted);
    } catch (error) {
      return await presentControlledFailure3(
        admitted,
        {
          timedOut: false,
          code: result2.code,
          stderr: result2.stderr,
          thrown: error
        },
        io
      );
    }
    if (lawful !== void 0 && isLawfulTypedTerminalOutcome(lawful.roleOutcome)) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful
      };
    }
    const auditIncomplete = await trySettleComplianceAuditIncompleteTerminalResult(admitted);
    if (auditIncomplete !== void 0) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      if (auditIncomplete.roleOutcome.kind === "failure") {
        presentFailureTerminal(auditIncomplete, io);
      } else {
        io.stdout(formatTerminalResult(auditIncomplete));
      }
      return {
        exitCode: exitCodeForTerminalOutcome(auditIncomplete.roleOutcome),
        admitted,
        terminal: auditIncomplete
      };
    }
    const credentialFailure = postRunMissingCredentialFailure(
      result2,
      env.model,
      env.credentials
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result2.knownFailure,
      sessionFile: admitted.sessionFile,
      credential: credentialFailure
    });
    return await presentControlledFailure3(
      admitted,
      {
        timedOut: result2.timedOut,
        code: result2.code,
        stderr: result2.stderr,
        ...knownFailure === void 0 ? {} : { knownFailure }
      },
      io
    );
  } finally {
    await lease.release();
  }
}
async function runPublicDoctor(argv, env, io, parseDoctorArgv2) {
  let admitted;
  try {
    const parsed = parseDoctorArgv2(argv);
    admitted = await admitDoctorInvocation({
      home: env.home,
      cwd: env.cwd,
      issueNumber: parsed.issueNumber,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...parsed.project === void 0 ? {} : { project: parsed.project },
      ...parsed.runs === void 0 ? {} : { runs: parsed.runs },
      ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  await markRunAdmitted(admitted);
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  const extraArgs = buildDoctorActivationExtraArgs(admitted, {
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedDoctor({
    admitted,
    env,
    io,
    extraArgs,
    lease
  });
}
var init_doctor_run = __esm({
  "src/public-cli/doctor-run.ts"() {
    "use strict";
    init_explicit_internal();
    init_cli_errors();
    init_invocation();
    init_config2();
    init_public_run_credentials();
    init_run_lifecycle();
    init_settlement();
  }
});

// src/public-cli/fixer-run.ts
import { writeFile as writeFile8 } from "node:fs/promises";
import { join as join12 } from "node:path";
function buildModelArgs4(model) {
  if (model === void 0) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking
  ];
}
function buildFixerActivationExtraArgs(admitted, options) {
  const prompt = buildFixerTransportPrompt(admitted);
  const diagnosisSkillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "diagnosing-bugs"
  );
  const tddSkillPath = resolvePackagedMethodSkillPath(options.packageRoot, "tdd");
  const prerequisiteArgs = admitted.prerequisitesPath === void 0 ? [] : ["--ak-fixer-prerequisites", admitted.prerequisitesPath];
  return [
    "--no-skills",
    "--skill",
    diagnosisSkillPath,
    "--skill",
    tddSkillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "fixer",
    "--ak-fixer-phase",
    admitted.phase,
    "--ak-fix-packet",
    admitted.packetPath,
    ...prerequisiteArgs,
    "--mode",
    "json",
    ...buildModelArgs4(options.model),
    prompt
  ];
}
function buildFixerResumeActivationExtraArgs(admitted, options) {
  const diagnosisSkillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "diagnosing-bugs"
  );
  const tddSkillPath = resolvePackagedMethodSkillPath(options.packageRoot, "tdd");
  const prerequisiteArgs = admitted.prerequisitesPath === void 0 ? [] : ["--ak-fixer-prerequisites", admitted.prerequisitesPath];
  return [
    "--no-skills",
    "--skill",
    diagnosisSkillPath,
    "--skill",
    tddSkillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "fixer",
    "--ak-fixer-phase",
    admitted.phase,
    "--ak-fix-packet",
    admitted.packetPath,
    ...prerequisiteArgs,
    "--mode",
    "json",
    ...buildModelArgs4(options.model),
    RESUME_TRANSPORT_ENVELOPE
  ];
}
async function presentControlledFailure4(admitted, failureInput, io) {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session = !hasThrown && !failureInput.timedOut && failureInput.knownFailure === void 0 ? await inspectJudgeSession(admitted.sessionFile) : void 0;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...hasThrown ? { thrown: failureInput.thrown } : {},
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...session === void 0 ? {} : { session }
  });
  const hasLawfulTerminalResult = await hasLawfulFixerTerminalResult(admitted);
  const typedHttp429 = await readTypedHttp429Observation(admitted.runDirectory);
  const sessionPrincipalAvailable = await isSessionPrincipalAvailable(
    admitted.sessionFile
  );
  const resumable = sessionPrincipalAvailable && isV1ResumableFailure({
    hasLawfulTerminalResult,
    ...typedHttp429 === void 0 ? {} : { typedHttp429 }
  });
  if (resumable && typedHttp429 !== void 0) {
    await markRunResumable(admitted.runDirectory, typedHttp429);
  } else {
    await markRunTerminal(admitted.runDirectory).catch(() => void 0);
  }
  const terminal = await settleFailureTerminalResult(
    admitted,
    failure,
    resumable ? { resume: { command: renderResumeCommand(admitted.runId) } } : {}
  );
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal
  };
}
async function dispatchAdmittedFixer(input) {
  const { admitted, env, io, extraArgs, lease, methodMaterial } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials
    );
    if (missingCredential !== void 0) {
      return await presentControlledFailure4(
        admitted,
        missingCredential,
        io
      );
    }
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    const childEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory
    };
    if (env.correlationId !== void 0 && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
    }
    let result2;
    try {
      result2 = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs,
        cwd: admitted.projectRoot,
        home: env.home,
        agentDir: env.agentDir,
        env: childEnv,
        timeoutMs: env.timeoutMs,
        ...env.piRunner === void 0 ? {} : { runner: env.piRunner }
      });
    } catch (error) {
      return await presentControlledFailure4(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error
        },
        io
      );
    }
    try {
      await writeFile8(
        join12(admitted.runDirectory, "stderr.log"),
        result2.stderr,
        "utf8"
      );
    } catch {
    }
    let lawful;
    try {
      lawful = await trySettleFixerTerminalResult(admitted, {
        methodProvenance: methodMaterial.provenance,
        methodSkillPath: methodMaterial.skillPath,
        methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
          env.packageRoot,
          "diagnosing-bugs"
        )
      });
    } catch (error) {
      return await presentControlledFailure4(
        admitted,
        {
          timedOut: false,
          code: result2.code,
          stderr: result2.stderr,
          thrown: error
        },
        io
      );
    }
    if (lawful !== void 0 && isLawfulTypedTerminalOutcome(lawful.roleOutcome)) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful
      };
    }
    const auditIncomplete = await trySettleComplianceAuditIncompleteTerminalResult(admitted);
    if (auditIncomplete !== void 0) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      if (auditIncomplete.roleOutcome.kind === "failure") {
        presentFailureTerminal(auditIncomplete, io);
      } else {
        io.stdout(formatTerminalResult(auditIncomplete));
      }
      return {
        exitCode: exitCodeForTerminalOutcome(auditIncomplete.roleOutcome),
        admitted,
        terminal: auditIncomplete
      };
    }
    const credentialFailure = postRunMissingCredentialFailure(
      result2,
      env.model,
      env.credentials
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result2.knownFailure,
      sessionFile: admitted.sessionFile,
      credential: credentialFailure
    });
    return await presentControlledFailure4(
      admitted,
      {
        timedOut: result2.timedOut,
        code: result2.code,
        stderr: result2.stderr,
        ...knownFailure === void 0 ? {} : { knownFailure }
      },
      io
    );
  } finally {
    await lease.release();
  }
}
async function loadFixerMethodMaterial(packageRoot2) {
  return await loadPackagedMethodSkillMaterial(packageRoot2, "diagnosing-bugs");
}
async function runPublicFixer(argv, env, io, parseFixerArgv2) {
  let admitted;
  try {
    const parsed = parseFixerArgv2(argv);
    admitted = await admitFixerInvocation({
      home: env.home,
      cwd: env.cwd,
      phase: parsed.phase,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...parsed.prerequisitesPath === void 0 ? {} : { prerequisitesPath: parsed.prerequisitesPath },
      ...parsed.project === void 0 ? {} : { project: parsed.project },
      ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  await markRunAdmitted(admitted);
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  let methodMaterial;
  try {
    methodMaterial = await loadFixerMethodMaterial(env.packageRoot);
  } catch (error) {
    await lease.release();
    return await presentControlledFailure4(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error
      },
      io
    );
  }
  const extraArgs = buildFixerActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedFixer({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial
  });
}
async function runPublicFixerResume(argv, env, io) {
  const runId = argv[0];
  if (runId === void 0 || runId.trim() === "" || runId.startsWith("-")) {
    presentStructuralRejection(
      new CliUsageError("usage: ak-role resume <runId>"),
      io
    );
    return { exitCode: 2 };
  }
  if (argv.length > 1) {
    presentStructuralRejection(
      new CliUsageError("resume takes exactly one run id"),
      io
    );
    return { exitCode: 2 };
  }
  let loaded;
  try {
    loaded = await loadResumableFixerRun(env.home, runId);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  const { admitted } = loaded;
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }
  let methodMaterial;
  try {
    methodMaterial = await loadFixerMethodMaterial(env.packageRoot);
  } catch (error) {
    await lease.release();
    return await presentControlledFailure4(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error
      },
      io
    );
  }
  const extraArgs = buildFixerResumeActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedFixer({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial
  });
}
var init_fixer_run = __esm({
  "src/public-cli/fixer-run.ts"() {
    "use strict";
    init_method_skill();
    init_explicit_internal();
    init_cli_errors();
    init_invocation();
    init_config2();
    init_public_run_credentials();
    init_run_lifecycle();
    init_settlement();
  }
});

// src/public-cli/judge-run.ts
import { writeFile as writeFile9 } from "node:fs/promises";
import { join as join13 } from "node:path";
function buildModelArgs5(model) {
  if (model === void 0) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking
  ];
}
function buildJudgeActivationExtraArgs(admitted, options = {}) {
  const prompt = buildJudgeTransportPrompt(admitted);
  return [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    // Exact Pi session file principal (SessionManager.open), not directory-latest.
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "judge",
    "--mode",
    "json",
    ...buildModelArgs5(options.model),
    prompt
  ];
}
function buildJudgeResumeActivationExtraArgs(admitted, options = {}) {
  return [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "judge",
    "--mode",
    "json",
    ...buildModelArgs5(options.model),
    RESUME_TRANSPORT_ENVELOPE
  ];
}
async function presentControlledFailure5(admitted, failureInput, io) {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session = !hasThrown && !failureInput.timedOut && failureInput.knownFailure === void 0 ? await inspectJudgeSession(admitted.sessionFile) : void 0;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...hasThrown ? { thrown: failureInput.thrown } : {},
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...session === void 0 ? {} : { session }
  });
  const hasLawfulTerminalResult = await hasLawfulJudgeTerminalResult(admitted);
  const typedHttp429 = await readTypedHttp429Observation(admitted.runDirectory);
  const sessionPrincipalAvailable = await isSessionPrincipalAvailable(
    admitted.sessionFile
  );
  const resumable = sessionPrincipalAvailable && isV1ResumableFailure({
    hasLawfulTerminalResult,
    ...typedHttp429 === void 0 ? {} : { typedHttp429 }
  });
  if (resumable && typedHttp429 !== void 0) {
    await markRunResumable(admitted.runDirectory, typedHttp429);
  } else {
    await markRunTerminal(admitted.runDirectory).catch(() => void 0);
  }
  const terminal = await settleJudgeFailureTerminalResult(
    admitted,
    failure,
    resumable ? { resume: { command: renderResumeCommand(admitted.runId) } } : {}
  );
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal
  };
}
async function dispatchAdmittedJudge(input) {
  const { admitted, env, io, extraArgs, lease } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials
    );
    if (missingCredential !== void 0) {
      return await presentControlledFailure5(
        admitted,
        missingCredential,
        io
      );
    }
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    const childEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      // Public-run marker so Navigator work context prefers admitted instruction
      // and role-runtime can record typed provider HTTP observations.
      AK_ROLE_RUN_DIR: admitted.runDirectory
    };
    if (env.correlationId !== void 0 && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
    }
    let result2;
    try {
      result2 = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs,
        cwd: admitted.projectRoot,
        home: env.home,
        agentDir: env.agentDir,
        env: childEnv,
        timeoutMs: env.timeoutMs,
        ...env.piRunner === void 0 ? {} : { runner: env.piRunner }
      });
    } catch (error) {
      return await presentControlledFailure5(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error
        },
        io
      );
    }
    try {
      await writeFile9(
        join13(admitted.runDirectory, "stderr.log"),
        result2.stderr,
        "utf8"
      );
    } catch {
    }
    let lawful;
    try {
      lawful = await trySettleJudgeTerminalResult(admitted);
    } catch (error) {
      return await presentControlledFailure5(
        admitted,
        {
          timedOut: false,
          code: result2.code,
          stderr: result2.stderr,
          thrown: error
        },
        io
      );
    }
    if (lawful !== void 0 && isLawfulTypedTerminalOutcome(lawful.roleOutcome)) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful
      };
    }
    const auditIncomplete = await trySettleComplianceAuditIncompleteTerminalResult(admitted);
    if (auditIncomplete !== void 0) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      if (auditIncomplete.roleOutcome.kind === "failure") {
        presentFailureTerminal(auditIncomplete, io);
      } else {
        io.stdout(formatTerminalResult(auditIncomplete));
      }
      return {
        exitCode: exitCodeForTerminalOutcome(auditIncomplete.roleOutcome),
        admitted,
        terminal: auditIncomplete
      };
    }
    const credentialFailure = postRunMissingCredentialFailure(
      result2,
      env.model,
      env.credentials
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result2.knownFailure,
      sessionFile: admitted.sessionFile,
      credential: credentialFailure
    });
    return await presentControlledFailure5(
      admitted,
      {
        timedOut: result2.timedOut,
        code: result2.code,
        stderr: result2.stderr,
        ...knownFailure === void 0 ? {} : { knownFailure }
      },
      io
    );
  } finally {
    await lease.release();
  }
}
async function runPublicJudge(argv, env, io, parseJudgeArgv2) {
  let admitted;
  try {
    const parsed = parseJudgeArgv2(argv);
    admitted = await admitJudgeInvocation({
      home: env.home,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...parsed.project === void 0 ? {} : { project: parsed.project },
      ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  await markRunAdmitted(admitted);
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  const extraArgs = buildJudgeActivationExtraArgs(admitted, {
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedJudge({
    admitted,
    env,
    io,
    extraArgs,
    lease
  });
}
async function runPublicResume(argv, env, io) {
  const runId = argv[0];
  if (runId === void 0 || runId.trim() === "" || runId.startsWith("-")) {
    presentStructuralRejection(
      new CliUsageError("usage: ak-role resume <runId>"),
      io
    );
    return { exitCode: 2 };
  }
  if (argv.length > 1) {
    presentStructuralRejection(
      new CliUsageError("resume takes exactly one run id"),
      io
    );
    return { exitCode: 2 };
  }
  let loaded;
  try {
    loaded = await loadResumableJudgeRun(env.home, runId);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  const { admitted } = loaded;
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }
  const extraArgs = buildJudgeResumeActivationExtraArgs(admitted, {
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedJudge({
    admitted,
    env,
    io,
    extraArgs,
    lease
  });
}
var init_judge_run = __esm({
  "src/public-cli/judge-run.ts"() {
    "use strict";
    init_explicit_internal();
    init_cli_errors();
    init_invocation();
    init_config2();
    init_public_run_credentials();
    init_run_lifecycle();
    init_settlement();
  }
});

// src/public-cli/merger-run.ts
import { mkdir as mkdir4, writeFile as writeFile10 } from "node:fs/promises";
import { join as join14, resolve as resolve7 } from "node:path";
function buildModelArgs6(model) {
  if (model === void 0) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking
  ];
}
function buildMergerActivationExtraArgs(admitted, options) {
  const prompt = buildMergerTransportPrompt(admitted);
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "resolving-merge-conflicts"
  );
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "merger",
    "--ak-merger-input",
    admitted.mergerInputPath,
    "--mode",
    "json",
    ...buildModelArgs6(options.model),
    prompt
  ];
}
function buildMergerResumeActivationExtraArgs(admitted, options) {
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "resolving-merge-conflicts"
  );
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "merger",
    "--ak-merger-input",
    admitted.mergerInputPath,
    "--mode",
    "json",
    ...buildModelArgs6(options.model),
    RESUME_TRANSPORT_ENVELOPE
  ];
}
async function presentControlledFailure6(admitted, failureInput, io) {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session = !hasThrown && !failureInput.timedOut && failureInput.knownFailure === void 0 && failureInput.knownCause === void 0 ? await inspectJudgeSession(admitted.sessionFile) : void 0;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...hasThrown ? { thrown: failureInput.thrown } : {},
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...failureInput.knownCause === void 0 ? {} : { knownCause: failureInput.knownCause },
    ...failureInput.knownIdentity === void 0 ? {} : { knownIdentity: failureInput.knownIdentity },
    ...failureInput.knownDiagnostic === void 0 ? {} : { knownDiagnostic: failureInput.knownDiagnostic },
    ...session === void 0 ? {} : { session }
  });
  const hasLawfulTerminalResult = await hasLawfulMergerTerminalResult(admitted);
  const typedHttp429 = await readTypedHttp429Observation(admitted.runDirectory);
  const sessionPrincipalAvailable = await isSessionPrincipalAvailable(
    admitted.sessionFile
  );
  const resumable = sessionPrincipalAvailable && isV1ResumableFailure({
    hasLawfulTerminalResult,
    ...typedHttp429 === void 0 ? {} : { typedHttp429 }
  });
  if (resumable && typedHttp429 !== void 0) {
    await markRunResumable(admitted.runDirectory, typedHttp429);
  } else {
    await markRunTerminal(admitted.runDirectory).catch(() => void 0);
  }
  const terminal = await settleFailureTerminalResult(
    admitted,
    failure,
    resumable ? { resume: { command: renderResumeCommand(admitted.runId) } } : {}
  );
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal
  };
}
async function dispatchAdmittedMerger(input) {
  const { admitted, env, io, extraArgs, lease, methodMaterial } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials
    );
    if (missingCredential !== void 0) {
      return await presentControlledFailure6(
        admitted,
        missingCredential,
        io
      );
    }
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    const childEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory
    };
    if (env.correlationId !== void 0 && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
    }
    let result2;
    try {
      result2 = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs,
        cwd: admitted.projectRoot,
        home: env.home,
        agentDir: env.agentDir,
        env: childEnv,
        timeoutMs: env.timeoutMs,
        ...env.piRunner === void 0 ? {} : { runner: env.piRunner }
      });
    } catch (error) {
      return await presentControlledFailure6(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error
        },
        io
      );
    }
    try {
      await writeFile10(
        join14(admitted.runDirectory, "stderr.log"),
        result2.stderr,
        "utf8"
      );
    } catch {
    }
    let lawful;
    try {
      lawful = await trySettleMergerTerminalResult(admitted, {
        methodProvenance: methodMaterial.provenance,
        methodSkillPath: methodMaterial.skillPath,
        methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
          env.packageRoot,
          "resolving-merge-conflicts"
        )
      });
    } catch (error) {
      return await presentControlledFailure6(
        admitted,
        {
          timedOut: false,
          code: result2.code,
          stderr: result2.stderr,
          thrown: error
        },
        io
      );
    }
    if (lawful !== void 0) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful
      };
    }
    const credentialFailure = postRunMissingCredentialFailure(
      result2,
      env.model,
      env.credentials
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result2.knownFailure,
      sessionFile: admitted.sessionFile,
      credential: credentialFailure
    });
    return await presentControlledFailure6(
      admitted,
      {
        timedOut: result2.timedOut,
        code: result2.code,
        stderr: result2.stderr,
        ...knownFailure === void 0 ? {} : { knownFailure }
      },
      io
    );
  } finally {
    await lease.release();
  }
}
async function loadMergerMethodMaterial(packageRoot2) {
  return await loadPackagedMethodSkillMaterial(
    packageRoot2,
    "resolving-merge-conflicts"
  );
}
async function admitMergerShellForActivationFailure(options) {
  const projectRoot = resolve7(options.project ?? options.cwd);
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join14(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@merger`
  );
  const sessionDirectory = join14(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  await mkdir4(runDirectory, { recursive: true });
  const emptyDerived = {
    targetObjectId: "",
    sourceObjectId: "",
    automaticMergeTreeId: "",
    expectedConflictPaths: [],
    resolutionScope: []
  };
  const admittedRequestPath = join14(runDirectory, "admitted-request.json");
  const mergerInputPath = join14(runDirectory, "merger-input.json");
  await writeFile10(
    admittedRequestPath,
    `${JSON.stringify(
      {
        role: "merger",
        runId,
        bookKey,
        projectRoot,
        instruction: options.instruction,
        instructionEmpty: false,
        mergerInputPath,
        derived: emptyDerived,
        attachments: []
      },
      null,
      2
    )}
`,
    "utf8"
  );
  return {
    role: "merger",
    runId,
    bookKey,
    projectRoot,
    instruction: options.instruction,
    instructionEmpty: false,
    attachments: [],
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
    mergerInputPath,
    derived: emptyDerived
  };
}
async function runPublicMerger(argv, env, io, parseMergerArgv2) {
  let parsed;
  try {
    parsed = parseMergerArgv2(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  let admitted;
  try {
    admitted = await admitMergerInvocation({
      home: env.home,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...parsed.project === void 0 ? {} : { project: parsed.project },
      ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    if (error instanceof MergerEnvelopeDerivationError) {
      const shell = await admitMergerShellForActivationFailure({
        home: env.home,
        cwd: env.cwd,
        instruction: parsed.instruction,
        ...parsed.project === void 0 ? {} : { project: parsed.project },
        ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
      });
      await markRunAdmitted(shell);
      return await presentControlledFailure6(
        shell,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation",
          knownDiagnostic: error.message
        },
        io
      );
    }
    throw error;
  }
  await markRunAdmitted(admitted);
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  let methodMaterial;
  try {
    methodMaterial = await loadMergerMethodMaterial(env.packageRoot);
  } catch (error) {
    await lease.release();
    return await presentControlledFailure6(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
        knownCause: "activation"
      },
      io
    );
  }
  const extraArgs = buildMergerActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedMerger({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial
  });
}
async function runPublicMergerResume(argv, env, io) {
  const runId = argv[0];
  if (runId === void 0 || runId.trim() === "" || runId.startsWith("-")) {
    presentStructuralRejection(
      new CliUsageError("usage: ak-role resume <runId>"),
      io
    );
    return { exitCode: 2 };
  }
  if (argv.length > 1) {
    presentStructuralRejection(
      new CliUsageError("resume takes exactly one run id"),
      io
    );
    return { exitCode: 2 };
  }
  let loaded;
  try {
    loaded = await loadResumableMergerRun(env.home, runId);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  const { admitted } = loaded;
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }
  let methodMaterial;
  try {
    methodMaterial = await loadMergerMethodMaterial(env.packageRoot);
  } catch (error) {
    await lease.release();
    return await presentControlledFailure6(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
        knownCause: "activation"
      },
      io
    );
  }
  const extraArgs = buildMergerResumeActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedMerger({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial
  });
}
var init_merger_run = __esm({
  "src/public-cli/merger-run.ts"() {
    "use strict";
    init_activation_ledger_git();
    init_activation_ledger_topology();
    init_method_skill();
    init_uuidv7();
    init_explicit_internal();
    init_cli_errors();
    init_invocation();
    init_config2();
    init_public_run_credentials();
    init_run_lifecycle();
    init_settlement();
  }
});

// src/public-cli/reviewer-run.ts
import { writeFile as writeFile11 } from "node:fs/promises";
import { join as join15 } from "node:path";
function buildModelArgs7(model) {
  if (model === void 0) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking
  ];
}
function buildReviewerActivationExtraArgs(admitted, options) {
  const prompt = buildReviewerTransportPrompt(admitted);
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "code-review"
  );
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "reviewer",
    "--ak-review-base",
    admitted.baseRevision,
    "--mode",
    "json",
    ...buildModelArgs7(options.model),
    prompt
  ];
}
function buildReviewerResumeActivationExtraArgs(admitted, options) {
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "code-review"
  );
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...options.extraPiArgs ?? [],
    "--ak-role",
    "reviewer",
    "--ak-review-base",
    admitted.baseRevision,
    "--mode",
    "json",
    ...buildModelArgs7(options.model),
    RESUME_TRANSPORT_ENVELOPE
  ];
}
async function presentControlledFailure7(admitted, failureInput, io) {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session = !hasThrown && !failureInput.timedOut && failureInput.knownFailure === void 0 ? await inspectJudgeSession(admitted.sessionFile) : void 0;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...hasThrown ? { thrown: failureInput.thrown } : {},
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...session === void 0 ? {} : { session }
  });
  const hasLawfulTerminalResult = await hasLawfulReviewerTerminalResult(admitted);
  const typedHttp429 = await readTypedHttp429Observation(admitted.runDirectory);
  const sessionPrincipalAvailable = await isSessionPrincipalAvailable(
    admitted.sessionFile
  );
  const resumable = sessionPrincipalAvailable && isV1ResumableFailure({
    hasLawfulTerminalResult,
    ...typedHttp429 === void 0 ? {} : { typedHttp429 }
  });
  if (resumable && typedHttp429 !== void 0) {
    await markRunResumable(admitted.runDirectory, typedHttp429);
  } else {
    await markRunTerminal(admitted.runDirectory).catch(() => void 0);
  }
  const terminal = await settleFailureTerminalResult(
    admitted,
    failure,
    resumable ? { resume: { command: renderResumeCommand(admitted.runId) } } : {}
  );
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal
  };
}
async function dispatchAdmittedReviewer(input) {
  const { admitted, env, io, extraArgs, lease, methodMaterial } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials
    );
    if (missingCredential !== void 0) {
      return await presentControlledFailure7(
        admitted,
        missingCredential,
        io
      );
    }
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    const childEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory
    };
    if (env.correlationId !== void 0 && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
    }
    let result2;
    try {
      result2 = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs,
        cwd: admitted.projectRoot,
        home: env.home,
        agentDir: env.agentDir,
        env: childEnv,
        timeoutMs: env.timeoutMs,
        ...env.piRunner === void 0 ? {} : { runner: env.piRunner }
      });
    } catch (error) {
      return await presentControlledFailure7(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error
        },
        io
      );
    }
    try {
      await writeFile11(
        join15(admitted.runDirectory, "stderr.log"),
        result2.stderr,
        "utf8"
      );
    } catch {
    }
    let lawful;
    try {
      lawful = await trySettleReviewerTerminalResult(admitted, {
        methodProvenance: methodMaterial.provenance,
        methodSkillPath: methodMaterial.skillPath,
        methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
          env.packageRoot,
          "code-review"
        )
      });
    } catch (error) {
      return await presentControlledFailure7(
        admitted,
        {
          timedOut: false,
          code: result2.code,
          stderr: result2.stderr,
          thrown: error
        },
        io
      );
    }
    if (lawful !== void 0 && isLawfulTypedTerminalOutcome(lawful.roleOutcome)) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful
      };
    }
    const auditIncomplete = await trySettleComplianceAuditIncompleteTerminalResult(admitted);
    if (auditIncomplete !== void 0) {
      await markRunTerminal(admitted.runDirectory).catch(() => void 0);
      if (auditIncomplete.roleOutcome.kind === "failure") {
        presentFailureTerminal(auditIncomplete, io);
      } else {
        io.stdout(formatTerminalResult(auditIncomplete));
      }
      return {
        exitCode: exitCodeForTerminalOutcome(auditIncomplete.roleOutcome),
        admitted,
        terminal: auditIncomplete
      };
    }
    const credentialFailure = postRunMissingCredentialFailure(
      result2,
      env.model,
      env.credentials
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result2.knownFailure,
      sessionFile: admitted.sessionFile,
      credential: credentialFailure
    });
    return await presentControlledFailure7(
      admitted,
      {
        timedOut: result2.timedOut,
        code: result2.code,
        stderr: result2.stderr,
        ...knownFailure === void 0 ? {} : { knownFailure }
      },
      io
    );
  } finally {
    await lease.release();
  }
}
async function loadReviewerMethodMaterial(packageRoot2) {
  return await loadPackagedMethodSkillMaterial(packageRoot2, "code-review");
}
async function runPublicReviewer(argv, env, io, parseReviewerArgv2) {
  let admitted;
  try {
    const parsed = parseReviewerArgv2(argv);
    admitted = await admitReviewerInvocation({
      home: env.home,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      baseRevision: parsed.baseRevision,
      ...parsed.project === void 0 ? {} : { project: parsed.project },
      ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  await markRunAdmitted(admitted);
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  let methodMaterial;
  try {
    methodMaterial = await loadReviewerMethodMaterial(env.packageRoot);
  } catch (error) {
    await lease.release();
    return await presentControlledFailure7(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error
      },
      io
    );
  }
  const extraArgs = buildReviewerActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedReviewer({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial
  });
}
async function runPublicReviewerResume(argv, env, io) {
  const runId = argv[0];
  if (runId === void 0 || runId.trim() === "" || runId.startsWith("-")) {
    presentStructuralRejection(
      new CliUsageError("usage: ak-role resume <runId>"),
      io
    );
    return { exitCode: 2 };
  }
  if (argv.length > 1) {
    presentStructuralRejection(
      new CliUsageError("resume takes exactly one run id"),
      io
    );
    return { exitCode: 2 };
  }
  let loaded;
  try {
    loaded = await loadResumableReviewerRun(env.home, runId);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
  const { admitted } = loaded;
  let lease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }
  let methodMaterial;
  try {
    methodMaterial = await loadReviewerMethodMaterial(env.packageRoot);
  } catch (error) {
    await lease.release();
    return await presentControlledFailure7(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error
      },
      io
    );
  }
  const extraArgs = buildReviewerResumeActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...env.model === void 0 ? {} : { model: env.model },
    ...env.extraPiArgs === void 0 ? {} : { extraPiArgs: env.extraPiArgs }
  });
  return await dispatchAdmittedReviewer({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial
  });
}
var init_reviewer_run = __esm({
  "src/public-cli/reviewer-run.ts"() {
    "use strict";
    init_method_skill();
    init_explicit_internal();
    init_cli_errors();
    init_invocation();
    init_config2();
    init_public_run_credentials();
    init_run_lifecycle();
    init_settlement();
  }
});

// src/public-cli/cli.ts
var cli_exports = {};
__export(cli_exports, {
  CliUsageError: () => CliUsageError,
  buildExplicitInternalActivationArgs: () => buildExplicitInternalActivationArgs,
  helpDocument: () => helpDocument,
  resolveInternalRoleEntrypoint: () => resolveInternalRoleEntrypoint,
  runAkRole: () => runAkRole
});
import { homedir as homedir3 } from "node:os";
import { join as join16 } from "node:path";
function defaultIo() {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    }
  };
}
function resolveHome(env) {
  return env.home ?? process.env.HOME ?? homedir3();
}
function resolveAgentDir(env, home) {
  return env.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join16(home, ".pi", "agent");
}
function parseThinking(value) {
  if (!THINKING_LEVELS2.has(value)) {
    throw new CliUsageError(`unknown thinking level: ${value}`);
  }
  return value;
}
function parseArgv(argv) {
  const args = [...argv];
  let model;
  let thinking;
  let help = false;
  const positional = [];
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--") {
      positional.push(...args);
      break;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--model") {
      const value = args.shift();
      if (value === void 0) throw new CliUsageError("--model requires a value");
      model = value;
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
      continue;
    }
    if (token === "--thinking") {
      const value = args.shift();
      if (value === void 0) throw new CliUsageError("--thinking requires a value");
      thinking = parseThinking(value);
      continue;
    }
    if (token.startsWith("--thinking=")) {
      thinking = parseThinking(token.slice("--thinking=".length));
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      positional.push(token);
      continue;
    }
    positional.push(token);
  }
  const [command, ...rest] = positional;
  return {
    ...command === void 0 ? {} : { command },
    args: rest,
    ...model === void 0 ? {} : { model },
    ...thinking === void 0 ? {} : { thinking },
    help
  };
}
function invocationFromParsed(parsed) {
  if (parsed.model === void 0 && parsed.thinking === void 0) return void 0;
  return {
    ...parsed.model === void 0 ? {} : { model: parsed.model },
    ...parsed.thinking === void 0 ? {} : { thinking: parsed.thinking }
  };
}
function helpDocument() {
  return {
    executable: "ak-role",
    capabilities: listHelpCapabilities(),
    internalEntrypoint: INTERNAL_ROLE_ENTRYPOINT_RELATIVE
  };
}
function renderHelp() {
  const doc = helpDocument();
  const lines = [
    "ak-role \u2014 public role CLI",
    "",
    "Support commands:"
  ];
  for (const cap of doc.capabilities) {
    if (cap.kind === "support") {
      lines.push(`  ${cap.name}`);
    }
  }
  lines.push("", "Callable roles:");
  for (const cap of doc.capabilities) {
    if (cap.kind === "role") {
      const phaseText = cap.phases.length === 1 && cap.phases[0] === null ? "no phase" : `phases ${cap.phases.filter((p) => p !== null).join("|")}` + (cap.defaultPhase ? ` (default ${cap.defaultPhase})` : "");
      lines.push(`  ${cap.name} \u2014 ${phaseText}`);
    }
  }
  lines.push(
    "",
    "Global options: --model provider/model --thinking level",
    "Persistent config: ak-role config set <seat> <provider/model:thinking>",
    "Effective seats: ak-role roles"
  );
  return `${lines.join("\n")}
`;
}
function renderRoles(seats) {
  const lines = ["seat	kind	source	model"];
  for (const seat of seats) {
    const kind = seat.automatic ? "automatic" : "callable";
    const model = seat.selection === void 0 ? "-" : formatModelSpec(seat.selection);
    lines.push(`${seat.seat}	${kind}	${seat.source}	${model}`);
  }
  return `${lines.join("\n")}
`;
}
function renderConfig(config) {
  const lines = ["seat	model"];
  const keys = Object.keys(config.seats);
  if (keys.length === 0) {
    lines.push("(empty)");
  } else {
    for (const seat of keys.sort()) {
      const selection = config.seats[seat];
      if (selection === void 0) continue;
      lines.push(`${seat}	${formatModelSpec(selection)}`);
    }
  }
  return `${lines.join("\n")}
`;
}
async function runConfigCommand(args, home, io) {
  if (args.length === 0 || args[0] === "get" || args[0] === "list" || args[0] === "show") {
    const config = await loadPublicCliConfig(home);
    if (args[0] === "get" && args[1] !== void 0) {
      if (!isPublicConfigurableSeat(args[1])) {
        throw new CliUsageError(`unknown configurable seat: ${args[1]}`);
      }
      const selection = config.seats[args[1]];
      if (selection === void 0) {
        io.stdout(`${args[1]}	(unconfigured)
`);
      } else {
        io.stdout(`${args[1]}	${formatModelSpec(selection)}
`);
      }
      return 0;
    }
    io.stdout(renderConfig(config));
    return 0;
  }
  if (args[0] === "set") {
    if (args.length < 3) {
      throw new CliUsageError(
        "usage: ak-role config set <seat> <provider/model:thinking>"
      );
    }
    const pairs = args.slice(1);
    if (pairs.length % 2 !== 0) {
      throw new CliUsageError(
        "config set requires seat/spec pairs: ak-role config set <seat> <spec> [<seat> <spec> ...]"
      );
    }
    let config = await loadPublicCliConfig(home);
    for (let i = 0; i < pairs.length; i += 2) {
      const seat = pairs[i];
      const spec = pairs[i + 1];
      if (!isPublicConfigurableSeat(seat)) {
        throw new CliUsageError(`unknown configurable seat: ${seat}`);
      }
      config = setPersistentSeatConfig(config, seat, parseModelSpec(spec));
    }
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config));
    return 0;
  }
  throw new CliUsageError(`unknown config subcommand: ${args[0]}`);
}
async function runAkRole(argv, env) {
  const io = env.io ?? defaultIo();
  const home = resolveHome(env);
  try {
    const parsed = parseArgv(argv);
    if (parsed.help || parsed.command === void 0 || parsed.command === "help") {
      if (parsed.command === "help" && parsed.args[0] !== void 0) {
        const topic = parsed.args[0];
        const caps = listHelpCapabilities();
        const match = caps.find((cap) => cap.name === topic);
        if (match === void 0) {
          throw new CliUsageError(`unknown help topic: ${topic}`);
        }
        if (match.kind === "support") {
          io.stdout(`command	${match.name}	kind	support
`);
        } else {
          io.stdout(
            `command	${match.name}	kind	role	phases	${match.phases.map((p) => p === null ? "none" : p).join(",")}	default	${match.defaultPhase ?? "none"}
`
          );
        }
        return { exitCode: 0 };
      }
      io.stdout(renderHelp());
      return { exitCode: 0 };
    }
    if (parsed.command === "roles") {
      if (parsed.args.length > 0) {
        throw new CliUsageError("roles takes no arguments");
      }
      const config = await loadPublicCliConfig(home);
      const credentials = env.credentials ?? await loadCredentialProviders(resolveAgentDir(env, home));
      const seats = effectiveSeatConfigurations(
        config,
        credentials,
        invocationFromParsed(parsed)
      );
      io.stdout(renderRoles(seats));
      return { exitCode: 0 };
    }
    if (parsed.command === "config") {
      return { exitCode: await runConfigCommand(parsed.args, home, io) };
    }
    if (parsed.command === "resume") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials = env.credentials ?? await loadCredentialProviders(agentDir);
      const resumeRunId = parsed.args[0];
      const resumeRole = resumeRunId === void 0 || resumeRunId.trim() === "" ? void 0 : await peekRoleRunRole(home, resumeRunId);
      if (resumeRole === "collector") {
        throw new CliUsageError(
          "collector role runs are one-shot and cannot be resumed"
        );
      }
      if (resumeRole === "doctor") {
        throw new CliUsageError(
          "doctor role runs are one-shot and cannot be resumed"
        );
      }
      const resumeSeatRole = resumeRole === "coder" ? "coder" : resumeRole === "fixer" ? "fixer" : resumeRole === "reviewer" ? "reviewer" : resumeRole === "merger" ? "merger" : "judge";
      const seat = resolveEffectiveSeat(
        config,
        resumeSeatRole,
        credentials,
        invocationFromParsed(parsed)
      );
      if (resumeRole === "coder") {
        const result3 = await runPublicCoderResume(
          parsed.args,
          {
            home,
            agentDir,
            packageRoot: env.packageRoot,
            cwd,
            credentials,
            ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
            ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
            ...seat.selection === void 0 ? {} : { model: seat.selection },
            ...env.coderExtraPiArgs === void 0 ? {} : { extraPiArgs: env.coderExtraPiArgs },
            ...env.coderTimeoutMs === void 0 ? {} : { timeoutMs: env.coderTimeoutMs }
          },
          io
        );
        return {
          exitCode: result3.exitCode,
          ...result3.terminal === void 0 ? {} : { terminal: result3.terminal }
        };
      }
      if (resumeRole === "fixer") {
        const result3 = await runPublicFixerResume(
          parsed.args,
          {
            home,
            agentDir,
            packageRoot: env.packageRoot,
            cwd,
            credentials,
            ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
            ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
            ...seat.selection === void 0 ? {} : { model: seat.selection },
            ...env.fixerExtraPiArgs === void 0 ? {} : { extraPiArgs: env.fixerExtraPiArgs },
            ...env.fixerTimeoutMs === void 0 ? {} : { timeoutMs: env.fixerTimeoutMs }
          },
          io
        );
        return {
          exitCode: result3.exitCode,
          ...result3.terminal === void 0 ? {} : { terminal: result3.terminal }
        };
      }
      if (resumeRole === "reviewer") {
        const result3 = await runPublicReviewerResume(
          parsed.args,
          {
            home,
            agentDir,
            packageRoot: env.packageRoot,
            cwd,
            credentials,
            ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
            ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
            ...seat.selection === void 0 ? {} : { model: seat.selection },
            ...env.reviewerExtraPiArgs === void 0 ? {} : { extraPiArgs: env.reviewerExtraPiArgs },
            ...env.reviewerTimeoutMs === void 0 ? {} : { timeoutMs: env.reviewerTimeoutMs }
          },
          io
        );
        return {
          exitCode: result3.exitCode,
          ...result3.terminal === void 0 ? {} : { terminal: result3.terminal }
        };
      }
      if (resumeRole === "merger") {
        const result3 = await runPublicMergerResume(
          parsed.args,
          {
            home,
            agentDir,
            packageRoot: env.packageRoot,
            cwd,
            credentials,
            ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
            ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
            ...seat.selection === void 0 ? {} : { model: seat.selection },
            ...env.mergerExtraPiArgs === void 0 ? {} : { extraPiArgs: env.mergerExtraPiArgs },
            ...env.mergerTimeoutMs === void 0 ? {} : { timeoutMs: env.mergerTimeoutMs }
          },
          io
        );
        return {
          exitCode: result3.exitCode,
          ...result3.terminal === void 0 ? {} : { terminal: result3.terminal }
        };
      }
      const result2 = await runPublicResume(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
          ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
          ...seat.selection === void 0 ? {} : { model: seat.selection },
          ...env.judgeExtraPiArgs === void 0 ? {} : { extraPiArgs: env.judgeExtraPiArgs },
          ...env.judgeTimeoutMs === void 0 ? {} : { timeoutMs: env.judgeTimeoutMs }
        },
        io
      );
      return {
        exitCode: result2.exitCode,
        ...result2.terminal === void 0 ? {} : { terminal: result2.terminal }
      };
    }
    if (isPublicCliSupportCommand(parsed.command)) {
      throw new CliUsageError(`unhandled support command: ${parsed.command}`);
    }
    if (parsed.command === "judge") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials = env.credentials ?? await loadCredentialProviders(agentDir);
      const seat = resolveEffectiveSeat(
        config,
        "judge",
        credentials,
        invocationFromParsed(parsed)
      );
      const result2 = await runPublicJudge(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
          ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
          ...seat.selection === void 0 ? {} : { model: seat.selection },
          ...env.judgeExtraPiArgs === void 0 ? {} : { extraPiArgs: env.judgeExtraPiArgs },
          ...env.judgeTimeoutMs === void 0 ? {} : { timeoutMs: env.judgeTimeoutMs },
          ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
        },
        io,
        parseJudgeArgv
      );
      return {
        exitCode: result2.exitCode,
        ...result2.terminal === void 0 ? {} : { terminal: result2.terminal }
      };
    }
    if (parsed.command === "coder") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials = env.credentials ?? await loadCredentialProviders(agentDir);
      const seat = resolveEffectiveSeat(
        config,
        "coder",
        credentials,
        invocationFromParsed(parsed)
      );
      const result2 = await runPublicCoder(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
          ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
          ...seat.selection === void 0 ? {} : { model: seat.selection },
          ...env.coderExtraPiArgs === void 0 ? {} : { extraPiArgs: env.coderExtraPiArgs },
          ...env.coderTimeoutMs === void 0 ? {} : { timeoutMs: env.coderTimeoutMs },
          ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
        },
        io,
        parseCoderArgv
      );
      return {
        exitCode: result2.exitCode,
        ...result2.terminal === void 0 ? {} : { terminal: result2.terminal }
      };
    }
    if (parsed.command === "fixer") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials = env.credentials ?? await loadCredentialProviders(agentDir);
      const seat = resolveEffectiveSeat(
        config,
        "fixer",
        credentials,
        invocationFromParsed(parsed)
      );
      const result2 = await runPublicFixer(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
          ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
          ...seat.selection === void 0 ? {} : { model: seat.selection },
          ...env.fixerExtraPiArgs === void 0 ? {} : { extraPiArgs: env.fixerExtraPiArgs },
          ...env.fixerTimeoutMs === void 0 ? {} : { timeoutMs: env.fixerTimeoutMs },
          ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
        },
        io,
        parseFixerArgv
      );
      return {
        exitCode: result2.exitCode,
        ...result2.terminal === void 0 ? {} : { terminal: result2.terminal }
      };
    }
    if (parsed.command === "collector") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials = env.credentials ?? await loadCredentialProviders(agentDir);
      const seat = resolveEffectiveSeat(
        config,
        "collector",
        credentials,
        invocationFromParsed(parsed)
      );
      const result2 = await runPublicCollector(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
          ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
          ...seat.selection === void 0 ? {} : { model: seat.selection },
          ...env.collectorExtraPiArgs === void 0 ? {} : { extraPiArgs: env.collectorExtraPiArgs },
          ...env.collectorTimeoutMs === void 0 ? {} : { timeoutMs: env.collectorTimeoutMs },
          ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
        },
        io,
        parseCollectorArgv
      );
      return {
        exitCode: result2.exitCode,
        ...result2.terminal === void 0 ? {} : { terminal: result2.terminal }
      };
    }
    if (parsed.command === "reviewer") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials = env.credentials ?? await loadCredentialProviders(agentDir);
      const seat = resolveEffectiveSeat(
        config,
        "reviewer",
        credentials,
        invocationFromParsed(parsed)
      );
      const result2 = await runPublicReviewer(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
          ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
          ...seat.selection === void 0 ? {} : { model: seat.selection },
          ...env.reviewerExtraPiArgs === void 0 ? {} : { extraPiArgs: env.reviewerExtraPiArgs },
          ...env.reviewerTimeoutMs === void 0 ? {} : { timeoutMs: env.reviewerTimeoutMs },
          ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
        },
        io,
        parseReviewerArgv
      );
      return {
        exitCode: result2.exitCode,
        ...result2.terminal === void 0 ? {} : { terminal: result2.terminal }
      };
    }
    if (parsed.command === "doctor") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials = env.credentials ?? await loadCredentialProviders(agentDir);
      const seat = resolveEffectiveSeat(
        config,
        "doctor",
        credentials,
        invocationFromParsed(parsed)
      );
      const result2 = await runPublicDoctor(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
          ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
          ...seat.selection === void 0 ? {} : { model: seat.selection },
          ...env.doctorExtraPiArgs === void 0 ? {} : { extraPiArgs: env.doctorExtraPiArgs },
          ...env.doctorTimeoutMs === void 0 ? {} : { timeoutMs: env.doctorTimeoutMs },
          ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
        },
        io,
        parseDoctorArgv
      );
      return {
        exitCode: result2.exitCode,
        ...result2.terminal === void 0 ? {} : { terminal: result2.terminal }
      };
    }
    if (parsed.command === "merger") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials = env.credentials ?? await loadCredentialProviders(agentDir);
      const seat = resolveEffectiveSeat(
        config,
        "merger",
        credentials,
        invocationFromParsed(parsed)
      );
      const result2 = await runPublicMerger(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...env.correlationId === void 0 ? {} : { correlationId: env.correlationId },
          ...env.piRunner === void 0 ? {} : { piRunner: env.piRunner },
          ...seat.selection === void 0 ? {} : { model: seat.selection },
          ...env.mergerExtraPiArgs === void 0 ? {} : { extraPiArgs: env.mergerExtraPiArgs },
          ...env.mergerTimeoutMs === void 0 ? {} : { timeoutMs: env.mergerTimeoutMs },
          ...env.createRunId === void 0 ? {} : { createRunId: env.createRunId }
        },
        io,
        parseMergerArgv
      );
      return {
        exitCode: result2.exitCode,
        ...result2.terminal === void 0 ? {} : { terminal: result2.terminal }
      };
    }
    throw new CliUsageError(`unknown command: ${parsed.command}`);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    if (error instanceof Error) {
      const label = error.name !== "" && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
      io.stderr(formatCliDiagnostic(label || error.name || "unrecognized exception"));
      return { exitCode: 1 };
    }
    io.stderr(formatCliDiagnostic(String(error)));
    return { exitCode: 1 };
  }
}
var THINKING_LEVELS2;
var init_cli = __esm({
  "src/public-cli/cli.ts"() {
    "use strict";
    init_config2();
    init_cli_errors();
    init_explicit_internal();
    init_invocation();
    init_coder_run();
    init_collector_run();
    init_doctor_run();
    init_fixer_run();
    init_judge_run();
    init_merger_run();
    init_reviewer_run();
    init_run_lifecycle();
    init_registry2();
    init_settlement();
    init_explicit_internal();
    init_cli_errors();
    THINKING_LEVELS2 = /* @__PURE__ */ new Set([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
  }
});

// src/public-cli/main.ts
import { dirname as dirname7, join as join17 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/public-cli/host-pi-runtime.ts
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
var HOST_PROVIDED_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "typebox"
];
function ensureHostPiRuntimeResolvable(packageRoot2, env = process.env) {
  const missing = missingPackages(packageRoot2);
  if (missing.length === 0) {
    return;
  }
  const hostCli = findHostPiCli(env);
  if (hostCli === void 0) {
    throw new Error(
      `ak-role cannot resolve ${missing.join(", ")} next to the installed package and found no host \`pi\` executable on PATH. Install Pi (@earendil-works/pi-coding-agent) on this machine or provide the peer packages locally.`
    );
  }
  for (const name of missing) {
    const hostDir = findPackageDirFrom(dirname(hostCli), name);
    if (hostDir === void 0) {
      throw new Error(`ak-role found the host pi at ${hostCli} but could not locate ${name} in its tree.`);
    }
    linkPackage(packageRoot2, name, hostDir);
  }
  const unresolved = missingPackages(packageRoot2);
  if (unresolved.length > 0) {
    throw new Error(
      `ak-role linked the host Pi runtime from ${hostCli} but ${unresolved.join(", ")} remained unresolvable.`
    );
  }
}
function missingPackages(packageRoot2) {
  return HOST_PROVIDED_PACKAGES.filter((name) => findPackageDirFrom(packageRoot2, name) === void 0);
}
function findPackageDirFrom(startDir, name) {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return void 0;
    }
    dir = parent;
  }
}
function findHostPiCli(env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, "pi");
    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }
  }
  return void 0;
}
function linkPackage(packageRoot2, name, targetDir) {
  const linkPath = join(packageRoot2, "node_modules", ...name.split("/"));
  mkdirSync(dirname(linkPath), { recursive: true });
  const existing = lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing !== void 0) {
    if (!existing.isSymbolicLink()) {
      throw new Error(
        `ak-role found ${linkPath} present but unresolvable; refusing to replace a non-symlink install.`
      );
    }
    rmSync(linkPath);
  }
  try {
    symlinkSync(targetDir, linkPath, "dir");
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

// src/public-cli/main.ts
var here = dirname7(fileURLToPath2(import.meta.url));
var packageRoot = join17(here, "..", "..");
ensureHostPiRuntimeResolvable(packageRoot);
var { runAkRole: runAkRole2 } = await Promise.resolve().then(() => (init_cli(), cli_exports));
var result = await runAkRole2(process.argv.slice(2), { packageRoot });
process.exitCode = result.exitCode;
