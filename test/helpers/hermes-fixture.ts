/**
 * Shared Hermes / gh PATH executable fixtures (#582 / ADR 0075).
 * Real subprocess fixtures for countersign pre-court + diarist — NOT production APIs.
 *
 * Config/input errors fail loud (non-zero + stderr). Silent fallback is forbidden.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type HermesFixtureOptions = {
  /**
   * Resolver stdout when staged body has no `candidates` array.
   * Default: `{"assertion":"true-unbound"}`.
   */
  resolverResponse?: unknown;
  /**
   * Collector stdout when staged body includes `candidates`.
   * Default: `{"selections":[]}`.
   * Ignored when `selectAllCandidates` is true.
   */
  collectorResponse?: unknown;
  /**
   * Collector face: emit one selection per staged candidate using the full
   * transcript as the sole quote (passes mechanical verbatim check).
   * Enables durable volume assertions on typed sourceKind/sourceRef.
   */
  selectAllCandidates?: boolean;
  /** Force non-zero exit (both faces). */
  defaultExitCode?: number;
  /** Optional capture of the staged --query-file body path contents. */
  captureFile?: string;
  /**
   * Optional control JSON file path. Shape:
   * `{ exitCode?, stderr?, resolverResponse?, collectorResponse?, response? }`
   * `response` forces the same stdout for either face.
   * Missing file → defaults. Present but unreadable/unparseable → non-zero fail.
   */
  controlFile?: string;
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
  const collectorDefault =
    options.collectorResponse === undefined
      ? { selections: [] }
      : options.collectorResponse;
  const selectAll = options.selectAllCandidates === true;

  const script = `#!/usr/bin/env node
const fs = require("node:fs");

function fail(message, err) {
  const detail = err && err.message ? (": " + err.message) : "";
  process.stderr.write("hermes-fixture: " + message + detail + "\\n");
  process.exit(2);
}

const args = process.argv.slice(2);
const qIdx = args.indexOf("--query-file");
const queryFile = qIdx >= 0 ? args[qIdx + 1] : undefined;

let staged = null;
if (qIdx >= 0) {
  if (typeof queryFile !== "string" || queryFile.length === 0) {
    fail("--query-file flag present without path");
  }
  if (!fs.existsSync(queryFile)) {
    fail("staged query-file missing: " + queryFile);
  }
  let raw;
  try {
    raw = fs.readFileSync(queryFile, "utf8");
  } catch (err) {
    fail("staged query-file unreadable: " + queryFile, err);
  }
  try {
    staged = JSON.parse(raw);
  } catch (err) {
    fail("staged query-file is not JSON: " + queryFile, err);
  }
  const cap = process.env.AK_TEST_HERMES_CAPTURE_FILE || ${JSON.stringify(options.captureFile ?? null)};
  if (cap) {
    try {
      fs.writeFileSync(cap, raw, "utf8");
    } catch (err) {
      fail("capture file unwritable: " + cap, err);
    }
  }
}

const isCollector = staged !== null && Array.isArray(staged.candidates);

if (process.env.AK_TEST_HERMES_EXIT_CODE) {
  process.exit(Number(process.env.AK_TEST_HERMES_EXIT_CODE));
}

if (process.env.AK_TEST_HERMES_RESPONSE) {
  process.stdout.write(process.env.AK_TEST_HERMES_RESPONSE);
  process.exit(0);
}

const controlFile = process.env.AK_TEST_HERMES_CONTROL_FILE || ${JSON.stringify(options.controlFile ?? null)};
if (controlFile) {
  if (fs.existsSync(controlFile)) {
    let ctrl;
    try {
      ctrl = JSON.parse(fs.readFileSync(controlFile, "utf8"));
    } catch (err) {
      fail("control file is not JSON: " + controlFile, err);
    }
    if (ctrl.exitCode !== undefined) {
      if (ctrl.stderr) process.stderr.write(String(ctrl.stderr));
      process.exit(Number(ctrl.exitCode));
    }
    if (ctrl.response !== undefined) {
      process.stdout.write(typeof ctrl.response === "string" ? ctrl.response : JSON.stringify(ctrl.response));
      process.exit(0);
    }
    if (isCollector && ctrl.collectorResponse !== undefined) {
      process.stdout.write(typeof ctrl.collectorResponse === "string" ? ctrl.collectorResponse : JSON.stringify(ctrl.collectorResponse));
      process.exit(0);
    }
    if (!isCollector && ctrl.resolverResponse !== undefined) {
      process.stdout.write(typeof ctrl.resolverResponse === "string" ? ctrl.resolverResponse : JSON.stringify(ctrl.resolverResponse));
      process.exit(0);
    }
  }
}

${options.defaultExitCode !== undefined ? `process.exit(${Number(options.defaultExitCode)});` : ""}

if (isCollector) {
  ${
    selectAll
      ? `const selections = staged.candidates.map((c, i) => {
    const transcript = typeof c.transcript === "string" ? c.transcript : "";
    return {
      candidateIndex: typeof c.candidateIndex === "number" ? c.candidateIndex : i,
      quotes: transcript.length > 0 ? [transcript] : [],
    };
  });
  process.stdout.write(JSON.stringify({ selections }));
  process.exit(0);`
      : `process.stdout.write(${embedJson(collectorDefault)});
  process.exit(0);`
  }
}

process.stdout.write(${embedJson(resolverDefault)});
process.exit(0);
`;
  await writeFile(hermesPath, script, "utf8");
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
  controlFile?: string;
};

export async function installGhFixture(
  binDir: string,
  options: GhFixtureOptions = {},
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const ghPath = join(binDir, "gh");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

function fail(message, err) {
  const detail = err && err.message ? (": " + err.message) : "";
  process.stderr.write("gh-fixture: " + message + detail + "\\n");
  process.exit(2);
}

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
const controlFile =
  process.env.AK_TEST_GH_CONTROL_FILE ||
  ${JSON.stringify(options.controlFile ?? null)};
let activeIssues = issues;
if (controlFile && fs.existsSync(controlFile)) {
  try {
    activeIssues = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  } catch (err) {
    fail("control file is not JSON: " + controlFile, err);
  }
}

const issueMatch = path.match(new RegExp("issues/(\\\\d+)(/comments)?"));
if (issueMatch) {
  const num = Number(issueMatch[1]);
  const isComments = Boolean(issueMatch[2]);
  const issue = activeIssues[num];
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
  await writeFile(ghPath, script, "utf8");
  await chmod(ghPath, 0o755);
  return binDir;
}

export function withPrependedPath<T>(
  binDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = process.env.PATH;
  process.env.PATH = prior ? `${binDir}:${prior}` : binDir;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
    });
}
