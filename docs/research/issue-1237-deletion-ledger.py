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

# current same-file texts for 仍在
current_files: dict[str, str] = {}
for p in (ROOT / "test").rglob("*.ts"):
    rel = str(p.relative_to(ROOT))
    current_files[rel] = p.read_text(errors="replace")

def still_in_same_file(path: str, body: str) -> str | None:
    text = current_files.get(path)
    if not text:
        return None
    key = re.sub(r"\s+", " ", body).strip()
    if len(key) < 12:
        return None
    lines = text.splitlines()
    norm_lines = [re.sub(r"\s+", " ", ln).strip() for ln in lines]
    # single-line
    for i, ln in enumerate(norm_lines, 1):
        if key == ln or key in ln:
            return f"{path}:{i}"
    # multi-line collapsed window
    if " " in key and len(key) > 40:
        blob = " ".join(norm_lines)
        if key in blob:
            # find start line
            acc = ""
            for i, ln in enumerate(norm_lines, 1):
                acc = (acc + " " + ln).strip()
                if key in acc:
                    return f"{path}:{max(1, i - key.count(' '))}"
                if len(acc) > len(key) + 200:
                    acc = acc[-len(key):]
    return None

# sweep table: path -> (line, category)
sweep = (ROOT / "docs/research/issue-1237-test-quality-sweep.md").read_text()
sweep_rows: dict[str, tuple[int, str]] = {}
for i, ln in enumerate(sweep.splitlines(), 1):
    m = re.match(r"\| `(test/[^`]+)` \| ([^|]+) \|", ln)
    if m:
        sweep_rows[m.group(1)] = (i, m.group(2).strip())

# src blob for S name check
src_blob = ""
for folder in ("src", "extensions", "scripts", "souls"):
    base = ROOT / folder
    if not base.exists():
        continue
    for p in base.rglob("*"):
        if p.suffix in {".ts", ".md", ".mjs", ".js"} and p.is_file():
            src_blob += "\n" + p.read_text(errors="replace")

ABSENCE_RE = re.compile(
    r"""(?:['"]([A-Za-z0-9_.:/-]{4,})['"]\s+in\b|notEqual\([^,]+,\s*['"]([A-Za-z0-9_.:/-]{4,})['"]|hasOwn\([^,]+,\s*['"]([A-Za-z0-9_.:/-]{4,})['"]|\.([A-Za-z_][A-Za-z0-9_]{3,})\s*===\s*undefined)"""
)

def absence_name(body: str) -> str | None:
    m = ABSENCE_RE.search(body)
    if not m:
        return None
    return next(g for g in m.groups() if g)

COMMON = {
    "status", "result", "stdout", "stderr", "payload", "payloads", "kind", "role",
    "cause", "terminal", "diagnostic", "name", "code", "path", "type", "mode",
    "phase", "error", "message", "length", "value", "input", "output", "data",
}

def is_chunk(body: str) -> bool:
    return bool(re.search(r"(stdout|stderr)\.length\s*(===|==|!==|!=)\s*\d", body)) or bool(
        re.search(r"""split\(\s*['"]\\n['"]\s*\)\.length\s*(===|==)\s*\d""", body)
    )

def is_mirror_shape(body: str) -> bool:
    if re.search(r"\.(keys|flags|handlers)\(\)", body) and "deepEqual" in body:
        return True
    if re.search(r"Schema\s*===|===.*Schema", body):
        return True
    if "readFileSync" in body and ".includes(" in body and ".ts" in body:
        return True
    if re.search(r"Object\.keys\(", body) and "deepEqual" in body:
        return True
    return False

def cite(path: str) -> str:
    row = sweep_rows.get(path)
    if not row:
        return "无逐文件表行"
    return f"docs/research/issue-1237-test-quality-sweep.md:{row[0]} 类别 {row[1]}"

FIXED_STDERR = (
    "改好 test/integration/public-cli-failure-real-entry.test.ts:296；"
    "变异：隔离副本 /tmp/r10a-mut 将 presentFailureTerminal 的 hostStderr 附带改为 false；"
    "HEAD 红 production knownFailure channel reaches settlement as provider with typed identity"
)
FIXED_SYNTH = (
    "改好 test/contract/analyst-413-r2-findings.test.ts:205（basename 非合成）与 :211（root:<absolute> 为合成）；"
    "变异：隔离副本 isSyntheticAnalystBookKey 改 return true，以及改 return false；"
    "HEAD 均红 U3: real book basename root:foo keeps its book scope through cohort cache-miss recompute"
)
NULL_NOTARY = "null（公开入口只写已校验正整数，产不出非法旗；仓内无现成扩展激活案能把非法值送进 readNotaryTicketFlag）"

