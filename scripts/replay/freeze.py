#!/usr/bin/env python3
"""Freeze one recorded seat run into a self-contained replay kit.

Kit layout (default ~/.ak-roles/replays/<runId>/):
  meta.json      role/host/model/ticket/cut/head/original paths
  issue.json     ticket body as of the cut (served by bin/gh for `issue view N`)
  records.jsonl  diarist records with timestamp <= cut
  sys.txt        frozen system prompt (codex: full headless prompt; pi: appended tail)
  schema.json    headless output schema when the run had one
  instr.txt      the instruction the run was admitted with
  wt/            detached worktree at the judged HEAD (node_modules symlinked)
  bin/ zdot/     gh shim + login-shell PATH glue
"""
import argparse, json, os, shutil, subprocess, sys
from datetime import datetime, timezone

NOTICE = ("<frozen_replay_notice>\n本局为冻结重放：仓库是 {repo} 在 {head} 的分离工作树；本票起居录已冻结在 {cut} 时的状态"
          "（路径见随案指针）；`gh issue view {num}` 返回的是当时的票面。照常审、照常交卷。\n</frozen_replay_notice>\n\n")

def sh(*cmd, cwd=None, check=True):
    p = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    if check and p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{p.stderr}")
    return p.stdout

def load_json(path):
    with open(path) as f:
        return json.load(f)

def jsonl(path):
    if not os.path.exists(path):
        return []
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows

def iso(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc)

def default_cut(run):
    sealed = [r["timestamp"] for r in jsonl(f"{run}/session/submission-ledger/records.jsonl") if r.get("kind") == "sealed" and r.get("timestamp")]
    if sealed:
        return min(sealed), "first sealed submission"
    rows = jsonl(f"{run}/session/session.jsonl")
    if rows and rows[0].get("timestamp"):
        return rows[0]["timestamp"], "session start"
    sys.exit("cannot infer cut time; pass --cut")

