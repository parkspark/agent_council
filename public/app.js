// Agent Council 대시보드 (프레임워크 없이 작성)
// 서버가 보내는 이벤트(SSE)를 상태로 모은 뒤(reduce) 화면을 다시 그립니다(render).

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CALL = { propose: '제안', debate: '토론', synthesize: '합의안', vote: '투표', execute: '실행', review: '리뷰', fix: '리뷰 반영', judge: '구현 평가', probe: '연결 확인' };
const STANCE = { agree: ['동의', 'ok'], revise: ['수정 제안', 'warn'], object: ['반대', 'bad'], unknown: ['불명확', 'neutral'] };
const VOTE = { approve: ['찬성', 'ok'], reject: ['반대', 'bad'], abstain: ['기권', 'neutral'], unknown: ['불명확', 'neutral'] };
const VERDICT = { approve: ['승인', 'ok'], changes: ['수정 요청', 'warn'], abstain: ['기권', 'neutral'], unknown: ['불명확', 'neutral'] };
const STATUS = { completed: '완료', discussed: '토론 완료', 'no-consensus': '합의 실패', rejected: '실행 안 함', cancelled: '취소됨', failed: '실패' };
const MODE_HINT = {
  lead: '토론으로 정한 실행 담당 한 명이 구현하고, 나머지가 변경 사항을 리뷰합니다.',
  compete: '모두 각자의 git worktree에서 구현한 뒤, 서로의 결과를 보고 가장 좋은 구현에 투표합니다. 커밋이 있는 git 저장소가 필요합니다.',
  discuss: '파일을 바꾸지 않고 토론과 합의안까지만 진행합니다.',
};
const STEPS_FULL = [['propose', '제안'], ['debate', '토론'], ['consensus', '합의'], ['approval', '승인'], ['execute', '실행'], ['review', '리뷰']];
const STEPS_DISCUSS = STEPS_FULL.slice(0, 3);
const PHASE_STEP = { propose: 'propose', debate: 'debate', consensus: 'consensus', vote: 'consensus', approval: 'approval', execute: 'execute', review: 'review', fix: 'review' };

