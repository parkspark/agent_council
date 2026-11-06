#!/usr/bin/env node
// 가짜 에이전트: 실제 CLI(claude / codex / agy)의 출력 형식만 흉내 냅니다.
// 사용량(토큰)을 쓰지 않고 오케스트레이터 흐름과 대시보드를 확인할 때 씁니다.  (--mock)
//
// 환경 변수
//   COUNCIL_MOCK_FAST=1          대기 시간을 거의 없앰 (테스트용)
//   COUNCIL_MOCK_FAIL=codex      해당 에이전트가 로그인 오류로 실패하는 상황을 흉내
//   COUNCIL_MOCK_PERMFAIL=antigravity
//                                첫 시도에서 "셸 명령 권한 거부 → 답변 없음"을 흉내 (재시도 경로 확인용)
//   COUNCIL_MOCK_HANG=antigravity
//                                최종 답변(result)을 보낸 뒤 프로세스가 끝나지 않고 멈춘 상황을 흉내 (실제 agy에서 관찰됨)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const flavor = (argv.find((a) => a.startsWith('--flavor=')) || '--flavor=claude').split('=')[1];
const args = argv.filter((a) => !a.startsWith('--flavor='));
const fast = process.env.COUNCIL_MOCK_FAST === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, fast ? 5 : ms + Math.random() * ms * 0.6));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const uuid = () => crypto.randomUUID();

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) s += c;
  return s;
}

function getPrompt(stdin) {
  const pi = args.indexOf('-p');
  if (pi >= 0 && args[pi + 1] && !args[pi + 1].startsWith('-')) return args[pi + 1];
  if (args.includes('--input-format')) {
    for (const line of stdin.split('\n')) {
      try {
        const o = JSON.parse(line);
        if (o.message?.content) return o.message.content;
      } catch { /* 다음 줄 */ }
    }
  }
  if (flavor === 'codex') {
    const last = args[args.length - 1];
    if (last && last !== '-' && !last.startsWith('-')) return last;
  }
  return stdin;
}

const WRITE_FLAGS = ['acceptEdits', 'bypassPermissions', '--full-auto', 'accept-edits', '--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox'];
const canWrite = args.some((a) => WRITE_FLAGS.includes(a));

// ───────────────────────────── 단계별 가짜 답변

const PERSONA = {
  claude: {
    approach: '기존 구조를 유지하면서 작은 모듈로 나눠 단계적으로 구현합니다. 먼저 진입점과 데이터 흐름을 정리하고, 변경 범위를 최소화합니다.',
    concern: '테스트 없이 한 번에 크게 바꾸면 회귀 버그를 놓치기 쉽습니다.',
  },
  codex: {
    approach: '실패하는 테스트를 먼저 작성하고(TDD), 테스트를 통과시키는 최소 구현부터 시작합니다.',
    concern: '요구 사항이 모호한 부분은 테스트 케이스로 먼저 고정해야 합니다.',
  },
  antigravity: {
    approach: '사용자 화면 흐름을 먼저 그려 보고, 화면에 필요한 API와 상태를 거꾸로 설계합니다.',
    concern: '오류 메시지와 빈 상태(empty state) 처리가 빠지기 쉽습니다.',
  },
};

function jsonBlock(o) {
  return '\n```json\n' + JSON.stringify(o) + '\n```';
}

