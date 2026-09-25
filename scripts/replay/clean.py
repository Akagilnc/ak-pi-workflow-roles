#!/usr/bin/env python3
"""Remove a kit and every worktree it registered: clean.py <kit>."""
import glob, json, os, shutil, subprocess, sys

kit = os.path.abspath(sys.argv[1])
repo = json.load(open(f"{kit}/meta.json"))["repo"] if os.path.exists(f"{kit}/meta.json") else None
for wt in [f"{kit}/wt", *glob.glob(f"{kit}/wt-*")]:
    if repo and os.path.isdir(wt):
        subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", wt], capture_output=True)
shutil.rmtree(kit, ignore_errors=True)
if repo:
    subprocess.run(["git", "-C", repo, "worktree", "prune"], capture_output=True)
print(f"removed {kit}")
