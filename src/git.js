// git 관련 도우미: 변경 사항(diff) 수집, 워크트리(compete 모드) 관리
// 사용자 저장소의 상태를 바꾸지 않는 명령만 씁니다. (예외: compete 모드의 worktree/branch 생성과 그 안에서의 커밋)

import fs from 'node:fs';
import path from 'node:path';
import { resolveCommand, runProcess } from './process.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'target', '.idea', '.vs', 'vendor', 'runs', '.sandbox']);

export async function git(args, cwd, opts = {}) {
  const resolved = await resolveCommand('git');
  if (!resolved.found) return { ok: false, code: -1, stdout: '', stderr: 'git을 찾을 수 없습니다.' };
  const r = await runProcess({
    resolved,
    args: ['-c', 'core.quotepath=false', ...args],
    cwd,
    timeoutMs: opts.timeoutMs ?? 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr };
}

export async function gitAvailable() {
  return (await resolveCommand('git')).found;
}

export async function isGitRepo(cwd) {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.stdout.trim() === 'true';
}

export async function repoRoot(cwd) {
  const r = await git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok ? path.resolve(r.stdout.trim()) : null;
}

export async function headCommit(cwd) {
  const r = await git(['rev-parse', '--verify', 'HEAD'], cwd);
  return r.ok ? r.stdout.trim() : null;
}

async function listUntracked(root) {
  const r = await git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  const map = new Map();
  if (!r.ok) return map;
  for (const p of r.stdout.split('\0').filter(Boolean)) {
    try {
      map.set(p, fs.statSync(path.join(root, p)).mtimeMs);
    } catch { /* 사라진 파일 */ }
  }
  return map;
}

function snapshotDir(dir, limit = 20000) {
  const out = new Map();
  const walk = (d) => {
    if (out.size >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out.set(path.relative(dir, full).split(path.sep).join('/'), `${st.mtimeMs}:${st.size}`);
        } catch { /* 무시 */ }
      }
    }
  };
  walk(dir);
  return out;
}

function readTextFile(file, maxChars = 8000) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // 바이너리
    const s = buf.toString('utf8');
    return s.length > maxChars ? s.slice(0, maxChars) + '\n…(이하 생략)' : s;
  } catch {
    return null;
  }
}

function syntheticNewFileDiff(rel, content) {
  const body = content == null ? '(바이너리 또는 읽을 수 없는 파일)' : content;
  return [`diff --git a/${rel} b/${rel}`, 'new file', '--- /dev/null', `+++ b/${rel}`, ...body.split('\n').map((l) => '+' + l)].join('\n');
}

function truncate(s, max) {
  if (!max || s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `\n…(diff ${s.length - max}자 생략)`, truncated: true };
}

/** 실행 직전 상태를 기록해 둡니다. git 저장소가 아니면 파일 시간으로 비교합니다. */
export async function captureBaseline(cwd) {
  if (!(await isGitRepo(cwd))) return { kind: 'fs', root: cwd, snapshot: snapshotDir(cwd) };
  const root = await repoRoot(cwd);
  const head = await headCommit(root);
  // stash create: 작업 트리를 건드리지 않고 "현재 상태"를 커밋 객체로만 만들어 줍니다.
  const stash = head ? (await git(['stash', 'create'], root)).stdout.trim() : '';
  return {
    kind: 'git',
    root,
    head,
    ref: stash || head || EMPTY_TREE,
    dirty: !!stash,
    untracked: await listUntracked(root),
  };
}

