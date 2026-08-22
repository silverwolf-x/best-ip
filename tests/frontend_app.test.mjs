import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const appSource = readFileSync("frontend/app.js", "utf8");
const indexSource = readFileSync("frontend/index.html", "utf8");

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
      remove: () => {},
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

function createFixture({ includeError = true, dispatch, poll, cancel, pagesMode = true, fetchImpl } = {}) {
  const ids = [...new Set(
    [...indexSource.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id),
  )].filter((id) => includeError || id !== "errorMessage");
  const nodes = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]));
  const meta = { content: "" };
  const document = {
    documentElement: { dataset: {} },
    querySelector(selector) {
      if (selector === 'meta[name="api-base"]') return meta;
      if (selector.startsWith("#")) return nodes[selector.slice(1)] || null;
      return null;
    },
    querySelectorAll() { return []; },
    createDocumentFragment() { return new FakeElement("fragment"); },
    createElement(tagName) { return new FakeElement(tagName); },
    createTextNode(text) {
      const node = new FakeElement("text");
      node.textContent = text;
      return node;
    },
  };
  const timers = [];
  const calls = [];
  const logs = [];
  const action = {
    MAX_POLL_DELAY_MS: 10_000,
    isPagesMode: () => pagesMode,
    dispatch: dispatch || (async (...args) => {
      calls.push(args);
      throw new Error("PAT 无效");
    }),
    poll: poll || (async () => ({ status: "dispatching", manifest_ready: false })),
    cancel: cancel || (async () => {}),
  };
  const window = { BestIpAction: action };
  const context = {
    window,
    document,
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: () => ({ matches: false }),
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => {},
    console: { error: (...args) => logs.push(args.join(" ")), log: () => {}, warn: () => {} },
    fetch: fetchImpl || (async () => { throw new Error("unexpected raw fetch"); }),
    Date,
    Promise,
    URL,
    Blob,
    navigator: { clipboard: { writeText: async () => {} } },
  };
  runInNewContext(appSource, context, { filename: "frontend/app.js" });
  return { nodes, calls, timers, logs };
}

function submit(fixture) {
  const listener = fixture.nodes.scanForm.listeners.get("submit")?.[0];
  assert.ok(listener, "submit listener must be registered");
  return listener({ preventDefault() {} });
}

test("the real page includes the error node and failed Pages submit is recoverable", async () => {
  assert.equal((indexSource.match(/id="errorMessage"/g) || []).length, 1);
  const fixture = createFixture();
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  fixture.nodes.githubPat.value = `github_pat_${"a".repeat(40)}`;

  await submit(fixture);

  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.nodes.errorMessage.hidden, false);
  assert.equal(fixture.nodes.errorMessage.textContent, "PAT 无效");
  assert.equal(fixture.nodes.startButton.disabled, false);
  assert.equal(fixture.nodes.cancelButton.hidden, true);
  assert.equal(fixture.nodes.githubPat.value, "");
  assert.equal(fixture.logs.length, 0);
});

test("a transient Pages polling failure keeps the retry timer alive", async () => {
  const dispatchCalls = [];
  const fixture = createFixture({
    dispatch: async (...args) => {
      dispatchCalls.push(args);
      return { requestId: "req-test", runId: null, dispatchedAt: Date.now() };
    },
    poll: async () => { throw new Error("暂时网络错误"); },
  });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  fixture.nodes.githubPat.value = `github_pat_${"b".repeat(40)}`;

  await submit(fixture);

  assert.equal(dispatchCalls.length, 1);
  assert.equal(fixture.nodes.errorMessage.textContent, "读取 GitHub Actions 状态失败，重试中：暂时网络错误");
  assert.equal(fixture.nodes.startButton.disabled, true);
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.timers[0].delay, 2000);
});

test("missing error markup cannot crash terminal error handling", async () => {
  const fixture = createFixture({ includeError: false });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  fixture.nodes.githubPat.value = `github_pat_${"c".repeat(40)}`;

  await submit(fixture);

  assert.equal(fixture.nodes.startButton.disabled, false);
  assert.equal(fixture.nodes.cancelButton.hidden, true);
  assert.match(fixture.logs.join("\n"), /错误提示区域不可用/);
});

