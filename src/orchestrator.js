// Agent Council 오케스트레이터
//
//   1. 제안(propose)    : 모든 에이전트가 동시에, 서로의 의견을 보지 않고 계획을 제안
//   2. 토론(debate)     : 서로의 입장을 읽고 비판·수정 (N라운드, 모두 agree면 조기 종료)
//   3. 합의(consensus)  : 진행자가 최종안 작성 → 나머지가 찬반 투표 → 과반이면 성립
//   4. 승인(approval)   : 사용자가 실행 여부 결정 (--yes 면 생략)
//   5. 실행(execute)    : lead = 한 명이 구현 / compete = 모두 각자 워크트리에서 구현
//   6. 리뷰(review)     : lead = 나머지가 diff 리뷰 → 수정 요청 시 반영 / compete = 서로의 구현에 투표
//
// 모든 진행 상황은 'event' 이벤트로 내보내며(대시보드·터미널이 구독), runs/<id>/ 아래에 기록됩니다.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, AGENT_IDS, agentName, normalizeAgentId } from './agents/index.js';
import { resolveCommand, runProcess, childEnv } from './process.js';
import * as P from './prompts.js';
import { extractJson, normStance, normVote, normVerdict, asList } from './protocol.js';
import * as G from './git.js';
import { writeTranscript } from './transcript.js';
import { clip } from './agents/util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS_DIR = path.join(ROOT, 'runs');
const MOCK_AGENT = path.join(ROOT, 'mock', 'fake-agent.js');

export class CancelledError extends Error {
  constructor() {
    super('취소됨');
    this.name = 'CancelledError';
  }
}

function makeRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`;
}

function lastLines(s, n = 6) {
  return String(s || '').trim().split(/\r?\n/).slice(-n).join('\n');
}

/** raw 로그 끝에 남기는 종료 요약. 나중에 "답은 끝났는데 프로세스가 안 끝난" 경우를 구분하는 데 씁니다. */
export function describeExit(res) {
  const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const parts = [`종료 code=${res.code ?? '-'}${res.signal ? ` signal=${res.signal}` : ''}`, `총 ${sec(res.durationMs ?? 0)}`];
  if (res.doneMs != null) parts.push(`최종 답변 수신 ${sec(res.doneMs)}`);
  parts.push(res.exitMs != null ? `프로세스 종료 ${sec(res.exitMs)}` : '프로세스 종료 이벤트 없음');
  if (res.aborted) parts.push('취소');
  if (res.timedOut) parts.push('전체 시간 초과로 종료시킴');
  if (res.idleTimedOut) parts.push('무응답 시간 초과로 종료시킴');
  if (res.killedAfterDone) {
    parts.push(res.killMs != null
      ? `답변 후에도 프로세스가 끝나지 않아 ${sec(res.killMs)}에 종료시킴`
      : '답변 후 프로세스는 끝났지만 출력 파이프가 열려 있었음');
  }
  if (res.forcedClose) parts.push('출력 파이프가 닫히지 않아 강제로 닫음');
  return parts.join(' · ');
}

export function agentInfo(id) {
  const a = ADAPTERS[id];
  return { id, name: a.name, short: a.short, color: a.color };
}

export class Council extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.config      loadConfig() 결과
   * @param {string} o.task        사용자 요청
   * @param {string} [o.cwd]       에이전트가 작업할 디렉터리
   * @param {string[]} [o.agents]  참여 에이전트 id 목록
   * @param {'lead'|'compete'} [o.mode]
   * @param {number} [o.rounds]    토론 라운드 수
   * @param {boolean} [o.discussOnly]  토론·합의까지만
   * @param {boolean} [o.autoApprove]  사용자 승인 없이 바로 실행
   * @param {boolean} [o.mock]     가짜 에이전트 사용
   * @param {(req:object)=>Promise<{approved:boolean,note?:string}>} [o.confirm]
   */
  constructor(o) {
    super();
    const cfg = o.config;
    this.config = cfg;
    this.task = String(o.task || '').trim();
    this.cwd = path.resolve(o.cwd || cfg.defaultCwd || process.cwd());
    this.mode = o.mode || cfg.executionMode || 'lead';
    this.rounds = Number.isFinite(o.rounds) ? Math.max(0, Math.min(6, o.rounds)) : cfg.debateRounds;
    this.discussOnly = !!o.discussOnly;
    this.autoApprove = !!o.autoApprove;
    this.mock = !!o.mock;
    this.moderatorPref = normalizeAgentId(o.moderator || cfg.moderator);
    this.executorPref = o.executor || cfg.executor || 'auto';
    this.confirm = o.confirm || (async () => ({ approved: true }));
    const wanted = (o.agents?.length ? o.agents : AGENT_IDS).map(normalizeAgentId).filter(Boolean);
    this.requested = [...new Set(wanted)].filter((id) => ADAPTERS[id] && cfg.agents[id]?.enabled !== false);
    this.runId = o.runId || makeRunId();
    this.runDir = path.join(o.runsDir || RUNS_DIR, this.runId);
    this.events = [];
    this.active = [];
    this.ac = new AbortController();
    this.seq = 0;
    this.status = 'idle';
  }

  // ───────────────────────────── 이벤트 / 취소

  emitEvent(type, data = {}) {
    const ev = { type, ts: Date.now(), runId: this.runId, ...data };
    this.events.push(ev);
    try {
      fs.appendFileSync(path.join(this.runDir, 'events.jsonl'), JSON.stringify(ev) + '\n');
    } catch { /* 기록 실패는 무시 */ }
    this.emit('event', ev);
    return ev;
  }

  phase(phase, title, round = 0) {
    this.currentPhase = phase;
    this.emitEvent('phase', { phase, title, round });
  }

  warn(message) {
    this.emitEvent('warning', { message });
  }

  cancel() {
    if (this.ac.signal.aborted) return;
    this.ac.abort();
    this.emitEvent('run.cancelling', {});
  }

  get aborted() {
    return this.ac.signal.aborted;
  }

  checkAbort() {
    if (this.aborted) throw new CancelledError();
  }

  abortPromise() {
    const p = new Promise((_, reject) => {
      if (this.aborted) reject(new CancelledError());
      this.ac.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    });
    p.catch(() => {}); // 경합이 끝난 뒤 취소되어도 unhandled rejection이 나지 않도록
    return p;
  }

  // ───────────────────────────── 에이전트 호출

  agentCfg(id) {
    return { command: ADAPTERS[id].defaultCommand, ...(this.config.agents[id] || {}) };
  }

  limitsFor(id) {
    const ad = ADAPTERS[id];
    const mode = this.agentCfg(id).inputMode || ad.defaultInputMode;
    // 프롬프트를 명령줄 인자로 넘기는 경우 Windows 명령줄 길이 제한(약 32K자)을 피하도록 줄입니다.
    if (mode === 'arg') return { opinion: Math.min(this.config.maxOpinionChars, 5000), diff: Math.min(this.config.maxDiffChars, 9000) };
    return { opinion: this.config.maxOpinionChars, diff: this.config.maxDiffChars };
  }

  ctx(id, extra = {}) {
    return {
      self: id,
      task: this.task,
      cwd: this.cwd,
      agents: this.active,
      language: this.config.language,
      limits: this.limitsFor(id),
      ...extra,
    };
  }

  permFor(access) {
    return access === 'read' ? 'read' : this.config.permission === 'full' ? 'full' : 'edits';
  }

  /**
   * 에이전트 하나를 실행하고 결과를 돌려줍니다. 실패해도 throw하지 않고 ok:false 를 돌려줍니다.
   * (취소된 경우에만 CancelledError)
   *
   * - 기본 권한으로 실행할 때는 CLI별 환경 제약 안내(NOTES)를 프롬프트 끝에 붙입니다.
   * - 권한 거부 때문에 답변 없이 끝나면(예: agy가 셸 명령을 시도) 안내를 강화해 한 번 다시 시도합니다.
   */
  async callAgent(id, opts) {
    const ad = ADAPTERS[id];
    const perm = this.permFor(opts.access || 'read');
    const ac = this.agentCfg(id);
    // permissionArgs를 직접 지정했거나 shellHint:false 면 "셸 금지" 안내를 붙이지 않습니다.
    const usingDefaultPerm = !ac.permissionArgs?.[perm];
    const note = usingDefaultPerm && ac.shellHint !== false ? ad.NOTES?.[perm] : null;
    const prompt = note ? `${opts.prompt}\n\n${note}` : opts.prompt;

    const first = await this.callAgentOnce(id, { ...opts, prompt });
    if (first.ok || !ad.isPermissionError?.(first.error)) return first;

    this.warn(`${agentName(id)}가 허용되지 않은 터미널 명령을 시도하다 답변 없이 끝났습니다. 셸 명령 없이 다시 시도합니다.`);
    return this.callAgentOnce(id, { ...opts, prompt: `${prompt}\n\n${ad.RETRY_NOTE || ''}`, label: '재시도' });
  }

  async callAgentOnce(id, { phase, round = 0, prompt, access = 'read', cwd = this.cwd, label, timeoutMinutes }) {
    this.checkAbort();
    const ad = ADAPTERS[id];
    const ac = this.agentCfg(id);
    const inputMode = ac.inputMode || ad.defaultInputMode;
    const perm = this.permFor(access);
    const tc = this.config.timeouts || {};
    const timeoutMin = timeoutMinutes
      ?? (access === 'read' ? tc.discussMinutes : tc.executeMinutes);
    const idleMin = Number(tc.idleMinutes) > 0 ? Number(tc.idleMinutes) : 0; // 0 또는 미지정이면 끔
    const g = Number(tc.graceSeconds ?? 5);
    const graceSec = Number.isFinite(g) && g >= 0 ? g : 5;
    const permArgs = ac.permissionArgs?.[perm] ?? ad.PERMISSIONS[perm];
    const args = ad.buildArgs({
      inputMode,
      prompt,
      model: ac.model,
      permArgs,
      extraArgs: ac.extraArgs || [],
      timeoutMinutes: timeoutMin,
    });

    const resolved = this.mock
      ? { found: true, file: process.execPath, prefixArgs: [MOCK_AGENT, `--flavor=${id}`], shell: false, how: 'mock' }
      : await resolveCommand(ac.command);

    const seq = ++this.seq;
    const base = `${String(seq).padStart(2, '0')}-${phase}${round ? '-r' + round : ''}-${id}`;
    const rawDir = path.join(this.runDir, 'raw');
    fs.writeFileSync(path.join(rawDir, `${base}.prompt.md`), prompt);
    const raw = fs.createWriteStream(path.join(rawDir, `${base}.out.jsonl`));
    raw.on('error', () => {});
    raw.write(`# ${resolved.file} ${[...(resolved.prefixArgs || []), ...args.map((a) => (a === prompt ? '<prompt>' : a))].join(' ')}\n`);

    const parser = ad.createParser();
    const callId = String(seq);
    this.emitEvent('agent.started', { agent: id, phase, round, callId, access: perm, label: label || null });
    const t0 = Date.now();

    const res = await runProcess({
      resolved,
      args,
      cwd,
      input: ad.formatInput(prompt, inputMode),
      env: childEnv(),
      timeoutMs: timeoutMin * 60000,
      idleTimeoutMs: idleMin * 60000,
      // 최종 답변(result)을 받으면 graceSec 안에 안 끝나도 프로세스를 정리하고 넘어갑니다.
      isDone: () => parser.isDone?.() ?? false,
      graceMs: graceSec * 1000,
      signal: this.ac.signal,
      onLine: (line) => {
        raw.write(line + '\n');
        let evs = [];
        try {
          evs = parser.push(line);
        } catch { /* 파싱 실패한 줄은 무시 */ }
        for (const ev of evs) {
          this.emitEvent('agent.activity', { agent: id, phase, round, callId, kind: ev.kind, text: clip(ev.text, 300) });
        }
      },
      onStderr: (chunk) => raw.write(`[stderr] ${chunk}`),
    });
    raw.write(`# ${describeExit(res)}\n`);
    raw.end();

    const out = parser.result();
    const text = String(out.text || '').trim();
    // 최종 답변까지 받았다면, 그 뒤에 프로세스가 멈춰 시간 초과가 나도 답변은 그대로 씁니다.
    const completed = (parser.isDone?.() ?? false) && !!text;
    let error = null;
    if (res.aborted) error = '취소됨';
    else if ((res.timedOut || res.idleTimedOut) && !completed) {
      error = res.idleTimedOut ? `응답 없음 (${idleMin}분 동안 출력 없음)` : `시간 초과 (${timeoutMin}분)`;
    } else if (!text) {
      error = out.error || lastLines(res.stderr) || `종료 코드 ${res.code}`;
      if (res.error?.code === 'ENOENT') error = `'${ac.command}' 명령을 실행할 수 없습니다 (설치/PATH 확인)`;
    }
    const ok = !error;
    let warning = null;
    if (ok && (res.timedOut || res.idleTimedOut)) {
      warning = '최종 답변을 받은 뒤 프로세스가 끝나지 않아 제한 시간에 종료했습니다. 받은 답변을 사용합니다.';
    } else if (ok && res.killedAfterDone) {
      warning = `최종 답변을 받은 뒤 ${graceSec}초 안에 프로세스가 끝나지 않아 정리했습니다. 받은 답변을 사용합니다.`;
    } else if (ok && ((res.code != null && res.code !== 0) || out.error)) {
      warning = clip(out.error || `종료 코드 ${res.code}`, 300);
    }
    const result = {
      agent: id,
      phase,
      round,
      callId,
      label: label || null,
      ok,
      text: ok ? text : '',
      json: ok ? extractJson(text) : null,
      error,
      warning,
      durationMs: Date.now() - t0,
      costUsd: out.costUsd ?? null,
      sessionId: out.sessionId ?? null,
    };
    this.emitEvent('agent.completed', result);
    if (res.aborted) throw new CancelledError();
    return result;
  }

  /** 여러 에이전트를 동시에 실행. makeCall(id)는 동기적으로 {phase, prompt, ...}를 돌려줘야 합니다. */
  async parallel(ids, makeCall) {
    const calls = ids.map((id) => [id, makeCall(id)]); // 프롬프트를 먼저 모두 만든 뒤 실행
    const settled = await Promise.allSettled(calls.map(([id, c]) => this.callAgent(id, c)));
    if (this.aborted) throw new CancelledError();
    return settled.map((s, i) => (s.status === 'fulfilled'
      ? s.value
      : { agent: calls[i][0], ok: false, text: '', json: null, error: String(s.reason?.message || s.reason) }));
  }

  // ───────────────────────────── 메인 흐름

  async run() {
    fs.mkdirSync(path.join(this.runDir, 'raw'), { recursive: true });
    this.startedAt = Date.now();
    this.status = 'running';
    let final = { status: 'completed', summary: '' };

    try {
      if (!this.task) throw new Error('요청 내용이 비어 있습니다.');
      if (!fs.existsSync(this.cwd) || !fs.statSync(this.cwd).isDirectory()) {
        throw new Error(`작업 디렉터리가 없습니다: ${this.cwd}`);
      }
      this.active = await this.checkAgents();
      if (!this.active.length) {
        throw new Error('실행할 수 있는 에이전트가 없습니다. `node bin/council.js doctor`로 설치 상태를 확인하세요.');
      }
      this.emitEvent('run.started', {
        task: this.task,
        cwd: this.cwd,
        mode: this.mode,
        rounds: this.rounds,
        discussOnly: this.discussOnly,
        autoApprove: this.autoApprove,
        mock: this.mock,
        permission: this.config.permission,
        agents: this.active.map(agentInfo),
        runDir: this.runDir,
      });

      const positions = await this.discuss();
      const consensus = await this.reachConsensus(positions);

      if (this.discussOnly) {
        final = {
          status: consensus.approved ? 'discussed' : 'no-consensus',
          summary: consensus.json.plan_summary || '토론과 합의를 마쳤습니다.',
          moderator: consensus.moderator,
        };
      } else if (!consensus.approved && this.autoApprove) {
        final = { status: 'no-consensus', summary: '합의에 실패해 자동 실행하지 않았습니다. 회의록을 확인하세요.' };
      } else {
        const decision = await this.approvalGate(consensus);
        if (!decision.approved) {
          final = { status: 'rejected', summary: '사용자가 실행하지 않기로 했습니다.' };
        } else if (this.mode === 'compete') {
          final = await this.executeCompete(consensus, decision);
        } else {
          final = await this.executeLead(consensus, decision);
        }
      }
    } catch (e) {
      if (e instanceof CancelledError || this.aborted) final = { status: 'cancelled', summary: '실행이 취소되었습니다.' };
      else final = { status: 'failed', summary: `오류: ${e.message}`, error: e.message };
    }

    this.status = final.status;
    final = { ...final, durationMs: Date.now() - this.startedAt, runDir: this.runDir };
    const meta = {
      runId: this.runId,
      task: this.task,
      cwd: this.cwd,
      mode: this.mode,
      discussOnly: this.discussOnly,
      agents: this.active,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      ...final,
    };
    try {
      fs.writeFileSync(path.join(this.runDir, 'result.json'), JSON.stringify(meta, null, 2));
      final.transcript = writeTranscript(this.runDir, meta, this.events);
    } catch (e) {
      this.warn(`기록 저장 실패: ${e.message}`);
    }
    this.emitEvent('run.completed', final);
    return final;
  }

  async checkAgents() {
    if (this.mock) return [...this.requested];
    const ok = [];
    for (const id of this.requested) {
      const cmd = this.agentCfg(id).command;
      const r = await resolveCommand(cmd);
      if (r.found) ok.push(id);
      else this.warn(`${agentName(id)}: '${cmd}' 명령을 찾을 수 없어 이번 회의에서 제외합니다.`);
    }
    return ok;
  }

  // ───────────────────────────── 1~2. 제안과 토론

  async discuss() {
    this.phase('propose', '독립 제안');
    const props = await this.parallel(this.active, (id) => ({ phase: 'propose', prompt: P.propose(this.ctx(id)) }));
    const positions = {};
    for (const r of props) {
      if (r.ok) positions[r.agent] = r;
      else this.warn(`${agentName(r.agent)}가 제안 단계에서 실패해 이후 단계에서 제외합니다: ${clip(r.error, 200)}`);
    }
    this.active = this.active.filter((id) => positions[id]);
    if (!this.active.length) {
      throw new Error(`모든 에이전트가 응답하지 못했습니다. 로그: ${path.join(this.runDir, 'raw')}`);
    }

    for (let r = 1; r <= this.rounds && this.active.length > 1; r++) {
      this.phase('debate', `토론 ${r}/${this.rounds}`, r);
      const snapshot = { ...positions };
      const res = await this.parallel(this.active, (id) => ({
        phase: 'debate',
        round: r,
        prompt: P.debate(this.ctx(id), { round: r, rounds: this.rounds, positions: snapshot }),
      }));
      for (const x of res) if (x.ok) positions[x.agent] = x;
      const stances = Object.fromEntries(this.active.map((id) => [id, normStance(positions[id]?.json?.stance)]));
      const allAgree = this.active.every((id) => stances[id] === 'agree');
      this.emitEvent('debate.round', { round: r, stances, allAgree });
      if (allAgree) break;
    }
    return positions;
  }

  // ───────────────────────────── 3. 합의

  executorRule() {
    if (this.executorPref && this.executorPref !== 'auto') {
      const id = normalizeAgentId(this.executorPref);
      if (id && this.active.includes(id)) return `실행 담당은 ${id}(${agentName(id)})로 정해져 있습니다. executor 값에 "${id}"를 쓰세요.`;
    }
    return '토론 내용을 보고 이 작업을 가장 잘 해낼 에이전트 한 명을 고르세요. 각자 강점을 보인 부분을 근거로 삼으세요.';
  }

  pickExecutor(plan) {
    if (this.executorPref && this.executorPref !== 'auto') {
      const id = normalizeAgentId(this.executorPref);
      if (id && this.active.includes(id)) return id;
    }
    const fromPlan = normalizeAgentId(plan.json?.executor);
    if (fromPlan && this.active.includes(fromPlan)) return fromPlan;
    return plan.moderator;
  }

  async reachConsensus(positions) {
    const order = [
      ...(this.moderatorPref && this.active.includes(this.moderatorPref) ? [this.moderatorPref] : []),
      ...this.active.filter((id) => id !== this.moderatorPref),
    ];
    const maxAttempts = 1 + Math.max(0, this.config.consensusRetries ?? 1);
    let attempt = 0;
    let modIdx = 0;
    let plan = null;
    let votes = [];
    let approved = false;
    let rejections = [];

    while (attempt < maxAttempts && modIdx < order.length) {
      const moderator = order[modIdx];
      this.phase('consensus', `합의안 작성 · 진행자 ${agentName(moderator)}`, attempt + 1);
      const syn = await this.callAgent(moderator, {
        phase: 'synthesize',
        round: attempt + 1,
        prompt: P.synthesize(this.ctx(moderator), {
          positions,
          rejections,
          executorRule: this.executorRule(),
          discussOnly: this.discussOnly,
          mode: this.mode,
        }),
      });
      if (!syn.ok) {
        this.warn(`${agentName(moderator)}가 합의안 작성에 실패해 다른 진행자로 넘깁니다.`);
        modIdx++;
        continue;
      }
      attempt++;
      plan = { moderator, text: syn.text, json: syn.json || {} };
      this.emitEvent('consensus.proposed', { moderator, attempt, text: syn.text, json: syn.json });

      const voters = this.active.filter((id) => id !== moderator);
      votes = [];
      if (voters.length) {
        this.phase('vote', '합의안 투표', attempt);
        const vr = await this.parallel(voters, (id) => ({
          phase: 'vote',
          round: attempt,
          prompt: P.vote(this.ctx(id), { plan, moderator }),
        }));
        votes = vr.map((v) => ({
          agent: v.agent,
          vote: v.ok ? normVote(v.json?.vote) : 'abstain',
          reason: v.ok ? String(v.json?.reason || '') : v.error,
          mustFix: asList(v.json?.must_fix),
        }));
      }
      const yes = 1 + votes.filter((v) => v.vote === 'approve').length; // 진행자는 찬성으로 간주
      const no = votes.filter((v) => v.vote === 'reject').length;
      const needed = Math.floor(this.active.length / 2) + 1;
      approved = yes >= needed && yes > no;
      this.emitEvent('consensus.vote', { attempt, moderator, votes, yes, no, needed, approved });
      if (approved) break;
      rejections = votes.filter((v) => v.vote === 'reject');
    }

    if (!plan) throw new Error('합의안을 작성할 수 있는 에이전트가 없습니다.');
    const executor = this.discussOnly || this.mode === 'compete' ? null : this.pickExecutor(plan);
    const consensus = { ...plan, votes, approved, executor };
    this.emitEvent('consensus.final', {
      moderator: plan.moderator,
      approved,
      executor,
      summary: plan.json.plan_summary || '',
      text: plan.text,
    });
    return consensus;
  }

  async approvalGate(consensus) {
    this.phase('approval', '사용자 승인');
    if (this.autoApprove) {
      this.emitEvent('approval.resolved', { approved: true, auto: true });
      return { approved: true };
    }
    const req = {
      mode: this.mode,
      executor: consensus.executor,
      approved: consensus.approved,
      summary: consensus.json.plan_summary || '',
      plan: consensus.text,
      permission: this.config.permission,
    };
    this.emitEvent('approval.required', req);
    const d = await Promise.race([Promise.resolve(this.confirm(req)), this.abortPromise()]);
    const decision = { approved: !!d?.approved, note: d?.note ? String(d.note).slice(0, 4000) : '' };
    this.emitEvent('approval.resolved', decision);
    return decision;
  }

  // ───────────────────────────── 4~6. 실행 (lead)

  async executeLead(consensus, decision) {
    const executor = consensus.executor;
    const baseline = await G.captureBaseline(this.cwd);
    if (baseline.kind === 'git' && baseline.dirty) {
      this.warn('실행 전부터 커밋되지 않은 변경이 있었습니다. 리뷰에는 실행 이후 생긴 변경만 보여줍니다.');
    }
    if (baseline.kind === 'fs') {
      this.warn('git 저장소가 아니어서 파일 시간으로 변경을 추적합니다. 정확한 diff 리뷰를 원하면 `git init` 후 커밋해 두세요.');
    }

    this.phase('execute', `실행 · ${agentName(executor)}`);
    let report = await this.callAgent(executor, {
      phase: 'execute',
      prompt: P.execute(this.ctx(executor), { plan: consensus, note: decision.note }),
      access: 'write',
    });
    if (!report.ok) throw new Error(`${agentName(executor)} 실행 실패: ${report.error}`);

    let changes = await G.collectChanges(baseline, { maxChars: this.config.maxDiffChars });
    this.emitEvent('changes', { agent: executor, ...changes });

    const reviewers = this.active.filter((id) => id !== executor);
    const maxFix = Math.max(0, this.config.maxFixRounds ?? 1);
    let reviewState = reviewers.length ? 'pending' : 'skipped';
    let reports = report.text;

    for (let i = 1; reviewers.length && i <= maxFix + 1; i++) {
      this.phase('review', `리뷰 ${i}차`, i);
      const rr = await this.parallel(reviewers, (id) => ({
        phase: 'review',
        round: i,
        prompt: P.review(this.ctx(id), { plan: consensus, executor, report: reports, changes, round: i }),
      }));
      const reviews = rr.map((r) => ({
        agent: r.agent,
        verdict: r.ok ? normVerdict(r.json?.verdict) : 'abstain',
        issues: asList(r.json?.issues),
      }));
      const blocking = reviews.filter((r) => r.verdict === 'changes');
      const approvedCount = reviews.filter((r) => r.verdict === 'approve').length;
      reviewState = blocking.length ? 'changes' : approvedCount ? 'approved' : 'unknown';
      this.emitEvent('review.round', { round: i, reviews, state: reviewState });
      if (!blocking.length || i > maxFix) break;

      this.phase('fix', `리뷰 반영 ${i}차`, i);
      const fx = await this.callAgent(executor, {
        phase: 'fix',
        round: i,
        prompt: P.fix(this.ctx(executor), { plan: consensus, reviews: rr.filter((r) => r.ok), round: i }),
        access: 'write',
      });
      if (!fx.ok) {
        this.warn(`${agentName(executor)}가 리뷰 반영에 실패했습니다: ${clip(fx.error, 200)}`);
        break;
      }
      reports = `${report.text}\n\n---\n(리뷰 반영 ${i}차 보고)\n${fx.text}`;
      changes = await G.collectChanges(baseline, { maxChars: this.config.maxDiffChars });
      this.emitEvent('changes', { agent: executor, round: i, ...changes });
    }

    const n = changes.files.length;
    const reviewText = {
      approved: '리뷰를 통과했습니다.',
      changes: '리뷰에서 지적한 문제가 아직 남아 있습니다. 회의록을 확인하세요.',
      unknown: '리뷰 판정을 읽지 못했습니다. 회의록을 확인하세요.',
      skipped: '리뷰할 다른 에이전트가 없었습니다.',
      pending: '리뷰를 마치지 못했습니다.',
    }[reviewState];
    return {
      status: 'completed',
      executor,
      review: reviewState,
      filesChanged: n,
      summary: `${agentName(executor)}가 구현했고 파일 ${n}개가 바뀌었습니다. ${reviewText}`,
    };
  }

  // ───────────────────────────── 4~5. 실행 (compete)

  async executeCompete(consensus, decision) {
    const root = await G.repoRoot(this.cwd);
    const head = root && (await G.headCommit(root));
    if (!root || !head) {
      this.warn('경쟁 모드는 커밋이 하나 이상 있는 git 저장소가 필요해서 lead 모드로 전환합니다.');
      this.mode = 'lead';
      return this.executeLead({ ...consensus, executor: this.pickExecutor(consensus) }, decision);
    }
    const base = await G.captureBaseline(this.cwd);
    if (base.dirty || base.untracked.size) {
      this.warn('커밋되지 않은 변경은 워크트리에 포함되지 않습니다. 각 에이전트는 마지막 커밋(HEAD) 상태에서 시작합니다.');
    }
    const rel = path.relative(root, this.cwd);

    this.phase('execute', '경쟁 구현 (워크트리)');
    const wts = {};
    for (const id of this.active) {
      const wtPath = path.join(this.runDir, 'worktrees', id);
      const branch = `council/${this.runId}-${id}`;
      try {
        await G.addWorktree(root, wtPath, branch, head);
        wts[id] = { path: wtPath, branch, cwd: path.join(wtPath, rel) };
      } catch (e) {
        this.warn(e.message);
      }
    }
    const ids = Object.keys(wts);
    if (!ids.length) throw new Error('워크트리를 하나도 만들지 못했습니다.');

    const ex = await this.parallel(ids, (id) => ({
      phase: 'execute',
      prompt: P.executeCompete(this.ctx(id, { cwd: wts[id].cwd }), { plan: consensus, note: decision.note }),
      access: 'write',
      cwd: wts[id].cwd,
    }));

    const candidates = [];
    for (const r of ex) {
      if (!r.ok) continue;
      const w = wts[r.agent];
      try {
        await G.commitAll(w.path, `council(${r.agent}): ${clip(r.json?.summary || this.task, 60)}`);
      } catch (e) {
        this.warn(`${agentName(r.agent)} 커밋 실패: ${e.message}`);
      }
      const d = await G.diffRange(root, head, w.branch, { maxChars: this.config.maxDiffChars });
      this.emitEvent('changes', { agent: r.agent, branch: w.branch, worktree: w.path, ...d });
      if (!d.empty) candidates.push({ agent: r.agent, report: r.text, branch: w.branch, ...d });
      else this.warn(`${agentName(r.agent)}의 구현에서 변경 사항이 없습니다.`);
    }
    if (!candidates.length) throw new Error('유효한 구현이 하나도 없습니다.');

    let winner = candidates[0].agent;
    const tally = Object.fromEntries(candidates.map((c) => [c.agent, 0]));
    if (candidates.length > 1) {
      this.phase('review', '구현 비교 투표');
      const jr = await this.parallel(this.active, (id) => ({
        phase: 'judge',
        prompt: P.judge(this.ctx(id), { plan: consensus, candidates: candidates.filter((c) => c.agent !== id) }),
      }));
      const ballots = [];
      for (const j of jr) {
        const best = j.ok ? normalizeAgentId(j.json?.best) : null;
        const valid = best && best !== j.agent && tally[best] !== undefined;
        if (valid) tally[best]++;
        ballots.push({ agent: j.agent, best: valid ? best : null, reason: j.ok ? String(j.json?.reason || '') : j.error });
      }
      const max = Math.max(...Object.values(tally));
      const tied = Object.keys(tally).filter((k) => tally[k] === max);
      const modBallot = ballots.find((b) => b.agent === consensus.moderator)?.best;
      winner = tied.includes(modBallot) ? modBallot : tied[0];
      this.emitEvent('compete.result', { winner, tally, ballots, branches: Object.fromEntries(candidates.map((c) => [c.agent, c.branch])) });
    } else {
      this.emitEvent('compete.result', { winner, tally, ballots: [], branches: { [winner]: candidates[0].branch } });
    }

    const branch = wts[winner].branch;
    return {
      status: 'completed',
      winner,
      branch,
      mergeHint: `git merge ${branch}`,
      summary: `${agentName(winner)}의 구현이 뽑혔습니다. 적용하려면 저장소에서 git merge ${branch} 를 실행하세요.`,
    };
  }

  // ───────────────────────────── 연결 확인 (doctor --live)

  async probe(id) {
    fs.mkdirSync(path.join(this.runDir, 'raw'), { recursive: true });
    this.active = [id];
    return this.callAgent(id, { phase: 'probe', prompt: P.probe(this.ctx(id)), timeoutMinutes: 3 });
  }
}