const store = {
  get(k, d) { try { const v = localStorage.getItem('council.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('council.' + k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

let server = { agents: [], mock: false, defaults: {} };
let live = fresh();
let view = live;
let replayId = null;
let running = false;
let approvalPending = false;
let approvalNote = '';
const openKeys = new Set();
const expanded = new Set();

function fresh() {
  return {
    run: null, phase: null, phaseTitle: '', agents: {}, debates: [], proposals: [], votes: [], final: null,
    approval: null, approvalResolved: null, changes: [], reviews: [], compete: null, warnings: [], completed: null, cancelling: false,
  };
}

function agentState(st, id) {
  if (!st.agents[id]) st.agents[id] = { status: 'idle', entries: [], activity: [], current: null, badge: null };
  return st.agents[id];
}

function badgeFor(ev) {
  const j = ev.json || {};
  if (!ev.ok) return ['오류', 'bad'];
  if (ev.phase === 'debate') return STANCE[normStance(j.stance)];
  if (ev.phase === 'vote') return VOTE[normVote(j.vote)];
  if (ev.phase === 'review') return VERDICT[normVerdict(j.verdict)];
  if (ev.phase === 'judge' && j.best) return [`선택: ${nameOf(j.best)}`, 'neutral'];
  if (ev.phase === 'synthesize') return ['진행자', 'neutral'];
  if ((ev.phase === 'execute' || ev.phase === 'fix') && j.status) return [{ done: '완료', partial: '일부 완료', failed: '실패' }[j.status] || j.status, j.status === 'done' ? 'ok' : 'warn'];
  return null;
}

// protocol.js 와 같은 규칙 (브라우저용 사본)
const norm = (v) => { const s = String(v ?? '').toLowerCase().trim(); return s.includes('|') ? '' : s; };
function normStance(v) { const s = norm(v); if (!s) return 'unknown'; if (/disagree|object|반대/.test(s)) return 'object'; if (/revise|수정|조정/.test(s)) return 'revise'; if (/agree|동의|찬성/.test(s)) return 'agree'; return 'unknown'; }
function normVote(v) { const s = norm(v); if (!s) return 'unknown'; if (/reject|반대|no\b|거부/.test(s)) return 'reject'; if (/approve|찬성|yes|accept|동의/.test(s)) return 'approve'; return 'unknown'; }
function normVerdict(v) { const s = norm(v); if (!s) return 'unknown'; if (/change|request|reject|수정|반려/.test(s)) return 'changes'; if (/approve|lgtm|승인|통과|ok/.test(s)) return 'approve'; return 'unknown'; }

function reduce(st, ev) {
  switch (ev.type) {
    case 'run.started':
      st.run = ev;
      for (const a of ev.agents) agentState(st, a.id);
      break;
    case 'phase':
      st.phase = ev.phase;
      st.phaseTitle = ev.title;
      break;
    case 'agent.started': {
      const a = agentState(st, ev.agent);
      a.status = 'running';
      a.current = { phase: ev.phase, round: ev.round, since: ev.ts };
      a.activity = [];
      break;
    }
    case 'agent.activity': {
      if (ev.kind === 'text' || ev.kind === 'thinking') break;
      const a = agentState(st, ev.agent);
      a.activity.push(ev);
      if (a.activity.length > 5) a.activity.shift();
      break;
    }
    case 'agent.completed': {
      const a = agentState(st, ev.agent);
      a.status = ev.ok ? 'done' : 'error';
      a.current = null;
      a.entries.push(ev);
      const b = badgeFor(ev);
      if (b) a.badge = b;
      break;
    }
    case 'debate.round': st.debates.push(ev); break;
    case 'consensus.proposed': st.proposals.push(ev); break;
    case 'consensus.vote': st.votes.push(ev); break;
    case 'consensus.final': st.final = ev; break;
    case 'approval.required': st.approval = ev; st.approvalResolved = null; break;
    case 'approval.resolved': st.approvalResolved = ev; break;
    case 'changes': st.changes.push(ev); break;
    case 'review.round': st.reviews.push(ev); break;
    case 'compete.result': st.compete = ev; break;
    case 'warning': st.warnings.push(ev.message); break;
    case 'run.cancelling': st.cancelling = true; break;
    case 'run.completed':
      st.completed = ev;
      for (const a of Object.values(st.agents)) if (a.status === 'running') { a.status = 'idle'; a.current = null; }
      break;
    default: break;
  }
}

// ───────────────────────────── 작은 도우미

const info = (id) => server.agents.find((a) => a.id === id) || { id, name: id, short: id };
const nameOf = (id) => info(id).name || id;
const agentVar = (id) => `--agent: var(--c-${id})`;

function fmtDur(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

function stripJson(text) {
  return String(text || '').replace(/\n*```[ \t]*(?:json|JSON)?[ \t]*\r?\n[\s\S]*?```\s*$/, '').trimEnd();
}

function tag([label, kind]) {
  return `<span class="tag ${kind}">${esc(label)}</span>`;
}

// 원탁 그림: 세 좌석이 황동 고리를 둘러쌉니다. 좌석 상태(vote)에 따라 채워지거나 비어 있습니다.
function tableSvg(seats, ring, size = 76) {
  const c = size / 2;
  const R = size * 0.32;
  const r = size * 0.115;
  const ids = ['claude', 'codex', 'antigravity'];
  const angle = { claude: -90, codex: 30, antigravity: 150 };
  const circles = ids.map((id) => {
    const a = (angle[id] * Math.PI) / 180;
    const x = (c + R * Math.cos(a)).toFixed(1);
    const y = (c + R * Math.sin(a)).toFixed(1);
    const s = seats[id] || 'empty';
    const color = `var(--c-${id})`;
    if (s === 'off') return `<circle cx="${x}" cy="${y}" r="${r * 0.6}" fill="var(--line)"/>`;
    const fill = s === 'yes' ? color : 'var(--bg)';
    const dash = s === 'abstain' ? ' stroke-dasharray="2 2"' : '';
    const stroke = s === 'empty' ? 'var(--faint)' : color;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"${dash}/>`;
  }).join('');
  const ringStyle = ring === 'solid' ? 'stroke="var(--brass)" stroke-width="2.5"' : ring === 'broken' ? 'stroke="var(--danger)" stroke-width="2" stroke-dasharray="3 4"' : 'stroke="var(--brass)" stroke-width="1.5" stroke-dasharray="2 5"';
  return `<svg class="table-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${R}" fill="none" ${ringStyle}/>${circles}</svg>`;
}

// ───────────────────────────── 마크다운 (필요한 만큼만)

function inline(s) {
  return String(s).split(/(`[^`]+`)/g).map((seg) => {
    if (seg.length > 1 && seg.startsWith('`') && seg.endsWith('`')) return `<code>${esc(seg.slice(1, -1))}</code>`;
    return esc(seg).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }).join('');
}

function diffHtml(text) {
  return String(text).split('\n').map((l) => {
    const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'meta'
      : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
    return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
  }).join('\n');
}

function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^\s*```\s*([\w-]*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const isDiff = fence[1] === 'diff';
      out.push(`<pre class="${isDiff ? 'diff' : ''}"><code>${isDiff ? diffHtml(buf.join('\n')) : esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length <= 2 ? 3 : 4;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      out.push(`<div class="tbl"><table><thead><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const start = ordered ? parseInt(l.trim(), 10) : 1;
      const items = [];
      while (i < lines.length && LIST.test(lines[i])) {
        const m = lines[i].match(LIST);
        items.push({ sub: m[1].length >= 2, text: m[3] });
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST.test(lines[i])) {
          items[items.length - 1].text += ' ' + lines[i].trim();
          i++;
        }
      }
      const tagName = ordered ? 'ol' : 'ul';
      out.push(`<${tagName}${ordered && start > 1 ? ` start="${start}"` : ''}>${items.map((it) => `<li${it.sub ? ' class="sub"' : ''}>${inline(it.text)}</li>`).join('')}</${tagName}>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !LIST.test(lines[i]) && !/^\s*>/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

// ───────────────────────────── 렌더링: 진행 단계

const railEl = $('#rail');
const seatsEl = $('#seats');
const motionEl = $('#motion');

function renderRail() {
  const st = view;
  const steps = st.run?.discussOnly ? STEPS_DISCUSS : STEPS_FULL;
  const done = st.completed && ['completed', 'discussed'].includes(st.completed.status);
  const stopped = st.completed && !done;
  let cur = steps.findIndex(([k]) => k === PHASE_STEP[st.phase]);
  if (done) cur = steps.length;
  if (!st.run && !st.completed) cur = -1;
  const items = steps.map(([, label], i) => {
    const cls = i < cur ? 'done' : i === cur ? (stopped ? 'stopped' : 'current') : '';
    return `<li class="${cls}"${i === cur && !stopped ? ' aria-current="step"' : ''}><span class="n">${i + 1}</span>${label}</li>`;
  }).join('');
  let status = '회의를 기다리는 중';
  if (st.completed) status = `${STATUS[st.completed.status] || st.completed.status}, ${fmtDur(st.completed.durationMs)}`;
  else if (st.cancelling) status = '중단하는 중';
  else if (st.run) status = `${st.phaseTitle || '시작하는 중'}<span class="elapsed" data-since="${st.run.ts}"></span>`;
  railEl.innerHTML = `<ol>${items}</ol><p class="rail-status">${status}</p>`;
}

// ───────────────────────────── 렌더링: 좌석

function seatIds() {
  return ['claude', 'codex', 'antigravity'];
}

function renderSeats() {
  seatsEl.innerHTML = seatIds().map((id) => `<article class="seat" id="seat-${id}" style="${agentVar(id)}"></article>`).join('');
  for (const id of seatIds()) renderSeat(id);
}

function seatParticipates(id) {
  if (view.run) return view.run.agents.some((a) => a.id === id);
  return true;
}

function renderSeat(id) {
  const el = $(`#seat-${id}`);
  if (!el) return;
  const meta = info(id);
  const a = view.agents[id] || { status: 'idle', entries: [], activity: [], current: null, badge: null };
  const inRun = seatParticipates(id);
  const missing = meta.found === false;
  el.classList.toggle('off', !inRun || missing);

  let state = '대기';
  if (missing) state = '설치 안 됨';
  else if (!inRun) state = '이번 회의에 참여하지 않음';
  else if (a.status === 'running') state = '발언 중';
  else if (a.status === 'error') state = '오류';
  else if (a.entries.length) state = `발언 ${a.entries.length}회`;

  const head = `<header class="seat-head"><h2>${esc(meta.name)}</h2><span class="seat-state">${state}</span>${a.badge && inRun ? tag(a.badge) : ''}</header>`;
  const activity = a.status === 'running' && a.current ? activityHtml(a) : '';

  const entries = el.querySelector('.entries');
  const nearBottom = !entries || entries.scrollHeight - entries.scrollTop - entries.clientHeight < 60;
  const prevTop = entries?.scrollTop ?? 0;

  let body;
  if (missing) body = `<p class="seat-empty">'${esc(meta.command)}' 명령을 찾을 수 없습니다. CLI를 설치하거나 council.config.json에서 명령 이름을 바꾼 뒤 서버를 다시 시작하세요.</p>`;
  else if (!a.entries.length) body = `<p class="seat-empty">${inRun ? `회의가 시작되면 ${esc(meta.name)}의 발언이 여기에 쌓입니다.` : '이번 회의에는 참여하지 않습니다.'}</p>`;
  else body = a.entries.map(entryHtml).join('');

  el.innerHTML = `${head}<div class="activity-slot">${activity}</div><div class="entries">${body}</div>`;
  const ne = el.querySelector('.entries');
  ne.scrollTop = nearBottom ? ne.scrollHeight : prevTop;
}

function activityHtml(a) {
  const cur = a.current;
  const label = `${CALL[cur.phase] || cur.phase}${cur.round ? ' ' + cur.round : ''}`;
  const tools = a.activity.map((t) => `<li class="${t.kind === 'error' ? 'error' : ''}">${esc(t.text)}</li>`).join('');
  return `<div class="activity"><div class="activity-line"><span class="pulse"></span><span>${esc(label)} 작성 중</span><span class="elapsed" data-since="${cur.since}"></span></div>${tools ? `<ul>${tools}</ul>` : ''}</div>`;
}

function renderActivity(id) {
  const el = $(`#seat-${id} .activity-slot`);
  const a = view.agents[id];
  if (el && a) el.innerHTML = a.status === 'running' && a.current ? activityHtml(a) : '';
}

function entryHtml(ev) {
  const title = `${CALL[ev.phase] || ev.phase}${ev.round && ev.phase !== 'synthesize' ? ' ' + ev.round : ''}${ev.label ? ` (${ev.label})` : ''}`;
  const badge = badgeFor(ev);
  let body;
  if (!ev.ok) body = `<p class="err">${esc(ev.error)}</p>`;
  else {
    const text = stripJson(ev.text);
    if (!ev._html) ev._html = md(text);
    const long = text.length > 900 || text.split('\n').length > 16;
    const open = expanded.has(ev.callId);
    body = `<div class="md${long && !open ? ' clamp' : ''}">${ev._html}</div>${long ? `<button type="button" class="more" data-expand="${esc(ev.callId)}">${open ? '접기' : '전체 보기'}</button>` : ''}`;
  }
  return `<section class="entry"><header><h3>${esc(title)}</h3><span class="dur">${fmtDur(ev.durationMs)}</span>${badge ? tag(badge) : ''}</header>${body}${ev.warning ? `<p class="warn-line">경고: ${esc(ev.warning)}</p>` : ''}</section>`;
}

// ───────────────────────────── 렌더링: 협의 패널

function details(key, summary, inner) {
  return `<details data-key="${esc(key)}"${openKeys.has(key) ? ' open' : ''}><summary>${esc(summary)}</summary>${inner}</details>`;
}

function whoTag(id, extra = '') {
  return `<span class="who-tag" style="${agentVar(id)}">${esc(nameOf(id))}${extra}</span>`;
}

function emptyHtml() {
  return `<div class="empty">${tableSvg({ claude: 'yes', codex: 'yes', antigravity: 'yes' }, 'solid', 92)}
    <h2>세 에이전트에게 일을 맡겨 보세요</h2>
    <p>요청을 적고 회의를 시작하면 Claude Code, Codex, Antigravity가 각자 계획을 내고, 서로의 계획을 비판한 뒤, 합의안을 투표로 정합니다. 코드를 바꾸기 전에는 여기서 승인을 받습니다.</p>
    ${server.mock ? '<p>지금은 연습 모드입니다. 가짜 에이전트가 답하므로 사용량이 들지 않고, 작업 폴더를 비워 두면 연습용 데모 프로젝트에서 실행됩니다.</p>' : ''}
  </div>`;
}

function resultHtml(st) {
  const c = st.completed;
  const kind = ['completed', 'discussed'].includes(c.status) ? 'result-ok' : c.status === 'failed' ? 'result-bad' : 'result-mid';
  return `<section class="mblock ${kind}"><h2>결과</h2><p class="lead">${esc(STATUS[c.status] || c.status)}</p><p>${esc(c.summary || '')}</p>
    ${c.mergeHint ? `<div class="cmd"><code>${esc(c.mergeHint)}</code><button type="button" class="copy" data-copy="${esc(c.mergeHint)}">복사</button></div>` : ''}
    ${c.transcript ? `<div class="cmd"><span>회의록</span><code>${esc(c.transcript)}</code><button type="button" class="copy" data-copy="${esc(c.transcript)}">경로 복사</button></div>` : ''}
  </section>`;
}

function approvalHtml(st) {
  const r = st.approval;
  const who = r.mode === 'compete' ? '참여한 모든 에이전트가 각자의 worktree에서' : `${nameOf(r.executor)}가`;
  return `<section class="mblock approval" id="approvalBox"><h2>실행 승인</h2>
    <p class="lead">${esc(r.summary || '합의안대로 실행할까요?')}</p>
    ${r.approved ? '' : '<p class="note-warn">투표에서 합의가 성립하지 않았습니다. 그래도 실행할 수 있습니다.</p>'}
    <dl class="facts">
      <dt>실행</dt><dd>${esc(who)} 작업합니다</dd>
      <dt>폴더</dt><dd class="mono">${esc(st.run?.cwd || '')}</dd>
      <dt>권한</dt><dd>${r.permission === 'full' ? '모든 권한 (명령 실행 포함)' : '파일 편집만 자동 승인'}</dd>
    </dl>
    <label for="approvalNote">추가 지시 (선택)</label>
    <textarea id="approvalNote" rows="2" placeholder="예: 테스트 파일은 tests 폴더에 만들어 줘">${esc(approvalNote)}</textarea>
    <div class="actions"><button type="button" class="primary" data-act="approve">실행</button><button type="button" class="secondary" data-act="reject">실행하지 않음</button></div>
  </section>`;
}

function motionHtml(st) {
  const p = st.proposals[st.proposals.length - 1];
  const v = st.votes[st.votes.length - 1];
  const summary = p.json?.plan_summary || '합의안';
  const seats = {};
  for (const id of ['claude', 'codex', 'antigravity']) seats[id] = st.run?.agents.some((a) => a.id === id) ? 'empty' : 'off';
  if (p.moderator) seats[p.moderator] = 'yes';
  let voteLines = '';
  if (v && v.attempt === p.attempt) {
    for (const x of v.votes) seats[x.agent] = x.vote === 'approve' ? 'yes' : x.vote === 'reject' ? 'no' : 'abstain';
    voteLines = [
      `<div class="vote-line" style="${agentVar(p.moderator)}"><span class="who">${esc(nameOf(p.moderator))}</span><span>진행자</span></div>`,
      ...v.votes.map((x) => `<div class="vote-line" style="${agentVar(x.agent)}"><span class="who">${esc(nameOf(x.agent))}</span>${tag(VOTE[x.vote] || [x.vote, 'neutral'])}<span class="why">${esc(x.reason || '')}</span></div>`),
      `<div class="vote-line"><span class="verdict ${v.approved ? 'ok' : 'bad'}">${v.approved ? '합의 성립' : '합의 실패'}</span><span class="why">찬성 ${v.yes}명, 필요 ${v.needed}명</span></div>`,
    ].join('');
  } else {
    voteLines = `<div class="vote-line" style="${agentVar(p.moderator)}"><span class="who">${esc(nameOf(p.moderator))}</span><span>진행자가 합의안을 작성했습니다. 투표를 기다리는 중입니다.</span></div>`;
  }
  const ring = v && v.attempt === p.attempt ? (v.approved ? 'solid' : 'broken') : 'pending';
  const crit = Array.isArray(p.json?.acceptance_criteria) && p.json.acceptance_criteria.length
    ? `<ul class="criteria">${p.json.acceptance_criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '';
  const exec = st.final?.executor ? `<p>실행 담당: ${whoTag(st.final.executor)}</p>` : '';
  if (!p._html) p._html = md(stripJson(p.text));
  return `<section class="mblock council"><h2>안건${p.attempt > 1 ? ` (${p.attempt}차 수정안)` : ''}</h2>
    <p class="lead">${esc(summary)}</p>
    <div class="table-row">${tableSvg(seats, ring)}<div class="votes">${voteLines}</div></div>
    ${crit}${exec}
    ${details(`plan-${st.run?.runId}-${p.attempt}`, '합의안 전문 보기', `<div class="md">${p._html}</div>`)}
  </section>`;
}

function debateHtml(st) {
  const rows = st.debates.map((d) => `<div class="debate-row"><span class="round">토론 ${d.round}</span>${Object.entries(d.stances).map(([id, s]) => `${whoTag(id)} ${tag(STANCE[s] || [s, 'neutral'])}`).join('')}${d.allAgree ? '<span class="verdict ok">전원 동의</span>' : ''}</div>`).join('');
  return `<section class="mblock"><h2>토론 경과</h2><div class="debate-grid">${rows}</div></section>`;
}

function changesHtml(st) {
  const latest = new Map();
  for (const c of st.changes) latest.set(c.agent, c);
  return [...latest.values()].map((c) => `<section class="mblock"><h2>${esc(nameOf(c.agent))}의 변경 사항${c.branch ? ` (${esc(c.branch)})` : ''}</h2>
    ${c.empty ? '<p>감지된 파일 변경이 없습니다.</p>' : `<pre class="stat">${esc(c.stat || c.files.join('\n'))}</pre>
    ${details(`diff-${st.run?.runId}-${c.agent}-${c.round || 0}`, c.truncated ? 'diff 보기 (일부 생략됨)' : 'diff 보기', `<pre class="diff">${diffHtml(c.diff)}</pre>`)}`}
  </section>`).join('');
}

function reviewHtml(st) {
  const rounds = st.reviews.map((r) => `<div class="review-round"><h3>${r.round}차 리뷰</h3>${r.reviews.map((x) => `<div class="vote-line" style="${agentVar(x.agent)}"><span class="who">${esc(nameOf(x.agent))}</span>${tag(VERDICT[x.verdict] || [x.verdict, 'neutral'])}</div>${x.issues?.length ? `<ul>${x.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`).join('')}</div>`).join('');
  return `<section class="mblock"><h2>코드 리뷰</h2>${rounds}</section>`;
}

function competeHtml(st) {
  const c = st.compete;
  const rows = Object.entries(c.tally).map(([id, n]) => `<div class="vote-line" style="${agentVar(id)}"><span class="who">${esc(nameOf(id))}</span><span>${n}표</span>${id === c.winner ? '<span class="verdict ok">우승</span>' : ''}<span class="why">${esc(c.branches[id] || '')}</span></div>`).join('');
  const ballots = (c.ballots || []).map((b) => `<li>${esc(nameOf(b.agent))}: ${b.best ? esc(nameOf(b.best)) : '무효'}${b.reason ? `, ${esc(b.reason)}` : ''}</li>`).join('');
  return `<section class="mblock council"><h2>구현 투표</h2><p class="lead">${esc(nameOf(c.winner))}의 구현이 뽑혔습니다</p><div class="votes">${rows}</div>${ballots ? `<ul class="criteria">${ballots}</ul>` : ''}</section>`;
}

function renderMotion() {
  const st = view;
  if (!st.run && !st.completed) {
    motionEl.innerHTML = emptyHtml();
    return;
  }
  const parts = [];
  if (st.completed) parts.push(resultHtml(st));
  if (st.approval && !st.approvalResolved && approvalPending && !replayId) parts.push(approvalHtml(st));
  if (st.warnings.length) parts.push(`<section class="mblock warns"><h2>알림</h2><ul>${st.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>`);
  if (st.compete) parts.push(competeHtml(st));
  if (st.reviews.length) parts.push(reviewHtml(st));
  if (st.changes.length) parts.push(changesHtml(st));
  if (st.proposals.length) parts.push(motionHtml(st));
  if (st.debates.length) parts.push(debateHtml(st));
  if (!parts.length) parts.push(`<section class="mblock council"><h2>안건</h2><p class="lead">각 에이전트가 독립적으로 계획을 세우는 중입니다</p><p>제안이 모이면 서로의 계획을 비판하는 토론이 시작됩니다.</p></section>`);
  motionEl.innerHTML = parts.join('');
}

// ───────────────────────────── 렌더 스케줄링

const dirty = { all: false, rail: false, motion: false, seats: new Set(), activity: new Set() };
let rafPending = false;

function mark(ev) {
  if (!ev) { dirty.all = true; }
  else if (ev.type === 'agent.activity') dirty.activity.add(ev.agent);
  else if (ev.type === 'agent.started' || ev.type === 'agent.completed') { dirty.seats.add(ev.agent); dirty.rail = true; }
  else if (ev.type === 'run.started' || ev.type === 'run.completed') dirty.all = true;
  else { dirty.rail = true; dirty.motion = true; }
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(flush);
  }
}

function flush() {
  rafPending = false;
  if (dirty.all) {
    renderRail();
    renderSeats();
    renderMotion();
  } else {
    if (dirty.rail) renderRail();
    for (const id of dirty.seats) renderSeat(id);
    for (const id of dirty.activity) if (!dirty.seats.has(id)) renderActivity(id);
    if (dirty.motion) renderMotion();
  }
  dirty.all = dirty.rail = dirty.motion = false;
  dirty.seats.clear();
  dirty.activity.clear();
  tickElapsed();
}

function tickElapsed() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.elapsed[data-since]')) {
    el.textContent = ` ${fmtDur(now - Number(el.dataset.since))}`;
  }
}
setInterval(tickElapsed, 1000);

// ───────────────────────────── 서버 통신

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => {
    $('#connBar').hidden = true;
    const d = JSON.parse(e.data);
    live = fresh();
    for (const ev of d.events) reduce(live, ev);
    running = d.running;
    approvalPending = d.approvalPending;
    if (!replayId) view = live;
    mark();
    updateControls();
  });
  es.addEventListener('reset', () => {
    live = fresh();
    approvalNote = '';
    if (!replayId) view = live;
    mark();
  });
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    reduce(live, ev);
    if (ev.type === 'run.started') running = true;
    if (ev.type === 'approval.required') approvalPending = true;
    if (ev.type === 'approval.resolved') approvalPending = false;
    if (ev.type === 'run.completed') {
      running = false;
      approvalPending = false;
      loadHistory();
    }
    if (!replayId) {
      mark(ev);
      if (ev.type === 'approval.required') {
        requestAnimationFrame(() => $('#approvalBox')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }));
      }
    }
    updateControls();
  };
  es.onerror = () => {
    $('#connBar').hidden = false;
  };
}

// ───────────────────────────── 폼

const form = $('#runForm');

function currentMode() {
  return form.querySelector('input[name="mode"]:checked')?.value || 'lead';
}

function updateControls() {
  $('#startBtn').hidden = running;
  $('#cancelBtn').hidden = !running;
  $('#startBtn').disabled = running;
  $('#modeHint').textContent = MODE_HINT[currentMode()];
  $('#autoApprove').closest('label').hidden = currentMode() === 'discuss';
}

function renderAgentPick() {
  const saved = store.get('agents', null);
  $('#agentPick').innerHTML = '<legend class="field-label">참여 에이전트</legend>' + server.agents.map((a) => {
    const ok = a.found !== false && a.enabled !== false;
    const checked = ok && (saved ? saved.includes(a.id) : true);
    const note = a.enabled === false ? '설정에서 꺼져 있음' : a.found === false ? `'${a.command}' 명령 없음` : a.how === 'mock' ? '가짜 에이전트' : '';
    return `<label class="agent-row${ok ? '' : ' missing'}" style="${agentVar(a.id)}"><input type="checkbox" name="agent" value="${a.id}"${checked ? ' checked' : ''}${ok ? '' : ' disabled'}><span class="dot"></span><span>${esc(a.name)}${note ? `<small>${esc(note)}</small>` : ''}</span></label>`;
  }).join('');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#formError');
  err.textContent = '';
  const task = $('#task').value.trim();
  const cwd = $('#cwd').value.trim();
  const agents = [...form.querySelectorAll('input[name="agent"]:checked')].map((i) => i.value);
  const mode = currentMode();
  if (!task) { err.textContent = '요청 내용을 적어 주세요.'; $('#task').focus(); return; }
  if (!cwd && !server.mock) { err.textContent = '에이전트가 작업할 폴더 경로를 적어 주세요.'; $('#cwd').focus(); return; }
  if (!agents.length) { err.textContent = '참여할 에이전트를 하나 이상 고르세요.'; return; }
  store.set('cwd', cwd);
  store.set('mode', mode);
  store.set('agents', agents);
  store.set('rounds', Number($('#rounds').value));
  try {
    $('#startBtn').disabled = true;
    if (replayId) leaveReplay();
    await api('/api/run', {
      task,
      cwd,
      agents,
      mode: mode === 'compete' ? 'compete' : 'lead',
      discussOnly: mode === 'discuss',
      rounds: Number($('#rounds').value),
      autoApprove: mode !== 'discuss' && $('#autoApprove').checked,
    });
    running = true;
    updateControls();
  } catch (ex) {
    err.textContent = ex.message;
    $('#startBtn').disabled = false;
  }
});

$('#task').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
});
form.addEventListener('change', updateControls);

