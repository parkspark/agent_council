import claude from './claude.js';
import codex from './codex.js';
import antigravity from './antigravity.js';

export const ADAPTERS = { claude, codex, antigravity };
export const AGENT_IDS = Object.keys(ADAPTERS);

/** "Claude Code", "gemini", "agy", "OpenAI" 같은 표기를 내부 id로 정규화 */
export function normalizeAgentId(v) {
  const s = String(v ?? '').toLowerCase().trim();
  if (!s) return null;
  if (s.includes('claude') || s.includes('anthropic')) return 'claude';
  if (s.includes('codex') || s.includes('openai') || s.includes('gpt')) return 'codex';
  if (s.includes('antigravity') || s.includes('agy') || s.includes('gemini') || s.includes('google')) return 'antigravity';
  return null;
}

export function agentName(id) {
  return ADAPTERS[id]?.name || id;
}
