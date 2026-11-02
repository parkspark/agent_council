// 웹 대시보드 서버 (외부 의존성 없음: node:http + Server-Sent Events)
//
// 보안: 에이전트에게 파일 수정 권한을 주는 도구이므로
//   - 127.0.0.1 에만 바인딩
//   - Host 헤더 검사(DNS rebinding 방지)
//   - POST는 JSON + 같은 Origin 만 허용(다른 사이트에서 몰래 실행 요청 방지)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AGENT_IDS, normalizeAgentId } from './agents/index.js';
import { Council, ROOT, RUNS_DIR, agentInfo } from './orchestrator.js';
import { resolveCommand, IS_WIN } from './process.js';
import { ensureDemoProject } from './demo.js';

const PUBLIC = path.join(ROOT, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('요청 본문이 너무 큽니다.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON 형식이 아닙니다.'));
      }
    });
    req.on('error', reject);
  });
}

export function listRuns(limit = 40) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR)
    .filter((d) => /^\d{8}-\d{6}-\w+$/.test(d))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((id) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'result.json'), 'utf8'));
        return { runId: id, status: m.status, task: m.task, summary: m.summary, mode: m.mode, discussOnly: m.discussOnly, startedAt: m.startedAt };
      } catch {
        return { runId: id, status: 'unknown', task: '(기록 없음 또는 진행 중)' };
      }
    });
}

function openBrowser(url) {
  const [cmd, args] = IS_WIN ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch { /* 브라우저를 못 열면 주소만 출력 */ }
}

export async function startServer({ config, port = 4545, mock = false, open = true, host = '127.0.0.1' }) {
  const state = { council: null, events: [], pendingApproval: null, clients: new Set() };

  const agents = await Promise.all(AGENT_IDS.map(async (id) => {
    const c = config.agents[id] || {};
    const r = mock ? { found: true, how: 'mock', path: null } : await resolveCommand(c.command);
    return { ...agentInfo(id), enabled: c.enabled !== false, command: c.command, found: r.found, how: r.how, path: r.path };
  }));

  const broadcast = (ev, name) => {
    const data = `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(ev)}\n\n`;
    for (const res of state.clients) res.write(data);
  };

  const running = () => !!state.council && state.council.status === 'running';
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: '허용되지 않은 Host' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;

      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: '허용되지 않은 Origin' });
        if (!String(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'JSON만 허용' });
      }

      // ── 정적 파일
      if (req.method === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, file), 'utf8'), type);
      }

      // ── 상태
      if (req.method === 'GET' && p === '/api/state') {
        return send(res, 200, {
          agents,
          mock,
          running: running(),
          runId: state.council?.runId || null,
          approvalPending: !!state.pendingApproval,
          defaults: {
            cwd: config.defaultCwd || '',
            mode: config.executionMode,
            rounds: config.debateRounds,
            permission: config.permission,
          },
          configFile: config._file,
        });
      }

      // ── 실시간 이벤트 (SSE)
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        res.write(`event: snapshot\ndata: ${JSON.stringify({ events: state.events, running: running(), approvalPending: !!state.pendingApproval })}\n\n`);
        state.clients.add(res);
        const hb = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(hb);
          state.clients.delete(res);
        });
        return;
      }

      // ── 실행 시작
      if (req.method === 'POST' && p === '/api/run') {
        if (running()) return send(res, 409, { error: '이미 실행 중인 회의가 있습니다.' });
        const b = await readBody(req);
        const task = String(b.task || '').trim();
        if (!task) return send(res, 400, { error: '요청 내용을 입력하세요.' });
        if (task.length > 20000) return send(res, 400, { error: '요청이 너무 깁니다 (2만 자 이하).' });
        let cwd = String(b.cwd || '').trim();
        if (!cwd && mock) cwd = await ensureDemoProject(ROOT);
        else if (mock && cwd === '(demo)') cwd = await ensureDemoProject(ROOT);
        if (!cwd) return send(res, 400, { error: '작업 디렉터리(프로젝트 경로)를 입력하세요.' });
        if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
          return send(res, 400, { error: `폴더를 찾을 수 없습니다: ${cwd}` });
        }
        const ids = Array.isArray(b.agents) ? b.agents.map(normalizeAgentId).filter(Boolean) : undefined;
        if (ids && !ids.length) return send(res, 400, { error: '에이전트를 하나 이상 선택하세요.' });
        const mode = b.mode === 'compete' ? 'compete' : 'lead';
        const rounds = Number.isFinite(Number(b.rounds)) ? Math.max(0, Math.min(5, Number(b.rounds))) : undefined;

        const council = new Council({
          config,
          task,
          cwd,
          agents: ids,
          mode,
          rounds,
          discussOnly: !!b.discussOnly,
          autoApprove: !!b.autoApprove,
          mock,
          confirm: () => new Promise((resolve) => {
            state.pendingApproval = resolve;
          }),
        });
        state.council = council;
        state.events = [];
        state.pendingApproval = null;
        broadcast({ runId: council.runId }, 'reset');
        council.on('event', (ev) => {
          state.events.push(ev);
          broadcast(ev);
        });
        council.run().finally(() => {
          state.pendingApproval = null;
        });
        return send(res, 200, { runId: council.runId });
      }

      // ── 승인 / 취소
      if (req.method === 'POST' && p === '/api/approve') {
        const b = await readBody(req);
        if (!state.pendingApproval) return send(res, 409, { error: '승인 대기 중인 계획이 없습니다.' });
        const resolve = state.pendingApproval;
        state.pendingApproval = null;
        resolve({ approved: !!b.approved, note: String(b.note || '') });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/cancel') {
        if (!running()) return send(res, 409, { error: '실행 중인 회의가 없습니다.' });
        state.pendingApproval = null;
        state.council.cancel();
        return send(res, 200, { ok: true });
      }

      // ── 지난 실행 기록
      if (req.method === 'GET' && p === '/api/runs') return send(res, 200, { runs: listRuns() });
      const m = p.match(/^\/api\/runs\/([\w-]+)$/);
      if (req.method === 'GET' && m) {
        const dir = path.join(RUNS_DIR, m[1]);
        const file = path.join(dir, 'events.jsonl');
        if (!fs.existsSync(file)) return send(res, 404, { error: '기록이 없습니다.' });
        const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
        return send(res, 200, { runId: m[1], events });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://localhost:${port}`;
  console.log(`\n🏛  Agent Council 대시보드: ${url}${mock ? '  (MOCK 모드: 가짜 에이전트)' : ''}`);
  for (const a of agents) {
    console.log(`   ${a.found ? '✓' : '✗'} ${a.name.padEnd(12)} ${a.found ? a.how : `'${a.command}' 명령을 찾을 수 없음`}`);
  }
  console.log('   종료: Ctrl+C\n');
  if (open) openBrowser(url);

  const shutdown = () => {
    if (state.council && running()) state.council.cancel();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, state, url };
}
