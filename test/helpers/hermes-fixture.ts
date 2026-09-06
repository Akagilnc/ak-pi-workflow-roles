/**
 * Shared Hermes / gh PATH executable fixtures (#582 / ADR 0075).
 * Real subprocess fixtures for the shared seat ticket resolver and the GitHub
 * issue face — NOT production APIs. Install-time options only; no env/control
 * dual channels.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type HermesFixtureOptions = {
  /** Resolver stdout. Default: `{"assertion":"true-unbound"}`. */
  resolverResponse?: unknown;
  /** Force non-zero exit. */
  defaultExitCode?: number;
};

function embedJson(value: unknown): string {
  return JSON.stringify(
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

export async function installHermesFixture(
  binDir: string,
  options: HermesFixtureOptions = {},
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const hermesPath = join(binDir, "hermes");
  const resolverDefault =
    options.resolverResponse === undefined
      ? { assertion: "true-unbound" }
      : options.resolverResponse;
  const exitCode =
    options.defaultExitCode === undefined
      ? undefined
      : Number(options.defaultExitCode);

  // Explicit CommonJS (.cjs): package root is "type":"module"; bare `hermes`
  // without extension inherits ESM and rejects require(). Fixture must reach
  // the staged-query face, not die on module boundary.
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const qIdx = args.indexOf("--query-file");
const queryFile = qIdx >= 0 ? args[qIdx + 1] : undefined;

// Production always stages --query-file; missing/bad JSON throws → non-zero (no wash).
if (typeof queryFile === "string" && queryFile.length > 0) {
  JSON.parse(fs.readFileSync(queryFile, "utf8"));
}

${exitCode !== undefined ? `process.exit(${exitCode});` : ""}

process.stdout.write(${embedJson(resolverDefault)});
process.exit(0);
`;
  // Write as hermes.cjs then symlink `hermes` so PATH resolution stays bare-name
  // while Node reads the file as CommonJS regardless of package "type".
  const hermesCjsPath = join(binDir, "hermes.cjs");
  await writeFile(hermesCjsPath, script, "utf8");
  await chmod(hermesCjsPath, 0o755);
  // Wrapper keeps the production-facing bare name on PATH.
  const wrapper = `#!/usr/bin/env bash\nexec "$(dirname "$0")/hermes.cjs" "$@"\n`;
  await writeFile(hermesPath, wrapper, "utf8");
  await chmod(hermesPath, 0o755);
  return binDir;
}

export type GhFixtureOptions = {
  issues?: Record<
    number,
    {
      body?: string;
      htmlUrl?: string;
      html_url?: string;
      comments?: Array<{
        id: number;
        body: string;
        createdAt?: string;
        created_at?: string;
        updatedAt?: string;
        updated_at?: string;
        htmlUrl?: string;
        html_url?: string;
      }>;
    }
  >;
};

export async function installGhFixture(
  binDir: string,
  options: GhFixtureOptions = {},
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const ghPath = join(binDir, "gh");
  // Same ESM package-boundary fix as hermes: bare name on PATH, .cjs body.
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const path =
  args.find(
    (a) =>
      a.startsWith("repos/") ||
      a.startsWith("/repos/") ||
      a.startsWith("user") ||
      a.startsWith("/user"),
  ) ||
  args.at(-1) ||
  "";

function ok(body) {
  process.stdout.write(
    "HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n" +
      JSON.stringify(body),
  );
  process.exit(0);
}
function reply(status, statusText, body) {
  process.stdout.write(
    "HTTP/1.1 " +
      status +
      " " +
      statusText +
      "\\r\\ncontent-type: application/json\\r\\n\\r\\n" +
      JSON.stringify(body),
  );
  process.exit(0);
}

if (path.includes("user")) {
  ok({ login: "fixture-user" });
}

const issues = ${JSON.stringify(options.issues ?? {})};
const issueMatch = path.match(new RegExp("issues/(\\\\d+)(/comments)?"));
if (issueMatch) {
  const num = Number(issueMatch[1]);
  const isComments = Boolean(issueMatch[2]);
  const issue = issues[num] || issues[String(num)];
  if (!issue) {
    reply(404, "Not Found", { message: "Not Found" });
  }
  if (isComments) {
    const rawComments = issue.comments || [];
    const normalized = rawComments.map((c, i) => ({
      id: c.id ?? i + 1,
      body: c.body ?? "",
      user: { login: "test-user", type: "User", id: 1 },
      created_at:
        c.created_at || c.createdAt || "2026-08-31T12:00:00.000Z",
      updated_at:
        c.updated_at ||
        c.updatedAt ||
        c.created_at ||
        c.createdAt ||
        "2026-08-31T12:00:00.000Z",
      html_url:
        c.html_url ||
        c.htmlUrl ||
        "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/" +
          num +
          "#issuecomment-" +
          (c.id ?? i + 1),
    }));
    ok(normalized);
  } else {
    ok({
      number: num,
      body: issue.body !== undefined ? issue.body : "issue body",
      html_url:
        issue.html_url ||
        issue.htmlUrl ||
        "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/" + num,
      user: { login: "issue-author", type: "User", id: 2 },
      state: "open",
      created_at: "2026-08-31T00:00:00.000Z",
      updated_at: "2026-08-31T00:00:00.000Z",
    });
  }
}

reply(404, "Not Found", { message: "Not Found" });
`;
  const ghCjsPath = join(binDir, "gh.cjs");
  await writeFile(ghCjsPath, script, "utf8");
  await chmod(ghCjsPath, 0o755);
  const wrapper = `#!/usr/bin/env bash\nexec "$(dirname "$0")/gh.cjs" "$@"\n`;
  await writeFile(ghPath, wrapper, "utf8");
  await chmod(ghPath, 0o755);
  return binDir;
}
