/* ============================================================================
   失败对象的唯一工厂 + 网关状态码文案表
   ----------------------------------------------------------------------------
   为什么要把这两件事收成一份：scan.js 的 failure() 与 gateway.js 的 error() 是同形的
   （都往 Error 上挂 code，可选再挂 title），两个文件的 httpMessage() / httpTextFor() 里
   401/403/503 三句也几乎逐字相同。两份实现的实际代价是「同一个 403 在两条路上说得不
   一样」——改文案时只改一处就会留下这种不一致，而错误文案是用户唯一能看到的诊断信息。

   两条路的差异只有两处，这里显式写成调用方传进来的参数，而不是分头维护两份文案：
     1.「这次动作」怎么称呼：发起扫描那条路说「请求」「后再发起扫描」，读最近一次扫描
        那条路说「读取」、不带后缀；
     2. 503 要不要补原因：发起扫描那条路补上「缺少 GitHub Actions 相关的密钥」，读最近
        一次扫描那条路不补（它没有发起任何动作，说这句也没用）。
   ========================================================================== */

/**
 * 造一个带 code 的失败对象。两条网关通路共用。
 *
 * @param {string} code 机器可读的失败码（main.js 用它分流，例如 cancel_timeout 要留住会话）
 * @param {string} message 给用户看的那句话
 * @param {{cause?: any, retryable?: boolean, title?: string}} [extra]
 *   cause 只作为诊断信息挂在 error.cause 上；retryable 默认 false；title 是空状态标题。
 */
export function failure(code, message, { cause = null, retryable, title } = {}) {
  // cause 为空时不传第二个参数：显式传 { cause: undefined } 会让错误多出一个值为 undefined
  // 的自有属性，和原先只有 gateway.js 才带 cause 的行为对不上。
  const error = Object.assign(new Error(message, cause ? { cause } : undefined), { code });
  // 只有明确的瞬时故障才留重试余地（由调用点判断），其余默认不给。
  error.retryable = retryable === true;
  if (title) error.title = title;
  return error;
}

// 状态码 → 文案模板。表里没有的状态交回调用方自己的兜底句：两条路的兜底句本来就不同
// （一条说「扫描网关返回 HTTP N」，另一条说「本站的扫描网关返回 HTTP N」）。
const STATUS_TEXT = {
  401: ({ sessionTail }) => `登录已过期：请重新用访问密码登录本站${sessionTail}。`,
  403: ({ action }) => `本站拒绝了这次${action}（403）：会话与请求来源不匹配。`,
  503: ({ detail }) => `本站的扫描网关尚未配置完成（503）${detail}。`,
};

/**
 * 网关返回的状态码 → 一句话。
 *
 * @param {number} status HTTP 状态码
 * @param {{sessionTail: string, action: string, detail: string, fallback: (status: number) => string}} voice
 *   调用方自己的说法：sessionTail 是 401 那句的后缀，action 是 403 那句里「这一次动作」的叫法，
 *   detail 是 503 那句要不要补的原因，fallback 是表里没有的状态码的兜底句。
 */
export function gatewayStatusText(status, voice) {
  const template = STATUS_TEXT[status];
  return template ? template(voice) : voice.fallback(status);
}
