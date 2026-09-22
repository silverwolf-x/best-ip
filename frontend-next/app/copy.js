/* ============================================================================
   剪贴板复制 —— 本文件是**唯一**的复制实现，页面与离线快照共用同一份源码。
   ----------------------------------------------------------------------------
   为什么写成经典脚本而不是 ES module：
   离线快照是一个单文件 .html，里面必须自带可用的复制逻辑。与其把复制逻辑抄一份
   塞进快照模板（两份实现必然漂移），不如让导出时把**本文件原文**内联进去——
   它不 import 任何东西，只往 globalThis 挂一个命名空间，因此同一份文本既能被
   页面当经典脚本加载，也能被快照原样内联。

   为什么要 execCommand 回退：
   navigator.clipboard 只在安全上下文里可用，而且要求文档获得焦点、权限被授予。
   file:// 打开的快照在部分浏览器里没有 navigator.clipboard（或直接 NotAllowedError），
   这时唯一还能写系统剪贴板的路径就是 document.execCommand("copy") + 选中一个临时
   textarea。快照要能离线复制，这条回退就是必需路径，不是锦上添花。
   ========================================================================== */
(function () {
  "use strict";

  // 按钮反馈停留时长；太短看不出成功，太长会挡住下一次点击。
  var FEEDBACK_MS = 1600;

  // 回退用的临时输入框类名。样式在 styles.css 的 .clipboard-buffer 里，
  // 此处不写内联 style：生产 CSP 是 style-src 'self'，标记里的 style 属性会被拦掉，
  // 而内联进快照的样式表里同样有这个类。
  var BUFFER_CLASS = "clipboard-buffer";

  function selectBuffer(buffer) {
    // 旧 iOS Safari 在 readonly 的 textarea 上 select() 会失败，
    // 这里显式给选区范围，覆盖 select() 不生效的实现。
    buffer.focus();
    buffer.select();
    if (typeof buffer.setSelectionRange === "function") {
      buffer.setSelectionRange(0, buffer.value.length);
    }
  }

  function execCommandCopy(value) {
    var buffer = document.createElement("textarea");
    buffer.className = BUFFER_CLASS;
    buffer.value = value;
    buffer.setAttribute("readonly", "");
    buffer.setAttribute("aria-hidden", "true");
    buffer.setAttribute("tabindex", "-1");
    document.body.appendChild(buffer);

    // 复制会顶掉用户当前选区，结束后要还回去，否则在搜索框里选了字再点复制会丢选区。
    var selection = typeof document.getSelection === "function" ? document.getSelection() : null;
    var previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;

    var copied = false;
    try {
      selectBuffer(buffer);
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }

    buffer.remove();
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    return copied;
  }

  /**
   * 把 text 写入系统剪贴板。
   * @returns {Promise<"clipboard"|"execCommand">} 实际生效的通道；两条路都失败时抛错。
   */
  function copyText(text) {
    var value = text === null || text === undefined ? "" : String(text);
    if (!value) return Promise.reject(new Error("没有可复制的内容"));

    var clipboard = globalThis.navigator ? globalThis.navigator.clipboard : null;
    var canUseAsyncApi = Boolean(clipboard) && typeof clipboard.writeText === "function";

    // 先走异步 Clipboard API；它可能在 await 期间被拒（无焦点/无权限），
    // 所以失败必须落到回退，而不是直接报错。
    var attempt = canUseAsyncApi
      ? Promise.resolve()
          .then(function () { return clipboard.writeText(value); })
          .then(function () { return "clipboard"; })
          .catch(function () { return null; })
      : Promise.resolve(null);

    return attempt.then(function (method) {
      if (method) return method;
      if (execCommandCopy(value)) return "execCommand";
      throw new Error("浏览器拒绝了剪贴板写入（Clipboard API 与 execCommand 都不可用）");
    });
  }

  function setFeedback(button, state, label) {
    if (state) {
      button.dataset.state = state;
    } else {
      delete button.dataset.state;
    }
    var text = button.querySelector(".copy-lbl");
    if (text) text.textContent = label;
  }

  function runCopy(button) {
    var labelNode = button.querySelector(".copy-lbl");
    var originalLabel = labelNode ? labelNode.textContent : "";
    var value = button.dataset.copy || "";

    // 连续点击时用同一把定时器复位，避免前一次的定时器把后一次的反馈提前抹掉。
    if (button.dataset.copyTimer) {
      clearTimeout(Number(button.dataset.copyTimer));
      delete button.dataset.copyTimer;
    }

    button.disabled = true;
    copyText(value)
      .then(function (method) {
        setFeedback(button, "copied", "已复制");
        button.dispatchEvent(new CustomEvent("bestip:copy", {
          bubbles: true,
          detail: { text: value, method: method, ok: true },
        }));
      })
      .catch(function (error) {
        setFeedback(button, "error", "复制失败");
        button.title = error.message;
        button.dispatchEvent(new CustomEvent("bestip:copy", {
          bubbles: true,
          detail: { text: value, method: null, ok: false, error: error.message },
        }));
      })
      .then(function () {
        button.disabled = false;
        button.dataset.copyTimer = String(setTimeout(function () {
          delete button.dataset.copyTimer;
          setFeedback(button, null, originalLabel);
        }, FEEDBACK_MS));
      });
  }

  /**
   * 给作用域内所有 [data-copy] 按钮接上复制行为。可重复调用（按钮只绑一次），
   * 因此页面渲染完新行后可以直接再调一次，不需要自己记账。
   *
   * 「已绑定」的记账只放在内存里的 WeakSet，**绝不写进 DOM 属性**：离线快照是拿实时
   * 页面的 outerHTML 拼出来的，绑定标记一旦落到标记语言里，快照里的按钮就会自带这个
   * 标记，attach() 会以为已经绑过而整体跳过——导出的快照里复制按钮就成了按不动的死按钮。
   * （这条实测过：.html 快照曾有 10 个 data-copy-bound="1" 而零个点击监听。）
   */
  var BOUND = new WeakSet();

  function attach(root) {
    var scope = root || document;
    var buttons = scope.querySelectorAll("[data-copy]");
    Array.prototype.forEach.call(buttons, function (button) {
      if (BOUND.has(button)) return;
      BOUND.add(button);
      button.addEventListener("click", function () { runCopy(button); });
    });
  }

  globalThis.BestIpCopy = { copyText: copyText, attach: attach };
})();
