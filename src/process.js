// 외부 CLI(claude / codex / agy / git)를 안전하게 실행하는 프로세스 러너.
//
// Windows에서 npm으로 설치한 CLI는 보통 `claude.cmd` 같은 배치 파일이라
// child_process.spawn()으로 바로 실행할 수 없습니다(EINVAL/ENOENT).
// 그래서 실행 파일 위치를 직접 찾아서
//   1) .exe      → 그대로 실행
//   2) npm .cmd  → 안에 적힌 JS 진입점을 찾아 `node <script>`로 실행 (cmd.exe를 거치지 않음)
//   3) 그 외     → 마지막 수단으로 shell: true
// 순서로 실행합니다. 프롬프트는 길고 줄바꿈·따옴표가 많으므로 가능하면 stdin으로 넘깁니다.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
const cache = new Map();

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function findOnPathPosix(cmd) {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 다음 경로 */ }
  }
  return null;
}

async function findOnPathWindows(cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? [cmd] : [];
  const r = await execFileP('where', [cmd]);
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// npm이 만든 .cmd shim 안에서 실제 JS 진입점 경로를 찾아냅니다.
//   예) "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
function parseNpmShim(cmdPath) {
  try {
    const src = fs.readFileSync(cmdPath, 'utf8');
    const m = src.match(/"%~?dp0%?\\([^"]+?\.[cm]?js)"/i);
    if (m) {
      const script = path.join(path.dirname(cmdPath), m[1]);
      if (fs.existsSync(script)) return script;
    }
  } catch { /* shim을 못 읽으면 shell로 실행 */ }
  return null;
}

/**
 * 명령 이름을 실제로 실행 가능한 형태로 해석합니다.
 * @returns {{found:boolean, path:string|null, file:string, prefixArgs:string[], shell:boolean, how:string}}
 */
export async function resolveCommand(cmd) {
  if (cache.has(cmd)) return cache.get(cmd);
  let r;
  if (!IS_WIN) {
    const p = findOnPathPosix(cmd);
    r = p
      ? { found: true, path: p, file: p, prefixArgs: [], shell: false, how: 'direct' }
      : { found: false, path: null, file: cmd, prefixArgs: [], shell: false, how: 'missing' };
  } else {
    const hits = await findOnPathWindows(cmd);
    const hit = hits.find((h) => /\.(exe|com|cmd|bat)$/i.test(h)) || hits[0];
    if (!hit) {
      r = { found: false, path: null, file: cmd, prefixArgs: [], shell: true, how: 'missing' };
    } else if (/\.(cmd|bat)$/i.test(hit)) {
      const script = parseNpmShim(hit);
      r = script
        ? { found: true, path: hit, file: process.execPath, prefixArgs: [script], shell: false, how: 'node-shim' }
        : { found: true, path: hit, file: hit, prefixArgs: [], shell: true, how: 'cmd' };
    } else {
      r = { found: true, path: hit, file: hit, prefixArgs: [], shell: false, how: 'exe' };
    }
  }
  cache.set(cmd, r);
  return r;
}

export function clearResolveCache() {
  cache.clear();
}

// shell: true 로 실행할 때만 쓰는 인자 인용 (프롬프트는 stdin으로 가므로 단순한 플래그만 해당)
function quoteForCmd(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^%!(),;=]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/** 하위 프로세스에 넘길 환경 변수. 중첩 실행 감지용 변수와 색상 출력을 끕니다. */
export function childEnv(extra = {}) {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) {
    delete env[k];
  }
  return env;
}

function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (IS_WIN) {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => {});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 이미 종료 */ } }
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 종료 */ }
    }, 3000).unref();
  }
}

/**
 * 프로세스를 실행하고 stdout을 줄 단위로 콜백합니다.
 * 절대 throw하지 않고 결과 객체를 돌려줍니다.
 */
export function runProcess({
  resolved,
  args = [],
  cwd,
  input = null,
  env = process.env,
  timeoutMs = 0,
  signal,
  onLine,
  onStderr,
  maxBuffer = 16 * 1024 * 1024,
}) {
  return new Promise((resolve) => {
    const fullArgs = [...(resolved.prefixArgs || []), ...args];
    const spawnOpts = { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN };
    let child;
    try {
      if (resolved.shell) {
        const line = [quoteForCmd(resolved.file), ...fullArgs.map(quoteForCmd)].join(' ');
        child = spawn(line, [], { ...spawnOpts, shell: true });
      } else {
        child = spawn(resolved.file, fullArgs, spawnOpts);
      }
    } catch (e) {
      resolve({ code: -1, signal: null, stdout: '', stderr: String(e.message), timedOut: false, aborted: false, error: e });
      return;
    }

    let stdout = '';
    let stderr = '';
    let buf = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;

    const emitLine = (line) => {
      if (!line.trim() || !onLine) return;
      try { onLine(line); } catch { /* 콜백 오류는 무시 */ }
    };

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, timedOut, aborted, ...extra });
    };

    function onAbort() {
      aborted = true;
      killTree(child);
    }

    child.on('error', (e) => finish({ code: -1, signal: null, error: e, stderr: stderr + String(e.message) }));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk;
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        emitLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk;
      if (onStderr) {
        try { onStderr(chunk); } catch { /* 무시 */ }
      }
    });
    child.on('close', (code, sig) => {
      if (buf) emitLine(buf.replace(/\r$/, ''));
      buf = '';
      finish({ code, signal: sig });
    });

    child.stdin.on('error', () => { /* 프로세스가 stdin을 읽기 전에 끝난 경우(EPIPE) */ });
    if (input != null) child.stdin.end(input, 'utf8');
    else child.stdin.end();

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
    }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 간단한 실행 헬퍼: 명령 이름으로 바로 실행 */
export async function run(cmd, args, opts = {}) {
  const resolved = await resolveCommand(cmd);
  if (!resolved.found) return { code: -1, stdout: '', stderr: `'${cmd}' 명령을 찾을 수 없습니다.`, missing: true };
  return runProcess({ resolved, args, ...opts });
}
