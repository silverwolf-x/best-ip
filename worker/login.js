import { assertLoginConfigured, assertSameOrigin, base64UrlEncode, passwordMatches, signSession, SESSION_COOKIE, LOGIN_CSRF_COOKIE, SESSION_TTL_SECONDS } from "./auth.js";
import { limitStream } from "./artifacts.js";
import { HttpError } from "./responses.js";

const cookieFlags = "Path=/; Secure; HttpOnly; SameSite=Strict";

function page(message = "", status = 200, logout = false, csrf = "") {
  return new Response(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Best IP · ${logout ? "退出登录" : "登录"}</title><link rel="stylesheet" href="/login.css"></head>
<body><main><h1>Best IP</h1><p>${logout ? "退出后需要重新输入访问密码。" : "输入访问密码，开始节点检测。"}</p>
<form method="post" action="/${logout ? "logout" : "login"}">
${logout ? "" : `<input type="hidden" name="csrf" value="${csrf}"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024" autofocus>`}
${message ? `<p role="alert">${message}</p>` : ""}
<button type="submit">${logout ? "退出登录" : "登录"}</button></form></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function loginRedirect() {
  return new Response(null, { status: 303, headers: { Location: "/login" } });
}

export async function loginRoute(request, env) {
  const path = new URL(request.url).pathname;
  if (!["/login", "/logout", "/login.css"].includes(path)) return null;
  assertLoginConfigured(env);
  if (path === "/login.css" && request.method === "GET") {
    return new Response('html{font:16px system-ui;color:#292524;background:#faf8f5}body{margin:0;display:grid;min-height:100svh;place-items:center}main{width:min(360px,80vw);padding:32px;background:white;border:1px solid #e7e5e4;border-radius:16px}h1{margin-top:0}p{line-height:1.6;color:#57534e}label{display:block;margin-bottom:8px}input,button{box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #a8a29e;border-radius:8px}button{margin-top:20px;background:#44403c;color:white;cursor:pointer}[role=alert]{color:#b91c1c}',
      { headers: { "Content-Type": "text/css; charset=utf-8" } });
  }
  if (request.method === "GET" && path !== "/login.css") {
    if (path === "/logout") return page("", 200, true);
    const csrf = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
    const response = page("", 200, false, csrf);
    response.headers.set("Set-Cookie", `${LOGIN_CSRF_COOKIE}=${csrf}; ${cookieFlags}; Max-Age=600`);
    return response;
  }
  if (request.method !== "POST" || path === "/login.css") throw new HttpError(405, "请求方法不支持", "method_not_allowed");
  if (path === "/logout") {
    assertSameOrigin(request);
    const response = loginRedirect();
    response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; ${cookieFlags}; Max-Age=0`);
    response.headers.append("Set-Cookie", `${LOGIN_CSRF_COOKIE}=; ${cookieFlags}; Max-Age=0`);
    return response;
  }
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") {
    throw new HttpError(415, "请使用登录表单", "invalid_login_request");
  }
  let body;
  try {
    body = await new Response(limitStream(request.body, 8192)).text();
  } catch {
    throw new HttpError(413, "登录请求过大", "invalid_login_request");
  }
  const form = new URLSearchParams(body);
  const csrf = form.get("csrf") || "";
  const csrfCookie = (request.headers.get("Cookie") || "").split(";")
    .map((part) => part.trim()).find((part) => part.startsWith(`${LOGIN_CSRF_COOKIE}=`))
    ?.slice(LOGIN_CSRF_COOKIE.length + 1) || "";
  if (!csrf || csrf !== csrfCookie || !/^[A-Za-z0-9_-]{32}$/u.test(csrf)) {
    throw new HttpError(403, "登录页面已过期，请刷新后重试", "csrf_rejected");
  }
  const password = form.get("password") || "";
  if (password.length > 1024 || !await passwordMatches(env, password)) return page("访问密码错误，请重试。", 401, false, csrf);
  const token = await signSession(env, new URL(request.url).origin);
  return new Response(null, { status: 303, headers: {
    Location: "/", "Set-Cookie": `${SESSION_COOKIE}=${token}; ${cookieFlags}; Max-Age=${SESSION_TTL_SECONDS}`,
  } });
}
