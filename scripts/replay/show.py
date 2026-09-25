#!/usr/bin/env python3
"""Print each leg's verdict side by side: show.py <kit> [<arm>]."""
import glob, json, os, sys

def codex_leg(path):
    last, cmds, usage = None, [], None
    for line in open(path):
        try: r = json.loads(line)
        except json.JSONDecodeError: continue
        it = r.get("item", {})
        if it.get("type") == "command_execution": cmds.append(it.get("command", ""))
        if it.get("type") == "agent_message": last = it.get("text")
        if r.get("type") == "turn.completed": usage = r.get("usage")
    return last, cmds, usage

def main():
    kit = os.path.abspath(sys.argv[1]); arm = sys.argv[2] if len(sys.argv) > 2 else "*"
    meta = json.load(open(f"{kit}/meta.json")); num = str(meta["ticket"])
    files = sorted(glob.glob(f"{kit}/out-{arm}-*.jsonl") + glob.glob(f"{kit}/out-{arm}-*.txt"))
    if not files: sys.exit(f"no legs for arm {arm} in {kit}")
    for f in files:
        name = os.path.basename(f)
        if f.endswith(".jsonl"):
            last, cmds, usage = codex_leg(f)
            views = sum(f"issue view {num}" in c for c in cmds)
            print(f"##### {name}  commands={len(cmds)} frozen-issue-views={views} tokens={usage and usage.get('input_tokens')}")
        else:
            last = open(f).read().strip()
            print(f"##### {name}  (pi, {len(last)} chars)")
        try:
            p = json.loads(last)
            keys = [k for k in ("status", "countersignStatus", "secretariatStatus", "findings", "reason", "fix", "note") if k in p]
            print(json.dumps({k: p[k] for k in keys}, ensure_ascii=False, indent=1)[:2500])
        except (TypeError, ValueError):
            print((last or "")[-4000:])
        print()

if __name__ == "__main__":
    main()
