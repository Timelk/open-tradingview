#!/usr/bin/env python3
"""Read-only, redacted source/history audit. Never reads .env* contents.

Findings contain only relative path, line number and rule. This is a targeted
pattern scan, not a certification that a repository is free of all secrets.
"""
from __future__ import annotations

import argparse
import base64
import collections
import json
import math
import os
import pathlib
import re
import subprocess
import sys

MAX_BYTES = 8 * 1024 * 1024
RULES = (
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("api-secret-prefix", re.compile(r"\bsk-(?:(?:proj|svcacct|ant-api\d+)-)?[A-Za-z0-9_-]{32,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{24,}\b")),
    ("npm-token", re.compile(r"\bnpm_[A-Za-z0-9]{36,}\b")),
    ("stripe-secret", re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b")),
    ("personal-absolute-path", re.compile(r"(?:/Users/[^/\s\"'<>\[\]{}^]+/|/home/[^/\s\"'<>\[\]{}^]+/|[A-Za-z]:[\\/]Users[\\/][^\\/\s\"'<>\[\]{}^]+[\\/])")),
)
PRIVATE_KEY = re.compile(
    r"-----BEGIN (?P<kind>(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY)-----"
    r"(?P<body>[\s\S]{40,}?)-----END (?P=kind)-----"
)
LITERAL = re.compile(
    r"(?i)(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|password|secret[_-]?key)"
    r"\s*[\"']?\s*[:=]\s*[\"'](?P<value>[^\"'\n]{20,})[\"']"
)
PLACEHOLDER = re.compile(r"(?i)(?:example|placeholder|your[_-]|replace[_-]|dummy|fake|changeme|<|\$\{|process\.env)")
TOKEN_RULES = {name for name, _ in RULES if name != "personal-absolute-path"}


def git(root: pathlib.Path, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", str(root), *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise RuntimeError("git-command-failed")
    return result.stdout


def env_path(path: str) -> bool:
    return any(part == ".env" or part.startswith(".env.") for part in pathlib.PurePosixPath(path).parts)


def fixture_value(value: str) -> bool:
    if PLACEHOLDER.search(value):
        return True
    payload = value.split("-", 1)[-1].split("_", 1)[-1]
    return len(set(payload)) <= 4


def entropy(value: str) -> float:
    counts = collections.Counter(value)
    return -sum((n / len(value)) * math.log2(n / len(value)) for n in counts.values())


def scan_text(path: str, text: str) -> tuple[list[dict], int]:
    findings: set[tuple[int, str]] = set()
    suppressed = 0
    for rule, pattern in RULES:
        for match in pattern.finditer(text):
            if rule in TOKEN_RULES and fixture_value(match.group()):
                suppressed += 1
                continue
            findings.add((text.count("\n", 0, match.start()) + 1, rule))
    for match in PRIVATE_KEY.finditer(text):
        raw = re.sub(r"\s+", "", match.group("body").replace("\\n", "\n").replace("\\r", "\r"))
        try:
            decoded = base64.b64decode(raw, validate=True)
        except (ValueError, base64.binascii.Error):
            suppressed += 1
            continue
        # PEM ASN.1 sequences and OpenSSH payloads have recognizable headers.
        if len(decoded) < 32 or not (decoded.startswith(b"\x30") or decoded.startswith(b"openssh-key-v1\x00")):
            suppressed += 1
            continue
        findings.add((text.count("\n", 0, match.start()) + 1, "private-key-block"))
    for match in LITERAL.finditer(text):
        value = match.group("value")
        if fixture_value(value) or entropy(value) < 3.8 or re.search(r"\s|://|/|\\", value):
            suppressed += 1
            continue
        # A candidate requires review; field name/entropy alone prove no secret.
        findings.add((text.count("\n", 0, match.start()) + 1, "credential-literal-review"))
    return [{"path": path, "line": line, "rule": rule} for line, rule in sorted(findings)], suppressed


def decode(data: bytes) -> str | None:
    if b"\x00" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def collect_worktree(root: pathlib.Path, include_dev: bool, filesystem: bool) -> list[str]:
    if filesystem:
        # Candidate snapshots need no Git initialization. No global/host files
        # are accessed; .env names are still filtered before every content read.
        paths = set()
        ignored = {".git", "node_modules", "dist", ".data", ".pnpm-store", "coverage", "__pycache__"}
        for directory, names, files in os.walk(root, followlinks=False):
            names[:] = [name for name in names if name not in ignored and not (pathlib.Path(directory) / name).is_symlink()]
            paths.update(str((pathlib.Path(directory) / name).relative_to(root)) for name in files)
    else:
        data = git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
        paths = {p.decode("utf-8", "replace") for p in data.split(b"\0") if p}
    if include_dev:
        for name in (".omc", ".claude", ".mcp.json", ".playwright-mcp"):
            target = root / name
            if target.is_file():
                paths.add(name)
            elif target.is_dir() and not target.is_symlink():
                paths.update(str(p.relative_to(root)) for p in target.rglob("*") if p.is_file() and not p.is_symlink())
    return sorted(paths)


def scan_worktree(root: pathlib.Path, include_dev: bool, filesystem: bool, summary: dict) -> list[dict]:
    findings = []
    for name in collect_worktree(root, include_dev, filesystem):
        path = root / name
        if env_path(name):
            summary["env_content_skipped"] += 1
            continue
        if path.is_symlink():
            findings.append({"path": name, "line": 0, "rule": "symlink-review"})
            continue
        if not path.is_file():
            summary["missing_worktree_files"] += 1
            continue
        if path.stat().st_size > MAX_BYTES:
            summary["oversize_files_skipped"] += 1
            continue
        text = decode(path.read_bytes())
        if text is None:
            summary["binary_files_skipped"] += 1
            continue
        summary["worktree_text_files_scanned"] += 1
        matches, suppressed = scan_text(name, text)
        findings.extend(matches)
        summary["placeholder_or_low_entropy_matches_suppressed"] += suppressed
    return findings


def scan_history(root: pathlib.Path, summary: dict) -> list[dict]:
    commits = git(root, "rev-list", "--all").decode().splitlines()
    summary["reachable_commits"] = len(commits)
    # Map every path from every reachable tree, including renamed/reused blobs.
    blobs: dict[str, set[str]] = collections.defaultdict(set)
    for commit in commits:
        for item in git(root, "ls-tree", "-r", "-z", commit).split(b"\0"):
            if not item:
                continue
            meta, path = item.split(b"\t", 1)
            _mode, kind, oid = meta.decode().split()
            if kind == "blob":
                blobs[oid].add(path.decode("utf-8", "replace"))
    findings = []
    summary["unique_reachable_blobs"] = len(blobs)
    # cat-file sizes are checked before retrieving contents.
    request = "\n".join(blobs) + "\n"
    sizes = subprocess.run(["git", "-C", str(root), "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], input=request.encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True).stdout.decode().splitlines()
    for row in sizes:
        oid, kind, length = row.split()
        names = blobs[oid]
        # If any alias is .env*, skip the blob entirely; never inspect env data.
        if any(env_path(name) for name in names):
            summary["history_env_blobs_skipped"] += 1
            continue
        if kind != "blob" or int(length) > MAX_BYTES:
            summary["history_oversize_blobs_skipped"] += 1
            continue
        text = decode(git(root, "cat-file", "blob", oid))
        if text is None:
            summary["history_binary_blobs_skipped"] += 1
            continue
        summary["history_text_blobs_scanned"] += 1
        for name in sorted(names):
            matches, suppressed = scan_text("history/" + name, text)
            findings.extend(matches)
            summary["placeholder_or_low_entropy_matches_suppressed"] += suppressed
    for commit in commits:
        # Commit contents stay in memory. No message, name, or email is emitted.
        message = git(root, "show", "-s", "--format=%B", commit).decode("utf-8", "replace")
        matches, suppressed = scan_text("history/commit-message", message)
        findings.extend(matches)
        summary["placeholder_or_low_entropy_matches_suppressed"] += suppressed
        identities = git(root, "show", "-s", "--format=%ae%n%ce", commit).decode("utf-8", "replace").splitlines()
        if any("@" in value and "noreply" not in value.casefold() for value in identities):
            summary["commits_with_non_noreply_email_identity"] += 1
    return findings


def env_inventory(root: pathlib.Path, filesystem: bool) -> list[dict]:
    names = {".env", ".env.local", ".env.openrouter.local", ".env.example"}
    names.update(p.name for p in root.glob(".env*") if p.is_file())
    tracked = set() if filesystem else {item.decode("utf-8", "replace") for item in git(root, "ls-files", "-z").split(b"\0") if item}
    return [{"path": name, "exists": (root / name).exists(), "ignored": None if filesystem else subprocess.run(["git", "-C", str(root), "check-ignore", "--no-index", "-q", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, "tracked": None if filesystem else name in tracked} for name in sorted(names)]


def self_test() -> None:
    # Synthetic strings exist only in memory; no credential examples are saved
    # to disk or included in stdout. Assertions also test placeholder handling.
    import random
    rng = random.Random(20261001)
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    payload = "".join(rng.choice(alphabet) for _ in range(70))
    examples = [
        ("github-token", "ghp_" + payload[:36]),
        ("github-token", "github_pat_" + payload),
        ("api-secret-prefix", "sk-proj-" + payload),
        ("api-secret-prefix", "sk-ant-api03-" + payload),
        ("aws-access-key", "AKIA" + "Q7W8E9R0T1Y2U3I4"),
        ("google-api-key", "AIza" + payload[:35]),
        ("npm-token", "npm_" + payload[:36]),
        ("stripe-secret", "sk_live_" + payload[:32]),
        ("slack-token", "xoxb-" + payload[:32]),
        ("credential-literal-review", 'apiSecret="' + payload + '"'),
        ("personal-absolute-path", "/Users/" + "synthetic-person/project"),
    ]
    for expected, value in examples:
        rows, _ = scan_text("self-test", value)
        assert any(row["rule"] == expected for row in rows)
        assert all(set(row) == {"path", "line", "rule"} for row in rows)
    for value in ("sk-" + "a" * 48, "AKIAIOSFODNN7EXAMPLE", 'apiSecret="replace_with_your_secret"'):
        rows, _ = scan_text("self-test", value)
        assert not rows
    # A synthetically seeded, structurally valid PKCS#8 Ed25519 key tests the
    # short-key case. Its seed/armor are never written or printed.
    der = bytes.fromhex("302e020100300506032b657004220420") + bytes(rng.randrange(256) for _ in range(32))
    armor = "-----BEGIN PRIVATE KEY-----\n" + base64.b64encode(der).decode() + "\n-----END PRIVATE KEY-----"
    for value in (armor, armor.replace("\n", "\\n")):
        rows, _ = scan_text("self-test", value)
        assert any(row["rule"] == "private-key-block" for row in rows)
    assert env_path("nested/.env.local") and env_path(".env.example")
    assert not env_path("src/environment.ts")
    assert decode(b"\x00\x01") is None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument("--history", action="store_true", help="Scan all reachable Git trees and commit messages; never .env* blobs.")
    parser.add_argument("--include-dev-state", action="store_true", help="Also inspect .omc, .claude, .mcp.json and .playwright-mcp even if ignored.")
    parser.add_argument("--filesystem", action="store_true", help="Scan a candidate source directory without requiring Git; skips .git/dependencies/runtime data.")
    parser.add_argument("--self-test", action="store_true", help="Run redaction, detection, and placeholder checks using in-memory synthetic strings.")
    parser.add_argument("--output", type=pathlib.Path, help="Write redacted JSON report; stdout prints only summary.")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print(json.dumps({"path": "audit", "line": 0, "rule": "self-test-passed"}))
        return 0
    if args.filesystem and args.history:
        parser.error("--filesystem cannot be combined with --history")
    root = args.root.resolve()
    summary: dict = collections.defaultdict(int)
    findings = scan_worktree(root, args.include_dev_state, args.filesystem, summary)
    if args.history:
        findings.extend(scan_history(root, summary))
    findings = list({(item["path"], item["line"], item["rule"]): item for item in findings}.values())
    findings.sort(key=lambda item: (item["path"], item["line"], item["rule"]))
    summary["finding_locations"] = len(findings)
    report = {"schema_version": 1, "scope": {"history": args.history, "dev_state": args.include_dev_state, "filesystem": args.filesystem, "max_text_file_bytes": MAX_BYTES, "env_contents_read": False}, "summary": dict(summary), "rules_by_count": dict(collections.Counter(item["rule"] for item in findings)), "environment_files": env_inventory(root, args.filesystem), "findings": findings}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({key: value for key, value in report.items() if key != "findings"}, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    # A finding requires review; a nonzero result must not be called a leak.
    return 1 if findings else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError):
        print(json.dumps({"path": "audit", "line": 0, "rule": "audit-incomplete"}), file=sys.stderr)
        raise SystemExit(2)
