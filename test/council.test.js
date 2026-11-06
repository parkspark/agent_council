// node --test test/   (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractJson, normStance, normVote, normVerdict, stripTrailingJson } from '../src/protocol.js';
import { ADAPTERS, normalizeAgentId } from '../src/agents/index.js';
import { loadConfig } from '../src/config.js';
import { Council, ROOT } from '../src/orchestrator.js';
import { windowsInstallDirs, findInInstallDirs, runProcess } from '../src/process.js';

test('답변 끝의 JSON 블록을 읽는다', () => {
  const t = '### 의견\n좋습니다.\n\n```json\n{"stance": "agree", "summary": "ok"}\n```';
  assert.deepEqual(extractJson(t), { stance: 'agree', summary: 'ok' });
  assert.equal(stripTrailingJson(t), '### 의견\n좋습니다.');
  assert.deepEqual(extractJson('끝 {"vote":"approve",}'), { vote: 'approve' });
  assert.equal(extractJson('JSON 없음'), null);
});

test('판정 값을 정규화한다', () => {
  assert.equal(normStance('agree'), 'agree');
  assert.equal(normStance('disagree'), 'object');
  assert.equal(normStance('agree | revise | object'), 'unknown');
  assert.equal(normVote('찬성'), 'approve');
  assert.equal(normVote('reject'), 'reject');
  assert.equal(normVerdict('request_changes'), 'changes');
  assert.equal(normalizeAgentId('Gemini (agy)'), 'antigravity');
  assert.equal(normalizeAgentId('OpenAI Codex'), 'codex');
});

test('Claude stream-json 결과를 파싱한다', () => {
  const p = ADAPTERS.claude.createParser();
  p.push('{"type":"system","subtype":"init","session_id":"s1","model":"m"}');
  const ev = p.push('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a.js"}}]}}');
  assert.equal(ev[0].kind, 'tool');
  assert.equal(p.isDone(), false);
  p.push('{"type":"result","subtype":"success","is_error":false,"result":"최종 답","session_id":"s1"}');
  assert.equal(p.isDone(), true);
  assert.equal(p.result().text, '최종 답');
  assert.equal(p.result().sessionId, 's1');
});

test('Codex JSONL을 파싱한다', () => {
  const p = ADAPTERS.codex.createParser();
  p.push('{"type":"thread.started","thread_id":"t1"}');
  p.push('{"type":"item.started","item":{"id":"i0","type":"command_execution","command":"ls"}}');
  p.push('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"끝"}}');
  assert.equal(p.isDone(), false);
  p.push('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}');
  assert.equal(p.isDone(), true);
  assert.equal(p.result().text, '끝');
  assert.equal(p.result().sessionId, 't1');
});

test('Antigravity stream-json을 파싱한다', () => {
  const p = ADAPTERS.antigravity.createParser();
  p.push('{"event":"init","conversation_id":"c1"}');
  p.push('{"event":"step_update","step_update":{"step_index":2,"state":"RUNNING","step_type":"agent_response","text_delta":"안녕"}}');
  p.push('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"하세요"}}');
  assert.equal(p.result().text, '안녕하세요');
  assert.equal(p.isDone(), false, '중간 답변만으로는 끝난 것이 아님');
  p.push('{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"최종"}}');
  assert.equal(p.isDone(), true);
  assert.equal(p.result().text, '최종');
});

test('Antigravity가 셸 권한 거부로 실패하면 안내를 붙여 한 번 재시도한다', async () => {
  process.env.COUNCIL_MOCK_FAST = '1';
  process.env.COUNCIL_MOCK_PERMFAIL = 'antigravity';
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-'));
    const council = new Council({
      config: loadConfig(ROOT), task: '분석', cwd: dir, mock: true, discussOnly: true, rounds: 1,
      runsDir: path.join(dir, '.runs'),
    });
    const done = [];
    council.on('event', (e) => { if (e.type === 'agent.completed' && e.agent === 'antigravity') done.push(e); });
    const final = await council.run();
    assert.equal(final.status, 'discussed');
    assert.equal(done[0].ok, false);
    assert.equal(done[1].ok, true);
    assert.equal(done[1].label, '재시도');
    assert.ok(council.active.includes('antigravity'), '재시도 성공 후 회의에 남아 있어야 함');
    const prompts = fs.readdirSync(path.join(council.runDir, 'raw')).filter((f) => f.includes('antigravity') && f.endsWith('.prompt.md'));
    const first = fs.readFileSync(path.join(council.runDir, 'raw', prompts[0]), 'utf8');
    assert.ok(first.includes('터미널(셸) 명령 권한이 없습니다'), '처음부터 셸 금지 안내가 붙어야 함');
  } finally {
    delete process.env.COUNCIL_MOCK_PERMFAIL;
  }
});

