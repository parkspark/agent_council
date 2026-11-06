// OpenAI Codex CLI 어댑터
//   codex exec --json --skip-git-repo-check --sandbox read-only -   (마지막 "-" = 프롬프트를 stdin에서 읽기)
// --json 출력(JSONL)의 주요 줄:
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"item.started","item":{"type":"command_execution","command":"..."}}
//   {"type":"item.completed","item":{"type":"agent_message","text":"최종 답변"}}
//   {"type":"turn.completed","usage":{...}}  /  {"type":"turn.failed","error":{...}}

import { clip, toolLabel, tryJson } from './util.js';

export const PERMISSIONS = {
  read: ['--sandbox', 'read-only'],
  edits: ['--full-auto'], // workspace-write 샌드박스
  full: ['--dangerously-bypass-approvals-and-sandbox'],
};

export default {
  id: 'codex',
  name: 'Codex',
  short: 'Codex',
  color: '#10A37F',
  defaultCommand: 'codex',
  defaultInputMode: 'stdin',
  PERMISSIONS,

  buildArgs({ inputMode, prompt, model, permArgs, extraArgs = [] }) {
    const a = ['exec', '--json', '--skip-git-repo-check', ...permArgs];
    if (model) a.push('-m', model);
    a.push(...extraArgs);
    a.push(inputMode === 'arg' ? prompt : '-');
    return a;
  },

  formatInput(prompt, inputMode) {
    return inputMode === 'stdin' ? prompt : null;
  },

  createParser() {
    let sessionId = null;
    let lastMessage = '';
    let error = null;
    let done = false;
    const plain = [];

    return {
      push(line) {
        const o = tryJson(line);
        if (!o) {
          plain.push(line);
          return [];
        }
        const ev = [];
        const t = o.type;
        const it = o.item;

        if (t === 'thread.started') {
          sessionId = o.thread_id || sessionId;
          ev.push({ kind: 'status', text: '세션 시작' });
        } else if ((t === 'item.started' || t === 'item.completed') && it) {
          const ty = it.type || it.item_type;
          const done = t === 'item.completed';
          if (ty === 'agent_message' || ty === 'assistant_message') {
            if (done && typeof it.text === 'string') {
              lastMessage = it.text;
              ev.push({ kind: 'text', text: it.text });
            }
          } else if (ty === 'reasoning') {
            if (done && it.text) ev.push({ kind: 'thinking', text: it.text });
          } else if (ty === 'command_execution') {
            if (!done) ev.push({ kind: 'tool', text: `$ ${clip(it.command, 140)}` });
            else if (typeof it.exit_code === 'number' && it.exit_code !== 0) {
              ev.push({ kind: 'status', text: `명령 종료 코드 ${it.exit_code}` });
            }
          } else if (ty === 'file_change') {
            if (done) {
              const files = (it.changes || []).map((c) => c.path).filter(Boolean);
              ev.push({ kind: 'tool', text: `파일 변경 · ${clip(files.join(', ') || '(알 수 없음)', 140)}` });
            }
          } else if (ty === 'mcp_tool_call') {
            if (!done) ev.push({ kind: 'tool', text: `${it.server || 'mcp'}.${it.tool || 'tool'}` });
          } else if (ty === 'web_search') {
            if (!done) ev.push({ kind: 'tool', text: `웹 검색 · ${clip(it.query, 120)}` });
          } else if (ty === 'error') {
            if (it.message) ev.push({ kind: 'status', text: clip(it.message, 200) });
          } else if (!done && ty) {
            ev.push({ kind: 'tool', text: toolLabel(ty, it) });
          }
        } else if (t === 'turn.completed') {
          done = true;
        } else if (t === 'turn.failed') {
          done = true;
          error = o.error?.message || 'turn failed';
          ev.push({ kind: 'error', text: error });
        } else if (t === 'error') {
          // 재연결 같은 일시적 오류도 이 이벤트로 옵니다. 최종 답변이 있으면 무시됩니다.
          error = o.message || 'error';
          ev.push({ kind: 'status', text: clip(error, 200) });
        } else if (o.msg && typeof o.msg === 'object') {
          // 구버전(0.4x 이전) 이벤트 형식 호환
          const m = o.msg;
          if (m.type === 'session_configured') sessionId = m.session_id || sessionId;
          else if (m.type === 'agent_message' && m.message) {
            lastMessage = m.message;
            ev.push({ kind: 'text', text: m.message });
          } else if (m.type === 'exec_command_begin') {
            ev.push({ kind: 'tool', text: `$ ${clip([].concat(m.command || []).join(' '), 140)}` });
          } else if (m.type === 'task_complete') done = true;
          else if (m.type === 'error') error = m.message || 'error';
        }
        return ev;
      },
      /** 턴이 끝났는지 (exec 모드는 턴 하나로 끝나므로 이 뒤에는 출력이 없습니다) */
      isDone() {
        return done;
      },
      result() {
        return { text: lastMessage || plain.join('\n'), sessionId, costUsd: null, error };
      },
    };
  },
};
