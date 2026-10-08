// 扫描通路的端到端实测：对线上站点走一遍「登录 → 发起扫描 → 跟进度 → 取产物并逐字节校验」。
//
// 和浏览器走的是同一份代码：轮询、阶段判定、进度读数规整、签名地址取字节、ZIP/CRC/SHA-256/manifest
// 校验，全部直接 import frontend-next/app/ 下的模块，只把 fetch 换成「带会话 cookie 与同源 Origin」
// 的那一个。所以这里绿了，说明的是页面那条路本身通了，而不是另写的一份仿制品通了。
//
// 唯一的差别是加密那一步：订阅明文不能出现在 Actions 输入或日志里，所以信封由发起方事先用同一份
// app/scan-crypto.js 封好（明文只在发起方本机出现过一次），这里原样 POST。
//
// 输出只有聚合数字（节点数、各状态计数、耗时分布、进度读数时间线、按序号的逐节点耗时），不打印
// 节点名、出口 IP 或任何订阅内容——Actions 日志可能对外可见。
//
// 用法：
//   SITE_PASSWORD=... BEST_IP_DISPATCH='{"request_id":…,"key_id":…,"encrypted_subscription_url":…}' \
//     node scripts/verify_scan_flow.mjs --site https://best-ip.silverwolfx.workers.dev
// 退出码：0 全部通过；1 有失败项。

import {
  pollScan, pollProgress, SCAN_POLL_FIRST_MS, SCAN_POLL_MAX_MS, SCAN_POLL_FINISH_MS, SCAN_PROGRESS_POLL_MS,
} from "../frontend-next/app/scan.js";
import { fetchLatestScan, pollLatestActive } from "../frontend-next/app/gateway.js";
import { countText, nodesAllFinal } from "../frontend-next/app/progress.js";

const argv = process.argv.slice(2);
const argOf = (name, fallback = "") => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const SITE = argOf("site", "https://best-ip.silverwolfx.workers.dev").replace(/\/+$/u, "");
const PASSWORD = process.env.SITE_PASSWORD || "";
const UA = "best-ip-scan-flow-verify";
const SESSION_COOKIE = "__Host-best-ip-session";
const failures = [];
const started = Date.now();

function record(ok, label, detail = "") {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cookiesOf(response) {
  const raw = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return raw.map((entry) => entry.split(";")[0].trim()).filter(Boolean);
}

async function login() {
  const page = await fetch(`${SITE}/login`, { headers: { "User-Agent": UA }, redirect: "manual" });
  const html = await page.text();
  const csrf = /name="csrf" value="([A-Za-z0-9_-]{32})"/u.exec(html)?.[1] || "";
  const csrfCookie = cookiesOf(page).find((entry) => entry.includes("login-csrf")) || "";
  if (!csrf || !csrfCookie) throw new Error(`登录页没有下发 CSRF 令牌（HTTP ${page.status}）`);
  const response = await fetch(`${SITE}/login`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Origin: SITE, Cookie: csrfCookie },
    body: new URLSearchParams({ csrf, password: PASSWORD }).toString(),
    redirect: "manual",
  });
  const session = cookiesOf(response).find((entry) => entry.startsWith(`${SESSION_COOKIE}=`)) || "";
  if (response.status !== 303 || !session) throw new Error(`登录没有换到会话（HTTP ${response.status}）`);
  return session;
}

/** 网关错误体（worker/responses.js 的 { error, detail }）→ 一句可排查的话；读不到就只给状态码。 */
async function gatewayError(response) {
  const body = await response.json().catch(() => null);
  const code = typeof body?.error === "string" ? body.error : "";
  const detail = typeof body?.detail === "string" ? body.detail : "";
  return [`HTTP ${response.status}`, code, detail].filter(Boolean).join(" · ");
}

