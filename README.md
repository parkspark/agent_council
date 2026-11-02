# Agent Council

Claude Code, Codex, Antigravity CLI 세 에이전트를 동시에 띄워서 **각자 제안 → 서로 비판 → 합의안 투표 → 실행 → 교차 리뷰**까지 진행하는 오케스트레이터입니다. 외부 패키지 없이 Node.js만으로 돌아갑니다.

```
          ┌──────── 1. 제안 (동시에, 서로 안 보고) ────────┐
 요청 ──▶ │  Claude Code        Codex        Antigravity  │
          └───────────────────────────────────────────────┘
                              │
          2. 토론 (N라운드: 서로의 입장을 읽고 동의/수정/반대, 모두 동의하면 조기 종료)
                              │
          3. 합의: 진행자가 최종안 작성 → 나머지가 찬반 투표 → 과반이면 성립
                              │
          4. 승인: 사용자가 대시보드(또는 터미널)에서 실행 여부 결정
                              │
          5. 실행 ─ lead    : 실행 담당 한 명이 구현 → 나머지가 diff 리뷰 → 지적 반영
                  └ compete : 셋이 각자 git worktree에서 구현 → 서로의 구현에 투표
```

## 동작 원리

각 CLI의 **헤드리스(비대화형) 모드**를 하위 프로세스로 실행하고, 출력 스트림(JSON)을 읽어 실시간으로 보여줍니다. 화면에 TUI를 띄워 키 입력을 흉내 내는 방식보다 훨씬 안정적이고, 각 CLI에 로그인된 구독/계정을 그대로 씁니다.

| 에이전트 | 실행 명령 (자동 구성) | 프롬프트 전달 |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose` | stdin |
| Codex | `codex exec --json --skip-git-repo-check -` | stdin |
| Antigravity | `agy --input-format stream-json --output-format stream-json` | stdin (JSON 한 줄) |

에이전트는 매 단계 **새 세션**으로 실행되고, 필요한 맥락(요청, 다른 에이전트의 입장, 합의안, diff)은 프롬프트에 담아 넘깁니다. 각 답변 끝의 ```json 블록으로 입장·투표·리뷰 판정을 읽습니다.

## 준비물

- Node.js 18.17 이상
- git (compete 모드와 정확한 diff 리뷰에 필요)
- 세 CLI 설치 및 로그인 (하나만 있어도 동작합니다)
  - Claude Code: `irm https://claude.ai/install.ps1 | iex` 또는 `npm install -g @anthropic-ai/claude-code`
  - Codex: `npm install -g @openai/codex`
  - Antigravity: `irm https://antigravity.google/cli/install.ps1 | iex`

## 빠른 시작 (Windows PowerShell)

```powershell
cd C:\path\to\agent_council

# 1) 가짜 에이전트로 화면과 흐름부터 체험 (사용량 0, 연습용 데모 프로젝트에서 실행)
npm run demo

# 2) 실제 CLI가 잘 연결되는지 확인 (에이전트마다 아주 짧은 요청 1회)
npm run doctor -- --live

# 3) 대시보드 실행 → 브라우저에서 http://localhost:4545
npm run ui
```

탐색기에서 `council-ui.cmd`(실제) 또는 `council-demo.cmd`(연습)를 더블클릭해도 됩니다.

### 터미널에서 바로 실행

```powershell
node bin\council.js "로그인 API에 입력값 검증 추가" --cwd C:\path\to\my-project
node bin\council.js "이 프로젝트 구조의 문제점과 개선안" --cwd ..\my-project --discuss-only
node bin\council.js "정렬 함수 성능 개선" --cwd ..\my-project --mode compete --rounds 1
node bin\council.js --help
```

| 옵션 | 설명 |
|---|---|
| `--cwd <경로>` | 에이전트가 작업할 프로젝트 폴더 |
| `--mode lead\|compete` | 한 명이 구현 + 리뷰(기본) / 셋이 경쟁 구현 후 투표 |
| `--discuss-only` | 토론과 합의안까지만 (파일 수정 없음) |
| `--rounds <n>` | 토론 라운드 수 (기본 2) |
| `--agents claude,codex` | 참여 에이전트 선택 |
| `--moderator <id>` / `--executor <id>` | 진행자 / 실행 담당 고정 |
| `-y`, `--yes` | 승인 없이 바로 실행 |
| `--brief` | 답변 전문 대신 요약만 출력 |
| `--mock` | 가짜 에이전트 사용 |

## 진행 방식 고르기

