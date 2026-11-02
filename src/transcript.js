// 이벤트 기록을 사람이 읽기 좋은 회의록(transcript.md)으로 변환

import fs from 'node:fs';
import path from 'node:path';
import { agentName } from './agents/index.js';
import { callTitle, fmtDuration, STATUS_LABEL, STANCE_LABEL, VOTE_LABEL, VERDICT_LABEL } from './labels.js';

export function buildTranscript(meta, events) {
  const L = [];
  L.push('# Agent Council 회의록', '');
  L.push(`- 실행 ID: \`${meta.runId}\``);
  L.push(`- 시작: ${new Date(meta.startedAt).toLocaleString('ko-KR')}`);
  L.push(`- 작업 디렉터리: \`${meta.cwd}\``);
  L.push(`- 모드: ${meta.discussOnly ? '토론만' : meta.mode}`);
  L.push(`- 참여: ${(meta.agents || []).map(agentName).join(', ') || '-'}`);
  L.push(`- 결과: **${STATUS_LABEL[meta.status] || meta.status}** — ${meta.summary || ''}`);
  L.push(`- 소요 시간: ${fmtDuration(meta.durationMs)}`);
  L.push('', '## 요청', '', meta.task, '');

  for (const ev of events) {
    switch (ev.type) {
      case 'phase':
        L.push(`## ${ev.title}`, '');
        break;
      case 'warning':
        L.push(`> ⚠️ ${ev.message}`, '');
        break;
      case 'agent.completed':
        L.push(`### ${agentName(ev.agent)} · ${callTitle(ev.phase, ev.round)}${ev.label ? ` (${ev.label})` : ''} (${fmtDuration(ev.durationMs)})`, '');
        if (ev.ok) L.push(ev.text, '');
        else L.push(`> ❌ 실패: ${ev.error}`, '');
        break;
      case 'debate.round':
        L.push(
          `**토론 ${ev.round} 결과:** ` +
            Object.entries(ev.stances).map(([a, s]) => `${agentName(a)}=${STANCE_LABEL[s] || s}`).join(', ') +
            (ev.allAgree ? ' → 전원 동의, 토론 종료' : ''),
          '',
        );
        break;
      case 'consensus.vote':
        L.push(`**투표 결과 (${ev.attempt}차):** 찬성 ${ev.yes} / 반대 ${ev.no} (필요 ${ev.needed}) → ${ev.approved ? '합의 성립' : '합의 실패'}`);
        L.push(`- ${agentName(ev.moderator)}: 진행자(찬성)`);
        for (const v of ev.votes) {
          L.push(`- ${agentName(v.agent)}: ${VOTE_LABEL[v.vote] || v.vote}${v.reason ? ' — ' + v.reason : ''}`);
          for (const m of v.mustFix || []) L.push(`  - 필수 수정: ${m}`);
        }
        L.push('');
        break;
      case 'consensus.final':
        if (ev.executor) L.push(`**실행 담당:** ${agentName(ev.executor)}`, '');
        break;
      case 'approval.resolved':
        L.push(`**사용자 승인:** ${ev.approved ? '실행' : '취소'}${ev.auto ? ' (자동)' : ''}${ev.note ? ` — 추가 지시: ${ev.note}` : ''}`, '');
        break;
      case 'changes':
        L.push(`#### 변경 사항 · ${agentName(ev.agent)}${ev.branch ? ` (\`${ev.branch}\`)` : ''}`, '');
        if (ev.empty) L.push('(변경 없음)', '');
        else L.push('```', ev.stat || ev.files.join('\n'), '```', '', '<details><summary>diff 보기</summary>', '', '```diff', ev.diff, '```', '', '</details>', '');
        break;
      case 'review.round':
        L.push(`**리뷰 ${ev.round}차:**`);
        for (const r of ev.reviews) {
          L.push(`- ${agentName(r.agent)}: ${VERDICT_LABEL[r.verdict] || r.verdict}`);
          for (const i of r.issues || []) L.push(`  - ${i}`);
        }
        L.push('');
        break;
      case 'compete.result':
        L.push(`**구현 투표:** ${Object.entries(ev.tally).map(([a, n]) => `${agentName(a)} ${n}표`).join(', ')} → 우승 ${agentName(ev.winner)}`);
        for (const b of ev.ballots || []) L.push(`- ${agentName(b.agent)} → ${b.best ? agentName(b.best) : '무효'}${b.reason ? ' — ' + b.reason : ''}`);
        L.push('', '브랜치:', ...Object.entries(ev.branches).map(([a, br]) => `- ${agentName(a)}: \`${br}\``), '');
        break;
      default:
        break;
    }
  }
  L.push('## 결과', '', `**${STATUS_LABEL[meta.status] || meta.status}** — ${meta.summary || ''}`);
  if (meta.mergeHint) L.push('', `적용: \`${meta.mergeHint}\` (대상 저장소에서 실행)`);
  return L.join('\n') + '\n';
}

export function writeTranscript(runDir, meta, events) {
  const file = path.join(runDir, 'transcript.md');
  fs.writeFileSync(file, buildTranscript(meta, events));
  return file;
}
