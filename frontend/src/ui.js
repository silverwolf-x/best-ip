import { createState, canExportResults } from './state.js';
import { createScanController } from './scan-controller.js';
import { createScanView } from './views/scan-view.js';
import { createTableView } from './views/table-view.js';
import { createDetailView } from './views/detail-view.js';
import { readImportText, parseImportedJson, parseImportedCsv, buildCsvExport, buildJsonExport, downloadBlob, dateStamp } from './import-export.js';
export function mountApp({ transport, document, schedule = setTimeout, unschedule = clearTimeout }) {
const state = createState();
const elements = {
  form: document.querySelector("#scanForm"),
  subscriptionUrl: document.querySelector("#subscriptionUrl"),
  revealButton: document.querySelector("#revealButton"),
  modeHint: document.querySelector("#modeHint"),
  startButton: document.querySelector("#startButton"),
  cancelButton: document.querySelector("#cancelButton"),
  healthStatus: document.querySelector("#healthStatus"),
  themeButton: document.querySelector("#themeButton"),
  scanStatusBadge: document.querySelector("#scanStatusBadge"),
  scanStatusText: document.querySelector("#scanStatusText"),
  scanProgressCount: document.querySelector("#scanProgressCount"),
  totalStat: document.querySelector("#totalStat"),
  errorMessage: document.querySelector("#errorMessage"),
  actionProgressPanel: document.querySelector("#actionProgressPanel"),
  actionJobProgress: document.querySelector("#actionJobProgress"),
  actionStepProgress: document.querySelector("#actionStepProgress"),
  actionProgressStatus: document.querySelector("#actionProgressStatus"),
  actionCurrentStep: document.querySelector("#actionCurrentStep"),
  actionProgressElapsed: document.querySelector("#actionProgressElapsed"),
  nodeProgressHint: document.querySelector("#nodeProgressHint"),
  completedStat: document.querySelector("#completedStat"),
  successStat: document.querySelector("#successStat"),
  issueStat: document.querySelector("#issueStat"),
  resultSearch: document.querySelector("#resultSearch"),
  statusFilter: document.querySelector("#statusFilter"),
  exportCsvBtn: document.querySelector("#exportCsvBtn"),
  exportJsonBtn: document.querySelector("#exportJsonBtn"),
  importResultsBtn: document.querySelector("#importResultsBtn"),
  importFileInput: document.querySelector("#importFileInput"),
  resultsToolbar: document.querySelector("#resultsToolbar"),
  resultBody: document.querySelector("#resultBody"),
  resultCards: document.querySelector("#resultCards"),
  resultTable: document.querySelector("#resultTable"),
  cardViewButton: document.querySelector("#cardViewButton"),
  tableViewButton: document.querySelector("#tableViewButton"),
  emptyResults: document.querySelector("#emptyResults"),
  detailDialog: document.querySelector("#detailDialog"),
  detailTitle: document.querySelector("#detailTitle"),
  detailSubtitle: document.querySelector("#detailSubtitle"),
  detailContent: document.querySelector("#detailContent"),
  copyJsonBtn: document.querySelector("#copyJsonBtn"),
  closeDialog: document.querySelector("#closeDialog"),
};
const scanView = createScanView(state, elements);
const tableView = createTableView(state, elements, document);
const detailView = createDetailView(state, elements, document);
const { renderRows, scheduleRenderRows } = tableView;
const { openDetails } = detailView;
const showInlineError = scanView.showError;
const render = () => { scanView.render(); renderRows(); };
const controller = createScanController({ transport, state, render, schedule, unschedule });
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("best-ip-theme", theme);
  elements.themeButton.title = theme === "dark" ? "浅色模式" : "暗黑模式";
}

applyTheme(localStorage.getItem("best-ip-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
elements.themeButton.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
elements.revealButton.addEventListener("click", () => {
  const revealing = elements.subscriptionUrl.type === "password";
  elements.subscriptionUrl.type = revealing ? "url" : "password";
  elements.revealButton.textContent = revealing ? "🔒" : "👁️";
});
elements.form.addEventListener('submit', async event => {
 event.preventDefault();
 const url = elements.subscriptionUrl.value.trim();
 if (!url || state.scanning) return;
 if (elements.detailDialog.open) elements.detailDialog.close();
 elements.subscriptionUrl.value = '';
 await controller.start(url);
});
elements.cancelButton.addEventListener('click', () => controller.cancel());
elements.importResultsBtn.addEventListener("click", () => elements.importFileInput.click());
elements.importFileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (file) await importResultsFile(file);
});

