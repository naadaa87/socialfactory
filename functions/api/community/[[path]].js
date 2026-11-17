// /api/community/* — 커뮤니티(모임 소개 · 자유게시판) 공개 API. 내용은 functions/_lib/community.js
import { handlePublic } from '../../_lib/community.js';
export const onRequest = (context) => handlePublic(context);
