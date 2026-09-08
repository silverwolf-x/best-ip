import { resetScan, applySnapshot, applyImportedResults } from "./state.js";

export function createScanController({ transport, state, render, schedule = setTimeout, unschedule = clearTimeout }) {
  let session = null;
  let generation = 0;
  let timer = null;
  let delay = 2000;
  let cancelRequested = false;
  let cancelAccepted = false;
  function clearTimer() { unschedule(timer); timer = null; }
  function queue(current) { clearTimer(); timer = schedule(() => poll(current), delay); }
  async function poll(current) {
    if (!session || current !== generation) return;
    try {
      const value = await transport.poll(session);
      if (current !== generation) return;
      applySnapshot(state, value);
      if (state.cancelling && !value.done) state.snapshot = { ...value, execution: "cancelling" };
      if (value.done) { session = null; clearTimer(); }
      else if (cancelRequested && !cancelAccepted) { await cancelSession(current); }
      else { delay = Math.min(10000, Math.round(delay * 1.5)); queue(current); }
    } catch (error) {
      if (current !== generation) return;
      if (error.retryable === false) { state.cancelling = false; clearTimer(); state.error = `读取扫描状态已暂停：${error.message}；任务可能仍在运行，请尝试停止扫描。`; }
      else { state.error = `读取扫描状态失败，重试中：${error.message}`; queue(current); }
    }
    render();
  }
  async function cancelSession(current, pollImmediately = false) {
    try {
      const result = await transport.cancel(session);
      if (current !== generation) return;
      cancelAccepted = result.requested !== false;
      if (result.confirmed) {
        state.scanning = false;
        state.cancelling = false;
        state.error = "";
        state.snapshot = { ...state.snapshot, execution: "cancelled", done: true, cleanupConfirmed: true };
        session = null;
      } else {
        state.snapshot = { ...state.snapshot, execution: "cancelling" };
        state.error = cancelAccepted ? "已请求取消，等待执行端确认结束；取消请求不代表清理完成。" : "等待执行端建立任务后发送取消请求；尚未确认停止。";
        if (pollImmediately) await poll(current);
        else queue(current);
      }
    } catch (error) {
      if (current !== generation) return;
      state.cancelling = false;
      cancelRequested = false;
      state.error = `停止失败：${error.message}`;
      if (error.retryable !== false) queue(current);
    }
    render();
  }
  return {
    async start(subscriptionUrl) {
      if (state.scanning) return;
      clearTimer();
      const current = ++generation;
      resetScan(state);
      cancelRequested = false;
      cancelAccepted = false;
      delay = 2000;
      render();
      try {
        const created = await transport.start(subscriptionUrl);
        if (current !== generation) return;
        session = created;
        if (cancelRequested) await cancelSession(current, true);
        else await poll(current);
      } catch (error) {
        if (current !== generation) return;
        state.scanning = false;
        state.cancelling = false;
        state.error = error.message;
        render();
      }
    },
    async cancel() {
      if (!state.scanning || state.cancelling) return;
      clearTimer();
      cancelRequested = true;
      cancelAccepted = false;
      state.cancelling = true;
      render();
      if (!session) return;
      await cancelSession(++generation);
    },
    importResults(parsed, source, filename) {
      if (state.scanning) throw new Error("请先停止当前扫描并等待取消确认，再导入结果。");
      generation += 1;
      clearTimer();
      session = null;
      applyImportedResults(state, parsed, source, filename);
      render();
    },
    async health() { return transport.health(); },
  };
}
