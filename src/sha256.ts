import { createHash } from "node:crypto";

/** Canonical lowercase SHA-256 encoding shared by reviewer identity seams. */
export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
