import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mountApp } from '../frontend/src/ui.js';
import { normalizeDisplayText, formatAsn, normalizeUnavailableLatencyStatus, filterResults, normalizeImportedResult } from '../frontend/src/results.js';
import { parseImportedJson, parseImportedCsv, buildCsvExport, buildJsonExport } from '../frontend/src/import-export.js';
import { snapshot } from '../frontend/src/transport/snapshot.js';
import { resultFixture } from './frontend-fixtures.mjs';
const indexSource = readFileSync('frontend/index.html', 'utf8');
class FakeElement {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.type = "text";
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
    this.open = false;
    this.title = "";
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.queryChildren = new Map();
    this.classList = {
      add: (...names) => { names.forEach((name) => { this.className += ` ${name}`; }); },
      remove: () => {}, toggle: () => {},
    };
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  querySelector(selector) {
    if (!this.queryChildren.has(selector)) this.queryChildren.set(selector, new FakeElement(`${this.id}:${selector}`));
    return this.queryChildren.get(selector);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  close() {
    this.open = false;
    for (const listener of this.listeners.get("close") || []) listener({ target: this });
  }

  showModal() {
    this.open = true;
  }

  click() {
    for (const listener of this.listeners.get("click") || []) listener({ target: this, preventDefault() {} });
  }
}
function createFixture({ start, poll, cancel, health, includeError = true } = {}) {
 const ids = [...indexSource.matchAll(/id="([^"]+)"/g)].map(match => match[1]).filter(id => includeError || id !== 'errorMessage');
 const nodes = Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
 nodes.statusFilter.value = 'all';
 const document = {
  documentElement: { dataset: {} },
  querySelector: selector => nodes[selector.slice(1)] || null,
  querySelectorAll: () => [],
  createDocumentFragment: () => new FakeElement('fragment'),
  createElement: name => new FakeElement(name),
  createTextNode: text => Object.assign(new FakeElement('text'), { textContent: text }),
 };
 globalThis.document = document;
 globalThis.localStorage = { getItem: () => null, setItem: () => {} };
 globalThis.matchMedia = () => ({ matches: false });
 globalThis.fetch = async () => { throw new Error('UI must not fetch'); };
 const calls = [];
 const timers = [];
 const transport = {
  health: health || (async () => ({ ready: true, label: '就绪', hint: '测试适配器' })),
  start: start || (async url => { calls.push(url); throw new Error('网关请求失败'); }),
  poll: poll || (async () => snapshot()),
  cancel: cancel || (async () => ({ requested: true, confirmed: false })),
 };
 const app = mountApp({ transport, document, schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; }, unschedule: timer => { if (timer) timer.cancelled = true; } });
 return { ...app, nodes, timers, calls };
}
async function submit(fixture) {
 return fixture.nodes.scanForm.listeners.get('submit')[0]({ preventDefault() {} });
}

test("native module page has no browser credentials or legacy global assembly", () => {
  assert.match(indexSource, /type="module" src="\.\/src\/main\.js"/);
  assert.doesNotMatch(indexSource, /githubPat|Fine-grained|action-client\.js|zip-reader\.js|app\.js|0\/0/);
  const sources = readdirSync("frontend/src", { recursive: true }).filter(path => path.endsWith(".js")).map(path => readFileSync(`frontend/src/${path}`, "utf8")).join("\n");
  assert.doesNotMatch(sources, /BestIpAction|BestIpZip|api\.github\.com|github_pat/);
  for (const path of ["ui.js", "main.js", "state.js", "scan-controller.js", "views/scan-view.js", "views/table-view.js", "views/detail-view.js"]) {
    assert.doesNotMatch(readFileSync(`frontend/src/${path}`, "utf8"), /localMode|credentials|\/api\/|scanToken|run_id|runId|actionRequestId/);
  }
  const headers = indexSource.match(/<tr class="header-titles">([\s\S]*?)<\/tr>/)[1];
  const filters = indexSource.match(/<tr class="header-filters">([\s\S]*?)<\/tr>/)[1];
  assert.equal((headers.match(/<th\b/g) || []).length, 11);
  assert.equal((filters.match(/<th\b/g) || []).length, 11);
});