/** 浏览器里的 fetch：同源请求带会话 cookie 与 Origin，跨源（签名 blob）什么都不带。 */
function browserFetch(session) {
  return (input, init = {}) => {
    const raw = input instanceof URL ? input.href : String(input);
    const url = raw.startsWith("/") ? `${SITE}${raw}` : raw;
    const headers = new Headers(init.headers || {});
    if (url.startsWith(`${SITE}/`)) {
      headers.set("Cookie", session);
      headers.set("Origin", SITE);
      headers.set("User-Agent", UA);
    }
    return fetch(url, { ...init, headers, redirect: "manual" });
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

/** 一份已校验产物的聚合摘要：只有数字。 */
function summarize(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const counts = { success: 0, partial: 0, failed: 0 };
  let scored = 0;
  const elapsed = [];
  for (const item of results) {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
    if (Number.isInteger(item.score) && item.score >= 0) scored += 1;
    if (Number.isInteger(item.elapsed_ms)) elapsed.push(item.elapsed_ms);
  }
  elapsed.sort((a, b) => a - b);
  const wall = Date.parse(payload?.finished_at || "") - Date.parse(payload?.created_at || "");
  return {
    total: results.length,
    ...counts,
    ipure_scored: scored,
    scan_wall: Number.isFinite(wall) ? seconds(wall) : "未知",
    node_p50: seconds(percentile(elapsed, 0.5)),
    node_p90: seconds(percentile(elapsed, 0.9)),
    node_max: seconds(elapsed.at(-1) || 0),
  };
}

const NODE_STATES = ["wait", "start", "connect", "lookup", "retry", "success", "partial", "failed"];

/** 逐节点读数的直方图：「等待 3 · 启动 2 · 连接 5 …」，只有数字。 */
function histogram(nodes) {
  const tally = Object.fromEntries(NODE_STATES.map((state) => [state, 0]));
  for (const node of nodes) tally[node.s] += 1;
  return NODE_STATES.filter((state) => tally[state]).map((state) => `${state} ${tally[state]}`).join(" · ");
}

/**
 * 页面的逐节点那一路：每 SCAN_PROGRESS_POLL_MS 问一次 /api/scans/<id>/progress，直到 stop()。
 * 只记数字：读了几次、几次带节点、节点状态变了几次、同时在检测的最多几个，以及最后一份读数。
 */
function startFeed(target, fetchImpl, clickedAt) {
  const stats = { reads: 0, withNodes: 0, changes: 0, maxActive: 0, firstNodesAt: 0, last: null, errors: 0 };
  let stopped = false;
  let lastShape = "";
  const loop = (async () => {
    while (!stopped) {
      try {
        const progress = await pollProgress(target, { fetchImpl });
        stats.reads += 1;
        if (progress?.nodes) {
          stats.withNodes += 1;
          if (!stats.firstNodesAt) stats.firstNodesAt = Date.now() - clickedAt;
          const shape = histogram(progress.nodes);
          const active = progress.nodes.filter((node) => ["start", "connect", "lookup", "retry"].includes(node.s)).length;
          stats.maxActive = Math.max(stats.maxActive, active);
          if (shape !== lastShape) {
            stats.changes += 1;
            lastShape = shape;
            console.log(`      ${seconds(Date.now() - clickedAt).padStart(7)}  节点 | ${shape}`);
          }
          stats.last = progress;
        }
        if (progress?.phase === "done") break;
      } catch {
        stats.errors += 1;
      }
      await sleep(SCAN_PROGRESS_POLL_MS);
    }
  })();
  return { stats, stop: async () => { stopped = true; await loop; } };
}

function dispatchInput() {
  const raw = process.env.BEST_IP_DISPATCH || "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BEST_IP_DISPATCH 不是 JSON");
  }
  const envelope = JSON.parse(String(parsed?.encrypted_subscription_url || "null"));
  if (typeof parsed?.request_id !== "string" || typeof parsed?.key_id !== "string" || !envelope) {
    throw new Error("BEST_IP_DISPATCH 缺少 request_id / key_id / encrypted_subscription_url");
  }
  return { request_id: parsed.request_id, key_id: parsed.key_id, envelope };
}