$('#cancelBtn').addEventListener('click', async () => {
  try {
    await api('/api/cancel', {});
  } catch (ex) {
    $('#formError').textContent = ex.message;
  }
});

// ───────────────────────────── 패널 동작 (이벤트 위임)

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.expand) {
    const id = t.dataset.expand;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    const seat = t.closest('.seat');
    if (seat) renderSeat(seat.id.replace('seat-', ''));
  } else if (t.dataset.copy) {
    const orig = t.dataset.label || t.textContent;
    t.dataset.label = orig;
    try {
      await navigator.clipboard.writeText(t.dataset.copy);
      t.textContent = '복사됨';
    } catch {
      t.textContent = '복사 실패';
    }
    setTimeout(() => { t.textContent = orig; }, 1500);
  } else if (t.dataset.act) {
    const approved = t.dataset.act === 'approve';
    t.disabled = true;
    try {
      await api('/api/approve', { approved, note: approved ? approvalNote : '' });
      approvalPending = false;
      approvalNote = '';
      mark({ type: 'approval' });
    } catch (ex) {
      t.disabled = false;
      $('#formError').textContent = ex.message;
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'approvalNote') approvalNote = e.target.value;
});

document.addEventListener('toggle', (e) => {
  const k = e.target.dataset?.key;
  if (!k) return;
  e.target.open ? openKeys.add(k) : openKeys.delete(k);
}, true);

