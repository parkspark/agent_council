// 설정 로딩: 기본값 + council.config.json(있으면) 병합

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  language: 'ko',
  // 토론 라운드 수 (모두 agree 하면 일찍 끝남)
  debateRounds: 2,
  // 합의안을 작성하는 진행자
  moderator: 'claude',
  // 실행 담당. "auto"면 진행자가 토론 내용을 보고 고름
  executor: 'auto',
  // lead: 한 명이 구현하고 나머지가 리뷰 / compete: 셋이 각자 워크트리에서 구현 후 투표
  executionMode: 'lead',
  // 실행 단계 권한: edits(파일 편집만 자동 승인) / full(모든 권한, 테스트 실행 포함)
  permission: 'edits',
  // 합의 실패 시 합의안을 다시 쓰는 횟수
  consensusRetries: 1,
  // 리뷰에서 수정 요청이 나왔을 때 고치는 횟수
  maxFixRounds: 1,
  // discussMinutes / executeMinutes: 호출당 전체 제한 시간
  // idleMinutes: 이 시간 동안 출력이 전혀 없으면 멈춘 것으로 보고 중단 (0이면 끔)
  // graceSeconds: 최종 답변을 받은 뒤 프로세스가 스스로 끝나기를 기다리는 시간. 지나면 정리하고 넘어감
  timeouts: { discussMinutes: 15, executeMinutes: 40, idleMinutes: 10, graceSeconds: 5 },
  // 다른 에이전트 의견을 프롬프트에 넣을 때 에이전트당 최대 글자 수
  maxOpinionChars: 8000,
  maxDiffChars: 40000,
  port: 4545,
  defaultCwd: null,
  agents: {
    claude: { enabled: true, command: 'claude', model: null, inputMode: null, extraArgs: [], permissionArgs: null },
    codex: { enabled: true, command: 'codex', model: null, inputMode: null, extraArgs: [], permissionArgs: null },
    antigravity: { enabled: true, command: 'agy', model: null, inputMode: null, extraArgs: [], permissionArgs: null },
  },
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('//') || k.startsWith('_')) continue; // 주석 키 무시
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(root, explicitPath) {
  const file = explicitPath ? path.resolve(explicitPath) : path.join(root, 'council.config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (e) {
      throw new Error(`설정 파일을 읽을 수 없습니다 (${file}): ${e.message}`);
    }
  } else if (explicitPath) {
    throw new Error(`설정 파일이 없습니다: ${file}`);
  }
  const cfg = deepMerge(DEFAULT_CONFIG, user);
  cfg._file = fs.existsSync(file) ? file : null;
  return cfg;
}