["dragenter", "dragover"].forEach((eventName) => {
  elements.resultsToolbar?.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    elements.resultsToolbar.classList.add("import-drag-active");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  elements.resultsToolbar?.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    elements.resultsToolbar.classList.remove("import-drag-active");
  });
});
elements.resultsToolbar?.addEventListener("drop", async (event) => {
  const [file] = event.dataTransfer?.files || [];
  if (file) await importResultsFile(file);
});

elements.resultSearch.addEventListener("input", scheduleRenderRows);
elements.statusFilter.addEventListener("change", renderRows);

document.querySelectorAll(".th-filter").forEach((input) => {
  const col = input.dataset.col;
  if (!col) return;
  const eventName = input.tagName === "SELECT" ? "change" : "input";
  input.addEventListener(eventName, (e) => {
    state.columnFilters[col] = e.target.value.trim();
    if (eventName === "input") scheduleRenderRows();
    else renderRows();
  });
});

function setResultView(cards) {
  elements.resultCards.hidden = !cards;
  elements.resultTable.hidden = cards;
  elements.cardViewButton.setAttribute("aria-pressed", String(cards));
  elements.tableViewButton.setAttribute("aria-pressed", String(!cards));
}
elements.cardViewButton?.addEventListener("click", () => setResultView(true));
elements.tableViewButton?.addEventListener("click", () => setResultView(false));

async function handleResultClick(event) {
  const target = event.target;
  if (!target?.closest) return;
  const result = (target.closest("tr") || target.closest(".node-card"))?._bestIpResult;
  if (!result) return;
  if (target.closest(".node-name-btn")) {
    openDetails(result);
    return;
  }
  const copyButton = target.closest(".mini-copy");
  if (!copyButton || !result.exit_ip) return;
  event.stopPropagation();
  try {
    await navigator.clipboard.writeText(result.exit_ip);
    copyButton.textContent = "已复制";
    setTimeout(() => { copyButton.textContent = "复制"; }, 1500);
  } catch {
    alert("复制失败");
  }
}
elements.resultBody.addEventListener("click", handleResultClick);
elements.resultCards?.addEventListener("click", handleResultClick);

elements.closeDialog.addEventListener("click", () => elements.detailDialog.close());
elements.detailDialog.addEventListener("close", () => {
  state.detailGeneration += 1;
  state.activeDetailResult = null;
});
elements.detailDialog.addEventListener("click", (event) => {
  if (event.target === elements.detailDialog) elements.detailDialog.close();
});
elements.copyJsonBtn.addEventListener("click", async () => {
  if (!state.activeDetailResult) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.activeDetailResult, null, 2));
    elements.copyJsonBtn.textContent = "已复制";
    setTimeout(() => { elements.copyJsonBtn.textContent = "复制 JSON"; }, 2000);
  } catch {
    alert("复制失败，请手动选择复制。");
  }
});
document.querySelectorAll(".sort-btn").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    if (state.sortKey === key) {
      state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDirection = key === "node" || key === "location" ? "asc" : "desc";
    }
    document.querySelectorAll(".sort-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.sort === state.sortKey);
      btn.classList.toggle("asc", btn.dataset.sort === state.sortKey && state.sortDirection === "asc");
    });
    renderRows();
  });
});
elements.exportCsvBtn.addEventListener('click', () => {
 if (!canExportResults(state)) return;
 downloadBlob(buildCsvExport(state.results), 'best-ip-results-' + dateStamp() + '.csv', 'text/csv;charset=utf-8;');
});
elements.exportJsonBtn.addEventListener('click', () => {
 if (!canExportResults(state)) return;
 try { downloadBlob(JSON.stringify(buildJsonExport(state), null, 2), 'best-ip-results-' + dateStamp() + '.json', 'application/json;charset=utf-8;'); }
 catch (error) { showInlineError('导出 JSON 失败：' + error.message); }
});
async function importResultsFile(file) {
  const filename = String(file?.name || "").trim();
  const extension = filename.toLocaleLowerCase("en-US").split(".").pop();
  if (!filename || !["json", "csv"].includes(extension)) {
    showInlineError("导入失败：请选择之前导出的 .json 或 .csv 文件。");
    return;
  }

  try {
    const text = await readImportText(file);
    const parsed = extension === "json" ? parseImportedJson(text) : parseImportedCsv(text);
    controller.importResults(parsed, extension, filename);
    if (elements.detailDialog.open) elements.detailDialog.close();
  } catch (error) {
    showInlineError(`导入失败：${error.message || "文件格式无法识别"}`);
  }
}
render();
const ready = controller.health().then(scanView.renderHealth, error => scanView.renderHealth({ ready: false, label: error.message }));
return { state, controller, elements, ready, ...tableView, ...detailView };
}
