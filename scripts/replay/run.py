#!/usr/bin/env python3
"""Run one replay leg from a kit made by freeze.py, in its own detached worktree.
Output: <kit>/out-<arm>-<n>.{jsonl,txt}, worktree <kit>/wt-<arm>-<n>."""
import argparse, json, os, shutil, subprocess, sys

def sh(*cmd, cwd=None):
    p = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    if p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{p.stderr}")
    return p.stdout

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kit"); ap.add_argument("arm"); ap.add_argument("n")
    ap.add_argument("--sys", help="system prompt file to use instead of <kit>/sys.txt (edit a copy for the treatment arm)")
    ap.add_argument("--instr", help="instruction text instead of <kit>/instr.txt")
    ap.add_argument("--effort", help="codex reasoning effort (default: run's thinking)")
    ap.add_argument("--model", help="model id (default: run's model)")
    ap.add_argument("--thinking", help="pi thinking level (default: run's thinking)")
    ap.add_argument("--host", choices=["codex", "pi"], help="override host (default: run's host)")
    ap.add_argument("--allow-issue-writes", action="store_true", help="let `gh issue create/edit` land in a per-leg store (secretariat replays)")
    a = ap.parse_args()

    kit = os.path.abspath(a.kit)
    meta = json.load(open(f"{kit}/meta.json"))
    host = a.host or meta["host"]
    sysfile = os.path.abspath(a.sys) if a.sys else f"{kit}/sys.txt"
    instr = a.instr if a.instr is not None else open(f"{kit}/instr.txt").read().strip()
    tag = f"{a.arm}-{a.n}"
    if host == "codex" and meta["sysKind"] != "headless-system-prompt" and not a.sys:
        sys.exit("this run was a pi-host run; its sys.txt is only the appended tail. Pass --host pi or a full --sys.")
    wt = f"{kit}/wt-{tag}"
    if os.path.exists(wt):
        sys.exit(f"leg worktree exists: {wt} (pick another n, or replay-run.sh clean <kit>)")
    sh("git", "-C", meta["repo"], "worktree", "add", "--detach", wt, meta["head"])
    nm = f"{meta['repo']}/node_modules"
    if os.path.isdir(nm):
        os.symlink(nm, f"{wt}/node_modules")

    env = dict(os.environ)
    env.update({"ZDOTDIR": f"{kit}/zdot", "AK_SHIM_BIN": f"{kit}/bin", "PATH": f"{kit}/bin:{env.get('PATH','')}",
                "AK_FROZEN_ISSUE": f"{kit}/issue.json", "AK_ISSUE_NUM": str(meta["ticket"])})
    env.pop("AK_ISSUE_STORE", None)
    if a.allow_issue_writes:
        store = f"{kit}/issue-store-{tag}.json"
        shutil.copy(f"{kit}/issue.json", store)
        env["AK_ISSUE_STORE"] = store

    if host == "codex":
        sandbox = ["--sandbox", "read-only"]
        if a.allow_issue_writes:
            # the shim must write the per-leg store; nothing else becomes writable
            sandbox = ["--sandbox", "workspace-write", "-c", f'sandbox_workspace_write.writable_roots=["{kit}"]']
        cmd = ["codex", "exec", "--json", *sandbox, "-m", a.model or meta["model"],
               "-c", f"model_reasoning_effort={a.effort or meta.get('thinking') or 'medium'}",
               "-c", f'model_instructions_file="{sysfile}"']
        if os.path.exists(f"{kit}/schema.json"):
            cmd += ["--output-schema", f"{kit}/schema.json"]
        cmd.append(instr or "审。")
        out = f"{kit}/out-{tag}.jsonl"
    else:
        sess = f"{kit}/pisess-{tag}"
        shutil.rmtree(sess, ignore_errors=True); os.makedirs(sess)
        model = f"{meta['provider']}/{a.model or meta['model']}"
        thinking = a.thinking or meta.get("thinking")
        if thinking:
            model += f":{thinking}"
        cmd = ["pi", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--session-dir", sess,
               "--model", model, "--append-system-prompt", sysfile, instr or "审。"]
        out = f"{kit}/out-{tag}.txt"
    err = f"{kit}/err-{tag}.txt"
    print(f"leg {tag}: host={host} cwd={wt}\n  {' '.join(cmd[:12])} ...\n  stdout -> {out}")
    with open(out, "w") as fo, open(err, "w") as fe, open(os.devnull) as fi:
        rc = subprocess.run(cmd, cwd=wt, env=env, stdin=fi, stdout=fo, stderr=fe).returncode
    with open(err, "a") as fe:
        fe.write(f"\nexit={rc}\n")
    print(f"leg {tag}: exit={rc}")
    return rc

if __name__ == "__main__":
    sys.exit(main())
