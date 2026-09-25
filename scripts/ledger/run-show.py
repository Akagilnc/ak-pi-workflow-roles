#!/usr/bin/env python3
"""Caller-side read-only view of one ledger run: run-show.py <run-dir> [--payload-chars N]

Prints the last verdict payload, sealed rows, host session id, compaction count and token
usage that this run's own files (and the host's native session store) carry. Missing
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
    if not os.path.isfile(f"{run}/invocation.json"):
        sys.exit(f"not a run directory (no invocation.json): {run}")
    inv = json.load(open(f"{run}/invocation.json"))
    print(f"run: {run}\nrole: {inv.get('role')}  host: {inv.get('host')}  model: {inv.get('provider')}/{inv.get('model')}:{inv.get('thinking')}  ticket: {inv.get('ticketNumber')}")

    # 1. last verdict payload
    rep = f"{run}/artifacts/report.json"
    if os.path.exists(rep):
        payloads = json.load(open(rep)).get("outcome", {}).get("payloads") or []
        print(f"payloads: {len(payloads)}")
        if payloads:
            print("last payload:", json.dumps(payloads[-1], ensure_ascii=False)[:limit])
    else:
        print("last payload: unavailable (no artifacts/report.json)")

    # 2. sealed rows
    ledger = jsonl(f"{run}/session/submission-ledger/records.jsonl")
    own = lambda r: (r.get("subject") or {}).get("runId") in (None, inv.get("runId"))
    sealed = [r for r in ledger if r.get("kind") == "sealed" and own(r)]
    damaged = [r for r in ledger if "_damaged" in r]
    print(f"sealed rows: {len(sealed)}" + (f"  (damaged lines: {len(damaged)})" if damaged else ""))
    for r in sealed:
        acc = (r.get("payload") or {}).get("accepted") or r.get("accepted") or {}
        status = acc.get("status") or acc.get("countersignStatus") or acc.get("secretariatStatus") if isinstance(acc, dict) else None
        print(f"  {r.get('timestamp')}  {status}")

    # 3. host session ids
    ids = []
    for f in ("codex-headless-session.json", "claude-headless-session.json", "grok-acp-session.json", "hermes-acp-session.json"):
        p = f"{run}/session/{f}"
        if os.path.exists(p):
            try:
                sid = json.load(open(p)).get("sessionId")
            except json.JSONDecodeError:
                sid = None
            if isinstance(sid, str) and sid.strip():
                ids.append((f, sid))
            else:
                print(f"host session id: binding {f} is damaged or empty")
    host_rows = jsonl(f"{run}/session/host-session/records.jsonl")
    for r in host_rows:
        p = r.get("payload") or {}
        if p.get("type") == "thread.started" and isinstance(p.get("thread_id"), str) and p["thread_id"].strip():
            ids.append(("host-session thread.started", p["thread_id"]))
            break
    sess_rows = jsonl(f"{run}/session/session.jsonl")
    if not ids and sess_rows and sess_rows[0].get("type") == "session":
        ids.append(("pi session header", sess_rows[0].get("id")))
    print("host session id:", ", ".join(f"{v} ({k})" for k, v in ids) if ids else "unavailable")

    # 4 + 5. compaction count and token usage, by host family
    host = inv.get("host")
    codex_ids = [v for k, v in ids if k.startswith(("codex", "host-session"))]
    if host not in ("codex", "claude", "pi"):
        print(f"compaction count: unavailable (host {host!r} not parsed by this script)")
        print(f"token usage: unavailable (host {host!r} not parsed by this script)")
    elif codex_ids:
        home = os.path.join(os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex"), "sessions")
        cands = [p for p in glob.glob(f"{home}/**/*.jsonl", recursive=True) if any(i in os.path.basename(p) for i in codex_ids)]
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
    elif host == "claude" and host_rows:
        comp = sum(1 for r in host_rows if (r.get("payload") or {}).get("subtype") == "compact_boundary")
        usages = [(r.get("payload") or {}).get("usage") for r in host_rows if (r.get("payload") or {}).get("type") == "result" and (r.get("payload") or {}).get("usage")]
        print(f"compaction count: {comp} (host-session records)")
        print("token usage:", json.dumps(usages[-1], ensure_ascii=False) if usages else "unavailable (no result usage in host-session records)")
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
