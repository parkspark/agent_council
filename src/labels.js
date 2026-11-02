export const CALL_LABEL = {
  propose: '제안',
  debate: '토론',
  synthesize: '합의안',
  vote: '투표',
  execute: '실행',
  review: '리뷰',
  fix: '리뷰 반영',
  judge: '구현 평가',
  probe: '연결 확인',
};

export const STATUS_LABEL = {
  completed: '완료',
  discussed: '토론 완료',
  'no-consensus': '합의 실패',
  rejected: '실행 안 함',
  cancelled: '취소됨',
  failed: '실패',
};

export const STANCE_LABEL = { agree: '동의', revise: '수정 제안', object: '반대', unknown: '불명확' };
export const VOTE_LABEL = { approve: '찬성', reject: '반대', abstain: '기권', unknown: '불명확' };
export const VERDICT_LABEL = { approve: '승인', changes: '수정 요청', abstain: '기권', unknown: '불명확' };

export function callTitle(phase, round) {
  const base = CALL_LABEL[phase] || phase;
  return round ? `${base} ${round}` : base;
}

export function fmtDuration(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}
