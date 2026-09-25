#!/usr/bin/env python3
"""Freeze one recorded seat run into a self-contained replay kit.

Kit layout (default ~/.ak-roles/replays/<runId>/):
  meta.json      role/host/model/ticket/cut/head/original paths
  issue.json     ticket body as of the cut (served by bin/gh for `issue view N`)
  records.jsonl  diarist records with timestamp <= cut, session pointers re-aimed at sources/
  sources/       the driver transcripts those records point at, truncated at the cut
  run/<run>/     the replayed run itself truncated at the cut (ledger rows, payloads, attachments)
  pointer.md     the run's case-dossier pointer, re-pointed at records.jsonl
  sys.txt        frozen system prompt (codex: full headless prompt; pi: appended tail)
  schema.json    headless output schema when the run had one
  instr.txt      the instruction the run was admitted with
  wt/            detached worktree at the judged HEAD (node_modules symlinked); run.py adds wt-<leg>/
  bin/ zdot/     gh shim + login-shell PATH glue
"""
import argparse, hashlib, json, os, shutil, subprocess, sys
from datetime import datetime, timezone

SUPPORTED_HOSTS = ("codex", "pi")
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
    # GitHub's UserContentEdit.diff carries the full body after that edit (verified on
    # #1021: the 04:44:49 edit's diff equals the body the seat read, 4 edits before the cut).
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

