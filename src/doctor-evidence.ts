import { sha256Hex } from "./sha256.ts";
import { statsLineEvidenceBytes, validateDoctorEvidenceIndex, type DoctorEvidenceIndexV1 } from "./doctor-contracts.ts";

export type DoctorCommittedEvidenceReader = { read(targetCommit: string, path: string): Promise<Uint8Array> };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; }
function canonicalDocketPath(path: unknown): path is string {
  if (typeof path !== "string" || path.includes("\\") || path.includes("//") || path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")) return false;
  return /^\.ak\/dockets\/issues\/[1-9]\d*\/(?:[^/]+\/)*[^/]+$/.test(path);
}

/** Resolve claim-chain entries from immutable target bytes before admitting any evidence to Doctor. */
export async function resolveDoctorEvidenceIndex(value: unknown, reader: DoctorCommittedEvidenceReader): Promise<DoctorEvidenceIndexV1> {
  if (!record(value) || !Array.isArray(value.evidence) || typeof value.targetCommit !== "string") throw new Error("Doctor evidence index is malformed");
  const committed = new Set(["manifest", "receipt", "verdict", "disposition"]); const sources = new Set<string>();
  const evidence = await Promise.all(value.evidence.map(async (item) => {
    if (!record(item) || !committed.has(String(item.kind))) return item;
    if (!record(item.source) || item.source.commit !== value.targetCommit || !canonicalDocketPath(item.source.path)) throw new Error("Committed evidence source is not a canonical target-confined docket path");
    const sourceCommit = item.source.commit as string; const sourcePath = item.source.path; const sourceKey = `${sourceCommit}:${sourcePath}`; if (sources.has(sourceKey)) throw new Error("Duplicate committed evidence source"); sources.add(sourceKey);
    let bytes: Uint8Array; try { bytes = await reader.read(sourceCommit, sourcePath); } catch (error) { throw new Error(`Committed evidence is inaccessible: ${sourcePath}`, { cause: error }); }
    let data: unknown; try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { throw new Error(`Committed evidence is malformed: ${sourcePath}`, { cause: error }); }
    const sha256 = sha256Hex(bytes); const byteLength = bytes.byteLength;
    if (item.sha256 !== sha256 || item.byteLength !== byteLength || canonical(item.data) !== canonical(data)) throw new Error(`Committed evidence target-byte mismatch: ${String(item.id)}`);
    return { id: item.id, kind: item.kind, sha256, byteLength, source: { commit: sourceCommit, path: sourcePath }, data };
  }));
  // The ordinary validator closes metadata/StatsLine contracts and freezes the resolver-derived store.
  return validateDoctorEvidenceIndex({ ...value, evidence });
}

export function evidenceAssertion(data: unknown) { const bytes = statsLineEvidenceBytes(data); return { sha256: sha256Hex(bytes), byteLength: bytes.byteLength }; }
