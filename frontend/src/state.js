import { normalizeImportedResult } from "./results.js";

export function createState() {
  return { job: null, snapshot: null, results: [], scanning: false, cancelling: false, imported: false, importSource: "", error: "", sortKey: "coffee_score", sortDirection: "desc", activeDetailResult: null, detailGeneration: 0, columnFilters: { node: "", score: "", status: "", exit_ip: "", isp: "", native: "", security: "", gpt: "", ping: "" } };
}

export function resetScan(state) {
  Object.assign(state, { job: null, snapshot: null, results: [], scanning: true, cancelling: false, imported: false, importSource: "", error: "", activeDetailResult: null });
  state.detailGeneration += 1;
}

export function applySnapshot(state, value) {
  state.snapshot = value;
  state.error = value.error?.message || "";
  if (value.result.export) {
    state.job = value.result.export;
    state.results = value.result.export.results.map((record, index) => normalizeImportedResult(record, index, "scan"));
    state.importSource = "scan";
    if (value.result.availability === "all_failed") state.error = "扫描执行完成，但全部节点失败，没有可用出口。";
    else if (!value.result.fullyScored) state.error = "扫描已完成，保留有出口的部分结果；包含部分或失败节点，不代表完整评分。";
  }
  if (value.done) {
    state.scanning = false;
    state.cancelling = false;
  }
}

export function applyImportedResults(state, parsed, source, filename) {
  const counts = { success: 0, partial: 0, failed: 0 };
  for (const result of parsed.results) counts[result.status] += 1;
  const metadata = parsed.metadata || {};
  const results = parsed.results;
  Object.assign(state, { results, imported: true, importSource: source, scanning: false, cancelling: false, snapshot: null, error: "", activeDetailResult: null });
  state.detailGeneration += 1;
  state.job = { id: `imported-${Date.now()}`, status: "completed", message: `已导入 ${filename}`, created_at: metadata.created_at || parsed.manifest?.created_at || null, finished_at: metadata.finished_at || parsed.manifest?.finished_at || null, total: results.length, completed: results.length, success_count: counts.success, partial_count: counts.partial, failed_count: counts.failed, manifest_ready: true, cleanup_confirmed: false, execution_mode: "imported", results, manifest: parsed.manifest, imported: true };
}

export function canExportResults(state) {
  return !state.scanning && Boolean(state.results.length && (state.imported || ["verified", "all_failed"].includes(state.snapshot?.result.availability)));
}