test("pure normalization and views preserve safe text, ASN and missing latency labels", () => {
  const fixture = createFixture();
  assert.equal(normalizeDisplayText("Amazon.com&#x9; Inc."), "Amazon.com Inc.");
  assert.equal(formatAsn("ASAS16509"), "AS16509");
  assert.equal(formatAsn("invalid"), "");
  assert.equal(normalizeUnavailableLatencyStatus("未返回 (-1ms)", "超时"), "未返回");
  assert.equal(fixture.createMiniGptBar([]).textContent, "未检测");
  assert.equal(fixture.createMiniPingBar([]).textContent, "未检测");
  assert.match(fixture.renderThreatChips({ security_status: "检测数据不足" }, {}), /检测数据不足/);
  assert.match(fixture.renderOpenPortsHtml({}, null), /未检测/);
  const injected = '" onmouseover="alert(1)';
  const row = fixture.createResultRow({ node: "node", requests: { ipure: { error_type: "EnrichmentUnavailable", error: injected } }, gpt_check: [], global_ping: [] });
  assert.equal(row.children[1].children[0].title, injected);
  assert.equal(row.children[1].innerHTML, "");
});

test("failed submit is recoverable and health uses only the adapter", async () => {
  const fixture = createFixture();
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  await fixture.ready;
  await submit(fixture);
  assert.equal(fixture.nodes.healthStatus.textContent, "就绪");
  assert.equal(fixture.nodes.modeHint.textContent, "测试适配器");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.nodes.errorMessage.textContent, "网关请求失败");
  assert.equal(fixture.nodes.startButton.disabled, false);
  assert.equal(fixture.nodes.cancelButton.hidden, true);
});

test("missing error element does not crash submission failure", async () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const fixture = createFixture({ includeError: false });
    fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
    await submit(fixture);
    assert.equal(fixture.nodes.startButton.disabled, false);
    assert.match(logs.join(" "), /错误提示区域不可用/);
  } finally { console.error = original; }
});

test("transient polling failure retains retry and unknown nodes", async () => {
  const fixture = createFixture({ start: async () => Object.freeze({}), poll: async () => { throw new Error("暂时网络错误"); } });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  await submit(fixture);
  assert.equal(fixture.nodes.errorMessage.textContent, "读取扫描状态失败，重试中：暂时网络错误");
  assert.equal(fixture.nodes.startButton.disabled, true);
  assert.equal(fixture.timers.at(-1).delay, 2000);
  assert.equal(fixture.nodes.totalStat.textContent, "—");
});

test("step progress is real text and never invents node counts", async () => {
  const name = "<img src=x onerror=alert(1)> verifier";
  const fixture = createFixture({ start: async () => ({}), poll: async () => snapshot({ execution: "running", progress: { source: "steps", label: "步骤进行中", currentStep: name, jobs: { total: 1, current: 1, completed: 0 }, steps: { total: 4, current: 3, completed: 2 }, elapsedMs: 65000, stepElapsedMs: 5000 } }) });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  await submit(fixture);
  assert.equal(fixture.nodes.actionJobProgress.textContent, "任务 1/1 · 已完成 0/1");
  assert.equal(fixture.nodes.actionStepProgress.textContent, "步骤 3/4 · 已完成 2/4");
  assert.equal(fixture.nodes.actionCurrentStep.textContent, `当前步骤：${name}`);
  assert.equal(fixture.nodes.actionCurrentStep.innerHTML, "");
  assert.equal(fixture.nodes.scanProgressCount.textContent, "步骤 3/4");
  assert.equal(fixture.nodes.totalStat.textContent, "—");
  assert.match(fixture.nodes.nodeProgressHint.textContent, /等待终态 artifact/);
});

