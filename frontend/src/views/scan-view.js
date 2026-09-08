import { canExportResults } from "../state.js";

export function formatCount(value) { return Number.isInteger(value) ? String(value) : "—"; }
export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时${minutes}分`;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

export function createScanView(state, elements) {
  function showError(message) {
    if (!elements.errorMessage) { console.error("Best IP 错误提示区域不可用"); return; }
    elements.errorMessage.hidden = !message;
    elements.errorMessage.textContent = message;
  }
  function render() {
    const value = state.snapshot;
    const progress = value?.progress;
    elements.startButton.disabled = state.scanning;
    elements.startButton.textContent = state.scanning ? "检测中..." : "开始检测";
    elements.cancelButton.hidden = !state.scanning;
    elements.cancelButton.disabled = state.cancelling;
    elements.exportCsvBtn.disabled = !canExportResults(state);
    elements.exportJsonBtn.disabled = !canExportResults(state);
    elements.importResultsBtn.disabled = state.scanning;
    elements.scanStatusBadge.hidden = !state.scanning && !value && !state.imported;
    const status = value?.execution;
    const label = state.cancelling || status === "cancelling" ? "取消中，等待确认" : status === "cancelled" ? "扫描已取消" : status === "failed" ? "扫描执行失败" : progress?.label || (state.imported ? state.job.message : state.scanning ? "创建任务" : "等待扫描");
    elements.scanStatusText.textContent = label;
    elements.actionProgressPanel.hidden = !progress;
    elements.actionProgressStatus.textContent = label;
    const fraction = item => `${formatCount(item?.current)}/${formatCount(item?.total)} · 已完成 ${formatCount(item?.completed)}/${formatCount(item?.total)}`;
    elements.actionJobProgress.textContent = `任务 ${fraction(progress?.jobs)}`;
    elements.actionStepProgress.textContent = `步骤 ${fraction(progress?.steps)}`;
    elements.actionCurrentStep.textContent = `当前步骤：${progress?.currentStep || "—"}`;
    elements.actionCurrentStep.title = progress?.currentStep || "";
    elements.actionProgressElapsed.textContent = `已用时：本步骤 ${formatDuration(progress?.stepElapsedMs)} · 运行 ${formatDuration(progress?.elapsedMs)}`;
    const nodes = state.imported ? state.job : value?.nodes;
    elements.scanProgressCount.textContent = progress?.source === "steps" ? `步骤 ${formatCount(progress.steps?.current)}/${formatCount(progress.steps?.total)}` : `${formatCount(nodes?.completed)}/${formatCount(nodes?.total)}`;
    elements.totalStat.textContent = formatCount(nodes?.total);
    elements.completedStat.textContent = formatCount(nodes?.completed);
    elements.successStat.textContent = formatCount(nodes?.success_count);
    elements.issueStat.textContent = Number.isInteger(nodes?.partial_count) && Number.isInteger(nodes?.failed_count) ? String(nodes.partial_count + nodes.failed_count) : "—";
    const availability = value?.result?.availability;
    const hint = state.imported ? "用户导入结果，未作为可信扫描 artifact 验证。" : availability === "invalid" ? "结果校验失败，不展示为可信扫描结果。" : availability === "all_failed" ? "全部节点失败，没有可用出口；可导出失败记录用于排查。" : availability === "verified" && !value.result.fullyScored ? "已验证有出口的节点，包含部分/失败节点；不代表完整评分。" : progress?.source === "steps" && availability === "unavailable" ? "节点统计：等待终态 artifact（仅有执行步骤进度）" : "";
    elements.nodeProgressHint.hidden = !hint;
    elements.nodeProgressHint.textContent = hint;
    showError(state.error);
  }
  function renderHealth(health) {
    elements.healthStatus.textContent = health.label;
    elements.healthStatus.className = health.ready ? "health ready" : "health error";
    elements.modeHint.hidden = !health.hint;
    elements.modeHint.textContent = health.hint || "";
  }
  return { render, showError, renderHealth };
}
