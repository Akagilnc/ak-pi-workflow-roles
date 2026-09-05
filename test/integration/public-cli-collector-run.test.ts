import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import { INTERNAL_ROLE_ENTRYPOINT_RELATIVE } from "../../src/public-cli/registry.ts";
import { packageRoot, piCli, runPiSubprocess, withHermeticHome } from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";

function seedProject(project: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: project });
  execFileSync("git", ["config", "user.email", "collector@test.local"], { cwd: project });
  execFileSync("git", ["config", "user.name", "Collector"], { cwd: project });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: project });
}

test("public Collector request manifest executes request, re-observes it, and publishes the receipt", { timeout: 120_000 }, async () => {
  await withHermeticHome({ prefix: "ak-public-collector-request-" }, async ({ home }) => {
    const project = resolve(home, "work");
    const agentDir = resolve(home, ".pi", "agent");
    const binDir = resolve(home, "bin");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    seedProject(project);
    const manifest = resolve(home, "requests.json");
    await writeFile(manifest, JSON.stringify({ requests: [{ id: "codex", body: "Please review." }] }));

    const state = resolve(home, "created-comment.json");
    const gh = resolve(binDir, "gh");
    await writeFile(gh, `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2); const path=args.filter(a=>a.startsWith('/')).at(-1)||''; const method=args[args.indexOf('-X')+1];
function ok(body){process.stdout.write('HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(body));}
const comment=()=>({id:91,user:{login:'collector-fixture',type:'User',id:42},body:fs.existsSync(${JSON.stringify(state)})?JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')).body:'',created_at:'2026-01-01T00:01:00Z',updated_at:'2026-01-01T00:01:00Z',html_url:'https://github.com/acme/widgets/issues/3#issuecomment-91'});
if(path.endsWith('/user')) ok({login:'collector-fixture'});
else if(path.includes('/pulls/3')&&!path.includes('/reviews')&&!path.includes('/comments')) ok({number:3,state:'open',head:{sha:'deadbeef'},updated_at:'2026-01-01T00:00:00Z',html_url:'https://github.com/acme/widgets/pull/3'});
else if(method==='POST'&&path.includes('/issues/3/comments')){let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(state)},input);ok(comment());});}
else if(path.includes('/issues/3/comments')) ok(fs.existsSync(${JSON.stringify(state)})?[comment()]:[]);
else if(path.includes('/reviews')||path.includes('/reactions')||path.includes('/pulls/3/comments')) ok([]); else process.exit(2);
`, "utf8");
    await chmod(gh, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      const result = await runAkRole([
        "collector", "--model", "ak-collector-offline/faux-1", "--thinking", "off",
        "--project", project, "--repo", "acme/widgets", "--pr", "3",
        "--request-manifest", manifest, "Request and observe the review.",
      ], {
        packageRoot, home, agentDir, cwd: project,
        createRunId: () => "public-collector-request",
        credentials: { "openai-codex": true, xai: false },
        collectorExtraPiArgs: ["-e", resolve(packageRoot, "test/fixtures/collector-observe-provider.ts")],
        collectorTimeoutMs: 90_000,
        io: { stdout() {}, stderr() {} },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      const reportPath = result.terminal?.artifacts.find((artifact) => artifact.kind === "report")?.path;
      assert.ok(reportPath, "public Terminal must expose the report artifact");
      const report = JSON.parse(await readFile(reportPath, "utf8")) as { receipt: any };
      assert.equal(report.receipt.requestAttempts.length, 1);
      assert.equal(report.receipt.requestAttempts[0].requestId, "codex");
      assert.equal(report.receipt.requestAttempts[0].status, "succeeded");
      assert.ok(report.receipt.snapshots.length >= 2);
      assert.ok(report.receipt.evidenceRecords.some((record: any) => record.kind === "issue_comment" && record.githubId === 91));
      // #438: --repo owner/repo is identity, not a Navigator file path — Terminal must not project source=context path ENOENT.
      const navigator = result.terminal?.navigator;
      assert.ok(navigator, "public Terminal must expose Navigator fact");
      if (navigator.disposition === "unavailable") {
        assert.notEqual(navigator.source, "context");
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });
});

test("public Collector preserves a real HTTP 404 as typed activation failure and Error Artifact", { timeout: 120_000 }, async () => {
  await withHermeticHome({ prefix: "ak-public-collector-404-" }, async ({ home }) => {
    const project = resolve(home, "work");
    const agentDir = resolve(home, ".pi", "agent");
    const binDir = resolve(home, "bin");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    seedProject(project);

    const gh = resolve(binDir, "gh");
    await writeFile(gh, `#!/usr/bin/env node
const args = process.argv.slice(2); const path = args.filter(a => a.startsWith('/')).at(-1) || '';
function reply(status, body) { process.stdout.write('HTTP/1.1 '+status+'\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(body)); }
if (path.endsWith('/user')) reply(200, {login:'fixture'}); else if (path.includes('/pulls/404')) reply(404, {message:'Not Found'}); else process.exit(2);
`, "utf8");
    await chmod(gh, 0o755);

    const stderr: string[] = [];
    const result = await runAkRole([
      "collector", "--model", "ak-collector-offline/faux-1", "--thinking", "off",
      "--project", project, "--pr", "404", "Observe the pull request.",
    ], {
      packageRoot, home, agentDir, cwd: project,
      createRunId: () => "public-collector-http-404",
      credentials: { "openai-codex": true, xai: false },
      collectorExtraPiArgs: ["-e", resolve(packageRoot, "test/fixtures/collector-observe-provider.ts")],
      collectorTimeoutMs: 90_000,
      io: { stdout() {}, stderr: (text) => stderr.push(text) },
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
        assert.ok(args.some((arg) => arg.endsWith(INTERNAL_ROLE_ENTRYPOINT_RELATIVE)));
        const subprocess = await runPiSubprocess([...args], {
          cwd: options.cwd,
          env: { ...options.env, PATH: `${binDir}:${dirname(piCli)}:${options.env.PATH ?? ""}`, PI_OFFLINE: "1" },
          timeoutMs: options.timeoutMs ?? 90_000,
        });
        return { code: subprocess.code, stdout: subprocess.stdout, stderr: subprocess.stderr, timedOut: subprocess.localTimeout, args: [...args] };
      },
            extraPiArgs: ["-e", resolve(packageRoot, "test/fixtures/collector-observe-provider.ts")],
          }),
    });

    assert.equal(result.exitCode, 1, stderr.join(""));
    assert.equal(result.terminal?.roleOutcome.kind, "failure");
    if (result.terminal?.roleOutcome.kind !== "failure") assert.fail("expected typed failure");
    assert.equal(result.terminal.roleOutcome.cause, "activation");
    assert.match(result.terminal.roleOutcome.diagnostic, /HTTP 404/);
    const errorArtifact = result.terminal.artifacts.find((artifact) => artifact.kind === "error");
    assert.ok(errorArtifact, "typed failure must publish an Error Artifact");
    assert.match(await readFile(errorArtifact.path, "utf8"), /HTTP 404/);
  });
});

test("#676 D6 public Collector returns closed-PR findings without new requests", { timeout: 120_000 }, async () => {
  await withHermeticHome({ prefix: "ak-public-collector-closed-" }, async ({ home }) => {
    const project = resolve(home, "work");
    const agentDir = resolve(home, ".pi", "agent");
    const binDir = resolve(home, "bin");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    seedProject(project);

    const logPath = resolve(home, "gh-calls.jsonl");
    const gh = resolve(binDir, "gh");
    await writeFile(gh, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2); const path=args.filter(a=>a.startsWith('/')).at(-1)||'';
const methodIdx=args.indexOf('-X'); const method=methodIdx>=0?args[methodIdx+1]:'GET';
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({method,path,args})+'\\n');
if(method==='POST'){ process.stderr.write('unexpected-post'); process.exit(3); }
function ok(body){process.stdout.write('HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(body));}
if(path.endsWith('/user')) ok({login:'collector-fixture'});
else if(path.includes('/pulls/9')&&!path.includes('/reviews')&&!path.includes('/comments')&&!path.includes('?')) ok({number:9,state:'closed',merged:true,head:{sha:'cafebabe'},updated_at:'2026-01-01T00:00:00Z',html_url:'https://github.com/acme/widgets/pull/9'});
else if(path.includes('/reviews')) ok([{id:91,user:{login:'coderabbitai[bot]',type:'Bot',id:136622811},state:'COMMENTED',body:'closed-pr finding',commit_id:'cafebabe',submitted_at:'2026-01-01T00:01:00Z',html_url:'https://github.com/acme/widgets/pull/9#pullrequestreview-91'}]);
else if(path.includes('/comments')||path.includes('/reactions')) ok([]);
else process.exit(2);
`, "utf8");
    await chmod(gh, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      const result = await runAkRole([
        "collector", "--model", "ak-collector-offline/faux-1", "--thinking", "off",
        "--project", project, "--repo", "acme/widgets", "--pr", "9",
        "Collect closed PR materials.",
      ], {
        packageRoot, home, agentDir, cwd: project,
        createRunId: () => "public-collector-closed",
        credentials: { "openai-codex": true, xai: false },
        collectorExtraPiArgs: ["-e", resolve(packageRoot, "test/fixtures/collector-observe-provider.ts")],
        collectorTimeoutMs: 90_000,
        io: { stdout() {}, stderr() {} },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal(result.terminal?.roleOutcome.decisiveFacts.prState, "CLOSED");
      const reportPath = result.terminal?.artifacts.find((artifact) => artifact.kind === "report")?.path;
      assert.ok(reportPath);
      const report = JSON.parse(await readFile(reportPath, "utf8")) as { receipt: any };
      assert.equal(report.receipt.prState, "CLOSED");
      assert.equal(report.receipt.requestAttempts.length, 0);
      assert.ok(report.receipt.groups.some((group: any) => group.findings.length >= 1));
      assert.ok(
        report.receipt.groups.some((group: any) =>
          group.findings.some((finding: any) => finding.pointer?.commentId === 91),
        ),
      );
      const calls = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(calls.some((call: any) => call.method === "POST"), false, "closed PR must not POST");
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });
});

test("#676 D1 public Collector rejects zero/multi/detached targets without POST", { timeout: 60_000 }, async () => {
  await withHermeticHome({ prefix: "ak-public-collector-ambiguous-" }, async ({ home }) => {
    const project = resolve(home, "work");
    const agentDir = resolve(home, ".pi", "agent");
    const binDir = resolve(home, "bin");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    seedProject(project);

    const logPath = resolve(home, "gh-calls.jsonl");
    const modePath = resolve(home, "gh-mode.txt");
    await writeFile(modePath, "zero", "utf8");
    const gh = resolve(binDir, "gh");
    await writeFile(gh, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2); const path=args.filter(a=>a.startsWith('/')).at(-1)||'';
const methodIdx=args.indexOf('-X'); const method=methodIdx>=0?args[methodIdx+1]:'GET';
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({method,path})+'\\n');
if(method==='POST'){ process.stderr.write('unexpected-post'); process.exit(3); }
function ok(body){process.stdout.write('HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(body));}
const mode=fs.readFileSync(${JSON.stringify(modePath)},'utf8').trim();
if(path.includes('/commits/') && path.endsWith('/pulls')) {
  if(mode==='multi') ok([{number:11},{number:12}]);
  else ok([]);
  return;
}
if(path.includes('/pulls?') || path.includes('pulls?head=')) {
  if(mode==='multi') ok([{number:11},{number:12}]);
  else ok([]);
  return;
}
process.exit(2);
`, "utf8");
    await chmod(gh, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    const runAmbiguous = async (label: string) => {
      const before = (await readFile(logPath, "utf8").catch(() => "")).length;
      const stderr: string[] = [];
      const result = await runAkRole([
        "collector", "--model", "ak-collector-offline/faux-1", "--thinking", "off",
        "--project", project, "--repo", "acme/widgets",
        `Ambiguous ${label}`,
      ], {
        packageRoot, home, agentDir, cwd: project,
        createRunId: () => `public-collector-ambiguous-${label}`,
        credentials: { "openai-codex": true, xai: false },
        collectorExtraPiArgs: ["-e", resolve(packageRoot, "test/fixtures/collector-observe-provider.ts")],
        collectorTimeoutMs: 30_000,
        io: { stdout() {}, stderr: (text) => stderr.push(text) },
      });
      assert.equal(result.exitCode, 2, `${label}: ${stderr.join("")}`);
      assert.equal(result.terminal, undefined, label);
      const lines = (await readFile(logPath, "utf8")).slice(before).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(lines.some((call: any) => call.method === "POST"), false, `${label} must not POST`);
      assert.ok(lines.length >= 1, `${label} must record gh lookup calls`);
    };

    try {
      execFileSync("git", ["checkout", "-b", "feature/no-unique-pr"], { cwd: project });
      await writeFile(modePath, "zero", "utf8");
      await runAmbiguous("zero");

      await writeFile(modePath, "multi", "utf8");
      await writeFile(logPath, "", "utf8");
      await runAmbiguous("multi");

      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
      execFileSync("git", ["checkout", "--detach", sha], { cwd: project, stdio: "ignore" });
      await writeFile(logPath, "", "utf8");
      const stderr: string[] = [];
      const detached = await runAkRole([
        "collector", "--model", "ak-collector-offline/faux-1", "--thinking", "off",
        "--project", project, "--repo", "acme/widgets",
        "Detached HEAD must not guess.",
      ], {
        packageRoot, home, agentDir, cwd: project,
        createRunId: () => "public-collector-ambiguous-detached",
        credentials: { "openai-codex": true, xai: false },
        collectorExtraPiArgs: ["-e", resolve(packageRoot, "test/fixtures/collector-observe-provider.ts")],
        collectorTimeoutMs: 30_000,
        io: { stdout() {}, stderr: (text) => stderr.push(text) },
      });
      assert.equal(detached.exitCode, 2, stderr.join(""));
      assert.equal(detached.terminal, undefined);
      const detachedCalls = (await readFile(logPath, "utf8")).trim();
      assert.equal(detachedCalls.length, 0, "detached HEAD must not query gh before requiring --pr");
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });
});

test("#676 D1 public Collector resolves fork head and unique branch PR without guessing", { timeout: 120_000 }, async () => {
  await withHermeticHome({ prefix: "ak-public-collector-branch-" }, async ({ home }) => {
    const project = resolve(home, "work");
    const agentDir = resolve(home, ".pi", "agent");
    const binDir = resolve(home, "bin");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    seedProject(project);
    execFileSync("git", ["checkout", "-b", "codex/issue-676"], { cwd: project });
    // Contributor fork remote as upstream of the working branch (base repo stays origin).
    execFileSync("git", ["remote", "add", "fork", "https://github.com/contributor/widgets.git"], { cwd: project });
    execFileSync("git", ["config", "branch.codex/issue-676.remote", "fork"], { cwd: project });
    execFileSync("git", ["config", "branch.codex/issue-676.merge", "refs/heads/codex/issue-676"], { cwd: project });

    const logPath = resolve(home, "gh-calls.jsonl");
    const gh = resolve(binDir, "gh");
    await writeFile(gh, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2); const path=args.filter(a=>a.startsWith('/')).at(-1)||'';
const methodIdx=args.indexOf('-X'); const method=methodIdx>=0?args[methodIdx+1]:'GET';
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({method,path})+'\\n');
if(method==='POST'){ process.stderr.write('unexpected-post'); process.exit(3); }
function ok(body){process.stdout.write('HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(body));}
if(path.endsWith('/user')) ok({login:'collector-fixture'});
else if(path.includes('pulls?head=') || (path.includes('/pulls?') && path.includes('head='))) {
  if(path.includes('contributor') || decodeURIComponent(path).includes('contributor:')) ok([{number:6761,head:{ref:'codex/issue-676'}}]);
  else ok([]);
}
else if(path.includes('/commits/') && path.endsWith('/pulls')) ok([]);
else if(path.includes('/pulls/6761')&&!path.includes('/reviews')&&!path.includes('/comments')) ok({number:6761,state:'open',head:{sha:'branchhead'},updated_at:'2026-01-01T00:00:00Z',html_url:'https://github.com/acme/widgets/pull/6761'});
else if(path.includes('/reviews')) ok([{id:61,user:{login:'chatgpt-codex-connector[bot]',type:'Bot',id:199175422},state:'COMMENTED',body:'branch-resolved finding',commit_id:'branchhead',submitted_at:'2026-01-01T00:01:00Z',html_url:'https://github.com/acme/widgets/pull/6761#pullrequestreview-61'}]);
else if(path.includes('/comments')||path.includes('/reactions')) ok([]);
else process.exit(2);
`, "utf8");
    await chmod(gh, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      const result = await runAkRole([
        "collector", "--model", "ak-collector-offline/faux-1", "--thinking", "off",
        "--project", project, "--repo", "acme/widgets",
        "Resolve fork branch target and collect.",
      ], {
        packageRoot, home, agentDir, cwd: project,
        createRunId: () => "public-collector-branch",
        credentials: { "openai-codex": true, xai: false },
        collectorExtraPiArgs: ["-e", resolve(packageRoot, "test/fixtures/collector-observe-provider.ts")],
        collectorTimeoutMs: 90_000,
        io: { stdout() {}, stderr() {} },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal(result.terminal?.roleOutcome.decisiveFacts.prNumber, 6761);
      const reportPath = result.terminal?.artifacts.find((artifact) => artifact.kind === "report")?.path;
      assert.ok(reportPath);
      const report = JSON.parse(await readFile(reportPath, "utf8")) as { receipt: any };
      assert.equal(report.receipt.prNumber, 6761);
      assert.equal(report.receipt.prState, "OPEN");
      assert.ok(
        report.receipt.groups.some((group: any) =>
          group.findings.some((finding: any) => finding.pointer?.commentId === 61),
        ),
      );
      const calls = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(calls.some((call: any) => call.method === "POST"), false);
      assert.ok(
        calls.some((call: any) => typeof call.path === "string" && (call.path.includes("contributor") || decodeURIComponent(call.path).includes("contributor:"))),
        "fork head owner must appear in lookup path",
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });
});

test("#676 D1 target lookup infrastructure failure is not washed into usage exit 2", { timeout: 30_000 }, async () => {
  await withHermeticHome({ prefix: "ak-public-collector-infra-" }, async ({ home }) => {
    const project = resolve(home, "work");
    const agentDir = resolve(home, ".pi", "agent");
    const binDir = resolve(home, "bin");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    seedProject(project);
    execFileSync("git", ["checkout", "-b", "feature/lookup-fail"], { cwd: project });

    const gh = resolve(binDir, "gh");
    await writeFile(gh, `#!/usr/bin/env node
process.stderr.write('gh simulated transport failure\\n');
process.exit(1);
`, "utf8");
    await chmod(gh, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    const stderr: string[] = [];
    try {
      const result = await runAkRole([
        "collector", "--model", "ak-collector-offline/faux-1", "--thinking", "off",
        "--project", project, "--repo", "acme/widgets",
        "Lookup failure must keep true cause.",
      ], {
        packageRoot, home, agentDir, cwd: project,
        createRunId: () => "public-collector-infra",
        credentials: { "openai-codex": true, xai: false },
        collectorExtraPiArgs: ["-e", resolve(packageRoot, "test/fixtures/collector-observe-provider.ts")],
        collectorTimeoutMs: 30_000,
        io: { stdout() {}, stderr: (text) => stderr.push(text) },
      });
      assert.notEqual(result.exitCode, 2, stderr.join(""));
      assert.equal(result.exitCode, 1, stderr.join(""));
      assert.match(stderr.join(""), /lookup|gh api failed|HTTP|transport|failed/i);
      assert.equal(result.terminal, undefined);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });
});
