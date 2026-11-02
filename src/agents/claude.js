// Claude Code CLI 어댑터
//   claude -p --output-format stream-json --verbose   (프롬프트는 stdin)
// stream-json 출력의 주요 줄:
//   {"type":"system","subtype":"init","session_id":"...","model":"..."}
//   {"type":"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}
//   {"type":"result","subtype":"success","is_error":false,"result":"최종 답변","session_id":"..."}

import { toolLabel, tryJson } from './util.js';

// 권한 단계별 플래그. council.config.json 의 agents.claude.permissionArgs 로 덮어쓸 수 있습니다.
export const PERMISSIONS = {
  // 토론·리뷰: 읽기만 허용. dontAsk = 미리 허용되지 않은 도구는 묻지 않고 거부
  read: ['--permission-mode', 'dontAsk', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit'],
  // 실행: 파일 편집 자동 승인 (셸 명령은 거부됨)
  edits: ['--permission-mode', 'acceptEdits'],
  // 실행: 모든 권한 (테스트 실행 등까지 자동)
  full: ['--dangerously-skip-permissions'],
};

// 기본 권한(edits)에서는 Bash가 거부되므로 테스트를 돌리려다 헤매지 않게 미리 알려 줍니다.
const NOTES = {
  edits: [
    '## 실행 환경 제약',
    '파일 편집은 자동 승인되지만 셸(Bash) 명령은 거부됩니다.',
    '빌드나 테스트는 실행하지 말고, 대신 실행해 볼 명령을 보고서의 "검증 방법과 결과"에 적으세요.',
  ].join('\n'),
};

export default {
  id: 'claude',
  name: 'Claude Code',
  short: 'Claude',
  color: '#D97757',
  defaultCommand: 'claude',
  defaultInputMode: 'stdin',
  PERMISSIONS,
  NOTES,

  buildArgs({ inputMode, prompt, model, permArgs, extraArgs = [] }) {
    const a = ['-p'];
    if (inputMode === 'arg') a.push(prompt);
    a.push('--output-format', 'stream-json', '--verbose');
    if (model) a.push('--model', model);
    a.push(...extraArgs);
    a.push(...permArgs); // --disallowedTools 는 가변 인자라 맨 뒤에 둡니다
    return a;
  },

  formatInput(prompt, inputMode) {
    return inputMode === 'stdin' ? prompt : null;
  },

  createParser() {
    let sessionId = null;
    let finalText = null;
    let lastText = '';
    let error = null;
    let costUsd = null;
    const plain = [];

    return {
      push(line) {
        const o = tryJson(line);
        if (!o) {
          plain.push(line);
          return [];
        }
        const ev = [];
        if (o.type === 'system' && o.subtype === 'init') {
          sessionId = o.session_id || sessionId;
          ev.push({ kind: 'status', text: `세션 시작${o.model ? ' · ' + o.model : ''}` });
        } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
          for (const c of o.message.content) {
            if (c.type === 'text' && c.text?.trim()) {
              lastText = c.text;
              ev.push({ kind: 'text', text: c.text });
            } else if (c.type === 'tool_use') {
              ev.push({ kind: 'tool', text: toolLabel(c.name, c.input) });
            } else if (c.type === 'thinking' && c.thinking) {
              ev.push({ kind: 'thinking', text: c.thinking });
            }
          }
        } else if (o.type === 'result') {
          sessionId = o.session_id || sessionId;
          if (typeof o.result === 'string') finalText = o.result;
          if (typeof o.total_cost_usd === 'number') costUsd = o.total_cost_usd;
          if (o.is_error) error = (typeof o.result === 'string' && o.result) || o.subtype || 'error';
          if (Array.isArray(o.permission_denials) && o.permission_denials.length) {
            ev.push({ kind: 'status', text: `권한 거부 ${o.permission_denials.length}건` });
          }
        }
        return ev;
      },
      result() {
        return {
          text: (finalText && finalText.trim()) ? finalText : (lastText || plain.join('\n')),
          sessionId,
          costUsd,
          error,
        };
      },
    };
  },
};
