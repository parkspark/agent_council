// 단계별 프롬프트 템플릿.
// 각 에이전트는 매 호출마다 "새 세션"으로 실행되므로(상태 없음), 필요한 맥락을 프롬프트에 모두 담습니다.
// 맨 위 HTML 주석(<!-- council ... -->)은 기록/디버깅과 mock 에이전트용 표식입니다.

import { agentName } from './agents/index.js';

export function clipMiddle(s, n) {
  const t = String(s || '').trim();
  if (!n || t.length <= n) return t;
  const head = Math.floor(n * 0.7);
  const tail = n - head;
  return `${t.slice(0, head)}\n\n…(중략: ${t.length - n}자)…\n\n${t.slice(-tail)}`;
}

function marker(phase, ctx, round = 0) {
  return `<!-- council phase=${phase} round=${round} agent=${ctx.self} -->`;
}

function header(ctx) {
  const others = ctx.agents.filter((a) => a !== ctx.self).map(agentName);
  const lang = ctx.language === 'en'
    ? '- Write every answer in English.'
    : '- 모든 답변은 한국어로 작성하세요. (코드, 명령어, 파일 이름은 원문 그대로)';
  return [
    `당신은 "${agentName(ctx.self)}"입니다. 여러 AI 코딩 에이전트가 하나의 협의체(Agent Council)를 이루어 사용자의 요청을 함께 해결하고 있습니다.`,
    `- 협의체 구성원: ${ctx.agents.map(agentName).join(', ')}${others.length ? ` (다른 구성원: ${others.join(', ')})` : ''}`,
    `- 작업 디렉터리: ${ctx.cwd}`,
    lang,
    '- 다른 에이전트의 의견을 무조건 따르지 마세요. 코드를 직접 확인하고, 근거를 들어 동의하거나 반대하세요.',
    '',
    '## 사용자 요청',
    ctx.task,
  ].join('\n');
}

const READ_ONLY = '규칙: 이 단계에서는 파일을 수정·생성·삭제하지 마세요. 코드를 읽고 분석만 하세요.';

function jsonTail(example, notes = []) {
  return [
    '',
    '답변의 **맨 마지막**에 반드시 아래 형식의 JSON 코드 블록을 붙이세요 (값만 바꾸고, 블록 뒤에는 아무것도 쓰지 마세요):',
    '```json',
    JSON.stringify(example, null, 0),
    '```',
    ...notes,
  ].join('\n');
}

function positionsBlock(ctx, positions, maxChars) {
  const order = [ctx.self, ...ctx.agents.filter((a) => a !== ctx.self)];
  return order
    .filter((id) => positions[id]?.text)
    .map((id) => `### ${agentName(id)}${id === ctx.self ? ' (당신)' : ''}의 입장\n${clipMiddle(positions[id].text, maxChars)}`)
    .join('\n\n');
}

// ──────────────────────────────────────────── 1. 독립 제안
export function propose(ctx) {
  return [
    marker('propose', ctx),
    header(ctx),
    '',
    '## 지금 단계: 1. 독립 제안',
    '다른 에이전트의 의견은 아직 볼 수 없습니다. 독립적으로 판단하세요.',
    READ_ONLY,
    '',
    '다음 형식으로 답하세요:',
    '### 요청 이해',
    '### 제안하는 접근 방식',
    '### 단계별 계획',
    '### 위험 요소와 확인이 필요한 점',
    jsonTail({ summary: '제안을 한 문장으로 요약', confidence: 0.8 }),
  ].join('\n');
}

