#!/usr/bin/env python3
"""Freeze one recorded seat run into a self-contained replay kit.

Kit layout (default ~/.ak-roles/replays/<runId>/):
  meta.json      role/host/model/ticket/cut/head/original paths
  issue.json     ticket body as of the cut (served by bin/gh for `issue view N`)
  records.jsonl  diarist records with timestamp <= cut, session pointers re-aimed at sources/
  sources/       the driver transcripts those records point at, truncated at the cut
  run/<run>/     the replayed run and the run it audits (admitted sourceRunPath), each truncated at the cut (current.json (rendered from the truncated rows), history.jsonl, state.jsonl, log.jsonl, session/)
  sys.txt        frozen system prompt when a turn-delivery row recorded one; otherwise notice-only (gap)
  schema.json    headless output schema when turn-delivery recorded one; omitted on gap
  instr.txt      admitted transport prompt (instruction + caller file-flag paths)
  wt/            detached worktree at the judged HEAD (node_modules symlinked); run.py adds wt-<leg>/
  bin/ zdot/     gh shim + login-shell PATH glue
"""
import argparse, hashlib, json, os, shutil, subprocess, sys
from datetime import datetime, timezone

def project_admitted_instruction(adm, tool_dir):
    """Reuse production appendCallerFileFlagPaths — no parallel join (#1169 J1)."""
    repo_root = os.path.abspath(f"{tool_dir}/../..")
    inv = os.path.abspath(f"{tool_dir}/../../src/public-cli/invocation.ts")
    # Official: text/universal_newlines converts stdout CR/LF to \n; binary does not
    # (docs.python.org/3/library/subprocess.html#frequently-used-arguments).
    # stdin JSON + Node utf8 + binary capture keeps dispatch/file-flag bytes intact.
    p = subprocess.run(
        ["node", "--import", "tsx", "-e",
         "import { readFileSync } from 'node:fs';"
         "import('" + inv + "').then((m) => {"
         "  const a = JSON.parse(readFileSync(0, 'utf8'));"
         "  process.stdout.write(m.appendCallerFileFlagPaths("
         "    a.instruction ?? '', a.attachments ?? [],"
         "    a.requestManifestPath, a.prerequisitesPath));"
         "})"],
        cwd=repo_root, capture_output=True,
        input=json.dumps(adm, ensure_ascii=False).encode("utf-8"),
    )
    if p.returncode != 0:
        sys.exit(
            "projecting admitted file-flag instruction failed:\n"
            + p.stderr.decode("utf-8", errors="replace")
        )
    return p.stdout.decode("utf-8")

SUPPORTED_HOSTS = ("codex", "pi")
NOTICE = ("<frozen_replay_notice>\n本局为冻结重放：仓库是 {repo} 在 {head} 的分离工作树；本票起居录与它指向的源卷都已冻结在 {cut} 时的状态："
          "起居录只从 {records} 读，源卷只开它里面指向的 {sources}/ 副本（自行开卷补齐陛下原话照常，开的是这份副本）；"
          "被审 run 与本 run 的卷宗在 {runs}/ 下；不读现场票目录、现场账本与现场源卷；`gh issue view {num}` 返回的是当时的票面。照常审、照常交卷。\n</frozen_replay_notice>\n\n")

def sh(*cmd, cwd=None, check=True):
    p = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    if check and p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{p.stderr}")
    return p.stdout

def load_json(path):
    with open(path) as f:
        return json.load(f)

def jsonl(path):
    """Parse jsonl facts. Absent file → []. Malformed completed line fails loudly with path:line."""
    rows = []
    try:
        fh = open(path)
    except FileNotFoundError:
        return []
    with fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"malformed JSONL {path}:{lineno}: {exc.msg}") from exc
    return rows

def iso(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc)

def default_cut(run):
    sealed = [r["timestamp"] for r in jsonl(f"{run}/history.jsonl") if r.get("kind") == "sealed" and r.get("timestamp")]
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
    return {"number": num, "title": title_at(repo_slug, num, cut, data["title"]), "url": data["url"], "state": "OPEN",
            "updatedAt": body_at, "body": body, "comments": comments}, warn