test("verified partial retains exit data and export; invalid results are never rendered", async () => {
  for (const invalid of [false, true]) {
    const fixture = createFixture({ start: async () => ({}), poll: async () => snapshot({ execution: "completed", done: true, invalid, result: invalid ? null : resultFixture("partial", "partial") }) });
    fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
    await submit(fixture);
    assert.equal(fixture.nodes.startButton.disabled, false);
    assert.equal(fixture.nodes.exportJsonBtn.disabled, invalid);
    assert.equal(fixture.state.results.length, invalid ? 0 : 1);
    if (!invalid) {
      assert.equal(fixture.nodes.issueStat.textContent, "1");
      assert.match(fixture.nodes.nodeProgressHint.textContent, /包含部分\/失败节点/);
      assert.equal(fixture.state.results[0].exit_ip, "203.0.113.10");
    }
  }
});

test("failed cancellation resumes polling; accepted request stays cancelling until terminal", async () => {
  let shouldFail = true;
  let completed = false;
  const fixture = createFixture({ start: async () => ({}), poll: async () => snapshot({ execution: completed ? "cancelled" : "running", done: completed, cleanupConfirmed: completed }), cancel: async () => { if (shouldFail) throw new Error("取消接口暂时不可用"); return { requested: true, confirmed: false }; } });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  await submit(fixture);
  await fixture.controller.cancel();
  assert.equal(fixture.nodes.cancelButton.disabled, false);
  assert.equal(fixture.timers.at(-1).delay, 3000);
  assert.match(fixture.nodes.errorMessage.textContent, /停止失败/);
  shouldFail = false;
  await fixture.controller.cancel();
  assert.equal(fixture.nodes.startButton.disabled, true);
  assert.equal(fixture.nodes.actionProgressStatus.textContent, "取消中，等待确认");
  completed = true;
  await fixture.timers.at(-1).callback();
  assert.equal(fixture.nodes.actionProgressStatus.textContent, "扫描已取消");
  assert.equal(fixture.nodes.startButton.disabled, false);
  completed = false;
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/new";
  await submit(fixture);
  assert.equal(fixture.state.scanning, true);
});

test("stale poll cannot overwrite cancellation or a subsequent scan", async () => {
  let finish;
  let count = 0;
  const fixture = createFixture({ start: async () => ({}), poll: async () => ++count === 1 ? new Promise(resolve => { finish = resolve; }) : snapshot({ execution: "running" }), cancel: async () => ({ requested: true, confirmed: true }) });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  const started = submit(fixture);
  await Promise.resolve();
  await fixture.controller.cancel();
  finish(snapshot({ execution: "completed", result: resultFixture("stale", "success"), done: true }));
  await started;
  assert.equal(fixture.state.results.length, 0);
  assert.equal(fixture.state.snapshot.execution, "cancelled");
});

test("cancel during deferred creation returns promptly and cancels before the first poll", async () => {
  let finishStart;
  const session = Object.freeze({});
  const calls = [];
  const fixture = createFixture({
    start: () => new Promise(resolve => { finishStart = resolve; }),
    cancel: async received => { assert.equal(received, session); calls.push("cancel"); return { requested: true, confirmed: false }; },
    poll: async received => { assert.equal(received, session); calls.push("poll"); return snapshot({ execution: "cancelled", done: true, cleanupConfirmed: true }); },
  });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  const started = submit(fixture);
  await fixture.controller.cancel();
  assert.equal(fixture.nodes.startButton.disabled, true);
  assert.equal(fixture.nodes.cancelButton.disabled, true);
  assert.deepEqual(calls, []);
  finishStart(session);
  await started;
  assert.deepEqual(calls, ["cancel", "poll"]);
  assert.equal(fixture.nodes.actionProgressStatus.textContent, "扫描已取消");
  assert.equal(fixture.nodes.startButton.disabled, false);
  await fixture.controller.cancel();
  assert.deepEqual(calls, ["cancel", "poll"]);
});

test("deferred creation failure clears cancellation and permits another submission", async () => {
  let rejectStart;
  const fixture = createFixture({ start: () => new Promise((_resolve, reject) => { rejectStart = reject; }) });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  const started = submit(fixture);
  await fixture.controller.cancel();
  rejectStart(new Error("创建失败"));
  await started;
  assert.equal(fixture.nodes.startButton.disabled, false);
  assert.equal(fixture.nodes.cancelButton.hidden, true);
  assert.equal(fixture.nodes.cancelButton.disabled, false);
  assert.equal(fixture.nodes.errorMessage.textContent, "创建失败");
});