test("Pages renders real Actions job and step progress without node 0/0", async () => {
  const stepName = "<img src=x onerror=alert(1)> verifier";
  const fixture = createFixture({
    dispatch: async () => ({ requestId: "req-progress", runId: 42, dispatchedAt: Date.now() }),
    poll: async () => ({
      status: "running",
      runId: 42,
      manifest_ready: false,
      action_progress: {
        source: "github-actions",
        run_id: 42,
        run_attempt: 2,
        run_status: "running",
        raw_run_status: "in_progress",
        conclusion: null,
        jobs_state: "available",
        jobs_total: 1,
        jobs_completed: 0,
        current_job_index: 1,
        current_step_index: 3,
        steps_total: 4,
        steps_completed: 2,
        current_step: {
          name: stepName,
          status: "in_progress",
          state: "running",
          conclusion: null,
          elapsed_ms: 5000,
        },
        elapsed_ms: 65000,
      },
      node_progress: {
        source: "artifact",
        phase: "waiting_artifact",
        total: null,
        completed: null,
        success_count: null,
        partial_count: null,
        failed_count: null,
        usable: null,
      },
    }),
  });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  fixture.nodes.githubPat.value = `github_pat_${"d".repeat(40)}`;

  await submit(fixture);

  assert.equal(fixture.nodes.actionProgressPanel.hidden, false);
  assert.equal(fixture.nodes.actionJobProgress.textContent, "Job 1/1 · 已完成 0/1");
  assert.equal(fixture.nodes.actionStepProgress.textContent, "Step 3/4 · 已完成 2/4");
  assert.equal(fixture.nodes.actionProgressStatus.textContent, "步骤进行中");
  assert.equal(fixture.nodes.actionCurrentStep.textContent, `当前步骤：${stepName}（in_progress）`);
  assert.equal(fixture.nodes.actionCurrentStep.innerHTML, "");
  assert.equal(fixture.nodes.actionProgressElapsed.textContent, "已用时：本步骤 5秒 · 运行 1分5秒 · Attempt 2");
  assert.equal(fixture.nodes.scanProgressCount.textContent, "步骤 3/4");
  assert.notEqual(fixture.nodes.scanProgressCount.textContent, "0/0");
  assert.equal(fixture.nodes.totalStat.textContent, "—");
  assert.equal(fixture.nodes.completedStat.textContent, "—");
  assert.equal(fixture.nodes.nodeProgressHint.hidden, false);
  assert.match(fixture.nodes.nodeProgressHint.textContent, /等待终态 artifact/);
});

test("Pages switches to verified terminal artifact node counts", async () => {
  const fixture = createFixture({
    dispatch: async () => ({ requestId: "req-terminal", runId: 43, dispatchedAt: Date.now() }),
    poll: async () => ({
      status: "completed",
      runId: 43,
      manifest_ready: true,
      action_progress: {
        source: "github-actions",
        run_id: 43,
        run_attempt: 1,
        run_status: "completed",
        raw_run_status: "completed",
        conclusion: "success",
        jobs_state: "available",
        jobs_total: 1,
        jobs_completed: 1,
        current_job_index: 1,
        current_step_index: 2,
        steps_total: 2,
        steps_completed: 2,
        current_step: { name: "Upload sanitized result artifact", status: "completed", state: "completed", conclusion: "success", elapsed_ms: 1000 },
        elapsed_ms: 7000,
      },
      node_progress: {
        source: "artifact",
        phase: "terminal",
        total: 2,
        completed: 2,
        success_count: 1,
        partial_count: 1,
        failed_count: 0,
        usable: false,
      },
      action_status: { usable: false },
      action_result: {
        results: [
          { node: "node-a", status: "success", score: 80, global_ping: [], gpt_check: [] },
          { node: "node-b", status: "partial", score: 40, global_ping: [], gpt_check: [] },
        ],
        total: 2,
        completed: 2,
        success_count: 1,
        partial_count: 1,
        failed_count: 0,
        manifest_ready: true,
      },
    }),
  });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  fixture.nodes.githubPat.value = `github_pat_${"e".repeat(40)}`;

  await submit(fixture);

  assert.equal(fixture.nodes.actionProgressPanel.hidden, false);
  assert.equal(fixture.nodes.totalStat.textContent, "2");
  assert.equal(fixture.nodes.completedStat.textContent, "2");
  assert.equal(fixture.nodes.successStat.textContent, "1");
  assert.equal(fixture.nodes.issueStat.textContent, "1");
  assert.equal(fixture.nodes.nodeProgressHint.hidden, false);
  assert.match(fixture.nodes.nodeProgressHint.textContent, /包含部分\/失败节点/);
  assert.equal(fixture.nodes.startButton.disabled, false);
  assert.equal(fixture.nodes.cancelButton.hidden, true);
});

