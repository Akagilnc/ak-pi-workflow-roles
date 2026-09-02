import { resolve } from "node:path";
import {
  physicalPathIdentity,
  physicallyContainedIn,
  resolveActivationLedgerHomeForPath
} from "./activation-ledger-topology.js";
function issueRoot(value) {
  const normalized = value.replaceAll("\\", "/");
  const marker = ".ak/work/issues/";
  const index = normalized.indexOf(marker);
  if (index < 0) return void 0;
  const issue = normalized.slice(index + marker.length).split("/")[0]?.split("#")[0];
  return issue === void 0 || issue === "" ? void 0 : normalized.slice(0, index + marker.length) + issue;
}
function workIdentityFromCwd(cwd) {
  const resolvedCwd = resolve(cwd, ".");
  const cwdIssue = issueRoot(resolvedCwd);
  if (cwdIssue !== void 0) return cwdIssue;
  if (resolvedCwd.includes("/.ak/work/")) return resolvedCwd;
  return void 0;
}
function isMachineLedgerSessionPath(sessionPath) {
  return physicallyContainedIn(resolveActivationLedgerHomeForPath(sessionPath), sessionPath);
}
function subjectPath(sessionDir, cwd = process.cwd()) {
  if (sessionDir === "") {
    return workIdentityFromCwd(cwd) ?? resolve(cwd, ".ak/work");
  }
  const resolvedSession = resolve(cwd, sessionDir || ".ak/work");
  if (isMachineLedgerSessionPath(resolvedSession)) {
    return workIdentityFromCwd(cwd) ?? resolve(cwd, ".ak/work");
  }
  const issue = issueRoot(resolvedSession);
  if (issue !== void 0) return issue;
  const runsMarker = "/runs/";
  const runsIndex = resolvedSession.indexOf(runsMarker);
  if (runsIndex >= 0) {
    return resolvedSession.slice(0, runsIndex);
  }
  return resolvedSession;
}
function workSubjectKeyFromProjectRoot(projectRoot) {
  return subjectPath("", projectRoot);
}
function workSubjectKeysEqual(left, right) {
  return physicalPathIdentity(left) === physicalPathIdentity(right);
}
export {
  issueRoot,
  subjectPath,
  workSubjectKeyFromProjectRoot,
  workSubjectKeysEqual
};
