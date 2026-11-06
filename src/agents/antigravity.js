// Google Antigravity CLI(agy) 어댑터
//   agy --input-format stream-json --output-format stream-json   (프롬프트는 stdin에 JSON 한 줄)
//   입력: {"event":"user","message":{"content":"..."}}
// stream-json 출력의 주요 줄:
//   {"event":"init","conversation_id":"...","init":{"cwd":"..."}}
//   {"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"..."}}
//   {"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"최종 답변"}}
// 참고: https://antigravity.google/docs/cli/headless

import { clip, tryJson } from './util.js';

export const PERMISSIONS = {
  read: ['--mode', 'plan'],
  edits: ['--mode', 'accept-edits'],
  full: ['--dangerously-skip-permissions'],
};

// 헤드리스 모드에서 agy는 워크스페이스 파일 읽기/쓰기는 자동 허용하지만,
// 터미널 명령은 기본값이 "ask"라서 자동 거부되고, 그러면 답변 없이 끝나 버립니다.
// ("jetski: no output produced — a tool required the "command" permission ...")
// 그래서 기본 권한(read/edits)으로 실행할 때는 셸 명령을 쓰지 말라고 미리 알려 줍니다.
const READ_TOOLS = 'list_dir, find_by_name, grep_search, view_file';

const NOTES = {
  read: [
    '## 실행 환경 제약 (중요)',
    '당신은 헤드리스 모드로 실행 중이라 터미널(셸) 명령 권한이 없습니다. run_command 도구(Get-ChildItem, dir, ls, git 등 모든 셸 명령)를 한 번이라도 호출하면 작업 전체가 답변 없이 실패합니다.',
    `코드를 살펴볼 때는 ${READ_TOOLS} 도구만 사용하세요. 명령으로만 확인할 수 있는 내용은 "확인 필요"로 적으세요.`,
  ].join('\n'),
  edits: [
    '## 실행 환경 제약 (중요)',
    '작업 디렉터리 안의 파일 생성·수정은 가능하지만 터미널(셸) 명령 권한은 없습니다. run_command 도구를 한 번이라도 호출하면 작업 전체가 답변 없이 실패합니다.',
    `코드는 ${READ_TOOLS}로 살펴보고, 파일 도구로 수정하세요. 빌드나 테스트는 실행하지 말고, 대신 실행해 볼 명령을 보고서의 "검증 방법과 결과"에 적으세요.`,
  ].join('\n'),
};

const RETRY_NOTE = [
  '## 재시도 안내',
  '이전 시도는 run_command(셸 명령)를 호출했다가 권한이 거부되어 답변 없이 실패했습니다.',
  `이번에는 run_command를 절대 호출하지 마세요. ${READ_TOOLS} 도구와 위에 주어진 정보만으로 답하세요.`,
].join('\n');

// 실제 출력 예:
// {"step_type":"tool","state":"ACTIVE","tool_name":"run_command",
//  "tool_info":{"name":"run_command","parameters":{"CommandLine":"Get-ChildItem -Recurse ..."}}}
function stepLabel(s) {
  const info = (s.tool_info && typeof s.tool_info === 'object' && s.tool_info)
    || (s.tool && typeof s.tool === 'object' && s.tool) || {};
  const name = s.tool_name || info.name || s.name || s.title || '';
  const params = info.parameters || info.input || {};
  const detail =
    params.CommandLine || params.AbsolutePath || params.DirectoryPath || params.SearchPath ||
    params.Query || params.Pattern || params.path || params.file_path || params.command || params.query ||
    Object.values(params).find((v) => typeof v === 'string') || s.summary || s.description || '';
  if (!name && !detail) return null;
  return `${name || 'tool'}${detail ? ' · ' + clip(detail, 120) : ''}`;
}

