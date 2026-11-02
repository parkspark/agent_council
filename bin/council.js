#!/usr/bin/env node
// Agent Council CLI 진입점
//   node bin/council.js "할 일" --cwd <프로젝트 경로>      터미널에서 바로 실행
//   node bin/council.js ui                                 웹 대시보드
//   node bin/council.js doctor [--live]                    설치·연결 확인

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { Council, ROOT, RUNS_DIR } from '../src/orchestrator.js';
import { attachTerminal } from '../src/terminal.js';
import { ADAPTERS, AGENT_IDS } from '../src/agents/index.js';
import { resolveCommand, run } from '../src/process.js';
import { ensureDemoProject } from '../src/demo.js';
import * as G from '../src/git.js';
import { stripTrailingJson } from '../src/protocol.js';
import { STATUS_LABEL } from '../src/labels.js';

const BOOL = new Set(['discuss-only', 'yes', 'mock', 'no-open', 'brief', 'live', 'branches', 'help']);
const COMMANDS = new Set(['ui', 'dashboard', 'doctor', 'runs', 'clean', 'help']);

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      o._.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-y') o.yes = true;
    else if (a === '-h') o.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) o[k] = a.slice(eq + 1);
      else if (BOOL.has(k)) o[k] = true;
      else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

const HELP = `
Agent Council — Claude Code · Codex · Antigravity CLI가 토론하고 합의한 뒤 작업을 수행합니다.

사용법
  node bin/council.js "요청 내용" --cwd <프로젝트 경로> [옵션]
  node bin/council.js ui [--port 4545] [--mock] [--no-open]
  node bin/council.js doctor [--live]
  node bin/council.js runs
  node bin/council.js clean --cwd <저장소 경로> [--branches]

실행 옵션
  --cwd <경로>         에이전트가 작업할 프로젝트 폴더 (기본: 현재 폴더)
  --file <경로>        요청 내용을 파일에서 읽기
  --mode lead|compete  lead: 한 명이 구현 + 나머지 리뷰 (기본) / compete: 각자 워크트리에서 구현 후 투표
  --rounds <n>         토론 라운드 수 (기본: 설정값 2)
  --agents a,b         참여 에이전트 (claude,codex,antigravity)
  --moderator <id>     합의안 작성자 (기본: claude)
  --executor <id>      실행 담당 고정 (기본: auto = 진행자가 선택)
  --discuss-only       토론과 합의까지만 하고 실행하지 않음
  -y, --yes            사용자 승인 없이 바로 실행
  --brief              에이전트 답변 전문 대신 요약만 출력
  --mock               실제 CLI 대신 가짜 에이전트로 흐름만 시험 (사용량 0)
  --config <파일>       다른 설정 파일 사용

예시
  node bin/council.js "로그인 API에 입력값 검증 추가" --cwd C:\\path\\to\\my-project
  node bin/council.js "이 프로젝트 구조의 문제점" --cwd . --discuss-only
  node bin/council.js ui --mock
`;

async function terminalConfirm(council, req) {
  if (!process.stdin.isTTY) {
    console.log('\n승인이 필요하지만 대화형 터미널이 아닙니다. 바로 실행하려면 --yes 옵션을 쓰세요.');
    return { approved: false };
  }
  const who = req.mode === 'compete' ? '모든 에이전트(경쟁 구현)' : ADAPTERS[req.executor]?.name;
  console.log('');
  console.log(`┌ 실행 승인 요청`);
  console.log(`│ 합의: ${req.approved ? '성립' : '실패 (그래도 실행할 수 있습니다)'}`);
  console.log(`│ 실행 담당: ${who}  ·  권한: ${req.permission}`);
  if (req.summary) console.log(`│ 요약: ${req.summary}`);
  console.log('└ (위의 합의안 전문을 확인하세요)');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    rl.close();
    council.cancel();
  });
  try {
    const a = (await rl.question('이 계획대로 실행할까요? [y/N] ')).trim().toLowerCase();
    if (!['y', 'yes', 'ㅛ', '네', '예'].includes(a)) return { approved: false };
    const note = (await rl.question('추가 지시가 있으면 입력하세요 (없으면 Enter): ')).trim();
    return { approved: true, note };
  } catch {
    return { approved: false };
  } finally {
    rl.close();
  }
}

async function runTask(o, config) {
  let task = o._.join(' ').trim();
  if (o.file) task = fs.readFileSync(path.resolve(o.file), 'utf8').trim();
  if (!task) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  let cwd = o.cwd ? path.resolve(o.cwd) : undefined;
  if (o.mock && !cwd) cwd = await ensureDemoProject(ROOT);

  let council;
  council = new Council({
    config,
    task,
    cwd,
    agents: o.agents ? String(o.agents).split(',') : undefined,
    mode: o.mode,
    rounds: o.rounds != null ? Number(o.rounds) : undefined,
    discussOnly: !!o['discuss-only'],
    autoApprove: !!o.yes,
    mock: !!o.mock,
    moderator: o.moderator,
    executor: o.executor,
    confirm: (req) => terminalConfirm(council, req),
  });
  attachTerminal(council, { brief: !!o.brief });

  let sigints = 0;
  process.on('SIGINT', () => {
    sigints++;
    if (sigints === 1) council.cancel();
    else process.exit(130);
  });

  const final = await council.run();
  process.exitCode = ['completed', 'discussed'].includes(final.status) ? 0 : 1;
}

