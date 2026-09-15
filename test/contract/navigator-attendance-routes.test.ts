// #420 整改拆分：路线记忆与重绑家族
// #178: prepare consumers that relied on package navigator default were culled.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { settlementNavigationFromEvent, writeNavigatorModelSetting, navigatorSubjectKey, navigatorSubjectKeyForInput, parseNavigatorModelSetting, readNavigatorModelSetting, selectNavigatorCandidate, subjectPath } from "../../src/navigator-attendance.ts";
import { createHash } from "node:crypto";
import { candidate } from "../helpers/navigator-attendance-kit.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

// #685: host-neutral native AgentSession prompt cases culled — providerFailure/
// terminal-less. C3 §I: 无具名 @navigator 卷，不得用异常面总称结清
// (docs/research/issue-685-c3-deleted-contract-handoff.md). Call-input remains.

test("persistent model edits are immediate and have no fallback", async () => {
  await withTempRoot("navigator-model-setting-", async (root) => {
    const path = join(root, "navigator-model.json");
    // #178: package default fill-in removed — test starts from an explicit write.
    const started = Date.now();
    await writeNavigatorModelSetting("provider/one:max", path);
    assert.equal(await readNavigatorModelSetting(path), "provider/one:max");
    await writeNavigatorModelSetting("provider/two", path);
    assert.equal(await readNavigatorModelSetting(path), "provider/two");
    assert.equal(Date.now() - started < 5000, true);
    await writeFile(path, JSON.stringify({ model: "provider/one:backup" }));
    const opaqueSuffix = await readNavigatorModelSetting(path);
    // Suffix is opaque pass-through — no whitelist reject at parse (#683 / #675 ⑥).
    assert.deepEqual(parseNavigatorModelSetting(opaqueSuffix), {
      provider: "provider",
      model: "one",
      thinkingLevel: "backup",
    });
    await writeFile(path, JSON.stringify({ model: "provider-only-no-slash" }));
    const invalid = await readNavigatorModelSetting(path);
    assert.throws(() => parseNavigatorModelSetting(invalid));
  });
});

test("settlement navigation essentials keep recommendation fields as written", () => {
  const recommendationEvent = {
    version: 1 as const,
    disposition: "recommendation" as const,
    invocationId: "i1",
    role: "judge",
    phase: null,
    subjectKey: "/repo",
    route: [{ role: "judge" as const, phase: null }, { role: "reviewer" as const, phase: null }],
    next: { role: "reviewer" as const, phase: null },
    reason: "needs review",
    command: "Usage: pi --ak-role reviewer --help" };
  assert.deepEqual(settlementNavigationFromEvent(recommendationEvent), {
    disposition: "recommendation",
    route: recommendationEvent.route,
    next: recommendationEvent.next,
    reason: recommendationEvent.reason,
    command: recommendationEvent.command });
  assert.deepEqual(
    settlementNavigationFromEvent({
      version: 1,
      disposition: "recommendation",
      invocationId: "i2",
      role: "judge",
      phase: null,
      subjectKey: "/repo",
      next: { role: "fixer", phase: "apply" } }),
    {
      disposition: "recommendation",
      next: { role: "fixer", phase: "apply" } },
  );
});

