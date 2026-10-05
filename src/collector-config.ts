import { isTicketNumberString, parseTicketNumber } from "./run-ticket-number.ts";

export const COLLECTOR_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const COLLECTOR_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export type CollectorRepository = {
  display: string;
  canonical: string;
  owner: string;
  repo: string;
};

function fail(message: string, cause?: unknown): never {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

function conservativeAscii(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code > 0x7f) return false;
  }
  return true;
}

export function parseCollectorRepository(raw: unknown): CollectorRepository {
  if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) fail("Collector repository must be a string owner/repo");
  if (!conservativeAscii(raw) || raw.includes("://") || /[?#@%\\ ]/.test(raw)) fail("Collector repository rejects URL syntax and non-identity bytes");
  const parts = raw.split("/");
  if (parts.length !== 2) fail("Collector repository must contain exactly one '/' separating owner and repo");
  const [ownerDisplay, repoDisplay] = parts as [string, string];
  if (!COLLECTOR_OWNER_PATTERN.test(ownerDisplay) || !COLLECTOR_REPO_PATTERN.test(repoDisplay)) fail("Collector repository does not match the conservative owner/repo grammar");
  const owner = ownerDisplay.toLowerCase();
  const repo = repoDisplay.toLowerCase();
  return { display: raw, canonical: `${owner}/${repo}`, owner, repo };
}

export function parseCollectorPrNumber(raw: unknown): number {
  if (typeof raw !== "string" && typeof raw !== "number") fail("Collector pull request number is required");
  const value = parseTicketNumber(raw);
  if (value === undefined) fail(typeof raw === "string" && !isTicketNumberString(raw)
    ? "Collector pull request number must be a positive safe integer string"
    : "Collector pull request number must be a positive safe integer");
  return value;
}
