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

// PATH에서 못 찾았을 때 직접 확인할 CLI 기본 설치 폴더.
// 설치 스크립트가 PATH를 바꿔도 이미 열려 있던 터미널·VS Code·탐색기는 예전 PATH를 그대로 쓰기 때문에
// `where`가 실패할 수 있습니다. 그럴 때도 실행 파일이 기본 위치에 있으면 그대로 씁니다.
export function windowsInstallDirs(env = process.env) {
  const home = env.USERPROFILE || '';
  const local = env.LOCALAPPDATA || (home && path.join(home, 'AppData', 'Local'));
  const roaming = env.APPDATA || (home && path.join(home, 'AppData', 'Roaming'));
  return [
    local && path.join(local, 'agy', 'bin'), // Antigravity (install.ps1)
    home && path.join(home, '.local', 'bin'), // Claude Code (install.ps1)
    local && path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'), // Codex 설치 프로그램
    roaming && path.join(roaming, 'npm'), // npm install -g
  ].filter(Boolean);
}

/** 명령 이름(경로 없이)을 기본 설치 폴더에서 찾습니다. */
export function findInInstallDirs(cmd, dirs = windowsInstallDirs()) {
  if (!cmd || /[\\/]/.test(cmd)) return [];
  const exts = path.extname(cmd) ? [''] : ['.exe', '.cmd', '.bat', '.com'];
  const hits = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(p).isFile()) hits.push(p);
      } catch { /* 이 위치에는 없음 */ }
    }
  }
  return hits;
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
  let outsidePath = false;
  if (!IS_WIN) {
    const p = findOnPathPosix(cmd);
    r = p
      ? { found: true, path: p, file: p, prefixArgs: [], shell: false, how: 'direct' }
      : { found: false, path: null, file: cmd, prefixArgs: [], shell: false, how: 'missing' };
  } else {
    let hits = await findOnPathWindows(cmd);
    if (!hits.length) {
      hits = findInInstallDirs(cmd);
      outsidePath = hits.length > 0;
    }
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
  if (outsidePath && r.found) r = { ...r, how: `${r.how} · PATH 밖 기본 설치 위치에서 찾음` };
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
 *
 * CLI가 답을 다 내놓고도 끝나지 않는 경우를 막기 위해, 'close'만 기다리지 않고 다음도 봅니다.
 *   - isDone()      : 줄을 받을 때마다 확인합니다. true가 된 뒤 graceMs 안에 안 끝나면 프로세스를 정리하고 끝냅니다.
 *   - 'exit' 이후   : 프로세스는 끝났는데 하위 프로세스가 출력 파이프를 붙잡고 있어 'close'가 안 오면,
 *                     마지막 출력 뒤 graceMs가 지나면 끝냅니다.
 *   - idleTimeoutMs : stdout·stderr에 이 시간 동안 아무 출력이 없으면 중단합니다. (0이면 끔)
 *   - timeoutMs     : 전체 제한 시간. (0이면 끔)
 * 강제로 종료한 뒤에도 killWaitMs 안에 'close'가 오지 않으면 우리 쪽 파이프를 닫고 끝냅니다(무한 대기 방지).
 *
 * 결과의 doneMs / exitMs / killMs / durationMs 는 시작 시점부터의 밀리초입니다(해당 사건이 없으면 null).
 */
export function runProcess({
  resolved,
  args = [],
  cwd,
  input = null,
  env = process.env,
  timeoutMs = 0,
  idleTimeoutMs = 0,
  isDone,
  graceMs = 5000,
  killWaitMs = 5000,
  signal,
  onLine,
  onStderr,
  maxBuffer = 16 * 1024 * 1024,
}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
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
      resolve({
        code: -1, signal: null, stdout: '', stderr: String(e.message), error: e,
        timedOut: false, idleTimedOut: false, aborted: false, killedAfterDone: false, forcedClose: false,
        doneMs: null, exitMs: null, killMs: null, durationMs: Date.now() - t0,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let buf = '';
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let idleTimedOut = false;
    let aborted = false;
    let killedAfterDone = false; // 완료 신호를 받은 뒤에도 안 끝나서 정리함
    let forcedClose = false; // 'close'를 기다리지 않고 파이프를 닫고 끝냄
    let doneMs = null;
    let exitMs = null;
    let killMs = null; // 우리가 종료시킨 시점
    let exitCode = null;
    let exitSignal = null;
    const timers = {};

    const setTimer = (name, ms, fn) => {
      clearTimeout(timers[name]);
      timers[name] = setTimeout(fn, ms);
    };

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      for (const t of Object.values(timers)) clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        stdout, stderr, code: exitCode, signal: exitSignal,
        timedOut, idleTimedOut, aborted, killedAfterDone, forcedClose,
        doneMs, exitMs, killMs, durationMs: Date.now() - t0,
        ...extra,
      });
    };

    const emitLine = (line) => {
      if (!line.trim() || !onLine) return;
      try { onLine(line); } catch { /* 콜백 오류는 무시 */ }
    };

    const flushBuf = () => {
      if (!buf) return;
      const line = buf.replace(/\r$/, '');
      buf = '';
      emitLine(line);
      checkDone();
    };

    // 'close'를 기다리지 않고 끝냅니다. 우리 쪽 파이프를 닫아 이벤트 루프가 붙잡히지 않게 합니다.
    const forceFinish = () => {
      if (settled) return;
      forcedClose = true;
      flushBuf();
      for (const s of [child.stdout, child.stderr]) {
        try { s.destroy(); } catch { /* 이미 닫힘 */ }
      }
      finish();
    };

    // 프로세스 트리를 종료하고, 그래도 'close'가 안 오면 killWaitMs 뒤 끝냅니다.
    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      killMs = Date.now() - t0;
      clearTimeout(timers.idle);
      killTree(child);
      setTimer('killWait', killWaitMs, forceFinish);
    };

    function checkDone() {
      if (doneMs !== null || !isDone || settled) return;
      let d = false;
      try { d = !!isDone(); } catch { /* 판단 실패는 무시 */ }
      if (!d) return;
      doneMs = Date.now() - t0;
      clearTimeout(timers.idle);
      setTimer('done', graceMs, () => {
        if (settled || terminating) return;
        killedAfterDone = true;
        if (exitMs !== null) forceFinish(); // 프로세스는 이미 끝났고 파이프만 남은 경우
        else terminate();
      });
    }

    const bumpIdle = () => {
      if (!idleTimeoutMs || settled || terminating || doneMs !== null || exitMs !== null) return;
      setTimer('idle', idleTimeoutMs, () => {
        if (settled || terminating) return;
        idleTimedOut = true;
        terminate();
      });
    };

    // 'exit' 뒤에도 출력이 이어지는 동안은 기다리고, 마지막 출력 뒤 graceMs가 지나면 끝냅니다.
    const armExitGrace = () => setTimer('exit', graceMs, forceFinish);

    const onActivity = () => {
      bumpIdle();
      if (exitMs !== null) armExitGrace();
    };

    function onAbort() {
      aborted = true;
      terminate();
    }

    child.on('error', (e) => finish({ code: -1, signal: null, error: e, stderr: stderr + String(e.message) }));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      onActivity();
      if (stdout.length < maxBuffer) stdout += chunk;
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        emitLine(line);
        checkDone();
      }
    });
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      onActivity();
      if (stderr.length < 256 * 1024) stderr += chunk;
      if (onStderr) {
        try { onStderr(chunk); } catch { /* 무시 */ }
      }
    });
    child.on('exit', (code, sig) => {
      exitMs = Date.now() - t0;
      exitCode = code;
      exitSignal = sig;
      clearTimeout(timers.idle);
      if (!settled) armExitGrace();
    });
    child.on('close', (code, sig) => {
      flushBuf();
      if (exitMs === null) {
        exitCode = code;
        exitSignal = sig;
      }
      finish();
    });

    child.stdin.on('error', () => { /* 프로세스가 stdin을 읽기 전에 끝난 경우(EPIPE) */ });
    if (input != null) child.stdin.end(input, 'utf8');
    else child.stdin.end();

    if (timeoutMs > 0) {
      setTimer('total', timeoutMs, () => {
        if (settled || terminating) return;
        timedOut = true;
        terminate();
      });
    }
    bumpIdle();
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
