// 僅合併相鄰、同一操作者、同一原因且五分鐘內的確認 / 失效提交。
// 只忽略目標條目的編號；原因中的文檔、Action 等編號仍參與比較。
function batchKey(entry) {
  const match = /^\[(失效|確認|确认)\]\s+([ABR])-\d+\b(.*)$/.exec(entry.subject || '');
  if (!match || !Number.isFinite(Date.parse(entry.date))) return null;
  return {
    operation: match[1] === '失效' ? 'invalidate' : 'confirm',
    key: JSON.stringify([match[1], match[2], match[3], entry.author, entry.email])
  };
}

export function groupHistory(history) {
  const groups = [];
  for (const entry of history) {
    const batch = batchKey(entry);
    const previous = groups.at(-1);
    const elapsed = previous ? Date.parse(previous.entries[0].date) - Date.parse(entry.date) : NaN;
    if (batch && previous?.key === batch.key && elapsed >= 0 && elapsed <= 5 * 60 * 1000) {
      previous.entries.push(entry);
    } else {
      groups.push({ key: batch?.key || null, operation: batch?.operation || null, entries: [entry] });
    }
  }
  return groups;
}