def title_at(repo_slug, num, cut, current_title):
    # The GraphQL issue node carries only the live title; renames live in the timeline.
    # Title at the cut = the last rename before the cut, else the `from` of the first rename after it.
    # --paginate --slurp yields one outer array of pages; flatten before filtering.
    pages = json.loads(sh("gh", "api", f"repos/{repo_slug}/issues/{num}/timeline", "--paginate", "--slurp"))
    events = sorted(({"at": e["created_at"], "from": e["rename"]["from"], "to": e["rename"]["to"]}
                     for page in pages for e in page if e.get("event") == "renamed"), key=lambda e: e["at"])
    before = [e for e in events if iso(e["at"]) <= cut]
    if before:
        return before[-1]["to"]
    if events:
        return events[0]["from"]
    return current_title

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
    if not os.path.exists(f"{run}/state.jsonl"):
        sys.exit(f"not a run directory (no state.jsonl): {run}")
    cut_raw, cut_src = (a.cut, "--cut") if a.cut else default_cut(run)
    cut = iso(cut_raw)
    # Identity and admission are the last rows of state.jsonl at or before the cut, not the live
    # current.json (a later resume may have rewritten them).
    at_cut = {}
    for r in jsonl(f"{run}/state.jsonl"):
        if (not r.get("timestamp") or iso(r["timestamp"]) <= cut) and isinstance(r.get("payload"), dict):
            at_cut[r.get("kind")] = r["payload"]
    inv = at_cut.get("invocation")
    if not inv:
        sys.exit(f"no invocation row at or before the cut in {run}/state.jsonl")
    adm = at_cut.get("admitted-request") or {}
    role, host, num = inv["role"], inv.get("host", "pi"), inv.get("ticketNumber") or adm.get("ticketNumber")
    if host not in SUPPORTED_HOSTS:
        sys.exit(f"recorded host {host!r} has no replay runner (supported: {', '.join(SUPPORTED_HOSTS)})")
    if num is None:
        sys.exit("run has no ticket number; cannot freeze the ticket body")

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
    # The audited run (admitted sourceRunPath: countersign → notary, judge → auditor …) is frozen the
    # same way, so the leg finds the audited verdict inside the kit instead of the live ledger.
    targets = [run]
    source_run = adm.get("sourceRunPath")
    if isinstance(source_run, str) and source_run != run and os.path.exists(f"{source_run}/state.jsonl"):
        targets.append(os.path.abspath(source_run))
    frozen_of = {t: f"{kit}/run/{os.path.basename(t)}" for t in targets}
    frozen_run = frozen_of[run]
    home = os.path.expanduser("~")
    def repoint(text):
        for live, frozen in ((records_src, f"{kit}/records.jsonl"), *frozen_of.items()):
            text = text.replace(live, frozen)
            if live.startswith(home):  # historical command text often spells the home as ~
                text = text.replace("~" + live[len(home):], frozen)
        return text
    def freeze_run_dir(run, frozen_run):
        """One run directory truncated at the cut: row files, rendered current.json, host original, session.jsonl."""
        os.makedirs(f"{frozen_run}/session", exist_ok=True)
        # Top-level role inputs (e.g. merger-input.json) freeze with the run.
        # #1168: do not copy obsolete dispatch copies into a new replay kit.
        _skip_run_files = {
            "current.json", "history.jsonl", "state.jsonl", "log.jsonl",
            "task.md", "fix-packet.md", "prerequisites.json",
        }
        for name in sorted(os.listdir(run)):
            src_path = f"{run}/{name}"
            if not os.path.isfile(src_path) or name in _skip_run_files:
                continue  # dossier files are rebuilt truncated below; obsolete copies stay put
            try:
                with open(src_path, encoding="utf-8") as f:
                    text = f.read()
                with open(f"{frozen_run}/{name}", "w", encoding="utf-8") as f:
                    f.write(repoint(text))
            except UnicodeDecodeError:
                shutil.copy(src_path, f"{frozen_run}/{name}")
        # #1169: do not carry attachments/ into a new replay kit (concept deleted;
        # stock volumes may still have the directory — leave them in place).
        def kept_rows(rel):
            return [r for r in jsonl(f"{run}/{rel}") if not r.get("timestamp") or iso(r["timestamp"]) <= cut]
        kept_history = kept_rows("history.jsonl")
        for rel in ("history.jsonl", "state.jsonl", "log.jsonl"):
            rows = kept_history if rel == "history.jsonl" else kept_rows(rel)
            if rows or os.path.exists(f"{run}/{rel}"):
                with open(f"{frozen_run}/{rel}", "w") as f:
                    for r in rows:
                        f.write(repoint(json.dumps(r, ensure_ascii=False)) + "\n")
        # current.json is the package's own rendering of the three truncated row files: nothing recorded
        # after the cut survives, and identity, admission and terminal are the last rows at or before it.
        p = subprocess.run(["node", "--import", "tsx", "-e",
                            "import('" + os.path.abspath(f"{a.tool_dir}/../../src/run-dossier.ts") + "').then((m) => m.renderCurrentSync(process.argv[1]))",
                            frozen_run], cwd=os.path.abspath(f"{a.tool_dir}/../.."), text=True, capture_output=True)
        if p.returncode != 0:
            sys.exit(f"rendering the frozen current.json failed:\n{p.stderr}")
        kept_sealed = [r for r in kept_history if r.get("kind") == "sealed"]
        payloads_before = [(r.get("payload") or {}).get("accepted") for r in kept_sealed if (r.get("payload") or {}).get("accepted") is not None]
        sealed_before = len(payloads_before)
        # The host original (codex / claude single file, grok directory) up to the cut.
        session_dir = f"{run}/session"
        for name in (os.listdir(session_dir) if os.path.isdir(session_dir) else []):
            path = f"{session_dir}/{name}"
            if name in ("codex.jsonl", "claude.jsonl") and os.path.isfile(path):
                os.makedirs(f"{frozen_run}/session", exist_ok=True)
                with open(f"{frozen_run}/session/{name}", "w") as out, open(path) as src:
                    for line in src:
                        try:
                            ts = json.loads(line).get("timestamp") if line.strip() else None
                        except (json.JSONDecodeError, AttributeError):
                            ts = None
                        if ts and iso(ts) > cut:
                            break
                        out.write(line if line.endswith("\n") else line + "\n")
            elif name == "grok-build" and os.path.isdir(path):
                os.makedirs(f"{frozen_run}/session/grok-build", exist_ok=True)
                for leaf in os.listdir(path):
                    shutil.copy(f"{path}/{leaf}", f"{frozen_run}/session/grok-build/{leaf}")
        # session.jsonl only here — log.jsonl was already truncated with the other row files above.
        if os.path.exists(f"{run}/session/session.jsonl"):
            os.makedirs(f"{frozen_run}/session", exist_ok=True)
            with open(f"{frozen_run}/session/session.jsonl", "w") as f:
                for r in jsonl(f"{run}/session/session.jsonl"):
                    if not r.get("timestamp") or iso(r["timestamp"]) <= cut:
                        f.write(repoint(json.dumps(r, ensure_ascii=False)) + "\n")

        return sealed_before, kept_history

    sealed_before, kept_history = None, []
    for t in targets:
        n_sealed, rows = freeze_run_dir(t, frozen_of[t])
        if t == run:
            sealed_before, kept_history = n_sealed, rows  # the replayed run's rows feed the prompt below

    # #1169: do not mint kit/pointer.md from stock attachments/ copies.

    notice = NOTICE.format(repo=os.path.basename(repo), head=head[:8], cut=cut_raw, num=num, records=f"{kit}/records.jsonl",
                           sources=f"{kit}/sources", runs=f"{kit}/run")
    # Prompt and schema come only from turn-delivery rows at or before the cut (#1161).
    # Missing material is a declared gap — never reconstructed.
    delivered_row = next((r for r in reversed(kept_history) if r.get("kind") == "turn-delivery"), None)
    delivered = (delivered_row or {}).get("payload") or None
    delivered_prompt = delivered.get("systemPrompt") if delivered else None
    gaps = []
    if isinstance(delivered_prompt, str):
        sys_kind = "turn-delivery"
        sysprompt = delivered_prompt.replace(records_src, f"{kit}/records.jsonl").replace(run, frozen_run)
    else:
        sys_kind = "missing-turn-delivery"
        sysprompt = ""
        gaps.append("systemPrompt")
    if delivered is None or delivered.get("outputSchema") is None:
        gaps.append("outputSchema")

    sh("git", "-C", repo, "worktree", "prune")
    sh("git", "-C", repo, "worktree", "add", "--detach", f"{kit}/wt", head)
    nm = f"{repo}/node_modules"
    if os.path.isdir(nm) and not os.path.exists(f"{kit}/wt/node_modules"):
        os.symlink(nm, f"{kit}/wt/node_modules")

    with open(f"{kit}/sys.txt", "w") as f:
        f.write(notice + sysprompt)

    if delivered is not None and delivered.get("outputSchema") is not None:
        with open(f"{kit}/schema.json", "w") as f:
            json.dump(delivered["outputSchema"], f, ensure_ascii=False, indent=2)
    # Official open: newline='' returns/writes line endings untranslated
    # (docs.python.org/3/library/functions.html#open). Match production utf-8.
    with open(f"{kit}/instr.txt", "w", encoding="utf-8", newline="") as f:
        # Prior instruction remapping only; caller file-flag paths pass through as admitted.
        f.write(project_admitted_instruction(
            {**adm, "instruction": repoint(adm.get("instruction") or "")},
            a.tool_dir,
        ))

    meta = {"runId": inv["runId"], "runDir": run, "role": role, "host": host, "provider": inv.get("provider"),
            "model": inv.get("model"), "thinking": inv.get("thinking"), "ticket": num, "repoSlug": slug, "repo": repo,
            "project": project, "cut": cut_raw, "cutSource": cut_src, "head": head, "sysKind": sys_kind,
            "issueBodyAt": issue["updatedAt"], "recordsKept": len(kept), "recordsSource": records_src, "frozenSources": sorted(frozen_sources), "frozenRun": frozen_run, "payloadsKept": sealed_before,
            "frozenAt": datetime.now(timezone.utc).isoformat()}
    if gaps:
        meta["gaps"] = gaps
    with open(f"{kit}/meta.json", "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    print(f"kit: {kit}")
    for k in ("role", "host", "model", "thinking", "ticket", "cut", "cutSource", "head", "sysKind", "issueBodyAt", "recordsKept"):
        print(f"  {k}: {meta[k]}")
    if gaps:
        print(f"GAP: missing turn-delivery material before cut: {', '.join(gaps)}; not reconstructed — pass --sys for an experimental prompt")
    if warn:
        print(f"WARNING: {warn}")
    print("next: replay-run.sh run <kit> <arm> <n> [--sys edited-copy-of-sys.txt]")
if __name__ == "__main__":
    main()