async function main() {
  console.log(`站点：${SITE}\n`);
  if (!PASSWORD) {
    record(false, "SITE_PASSWORD 已提供");
    return;
  }
  const dispatch = dispatchInput();
  const session = await login();
  record(true, "登录换取会话");
  const fetchImpl = browserFetch(session);

  // ---- 上一份结果：页面打开时读的就是它（只读路径），顺便留一份「之前」的耗时作对照 ----
  try {
    const before = await fetchLatestScan({ fetchImpl });
    record(true, "读取最近一次扫描并逐字节校验", JSON.stringify(summarize(before.payload)));
  } catch (error) {
    // 页面只说得出状态码；这里再原样问一次，把网关自己的错误码与原因打出来，排查时不用猜。
    const raw = await fetchImpl("/api/scans/latest", { headers: { Accept: "application/json" } });
    const why = raw.ok ? "" : `；网关：${await gatewayError(raw)}`;
    console.log(`      最近一次扫描不可读（${error?.code || "error"}：${error?.message}${why}）——不影响本次实测`);
  }

  // ---- 发起：与页面同一个端点、同一个信封形状 ----
  const clickedAt = Date.now();
  const response = await fetchImpl("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(dispatch),
  });
  const created = response.status === 202 ? await response.json().catch(() => null) : null;
  record(response.status === 202 && typeof created?.scan_token === "string", "Worker 接受扫描请求",
    response.status === 202 ? "HTTP 202" : await gatewayError(response));
  if (response.status !== 202 || !created?.scan_token) return;

  const scan = {
    id: dispatch.request_id,
    token: created.scan_token,
    runId: 0,
    runAttempt: 0,
    dispatchedAt: Number.isSafeInteger(created.dispatched_at) ? created.dispatched_at : clickedAt,
    status: "queued",
    hasRun: false,
    cancelRequestedAt: 0,
  };

  // ---- 跟进度：节奏与页面一致（首轮 SCAN_POLL_FIRST_MS，×1.5，上限 SCAN_POLL_MAX_MS）----
  let delay = SCAN_POLL_FIRST_MS;
  let last = "";
  const reached = {};
  let progressReadings = 0;
  let scanningReadings = 0;
  let followChecked = false;
  let state = null;
  let feed = null;
  for (;;) {
    await sleep(delay);
    // 与页面同一个节奏：节点检测完（packaging/done）之后每秒一次，其余每次 ×1.5、封顶。
    // 下一次间隔按「这一轮拿到的读数」算，所以放在轮询之后（见循环末尾）。
    try {
      state = await pollScan(scan, { fetchImpl });
    } catch (error) {
      if (error?.retryable === true) {
        console.log(`      ${seconds(Date.now() - clickedAt)}  轮询瞬时失败，重试：${error.message}`);
        delay = Math.min(SCAN_POLL_MAX_MS, Math.round(delay * 1.5));
        continue;
      }
      await feed?.stop();
      record(false, "扫描状态轮询", `${error?.code || "error"}：${error?.message}`);
      return;
    }
    const at = Date.now() - clickedAt;
    if (!reached[state.stage]) reached[state.stage] = at;
    // 拿到运行身份就开始逐节点读数，与页面同一时机。
    if (!feed && scan.runId && !state.done) {
      feed = startFeed({ id: scan.id, runId: scan.runId, runAttempt: scan.runAttempt }, fetchImpl, clickedAt);
    }
    if (state.progress) {
      progressReadings += 1;
      if (state.progress.phase === "scanning") scanningReadings += 1;
    }
    const line = `${state.stage} | ${countText(state.progress) || state.progress?.phase || "-"} | ${state.message}`;
    if (line !== last) {
      console.log(`      ${seconds(at).padStart(7)}  ${line}`);
      last = line;
    }
    // 刷新页面后的「跟进」路径：没有 scan_token，只读 /api/scans/latest 的 active。
    if (!followChecked && state.stage === "scan" && !state.done) {
      followChecked = true;
      try {
        const { active } = await pollLatestActive({ fetchImpl });
        record(active?.requestId === scan.id, "刷新后的跟进路径能看到这次扫描",
          active ? `${active.status}${active.progress ? ` · ${countText(active.progress) || active.progress.phase}` : " · 无计数"}` : "active 为空");
      } catch (error) {
        record(false, "刷新后的跟进路径能看到这次扫描", error?.message);
      }
    }
    if (state.done) break;
    const finishing = [feed?.stats.last, state.progress].some((item) => ["packaging", "done"].includes(item?.phase));
    delay = finishing ? SCAN_POLL_FINISH_MS : Math.min(SCAN_POLL_MAX_MS, Math.round(delay * 1.5));
  }

  const total = Date.now() - clickedAt;
  await feed?.stop();
  if (state.failure) {
    record(false, "扫描成功结束", state.failure);
    return;
  }
  record(true, "产物取回并通过逐字节校验（与页面同一份 reader）");
  record(progressReadings > 0, "运行中读到 runner 的实时进度", `${progressReadings} 次读数，其中扫描中 ${scanningReadings} 次`);
  const summary = summarize(state.payload);
  const final = state.progress;
  record(!final || (final.total === summary.total && final.success === summary.success
    && final.partial === summary.partial && final.failed === summary.failed),
  "最后一次进度读数与终态产物计数一致", final ? countText(final) : "没有最后读数");
  // 逐节点那一路：读到过、最后一份全部落定，且每个序号的终态与产物里同一个节点逐一相同。
  const stats = feed?.stats;
  record(Boolean(stats?.withNodes), "运行中读到逐节点的实时状态",
    stats ? `${stats.reads} 次读数，${stats.withNodes} 次带节点，状态变化 ${stats.changes} 次，同时检测最多 ${stats.maxActive} 个，首次出现 ${seconds(stats.firstNodesAt)}` : "没有读数");
  const results = Array.isArray(state.payload?.results) ? state.payload.results : [];
  const byIndex = new Map(results.map((item) => [item.node_index, item]));
  const lastNodes = stats?.last?.nodes || [];
  const mismatched = lastNodes.filter((node, index) => byIndex.get(index)?.status !== node.s).length;
  record(nodesAllFinal(lastNodes) && lastNodes.length === results.length && mismatched === 0,
    "最后一份逐节点读数与产物逐一一致", `${lastNodes.length} 个节点，不一致 ${mismatched} 个`);
  // 按序号的逐节点耗时（实时读数里的节点总用时，含重试）与尝试次数——只有数字，用来看长尾落在哪。
  const rows = lastNodes.map((node, index) => ({ index, status: node.s, attempts: node.a, wall_ms: node.ms }))
    .sort((left, right) => right.wall_ms - left.wall_ms);
  console.log("逐节点（按用时降序，序号从 0 起）：" + rows.map((row) => `#${row.index} ${row.status} ×${row.attempts} ${seconds(row.wall_ms)}`).join(" · "));
  console.log(`\n本次结果：${JSON.stringify(summary)}`);
  console.log("阶段首次出现（自点击起）：" + Object.entries(reached).map(([stage, ms]) => `${stage} ${seconds(ms)}`).join(" · "));
  console.log(`点击 → 结果上屏：${seconds(total)}`);
}

try {
  await main();
} catch (error) {
  record(false, "实测中断", error?.message || String(error));
}
console.log(`\n用时 ${seconds(Date.now() - started)}；${failures.length ? `${failures.length} 项失败` : "全部通过"}`);
if (failures.length) process.exitCode = 1;
