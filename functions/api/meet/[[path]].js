// /api/meet/* — 모임 초대장 · 룸 가이드(와이파이) 공개 API. 내용은 functions/_lib/meet.js
import { handlePublic } from '../../_lib/meet.js';
export const onRequest = (context) => handlePublic(context);
