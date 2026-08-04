import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const COLLECTOR_HOST = "github.com" as const;
export const COLLECTOR_MANIFEST_VERSION = 1 as const;
export const COLLECTOR_LEG_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const COLLECTOR_OWNER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const COLLECTOR_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export type CollectorRepository = {
  display: string;
  canonical: string;
  owner: string;
  repo: string;
};

export type CollectorLegConfig = {
  id: string;
  expectedAuthors: readonly string[];
  requestBody?: string;
};

export type CollectorManifest = {
  version: 1;
  legs: readonly CollectorLegConfig[];
  canonicalJson: string;
  digest: string;
  sourcePath: string;
};

function fail(message: string, cause?: unknown): never {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

function isAsciiControlOrNonAscii(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code > 0x7f) return true;
  }
  return false;
}

export function parseCollectorRepository(raw: unknown): CollectorRepository {
  if (typeof raw !== "string") {
    fail("Collector repository must be a string owner/repo");
  }
  const display = raw.trim();
  if (display !== raw) {
    fail("Collector repository must not include surrounding whitespace");
  }
  if (display.length === 0) {
    fail("Collector repository is required");
  }
  if (isAsciiControlOrNonAscii(display)) {
    fail("Collector repository must be conservative ASCII without control bytes");
  }
  if (
    display.includes("://") ||
    display.includes("?") ||
    display.includes("#") ||
    display.includes("@") ||
    display.includes("%") ||
    display.includes("\\") ||
    display.includes(" ")
  ) {
    fail("Collector repository rejects URL syntax, credentials, query, fragment, and percent encoding");
  }
  const parts = display.split("/");
  if (parts.length !== 2) {
    fail("Collector repository must contain exactly one '/' separating owner and repo");
  }
  const [ownerDisplay, repoDisplay] = parts;
  if (ownerDisplay === undefined || repoDisplay === undefined) {
    fail("Collector repository must contain exactly one '/' separating owner and repo");
  }
  if (
    ownerDisplay.length === 0 || repoDisplay.length === 0 ||
    ownerDisplay === "." || ownerDisplay === ".." ||
    repoDisplay === "." || repoDisplay === ".."
  ) {
    fail("Collector repository rejects empty, '.', or '..' segments");
  }
  if (!COLLECTOR_OWNER_PATTERN.test(ownerDisplay)) {
    fail("Collector repository owner must match the v1 conservative grammar (1-39 alphanumeric/hyphen)");
  }
  if (!COLLECTOR_REPO_PATTERN.test(repoDisplay)) {
    fail("Collector repository name must match the v1 conservative grammar (1-100 alphanumeric/._-)");
  }
  const owner = ownerDisplay.toLowerCase();
  const repo = repoDisplay.toLowerCase();
  return {
    display,
    canonical: `${owner}/${repo}`,
    owner,
    repo,
  };
}