export default {
  id: 'antigravity',
  name: 'Antigravity',
  short: 'Antigravity',
  color: '#4C8DF6',
  defaultCommand: 'agy',
  defaultInputMode: 'stream-json',
  PERMISSIONS,
  NOTES,
  RETRY_NOTE,

  /** 권한 거부로 답변 없이 끝난 경우인지 (이 경우 한 번 자동 재시도) */
  isPermissionError(err) {
    return /auto-denied|permission|no output produced/i.test(String(err || ''));
  },

  buildArgs({ inputMode, prompt, model, permArgs, extraArgs = [], timeoutMinutes }) {
    const a = [];
    if (inputMode === 'arg') a.push('-p', prompt, '--output-format', 'stream-json');
    else if (inputMode === 'stdin') a.push('-p', '--output-format', 'stream-json');
    else a.push('--input-format', 'stream-json', '--output-format', 'stream-json');
    if (model) a.push('--model', model);
    a.push(...permArgs);
    if (timeoutMinutes) a.push('--print-timeout', `${timeoutMinutes}m`);
    a.push(...extraArgs);
    return a;
  },

  formatInput(prompt, inputMode) {
    if (inputMode === 'stream-json') return JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
    if (inputMode === 'stdin') return prompt;
    return null;
  },

  createParser() {
    let sessionId = null;
    let finalText = null;
    let lastText = '';
    let error = null;
    const steps = new Map(); // step_index → 누적 텍스트
    const announced = new Set();
    const plain = [];
    let done = false;

    const handleResult = (r) => {
      done = true;
      sessionId = r.conversation_id || sessionId;
      if (typeof r.response === 'string') finalText = r.response;
      const denied = Array.isArray(r.denied_actions) ? r.denied_actions : [];
      if (r.error) error = typeof r.error === 'string' ? r.error : r.error.message || JSON.stringify(r.error);
      else if (!finalText?.trim() && denied.length) {
        // 실제로는 status:"SUCCESS", response:"" 와 함께 거부된 동작 목록이 옵니다.
        error = `권한이 거부되어 답변 없이 끝났습니다 (permission denied: ${denied.map((d) => d.display_name || d.action).join(', ')})`;
      } else if (r.status && r.status !== 'SUCCESS' && !finalText) error = r.status;
    };

    return {
      push(line) {
        const o = tryJson(line);
        if (!o) {
          plain.push(line);
          return [];
        }
        const ev = [];
        if (o.event === 'init') {
          sessionId = o.conversation_id || sessionId;
          ev.push({ kind: 'status', text: '세션 시작' });
        } else if (o.event === 'step_update') {
          const s = o.step_update || {};
          const idx = s.step_index ?? -1;
          if (s.step_type === 'agent_response') {
            if (typeof s.text === 'string') steps.set(idx, s.text);
            else if (s.text_delta) steps.set(idx, (steps.get(idx) || '') + s.text_delta);
            if (s.state === 'DONE' && steps.get(idx)?.trim()) {
              lastText = steps.get(idx);
              ev.push({ kind: 'text', text: lastText });
            }
          } else if (s.step_type === 'tool') {
            if (!announced.has(idx)) {
              const label = stepLabel(s);
              if (label || s.state === 'DONE') {
                announced.add(idx);
                ev.push({ kind: 'tool', text: label || '도구 실행' });
              }
            }
            if (s.state === 'ERROR') {
              const name = s.tool_name || s.tool_info?.name || '도구';
              const msg = s.tool_info?.error?.message || s.error?.message;
              ev.push({ kind: 'error', text: msg ? `${name} 실패 · ${clip(msg, 160)}` : `${name} 실패` });
            }
          }
        } else if (o.event === 'result') {
          handleResult(o.result || {});
        } else if (o.response !== undefined && o.status) {
          handleResult(o); // --output-format json 단일 응답 형식
        } else if (o.event === 'error' || o.error) {
          error = o.message || o.error?.message || String(o.error);
          ev.push({ kind: 'error', text: clip(error, 200) });
        }
        return ev;
      },
      /**
       * 최종 result 이벤트를 받았는지. agy는 답변을 다 보낸 뒤에도 프로세스가 끝나지 않고
       * 멈춰 있을 때가 있어서(실측: result 후 14분 대기), 러너가 이 신호를 보고 프로세스를 정리합니다.
       */
      isDone() {
        return done;
      },
      result() {
        return {
          text: (finalText && finalText.trim()) ? finalText : (lastText || plain.join('\n')),
          sessionId,
          costUsd: null,
          error,
        };
      },
    };
  },
};