// ──────────────────────────────────────────── 2. 토론
export function debate(ctx, { round, rounds, positions }) {
  return [
    marker('debate', ctx, round),
    header(ctx),
    '',
    `## 지금 단계: 2. 토론 (라운드 ${round}/${rounds})`,
    '아래는 각 에이전트의 직전 입장입니다.',
    '',
    positionsBlock(ctx, positions, ctx.limits.opinion),
    '',
    '## 할 일',
    '1. 다른 에이전트 제안의 좋은 점과 문제점을 구체적으로 짚으세요 (파일·함수 이름 등 근거 포함).',
    '2. 설득된 부분은 받아들이고, 동의할 수 없는 부분은 이유를 밝히세요.',
    '3. 이를 반영해 당신의 계획을 갱신하세요.',
    READ_ONLY + ' 필요하면 코드를 다시 읽어 주장을 검증하세요.',
    '',
    '다음 형식으로 답하세요:',
    '### 동의하는 점',
    '### 반대하거나 우려하는 점',
    '### 갱신된 계획',
    jsonTail(
      { stance: 'revise', summary: '현재 입장을 한 문장으로', open_issues: ['아직 합의되지 않은 쟁점'] },
      [
        'stance 값은 다음 중 하나만 쓰세요:',
        '- "agree": 다른 제안들과 사실상 같은 계획에 동의함 (open_issues는 빈 배열)',
        '- "revise": 큰 방향은 같지만 세부 조정이 필요함',
        '- "object": 핵심 방향에 반대함',
      ],
    ),
  ].join('\n');
}

