#!/usr/bin/env python3
"""Copy an isolated release candidate without credentials, runtime data or Git history.

This deliberately includes untracked source files: git archive HEAD would miss
current server, MCP, chart modules and the project skill. No source is deleted,
staged or committed. An existing project LICENSE is copied unchanged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT_FILES = {
    '.gitignore', '.env.example', '.mcp.json', 'README.md', 'README.zh-CN.md',
    'THIRD_PARTY_NOTICES.md', 'LICENSE', 'package.json', 'pnpm-lock.yaml',
    'index.html', 'vite.config.ts', 'vitest.config.ts', 'tsconfig.json',
    'pnpm-workspace.yaml', 'svelte.config.js',
}
PUBLIC_DATA = {
    'docs/validation/pattern-display-dedup-2026-09-27/patterns.json',
    'docs/technical-analysis-plan-2026-09-23/acceptance-generated.md',
    'docs/technical-analysis-plan-2026-09-23/acceptance-generated.json',
    'docs/technical-analysis-plan-2026-09-23/anchor-review-round2-score.md',
}
PUBLIC_DOCS = {
    'docs/developer-guide.md', 'docs/market-data-storage.md',
    'docs/dependency-license-review-2026-10-01.md',
    'docs/native-scope-validation-2026-10-01.md',
}
SOURCE_DIRS = ('src/', 'server/', 'mcp/', 'public/', 'tests/', 'scripts/',
               '.claude/skills/tvchart-agent/')
PRIVATE_DIRS = ('.git/', '.omc/', '.playwright-mcp/', '.data/', 'node_modules/',
                'dist/', '.vite/', '.pnpm-store/', 'coverage/')


def selected(path: str) -> bool:
    if path.startswith(PRIVATE_DIRS):
        return False
    if path != '.env.example' and any(p == '.env' or p.startswith('.env.') for p in Path(path).parts):
        return False
    if any(p == '__pycache__' for p in Path(path).parts):
        return False
    if path.endswith(('.pyc', '.local')):
        return False
    if path.startswith('scripts/release/audit-results'):
        return False
    # Standalone case-export research depends on unpublished development notes.
    if path.startswith('scripts/research/huzi-case-eval/') or path.startswith('scripts/research/') and 'backtest' in Path(path).name:
        return False
    return path in ROOT_FILES or path in PUBLIC_DATA or path.startswith(SOURCE_DIRS) or path.startswith('docs/assets/') or (
        path.startswith('docs/architecture/') and path.endswith('.md')
    ) or path in PUBLIC_DOCS


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--destination', type=Path, help='A new directory outside the source tree.')
    args = parser.parse_args()
    root = args.root.resolve()
    dest = args.destination.resolve() if args.destination else Path(tempfile.mkdtemp(prefix='open-tradingview-release-'))
    if dest == root or root in dest.parents:
        parser.error('destination must be outside the source tree')
    if args.destination and dest.exists():
        parser.error('destination already exists; use a new directory')
    dest.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(['git', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], check=True, capture_output=True)
    paths = sorted({p.decode() for p in result.stdout.split(b'\0') if p})
    files, excluded = [], []
    for name in paths:
        source = root / name
        if not selected(name) or not source.is_file():
            excluded.append(name)
            continue
        if source.is_symlink():
            raise RuntimeError('symlink requires review: ' + name)
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        files.append({'path': name, 'bytes': target.stat().st_size,
                      'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    for required in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'svelte.config.js', 'src/main.ts', 'server/agent-docs.ts',
                     'mcp/server.ts', '.claude/skills/tvchart-agent/SKILL.md'):
        if not (dest / required).is_file():
            raise RuntimeError('required source missing: ' + required)
    manifest = {'schema_version': 1, 'purpose': 'isolated verification candidate; not a published release',
                'private_files_and_git_history_copied': False,
                'license_pending': not (dest / 'LICENSE').exists(),
                'files': files, 'excluded_repository_paths': excluded}
    (dest / 'release-snapshot.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'destination': str(dest), 'copied_files': len(files),
                      'excluded_repository_paths': len(excluded),
                      'license_pending': manifest['license_pending']}, indent=2))


if __name__ == '__main__':
    main()
