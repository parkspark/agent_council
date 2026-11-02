// 에이전트 답변 끝에 붙는 ```json { ... } ``` 블록을 읽어 판정(입장/투표/리뷰)을 꺼냅니다.

function tryParse(s) {
  const t = String(s).trim();
  try {
    return JSON.parse(t);
  } catch { /* 관대한 파싱 시도 */ }
  try {
    return JSON.parse(t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** 텍스트에서 마지막 JSON 객체를 찾아 반환 (없으면 null) */
export function extractJson(text) {
  if (!text) return null;
  const blocks = [...String(text).matchAll(/```[ \t]*(?:json|JSON|jsonc)?[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const v = tryParse(blocks[i]);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  // 코드 블록이 없으면 끝에서부터 {...} 후보를 찾아봅니다
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  let pos = end;
  for (let tries = 0; tries < 60; tries++) {
    pos = text.lastIndexOf('{', pos - 1);
    if (pos < 0) break;
    const v = tryParse(text.slice(pos, end + 1));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

/** 표시용: 답변 끝의 JSON 블록 제거 */
export function stripTrailingJson(text) {
  return String(text || '').replace(/\n*```[ \t]*(?:json|JSON)?[ \t]*\r?\n[\s\S]*?```\s*$/, '').trimEnd();
}

function norm(v) {
  const s = String(v ?? '').toLowerCase().trim();
  return s.includes('|') ? '' : s; // 템플릿("a | b | c")을 그대로 베낀 경우는 무효
}

export function normStance(v) {
  const s = norm(v);
  if (!s) return 'unknown';
  if (/disagree|object|반대/.test(s)) return 'object';
  if (/revise|수정|조정/.test(s)) return 'revise';
  if (/agree|동의|찬성/.test(s)) return 'agree';
  return 'unknown';
}

export function normVote(v) {
  const s = norm(v);
  if (!s) return 'unknown';
  if (/reject|반대|no\b|거부/.test(s)) return 'reject';
  if (/approve|찬성|yes|accept|동의/.test(s)) return 'approve';
  return 'unknown';
}

export function normVerdict(v) {
  const s = norm(v);
  if (!s) return 'unknown';
  if (/change|request|reject|수정|반려/.test(s)) return 'changes';
  if (/approve|lgtm|승인|통과|ok/.test(s)) return 'approve';
  return 'unknown';
}

export function asList(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).filter((x) => x && x.trim());
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}
