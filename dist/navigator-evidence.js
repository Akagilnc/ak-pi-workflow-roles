import { sha256Hex } from "./sha256.js";
class NavigatorEvidenceStore {
  constructor(evidence, handles, maxPageBytes = 16384) {
    this.maxPageBytes = maxPageBytes;
    for (const item of evidence) {
      const bytes = handles.get(item.handle);
      if (!bytes) throw new Error(`missing evidence handle: ${item.id}`);
      if (sha256Hex(bytes) !== item.sha256) throw new Error(`evidence digest mismatch: ${item.id}`);
      this.#byId.set(item.id, { bytes, read: /* @__PURE__ */ new Set() });
    }
  }
  maxPageBytes;
  #byId = /* @__PURE__ */ new Map();
  read(evidenceId, offset = 0, limit = this.maxPageBytes) {
    const item = this.#byId.get(evidenceId);
    if (!item) throw new Error("evidence id is not admitted");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid evidence page");
    const length = Math.min(limit, this.maxPageBytes, item.bytes.length - offset);
    if (length < 0) throw new Error("offset beyond evidence");
    for (let i = offset; i < offset + length; i++) item.read.add(i);
    return { evidenceId, offset, byteLength: length, totalByteLength: item.bytes.length, content: new TextDecoder("utf-8", { fatal: true }).decode(item.bytes.slice(offset, offset + length)), truncated: offset + length < item.bytes.length };
  }
  readRecord() {
    return [...this.#byId].map(([evidenceId, v]) => ({ evidenceId, fullyRead: v.read.size === v.bytes.length })).filter((x) => x.fullyRead || this.#byId.get(x.evidenceId).read.size > 0);
  }
}
const navigatorEvidenceReadSchema = { type: "object", additionalProperties: false, required: ["evidenceId"], properties: { evidenceId: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16384 } } };
export {
  NavigatorEvidenceStore,
  navigatorEvidenceReadSchema
};