const INSTALL_HINT = {
  claude: 'irm https://claude.ai/install.ps1 | iex   또는   npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  antigravity: 'irm https://antigravity.google/cli/install.ps1 | iex',
};

async function doctor(o, config) {
  console.log('\n🩺 Agent Council 진단\n');
  console.log(`  Node      ${process.version} (${process.platform})`);
  const g = await resolveCommand('git');
  const gv = g.found ? (await run('git', ['--version'], { timeoutMs: 10000 })).stdout.trim() : '';
  console.log(`  git       ${g.found ? '✓ ' + gv : '✗ 없음 — compete 모드와 정확한 diff 리뷰에 필요합니다'}`);
  console.log(`  설정 파일  ${config._file || '(없음, 기본값 사용)'}\n`);

  const found = [];
  for (const id of AGENT_IDS) {
    const c = config.agents[id];
    const name = ADAPTERS[id].name.padEnd(12);
    if (c.enabled === false) {
      console.log(`  - ${name} 비활성화됨 (설정)`);
      continue;
    }
    if (o.mock) {
      console.log(`  ✓ ${name} mock`);
      found.push(id);
      continue;
    }
    const r = await resolveCommand(c.command);
    if (!r.found) {
      console.log(`  ✗ ${name} '${c.command}' 명령을 찾을 수 없습니다`);
      console.log(`      설치: ${INSTALL_HINT[id]}`);
      continue;
    }
    const v = await run(c.command, ['--version'], { timeoutMs: 20000 });
    const ver = (v.stdout || v.stderr).trim().split('\n')[0] || '(버전 확인 실패)';
    console.log(`  ✓ ${name} ${ver}`);
    console.log(`      ${r.path}  [${r.how}]`);
    found.push(id);
  }

  if (!o.live) {
    console.log('\n  실제로 답변을 받아 보려면: node bin/council.js doctor --live  (에이전트마다 짧은 요청 1회)\n');
    return;
  }
  console.log('\n  연결 테스트 (짧은 요청을 보내 응답 형식까지 확인합니다)…\n');
  await Promise.all(found.map(async (id) => {
    const c = new Council({ config, task: 'doctor', agents: [id], mock: !!o.mock, runsDir: path.join(RUNS_DIR, '_doctor') });
    const r = await c.probe(id);
    const name = ADAPTERS[id].name.padEnd(12);
    if (r.ok) console.log(`  ✓ ${name} 응답 OK (${(r.durationMs / 1000).toFixed(1)}초)${r.json?.ok ? '' : ' — 응답은 받았지만 JSON 형식이 아님'}`);
    else console.log(`  ✗ ${name} ${r.error}\n      로그: ${path.join(c.runDir, 'raw')}`);
  }));
  console.log('');
}

function listRunsCmd() {
  if (!fs.existsSync(RUNS_DIR)) return console.log('기록이 없습니다.');
  const ids = fs.readdirSync(RUNS_DIR).filter((d) => /^\d{8}-/.test(d)).sort().reverse().slice(0, 30);
  for (const id of ids) {
    let m = {};
    try {
      m = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'result.json'), 'utf8'));
    } catch { /* 진행 중 */ }
    console.log(`${id}  ${(STATUS_LABEL[m.status] || m.status || '?').padEnd(6)}  ${String(m.task || '').split('\n')[0].slice(0, 60)}`);
  }
  console.log(`\n회의록: ${RUNS_DIR}${path.sep}<ID>${path.sep}transcript.md`);
}

async function clean(o) {
  const cwd = path.resolve(o.cwd || process.cwd());
  const root = await G.repoRoot(cwd);
  if (!root) return console.log('git 저장소가 아닙니다:', cwd);
  const wts = await G.listCouncilWorktrees(root, RUNS_DIR);
  for (const w of wts) {
    const r = await G.removeWorktree(root, w.path);
    console.log(`${r.ok ? '✓' : '✗'} worktree 제거 ${w.path}${r.ok ? '' : ' — ' + r.stderr.trim()}`);
  }
  await G.git(['worktree', 'prune'], root);
  if (o.branches) {
    const br = await G.git(['branch', '--list', 'council/*', '--format=%(refname:short)'], root);
    for (const b of br.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const r = await G.deleteBranch(root, b);
      console.log(`${r.ok ? '✓' : '✗'} 브랜치 삭제 ${b}`);
    }
  } else {
    console.log('council/* 브랜치는 남겨 두었습니다. 함께 지우려면 --branches 옵션을 추가하세요.');
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const config = loadConfig(ROOT, o.config);
  const first = o._[0];
  const cmd = first && COMMANDS.has(first) && o._.length === 1 ? first : null;

  if (o.help || cmd === 'help' || (!o._.length && !o.file)) {
    console.log(HELP);
    return;
  }
  if (cmd === 'ui' || cmd === 'dashboard') {
    const { startServer } = await import('../src/server.js');
    await startServer({ config, port: Number(o.port || config.port), mock: !!o.mock, open: !o['no-open'] });
    return;
  }
  if (cmd === 'doctor') return doctor(o, config);
  if (cmd === 'runs') return listRunsCmd();
  if (cmd === 'clean') return clean(o);
  return runTask(o, config);
}

main().catch((e) => {
  console.error('오류:', e.message);
  process.exitCode = 1;
});
