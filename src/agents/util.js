// 어댑터들이 함께 쓰는 작은 도우미 함수

export function clip(s, n = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 도구 호출을 한 줄 라벨로 요약: "Read · src/app.js" */
export function toolLabel(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const v =
    i.file_path || i.path || i.command || i.cmd || i.pattern || i.url || i.query ||
    i.description || i.prompt || i.target || '';
  return `${name || 'tool'}${v ? ' · ' + clip(Array.isArray(v) ? v.join(' ') : v, 120) : ''}`;
}

export function tryJson(line) {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