def book_root(run, book_key):
    # <...>/books/<bookKey>/... — independent of where the run sits (ticket, unbound, legacy).
    parts = run.split(os.sep)
    for i in range(len(parts) - 1, 0, -1):
        if parts[i] == book_key and parts[i - 1] == "books":
            return os.sep.join(parts[: i + 1])
    sys.exit(f"run path does not contain books/{book_key}: {run}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--cut", help="ISO time; materials after it are hidden (default: first sealed submission)")
    ap.add_argument("--head", help="commit the seat judged (default: last commit before cut on the run's project branch)")
    ap.add_argument("--kit", help="kit directory (default ~/.ak-roles/replays/<runId>)")
    ap.add_argument("--repo", help="local git repo to cut the worktree from (default: the run's project root)")
    ap.add_argument("--repo-slug", help="owner/name for gh (default: from the repo's origin remote)")
    ap.add_argument("--tool-dir", required=True)
    a = ap.parse_args()

    run = os.path.abspath(a.run_dir.rstrip("/"))
    inv = load_json(f"{run}/invocation.json")
    adm = load_json(f"{run}/admitted-request.json") if os.path.exists(f"{run}/admitted-request.json") else {}
    role, host, num = inv["role"], inv.get("host", "pi"), inv.get("ticketNumber") or adm.get("ticketNumber")
    if host not in SUPPORTED_HOSTS:
        sys.exit(f"recorded host {host!r} has no replay runner (supported: {', '.join(SUPPORTED_HOSTS)})")
    if num is None:
        sys.exit("run has no ticket number; cannot freeze the ticket body")

    cut_raw, cut_src = (a.cut, "--cut") if a.cut else default_cut(run)
    cut = iso(cut_raw)
    project = inv["projectRoot"]
    src_repo = a.repo or project
    if not os.path.isdir(src_repo):
        sys.exit(f"project root {project} is gone; pass --repo <local checkout> (and --head if the branch moved)")
    repo = os.path.dirname(sh("git", "-C", src_repo, "rev-parse", "--path-format=absolute", "--git-common-dir").strip())
    head = a.head or sh("git", "-C", src_repo, "rev-list", "-1", f"--before={cut_raw}", "HEAD").strip()
    if not head:
        sys.exit("no commit before cut on the project's branch; pass --head")
    head = sh("git", "-C", repo, "rev-parse", head).strip()
    slug = a.repo_slug
    if slug is None:
        url = sh("git", "-C", src_repo, "remote", "get-url", "origin").strip()
        slug = url.split("github.com")[-1].lstrip(":/").removesuffix(".git")

    kit = os.path.abspath(a.kit or os.path.expanduser(f"~/.ak-roles/replays/{inv['runId']}"))
    if os.path.exists(kit):
        sys.exit(f"kit exists: {kit} (replay-run.sh clean <kit>, or pass --kit)")
    os.makedirs(kit)
    shutil.copytree(f"{a.tool_dir}/bin", f"{kit}/bin")
    shutil.copytree(f"{a.tool_dir}/zdot", f"{kit}/zdot")

    issue, warn = issue_at(slug, num, cut)
    with open(f"{kit}/issue.json", "w") as f:
        json.dump(issue, f, ensure_ascii=False, indent=1)

    records_src = f"{book_root(run, inv['bookKey'])}/{num}/records.jsonl"
    kept = [r for r in jsonl(records_src) if r.get("timestamp") and iso(r["timestamp"]) <= cut]
    # Source transcripts the diary points at are live files; freeze each one to the cut
    # and re-point the diary rows, so a leg following the pointer cannot read later turns.
    frozen_sources = {}
    def freeze_source(path):
        if path in frozen_sources:
            return frozen_sources[path]
        os.makedirs(f"{kit}/sources", exist_ok=True)
        # injective name: digest of the absolute path + basename (two hosts share leaf names)
        digest = hashlib.sha1(path.encode()).hexdigest()[:10]
        target = f"{kit}/sources/{digest}-{os.path.basename(path)}"
        n = 0
        with open(target, "w") as out, open(path) as src:
            for line in src:  # raw lines: positions, blank and malformed rows survive as they are
                try:
                    ts = json.loads(line).get("timestamp") if line.strip() else None
                except (json.JSONDecodeError, AttributeError):
                    ts = None
                if ts and iso(ts) > cut:
                    break  # transcripts are chronological; untimestamped trailer rows go with them
                out.write(line if line.endswith("\n") else line + "\n"); n += 1
        frozen_sources[path] = target
        return target
    kept_text = []
    for r in kept:
        for s in (r.get("payload") or {}).get("sessions") or []:
            path = s.get("path") if isinstance(s, dict) else None
            if isinstance(path, str) and path.endswith(".jsonl") and os.path.exists(path):
                s["path"] = freeze_source(path)
        kept_text.append(json.dumps(r, ensure_ascii=False))
    with open(f"{kit}/records.jsonl", "w") as f:
        for line in kept_text:
            f.write(line + "\n")

    # The run's own directory keeps growing after the cut (later verdicts, ledger rows). Freeze a
    # copy truncated at the cut and point every prompt reference at it.
    frozen_run = f"{kit}/run/{os.path.basename(run)}"
    os.makedirs(f"{frozen_run}/session/submission-ledger", exist_ok=True)
    cut_epoch = cut.timestamp()
    def repoint(text):
        return text.replace(records_src, f"{kit}/records.jsonl").replace(run, frozen_run)
    for name in sorted(os.listdir(run)):  # role inputs too: task.md, fix-packet.md, manifests…
        src_path = f"{run}/{name}"
        if not os.path.isfile(src_path):
            continue
        try:
            with open(src_path, encoding="utf-8") as f:
                text = f.read()
            with open(f"{frozen_run}/{name}", "w", encoding="utf-8") as f:
                f.write(repoint(text))
        except UnicodeDecodeError:
            shutil.copy(src_path, f"{frozen_run}/{name}")
    if os.path.isdir(f"{run}/attachments"):  # only what the run held at the cut
        for root, _dirs, files in os.walk(f"{run}/attachments"):
            for name in files:
                src_path = os.path.join(root, name)
                st = os.stat(src_path)  # birth time: the run's own pointer files get rewritten on every resume
                if getattr(st, "st_birthtime", st.st_mtime) > cut_epoch:
                    continue
                dest = os.path.join(frozen_run, os.path.relpath(src_path, run))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                try:
                    with open(src_path, encoding="utf-8") as f:
                        text = f.read()
                    with open(dest, "w", encoding="utf-8") as f:
                        f.write(repoint(text))
                except UnicodeDecodeError:
                    shutil.copy(src_path, dest)
    ledger_rows = jsonl(f"{run}/session/submission-ledger/records.jsonl")
    kept_ledger = [r for r in ledger_rows if not r.get("timestamp") or iso(r["timestamp"]) <= cut]
    with open(f"{frozen_run}/session/submission-ledger/records.jsonl", "w") as f:
        for r in kept_ledger:
            f.write(repoint(json.dumps(r, ensure_ascii=False)) + "\n")
    # The report face is rebuilt from the truncated ledger alone: payloads are the sealed rows'
    # accepted bodies in order, and no post-cut terminal fields survive.
    payloads_before = []
    for r in kept_ledger:
        if r.get("kind") != "sealed":
            continue
        accepted = (r.get("payload") or {}).get("accepted", r.get("accepted"))
        if accepted is not None:
            payloads_before.append(accepted)
    sealed_before = len(payloads_before)
    if os.path.exists(f"{run}/artifacts/report.json"):
        os.makedirs(f"{frozen_run}/artifacts", exist_ok=True)
        with open(f"{frozen_run}/artifacts/report.json", "w") as f:
            json.dump({"frozenAt": cut_raw, "outcome": {"payloads": payloads_before}}, f, ensure_ascii=False, indent=1)
    for rel in ("session/session.jsonl", "session/host-session/records.jsonl"):
        if os.path.exists(f"{run}/{rel}"):
            os.makedirs(os.path.dirname(f"{frozen_run}/{rel}"), exist_ok=True)
            with open(f"{frozen_run}/{rel}", "w") as f:
                for r in jsonl(f"{run}/{rel}"):
                    if not r.get("timestamp") or iso(r["timestamp"]) <= cut:
                        f.write(repoint(json.dumps(r, ensure_ascii=False)) + "\n")

    pointer_src = f"{run}/attachments/case-dossier/00-case-dossier-pointer.md"
    pointer = open(pointer_src).read() if os.path.exists(pointer_src) else ""
    if records_src in pointer:
        pointer = pointer.replace(records_src, f"{kit}/records.jsonl")
    elif pointer.strip():
        # runs admitted before the ticket was bound carry a template pointer; name the frozen copy
        pointer = pointer.rstrip("\n") + f"\n冻结副本：{kit}/records.jsonl\n"
    with open(f"{kit}/pointer.md", "w") as f:
        f.write(pointer)

    notice = NOTICE.format(repo=os.path.basename(repo), head=head[:8], cut=cut_raw, num=num)
    hp = f"{run}/headless-system-prompt.txt"
    sys_kind = "headless-system-prompt" if os.path.exists(hp) else "pi-tail"
    sysprompt = open(hp).read().replace(records_src, f"{kit}/records.jsonl").replace(run, frozen_run) if sys_kind == "headless-system-prompt" else None

    sh("git", "-C", repo, "worktree", "prune")
    sh("git", "-C", repo, "worktree", "add", "--detach", f"{kit}/wt", head)
    nm = f"{repo}/node_modules"
    if os.path.isdir(nm) and not os.path.exists(f"{kit}/wt/node_modules"):
        os.symlink(nm, f"{kit}/wt/node_modules")

    if sysprompt is None:
        env = dict(os.environ, AK_REPLAY_POINTER=f"{kit}/pointer.md")
        p = subprocess.run(["node", "--import", "tsx", f"{a.tool_dir}/pi-tail.ts", role, f"{kit}/wt"],
                           cwd=f"{kit}/wt", env=env, text=True, capture_output=True)
        if p.returncode != 0:
            sys.exit(f"pi tail assembly failed at {head[:8]} (hand-build a --sys for run.py):\n{p.stderr}")
        sysprompt = p.stdout.replace(run, frozen_run)
    with open(f"{kit}/sys.txt", "w") as f:
        f.write(notice + sysprompt)

    if os.path.exists(f"{run}/headless-output-schema.json"):
        shutil.copy(f"{run}/headless-output-schema.json", f"{kit}/schema.json")
    with open(f"{kit}/instr.txt", "w") as f:
        f.write((adm.get("instruction") or "").replace(run, frozen_run))

    meta = {"runId": inv["runId"], "runDir": run, "role": role, "host": host, "provider": inv.get("provider"),
            "model": inv.get("model"), "thinking": inv.get("thinking"), "ticket": num, "repoSlug": slug, "repo": repo,
            "project": project, "cut": cut_raw, "cutSource": cut_src, "head": head, "sysKind": sys_kind,
            "issueBodyAt": issue["updatedAt"], "recordsKept": len(kept), "recordsSource": records_src, "frozenSources": sorted(frozen_sources), "frozenRun": frozen_run, "payloadsKept": sealed_before,
            "frozenAt": datetime.now(timezone.utc).isoformat()}
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
