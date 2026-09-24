/* ============================================================================
   出网请求的超时契约
   ----------------------------------------------------------------------------
   规矩：**frontend-next 里不允许出现裸 fetch**。所有出网请求要么走这里的
   fetchWithTimeout()，要么用 timeoutPair() 自己拿信号并在 finally 里 release()。
   加一个请求就是加一处超时，这条没有例外。

   为什么要把这件事收成一个模块（原先是三份各写各的）：
   scan.js、gateway.js、api.js 各有一份 timeoutSignal，前两份逐字相同。三份里
   写的都是：

     typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined

   这个表达式在旧浏览器上返回 undefined，于是 signal 参数等于没传——**超时静默
   消失**，正好和这三个文件头注释里反复强调的「没有超时会让 promise 永不 settle、
   页面永久停在加载中且没有重试入口」相反。同一段理由被抄了三遍，缺陷也被抄了
   三遍，所以它不再留在调用点，收到这里一处。

   为什么必须有 release()：
   AbortSignal.timeout() 的定时器由平台持有，但退化分支用的是 setTimeout，不清掉
   就会在最坏情况下拖着整个页面（导出、扫描轮询这类一秒多次的路径上更明显）。
   调用方**必须**在 finally 里 release()，这也是它不返回裸 signal 的原因。

   为什么不用 AbortSignal.any() 去合并调用方自己的 signal：
   它在本项目要照顾的浏览器里覆盖不够。需要取消权的地方（例如停止扫描）由调用方
   自己持有 controller，把 controller 的 signal 当 fetchImpl 的一部分传进来即可，
   见 scan.js。
   ========================================================================== */

// 单个请求的默认上限。取值偏宽松：这几个请求最慢的一条是拉签名产物地址，
// 快就是在几百毫秒内返回，慢就是 Worker 那边卡住了——15 秒足够区分这两种情况，
// 又不至于让等不及的人以为页面坏了。
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 造一对「超时信号 + 释放函数」。
 *
 * 与旧实现的关键差别：AbortSignal.timeout 不可用时**退化成 AbortController +
 * setTimeout**，而不是返回 undefined。有时限是这条契约的全部意义，不能在降级
 * 环境里悄悄丢掉。
 *
 * @param {number} ms 毫秒上限
 * @returns {{ signal: AbortSignal | undefined, release: () => void }}
 *          调用方必须在 finally 里调用 release()。
 */
export function timeoutPair(ms = DEFAULT_TIMEOUT_MS) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(ms), release: () => {} };
  }
  if (typeof AbortController === "undefined") {
    // 连 AbortController 都没有的环境（本项目不打算支持，但不说谎）：
    // 交回一个空信号，调用方按「没有取消能力」继续跑，而不是假装有超时。
    return { signal: undefined, release: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(timeoutReason(ms));
  }, ms);
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * 超时的 abort reason。
 *
 * name 必须是 `TimeoutError`：isTimeoutError() 认的就是 name，而 `new Error(...)` 的 name
 * 是 "Error"——退化路径（没有 AbortSignal.timeout 的环境）上的超时于是会被调用方当成普通
 * 网络故障：文案说成「连不上」，scan.js 还会把一次超时当成可重试错误继续退避重试。
 * DOMException 的支持面足够广；确实拿不到时退回手改 name 的 Error，而不是交出一个
 * 调用方认不出来的错误。
 */
function timeoutReason(ms) {
  const message = `请求超过 ${ms} 毫秒未返回`;
  if (typeof DOMException === "function") return new DOMException(message, "TimeoutError");
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

/**
 * 超时/中止类的错误，供调用方决定文案（「N 秒内没有返回」而不是「连不上」）。
 */
export function isTimeoutError(error) {
  return Boolean(error) && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * 带超时的 fetch。
 *
 * 注意 init 里的 signal 会被本函数的超时信号**覆盖**：需要同时保留调用方的取消权时，
 * 不要走这个函数，改用 timeoutPair() 自己拼 init。
 *
 * @param {(input: any, init?: any) => Promise<Response>} fetchImpl 注入的 fetch（测试可替换）
 * @param {any} input 同 fetch 的第一个参数
 * @param {any} init 同 fetch 的第二个参数
 * @param {number} ms 毫秒上限
 */
export async function fetchWithTimeout(fetchImpl, input, init = {}, ms = DEFAULT_TIMEOUT_MS) {
  const { signal, release } = timeoutPair(ms);
  try {
    return await fetchImpl(input, { ...init, signal });
  } finally {
    release();
  }
}
