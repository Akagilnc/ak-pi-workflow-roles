import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { isUuidV7, uuidv7 } from "./uuidv7.js";
import { validateAssistedCallConfigV1, validateSelectedPiArgvV1 } from "./assisted-contracts.js";
import { acquireCurrentPositionV1 } from "./assisted-acquisition.js";
import { appendAssistedGenerationV1 as publishAssistedGenerationV1, AssistedLedgerConflictError, assistedRunDirectory, readAssistedLedgerV1 } from "./assisted-ledger.js";
import { navigatorBindingMatchesV1, validateNavigatorReceiptV1 } from "./navigator-contracts.js";
class CanonicalLifecycleResult extends Error {
  constructor(result) {
    super("canonical assisted result won publication");
    this.result = result;
  }
  result;
}
class CanonicalLifecycleTransition extends Error {
}
async function appendAssistedGenerationV1(runDirectory, event, now) {
  for (; ; ) {
    const rows = await readAssistedLedgerV1(runDirectory), winner = rows.find((row) => row.type === event.type && row.runId === event.runId && row.callId === event.callId && row.invocationId === event.invocationId && canonicalJson(row.payload) === canonicalJson(event.payload));
    if (winner) {
      const completed = event.callId && rows.find((r) => r.type === "call_completed" && r.callId === event.callId);
      if (completed) throw new CanonicalLifecycleResult(completed.payload.result);
      if (["call_started", "navigator_started", "action_reserved", "role_started", "recovered"].includes(event.type)) throw new CanonicalLifecycleTransition();
      return winner;
    }
    const active = rows.filter((r) => r.type === "call_started" && !rows.some((x) => x.type === "call_completed" && x.callId === r.callId)).at(-1), reservation = rows.find((r) => r.type === "action_reserved" && !rows.some((x) => (x.type === "role_settled" || x.type === "recovered") && x.invocationId === r.invocationId));
    if (rows.some((r) => r.type === "ended") || event.type === "ended" && (active || reservation || unresolved(rows)) || event.type === "call_started" && active || event.callId && active && active.callId !== event.callId || event.type === "action_reserved" && (reservation || unresolved(rows)) || ["navigator_started", "role_started"].includes(event.type) && unresolved(rows) || ["navigator_settled", "role_settled", "recovered"].includes(event.type) && unresolved(rows) !== event.invocationId || event.type === "call_completed" && rows.some((r) => r.type === "call_completed" && r.callId === event.callId)) throw new Error(`incompatible assisted lifecycle winner for ${event.type}`);
    try {
      return await publishAssistedGenerationV1(runDirectory, event, now);
    } catch (error) {
      if (!(error instanceof AssistedLedgerConflictError)) throw error;
    }
  }
}
async function runIndex(root, runId, parentIssue) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || !isUuidV7(runId) || parentIssue !== void 0 && (!Number.isSafeInteger(parentIssue) || parentIssue < 1)) throw new Error("invalid assisted run locator");
  const path = join(root, ".ak", "work", "assisted-runs", `${runId}.json`);
  if (parentIssue !== void 0) {
    await mkdir(join(root, ".ak", "work", "assisted-runs"), { recursive: true });
    try {
      await writeFile(path, `${canonicalJson({ version: 1, runId, parentIssue })}
`, { flag: "wx", mode: 384 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.version !== 1 || value.runId !== runId || !Number.isSafeInteger(value.parentIssue) || value.parentIssue < 1 || parentIssue !== void 0 && value.parentIssue !== parentIssue) throw new Error("assisted run index conflict");
  return value.parentIssue;
}
const configDigest = (c) => sha256Hex(canonicalJson(c));
const acquisitionDigest = (c) => sha256Hex(canonicalJson({ children: c.subject.children, acquisition: c.acquisition }));
const immutableSubject = (c) => canonicalJson({ repositoryRoot: c.subject.repositoryRoot, github: c.subject.github, parentIssue: c.subject.parentIssue });
const resolvedSubject = (s) => canonicalJson({ repositoryId: s.subject.github.id, parentId: s.subject.parent.id });
const environmentReference = (c) => `environment-policy:sha256:${sha256Hex(canonicalJson(c.execution.environment))}`;
const defaultEnvironment = () => ({ inherit: true, overrides: {}, unset: [] });
function payloadResult(row) {
  return row.type === "call_completed" ? row.payload.result : null;
}
function latestResult(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = payloadResult(rows[i]);
    if (r) return r;
  }
  return null;
}
function unresolved(rows) {
  const settled = new Set(rows.filter((r) => ["navigator_settled", "role_settled", "recovered"].includes(r.type) && r.invocationId).map((r) => r.invocationId));
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if ((r.type === "navigator_started" || r.type === "role_started") && r.invocationId && !settled.has(r.invocationId)) return r.invocationId;
  }
  return null;
}
async function publishResult(dir, result, now) {
  await appendAssistedGenerationV1(dir, { type: "call_completed", runId: result.runId, callId: result.callId, positionCursor: result.positionCursor, payload: { result } }, now);
  return result;
}
async function fenceLaunch(dir, config, kind, cursor, snapshotDigest) {
  const rows = await readAssistedLedgerV1(dir), same = rows.find((r) => r.type === "call_started" && r.callId === config.callId);
  if (!same || same.payload.configDigest !== configDigest(config)) throw new Error("incompatible assisted lifecycle truth before launch");
  const completed = rows.find((r) => r.type === "call_completed" && r.callId === config.callId);
  if (completed) throw new CanonicalLifecycleResult(completed.payload.result);
  if (unresolved(rows)) throw new Error("compatible assisted lifecycle is pending");
  if (kind === "navigator" && rows.some((r) => r.type === "navigator_settled" && r.callId === config.callId && r.positionCursor === cursor && r.payload.receipt?.snapshotDigest === snapshotDigest) || kind === "role" && rows.some((r) => (r.type === "action_reserved" || r.type === "role_started" || r.type === "role_settled") && r.callId === config.callId)) throw new Error(`compatible assisted ${kind} lifecycle already advanced`);
}
async function consult(config, position, piArgv, dir, deps, now, id) {
  await fenceLaunch(dir, config, "navigator", position.snapshot.positionCursor, position.snapshot.digest);
  const invocationId = id();
  await appendAssistedGenerationV1(dir, { type: "navigator_started", runId: config.runId, callId: config.callId, invocationId, positionCursor: position.snapshot.positionCursor, payload: { snapshotDigest: position.snapshot.digest } }, now);
  const settled = await deps.recorder.invokeNavigator({ config, position, invocationId, piArgv });
  if (settled.kind === "accepted") {
    if (settled.receipt.invocationId !== invocationId) throw new Error("Navigator invocation identity mismatch");
    const receipt = validateNavigatorReceiptV1(settled.receipt, position.snapshot, settled.evidenceRead);
    await appendAssistedGenerationV1(dir, { type: "navigator_settled", runId: config.runId, callId: config.callId, invocationId, positionCursor: position.snapshot.positionCursor, payload: { classification: "accepted", receipt, reference: settled.reference } }, now);
    return { receipt, reference: settled.reference };
  }
  await appendAssistedGenerationV1(dir, { type: "navigator_settled", runId: config.runId, callId: config.callId, invocationId, positionCursor: position.snapshot.positionCursor, payload: { classification: "infrastructure_failure", reference: settled.reference } }, now);
  return { receipt: null, reference: settled.reference };
}
async function run(mode, raw, argv, deps) {
  const config = validateAssistedCallConfigV1(raw), piArgv = validateSelectedPiArgvV1(argv, config.execution);
  await runIndex(config.subject.repositoryRoot, config.runId, config.subject.parentIssue);
  const dir = assistedRunDirectory(config.subject.repositoryRoot, config.subject.parentIssue, config.runId), now = deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()), id = deps.uuid ?? uuidv7;
  let rows = await readAssistedLedgerV1(dir);
  if (mode === "enter") {
    if (!rows.length) await appendAssistedGenerationV1(dir, { type: "entered", runId: config.runId, callId: config.callId, positionCursor: 0, payload: { immutableSubject: immutableSubject(config), subject: config.subject } }, now);
    else if (rows[0]?.payload.immutableSubject !== immutableSubject(config)) throw new Error("runId belongs to a different subject");
  } else {
    if (!rows.length) throw new Error("assisted run does not exist");
    if (rows[0]?.payload.immutableSubject !== immutableSubject(config)) throw new Error("resume subject identity mismatch");
  }
  rows = await readAssistedLedgerV1(dir);
  if (rows.some((r) => r.type === "ended")) throw new Error("assisted run has ended");
  if (mode === "resume") {
    const established = rows.find((r) => r.type === "acquisition")?.payload.snapshot;
    if (!established) throw new Error("resolved subject identity missing");
    const latest2 = rows.filter((r) => r.type === "role_settled").at(-1)?.payload.latestAttempt ?? null;
    const observed = await acquireCurrentPositionV1(config, rows.at(-1)?.positionCursor ?? 0, latest2, { git: deps.git, github: deps.github });
    if (resolvedSubject(observed.snapshot) !== resolvedSubject(established)) throw new Error("resolved subject identity mismatch");
  }
  let lost = unresolved(rows);
  if (lost && deps.recorder.readSealed) {
    const started = rows.find((r) => r.invocationId === lost && (r.type === "navigator_started" || r.type === "role_started")), snapshot = rows.filter((r) => r.type === "acquisition").at(-1)?.payload.snapshot, before = snapshot?.workspaces.find((w) => w.id === config.execution.workspaceId)?.target ?? null, sealed = await deps.recorder.readSealed({ config, invocationId: lost, kind: started.type === "navigator_started" ? "navigator" : "role", beforeTarget: before });
    if (sealed) {
      if (started.type === "navigator_started") {
        const nav = sealed;
        if (nav.kind !== "accepted" || !snapshot) throw new Error("sealed Navigator recovery mismatch");
        const receipt = validateNavigatorReceiptV1(nav.receipt, snapshot, nav.evidenceRead);
        await appendAssistedGenerationV1(dir, { type: "navigator_settled", runId: config.runId, callId: started.callId, invocationId: lost, positionCursor: started.positionCursor, payload: { classification: "accepted", receipt, reference: nav.reference } }, now);
      } else {
        const role = sealed, cursor2 = started.positionCursor + 1, latestAttempt = { invocationId: lost, role: config.execution.role, phase: config.execution.phase, beforeTarget: role.beforeTarget, afterTarget: role.afterTarget, terminalClass: role.terminalClass, reference: role.reference };
        await appendAssistedGenerationV1(dir, { type: "role_settled", runId: config.runId, callId: started.callId, invocationId: lost, positionCursor: cursor2, payload: { latestAttempt } }, now);
      }
      rows = await readAssistedLedgerV1(dir);
      lost = unresolved(rows);
    }
  }
  const same = rows.find((r) => r.type === "call_started" && r.callId === config.callId);
  if (same) {
    if (same.payload.configDigest !== configDigest(config)) throw new Error("conflicting callId reuse");
    const done = rows.find((r) => r.type === "call_completed" && r.callId === config.callId);
    if (done) return done.payload.result;
    if (lost) throw new Error(`recovery required for invocation ${lost}`);
    const recoveredRole = rows.filter((r) => (r.type === "role_settled" || r.type === "recovered") && r.callId === config.callId && r.payload.latestAttempt).at(-1);
    if (recoveredRole) {
      const latestAttempt = recoveredRole.payload.latestAttempt, cursor2 = recoveredRole.positionCursor, navRows = rows.filter((r) => r.type === "navigator_settled" && r.callId === config.callId && r.payload.classification === "accepted"), preReceipt = navRows[0]?.payload.receipt ?? null, settledPost = navRows.find((r) => r.sequence > recoveredRole.sequence), position2 = await acquireCurrentPositionV1(config, cursor2, latestAttempt, { git: deps.git, github: deps.github });
      if (!settledPost) await appendAssistedGenerationV1(dir, { type: "acquisition", runId: config.runId, callId: config.callId, positionCursor: cursor2, payload: { snapshot: position2.snapshot, reason: "docket_recovery" } }, now);
      const post2 = settledPost ? { receipt: settledPost.payload.receipt } : await consult(config, position2, piArgv, dir, deps, now, id), comparison2 = rows.filter((r) => r.type === "action_reserved" && r.callId === config.callId).at(-1)?.payload.comparison ?? null;
      return publishResult(dir, { version: 1, runId: config.runId, callId: config.callId, status: post2.receipt ? post2.receipt.status === "ordinary" ? "completed" : "navigation_halted" : "infrastructure_failure", positionCursor: cursor2, selectedInvocationId: recoveredRole.invocationId ?? null, preNavigation: preReceipt, settlement: { terminalClass: latestAttempt.terminalClass, reference: latestAttempt.reference }, postNavigation: post2.receipt, actionComparison: comparison2 }, now);
    }
  }
  if (lost) throw new Error(`recovery required for invocation ${lost}`);
  let cursor = rows.at(-1)?.positionCursor ?? 0;
  const priorAcquisition = rows.filter((r) => r.type === "call_started").at(-1)?.payload.acquisitionDigest;
  if (priorAcquisition && priorAcquisition !== acquisitionDigest(config)) cursor++;
  if (!same) await appendAssistedGenerationV1(dir, { type: "call_started", runId: config.runId, callId: config.callId, positionCursor: cursor, payload: { configDigest: configDigest(config), acquisitionDigest: acquisitionDigest(config), selected: { role: config.execution.role, phase: config.execution.phase }, argvDigest: sha256Hex(canonicalJson(piArgv)), piArgv, environmentReference: environmentReference(config), recoveryConfig: { ...config, execution: { ...config.execution, environment: defaultEnvironment() } } } }, now);
  let latest = null;
  const lastSettlement = rows.filter((r) => (r.type === "role_settled" || r.type === "recovered") && r.payload.latestAttempt).at(-1)?.payload.latestAttempt;
  if (lastSettlement) latest = lastSettlement;
  let position = await acquireCurrentPositionV1(config, cursor, latest, { git: deps.git, github: deps.github });
  await appendAssistedGenerationV1(dir, { type: "acquisition", runId: config.runId, callId: config.callId, positionCursor: cursor, payload: { snapshot: position.snapshot } }, now);
  const reusable = rows.filter((r) => r.type === "navigator_settled" && r.payload.classification === "accepted").at(-1)?.payload.receipt;
  let pre = reusable?.status === "ordinary" && navigatorBindingMatchesV1(position.snapshot, reusable) ? { receipt: reusable, reference: rows.filter((r) => r.type === "navigator_settled" && r.payload.classification === "accepted").at(-1).payload.reference } : await consult(config, position, piArgv, dir, deps, now, id);
  if (!pre.receipt || pre.receipt.status !== "ordinary") {
    const result = { version: 1, runId: config.runId, callId: config.callId, status: pre.receipt ? "navigation_halted" : "infrastructure_failure", positionCursor: cursor, selectedInvocationId: null, preNavigation: pre.receipt, settlement: null, postNavigation: null, actionComparison: null };
    return publishResult(dir, result, now);
  }
  const refreshed = await acquireCurrentPositionV1(config, cursor, latest, { git: deps.git, github: deps.github });
  if (refreshed.snapshot.digest !== position.snapshot.digest) {
    position = refreshed;
    await appendAssistedGenerationV1(dir, { type: "acquisition", runId: config.runId, callId: config.callId, positionCursor: cursor, payload: { snapshot: position.snapshot, reason: "prelaunch_drift" } }, now);
    pre = await consult(config, position, piArgv, dir, deps, now, id);
    if (!pre.receipt || pre.receipt.status !== "ordinary") return publishResult(dir, { version: 1, runId: config.runId, callId: config.callId, status: pre.receipt ? "navigation_halted" : "infrastructure_failure", positionCursor: cursor, selectedInvocationId: null, preNavigation: pre.receipt, settlement: null, postNavigation: null, actionComparison: null }, now);
  }
  const primary = pre.receipt.primary, comparison = primary.kind === "package_role" && primary.role === config.execution.role && primary.phase === config.execution.phase ? "followed" : "deviated", reserved = rows.filter((r) => r.type === "action_reserved" && r.callId === config.callId && !rows.some((x) => (x.type === "role_settled" || x.type === "recovered") && x.invocationId === r.invocationId)).at(-1);
  let selectedId;
  if (reserved) {
    selectedId = reserved.invocationId;
  } else {
    await fenceLaunch(dir, config, "role", cursor);
    selectedId = id();
    await appendAssistedGenerationV1(dir, { type: "action_reserved", runId: config.runId, callId: config.callId, invocationId: selectedId, positionCursor: cursor, payload: { comparison, selected: { role: config.execution.role, phase: config.execution.phase } } }, now);
  }
  await appendAssistedGenerationV1(dir, { type: "role_started", runId: config.runId, callId: config.callId, invocationId: selectedId, positionCursor: cursor, payload: {} }, now);
  const settlement = await deps.recorder.invokeRole({ config, invocationId: selectedId, piArgv, beforeTarget: position.snapshot.workspaces.find((w) => w.id === config.execution.workspaceId).target });
  cursor++;
  latest = { invocationId: selectedId, role: config.execution.role, phase: config.execution.phase, beforeTarget: settlement.beforeTarget, afterTarget: settlement.afterTarget, terminalClass: settlement.terminalClass, reference: settlement.reference };
  await appendAssistedGenerationV1(dir, { type: "role_settled", runId: config.runId, callId: config.callId, invocationId: selectedId, positionCursor: cursor, payload: { latestAttempt: latest } }, now);
  position = await acquireCurrentPositionV1(config, cursor, latest, { git: deps.git, github: deps.github });
  await appendAssistedGenerationV1(dir, { type: "acquisition", runId: config.runId, callId: config.callId, positionCursor: cursor, payload: { snapshot: position.snapshot, reason: "post_settlement" } }, now);
  const post = await consult(config, position, piArgv, dir, deps, now, id);
  const status = post.receipt ? post.receipt.status === "ordinary" ? "completed" : "navigation_halted" : "infrastructure_failure";
  return publishResult(dir, { version: 1, runId: config.runId, callId: config.callId, status, positionCursor: cursor, selectedInvocationId: selectedId, preNavigation: pre.receipt, settlement: { terminalClass: settlement.terminalClass, reference: settlement.reference }, postNavigation: post.receipt, actionComparison: comparison }, now);
}
async function reconciledRun(mode, config, piArgv, deps) {
  try {
    return await run(mode, config, piArgv, deps);
  } catch (error) {
    if (error instanceof CanonicalLifecycleResult) return error.result;
    throw error;
  }
}
const enterAssistedCallV1 = (config, piArgv, deps) => reconciledRun("enter", config, piArgv, deps);
const resumeAssistedCallV1 = (config, piArgv, deps) => reconciledRun("resume", config, piArgv, deps);
async function readAssistedRunV1(repositoryRoot, runId, parentIssue, callId) {
  const parent = parentIssue ?? await runIndex(repositoryRoot, runId);
  const rows = await readAssistedLedgerV1(assistedRunDirectory(repositoryRoot, parent, runId));
  if (!rows.length) throw new Error("assisted run does not exist");
  const acquisition = rows.filter((r) => r.type === "acquisition").at(-1);
  return { version: 1, runId, ended: rows.some((r) => r.type === "ended"), positionCursor: rows.at(-1).positionCursor, unresolvedInvocationId: unresolved(rows), latestCall: callId ? rows.find((r) => r.type === "call_completed" && r.callId === callId)?.payload.result ?? null : latestResult(rows), snapshot: acquisition?.payload.snapshot ?? null };
}
async function endAssistedRunV1(repositoryRoot, runId) {
  const parentIssue = await runIndex(repositoryRoot, runId), dir = assistedRunDirectory(repositoryRoot, parentIssue, runId), rows = await readAssistedLedgerV1(dir);
  if (!rows.length) throw new Error("assisted run does not exist");
  if (unresolved(rows)) throw new Error("unresolved invocation requires recovery");
  if (!rows.some((r) => r.type === "ended")) await appendAssistedGenerationV1(dir, { type: "ended", runId, callId: null, positionCursor: rows.at(-1).positionCursor, payload: { meaning: "assisted_mode_ended_only" } });
  return readAssistedRunV1(repositoryRoot, runId, parentIssue);
}
async function recoverAssistedInvocationInternalV1(repositoryRoot, runId, invocationId, confirmedStopped, deps) {
  if (!confirmedStopped) throw new Error("recovery requires confirmed-stopped attestation");
  const parentIssue = await runIndex(repositoryRoot, runId), dir = assistedRunDirectory(repositoryRoot, parentIssue, runId), rows = await readAssistedLedgerV1(dir);
  if (unresolved(rows) !== invocationId) {
    if (rows.some((r) => r.type === "recovered" && r.invocationId === invocationId)) return readAssistedRunV1(repositoryRoot, runId, parentIssue);
    throw new Error("invocation is not the unresolved head");
  }
  const started = rows.find((r) => r.invocationId === invocationId && (r.type === "role_started" || r.type === "navigator_started")), call = rows.filter((r) => r.type === "call_started" && r.callId === started.callId).at(-1);
  if (!call) throw new Error("recovery call declaration missing");
  const redacted = validateAssistedCallConfigV1(call.payload.recoveryConfig), reference = call.payload.environmentReference;
  if (typeof reference !== "string") throw new Error("recovery environment reference missing");
  const policy = reference === `environment-policy:sha256:${sha256Hex(canonicalJson(defaultEnvironment()))}` ? defaultEnvironment() : await deps.resolveEnvironmentPolicy?.(reference);
  if (!policy) throw new Error("recovery environment reference unavailable");
  const config = validateAssistedCallConfigV1({ ...redacted, execution: { ...redacted.execution, environment: policy } });
  if (environmentReference(config) !== reference) throw new Error("recovery environment reference mismatch");
  const piArgv = validateSelectedPiArgvV1(call.payload.piArgv, config.execution), priorCursor = rows.at(-1)?.positionCursor ?? 0, cursor = started.type === "role_started" ? priorCursor + 1 : priorCursor;
  let latest = rows.filter((r) => (r.type === "role_settled" || r.type === "recovered") && r.payload.latestAttempt).at(-1)?.payload.latestAttempt ?? null;
  if (started.type === "role_started") {
    const snapshot = rows.filter((r) => r.type === "acquisition").at(-1)?.payload.snapshot, workspace = snapshot.workspaces.find((w) => w.id === config.execution.workspaceId);
    const recoveryBytes = `${canonicalJson({ version: 1, invocationId, terminalClass: "outcome_unavailable_after_runner_loss", attestation: "confirmed_stopped" })}
`, recoveryDir = join(dir, "invocation-inputs", invocationId);
    await mkdir(recoveryDir, { recursive: true });
    try {
      await writeFile(join(recoveryDir, "failure.json"), recoveryBytes, { flag: "wx", mode: 384 });
    } catch (error) {
      if (error.code !== "EEXIST" || sha256Hex(await readFile(join(recoveryDir, "failure.json"))) !== sha256Hex(recoveryBytes)) throw error;
    }
    latest = { invocationId, role: config.execution.role, phase: config.execution.phase, beforeTarget: workspace.target, afterTarget: workspace.target, terminalClass: "outcome_unavailable_after_runner_loss", reference: { id: `failure:${invocationId}`, sha256: sha256Hex(recoveryBytes) } };
    await appendAssistedGenerationV1(dir, { type: "recovered", runId, callId: started.callId, invocationId, positionCursor: cursor, payload: { attestation: "confirmed_stopped", terminalClass: "outcome_unavailable_after_runner_loss", latestAttempt: latest } });
  } else await appendAssistedGenerationV1(dir, { type: "recovered", runId, callId: started.callId, invocationId, positionCursor: cursor, payload: { attestation: "confirmed_stopped", terminalClass: "outcome_unavailable_after_runner_loss" } });
  const position = await acquireCurrentPositionV1(config, cursor, latest, { git: deps.git, github: deps.github });
  await appendAssistedGenerationV1(dir, { type: "acquisition", runId, callId: started.callId, positionCursor: cursor, payload: { snapshot: position.snapshot, reason: "recovery" } });
  await consult(config, position, piArgv, dir, deps, deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()), deps.uuid ?? uuidv7);
  return readAssistedRunV1(repositoryRoot, runId, parentIssue);
}
async function recoverAssistedInvocationV1(repositoryRoot, runId, invocationId, confirmedStopped, deps) {
  try {
    return await recoverAssistedInvocationInternalV1(repositoryRoot, runId, invocationId, confirmedStopped, deps);
  } catch (error) {
    if (error instanceof CanonicalLifecycleResult || error instanceof CanonicalLifecycleTransition) return readAssistedRunV1(repositoryRoot, runId);
    throw error;
  }
}
export {
  endAssistedRunV1,
  enterAssistedCallV1,
  readAssistedRunV1,
  recoverAssistedInvocationV1,
  resumeAssistedCallV1
};
