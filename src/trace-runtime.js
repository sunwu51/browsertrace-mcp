(() => {
  "use strict";

  if (window.__chromeDebuggerTracer) return;

  const CHANNEL = "browsertrace-mcp-trace-v1";
  const INTERACTION_EVENTS = new Set([
    "click", "dblclick", "contextmenu", "submit", "change", "input",
    "keydown", "keyup", "focus", "blur", "wheel", "scroll",
    "mousedown", "mouseup", "mouseover", "mouseenter",
    "pointerdown", "pointerup", "pointerover", "pointerenter"
  ]);
  const eventOperations = new WeakMap();
  const listenerWrappers = new WeakMap();
  let injectedOperation = null;
  let currentOperation = null;
  let sequence = 0;

  function makeId(prefix) {
    return `${prefix}_${crypto.randomUUID?.() || `${Date.now()}_${++sequence}`}`;
  }

  function emit(payload) {
    window.postMessage({ channel: CHANNEL, payload: { ...payload, pageUrl: location.href } }, "*");
  }

  function safeText(value, maxLength = 65536) {
    if (value == null) return "";
    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n...[truncated]` : text;
  }

  function serializeHeaders(headers) {
    try {
      return Object.fromEntries(new Headers(headers || {}).entries());
    } catch {
      return {};
    }
  }

  function describe(event) {
    const target = event.target;
    const control = target?.closest?.("button,a,[role=button],input,textarea,select");
    const text = String(control?.innerText || control?.value || "").trim();
    if (text) return safeText(text, 200);
    return target ? `${target.tagName || "element"}${target.id ? `#${target.id}` : ""}` : event.type;
  }

  function createOperation(event) {
    const supplied = injectedOperation;
    const operation = {
      id: supplied?.id || makeId("op"),
      event: event.type,
      label: supplied?.label || describe(event),
      startedAt: Date.now(),
      source: supplied ? "mcp" : "page"
    };
    emit({ kind: "operation", operation });
    return operation;
  }

  function operationFor(event) {
    let operation = eventOperations.get(event);
    if (!operation) {
      operation = createOperation(event);
      eventOperations.set(event, operation);
    }
    return operation;
  }

  function activeOperation() {
    return currentOperation || injectedOperation;
  }

  function runWithOperation(operation, callback, thisArg, args) {
    const previous = currentOperation;
    currentOperation = operation;
    try {
      return callback.apply(thisArg, args);
    } finally {
      currentOperation = previous;
    }
  }

  function wrapCallback(callback, operation = activeOperation()) {
    if (typeof callback !== "function" || !operation) return callback;
    return function () {
      return runWithOperation(operation, callback, this, arguments);
    };
  }

  function invokeListener(listener, thisArg, args) {
    if (typeof listener === "function") return listener.apply(thisArg, args);
    return listener.handleEvent.apply(listener, args);
  }

  const originalAddEventListener = EventTarget.prototype.addEventListener;
  const originalRemoveEventListener = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!listener || !INTERACTION_EVENTS.has(type)) {
      return originalAddEventListener.call(this, type, listener, options);
    }

    let byType = listenerWrappers.get(listener);
    if (!byType) {
      byType = new Map();
      listenerWrappers.set(listener, byType);
    }
    let wrapped = byType.get(type);
    if (!wrapped) {
      wrapped = function (event) {
        return runWithOperation(operationFor(event), invokeListener, null, [listener, this, arguments]);
      };
      byType.set(type, wrapped);
    }
    return originalAddEventListener.call(this, type, wrapped, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const byType = listener && listenerWrappers.get(listener);
    return originalRemoveEventListener.call(this, type, byType?.get(type) || listener, options);
  };

  const originalThen = Promise.prototype.then;
  Promise.prototype.then = function (onFulfilled, onRejected) {
    const operation = activeOperation();
    return originalThen.call(this, wrapCallback(onFulfilled, operation), wrapCallback(onRejected, operation));
  };

  for (const name of ["setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "queueMicrotask"]) {
    const original = window[name];
    if (typeof original !== "function") continue;
    window[name] = function (callback) {
      const args = Array.from(arguments);
      args[0] = wrapCallback(callback);
      return original.apply(this, args);
    };
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input, init) {
      const operation = activeOperation();
      const requestId = makeId("req");
      const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url || "";
      const method = init?.method || input?.method || "GET";
      const startedAt = Date.now();
      const body = typeof init?.body === "string" ? safeText(init.body) : "";

      emit({
        kind: "request-start",
        request: {
          id: requestId,
          opid: operation?.id || null,
          transport: "fetch",
          method: String(method).toUpperCase(),
          url: new URL(url, location.href).href,
          requestHeaders: serializeHeaders(init?.headers || input?.headers),
          requestBody: body,
          startedAt
        }
      });

      return originalFetch.call(this, input, init).then((response) => {
        const responseHeaders = serializeHeaders(response.headers);
        response.clone().text().then((responseBody) => {
          emit({
            kind: "request-end",
            requestId,
            result: {
              status: response.status,
              statusText: response.statusText,
              responseHeaders,
              responseBody: safeText(responseBody),
              finishedAt: Date.now()
            }
          });
        }).catch(() => {
          emit({
            kind: "request-end",
            requestId,
            result: {
              status: response.status,
              statusText: response.statusText,
              responseHeaders,
              responseBodyUnavailable: true,
              finishedAt: Date.now()
            }
          });
        });
        return response;
      }, (error) => {
        emit({ kind: "request-end", requestId, result: { error: String(error), finishedAt: Date.now() } });
        throw error;
      });
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__chromeDebuggerTrace = {
      id: makeId("req"),
      method: String(method || "GET").toUpperCase(),
      url: new URL(String(url), location.href).href,
      requestHeaders: {}
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__chromeDebuggerTrace) {
      this.__chromeDebuggerTrace.requestHeaders[String(name).toLowerCase()] = String(value);
    }
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const trace = this.__chromeDebuggerTrace || {
      id: makeId("req"), method: "GET", url: location.href, requestHeaders: {}
    };
    const operation = activeOperation();
    const startedAt = Date.now();
    emit({
      kind: "request-start",
      request: {
        ...trace,
        opid: operation?.id || null,
        transport: "xhr",
        requestBody: typeof body === "string" ? safeText(body) : "",
        startedAt
      }
    });

    this.addEventListener("loadend", () => {
      let responseBody = "";
      let responseBodyUnavailable = false;
      try {
        if (!this.responseType || this.responseType === "text" || this.responseType === "json") {
          responseBody = safeText(this.responseType === "json" ? JSON.stringify(this.response) : this.responseText);
        } else {
          responseBodyUnavailable = true;
        }
      } catch {
        responseBodyUnavailable = true;
      }
      emit({
        kind: "request-end",
        requestId: trace.id,
        result: {
          status: this.status,
          statusText: this.statusText,
          responseHeadersRaw: safeText(this.getAllResponseHeaders()),
          responseBody,
          responseBodyUnavailable,
          finishedAt: Date.now()
        }
      });
    }, { once: true });
    return originalSend.apply(this, arguments);
  };

  window.__chromeDebuggerTracer = Object.freeze({
    setNextOperation(id, label = "") {
      injectedOperation = { id: String(id), label: String(label || "") };
      return injectedOperation.id;
    },
    clearOperation(id) {
      if (injectedOperation?.id === String(id)) injectedOperation = null;
    },
    createOperation(label = "") {
      const id = makeId("op");
      injectedOperation = { id, label: String(label || "") };
      return id;
    }
  });
})();