items: list[tuple[str, str, str, str]] = []  # kind, where, excerpt, disposition

for path in deleted_files:
    items.append(("file", path, "(deleted file)", ""))

changed = sorted(set(list(removed) + deleted_files))
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

def disposition(kind: str, where: str, body: str) -> str:
    path = where.split(":")[0]
    if "includes(hostStderr)" in body or "stderr[0]?.includes(hostStderr)" in body:
        return FIXED_STDERR
    if "isSyntheticAnalystBookKey" in body or "real basename root:foo is not" in body:
        return FIXED_SYNTH
    if "readNotaryTicketFlag" in body or "projectNotaryBoundFromFlags" in body or "ticket reader" in body or "invalid throws" in body:
        return NULL_NOTARY
    if kind == "assert":
        hit = still_in_same_file(path, body)
        if hit:
            return f"仍在 {hit}"
        if "assert.match" in body or "assert.doesNotMatch" in body or ".doesNotMatch(" in body:
            return f"T 文案锁；依据 souls/quality-law.md:32；{cite(path)}；不引承接"
        if is_chunk(body):
            return f"C 分块计数；依据 souls/quality-law.md:32 数条数；{cite(path)}；不引承接"
        name = absence_name(body)
        if name and name not in COMMON and name not in src_blob:
            return f"S 失效名缺席；名字 {name} 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接"
        if is_mirror_shape(body):
            return f"M 镜像形状；依据 souls/quality-law.md 锚定（机器只咬契约）；{cite(path)}；不引承接"
    # whole deleted file already adjudicated: cite category, withdraw successor
    row = sweep_rows.get(path)
    if kind == "file" and not row:
        return "null（夹具文件，逐文件表无此行，无断言承接）"
    if kind == "file" and row:
        return f"整文件删除；依据 {cite(path)}；该行承接路径本账不采用，承接 null"
    if kind == "case" and "with the file path" in body:
        return "案名改写后仍在 test/contract/analyst-413-r2-findings.test.ts:36；不是整案删除"
    if kind == "case" and path in deleted_files and row and "readNotaryTicketFlag" not in body and "ticket reader" not in body:
        # notary flag case already returned
        if path == "test/contract/notary-role.test.ts" and ("ticket" in body or "Flag" in body or "bound" in body.lower()):
            return NULL_NOTARY
        return f"整文件内整案；依据 {cite(path)}；承接 null"
    if kind == "assert" and path in deleted_files and row:
        if path == "test/contract/notary-role.test.ts" and ("ticket" in body or "Flag" in body or "Notary" in body and "throws" in body):
            return NULL_NOTARY
        return f"整文件内断言；依据 {cite(path)}；承接 null"
    return "null"

out_rows = []
for kind, where, excerpt, body in items:
    disp = disposition(kind, where, body if kind != "file" else excerpt)
    # file items passed excerpt as body via ""
    if kind == "file":
        disp = disposition(kind, where, "")
    excerpt_flat = excerpt.replace("|", "/").replace("\t", " ")
    disp_flat = disp.replace("|", "/").replace("\t", " ")
    out_rows.append((kind, where, excerpt_flat, disp_flat))

print(f"COUNT {len(out_rows)}")
from collections import Counter
c = Counter()
for _, _, _, d in out_rows:
    key = d.split("；")[0][:24]
    c[key] += 1
for k, v in c.most_common():
    print(f"BUCKET {v} {k}")

print("files", sum(1 for k, *_ in out_rows if k == "file"))
print("cases", sum(1 for k, *_ in out_rows if k == "case"))
print("asserts", sum(1 for k, *_ in out_rows if k == "assert"))

md = ROOT / "docs/research/issue-1237-deletion-ledger.md"
if md.exists():
    import re as _re
    wheres = []
    for line in md.read_text().splitlines():
        m = _re.match(r"\| \d+ \| \w+ \| `([^`]+)` \|", line)
        if m:
            wheres.append(m.group(1))
    got = [w for _, w, _, _ in out_rows]
    if wheres != got:
        print("MISMATCH ledger", len(wheres), "script", len(got))
        raise SystemExit(1)
    print("MATCH", len(wheres))