function answer(phase, round, prompt) {
  const me = PERSONA[flavor] || PERSONA.claude;
  const task = (prompt.match(/## 사용자 요청\n([\s\S]*?)\n\n## /) || [])[1]?.trim().split('\n')[0].slice(0, 80) || '요청';
  switch (phase) {
    case 'propose':
      return [
        '### 요청 이해', `"${task}"를 구현하는 작업으로 이해했습니다.`, '',
        '### 제안하는 접근 방식', me.approach, '',
        '### 단계별 계획', '1. 관련 파일 구조 파악', '2. 핵심 로직 구현', '3. 오류 처리와 검증',
        '', '### 위험 요소와 확인이 필요한 점', `- ${me.concern}`,
        jsonBlock({ summary: me.approach.split('.')[0], confidence: 0.7 + Math.random() * 0.2 }),
      ].join('\n');
    case 'debate': {
      const stance = round >= 2 ? 'agree' : flavor === 'codex' ? 'object' : 'revise';
      const text = {
        agree: '다른 에이전트들의 수정안을 반영하면 계획이 사실상 같아졌습니다. 이 방향에 동의합니다.',
        revise: '큰 방향은 같지만, 테스트 범위와 오류 처리 순서를 조정하자고 제안합니다.',
        object: '테스트 없이 구현부터 시작하는 안에는 반대합니다. 핵심 경로에 대한 테스트를 먼저 두어야 합니다.',
      }[stance];
      return [
        '### 동의하는 점', '- 작은 단위로 나눠 진행하는 점', '',
        '### 반대하거나 우려하는 점', `- ${me.concern}`, '',
        '### 갱신된 계획', text,
        jsonBlock({ stance, summary: text, open_issues: stance === 'agree' ? [] : ['테스트를 언제 작성할지'] }),
      ].join('\n');
    }
    case 'synthesize':
      return [
        '### 최종 계획',
        '1. 핵심 경로 테스트를 먼저 작성 (Codex 제안)',
        '2. 작은 모듈로 나눠 구현 (Claude 제안)',
        '3. 오류 메시지와 빈 상태 처리 (Antigravity 제안)',
        '', '### 쟁점별 결정과 이유', '- 테스트 시점: 구현 전에 핵심 경로만 테스트로 고정하기로 했습니다.',
        '', '### 실행 담당자와 선정 이유', '- Claude: 모듈 분리 경험을 토론에서 가장 구체적으로 보여줬습니다.',
        jsonBlock({ executor: 'claude', plan_summary: '테스트 우선 + 모듈 분리 + 오류 처리 보강', acceptance_criteria: ['테스트 통과', '오류 메시지 표시'] }),
      ].join('\n');
    case 'vote':
      return ['### 투표 의견', '토론의 핵심 쟁점이 모두 반영되었습니다.', jsonBlock({ vote: 'approve', reason: '쟁점이 반영되어 찬성합니다.', must_fix: [] })].join('\n');
    case 'execute':
    case 'fix':
      return [
        '### 변경 요약', phase === 'fix' ? '리뷰에서 지적된 오류 처리를 추가했습니다.' : '합의된 계획대로 데모 파일을 수정했습니다.',
        '### 변경한 파일', '- council-demo.md',
        '### 검증 방법과 결과', '- (mock) 검증 생략',
        jsonBlock({ status: 'done', summary: phase === 'fix' ? '오류 처리 추가' : '데모 파일 수정' }),
      ].join('\n');
    case 'review': {
      const changes = round === 1 && flavor === 'codex';
      return [
        '### 리뷰 의견',
        changes ? '입력값이 비어 있을 때의 오류 처리가 빠졌습니다.' : '계획대로 구현되었고 문제를 찾지 못했습니다.',
        jsonBlock({ verdict: changes ? 'changes' : 'approve', issues: changes ? ['빈 입력에 대한 오류 처리 추가'] : [] }),
      ].join('\n');
    }
    case 'judge': {
      const cands = [...prompt.matchAll(/### 후보: (\w+)/g)].map((m) => m[1]);
      const best = cands[0] || 'claude';
      return ['### 평가', `${best}의 구현이 가장 단순하고 계획을 충실히 따릅니다.`, jsonBlock({ best, ranking: cands, reason: '단순하고 정확함' })].join('\n');
    }
    default:
      return '```json\n{"ok": true}\n```';
  }
}

function doWrite(phase) {
  if (!canWrite) return null;
  const file = path.join(process.cwd(), 'council-demo.md');
  const line = phase === 'fix'
    ? `- [${flavor}] 빈 입력 오류 처리 추가 (${new Date().toLocaleTimeString('ko-KR')})\n`
    : `\n## ${flavor}의 구현\n- 합의된 계획에 따라 작성 (${new Date().toLocaleTimeString('ko-KR')})\n`;
  fs.appendFileSync(file, line);
  return 'council-demo.md';
}

// ───────────────────────────── 형식별 출력

async function main() {
  const stdin = await readStdin();
  const prompt = getPrompt(stdin);
  const m = prompt.match(/<!-- council phase=(\w+) round=(\d+) agent=(\w+) -->/) || [];
  const phase = m[1] || 'probe';
  const round = Number(m[2] || 0);

  if ((process.env.COUNCIL_MOCK_FAIL || '').split(',').includes(flavor)) {
    await sleep(300);
    process.stderr.write(`Error: ${flavor} 로그인이 필요합니다 (mock)\n`);
    process.exit(1);
  }

  const text = answer(phase, round, prompt);
  const isWritePhase = phase === 'execute' || phase === 'fix';
  const sid = uuid();

  if ((process.env.COUNCIL_MOCK_PERMFAIL || '').split(',').includes(flavor) && !prompt.includes('## 재시도 안내')) {
    const msg = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';
    await sleep(300);
    if (flavor === 'antigravity') {
      // 실제 agy 1.4.12 출력 형식 그대로
      const cmd = { name: 'run_command', parameters: { CommandLine: 'Get-ChildItem -Recurse -File | Select-Object FullName' } };
      out({ event: 'init', conversation_id: sid, init: { cwd: process.cwd(), permission_mode: 'request-review' } });
      out({ event: 'step_update', step_update: { conversation_id: sid, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: cmd } });
      out({ event: 'step_update', step_update: { conversation_id: sid, step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: cmd } });
      process.stderr.write(msg + '\n');
      out({ event: 'result', result: { conversation_id: sid, status: 'SUCCESS', response: '', num_turns: 1, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
    } else {
      process.stderr.write(msg + '\n');
    }
    return;
  }

  if (flavor === 'claude') {
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'mock-claude', cwd: process.cwd() });
    await sleep(600);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Glob', input: { pattern: '**/*' } }] }, session_id: sid });
    await sleep(800);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(process.cwd(), 'README.md') } }] }, session_id: sid });
    if (isWritePhase) {
      await sleep(700);
      const f = doWrite(phase);
      if (f) out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: f } }] }, session_id: sid });
    }
    await sleep(900);
    out({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, num_turns: 3 });
  } else if (flavor === 'codex') {
    out({ type: 'thread.started', thread_id: sid });
    out({ type: 'turn.started' });
    await sleep(700);
    out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'bash -lc "rg --files | head"', status: 'in_progress' } });
    await sleep(700);
    out({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'bash -lc "rg --files | head"', status: 'completed', exit_code: 0 } });
    out({ type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: '테스트를 어디에 둘지 살펴보는 중' } });
    if (isWritePhase) {
      await sleep(800);
      const f = doWrite(phase);
      if (f) out({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: f, kind: 'update' }], status: 'completed' } });
    }
    await sleep(900);
    out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 } });
  } else {
    out({ event: 'init', conversation_id: sid, init: { cwd: process.cwd() } });
    await sleep(800);
    out({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: path.join(process.cwd(), 'README.md') } } } });
    await sleep(600);
    out({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'DONE', step_type: 'tool' } });
    if (isWritePhase) {
      await sleep(700);
      const f = doWrite(phase);
      if (f) out({ event: 'step_update', step_update: { conversation_id: sid, step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: f } } } });
    }
    const chunks = text.match(/[\s\S]{1,80}/g) || [];
    for (const c of chunks) {
      out({ event: 'step_update', step_update: { conversation_id: sid, step_index: 3, state: 'RUNNING', step_type: 'agent_response', text_delta: c } });
      await sleep(40);
    }
    out({ event: 'step_update', step_update: { conversation_id: sid, step_index: 3, state: 'DONE', step_type: 'agent_response' } });
    out({ event: 'result', result: { conversation_id: sid, status: 'SUCCESS', response: text, num_turns: 2 } });
  }

  if ((process.env.COUNCIL_MOCK_HANG || '').split(',').includes(flavor)) {
    setInterval(() => {}, 60000); // 답변은 다 보냈지만 종료하지 않음
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n');
  process.exit(1);
});