test("work subjects remain stable and isolate ad hoc work", async () => {
  const issue = subjectPath("/repo/.ak/work/issues/28/runs/one/session", "/repo");
  assert.equal(issue, "/repo/.ak/work/issues/28");
  assert.equal(subjectPath(".ak/work/issues/28/runs/two/session", "/repo"), issue);
  assert.equal(subjectPath("/repo/.ak/work/ad-hoc/runs/coder/task.md", "/repo"), "/repo/.ak/work/ad-hoc");
  assert.equal(subjectPath("/repo/.ak/work/ad-hoc/runs/reviewer/fix-packet.json", "/repo"), "/repo/.ak/work/ad-hoc");

  const adHocRoot = "/repo/.ak/work/ad-hoc";
  assert.equal(navigatorSubjectKey(adHocRoot, "same concrete task"), navigatorSubjectKey(adHocRoot, "same   concrete task"));
  assert.notEqual(navigatorSubjectKey(adHocRoot, "same concrete task"), navigatorSubjectKey(adHocRoot, "different task"));
  assert.equal(
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/coder/other-task.md", "/repo"),
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/reviewer/fix-packet.json", "/repo"),
    "natural role-specific filenames remain one work subject",
  );
  assert.notEqual(
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/coder/task.md", "/repo"),
    navigatorSubjectKeyForInput("/repo/.ak/work/other-ad-hoc", "/repo/.ak/work/other-ad-hoc/runs/reviewer/fix-packet.json", "/repo"),
    "distinct work roots remain isolated",
  );
  assert.equal(navigatorSubjectKey("/repo/task.md", "task text"), "/repo/task.md");

  const ledgerSession = "/custom/home/.ak-roles/books/repo/issues/28/runs/judge@src/session";
  assert.equal(subjectPath(ledgerSession, "/repo"), "/repo/.ak/work");
  assert.equal(subjectPath("", "/repo"), "/repo/.ak/work");
  assert.equal(subjectPath(ledgerSession, issue), issue);
  // Any `.ak-roles/books/...` tree is ledger topology (ADR 0048 / #604), not work identity —
  // even a mislocated tree under a repo root derives subject from cwd, never the ledger path.
  assert.equal(subjectPath("/repo/.ak-roles/books/repo/issues/28/runs/judge@src/session", "/repo"), "/repo/.ak/work");

  await withTempRoot("ak-nav-physical-", async (home) => {
    const { realpathSync } = await import("node:fs");
    const physicalIssue = resolve(home, ".ak/work/issues/28");
    const session = resolve(home, ".ak-roles/books/h/runs/judge-navigator/session");
    await mkdir(physicalIssue, { recursive: true });
    await mkdir(session, { recursive: true });
    assert.equal(subjectPath(session, physicalIssue), physicalIssue);
    assert.equal(subjectPath(realpathSync(session), physicalIssue), physicalIssue);
    });

  assert.equal(navigatorSubjectKey(adHocRoot, `work subject: ${adHocRoot}`, "placeholder"), adHocRoot);
  const legitimate = `work subject: ${adHocRoot} with real task bytes`;
  const hashed = navigatorSubjectKey(adHocRoot, legitimate, "role_input");
  assert.equal(hashed, `${adHocRoot}#${createHash("sha256").update(legitimate.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 32)}`);
  assert.equal(navigatorSubjectKey(adHocRoot, "placeholder subject for work", "placeholder"), adHocRoot);
  assert.notEqual(navigatorSubjectKey(adHocRoot, "placeholder subject for work", "user_prompt"), adHocRoot);
});

test("status-specific route candidates outrank generics regardless of declaration order", () => {
  const route = [{ role: "fixer" as const, phase: "apply" as const }, { role: "judge" as const, phase: null }];
  const generic = candidate({
    id: "generic",
    matches: { role: "fixer", phase: "apply", kind: "accepted" },
    route,
    next: route[1]!,
    reason: "generic fallback" }).candidates[0]!;
  const unfinishedSpecific = candidate({
    id: "unfinished-specific",
    matches: { role: "fixer", phase: "apply", kind: "accepted", statuses: ["unfinished"] },
    route,
    next: route[0]!,
    reason: "finish the open class" }).candidates[0]!;
  const settlement = { kind: "accepted" as const, role: "fixer", phase: "apply" as const, status: "unfinished" };
  assert.equal(selectNavigatorCandidate([generic, unfinishedSpecific], settlement)?.candidate.id, "unfinished-specific");
  assert.equal(selectNavigatorCandidate([unfinishedSpecific, generic], settlement)?.candidate.id, "unfinished-specific");
  assert.equal(selectNavigatorCandidate([generic, unfinishedSpecific], { kind: "accepted", role: "fixer", phase: "apply", status: "completed" })?.candidate.id, "generic");
  assert.equal(selectNavigatorCandidate([unfinishedSpecific, generic], { kind: "accepted", role: "fixer", phase: "apply", status: "completed" })?.candidate.id, "generic");
  // Statuses list membership (absorbed from model-settings carrier).
  const reviewerStatuses = candidate({
    matches: { role: "reviewer", phase: null, kind: "accepted", statuses: ["completed", "refused"] },
    route: [{ role: "judge", phase: null }],
    next: { role: "judge", phase: null } }).candidates;
  assert.equal(selectNavigatorCandidate(reviewerStatuses, { kind: "accepted", role: "reviewer", phase: null, status: "completed" })?.candidate.id, reviewerStatuses[0]!.id);
  assert.equal(selectNavigatorCandidate(reviewerStatuses, { kind: "accepted", role: "reviewer", phase: null, status: "refused" })?.candidate.id, reviewerStatuses[0]!.id);
});
