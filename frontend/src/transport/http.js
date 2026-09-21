export function validateSubscriptionUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("订阅地址格式无效"); }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password) throw new Error("订阅地址必须是公开 HTTP/HTTPS 地址，且不能携带认证信息");
}

export async function responseError(response, serviceName) {
  const messages = { 401: "登录已过期，请刷新页面重新输入访问密码", 403: "当前账号没有扫描权限", 429: "扫描服务触发限流，请稍后重试", 404: "扫描任务或结果不存在" };
  let payload;
  try { payload = await response.clone().json(); } catch {}
  const error = new Error(messages[response.status] || (typeof payload?.detail === "string" ? payload.detail : `${serviceName}请求失败（HTTP ${response.status}）`));
  error.code = typeof payload?.error === "string" ? payload.error : "http_error";
  error.retryable = response.status >= 500 || response.status === 429;
  return error;
}

export function createHttp({ base = "", credentials, serviceName, fetchImpl = globalThis.fetch }) {
  async function request(path, options = {}, token = "") {
    if (!path.startsWith("/api/")) throw new Error("API path 无效");
    const response = await fetchImpl(base + path, { ...options, cache: "no-store", credentials, headers: { Accept: "application/json", ...(token ? { "X-Best-IP-Scan-Token": token } : {}), ...options.headers } });
    if (!response.ok) throw await responseError(response, serviceName);
    return response;
  }
  async function jsonBody(path, options, token) {
    const response = await request(path, options, token);
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new Error("扫描服务返回格式无效"); }
  }

  // 字节由浏览器直连 GitHub 的签名 blob 取，不再经过 Worker（原因见 worker/github.js 顶部）。
  // 这里刻意一个自定义头都不发：跨域请求一旦带上非安全清单里的头，就会多一次 CORS 预检。
  async function delegatedBytes(url) {
    let response;
    try {
      response = await fetchImpl(url, { mode: "cors", credentials: "omit", cache: "no-store", redirect: "follow" });
    } catch (error) {
      response = await fetchImpl(url, { mode: "cors", credentials: "omit", cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(15_000) });
    }
    if (!response.ok) throw Object.assign(new Error(`扫描结果下载失败（HTTP ${response.status}）`), { code: "artifact_unavailable", retryable: true });
    return await response.arrayBuffer();
  }

  return {
    json: jsonBody,
    async artifact(path, token) {
      const payload = await jsonBody(path, {}, token);
      const url = typeof payload?.artifact_url === "string" ? payload.artifact_url : "";
      if (!/^https:\/\/[a-z0-9.-]+\.blob\.core\.windows\.net\//u.test(url)) {
        throw Object.assign(new Error("扫描服务未返回有效的 artifact 地址"), { code: "invalid_artifact", retryable: false });
      }
      const bytes = await delegatedBytes(url);
      if (bytes.byteLength > 50 * 1024 * 1024) throw Object.assign(new Error("扫描 artifact 超出浏览器安全大小限制"), { code: "invalid_artifact", retryable: false });
      return bytes;
    },
  };
}
