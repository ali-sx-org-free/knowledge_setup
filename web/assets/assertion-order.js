// 原始字段注釋優先；斷言 ID 僅作同類條目的穩定排序，不改寫知識編碼。
export const ddlCommentPriority = assertion => assertion.structured?.key?.endsWith('.ddl_comment') ? 0 : 1;
export const compareDdlCommentsFirst = (a, b) => ddlCommentPriority(a) - ddlCommentPriority(b) || String(a.id).localeCompare(String(b.id));
