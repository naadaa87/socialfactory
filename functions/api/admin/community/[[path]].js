// /api/admin/community/* — 관리자 커뮤니티 관리 API. 내용은 functions/_lib/community-admin.js
import { handleAdmin } from '../../../_lib/community-admin.js';
export const onRequest = (context) => handleAdmin(context);