- **한 명이 구현 (lead)**: 진행자가 토론을 보고 실행 담당을 고릅니다. 나머지 둘이 변경 사항을 리뷰하고, 수정 요청이 있으면 담당자가 반영합니다(기본 1회).
- **셋이 경쟁 (compete)**: 커밋이 있는 git 저장소가 필요합니다. 에이전트마다 `council/<실행ID>-<에이전트>` 브랜치의 worktree가 만들어지고, 각자 구현한 뒤 서로의 결과에 투표합니다(자기 구현에는 투표 불가). 원본 브랜치는 건드리지 않으며, 우승 구현은 안내되는 `git merge` 명령으로 직접 합치면 됩니다. 정리는 `node bin\council.js clean --cwd <저장소> [--branches]`.
- **토론만**: 설계 검토, 버그 원인 분석, 기술 선택처럼 결론만 필요할 때.

## 설정 (`council.config.json`)

| 키 | 기본값 | 설명 |
|---|---|---|
| `debateRounds` | 2 | 토론 라운드 수 |
| `moderator` | `"claude"` | 합의안을 쓰는 진행자 |
| `executor` | `"auto"` | 실행 담당. `auto`면 진행자가 선택 |
| `executionMode` | `"lead"` | 기본 진행 방식 |
| `permission` | `"edits"` | 실행 단계 권한. `edits` = 파일 편집만 자동 승인, `full` = 명령 실행까지 모두 허용 |
| `consensusRetries` | 1 | 합의 실패 시 합의안을 다시 쓰는 횟수 |
| `maxFixRounds` | 1 | 리뷰 지적을 반영하는 횟수 |
| `timeouts` | 15분 / 40분 | 토론 단계 / 실행 단계 호출당 제한 시간 |
| `defaultCwd` | `null` | 대시보드에 미리 채울 작업 폴더 |
| `agents.<id>.command` | `claude` / `codex` / `agy` | 실행 파일 이름 또는 전체 경로 |
| `agents.<id>.model` | `null` | 모델 지정 (각 CLI의 `--model` / `-m`로 전달) |
| `agents.<id>.enabled` | `true` | 끄면 회의에서 제외 |
| `agents.<id>.extraArgs` | `[]` | 추가로 붙일 인자 |
| `agents.<id>.inputMode` | 자동 | `stdin` / `stream-json` / `arg` (프롬프트 전달 방식) |
| `agents.<id>.permissionArgs` | 자동 | `{ "read": [...], "edits": [...], "full": [...] }` 권한 플래그 직접 지정 |
| `agents.<id>.shellHint` | `true` | 셸 명령 권한이 없는 단계에서 "셸 명령을 쓰지 말라"는 안내를 프롬프트에 붙일지 |

권한 단계별 기본 플래그:

| | 토론·리뷰 (read) | 실행 edits | 실행 full |
|---|---|---|---|
| Claude Code | `--permission-mode dontAsk --disallowedTools Edit Write NotebookEdit` | `--permission-mode acceptEdits` | `--dangerously-skip-permissions` |
| Codex | `--sandbox read-only` | `--full-auto` | `--dangerously-bypass-approvals-and-sandbox` |
| Antigravity | `--mode plan` | `--mode accept-edits` | `--dangerously-skip-permissions` |

## 안전 장치

- 토론·투표·리뷰 단계는 읽기 전용 권한으로 실행합니다.
- 파일을 바꾸기 전에 반드시 사용자 승인을 받습니다(`--yes`로 끌 수 있음). 승인할 때 추가 지시를 덧붙일 수 있습니다.
- 에이전트에게 commit/push를 하지 말라고 지시합니다. 오케스트레이터는 push를 하지 않으며, 커밋은 compete 모드의 전용 worktree 브랜치에서만 만듭니다.
- 대시보드 서버는 `127.0.0.1`에만 열리고, 다른 사이트에서 보낸 실행 요청은 거부합니다.

## 기록

