/* ============================================================================
   剪贴板复制 —— 本文件是**唯一**的复制实现，页面与离线快照共用同一份源码。
   ----------------------------------------------------------------------------
   为什么写成经典脚本而不是 ES module：
   离线快照是一个单文件 .html，里面必须自带可用的复制逻辑。与其把复制逻辑抄一份
   塞进快照模板（两份实现必然漂移），不如让导出时把**本文件原文**内联进去——
   它不 import 任何东西，只往 globalThis 挂一个命名空间，因此同一份文本既能被
   页面当经典脚本加载，也能被快照原样内联。

   为什么全程 ES5 语法（var / function，不用箭头与可选链）：
   内联后的那段脚本还可能在 file:// 打开、在旧浏览器里跑——execCommand 回退正是
   为这些环境留的（见下）。同一份源码里不给它们留语法地雷。

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

  /**
   * 每个按钮的反馈记账只放内存里的 WeakMap，**一样绝不写进 DOM 属性**：
   * - 定时器 id 写进 dataset 会被序列化进导出的快照（快照就是实时页面的 outerHTML），
   *   而且行重建之后那些 id 指向的句柄早就没了，下一次点击「清掉上一个定时器」只是在
   *   清一个不存在的 id；
   * - 进入反馈前的文案（原文案 + 原 title）必须存下来：失败时 title 会被换成错误原因，
   *   没有存底就只能靠 removeAttribute 复位，而那会把 render.js / index.html 写的那句
   *   说明永久删掉（同一个坑在 main.js 的 EXPORT_TITLES 上已经踩过一次）。
   *
   * 只在**首次**用到某个按钮时记一次，之后不再重记：反馈还显示着的时候再点一次，
   * 如果每次都从 DOM 读「原文案」，读到的就是「已复制」「复制失败」这种临时文案，
   * 复位时会反过来把它当成原文案写回去。
   */
  var FEEDBACK = new WeakMap();

  function feedbackOf(button) {
    var record = FEEDBACK.get(button);
    if (record) return record;
    var label = button.querySelector(".copy-lbl");
    record = {
      label: label ? label.textContent : "",
      title: button.title,
      timer: null,
    };
    FEEDBACK.set(button, record);
    return record;
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

  /** 还原成进入反馈之前的样子：文案、data-state、title 一起回去。 */
  function resetFeedback(button) {
    var record = FEEDBACK.get(button);
    if (!record) return;
    record.timer = null;
    setFeedback(button, null, record.label);
    // title 必须一并写回：只复位文案和 data-state 的话，复制失败时写进去的那条
    // 「浏览器拒绝了剪贴板写入…」会一直挂在按钮上，哪怕后来复制成功了也还在。
    button.title = record.title;
  }

  function runCopy(button) {
    var value = button.dataset.copy || "";
    var record = feedbackOf(button);

    // 连续点击时用同一把定时器复位，避免前一次的定时器把后一次的反馈提前抹掉。
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;

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
        // 不是 Error 的抛出（自定义抛字符串）也要有可读文案，不能显示 "undefined"。
        var message = error && error.message ? error.message : String(error);
        setFeedback(button, "error", "复制失败");
        button.title = message;
        button.dispatchEvent(new CustomEvent("bestip:copy", {
          bubbles: true,
          detail: { text: value, method: null, ok: false, error: message },
        }));
      })
      .then(function () {
        button.disabled = false;
        record.timer = setTimeout(function () {
          resetFeedback(button);
        }, FEEDBACK_MS);
      });
  }

  /**
   * 给作用域内的 [data-copy] 按钮接上复制行为：**在根上绑一次**，点击时用
   * event.target.closest 找按钮。可重复调用（同一个根只绑一次），所以页面渲染完新行后
   * 可以直接再调一次，不需要自己记账。
   *
   * 为什么改成事件委托：每渲染一帧就 querySelectorAll 一遍整表、给每个按钮 new 一个闭包
   * 监听的做法，行数越多越像「每次重建都重新接线一遍」；委托只有一个监听器，而且新行天然
   * 被覆盖，连扫描都不需要。
   *
   * 「根已经绑过」的记账只放在内存里的 WeakSet，**绝不写进 DOM 属性**：离线快照是拿实时
   * 页面的 outerHTML 拼出来的，绑定标记一旦落到标记语言里，快照里的按钮就会自带这个
   * 标记，attach() 会以为已经绑过而整体跳过——导出的快照里复制按钮就成了按不动的死按钮。
   * （这条实测过：.html 快照曾有 10 个 data-copy-bound="1" 而零个点击监听。）
   */
  var BOUND_ROOTS = new WeakSet();

  function attach(root) {
    var scope = root || document;
    if (BOUND_ROOTS.has(scope)) return;
    BOUND_ROOTS.add(scope);
    scope.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var button = target.closest("[data-copy]");
      // closest 会一路往上爬、可能爬到 scope 外面去，所以命中之后必须确认这个按钮真在
      // 作用域里；scope 自己不算——原实现用的 querySelectorAll 只认后代节点。
      if (!button || button === scope || !scope.contains(button)) return;
      runCopy(button);
    });
  }

  globalThis.BestIpCopy = { copyText: copyText, attach: attach };
})();
