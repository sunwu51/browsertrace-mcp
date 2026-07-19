(() => {
  "use strict";

  const CHANNEL = "browsertrace-mcp-trace-v1";
  let port = null;

  function connectPort() {
    if (port) return port;
    try {
      const nextPort = chrome.runtime.connect({ name: "trace-bridge" });
      port = nextPort;
      nextPort.onDisconnect.addListener(() => {
        // Chrome closes extension ports when a page enters BFCache. Reading
        // lastError prevents an expected lifecycle event becoming a warning.
        void chrome.runtime.lastError;
        if (port === nextPort) port = null;
      });
      return nextPort;
    } catch {
      // A content script from an older extension context cannot reconnect after
      // an extension reload. A newly injected bridge will replace it on reload.
      return null;
    }
  }

  function handleMessage(event) {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    const payload = event.data.payload;
    if (!payload || typeof payload !== "object") return;
    const currentPort = connectPort();
    if (!currentPort) return;
    try {
      currentPort.postMessage({ type: "trace-record", payload });
    } catch {
      if (port === currentPort) port = null;
    }
  }

  function handlePageShow(event) {
    if (event.persisted) connectPort();
  }

  connectPort();
  window.addEventListener("message", handleMessage);
  window.addEventListener("pageshow", handlePageShow);
})();