test("permanent poll failure pauses requests but retains cancellation and blocks duplicate scans", async () => {
  const session = Object.freeze({});
  let starts = 0;
  let cancellationFails = true;
  const fixture = createFixture({
    start: async () => { starts += 1; return session; },
    poll: async () => { throw Object.assign(new Error("<img src=x>状态不可读"), { retryable: false }); },
    cancel: async received => {
      assert.equal(received, session);
      if (cancellationFails) throw Object.assign(new Error("停止暂不可用"), { retryable: false });
      return { requested: true, confirmed: true };
    },
  });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  await submit(fixture);
  assert.equal(fixture.nodes.startButton.disabled, true);
  assert.equal(fixture.nodes.cancelButton.hidden, false);
  assert.equal(fixture.nodes.cancelButton.disabled, false);
  assert.equal(fixture.nodes.importResultsBtn.disabled, true);
  assert.equal(fixture.timers.filter(timer => !timer.cancelled).length, 0);
  assert.match(fixture.nodes.errorMessage.textContent, /<img src=x>状态不可读/);
  assert.equal(fixture.nodes.errorMessage.innerHTML, "");
  await fixture.controller.start("https://subscription.example/duplicate");
  assert.equal(starts, 1);
  assert.throws(() => fixture.controller.importResults({ results: [] }, "json", "import.json"), /请先停止/);
  await fixture.controller.cancel();
  assert.equal(fixture.nodes.startButton.disabled, true);
  assert.equal(fixture.nodes.cancelButton.disabled, false);
  assert.equal(fixture.timers.filter(timer => !timer.cancelled).length, 0);
  cancellationFails = false;
  await fixture.controller.cancel();
  assert.equal(fixture.nodes.startButton.disabled, false);
  assert.equal(fixture.nodes.cancelButton.hidden, true);
  await fixture.controller.start("https://subscription.example/next");
  assert.equal(starts, 2);
});

test("permanent poll failure during unconfirmed cancellation leaves a usable stop button", async () => {
  let broken = false;
  const fixture = createFixture({
    start: async () => ({}),
    poll: async () => {
      if (broken) throw Object.assign(new Error("状态授权失效"), { retryable: false });
      return snapshot({ execution: "running" });
    },
  });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  await submit(fixture);
  await fixture.controller.cancel();
  broken = true;
  await fixture.timers.at(-1).callback();
  assert.equal(fixture.nodes.startButton.disabled, true);
  assert.equal(fixture.nodes.cancelButton.hidden, false);
  assert.equal(fixture.nodes.cancelButton.disabled, false);
  assert.notEqual(fixture.state.snapshot.cleanupConfirmed, true);
});

test("malformed imported probe entries normalize before filtering, table, detail and export", () => {
  const invalid = [null, 7, false, [], { name: 42 }, { name: null }, { name: { host: "unknown" } }];
  const parsed = parseImportedJson(JSON.stringify([{ node: "mixed", exit_ip: "203.0.113.1",
    gpt_check: [...invalid, { name: "api.openai.com", text: "正常", ok: true, elapsed_ms: 25 }],
    global_ping: [...invalid, { name: "Tokyo", code: "JP", status: "正常", ok: true, elapsed_ms: 12 }],
  }]));
  const fixture = createFixture();
  fixture.controller.importResults(parsed, "json", "mixed.json");
  assert.equal(fixture.nodes.resultBody.children[0].children.length, 1);
  assert.equal(fixture.nodes.emptyResults.hidden, true);
  assert.equal(filterResults(parsed.results, { query: "Tokyo", columnFilters: { gpt: "api.openai", ping: "JP" } }).length, 1);
  assert.equal(filterResults(parsed.results, { query: "missing" }).length, 0);
  fixture.openDetails(parsed.results[0]);
  assert.equal(fixture.nodes.detailDialog.open, true);
  const detailCards = fixture.nodes.detailContent.children[0].children;
  assert.ok(detailCards.some(card => card.innerHTML.includes("api.openai.com")));
  assert.ok(detailCards.some(card => card.innerHTML.includes("Tokyo")));
  const exported = buildJsonExport(fixture.state);
  assert.equal(exported.results[0].gpt_check.at(-1).name, "api.openai.com");
  assert.match(buildCsvExport(parsed.results), /正常 25ms/);
  const empty = normalizeImportedResult({ node: "empty", gpt_check: [null, 3], global_ping: [null, false] }, 0, "json");
  assert.equal(fixture.createMiniGptBar(empty.gpt_check).textContent, "未检测");
  assert.equal(fixture.createMiniPingBar(empty.global_ping).textContent, "未检测");
  fixture.openDetails(empty);
  assert.equal(fixture.nodes.detailDialog.open, true);
});