test('실제 agy 1.4.12의 권한 거부 출력을 오류로 인식한다', () => {
  const p = ADAPTERS.antigravity.createParser();
  const cmd = '{"name":"run_command","parameters":{"CommandLine":"Get-ChildItem -Recurse -File"}}';
  const ev1 = p.push(`{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":${cmd}}}`);
  assert.match(ev1[0].text, /run_command · Get-ChildItem/);
  const ev2 = p.push(`{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":${cmd}}}`);
  assert.equal(ev2[0].kind, 'error');
  p.push('{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"","num_turns":1,"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}');
  const r = p.result();
  assert.equal(r.text, '');
  assert.ok(ADAPTERS.antigravity.isPermissionError(r.error));
});

test('PATH에 없어도 기본 설치 위치에서 CLI를 찾는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-home-'));
  try {
    const local = path.join(home, 'AppData', 'Local');
    const bin = path.join(local, 'agy', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'agy.exe'), '');
    const dirs = windowsInstallDirs({ USERPROFILE: home, LOCALAPPDATA: local });
    assert.deepEqual(findInInstallDirs('agy', dirs), [path.join(bin, 'agy.exe')]);
    assert.deepEqual(findInInstallDirs('codex', dirs), []);
    assert.deepEqual(findInInstallDirs('..\\agy', dirs), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('가짜 에이전트로 전체 흐름(lead)이 끝까지 돈다', async () => {
  process.env.COUNCIL_MOCK_FAST = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  const council = new Council({
    config: loadConfig(ROOT),
    task: '테스트 작업',
    cwd: dir,
    mock: true,
    autoApprove: true,
    runsDir: path.join(dir, '.runs'),
  });
  const types = [];
  council.on('event', (e) => types.push(e.type));
  const final = await council.run();
  assert.equal(final.status, 'completed');
  assert.ok(types.includes('consensus.vote'));
  assert.ok(types.includes('review.round'));
  assert.ok(fs.existsSync(path.join(dir, 'council-demo.md')));
  assert.ok(fs.existsSync(final.transcript));
});

// ───────────────────────────── 프로세스가 끝나지 않는 경우 (agy가 답변 후 14분간 멈추던 문제)

const NODE = { found: true, file: process.execPath, prefixArgs: [], shell: false };

test('최종 답변을 받은 뒤 프로세스가 안 끝나면 grace 뒤 정리하고 돌려준다', async () => {
  let seen = false;
  const res = await runProcess({
    resolved: NODE,
    args: ['-e', 'console.log(JSON.stringify({event:"result"})); setInterval(() => {}, 1000);'],
    onLine: (l) => { if (l.includes('"result"')) seen = true; },
    isDone: () => seen,
    graceMs: 200,
    timeoutMs: 20000,
  });
  assert.equal(res.killedAfterDone, true);
  assert.equal(res.timedOut, false);
  assert.ok(res.doneMs != null && res.killMs != null && res.killMs >= res.doneMs);
  assert.ok(res.durationMs < 10000, `너무 오래 기다림: ${res.durationMs}ms`);
});

test('답변 후 정상 종료하면 강제 종료하지 않는다', async () => {
  let seen = false;
  const res = await runProcess({
    resolved: NODE,
    args: ['-e', 'console.log(JSON.stringify({event:"result"}));'],
    onLine: (l) => { if (l.includes('"result"')) seen = true; },
    isDone: () => seen,
    graceMs: 5000,
  });
  assert.equal(res.code, 0);
  assert.equal(res.killedAfterDone, false);
  assert.equal(res.forcedClose, false);
  assert.ok(res.exitMs != null);
});

test('프로세스가 끝났는데 하위 프로세스가 출력 파이프를 쥐고 있어도 기다리지 않는다', async () => {
  // detached로 띄운 네이티브 하위 프로세스는 부모가 끝난 뒤에도 stdout 파이프를 쥐고 있어서 'close'가 오지 않습니다.
  // (Windows에서 detached 없이 띄우거나 node를 띄우면 파이프를 쥐지 않아 이 상황이 재현되지 않습니다)
  const holder = process.platform === 'win32'
    ? '"cmd.exe", ["/d", "/c", "ping -n 4 127.0.0.1 >nul"]'
    : '"sh", ["-c", "sleep 3"]';
  const script = [
    `const c = require("child_process").spawn(${holder}, { stdio: "inherit", detached: true });`,
    'c.unref();',
    'console.log("bye");',
  ].join(' ');
  const lines = [];
  const res = await runProcess({ resolved: NODE, args: ['-e', script], onLine: (l) => lines.push(l), graceMs: 200, timeoutMs: 20000 });
  assert.deepEqual(lines, ['bye']);
  assert.equal(res.code, 0);
  assert.ok(res.exitMs != null);
  assert.equal(res.forcedClose, true, '파이프가 열린 채로 남는 경로를 타야 함');
  assert.equal(res.timedOut, false);
  assert.ok(res.durationMs < 2500, `하위 프로세스(약 3초)를 기다림: ${res.durationMs}ms`);
});

test('출력이 한동안 없으면 무응답 시간 초과로 중단한다', async () => {
  const res = await runProcess({
    resolved: NODE,
    args: ['-e', 'console.log("hi"); setInterval(() => {}, 1000);'],
    idleTimeoutMs: 300,
    timeoutMs: 20000,
  });
  assert.equal(res.idleTimedOut, true);
  assert.equal(res.timedOut, false);
  assert.ok(res.durationMs < 10000);
});

test('agy가 답변 후 멈춰도 토론이 기다리지 않고 답변을 쓴다', async () => {
  process.env.COUNCIL_MOCK_FAST = '1';
  process.env.COUNCIL_MOCK_HANG = 'antigravity';
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-'));
    const config = loadConfig(ROOT);
    config.timeouts = { ...config.timeouts, graceSeconds: 0.2 };
    const council = new Council({
      config, task: '분석', cwd: dir, mock: true, discussOnly: true, rounds: 1,
      runsDir: path.join(dir, '.runs'),
    });
    const done = [];
    council.on('event', (e) => { if (e.type === 'agent.completed' && e.agent === 'antigravity') done.push(e); });
    const final = await council.run();
    assert.equal(final.status, 'discussed');
    assert.ok(done.length >= 2);
    for (const d of done) {
      assert.equal(d.ok, true, d.error);
      assert.match(d.warning, /정리했습니다/);
      assert.ok(d.durationMs < 10000, `${d.phase}: ${d.durationMs}ms`);
    }
    assert.ok(council.active.includes('antigravity'));
    const rawDir = path.join(council.runDir, 'raw');
    const out = fs.readdirSync(rawDir).find((f) => f.includes('antigravity') && f.endsWith('.out.jsonl'));
    const last = fs.readFileSync(path.join(rawDir, out), 'utf8').trim().split(/\r?\n/).pop();
    assert.match(last, /^# 종료 .*최종 답변 수신 .*답변 후에도 프로세스가 끝나지 않아/);
  } finally {
    delete process.env.COUNCIL_MOCK_HANG;
  }
});

test('시간 초과가 나도 그 전에 최종 답변을 받았으면 실패로 처리하지 않는다', async () => {
  process.env.COUNCIL_MOCK_FAST = '1';
  process.env.COUNCIL_MOCK_HANG = 'antigravity';
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-'));
    const config = loadConfig(ROOT);
    // grace를 길게 둬서 전체 제한 시간(약 2초)이 먼저 걸리게 합니다.
    config.timeouts = { ...config.timeouts, discussMinutes: 0.035, graceSeconds: 60 };
    const council = new Council({
      config, task: '분석', cwd: dir, mock: true, discussOnly: true, agents: ['antigravity'],
      runsDir: path.join(dir, '.runs'),
    });
    const done = [];
    council.on('event', (e) => { if (e.type === 'agent.completed') done.push(e); });
    const final = await council.run();
    assert.equal(final.status, 'discussed');
    assert.ok(done.length >= 1);
    for (const d of done) {
      assert.equal(d.ok, true, d.error);
      assert.match(d.warning, /제한 시간/);
      assert.ok(d.text.length > 0);
    }
  } finally {
    delete process.env.COUNCIL_MOCK_HANG;
  }
});
