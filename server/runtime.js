// 进程内运行状态：调度器写入，/api/health 读取。
// 目的：让"为什么没提醒/行情是否正常"这类问题有地方可查。
export const runtime = {
  startedAt: Date.now(),
  lastTickAt: null,
  lastTickMode: null,
  lastTickMs: null,
  quoteOk: 0,
  quoteFail: 0,
  lastQuoteError: null,
  lastPushAt: null,
  lastPushOk: null,
  lastPushError: null,
  lastSnapshotDate: null,
  lastReportDate: null,
  fxUpdatedAt: null,
  fxSource: null,
  fxError: null,
};

export function markPush(ok, err) {
  runtime.lastPushAt = new Date().toISOString();
  runtime.lastPushOk = ok;
  runtime.lastPushError = ok ? null : String(err || '');
}
