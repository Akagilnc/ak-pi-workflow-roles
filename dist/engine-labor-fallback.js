let activationLatch;
function buildEngineLaborFallbackField(input) {
  return Object.freeze({
    engineLaborFallback: Object.freeze({
      engine: input.engine,
      failure: input.failure,
      laborBy: "seat"
    })
  });
}
const SEAT_FALLBACK_STATUS_SUFFIX = "-by-fallback";
function isSeatFallbackTaintedStatus(status) {
  return status.endsWith(SEAT_FALLBACK_STATUS_SUFFIX);
}
function seatFallbackBaseStatus(status) {
  return isSeatFallbackTaintedStatus(status) ? status.slice(0, -SEAT_FALLBACK_STATUS_SUFFIX.length) : status;
}
function seatFallbackStatusHasLawfulEvidence(status, source) {
  if (!isSeatFallbackTaintedStatus(status)) return true;
  return readEngineLaborFallbackFieldFrom(source) !== void 0;
}
function taintStatusForSeatFallback(status) {
  if (status.length === 0 || isSeatFallbackTaintedStatus(status)) return status;
  return `${status}${SEAT_FALLBACK_STATUS_SUFFIX}`;
}
const STATUS_DISCRIMINATOR_KEYS = ["judgeStatus", "status"];
function taintReceiptStatusDiscriminators(receipt) {
  let next;
  for (const key of STATUS_DISCRIMINATOR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(receipt, key)) continue;
    let value;
    try {
      value = receipt[key];
    } catch {
      continue;
    }
    if (typeof value !== "string" || value.length === 0) continue;
    const tainted = taintStatusForSeatFallback(value);
    if (tainted === value) continue;
    if (next === void 0) {
      next = { ...receipt };
    }
    next[key] = tainted;
  }
  return next === void 0 ? receipt : next;
}
function createEngineLaborFallbackLatch() {
  return { field: void 0 };
}
function recordEngineLaborFallback(latch, input) {
  const field = buildEngineLaborFallbackField(input);
  if (latch.field === void 0) latch.field = field;
  return latch.field;
}
function readEngineLaborFallbackField(latch) {
  return latch?.field;
}
function withEngineLaborFallbackField(receipt, field) {
  if (field !== void 0) {
    const taintedReceipt = taintReceiptStatusDiscriminators(receipt);
    return { ...taintedReceipt, ...field };
  }
  if (!Object.prototype.hasOwnProperty.call(receipt, "engineLaborFallback")) {
    return receipt;
  }
  const { engineLaborFallback: _forged, ...rest } = receipt;
  return rest;
}
function installActivationEngineLaborFallbackLatch(latch) {
  activationLatch = latch;
}
function clearActivationEngineLaborFallbackLatch() {
  activationLatch = void 0;
}
function activationEngineLaborFallbackLatch() {
  return activationLatch;
}
function readActivationEngineLaborFallbackField() {
  return readEngineLaborFallbackField(activationLatch);
}
function readEngineLaborFallbackFieldFrom(source) {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return void 0;
  }
  let raw;
  try {
    raw = source.engineLaborFallback;
  } catch {
    return void 0;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
  const rec = raw;
  if (typeof rec.engine !== "string" || typeof rec.failure !== "string" || rec.laborBy !== "seat") {
    return void 0;
  }
  return buildEngineLaborFallbackField({
    engine: rec.engine,
    failure: rec.failure
  });
}
function restoreEngineLaborFallbackFromSessionEntries(latch, entries, toolName) {
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry;
    if (row.type !== "message") continue;
    const message = row.message;
    if (typeof message !== "object" || message === null) continue;
    const msg = message;
    if (msg.role !== "toolResult") continue;
    if (msg.toolName !== toolName) continue;
    const field = readEngineLaborFallbackFieldFrom(msg.details);
    if (field === void 0) continue;
    recordEngineLaborFallback(latch, {
      engine: field.engineLaborFallback.engine,
      failure: field.engineLaborFallback.failure
    });
  }
}
export {
  SEAT_FALLBACK_STATUS_SUFFIX,
  activationEngineLaborFallbackLatch,
  buildEngineLaborFallbackField,
  clearActivationEngineLaborFallbackLatch,
  createEngineLaborFallbackLatch,
  installActivationEngineLaborFallbackLatch,
  isSeatFallbackTaintedStatus,
  readActivationEngineLaborFallbackField,
  readEngineLaborFallbackField,
  readEngineLaborFallbackFieldFrom,
  recordEngineLaborFallback,
  restoreEngineLaborFallbackFromSessionEntries,
  seatFallbackBaseStatus,
  seatFallbackStatusHasLawfulEvidence,
  taintStatusForSeatFallback,
  withEngineLaborFallbackField
};
