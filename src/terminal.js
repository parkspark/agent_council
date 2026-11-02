// 터미널 출력: 오케스트레이터 이벤트를 색깔 있는 로그로 보여줍니다.

import { ADAPTERS, agentName } from './agents/index.js';
import { stripTrailingJson } from './protocol.js';
import { callTitle, fmtDuration, STATUS_LABEL, STANCE_LABEL, VOTE_LABEL, VERDICT_LABEL } from './labels.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = esc('2');
const bold = esc('1');
const red = esc('31');
const green = esc('32');
const yellow = esc('33');
const cyan = esc('36');

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (s) => (useColor ? `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${s}\x1b[0m` : String(s));
}
const agentColor = (id) => rgb(ADAPTERS[id]?.color || '#999999');
const tag = (id) => agentColor(id)(bold(agentName(id)));

function width() {
  return Math.max(60, Math.min(process.stdout.columns || 100, 140));
}

// 한글 같은 전각 문자는 터미널에서 두 칸을 차지합니다.
function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1;
  }
  return w;
}

function chipFor(ev) {
  const j = ev.json || {};
  if (ev.phase === 'debate' && j.stance) return `입장: ${STANCE_LABEL[j.stance] || j.stance}`;
  if (ev.phase === 'vote' && j.vote) return `투표: ${VOTE_LABEL[j.vote] || j.vote}`;
  if (ev.phase === 'review' && j.verdict) return `리뷰: ${VERDICT_LABEL[j.verdict] || j.verdict}`;
  if (ev.phase === 'judge' && j.best) return `선택: ${agentName(j.best)}`;
  if (ev.phase === 'synthesize' && j.executor) return `실행 담당 제안: ${agentName(j.executor)}`;
  if (j.summary) return j.summary;
  return '';
}

export function attachTerminal(council, { brief = false } = {}) {
  council.on('event', (ev) => {
    const w = width();
    switch (ev.type) {
      case 'run.started':
        console.log('');
        console.log(bold('🏛  Agent Council'));
        console.log(dim(`   요청   `) + ev.task.split('\n')[0].slice(0, w - 12));
        console.log(dim(`   위치   `) + ev.cwd);
        console.log(dim(`   모드   `) + (ev.discussOnly ? '토론만' : `${ev.mode} · 권한 ${ev.permission}`) + (ev.mock ? yellow(' · MOCK') : ''));
        console.log(dim(`   참여   `) + ev.agents.map((a) => tag(a.id)).join(dim(' · ')));
        break;
      case 'phase': {
        const title = ` ${ev.title} `;
        console.log('\n' + cyan('━━' + bold(title) + '━'.repeat(Math.max(4, w - strWidth(title) - 4))));
        break;
      }
      case 'agent.started':
        console.log(`${agentColor(ev.agent)('●')} ${tag(ev.agent)} ${dim(callTitle(ev.phase, ev.round) + ' 시작…')}`);
        break;
      case 'agent.activity':
        if (!brief && (ev.kind === 'tool' || ev.kind === 'error')) {
          console.log(`  ${agentColor(ev.agent)('│')} ${dim(ev.text.slice(0, w - 6))}`);
        }
        break;
      case 'agent.completed': {
        const head = `${tag(ev.agent)} · ${callTitle(ev.phase, ev.round)}${ev.label ? ` (${ev.label})` : ''} ${dim('(' + fmtDuration(ev.durationMs) + ')')}`;
        if (!ev.ok) {
          console.log(`${red('✗')} ${head} ${red(ev.error)}`);
          break;
        }
        const chip = chipFor(ev);
        console.log(`${green('✓')} ${head}${chip ? '  ' + yellow('▸ ' + chip) : ''}`);
        if (!brief) {
          const bar = agentColor(ev.agent)('│ ');
          for (const line of stripTrailingJson(ev.text).split('\n')) console.log(bar + line);
          console.log('');
        }
        if (ev.warning) console.log(yellow(`  ⚠ ${ev.warning}`));
        break;
      }
      case 'debate.round':
        console.log(
          dim('  입장: ') +
            Object.entries(ev.stances).map(([a, s]) => `${tag(a)} ${STANCE_LABEL[s] || s}`).join(dim(' · ')) +
            (ev.allAgree ? green('  → 전원 동의') : ''),
        );
        break;
      case 'consensus.vote':
        if (!ev.votes.length) {
          console.log(`  ${bold('투표')} ${dim('투표할 다른 에이전트가 없어 진행자 안을 그대로 씁니다.')}`);
          break;
        }
        console.log(
          `  ${bold('투표')} ${tag(ev.moderator)} 진행자 · ` +
            ev.votes.map((v) => `${tag(v.agent)} ${v.vote === 'approve' ? green(VOTE_LABEL[v.vote]) : red(VOTE_LABEL[v.vote] || v.vote)}`).join(dim(' · ')) +
            `  → ${ev.approved ? green('합의 성립') : red('합의 실패')} ${dim(`(찬성 ${ev.yes}/${ev.needed} 필요)`)}`,
        );
        for (const v of ev.votes) if (v.vote === 'reject' && v.reason) console.log(dim(`    ${agentName(v.agent)}: ${v.reason}`));
        break;
      case 'consensus.final':
        if (ev.executor) console.log(`  ${bold('실행 담당')} ${tag(ev.executor)}`);
        break;
      case 'changes':
        console.log(`  ${bold('변경 사항')} ${tag(ev.agent)}${ev.branch ? dim(' ' + ev.branch) : ''}`);
        console.log(ev.empty ? dim('    (변경 없음)') : dim((ev.stat || ev.files.join('\n')).split('\n').map((l) => '    ' + l).join('\n')));
        break;
      case 'review.round':
        for (const r of ev.reviews) {
          const v = r.verdict === 'approve' ? green(VERDICT_LABEL[r.verdict]) : r.verdict === 'changes' ? yellow(VERDICT_LABEL[r.verdict]) : dim(VERDICT_LABEL[r.verdict] || r.verdict);
          console.log(`  ${tag(r.agent)} ${v}`);
          for (const i of r.issues || []) console.log(dim(`    - ${i}`));
        }
        break;
      case 'compete.result':
        console.log(`  ${bold('구현 투표')} ` + Object.entries(ev.tally).map(([a, n]) => `${tag(a)} ${n}표`).join(dim(' · ')) + `  → 우승 ${tag(ev.winner)}`);
        break;
      case 'warning':
        console.log(yellow(`⚠ ${ev.message}`));
        break;
      case 'run.cancelling':
        console.log(yellow('⏹ 취소 중… 실행 중인 에이전트를 종료합니다.'));
        break;
      case 'run.completed': {
        const ok = ['completed', 'discussed'].includes(ev.status);
        console.log('\n' + (ok ? green : ev.status === 'failed' ? red : yellow)(bold(`■ ${STATUS_LABEL[ev.status] || ev.status}`)) + ` ${ev.summary}`);
        if (ev.mergeHint) console.log(dim('  적용: ') + ev.mergeHint);
        if (ev.transcript) console.log(dim('  회의록: ') + ev.transcript);
        console.log(dim(`  소요 시간: ${fmtDuration(ev.durationMs)}`));
        break;
      }
      default:
        break;
    }
  });
}
