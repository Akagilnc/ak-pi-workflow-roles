#!/usr/bin/env python3
"""Caller-side read-only view of one ledger run: run-show.py <run-dir> [--payload-chars N]

Prints the last verdict payload, accepted submissions, host session id, compaction count and
token usage that this run's own files (current.json, history.jsonl, log.jsonl, the host
original) carry. Missing
material prints as unavailable. Never writes. Not part of the public CLI.
"""
import glob, json, os, sys

def read_jsonl(path):
    """Open and parse jsonl. OSError (incl. EACCES) propagates; JSONDecodeError → {_damaged}."""
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                rows.append({"_damaged": line[:80]})
    return rows

def jsonl(path):
    """Absent path → []. Other IO errors propagate (no exists pre-check washing EACCES)."""
    try:
        return read_jsonl(path)
    except FileNotFoundError:
        return []

def topology_original(run, host):
    """Fixed landing from docs/dossier-topology.md / ADR 0086 — one path per host."""
    if host == "pi":
        return f"{run}/session/session.jsonl"
    if host == "grok-build":
        return f"{run}/session/grok-build"
    if host in ("codex", "claude"):
        return f"{run}/session/{host}.jsonl"
    return None

def resolve_original(run, host, cur):
    """The run's one host original — binding success is not a gate (#1161 R1).

    Topology landing for the *current* host wins when it exists. current.host.original
    is the last successful native-session-copy pointer and may lag after a lawful
    host switch when log.jsonl could not record the new landing — never prefer that
    stale pointer over the fixed host path that is already on disk.
    """
    topo = topology_original(run, host)
    if topo is not None:
        present = os.path.isdir(topo) if host == "grok-build" else os.path.isfile(topo)
        if present:
            return topo
    pointed = ((cur.get("host") or {}).get("original"))
    if isinstance(pointed, str) and pointed.strip():
        return pointed
    return topo

def print_codex_stats(rows, where):
    compacted = sum(1 for r in rows if r.get("type") == "compacted")
    usage = None
    for r in rows:
        p = r.get("payload") or {}
        if r.get("type") == "event_msg" and p.get("type") == "token_count" and isinstance(p.get("info"), dict):
            usage = p["info"]
    print(f"compaction count: {compacted} ({where})")
    if usage:
        t, l = usage.get("total_token_usage", {}), usage.get("last_token_usage", {})
        print(f"token usage: total={t.get('total_tokens')} (input {t.get('input_tokens')}, cached {t.get('cached_input_tokens')}, output {t.get('output_tokens')}); last turn={l.get('total_tokens')}; context window={usage.get('model_context_window')}")
    else:
        print("token usage: unavailable (no token_count event in rollout)")

def print_pi_stats(sess_rows, where):
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
    print(f"compaction count: {comp} ({where})")
    print(f"token usage: {json.dumps(tot, ensure_ascii=False)} summed over {n} assistant messages" if n else "token usage: unavailable (no assistant usage in session volume)")

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

    # 1. last verdict payload — terminal's attemptHistoryIdentity, not last sealed
    sealed = [r for r in history if r.get("kind") == "sealed"]
    attempts = [r for r in history if r.get("kind") == "attempt-history"]
    print(f"sealed rows: {len(sealed)}  attempts: {len(attempts)}")
    terminal = cur.get("terminal") or {}
    body = terminal.get("body") if isinstance(terminal.get("body"), dict) else {}
    identity = body.get("attemptHistoryIdentity") if isinstance(body, dict) else None
    payloads = None
    if isinstance(identity, str) and identity.strip():
        for r in attempts:
            if r.get("identity") != identity:
                continue
            outcome = (r.get("payload") or {}).get("outcome") or {}
            if isinstance(outcome, dict) and isinstance(outcome.get("payloads"), list):
                payloads = outcome["payloads"]
            break
    if isinstance(payloads, list) and payloads:
        print("last payload:", json.dumps(payloads[-1], ensure_ascii=False)[:limit])
    elif isinstance(identity, str) and identity.strip():
        print(f"last payload: unavailable (attemptHistoryIdentity {identity!r} has no readable payloads)")
    else:
        print("last payload: unavailable (terminal has no attemptHistoryIdentity)")
    if terminal:
        print(f"terminal: {terminal.get('face')} at {terminal.get('at')}")

    # 2. sealed rows (independent of current terminal)
    damaged = [r for r in history if "_damaged" in r]
    print("status of each sealed row:" + (f"  (damaged lines: {len(damaged)})" if damaged else ""))
    for r in sealed:
        acc = (r.get("payload") or {}).get("accepted") or {}
        status = acc.get("status") or acc.get("countersignStatus") or acc.get("secretariatStatus") if isinstance(acc, dict) else None
        print(f"  {r.get('timestamp')}  {status}")

    # 3–5. host session id + compaction/token from this host's original (one read).
    # Never borrow package session.jsonl for a non-pi host (#1161 R1).
    # Hosts without an existing reader stay unavailable — no new parsers.
    host = inv.get("host")
    original = resolve_original(run, host, cur)
    ids = []
    sid = ((cur.get("host") or {}).get("sessions") or {}).get(host)
    if isinstance(sid, str) and sid.strip():
        ids.append(("current.json host", sid))

    host_rows = None  # None = absent / no reader; list = opened once (may be empty)
    if isinstance(original, str) and host in ("codex", "pi"):
        try:
            host_rows = read_jsonl(original)
        except FileNotFoundError:
            host_rows = None
        if host_rows is not None and not ids:
            if host == "codex":
                for r in host_rows:
                    if r.get("type") != "session_meta":
                        continue
                    meta_id = (r.get("payload") or {}).get("id")
                    if isinstance(meta_id, str) and meta_id.strip():
                        ids.append(("codex original session_meta", meta_id))
                        break
            elif host == "pi" and host_rows and host_rows[0].get("type") == "session":
                ids.append(("pi session header", host_rows[0].get("id")))
    print("host session id:", ", ".join(f"{v} ({k})" for k, v in ids) if ids else "unavailable")

    if host == "codex":
        if host_rows is not None:
            print_codex_stats(host_rows, original)
        else:
            home = os.path.join(os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex"), "sessions")
            codex_ids = [v for k, v in ids]
            cands = [p for p in glob.glob(f"{home}/**/*.jsonl", recursive=True) if any(i in os.path.basename(p) for i in codex_ids)] if codex_ids else []
            if cands:
                rollout = max(cands, key=os.path.getmtime)
                print_codex_stats(read_jsonl(rollout), rollout)
            else:
                print(f"compaction count: unavailable (no codex original in the run; no rollout for {codex_ids or '∅'} under {home})")
                print("token usage: unavailable (no rollout)")
    elif host == "pi":
        if host_rows is not None:
            print_pi_stats(host_rows, original or "pi session volume")
        else:
            print("compaction count: unavailable\ntoken usage: unavailable")
    elif host in ("claude", "grok-build"):
        where = original if isinstance(original, str) else "no host original in the run"
        print(f"compaction count: unavailable ({host} original not parsed by this script; {where})")
        print(f"token usage: unavailable ({host} original not parsed by this script; {where})")
    else:
        print(f"compaction count: unavailable (host {host!r} not parsed by this script)")
        print(f"token usage: unavailable (host {host!r} not parsed by this script)")

if __name__ == "__main__":
    main()