// ──────────────────────────────────────────── 3. 합의안 작성 (진행자)
export function synthesize(ctx, { positions, rejections = [], executorRule, discussOnly, mode }) {
  const lines = [
    marker('synthesize', ctx),
    header(ctx),
    '',
    '## 지금 단계: 3. 합의안 작성 (진행자: 당신)',
    '당신은 이번 회의의 진행자입니다. 토론 내용을 종합해 모두가 받아들일 수 있는 최종 결론을 작성하세요.',
    '특정 에이전트(당신 포함)의 안을 편애하지 말고, 근거가 더 탄탄한 쪽을 택하세요.',
    READ_ONLY,
    '',
    '## 각 에이전트의 최종 입장',
    positionsBlock(ctx, positions, ctx.limits.opinion),
  ];
  if (rejections.length) {
    lines.push('', '## 이전 합의안에 대한 반대 의견 (반드시 반영하세요)');
    for (const r of rejections) {
      lines.push(`- ${agentName(r.agent)}: ${r.reason || '(사유 없음)'}${r.mustFix?.length ? ` / 필수 수정: ${r.mustFix.join('; ')}` : ''}`);
    }
  }
  lines.push('', '다음 형식으로 답하세요:');
  if (discussOnly) {
    lines.push('### 최종 결론', '### 쟁점별 결정과 이유', '### 남은 이견');
    lines.push(jsonTail({ plan_summary: '결론을 한 문장으로', acceptance_criteria: ['결론이 맞는지 확인하는 기준'] }));
  } else {
    lines.push(
      '### 최종 계획',
      '(구체적인 단계, 수정할 파일, 완료 기준을 포함하세요)',
      '### 쟁점별 결정과 이유',
    );
    if (mode === 'compete') {
      lines.push('', '참고: 이번에는 모든 에이전트가 각자 별도의 작업 공간에서 이 계획을 구현한 뒤, 가장 좋은 구현을 투표로 고릅니다.');
      lines.push(jsonTail({ plan_summary: '계획을 한 문장으로', acceptance_criteria: ['완료 기준'] }));
    } else {
      lines.push('### 실행 담당자와 선정 이유');
      lines.push('', `실행 담당자 규칙: ${executorRule}`);
      lines.push(jsonTail(
        { executor: ctx.agents[0], plan_summary: '계획을 한 문장으로', acceptance_criteria: ['완료 기준'] },
        [`executor 값은 ${ctx.agents.map((a) => `"${a}"`).join(', ')} 중 하나입니다.`],
      ));
    }
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────── 3-2. 투표
export function vote(ctx, { plan, moderator }) {
  return [
    marker('vote', ctx),
    header(ctx),
    '',
    '## 지금 단계: 3-2. 합의안 투표',
    `진행자 ${agentName(moderator)}가 작성한 최종 합의안입니다:`,
    '',
    '---',
    clipMiddle(plan.text, ctx.limits.opinion * 1.5),
    '---',
    '',
    '이 합의안으로 진행하는 데 동의합니까?',
    '- 치명적인 문제(요청과 어긋남, 버그를 만들 계획, 빠진 핵심 단계)가 없다면 찬성하세요.',
    '- 사소한 개선점은 의견으로만 남기고 찬성해도 됩니다.',
    READ_ONLY,
    '',
    '### 투표 의견',
    jsonTail(
      { vote: 'approve', reason: '한두 문장', must_fix: [] },
      ['vote 값은 "approve" 또는 "reject" 중 하나. 반대할 경우 must_fix에 반드시 고쳐야 할 점을 적으세요.'],
    ),
  ].join('\n');
}

// ──────────────────────────────────────────── 4. 실행 (lead 모드)
export function execute(ctx, { plan, note }) {
  return [
    marker('execute', ctx),
    header(ctx),
    '',
    '## 지금 단계: 4. 실행 (담당: 당신)',
    '협의체가 합의한 계획을 실제로 구현하세요. 이제 작업 디렉터리 안의 파일 수정이 허용됩니다.',
    '',
    '### 합의된 계획',
    clipMiddle(plan.text, 20000),
    note ? `\n### 사용자 추가 지시\n${note}` : '',
    '',
    '### 규칙',
    '- 합의된 계획의 범위를 벗어나는 변경은 하지 마세요.',
    '- 구현이 끝나면 다른 에이전트들이 변경 사항(diff)을 리뷰합니다.',
    '- 가능하면 빌드나 테스트로 검증하세요.',
    '- git commit, push, 브랜치 변경은 하지 마세요.',
    '',
    '완료 후 다음 형식으로 보고하세요:',
    '### 변경 요약',
    '### 변경한 파일',
    '### 검증 방법과 결과',
    '### 남은 문제',
    jsonTail({ status: 'done', summary: '무엇을 했는지 한 문장으로' }, ['status 값은 "done", "partial", "failed" 중 하나.']),
  ].join('\n');
}

// ──────────────────────────────────────────── 4. 실행 (compete 모드)
export function executeCompete(ctx, { plan, note }) {
  return [
    marker('execute', ctx),
    header(ctx),
    '',
    '## 지금 단계: 4. 경쟁 구현',
    '모든 에이전트가 각자 별도의 git worktree에서 같은 계획을 독립적으로 구현합니다. 구현이 끝나면 서로의 결과를 비교해 가장 좋은 구현을 투표로 고릅니다.',
    `당신의 작업 공간: ${ctx.cwd} (이 디렉터리 안에서만 작업하세요)`,
    '',
    '### 합의된 계획',
    clipMiddle(plan.text, 20000),
    note ? `\n### 사용자 추가 지시\n${note}` : '',
    '',
    '### 규칙',
    '- 계획의 범위를 벗어나는 변경은 하지 마세요.',
    '- 가능하면 빌드나 테스트로 검증하세요.',
    '- git commit은 하지 마세요. 작업이 끝나면 오케스트레이터가 커밋합니다.',
    '',
    '완료 후 다음 형식으로 보고하세요:',
    '### 변경 요약',
    '### 검증 방법과 결과',
    jsonTail({ status: 'done', summary: '무엇을 했는지 한 문장으로' }, ['status 값은 "done", "partial", "failed" 중 하나.']),
  ].join('\n');
}

// ──────────────────────────────────────────── 5. 리뷰 (lead 모드)
export function review(ctx, { plan, executor, report, changes, round }) {
  return [
    marker('review', ctx, round),
    header(ctx),
    '',
    `## 지금 단계: 5. 코드 리뷰 (${round}차)`,
    `${agentName(executor)}가 합의된 계획을 구현했습니다. 변경 사항을 리뷰하세요.`,
    '',
    '### 합의된 계획',
    clipMiddle(plan.text, ctx.limits.opinion),
    '',
    `### ${agentName(executor)}의 구현 보고`,
    clipMiddle(report, ctx.limits.opinion),
    '',
    '### 변경 사항',
    changes.empty ? '(감지된 파일 변경이 없습니다)' : '```diff\n' + clipMiddle(changes.diff, ctx.limits.diff) + '\n```',
    '',
    '필요하면 작업 디렉터리의 파일을 직접 읽어 확인하세요. ' + READ_ONLY,
    '판단 기준: 계획 충족 여부, 버그, 보안 문제, 누락된 부분. 단순한 취향 차이는 수정 요청 사유가 아닙니다.',
    '',
    '### 리뷰 의견',
    jsonTail(
      { verdict: 'approve', issues: [] },
      ['verdict 값은 "approve" 또는 "changes". "changes"면 issues에 반드시 고쳐야 할 문제를 구체적으로 적으세요.'],
    ),
  ].join('\n');
}

// ──────────────────────────────────────────── 6. 리뷰 반영
export function fix(ctx, { plan, reviews, round }) {
  const fb = reviews
    .map((r) => `### ${agentName(r.agent)}의 리뷰\n${clipMiddle(r.text, ctx.limits.opinion)}`)
    .join('\n\n');
  return [
    marker('fix', ctx, round),
    header(ctx),
    '',
    `## 지금 단계: 6. 리뷰 반영 (${round}차)`,
    '당신이 구현한 변경 사항에 대해 다른 에이전트들이 리뷰를 남겼습니다.',
    '',
    '### 합의된 계획',
    clipMiddle(plan.text, ctx.limits.opinion),
    '',
    fb,
    '',
    '### 할 일',
    '- 타당한 지적은 수정하세요.',
    '- 동의하지 않는 지적은 수정하지 말고 이유를 설명하세요.',
    '- git commit, push는 하지 마세요.',
    '',
    '### 반영 내용',
    '### 반영하지 않은 지적과 이유',
    jsonTail({ status: 'done', summary: '무엇을 고쳤는지 한 문장으로' }),
  ].join('\n');
}

// ──────────────────────────────────────────── 5. 구현 비교 (compete 모드)
export function judge(ctx, { plan, candidates }) {
  const per = Math.max(4000, Math.floor(ctx.limits.diff / Math.max(1, candidates.length)));
  const blocks = candidates.map((c) => [
    `### 후보: ${c.agent} (${agentName(c.agent)})`,
    '보고:',
    clipMiddle(c.report, 3000),
    '```diff',
    clipMiddle(c.diff, per),
    '```',
  ].join('\n'));
  return [
    marker('judge', ctx),
    header(ctx),
    '',
    '## 지금 단계: 5. 구현 비교 평가',
    '같은 계획을 여러 에이전트가 각자 구현했습니다. 아래 후보 중 가장 좋은 구현을 고르세요.',
    `당신 자신의 구현(${ctx.self})은 후보에서 제외되었습니다.`,
    READ_ONLY,
    '',
    '### 합의된 계획',
    clipMiddle(plan.text, ctx.limits.opinion),
    '',
    ...blocks,
    '',
    '평가 기준: 계획 충족, 정확성(버그 여부), 단순함, 코드 품질.',
    '### 평가',
    jsonTail(
      { best: candidates[0]?.agent || 'codex', ranking: candidates.map((c) => c.agent), reason: '선택 이유' },
      [`best 값은 ${candidates.map((c) => `"${c.agent}"`).join(', ')} 중 하나입니다.`],
    ),
  ].join('\n');
}

// ──────────────────────────────────────────── 연결 확인 (doctor --live)
export function probe(ctx) {
  return [
    marker('probe', ctx),
    '연결 테스트입니다. 도구를 사용하지 말고, 정확히 아래 한 줄만 답하세요.',
    '```json',
    '{"ok": true}',
    '```',
  ].join('\n');
}
