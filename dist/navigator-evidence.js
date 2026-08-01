import { sha256Hex } from "./sha256.js";
function credit(intervals, start, end) {
  if (start === end) return;
  let i = 0;
  while (i < intervals.length && intervals[i][1] < start) i++;
  while (i < intervals.length && intervals[i][0] <= end) {
    start = Math.min(start, intervals[i][0]);
    end = Math.max(end, intervals[i][1]);
    intervals.splice(i, 1);
  }
  intervals.splice(i, 0, [start, end]);
}
function continuation(byte) {
  return byte !== void 0 && (byte & 192) === 128;
}
function sequenceEnd(bytes, index) {
  const first = bytes[index];
  if (first === void 0) return -1;
  if (first <= 127) return index + 1;
  if (first >= 194 && first <= 223) return continuation(bytes[index + 1]) ? index + 2 : -1;
  if (first >= 224 && first <= 239) {
    const second = bytes[index + 1], validSecond = first === 224 ? second !== void 0 && second >= 160 && second <= 191 : first === 237 ? second !== void 0 && second >= 128 && second <= 159 : continuation(second);
    return validSecond && continuation(bytes[index + 2]) ? index + 3 : -1;
  }
  if (first >= 240 && first <= 244) {
    const second = bytes[index + 1], validSecond = first === 240 ? second !== void 0 && second >= 144 && second <= 191 : first === 244 ? second !== void 0 && second >= 128 && second <= 143 : continuation(second);
    return validSecond && continuation(bytes[index + 2]) && continuation(bytes[index + 3]) ? index + 4 : -1;
  }
  return -1;
}
function utf8End(bytes, start, target) {
  let index = start;
  while (index < target) {
    const end = sequenceEnd(bytes, index);
    if (end < 0) return index > start ? index : target;
    if (end > target) return index > start ? index : end;
    index = end;
  }
  return target;
}
class NavigatorEvidenceStore {
  constructor(evidence, handles, maxPageBytes = 16384) {
    this.maxPageBytes = maxPageBytes;
    for (const item of evidence) {
      if (this.#byId.has(item.id)) throw new Error("duplicate evidence id");
      const source = handles.get(item.handle);
      if (!source) throw new Error(`missing evidence handle: ${item.id}`);
      const bytes = new Uint8Array(source);
      if (sha256Hex(bytes) !== item.sha256) throw new Error(`evidence digest mismatch: ${item.id}`);
      this.#byId.set(item.id, { bytes, read: [], touched: false });
    }
  }
  maxPageBytes;
  #byId = /* @__PURE__ */ new Map();
  read(evidenceId, offset = 0, limit = this.maxPageBytes) {
    const item = this.#byId.get(evidenceId);
    if (!item) throw new Error("evidence id is not admitted");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid evidence page");
    if (offset > item.bytes.length) throw new Error("offset beyond evidence");
    const target = Math.min(offset, item.bytes.length) + Math.min(limit, this.maxPageBytes, item.bytes.length - offset), end = utf8End(item.bytes, offset, target), slice = item.bytes.subarray(offset, end);
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch {
      throw new Error("evidence page is not valid UTF-8");
    }
    ;
    item.touched = true;
    credit(item.read, offset, end);
    return { evidenceId, offset, byteLength: end - offset, totalByteLength: item.bytes.length, content, truncated: end < item.bytes.length };
  }
  readRecord() {
    return [...this.#byId].flatMap(([evidenceId, v]) => v.touched ? [{ evidenceId, fullyRead: v.bytes.length === 0 || v.read.length === 1 && v.read[0][0] === 0 && v.read[0][1] === v.bytes.length }] : []);
  }
}
const navigatorEvidenceReadSchema = { type: "object", additionalProperties: false, required: ["evidenceId"], properties: { evidenceId: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16384 } } };
export {
  NavigatorEvidenceStore,
  navigatorEvidenceReadSchema
};
