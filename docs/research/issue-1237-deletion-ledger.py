#!/usr/bin/env python3
"""Mechanical ledger of deleted/weakened test assertions, cases, and files.

Count command (repo root):
  python3 docs/research/issue-1237-deletion-ledger.py
Prints COUNT and checks the ledger where-column.
"""
import re
import subprocess
from pathlib import Path

ROOT = Path.cwd()
BASE = "7997ffb2"

def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True, errors="replace")

deleted_files = [p for p in git("diff", "--diff-filter=D", "--name-only", BASE, "HEAD", "--", "test").split() if p]

diff = git("diff", "-U0", BASE, "HEAD", "--", "test")

# removed lines: file -> set of 1-based baseline line numbers
removed: dict[str, set[int]] = {}
file = None
old = None
for line in diff.splitlines():
    if line.startswith("diff --git"):
        m = re.search(r"b/(test/\S+)", line)
        file = m.group(1) if m else None
        old = None
        continue
    if line.startswith("@@"):
        m = re.search(r"@@ -(\d+)", line)
        old = int(m.group(1)) if m else None
        continue
    if file is None or old is None:
        continue
    if line.startswith("-") and not line.startswith("---"):
        removed.setdefault(file, set()).add(old)
        old += 1
    elif line.startswith("+") and not line.startswith("+++"):
        pass
    elif line.startswith("\\"):
        pass
    else:
        old += 1

def show(path: str) -> list[str]:
    try:
        return git("show", f"{BASE}:{path}").splitlines()
    except subprocess.CalledProcessError:
        return []

def paren_delta(s: str) -> int:
    # ignore parens inside strings roughly
    depth = 0
    quote = None
    esc = False
    for ch in s:
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
    return depth

def is_assert_start(s: str) -> bool:
    t = s.lstrip()
    return t.startswith("assert.") or t.startswith("assert(") or t.startswith("await assert.") or t.startswith("await assert(")

def assert_spans(lines: list[str]) -> list[tuple[int, int, str]]:
    """1-based inclusive start, exclusive end line, normalized body."""
    spans = []
    i = 0
    n = len(lines)
    while i < n:
        if is_assert_start(lines[i]):
            depth = paren_delta(lines[i])
            start = i
            i += 1
            while i < n and depth > 0:
                depth += paren_delta(lines[i])
                i += 1
            body = " ".join(lines[j].strip() for j in range(start, i))
            body = re.sub(r"\s+", " ", body)
            spans.append((start + 1, i + 1, body))
        else:
            i += 1
    return spans

TEST_RE = re.compile(r"""^\s*(?:test|it)(?:\.\w+)?\(\s*(['"`])(.*?)\1""")
TEST_START = re.compile(r"^\s*(?:test|it)(?:\.\w+)?\(")


items: list[tuple[str, str, str, str]] = []  # kind, where, excerpt, disposition

for path in deleted_files:
    items.append(("file", path, "(deleted file)", ""))

for path in sorted(removed):
    lines = show(path)
    if not lines:
        continue
    gone = removed[path]
    spans = assert_spans(lines)
    covered = set()
    for start, end, body in spans:
        span_lines = set(range(start, end))
        if span_lines & gone:
            covered |= span_lines
            items.append(("assert", f"{path}:{start}", body[:180], body))
    # assert start lines removed but not captured (unbalanced) 
    for ln in sorted(gone):
        if ln in covered or ln < 1 or ln > len(lines):
            continue
        if is_assert_start(lines[ln - 1]):
            body = re.sub(r"\s+", " ", lines[ln - 1].strip())
            items.append(("assert", f"{path}:{ln}", body[:180], body))
    for ln in sorted(gone):
        if ln < 1 or ln > len(lines):
            continue
        text = lines[ln - 1]
        if not TEST_START.match(text):
            continue
        m = TEST_RE.match(text)
        name = m.group(2) if m else text.strip()[:80]
        items.append(("case", f"{path}:{ln}", name[:160], name))


print(f"COUNT {len(items)}")
print("files", sum(1 for k, *_ in items if k == "file"))
print("cases", sum(1 for k, *_ in items if k == "case"))
print("asserts", sum(1 for k, *_ in items if k == "assert"))

md = ROOT / "docs/research/issue-1237-deletion-ledger.md"
wheres = []
disps = []
for line in md.read_text().splitlines():
    if not line.startswith("| "):
        continue
    parts = [part.strip() for part in line.strip().strip("|").split("|")]
    if len(parts) < 5 or not parts[0].isdigit():
        continue
    wheres.append(parts[2].strip("`"))
    disps.append(parts[4])

got = [where for _, where, _, _ in items]
if wheres != got:
    print("MISMATCH ledger", len(wheres), "script", len(got))
    raise SystemExit(1)
print("MATCH", len(wheres))

from collections import Counter
counts = Counter()
bad = []
for disp in disps:
    if disp.startswith("null") or "不采用" in disp or "未逐条" in disp:
        bad.append(disp[:80])
    if disp.startswith("c/null"):
        counts["c/null"] += 1
    elif disp.startswith("a/"):
        counts[disp.split("；", 1)[0]] += 1
    elif disp.startswith("b"):
        counts["b"] += 1
    elif disp.startswith("改好"):
        counts["改好"] += 1
    elif disp.startswith("仍在"):
        counts["仍在"] += 1
    else:
        bad.append(disp[:80])
if bad:
    print("BAD_DISPOSITION", len(bad))
    for item in bad[:8]:
        print(item)
    raise SystemExit(1)
for key, value in counts.most_common():
    print(f"BUCKET {value} {key}")
