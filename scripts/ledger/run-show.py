#!/usr/bin/env python3
"""Caller-side read-only view of one ledger run: run-show.py <run-dir> [--payload-chars N]

Prints the last verdict payload, accepted submissions, host session id, compaction count and
token usage that this run's own files (current.json, history.jsonl, log.jsonl, the host
original) carry. Missing
material prints as unavailable. Never writes. Not part of the public CLI.
"""
import glob, json, os, sys

def jsonl(path):
    rows = []
    if not os.path.exists(path):
        return rows
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            rows.append({"_damaged": line[:80]})
    return rows

def main():
    argv = sys.argv[1:]
    limit = 1200
    if "--payload-chars" in argv:
        i = argv.index("--payload-chars")
        limit = int(argv[i + 1])
        del argv[i:i + 2]
    if len(argv) != 1:
        sys.exit(__doc__)
    args = argv
    run = os.path.abspath(args[0].rstrip("/"))
    cur_path = f"{run}/current.json"
    if not os.path.isfile(cur_path):
        sys.exit(f"not a run directory (no current.json): {run}")
    cur = json.load(open(cur_path))
    inv = cur.get("invocation") or {}
    print(f"run: {run}\nrole: {inv.get('role')}  host: {inv.get('host')}  model: {inv.get('provider')}/{inv.get('model')}:{inv.get('thinking')}  ticket: {inv.get('ticketNumber')}")
    history = jsonl(f"{run}/history.jsonl")
    subs = [r for r in history if r.get("type") == "submission"]
    resumes = [r for r in history if r.get("type") == "resume"]

    # 1. last verdict payload (the role's submitted words live on the history rows)
    print(f"submissions: {len(subs)}  resumes: {len(resumes)}")
    if subs:
        print("last payload:", json.dumps(subs[-1].get("params"), ensure_ascii=False)[:limit])
    else:
        print("last payload: unavailable (no submission rows in history.jsonl)")
    terminal = cur.get("terminal")
    if terminal:
        print(f"terminal: {terminal.get('face')} at {terminal.get('at')}")

    # 2. accepted rows
    accepted = [r for r in subs if r.get("disposition") == "accepted"]
    damaged = [r for r in history if "_damaged" in r]
    print(f"accepted rows: {len(accepted)}" + (f"  (damaged lines: {len(damaged)})" if damaged else ""))
    for r in accepted:
        acc = r.get("params") or {}
        status = acc.get("status") or acc.get("countersignStatus") or acc.get("secretariatStatus") if isinstance(acc, dict) else None
        print(f"  {r.get('at')}  {status}")

    # 3. host session id
    ids = []
    sid = ((cur.get("host") or {}).get("sessions") or {}).get(inv.get("host"))
    if isinstance(sid, str) and sid.strip():
        ids.append(("current.json host", sid))
    sess_rows = jsonl(f"{run}/session/session.jsonl")
    if not ids and sess_rows and sess_rows[0].get("type") == "session":
        ids.append(("pi session header", sess_rows[0].get("id")))
    print("host session id:", ", ".join(f"{v} ({k})" for k, v in ids) if ids else "unavailable")

    # 4 + 5. compaction count and token usage, by host family
    host = inv.get("host")
    codex_ids = [v for k, v in ids if k == "current.json host"] if host == "codex" else []
    if host not in ("codex", "claude", "pi"):
        print(f"compaction count: unavailable (host {host!r} not parsed by this script)")
        print(f"token usage: unavailable (host {host!r} not parsed by this script)")
    elif codex_ids:
        home = os.path.join(os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex"), "sessions")
        own = f"{run}/session/codex.jsonl"  # the run's one host original (copied at exit)
        cands = [own] if os.path.exists(own) else [p for p in glob.glob(f"{home}/**/*.jsonl", recursive=True) if any(i in os.path.basename(p) for i in codex_ids)]
        if cands:
            rollout = max(cands, key=os.path.getmtime)
            rows = jsonl(rollout)
            compacted = sum(1 for r in rows if r.get("type") == "compacted")
            usage = None
            for r in rows:
                p = r.get("payload") or {}
                if r.get("type") == "event_msg" and p.get("type") == "token_count" and isinstance(p.get("info"), dict):
                    usage = p["info"]
            print(f"compaction count: {compacted} ({rollout})")
            if usage:
                t, l = usage.get("total_token_usage", {}), usage.get("last_token_usage", {})
                print(f"token usage: total={t.get('total_tokens')} (input {t.get('input_tokens')}, cached {t.get('cached_input_tokens')}, output {t.get('output_tokens')}); last turn={l.get('total_tokens')}; context window={usage.get('model_context_window')}")
            else:
                print("token usage: unavailable (no token_count event in rollout)")
        else:
            print(f"compaction count: unavailable (no rollout for {codex_ids} under {home})")
            print("token usage: unavailable (no rollout)")
    elif host == "claude":
        original = f"{run}/session/claude.jsonl"
        where = original if os.path.exists(original) else "no host original in the run"
        print(f"compaction count: unavailable (claude original not parsed by this script; {where})")
        print(f"token usage: unavailable (claude original not parsed by this script; {where})")
    elif sess_rows:
        comp = sum(1 for r in sess_rows if r.get("type") == "compaction")
        tot = {}
        n = 0
        for r in sess_rows:
            m = r.get("message") or {}
            if r.get("type") == "message" and m.get("role") == "assistant" and isinstance(m.get("usage"), dict):
                n += 1
                for k, v in m["usage"].items():
                    if isinstance(v, (int, float)):
                        tot[k] = tot.get(k, 0) + v
        print(f"compaction count: {comp} (pi session volume)")
        print(f"token usage: {json.dumps(tot, ensure_ascii=False)} summed over {n} assistant messages" if n else "token usage: unavailable (no assistant usage in session volume)")
    else:
        print("compaction count: unavailable\ntoken usage: unavailable")

if __name__ == "__main__":
    main()