// ───────────────────────────── 지난 회의

async function loadHistory() {
  try {
    const { runs } = await api('/api/runs');
    const list = $('#historyList');
    if (!runs.length) {
      list.innerHTML = '<li class="none">아직 기록이 없습니다.</li>';
      return;
    }
    list.innerHTML = runs.map((r) => {
      const k = ['completed', 'discussed'].includes(r.status) ? 'ok' : r.status === 'failed' ? 'bad' : r.status === 'unknown' ? '' : 'mid';
      const when = r.startedAt ? new Date(r.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return `<li><button type="button" data-run="${esc(r.runId)}"${replayId === r.runId ? ' aria-current="true"' : ''}><span class="st ${k}" title="${esc(STATUS[r.status] || r.status)}"></span><span class="t">${esc(String(r.task || '').split('\n')[0])}</span><time>${esc(when)} ${esc(STATUS[r.status] || '')}</time></button></li>`;
    }).join('');
  } catch { /* 기록 불러오기 실패는 조용히 무시 */ }
}

$('#historyList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-run]');
  if (!b) return;
  const id = b.dataset.run;
  if (live.run?.runId === id) {
    leaveReplay();
    return;
  }
  try {
    const { events } = await api(`/api/runs/${encodeURIComponent(id)}`);
    const st = fresh();
    for (const ev of events) reduce(st, ev);
    replayId = id;
    view = st;
    $('#replayBar').hidden = false;
    mark();
    loadHistory();
  } catch (ex) {
    $('#formError').textContent = ex.message;
  }
});

function leaveReplay() {
  replayId = null;
  view = live;
  $('#replayBar').hidden = true;
  mark();
  loadHistory();
}
$('#backLive').addEventListener('click', leaveReplay);

// ───────────────────────────── 시작

async function init() {
  $('#brandMark').innerHTML = tableSvg({ claude: 'yes', codex: 'yes', antigravity: 'yes' }, 'solid', 30);
  try {
    server = await api('/api/state');
  } catch (ex) {
    $('#formError').textContent = `서버 상태를 불러오지 못했습니다: ${ex.message}`;
  }
  running = !!server.running;
  approvalPending = !!server.approvalPending;
  $('#mockBadge').hidden = !server.mock;
  if (server.mock) $('#cwd').placeholder = '비워 두면 연습용 데모 프로젝트';
  $('#cwd').value = store.get('cwd', server.defaults?.cwd || '') || '';
  $('#rounds').value = store.get('rounds', server.defaults?.rounds ?? 2);
  const mode = store.get('mode', server.defaults?.mode || 'lead');
  const radio = form.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  renderAgentPick();
  updateControls();
  mark();
  loadHistory();
  connect();
}

init();
