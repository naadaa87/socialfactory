// /api/admin/meet/* — 관리자 '초대장 · 룸 가이드' API. 내용은 functions/_lib/meet-admin.js
import { handleAdmin } from '../../../_lib/meet-admin.js';
export const onRequest = (context) => handleAdmin(context);