test("local mode keeps node progress counters and hides Actions panel", async () => {
  const job = {
    id: "local-1",
    status: "running",
    total: 5,
    completed: 2,
    success_count: 1,
    partial_count: 1,
    failed_count: 0,
    current_node: "node-c",
    results: [],
    manifest_ready: false,
  };
  const fixture = createFixture({
    pagesMode: false,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => job }),
  });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";

  await submit(fixture);

  assert.equal(fixture.nodes.actionProgressPanel.hidden, true);
  assert.equal(fixture.nodes.scanProgressCount.textContent, "2/5");
  assert.equal(fixture.nodes.totalStat.textContent, "5");
  assert.equal(fixture.nodes.completedStat.textContent, "2");
  assert.equal(fixture.nodes.successStat.textContent, "1");
  assert.equal(fixture.nodes.issueStat.textContent, "1");
  assert.match(fixture.nodes.scanStatusText.textContent, /node-c/);
});

test("failed Pages cancellation restores polling and controls", async () => {
  const fixture = createFixture({
    dispatch: async () => ({ requestId: "req-cancel-failure", runId: 44, dispatchedAt: Date.now() }),
    poll: async () => ({
      status: "running",
      runId: 44,
      manifest_ready: false,
      action_progress: {
        source: "github-actions",
        run_status: "running",
        raw_run_status: "in_progress",
        jobs_state: "available",
        jobs_total: 1,
        jobs_completed: 0,
        current_job_index: 1,
        current_step_index: 1,
        steps_total: 1,
        steps_completed: 0,
        current_step: { name: "scan", status: "in_progress", state: "running", conclusion: null },
      },
      node_progress: { source: "artifact", phase: "waiting_artifact", total: null, completed: null },
    }),
    cancel: async () => { throw new Error("取消接口暂时不可用"); },
  });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  fixture.nodes.githubPat.value = `github_pat_${"j".repeat(40)}`;
  await submit(fixture);

  const cancelListener = fixture.nodes.cancelButton.listeners.get("click")?.[0];
  assert.ok(cancelListener);
  await cancelListener({ target: fixture.nodes.cancelButton });

  assert.equal(fixture.nodes.startButton.disabled, true);
  assert.equal(fixture.nodes.cancelButton.hidden, false);
  assert.equal(fixture.nodes.cancelButton.disabled, false);
  assert.equal(fixture.timers.at(-1).delay, 3000);
  assert.match(fixture.nodes.errorMessage.textContent, /停止失败：取消接口暂时不可用/);
});

test("successful Pages cancellation marks the visible Actions state cancelled", async () => {
  const fixture = createFixture({
    dispatch: async () => ({ requestId: "req-cancel-success", runId: 45, dispatchedAt: Date.now() }),
    poll: async () => ({
      status: "running",
      runId: 45,
      manifest_ready: false,
      action_progress: {
        source: "github-actions",
        run_status: "running",
        raw_run_status: "in_progress",
        jobs_state: "available",
        jobs_total: 1,
        jobs_completed: 0,
        current_job_index: 1,
        current_step_index: 1,
        steps_total: 1,
        steps_completed: 0,
        current_step: { name: "scan", status: "in_progress", state: "running", conclusion: null },
      },
      node_progress: { source: "artifact", phase: "waiting_artifact", total: null, completed: null },
    }),
  });
  fixture.nodes.subscriptionUrl.value = "https://subscription.example/config";
  fixture.nodes.githubPat.value = `github_pat_${"k".repeat(40)}`;
  await submit(fixture);

  const cancelListener = fixture.nodes.cancelButton.listeners.get("click")?.[0];
  await cancelListener({ target: fixture.nodes.cancelButton });

  assert.equal(fixture.nodes.actionProgressStatus.textContent, "Actions 已取消");
  assert.equal(fixture.nodes.cancelButton.hidden, true);
  assert.equal(fixture.nodes.startButton.disabled, false);
});