export function parseCollectorPrNumber(raw: unknown): number {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("Collector pull request number is required");
  }
  const text = String(raw).trim();
  if (text !== String(raw).trim() || text !== String(raw)) {
    // allow only exact digit strings when provided as string
  }
  if (typeof raw === "string") {
    if (!/^[1-9][0-9]*$/.test(raw)) {
      fail("Collector pull request number must be a positive safe integer string");
    }
  } else if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 1) {
      fail("Collector pull request number must be a positive safe integer");
    }
    return raw;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("Collector pull request number must be a positive safe integer");
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function canonicalizeAuthor(raw: unknown, legId: string): string {
  if (typeof raw !== "string") {
    fail(`Collector leg \"${legId}\" expectedAuthors entries must be strings`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    fail(`Collector leg \"${legId}\" expectedAuthors entries must be non-blank`);
  }
  if (trimmed !== raw.trim()) {
    // already trimmed
  }
  // GitHub login comparison is ASCII-lowercase; reject empty after trim already done
  return trimmed.toLowerCase();
}

function canonicalizeLeg(raw: unknown, index: number): CollectorLegConfig {
  if (!isPlainObject(raw)) {
    fail(`Collector manifest legs[${index}] must be an object`);
  }
  const hasRequest = Object.hasOwn(raw, "request");
  if (!hasRequiredKeys(raw, ["id", "expectedAuthors"])) {
    fail(`Collector manifest legs[${index}] is missing required keys`);
  }
  const id = raw["id"];
  if (typeof id !== "string" || !COLLECTOR_LEG_ID_PATTERN.test(id)) {
    fail(`Collector leg id at legs[${index}] must match ^[a-z][a-z0-9._-]{0,63}$`);
  }
  const authorsRaw = raw["expectedAuthors"];
  if (!Array.isArray(authorsRaw) || authorsRaw.length < 1) {
    fail(`Collector leg \"${id}\" expectedAuthors must be a non-empty array`);
  }
  const expectedAuthors: string[] = [];
  const seenAuthors = new Set<string>();
  for (const entry of authorsRaw) {
    const author = canonicalizeAuthor(entry, id);
    if (seenAuthors.has(author)) {
      fail(`Collector leg \"${id}\" has duplicate expected author \"${author}\"`);
    }
    seenAuthors.add(author);
    expectedAuthors.push(author);
  }

  let requestBody: string | undefined;
  if (hasRequest) {
    const request = raw["request"];
    if (!isPlainObject(request) || !hasRequiredKeys(request, ["body"])) {
      fail(`Collector leg \"${id}\" request must be an object with body`);
    }
    const body = request["body"];
    if (typeof body !== "string") {
      fail(`Collector leg \"${id}\" request body must be a string`);
    }
    if (body.trim().length === 0) {
      fail(`Collector leg \"${id}\" request body must be trim-non-empty`);
    }
    // Preserve body byte-for-byte except runtime marker append later.
    requestBody = body;
  }

  return requestBody === undefined
    ? { id, expectedAuthors }
    : { id, expectedAuthors, requestBody };
}

function stableCanonicalJson(manifest: {
  version: 1;
  legs: readonly CollectorLegConfig[];
}): string {
  const legs = manifest.legs.map((leg) => {
    const base: Record<string, unknown> = {
      id: leg.id,
      expectedAuthors: [...leg.expectedAuthors],
    };
    if (leg.requestBody !== undefined) {
      base["request"] = { body: leg.requestBody };
    }
    return base;
  });
  return `${JSON.stringify({ version: 1, legs })}\n`;
}

export async function loadCollectorManifest(path: string): Promise<CollectorManifest> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Collector leg manifest is unreadable at ${path}: ${detail}`, error);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Collector leg manifest must be UTF-8 JSON");
  }

  // Strip a single optional UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Collector leg manifest is not valid JSON: ${detail}`, error);
  }

  if (!isPlainObject(parsed) || !hasRequiredKeys(parsed, ["version", "legs"])) {
    fail("Collector manifest must be an object with version and legs");
  }
  if (parsed["version"] !== COLLECTOR_MANIFEST_VERSION) {
    fail("Collector manifest version must be the exact integer 1");
  }
  const legsRaw = parsed["legs"];
  if (!Array.isArray(legsRaw) || legsRaw.length < 1) {
    fail("Collector manifest legs must be a non-empty array");
  }

  const legs: CollectorLegConfig[] = [];
  const seenIds = new Set<string>();
  const authorOwners = new Map<string, string>();
  for (let index = 0; index < legsRaw.length; index += 1) {
    const leg = canonicalizeLeg(legsRaw[index], index);
    if (seenIds.has(leg.id)) {
      fail(`Collector manifest has duplicate leg id \"${leg.id}\"`);
    }
    seenIds.add(leg.id);
    for (const author of leg.expectedAuthors) {
      const owner = authorOwners.get(author);
      if (owner !== undefined) {
        fail(
          `Collector expected author \"${author}\" overlaps across legs \"${owner}\" and \"${leg.id}\"`,
        );
      }
      authorOwners.set(author, leg.id);
    }
    legs.push(leg);
  }

  const canonicalJson = stableCanonicalJson({ version: 1, legs });
  const digest = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return {
    version: 1,
    legs,
    canonicalJson,
    digest,
    sourcePath: path,
  };
}