test("JSON/CSV round trip retains scores, full details, quotes and imported trust boundary", () => {
  const result = { ...resultFixture("imported", "partial").results[0], node: 'node, "quoted"', score: 80, ipure_scores: { total: 80, ai: 90, streaming: 70, ecommerce: 60, email: 50 }, coffee_score: 75, gpt_check: [{ name: "chatgpt.com", elapsed_ms: 100, ok: true, text: "正常" }], asn: "ASAS16509" };
  const parsed = parseImportedJson(JSON.stringify({ results: [result] }));
  const csv = buildCsvExport(parsed.results);
  assert.match(csv, /IPure总分,IPure四项评分,Coffee评分/);
  const roundTrip = parseImportedCsv(csv);
  assert.equal(roundTrip.results[0].node, result.node);
  assert.equal(roundTrip.results[0].score, 80);
  assert.equal(roundTrip.results[0].ipure_scores.ai, 90);
  assert.equal(roundTrip.results[0].asn, 16509);
  const fixture = createFixture();
  fixture.controller.importResults(parsed, "json", "fixture.json");
  assert.equal(fixture.nodes.exportJsonBtn.disabled, false);
  assert.match(fixture.nodes.nodeProgressHint.textContent, /用户导入/);
  fixture.openDetails(fixture.state.results[0]);
  assert.equal(fixture.nodes.detailDialog.open, true);
  assert.equal(fixture.state.activeDetailResult.node, result.node);
  const exported = buildJsonExport(fixture.state);
  assert.equal(exported.results[0]._source, undefined);
  assert.equal(exported.cleanup_confirmed, false);
  assert.deepEqual(exported.results[0].coffee, result.coffee);
  fixture.nodes.detailDialog.close();
  assert.equal(fixture.state.activeDetailResult, null);
  assert.throws(() => parseImportedJson("{}"), /没有可导入/);
  assert.throws(() => parseImportedCsv("unknown\nnode"), /表头/);
});

test("pure filtering and sorting preserves all table filter responsibilities", () => {
  const first = normalizeImportedResult({ node: "alpha", status: "success", score: 90, exit_ip: "203.0.113.1", isp: "Example ISP", is_native: true, is_residential: true, security_status: "纯净", gpt_check: [{ name: "chatgpt.com", text: "正常", elapsed_ms: 100 }], global_ping: [{ name: "Tokyo", code: "JP", elapsed_ms: 25 }] }, 0, "json");
  const second = normalizeImportedResult({ node: "beta", status: "partial", score: 40, exit_ip: "203.0.113.2", is_vpn: true, security_status: "VPN" }, 1, "json");
  assert.deepEqual(filterResults([second, first]).map(item => item.node), ["alpha", "beta"]);
  assert.deepEqual(filterResults([second, first], { sortKey: "node", sortDirection: "desc" }).map(item => item.node), ["beta", "alpha"]);
  assert.deepEqual(filterResults([first, second], { query: "Tokyo", status: "success", columnFilters: { node: "ALP", score: "high", status: "success", exit_ip: ".1", isp: "example", native: "residential", security: "clean", gpt: "100", ping: "JP" } }), [first]);
  assert.deepEqual(filterResults([first, second], { columnFilters: { score: "low", security: "vpn" } }), [second]);
  assert.equal(filterResults([first], { columnFilters: { native: "broadcast" } }).length, 0);
});