실행마다 `runs\<실행ID>\` 아래에 남습니다.

- `transcript.md`: 사람이 읽는 회의록 (모든 발언, 투표, diff, 리뷰)
- `events.jsonl`: 대시보드 다시 보기용 이벤트 기록
- `raw\NN-<단계>-<에이전트>.prompt.md / .out.jsonl`: 각 호출의 실제 프롬프트와 CLI 원본 출력 (문제 해결용)

대시보드 왼쪽 **지난 회의**에서 예전 회의를 다시 볼 수 있습니다.

## 사용량 감 잡기

세 에이전트, 토론 2라운드, lead 모드 기준 한 번의 회의에 대략 **15~18회** 호출합니다.
(제안 3 + 토론 6 + 합의안 1 + 투표 2 + 실행 1 + 리뷰 2 (+ 반영 1 + 재리뷰 2))
가볍게 쓰려면 `--rounds 1`이나 `--agents claude,codex`로 줄이세요. 모두 동의하면 토론은 일찍 끝납니다.

## 문제 해결

- **'xxx' 명령을 찾을 수 없음**: `where claude`, `where codex`, `where agy`로 확인하세요. PATH에 없으면 `agents.<id>.command`에 전체 경로를 적습니다.
- **어떤 에이전트만 계속 실패**: `npm run doctor -- --live` 결과에 나오는 `raw` 폴더의 `.out.jsonl`을 열어 보면 CLI의 실제 오류 메시지가 있습니다. 대부분 로그인 만료나 플래그 차이입니다.
- **Antigravity: `jetski: no output produced — a tool required the "command" permission ...`**
  agy 헤드리스 모드는 워크스페이스 파일 읽기·쓰기는 자동 허용하지만 터미널 명령은 기본값이 "묻기"라서 자동 거부되고, 그러면 답변 없이 끝납니다. 오케스트레이터는 agy에게 처음부터 "셸 명령 없이 내장 파일 보기·검색 도구만 쓰라"고 안내하고, 그래도 이 오류가 나면 안내를 강화해 **한 번 자동 재시도**합니다. agy가 코드를 볼 때 읽기 전용 명령도 쓰게 하고 싶다면 아래 둘 중 하나를 고르세요.
  1. (권장) agy 사용자 설정 `%USERPROFILE%\.gemini\antigravity-cli\settings.json`에 읽기 전용 명령만 허용 규칙으로 추가하고, `council.config.json`에서 `"antigravity": { "shellHint": false }`로 셸 금지 안내를 끕니다. 이 설정은 대화형 agy에도 똑같이 적용됩니다.
     ```json
     {
       "permissions": {
         "allow": [
           "command(git status)", "command(git diff)", "command(git log)", "command(git show)",
           "command(rg)", "command(dir)", "command(type)", "command(findstr)",
           "command(Get-ChildItem)", "command(Get-Content)", "command(Select-String)"
         ]
       }
     }
     ```
     허용 목록에 없는 명령을 쓰면 같은 오류가 나지만, 자동 재시도로 넘어갑니다.
  2. (주의) 토론 단계에서도 모든 명령을 허용: `"antigravity": { "permissionArgs": { "read": ["--mode", "plan", "--dangerously-skip-permissions"] } }`. 읽기 단계에서도 agy가 아무 명령이나 실행할 수 있으니 신뢰하는 프로젝트에서만 쓰세요.
- **Antigravity 응답이 비어 있음 (다른 이유)**: CLI 버전에 따라 stdin 입력 방식이 다를 수 있습니다. `"antigravity": { "inputMode": "arg" }`로 바꿔 보세요(프롬프트를 `-p` 인자로 넘김).
- **Codex가 Windows에서 샌드박스 오류**: `"codex": { "permissionArgs": { "read": [], "edits": ["--full-auto"] } }`처럼 조정하거나 WSL에서 실행하세요.
- **실행 단계에서 테스트를 못 돌림**: 기본 `permission: "edits"`는 파일 편집만 허용합니다. 명령 실행까지 맡기려면 `"permission": "full"`로 바꾸세요(신뢰하는 프로젝트에서만).
- **시간 초과**: `timeouts.discussMinutes`, `timeouts.executeMinutes`를 늘리세요.

## 구조

```
bin/council.js          CLI 진입점 (실행, ui, doctor, runs, clean)
src/orchestrator.js     회의 진행 로직 (제안 → 토론 → 합의 → 승인 → 실행 → 리뷰)
src/prompts.js          단계별 프롬프트 템플릿 (여기를 고치면 토론 스타일이 바뀝니다)
src/agents/*.js         CLI별 어댑터: 실행 인자 구성과 출력 파싱
src/process.js          Windows .cmd/.exe 처리, stdin 전달, 시간 초과·취소
src/protocol.js         답변 끝 JSON 판정 읽기
src/git.js              diff 수집, worktree 관리
src/server.js           대시보드 서버 (HTTP + Server-Sent Events)
src/terminal.js         터미널 출력
src/transcript.js       회의록 생성
public/                 대시보드 화면 (index.html, style.css, app.js)
mock/fake-agent.js      세 CLI 출력 형식을 흉내 내는 가짜 에이전트
test/                   npm test
```

## 다음에 해볼 만한 것

- 세션 이어가기: 매 단계 새 세션 대신 `claude --resume`, `codex exec resume`, `agy --conversation`으로 각자의 맥락 유지
- 역할 분담 모드: 합의안을 하위 작업으로 나눠 에이전트별로 다른 worktree에서 동시에 구현한 뒤 병합
- 에이전트별 페르소나: 보안 검토 담당, 테스트 담당처럼 역할을 프롬프트에 부여