def issue_at(repo_slug, num, cut):
    owner, name = repo_slug.split("/")
    q = ('query{repository(owner:"%s",name:"%s"){issue(number:%d){title url state createdAt body '
         'userContentEdits(first:100){nodes{editedAt diff}} comments(first:100){nodes{author{login} createdAt body}}}}}' % (owner, name, num))
    data = json.loads(sh("gh", "api", "graphql", "-f", f"query={q}"))["data"]["repository"]["issue"]
    edits = sorted((e for e in data["userContentEdits"]["nodes"] if e.get("diff") is not None), key=lambda e: e["editedAt"])
    before = [e for e in edits if iso(e["editedAt"]) <= cut]
    warn = None
    if before:
        body, body_at = before[-1]["diff"], before[-1]["editedAt"]
    elif edits:
        body, body_at = data["body"], "CURRENT"
        warn = f"issue #{num}: all {len(edits)} edits are after the cut; original body is not recoverable, using CURRENT body"
    else:
        body, body_at = data["body"], data["createdAt"]
    comments = [c for c in data["comments"]["nodes"] if iso(c["createdAt"]) <= cut]
    return {"number": num, "title": data["title"], "url": data["url"], "state": "OPEN", "updatedAt": body_at,
            "body": body, "comments": comments}, warn

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--cut", help="ISO time; materials after it are hidden (default: first sealed submission)")
    ap.add_argument("--head", help="commit the seat judged (default: last commit before cut on the run's project branch)")
    ap.add_argument("--kit", help="kit directory (default ~/.ak-roles/replays/<runId>)")
    ap.add_argument("--repo-slug", help="owner/name for gh (default: from the project's origin remote)")
    ap.add_argument("--tool-dir", required=True)
    a = ap.parse_args()

    run = os.path.abspath(a.run_dir.rstrip("/"))
    inv = load_json(f"{run}/invocation.json")
    adm = load_json(f"{run}/admitted-request.json") if os.path.exists(f"{run}/admitted-request.json") else {}
    role, host, num = inv["role"], inv.get("host", "pi"), inv.get("ticketNumber") or adm.get("ticketNumber")
    project = inv["projectRoot"]
    book_dir = os.path.dirname(os.path.dirname(run))
    if num is None:
        sys.exit("run has no ticket number; cannot freeze the ticket body")

    cut_raw, cut_src = (a.cut, "--cut") if a.cut else default_cut(run)
    cut = iso(cut_raw)
    if not os.path.isdir(project):
        sys.exit(f"project root {project} is gone; pass --head and --repo-slug")
    repo = sh("git", "-C", project, "rev-parse", "--path-format=absolute", "--git-common-dir").strip()
    repo = os.path.dirname(repo)
    head = a.head or sh("git", "-C", project, "rev-list", "-1", f"--before={cut_raw}", "HEAD").strip()
    if not head:
        sys.exit("no commit before cut on the project's branch; pass --head")
    head = sh("git", "-C", repo, "rev-parse", head).strip()
    slug = a.repo_slug
    if slug is None:
        url = sh("git", "-C", project, "remote", "get-url", "origin").strip()
        slug = url.split("github.com")[-1].lstrip(":/").removesuffix(".git")

    kit = os.path.abspath(a.kit or os.path.expanduser(f"~/.ak-roles/replays/{inv['runId']}"))
    if os.path.exists(kit):
        sys.exit(f"kit exists: {kit} (remove it or pass --kit)")
    os.makedirs(kit)
    shutil.copytree(f"{a.tool_dir}/bin", f"{kit}/bin")
    shutil.copytree(f"{a.tool_dir}/zdot", f"{kit}/zdot")

    issue, warn = issue_at(slug, num, cut)
    with open(f"{kit}/issue.json", "w") as f:
        json.dump(issue, f, ensure_ascii=False, indent=1)

    records_src = f"{book_dir}/records.jsonl"
    kept = [r for r in jsonl(records_src) if r.get("timestamp") and iso(r["timestamp"]) <= cut]
    with open(f"{kit}/records.jsonl", "w") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    notice = NOTICE.format(repo=os.path.basename(repo), head=head[:8], cut=cut_raw, num=num)
    hp = f"{run}/headless-system-prompt.txt"
    if os.path.exists(hp):
        sysprompt = open(hp).read().replace(records_src, f"{kit}/records.jsonl")
        sys_kind = "headless-system-prompt"
    else:
        sys_kind = "pi-tail"
        sysprompt = None  # built after the worktree exists

    sh("git", "-C", repo, "worktree", "add", "--detach", f"{kit}/wt", head)
    nm = f"{repo}/node_modules"
    if os.path.isdir(nm) and not os.path.exists(f"{kit}/wt/node_modules"):
        os.symlink(nm, f"{kit}/wt/node_modules")

    if sysprompt is None:
        p = subprocess.run(["node", "--import", "tsx", f"{a.tool_dir}/pi-tail.ts", role], cwd=f"{kit}/wt", text=True, capture_output=True)
        if p.returncode != 0:
            sys.exit(f"pi tail assembly failed at {head[:8]} (pass a hand-built --sys to run):\n{p.stderr}")
        sysprompt = p.stdout.replace(records_src, f"{kit}/records.jsonl")
    with open(f"{kit}/sys.txt", "w") as f:
        f.write(notice + sysprompt)

    if os.path.exists(f"{run}/headless-output-schema.json"):
        shutil.copy(f"{run}/headless-output-schema.json", f"{kit}/schema.json")
    with open(f"{kit}/instr.txt", "w") as f:
        f.write(adm.get("instruction") or "")

    meta = {"runId": inv["runId"], "runDir": run, "role": role, "host": host, "provider": inv.get("provider"),
            "model": inv.get("model"), "thinking": inv.get("thinking"), "ticket": num, "repoSlug": slug, "repo": repo,
            "project": project, "cut": cut_raw, "cutSource": cut_src, "head": head, "sysKind": sys_kind,
            "issueBodyAt": issue["updatedAt"], "recordsKept": len(kept), "frozenAt": datetime.now(timezone.utc).isoformat()}
    with open(f"{kit}/meta.json", "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    print(f"kit: {kit}")
    for k in ("role", "host", "model", "thinking", "ticket", "cut", "cutSource", "head", "sysKind", "issueBodyAt", "recordsKept"):
        print(f"  {k}: {meta[k]}")
    if warn:
        print(f"WARNING: {warn}")
    print("next: replay-run.sh run <kit> <arm> <n> [--sys edited-copy-of-sys.txt]")

if __name__ == "__main__":
    main()
