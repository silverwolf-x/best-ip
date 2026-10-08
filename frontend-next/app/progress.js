/* ============================================================================
   扫描进度面板 —— 五段步骤条 + 节点进度条 + 一行说明
   ----------------------------------------------------------------------------
   一次扫描要经过「提交 → 排队 → 准备环境 → 扫描节点 → 校验结果」五段，原先页面上只有一行
   会变的文字（Actions 的步骤名），几十秒到几分钟里看不出走到了哪、还剩多少。这里把它画成
   一条步骤条，扫描节点那一段再配一根真实的节点进度条（计数来自 runner 的实时回报，见
   worker/progress.js）。

   三条约定：
   - 计数只是过程中的读数：表格仍然只认终态 artifact，面板上的数字不进表、不进导出；
   - 读不到计数（Worker 没有进度存储、runner 没报上来）时退回不定进度条，不编数字；
   - 只用 <progress> 与 data-* 属性表达状态，不写任何 style（生产 CSP 是 style-src 'self'）。
   ========================================================================== */

export const STAGES = [
  ["submit", "提交"],
  ["queue", "排队"],
  ["prepare", "准备环境"],
  ["scan", "扫描节点"],
  ["verify", "校验结果"],
];

const STAGE_KEYS = STAGES.map(([key]) => key);
// scan.yml 里真正跑扫描的那一步。之前的步骤都是准备环境，之后的是上传与清理。
export const SCAN_STEP_NAME = "Run production scan";
const PHASE_STAGE = { subscription: "prepare", scanning: "scan", packaging: "verify", done: "verify" };

// 步骤条每一段的那句话：说「正在做什么」，不说「加载中」。发起扫描与跟进扫描共用。
export const STAGE_TEXT = {
  submit: "正在加密订阅地址并交给扫描网关",
  queue: "排队中：等待 GitHub 分配执行机",
  prepare: "正在准备扫描环境：拉取订阅、启动 Mihomo",
  scan: "正在并发检测每个节点",
  verify: "节点检测完成：正在打包、上传并校验结果",
};
const MAX_COUNT = 100_000;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null;
}

/** Worker 交回的进度读数 → 自洽的计数；任何一项不合规就当没有（退回不定进度条），不猜。 */
export function normalizeProgress(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Object.hasOwn(PHASE_STAGE, raw.phase)) return null;
  const total = count(raw.total);
  const completed = count(raw.completed);
  const success = count(raw.success);
  const partial = count(raw.partial);
  const failed = count(raw.failed);
  if ([total, completed, success, partial, failed].includes(null)) return null;
  if (completed > total || success + partial + failed !== completed) return null;
  return { phase: raw.phase, total, completed, success, partial, failed };
}

function rank(stage) {
  const index = STAGE_KEYS.indexOf(stage);
  return index < 0 ? 0 : index;
}

function later(left, right) {
  return rank(left) >= rank(right) ? left : right;
}

/** 从 Actions 的步骤列表看走到了哪一段：扫描那一步之前是准备，之后是校验。 */
function stageFromSteps(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const job = list.find((item) => item?.status === "in_progress") || list[0] || null;
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const scanIndex = steps.findIndex((step) => step?.name === SCAN_STEP_NAME);
  if (scanIndex < 0) return "prepare";
  const current = steps.findIndex((step) => step?.status === "in_progress");
  if (current >= 0) {
    if (current < scanIndex) return "prepare";
    return current === scanIndex ? "scan" : "verify";
  }
  return steps[scanIndex]?.status === "completed" ? "verify" : "prepare";
}

/**
 * 运行状态 → 步骤条上的一段。runner 的进度读数比步骤名更准（它知道订阅下完没有、
 * 节点扫完没有），但两者取较后的那一段：晚到的旧读数不能把步骤条往回拨。
 */
export function stageOf({ runStatus, jobs = [], progress = null }) {
  if (!runStatus || runStatus === "queued") return "queue";
  if (runStatus === "completed") return "verify";
  const fromSteps = stageFromSteps(jobs);
  const fromProgress = progress ? PHASE_STAGE[progress.phase] : null;
  return fromProgress ? later(fromProgress, fromSteps) : fromSteps;
}

// 时长写法与 scan.js 的 formatDuration 同口径：一小时以内给「分秒」。
export function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000) return "不到 1 秒";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时${minutes}分`;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

/** 「12 / 25 个节点 · 9 完整 · 2 部分 · 1 失败」：只说有的那几项，0 就不提。 */
export function countText(progress) {
  if (!progress || progress.total < 1) return "";
  const parts = [`${progress.completed} / ${progress.total} 个节点`];
  if (progress.success) parts.push(`${progress.success} 完整`);
  if (progress.partial) parts.push(`${progress.partial} 部分`);
  if (progress.failed) parts.push(`${progress.failed} 失败`);
  return parts.join(" · ");
}

/**
 * 绑定面板骨架（index.html 里的 #scanPanel）。缺任何一块都返回一个什么也不做的面板：
 * 进度面板是反馈层，少了它扫描照样能跑完、表格照样能填上。
 */
export function createScanPanel(doc = globalThis.document) {
  const root = doc?.getElementById("scanPanel");
  const steps = root ? Array.from(root.querySelectorAll("[data-step]")) : [];
  const meter = doc?.getElementById("scanMeter");
  const counts = doc?.getElementById("scanCounts");
  const message = doc?.getElementById("scanProgress");
  const elapsed = doc?.getElementById("scanElapsed");
  if (!root || steps.length !== STAGES.length || !meter || !counts || !message || !elapsed) {
    return { show() {}, hide() {}, tick() {}, get visible() { return false; } };
  }

  let startedAt = 0;
  let finishedAt = 0;

  function tick(now = Date.now()) {
    if (!startedAt) {
      elapsed.textContent = "";
      return;
    }
    elapsed.textContent = `已用时 ${formatElapsed((finishedAt || now) - startedAt)}`;
  }

  /**
   * @param {{stage:string, state?:"active"|"done"|"error", progress?:object|null,
   *          message?:string, startedAt?:number, finished?:boolean}} view
   */
  function show(view) {
    const stage = STAGE_KEYS.includes(view.stage) ? view.stage : "submit";
    const state = view.state || "active";
    const current = rank(stage);
    steps.forEach((item, index) => {
      let value = "todo";
      if (state === "done" || index < current) value = "done";
      else if (index === current) value = state === "error" ? "error" : "active";
      item.dataset.state = value;
      if (value === "active") item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
    root.dataset.state = state;

    const progress = view.progress || null;
    const known = Boolean(progress && progress.total > 0);
    // 扫描段且知道总数：确定进度；扫描段但还不知道：不定进度（不编数字）；完成：拉满；其余：空。
    if (state === "done") {
      meter.max = 1;
      meter.value = 1;
    } else if (known && (stage === "scan" || stage === "verify")) {
      meter.max = progress.total;
      meter.value = progress.completed;
    } else if (state === "active" && (stage === "scan" || stage === "prepare")) {
      meter.removeAttribute("value");
    } else {
      meter.max = 1;
      meter.value = 0;
    }
    counts.textContent = known ? countText(progress) : "";
    counts.hidden = !known;
    message.textContent = view.message || "";

    startedAt = Number.isFinite(view.startedAt) && view.startedAt > 0 ? view.startedAt : 0;
    finishedAt = state === "active" ? 0 : (finishedAt || Date.now());
    root.hidden = false;
    tick();
  }

  function hide() {
    root.hidden = true;
    startedAt = 0;
    finishedAt = 0;
  }

  return { show, hide, tick, get visible() { return !root.hidden; } };
}