/** baseline 이후 바뀐 내용을 diff 텍스트로 모읍니다. */
export async function collectChanges(baseline, { maxChars = 40000 } = {}) {
  if (baseline.kind === 'git') {
    const { root, ref } = baseline;
    const ns = await git(['diff', '--name-status', ref], root);
    const stat = await git(['diff', '--stat', ref], root);
    const diff = await git(['diff', ref], root);
    const files = ns.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const untrackedNow = await listUntracked(root);
    const extra = [];
    let newCount = 0;
    for (const [p, m] of untrackedNow) {
      if (baseline.untracked.has(p) && baseline.untracked.get(p) === m) continue;
      newCount++;
      files.push(`A\t${p}`);
      if (extra.length < 40) extra.push(syntheticNewFileDiff(p, readTextFile(path.join(root, p))));
    }
    const full = [diff.stdout.trim(), ...extra].filter(Boolean).join('\n');
    const t = truncate(full, maxChars);
    const untrackedNote = newCount ? `\n 새 파일(아직 git에 추가되지 않음) ${newCount}개` : '';
    return { files, stat: (stat.stdout.trim() + untrackedNote).trim(), diff: t.text, truncated: t.truncated, empty: files.length === 0 };
  }

  // git이 아닌 폴더: 파일 수정 시각/크기로 비교
  const after = snapshotDir(baseline.root);
  const files = [];
  const parts = [];
  for (const [p, sig] of after) {
    const before = baseline.snapshot.get(p);
    if (before === sig) continue;
    files.push(`${before ? 'M' : 'A'}\t${p}`);
    if (parts.length < 40) {
      const content = readTextFile(path.join(baseline.root, p));
      parts.push(before
        ? `=== 수정됨: ${p} (현재 내용) ===\n${content ?? '(바이너리)'}`
        : syntheticNewFileDiff(p, content));
    }
  }
  for (const p of baseline.snapshot.keys()) {
    if (!after.has(p)) {
      files.push(`D\t${p}`);
      parts.push(`=== 삭제됨: ${p} ===`);
    }
  }
  const t = truncate(parts.join('\n\n'), maxChars);
  return {
    files,
    stat: files.length ? `${files.length}개 파일 변경 (git 저장소가 아니라서 전체 내용으로 표시)` : '',
    diff: t.text,
    truncated: t.truncated,
    empty: files.length === 0,
  };
}

// ───────────────────────────── compete 모드: 워크트리

export async function addWorktree(root, wtPath, branch, base) {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const r = await git(['worktree', 'add', '-b', branch, wtPath, base], root);
  if (!r.ok) throw new Error(`worktree 생성 실패 (${branch}): ${r.stderr.trim()}`);
}

export async function commitAll(wtPath, message) {
  await git(['add', '-A'], wtPath);
  const staged = await git(['diff', '--cached', '--quiet'], wtPath);
  if (staged.code === 0) return false; // 변경 없음
  const email = (await git(['config', 'user.email'], wtPath)).stdout.trim();
  const identity = email ? [] : ['-c', 'user.name=Agent Council', '-c', 'user.email=council@localhost'];
  const r = await git([...identity, 'commit', '--no-verify', '-m', message], wtPath);
  if (!r.ok) throw new Error(`커밋 실패: ${r.stderr.trim()}`);
  return true;
}

export async function diffRange(root, base, branch, { maxChars = 40000 } = {}) {
  const ns = await git(['diff', '--name-status', `${base}..${branch}`], root);
  const stat = await git(['diff', '--stat', `${base}..${branch}`], root);
  const diff = await git(['diff', `${base}..${branch}`], root);
  const files = ns.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const t = truncate(diff.stdout.trim(), maxChars);
  return { files, stat: stat.stdout.trim(), diff: t.text, truncated: t.truncated, empty: files.length === 0 };
}

export async function listCouncilWorktrees(root, runsDir) {
  const r = await git(['worktree', 'list', '--porcelain'], root);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: path.resolve(line.slice(9).trim()) };
      out.push(cur);
    } else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
  }
  const base = path.resolve(runsDir).toLowerCase();
  return out.filter((w) => w.path.toLowerCase().startsWith(base) || w.branch?.startsWith('council/'));
}

export async function removeWorktree(root, wtPath) {
  return git(['worktree', 'remove', '--force', wtPath], root);
}

export async function deleteBranch(root, branch) {
  return git(['branch', '-D', branch], root);
}
