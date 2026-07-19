/* global chrome */

const DEFAULT_SETTINGS = {
  wsUrl: "ws://localhost:3000/ws/browsertrace",
  enabled: true
};
const LEGACY_DEFAULT_WS_URL = "ws://localhost:3000/ws/chrome-debugger";
const TRACE_PREFIX = "trace:";
const AX_PREFIX = "ax:";
const CONSOLE_PREFIX = "console:";
const NETWORK_PREFIX = "network:";
const MAX_REQUESTS_PER_DOCUMENT = 500;
const MAX_CONSOLE_ENTRIES_PER_TAB = 500;
const MAX_NETWORK_REQUESTS_PER_TAB = 1000;
const DEFAULT_SNAPSHOT_MAX_NODES = 500;
const DEFAULT_TAB_GROUP_NAME = "BrowserTrace MCP";
const DEFAULT_RECORDING_FPS = 15;
const DEFAULT_RECORDING_QUALITY = 90;
const DEFAULT_RECORDING_MAX_WIDTH = 3840;
const DEFAULT_RECORDING_MAX_HEIGHT = 2160;
const DEFAULT_RECORDING_BITRATE = 12000000;
const DEFAULT_RECORDING_FINAL_HOLD_MS = 2000;
const DEFAULT_RECORDING_CHECKPOINT_HOLD_MS = 750;
const DEFAULT_RECORDING_MAX_DURATION_MS = 300000;
const RECORDING_TIMEOUT_ALARM = "browsertrace-recording-timeout";
const DEFAULT_CURSOR_MOVE_MS = 250;
const MAX_BATCH_ACTIONS = 100;
const MAX_ACTION_WAIT_MS = 10000;
const DEBUGGER_VERSION = "1.3";
const reconnectDelays = [1000, 2000, 5000, 10000, 30000];

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let running = false;
let executionQueue = Promise.resolve();
const writeQueues = new Map();
const attachedTabs = new Set();
const managedTabIds = new Set();
let recorderPort = null;
let recorderPortWaiters = [];
const recorderRequests = new Map();
let recording = null;
let recordingFrameForwarding = false;
let recordingFinishing = null;
let lastRecordingResult = null;

const CUA_ACTION_SCHEMA = {
  type: "object",
  description: "One CUA action. Use uid-based fields when a semantic snapshot UID is available; otherwise use viewport CSS pixel coordinates.",
  properties: {
    type: {
      type: "string",
      enum: ["move", "hover", "click", "double_click", "right_click", "mouse_down", "mouse_up", "drag", "scroll", "type", "key_press", "key_down", "key_up", "select_all", "clear", "wait", "screenshot"],
      description: "Action to perform."
    },
    uid: { type: "string", description: "Target element UID from screenshot/page snapshot. Replaces x/y for mouse actions and focuses the element before text/keyboard actions." },
    x: { type: "number", description: "Target viewport CSS pixel X coordinate when uid is not supplied." },
    y: { type: "number", description: "Target viewport CSS pixel Y coordinate when uid is not supplied." },
    fromUid: { type: "string", description: "Drag source UID. For drag only; replaces fromX/fromY." },
    toUid: { type: "string", description: "Drag destination UID. For drag only; replaces toX/toY." },
    fromX: { type: "number", description: "Drag source viewport CSS pixel X coordinate." },
    fromY: { type: "number", description: "Drag source viewport CSS pixel Y coordinate." },
    toX: { type: "number", description: "Drag destination viewport CSS pixel X coordinate." },
    toY: { type: "number", description: "Drag destination viewport CSS pixel Y coordinate." },
    button: { type: "string", enum: ["left", "middle", "right", "back", "forward"], description: "Mouse button for mouse_down/mouse_up. Defaults to left." },
    clickCount: { type: "integer", minimum: 1, description: "Click count for mouse_down/mouse_up. Defaults to 1." },
    durationMs: { type: "integer", minimum: 0, maximum: 10000, description: "Hover hold time, wait duration, or drag duration. Hover defaults to 500ms; wait defaults to 250ms." },
    steps: { type: "integer", minimum: 2, maximum: 50, description: "Number of interpolated pointer moves for drag. Defaults to 10." },
    deltaX: { type: "number", description: "Horizontal wheel delta for scroll. Defaults to 0." },
    deltaY: { type: "number", description: "Vertical wheel delta for scroll. Positive values scroll down. Defaults to 0." },
    text: { type: "string", description: "Text inserted by the type action." },
    key: { type: "string", description: "Key or combination for keyboard actions, for example Enter, Tab, Control+A, or Control+Shift+R." },
    code: { type: "string", description: "Optional CDP physical key code, such as KeyA or ArrowDown." },
    modifiers: { type: "integer", minimum: 0, maximum: 15, description: "Optional CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8." },
    opid: { type: "string", description: "Operation ID to associate with resulting fetch/XHR calls. Generated automatically for input actions when omitted." },
    label: { type: "string", description: "Human-readable label stored with the generated or supplied OPID." },
    delayAfterMs: { type: "integer", minimum: 0, maximum: 10000, description: "Fixed delay after this action before it returns. Prefer an explicit state wait when available." },
    includeImage: { type: "boolean", description: "For screenshot actions, include the PNG image. Defaults to true." },
    saveToFile: { type: "boolean", description: "For screenshot actions, upload the PNG to MCP Center temporary storage and return its absolute filePath. Defaults to true." },
    fullPage: { type: "boolean", description: "For screenshot actions without uid, capture the entire rendered page instead of the viewport." },
    verbose: { type: "boolean", description: "For screenshot actions, include low-signal accessibility nodes." },
    maxNodes: { type: "integer", minimum: 1, maximum: 2000, description: "For screenshot actions, maximum semantic snapshot nodes. Defaults to 500." },
    name: { type: "string", description: "Optional screenshot name used in cua_batch results." }
  },
  required: ["type"]
};

const TOOLS = [
  {
    name: "tab_open",
    description: "Open a URL in a new Chrome tab, attach the debugger immediately, and return its tab ID for subsequent debugging tools.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP or HTTPS URL to open." },
        active: { type: "boolean", description: "Whether to activate the new tab. Defaults to false." },
        groupName: { type: "string", description: "Tab group title. Defaults to BrowserTrace MCP. Groups are scoped to the tab's window." }
      },
      required: ["url"]
    }
  },
  {
    name: "tab_close",
    description: "Close one Chrome tab, or close every tab in all tab groups whose title exactly matches groupName, and remove their temporary debugger data.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Target tab ID. Defaults to the active tab when groupName is omitted." },
        groupName: { type: "string", description: "Exact tab group title to close across all Chrome windows. Closes every tab in every matching group." }
      }
    }
  },
  {
    name: "screenshot",
    description: "Return a compact accessibility snapshot with stable element UIDs, upload a PNG to MCP Center temporary storage by default, and optionally include the PNG as MCP image content. With uid, scroll to and capture only that element and return its semantic subtree.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Target tab ID. Defaults to the active tab." },
        includeImage: { type: "boolean", description: "Include the PNG as MCP image content. Defaults to true. Set false to avoid returning base64; file saving is controlled separately." },
        saveToFile: { type: "boolean", description: "Upload the PNG to MCP Center temporary storage and return its absolute filePath. Defaults to true." },
        name: { type: "string", description: "Screenshot name used to preserve a meaningful .png filename extension during upload." },
        uid: { type: "string", description: "Optional UID from a previous snapshot. Captures that element instead of the viewport." },
        fullPage: { type: "boolean", description: "Capture the entire rendered page instead of the viewport. Ignored when uid is supplied." },
        verbose: { type: "boolean", description: "Include ignored and otherwise low-signal accessibility nodes." },
        maxNodes: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum formatted snapshot nodes. Defaults to 500." }
      }
    }
  },
  {
    name: "cua_action",
    description: "Perform one trusted human-like browser action. tabId is required and must be the ID returned by this MCP server's tab_open tool; do not use a user-existing tab or a tab ID obtained elsewhere. Supports move, hover, click, double_click, right_click, mouse_down, mouse_up, drag, scroll, type, key_press, key_down, key_up, select_all, clear, wait, and screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Required tab ID returned by this MCP server's tab_open tool." },
        action: CUA_ACTION_SCHEMA
      },
      required: ["tabId", "action"]
    }
  },
  {
    name: "cua_batch",
    description: "Perform up to 100 trusted browser actions sequentially in one MCP call. tabId is required and must be the ID returned by this MCP server's tab_open tool; do not use a user-existing tab or a tab ID obtained elsewhere. Use for stable forms and known coordinates; stop the batch before an unknown layout change that requires visual inspection.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Required tab ID returned by this MCP server's tab_open tool." },
        actions: { type: "array", items: CUA_ACTION_SCHEMA, minItems: 1, maxItems: 100, description: "Actions executed sequentially using the same schema as cua_action.action." },
        stopOnError: { type: "boolean", description: "Stop at the first failed action. Defaults to true." },
        defaultDelayMs: { type: "integer", minimum: 0, maximum: 10000 },
        screenshotAfter: { type: "boolean" },
        saveToFile: { type: "boolean", description: "When screenshotAfter is true, upload that final PNG and return filePathAfter. Defaults to true. Unavailable to cross-extension callers." }
      },
      required: ["tabId", "actions"]
    }
  },
  {
    name: "mouse_click",
    description: "Send a trusted left mouse click through Chrome DevTools Protocol. An OPID is installed before the click so resulting fetch/XHR calls can be queried.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        x: { type: "number", description: "Viewport CSS pixel X coordinate." },
        y: { type: "number", description: "Viewport CSS pixel Y coordinate." },
        opid: { type: "string", description: "Optional operation ID. Generated when omitted." },
        label: { type: "string" }
      },
      required: ["x", "y"]
    }
  },
  {
    name: "type_text",
    description: "Insert text into the currently focused control using Chrome DevTools Protocol.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer" }, text: { type: "string" } },
      required: ["text"]
    }
  },
  {
    name: "key_press",
    description: "Send a trusted keyboard press, such as Enter, Tab, Escape, ArrowDown, or Backspace.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        key: { type: "string" },
        code: { type: "string" },
        modifiers: { type: "integer", description: "CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8." }
      },
      required: ["key"]
    }
  },
  {
    name: "scroll",
    description: "Scroll at a viewport coordinate using a trusted mouse wheel event.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" }, x: { type: "number" }, y: { type: "number" },
        deltaX: { type: "number" }, deltaY: { type: "number" }
      }
    }
  },
  {
    name: "evaluate_script",
    description: "Evaluate JavaScript in the target page through CDP and return a JSON-serializable result.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        expression: { type: "string", description: "JavaScript expression or immediately invoked function expression." },
        awaitPromise: { type: "boolean", description: "Await a returned Promise. Defaults to true." }
      },
      required: ["expression"]
    }
  },
  {
    name: "console_list",
    description: "List captured console calls, uncaught exceptions, and browser log entries for a tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        level: { type: "string", description: "Optional exact level/type filter, such as error, warning, log, or exception." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Newest entries to return. Defaults to 100." }
      }
    }
  },
  {
    name: "console_clear",
    description: "Delete captured console output for a tab and clear the page console.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer" } }
    }
  },
  {
    name: "recording_start",
    description: "Start the singleton continuous WebM recorder for an owner. If busy, a different owner is never preempted. The same owner may set replaceExisting=true to save and replace its previous recording. Recording stops and uploads automatically after maxDurationMs (5 minutes by default).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Target tab ID. Defaults to the active tab." },
        ownerId: { type: "string", description: "Required stable identifier for the agent/task that owns this recording. Reuse it across start, stop, and cancel calls." },
        replaceExisting: { type: "boolean", description: "If true and the active recording has the same ownerId, stop and save it before starting this recording. Never replaces another owner's recording. Defaults to false." },
        name: { type: "string", description: "Recording name used as the uploaded WebM filename hint." },
        maxDurationMs: { type: "integer", minimum: 1000, maximum: 300000, description: "Maximum continuous recording duration. Defaults to and cannot exceed 300000ms (5 minutes)." },
        saveToFile: { type: "boolean", description: "Upload the WebM when automatically stopped. Defaults to true." },
        fps: { type: "integer", minimum: 5, maximum: 30, description: "Final Canvas/MediaRecorder frame rate. Defaults to 15." },
        quality: { type: "integer", minimum: 20, maximum: 100, description: "CDP JPEG source-frame quality. Defaults to 90." },
        maxWidth: { type: "integer", minimum: 320, maximum: 3840, description: "Maximum physical-pixel video width after applying devicePixelRatio. Defaults to 3840." },
        maxHeight: { type: "integer", minimum: 240, maximum: 2160, description: "Maximum physical-pixel video height after applying devicePixelRatio. Defaults to 2160." },
        videoBitsPerSecond: { type: "integer", minimum: 250000, maximum: 20000000, description: "WebM target bitrate. Defaults to 12000000." },
        cursorMoveMs: { type: "integer", minimum: 0, maximum: 2000, description: "Fake cursor travel time before pointer actions. Defaults to 250ms." }
      },
      required: ["ownerId"]
    }
  },
  {
    name: "recording_status",
    description: "Return the current continuous recording state, or the most recent automatically completed result.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "recording_stop",
    description: "Finish an owned recording. recordingId and ownerId are required and must both match the active singleton recording.",
    inputSchema: {
      type: "object",
      properties: {
        recordingId: { type: "string", description: "Required recording ID returned by recording_start." },
        ownerId: { type: "string", description: "Required owner ID originally supplied to recording_start." },
        saveToFile: { type: "boolean", description: "Upload the WebM to MCP Center temporary storage and return its absolute filePath. Defaults to true." },
        finalHoldMs: { type: "integer", minimum: 0, maximum: 10000, description: "Capture the tab's current final state and hold it at the end of the video. Defaults to 2000ms; set 0 to disable." }
      },
      required: ["recordingId", "ownerId"]
    }
  },
  {
    name: "recording_cancel",
    description: "Discard an owned recording without uploading. recordingId and ownerId must both match.",
    inputSchema: {
      type: "object",
      properties: {
        recordingId: { type: "string", description: "Required recording ID returned by recording_start." },
        ownerId: { type: "string", description: "Required owner ID originally supplied to recording_start." }
      },
      required: ["recordingId", "ownerId"]
    }
  },
  {
    name: "operation_create",
    description: "Create an OPID that can be supplied to mouse_click and later used to query requests.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" } }
    }
  },
  {
    name: "operation_get_requests",
    description: "Return fetch/XHR requests best-effort correlated to an OPID by the page-world Zone-style async context tracer. Some native, navigation, service-worker, or unusual async chains can lose OPID context, so zero matches do not prove that no request occurred. Use network_list_requests with tab/time/URL filters as the CDP-level fallback. Records disappear when their tab closes or its main document navigates.",
    inputSchema: {
      type: "object",
      properties: {
        opid: { type: "string" },
        tabId: { type: "integer", description: "Optional tab filter." },
        includeBodies: { type: "boolean", description: "Include captured request and response bodies. Defaults to false." }
      },
      required: ["opid"]
    }
  },
  {
    name: "network_list_requests",
    description: "List and filter requests captured independently through CDP Network events. Use this to verify traffic when OPID correlation is empty or incomplete. For API traffic, usually set resourceTypes to [\"XHR\", \"Fetch\"] to exclude Font, Script, Stylesheet, and Image noise. Use resourceType: \"Stylesheet\" when investigating CSS, or \"Document\" for form submissions/navigation. Defaults to all resource types so unusual request chains are not hidden.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Target tab ID. Defaults to the active tab." },
        urlContains: { type: "string", description: "Case-insensitive substring filter for request URL." },
        method: { type: "string", description: "Exact HTTP method filter, for example GET or POST." },
        resourceType: {
          type: "string",
          enum: ["Document", "Stylesheet", "Image", "Media", "Font", "Script", "TextTrack", "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket", "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Preflight", "Other"],
          description: "One exact CDP resource type. Common values: XHR or Fetch for API calls, Stylesheet for CSS, Document for form submission/navigation."
        },
        resourceTypes: {
          type: "array",
          items: {
            type: "string",
            enum: ["Document", "Stylesheet", "Image", "Media", "Font", "Script", "TextTrack", "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket", "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Preflight", "Other"]
          },
          minItems: 1,
          uniqueItems: true,
          description: "Match any listed CDP type. Use [\"XHR\", \"Fetch\"] for normal API request inspection. Cannot be combined with resourceType."
        },
        statusMin: { type: "integer", minimum: 0, maximum: 999 },
        statusMax: { type: "integer", minimum: 0, maximum: 999 },
        since: { type: "number", description: "Only requests started at or after this Unix epoch time in milliseconds." },
        until: { type: "number", description: "Only requests started at or before this Unix epoch time in milliseconds." },
        includeHeaders: { type: "boolean", description: "Include request and response headers. Defaults to false." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum newest matching requests. Defaults to 100." }
      }
    }
  },
  {
    name: "request_get_details",
    description: "Get one recorded fetch/XHR request by its page request ID.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" }, tabId: { type: "integer" } },
      required: ["requestId"]
    }
  }
];

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function traceKey(tabId, documentId) {
  return `${TRACE_PREFIX}${tabId}:${documentId || "unknown"}`;
}

function networkKey(tabId) {
  return `${NETWORK_PREFIX}${tabId}`;
}

function queueStorageWrite(key, task) {
  const previous = writeQueues.get(key) || Promise.resolve();
  const next = previous.then(task, task).finally(() => {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  });
  writeQueues.set(key, next);
  return next;
}

async function saveTraceRecord(sender, payload) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return;
  const key = traceKey(tabId, sender.documentId);
  await queueStorageWrite(key, async () => {
    const stored = await chrome.storage.local.get(key);
    const document = stored[key] || {
      tabId,
      documentId: sender.documentId || "unknown",
      frameId: sender.frameId,
      pageUrl: payload.pageUrl || sender.url || "",
      operations: {},
      requests: {},
      createdAt: Date.now()
    };

    document.pageUrl = payload.pageUrl || document.pageUrl;
    document.updatedAt = Date.now();
    if (payload.kind === "operation" && payload.operation?.id) {
      document.operations[payload.operation.id] = payload.operation;
    } else if (payload.kind === "request-start" && payload.request?.id) {
      document.requests[payload.request.id] = payload.request;
    } else if (payload.kind === "request-end" && payload.requestId) {
      const existing = document.requests[payload.requestId];
      if (existing) {
        document.requests[payload.requestId] = {
          ...existing,
          ...payload.result,
          durationMs: payload.result?.finishedAt
            ? Math.max(0, payload.result.finishedAt - existing.startedAt)
            : undefined
        };
      }
    }

    const requests = Object.values(document.requests);
    if (requests.length > MAX_REQUESTS_PER_DOCUMENT) {
      requests.sort((a, b) => Number(a.startedAt) - Number(b.startedAt));
      for (const request of requests.slice(0, requests.length - MAX_REQUESTS_PER_DOCUMENT)) {
        delete document.requests[request.id];
      }
    }
    await chrome.storage.local.set({ [key]: document });
  });
}

async function removeTraceDataForTab(tabId) {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(`${TRACE_PREFIX}${tabId}:`));
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function removeDebuggerDataForTab(tabId) {
  await removeTraceDataForTab(tabId);
  await chrome.storage.local.remove([`${AX_PREFIX}${tabId}`, `${CONSOLE_PREFIX}${tabId}`, networkKey(tabId)]);
}

async function updateNetworkRequest(tabId, requestId, updater) {
  const key = networkKey(tabId);
  await queueStorageWrite(key, async () => {
    const stored = await chrome.storage.local.get(key);
    const requests = stored[key]?.requests || {};
    const updated = updater(requests[requestId]);
    if (updated) requests[requestId] = updated;
    const entries = Object.values(requests);
    if (entries.length > MAX_NETWORK_REQUESTS_PER_TAB) {
      entries.sort((a, b) => Number(a.startedAt) - Number(b.startedAt));
      for (const request of entries.slice(0, entries.length - MAX_NETWORK_REQUESTS_PER_TAB)) delete requests[request.requestId];
    }
    await chrome.storage.local.set({ [key]: { tabId, requests, updatedAt: Date.now() } });
  });
}

function withoutNetworkHeaders(request) {
  const { requestHeaders, responseHeaders, ...summary } = request;
  return {
    ...summary,
    requestHeadersCaptured: Boolean(requestHeaders),
    responseHeadersCaptured: Boolean(responseHeaders)
  };
}

async function queryNetworkRequests(tabId) {
  const key = networkKey(tabId);
  await writeQueues.get(key)?.catch(() => {});
  const stored = await chrome.storage.local.get(key);
  return Object.values(stored[key]?.requests || {});
}

async function queryTraceDocuments(tabId) {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key, value]) => key.startsWith(TRACE_PREFIX) && (!Number.isInteger(tabId) || value?.tabId === tabId))
    .map(([, value]) => value);
}

function withoutBodies(request) {
  const { requestBody, responseBody, ...summary } = request;
  return {
    ...summary,
    requestBodyCaptured: Boolean(requestBody),
    responseBodyCaptured: Boolean(responseBody)
  };
}

async function resolveTab(tabId) {
  if (Number.isInteger(tabId)) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

async function ensureTabRenderer(tabId, timeoutMs = 30000) {
  let tab = await chrome.tabs.get(tabId);
  if (!tab.discarded) return tab;
  await chrome.tabs.reload(tabId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(100);
    tab = await chrome.tabs.get(tabId);
    if (!tab.discarded && tab.status === "complete") return tab;
  }
  throw new Error(`Timed out restoring discarded tab ${tabId}`);
}

async function addTabToGroup(tab, requestedName) {
  const title = String(requestedName || DEFAULT_TAB_GROUP_NAME).trim() || DEFAULT_TAB_GROUP_NAME;
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  const existing = groups.find((group) => group.title === title);
  const groupId = await chrome.tabs.group({
    tabIds: [tab.id],
    ...(existing ? { groupId: existing.id } : {})
  });
  await chrome.tabGroups.update(groupId, {
    title,
    collapsed: tab.active ? false : true
  });
  return { id: groupId, title };
}

async function closeTabs(tabIds) {
  const ids = [...new Set(tabIds.filter(Number.isInteger))];
  if (!ids.length) return [];
  if (recording && ids.includes(recording.tabId)) {
    if (recording.capturing) {
      await chrome.debugger.sendCommand({ tabId: recording.tabId }, "Page.stopScreencast").catch(() => {});
    }
    await recorderRequest("cancel").catch(() => {});
    await chrome.alarms.clear(RECORDING_TIMEOUT_ALARM);
    recording = null;
  }
  await Promise.all(ids.map(async (tabId) => {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    attachedTabs.delete(tabId);
  }));
  await chrome.tabs.remove(ids);
  await Promise.all(ids.map((tabId) => removeDebuggerDataForTab(tabId)));
  return ids;
}

async function ensureDebugger(tabId) {
  if (attachedTabs.has(tabId)) return false;
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  } catch (error) {
    if (!String(error?.message || error).includes("Another debugger is already attached")) throw error;
    throw new Error("Cannot control this tab because another debugger or DevTools session is attached");
  }
  attachedTabs.add(tabId);
  await Promise.allSettled([
    chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
    chrome.debugger.sendCommand({ tabId }, "Log.enable"),
    chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxTotalBufferSize: 100000000,
      maxResourceBufferSize: 10000000,
      maxPostDataSize: 1000000
    }),
    chrome.debugger.sendCommand({ tabId }, "Page.enable"),
    chrome.debugger.sendCommand({ tabId }, "Accessibility.enable")
  ]);
  return true;
}

async function cdp(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function ensureRecorderDocument() {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: "recorder.html",
      reasons: ["BLOBS"],
      justification: "Encode continuous Chrome debugging recordings as WebM"
    });
  }
  if (recorderPort) return recorderPort;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      recorderPortWaiters = recorderPortWaiters.filter((waiter) => waiter !== onReady);
      reject(new Error("Timed out connecting to the offscreen recorder"));
    }, 5000);
    const onReady = () => {
      clearTimeout(timeout);
      resolve();
    };
    recorderPortWaiters.push(onReady);
  });
  return recorderPort;
}

async function recorderRequest(command, params = {}) {
  const port = await ensureRecorderDocument();
  const id = makeId("recorder_rpc");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      recorderRequests.delete(id);
      reject(new Error(`Recorder command timed out: ${command}`));
    }, command === "stop" ? 30000 : 10000);
    recorderRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });
    try {
      port.postMessage({ id, command, ...params });
    } catch (error) {
      recorderRequests.delete(id);
      clearTimeout(timeout);
      reject(error);
    }
  });
}

function assertRecordingOwner(recordingId, ownerId) {
  if (!recording) throw new Error("No active recording");
  if (!String(recordingId || "").trim()) throw new Error("recordingId is required");
  if (!String(ownerId || "").trim()) throw new Error("ownerId is required");
  if (String(recordingId) !== recording.id) throw new Error(`Recording ID does not match active recording ${recording.id}`);
  if (String(ownerId) !== recording.ownerId) throw new Error("ownerId does not own the active recording");
}

function isRecordableAction(type) {
  return type !== "wait" && type !== "screenshot";
}

async function beginRecordingBurst(tab, type, action) {
  if (!recording || recording.tabId !== tab.id || !isRecordableAction(type)) return false;
  recording.actions.push({
    index: recording.actions.length,
    type,
    uid: action.uid || undefined,
    fromUid: action.fromUid || undefined,
    toUid: action.toUid || undefined,
    opid: action.opid || undefined,
    startedAt: Date.now()
  });
  return true;
}

async function startContinuousRecordingCapture(tabId) {
  await ensureTabRenderer(tabId);
  await cdp(tabId, "Page.startScreencast", {
    format: "jpeg",
    quality: recording.quality,
    maxWidth: recording.width,
    maxHeight: recording.height,
    everyNthFrame: 1
  });
  const initial = await cdp(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: recording.quality,
    fromSurface: true,
    captureBeyondViewport: false
  });
  await recorderRequest("frame", { data: initial.data });
  await recorderRequest("resume");
  recording.capturing = true;
  recording.state = "recording";
  recording.segments = 1;
}

async function pauseRecordingBurst() {
  if (!recording?.capturing) return;
  const tabId = recording.tabId;
  await chrome.debugger.sendCommand({ tabId }, "Page.stopScreencast").catch(() => {});
  await recorderRequest("pause");
  if (recording) {
    recording.capturing = false;
    recording.state = "paused";
  }
}

function scheduleRecordingBurstPause(tabId, type) {
  // Continuous recordings intentionally retain idle time between MCP actions.
  void tabId;
  void type;
}

async function appendRecordingCheckpoint(tabId, image, holdMs = DEFAULT_RECORDING_CHECKPOINT_HOLD_MS, type = "screenshot") {
  if (!recording || recording.tabId !== tabId || !image || holdMs <= 0) return false;
  await recorderRequest("frame", { data: image.data, mimeType: image.mimeType });
  recording.actions.push({
    index: recording.actions.length,
    type,
    startedAt: Date.now()
  });

  if (recording.capturing && type === "final-state") await delay(holdMs);
  return true;
}

function installRecordingOverlay() {
  if (globalThis.__chromeDebuggerRecordingOverlay?.canvas?.isConnected) return;
  const canvas = document.createElement("canvas");
  canvas.dataset.chromeDebuggerRecordingOverlay = "true";
  Object.assign(canvas.style, {
    position: "fixed", inset: "0", width: "100vw", height: "100vh",
    pointerEvents: "none", zIndex: "2147483647"
  });
  (document.documentElement || document.body).appendChild(canvas);
  const context = canvas.getContext("2d");
  const state = { canvas, visible: false, x: 0, y: 0, movement: null, pulses: [], badge: null, stopped: false };
  const resize = () => {
    const dpr = Math.max(1, devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(innerHeight * dpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const draw = (now) => {
    if (state.stopped) return;
    if (canvas.width !== Math.round(innerWidth * Math.max(1, devicePixelRatio || 1)) || canvas.height !== Math.round(innerHeight * Math.max(1, devicePixelRatio || 1))) resize();
    context.clearRect(0, 0, innerWidth, innerHeight);
    if (state.movement) {
      const ratio = Math.min(1, Math.max(0, (now - state.movement.startedAt) / state.movement.durationMs));
      const eased = 1 - Math.pow(1 - ratio, 3);
      state.x = state.movement.fromX + (state.movement.toX - state.movement.fromX) * eased;
      state.y = state.movement.fromY + (state.movement.toY - state.movement.fromY) * eased;
      if (ratio >= 1) state.movement = null;
    }
    if (state.visible) {
      context.save();
      context.translate(state.x, state.y);
      context.beginPath();
      context.moveTo(0, 0); context.lineTo(4, 18); context.lineTo(9, 12);
      context.lineTo(15, 19); context.lineTo(19, 15); context.lineTo(12, 9);
      context.lineTo(18, 5); context.closePath();
      context.fillStyle = "#fff"; context.strokeStyle = "#111"; context.lineWidth = 2;
      context.fill(); context.stroke(); context.restore();
      state.pulses = state.pulses.filter((pulse) => now - pulse.startedAt < 550);
      for (const pulse of state.pulses) {
        const progress = Math.min(1, (now - pulse.startedAt) / 550);
        context.beginPath(); context.arc(state.x, state.y, 8 + progress * 24, 0, Math.PI * 2);
        context.strokeStyle = `rgba(${pulse.right ? "220,60,60" : "30,120,255"},${1 - progress})`;
        context.lineWidth = 3; context.stroke();
      }
    }
    if (state.badge && now - state.badge.startedAt < 900) {
      context.font = "600 18px system-ui, sans-serif";
      const width = context.measureText(state.badge.text).width + 24;
      const x = Math.max(12, innerWidth - width - 18);
      const y = innerHeight - 52;
      context.fillStyle = "rgba(20,20,20,.82)"; context.fillRect(x, y, width, 36);
      context.fillStyle = "#fff"; context.fillText(state.badge.text, x + 12, y + 24);
    } else state.badge = null;
    requestAnimationFrame(draw);
  };
  state.move = (x, y, durationMs) => {
    state.visible = true;
    state.movement = { fromX: state.x, fromY: state.y, toX: Number(x), toY: Number(y), durationMs: Math.max(1, Number(durationMs) || 1), startedAt: performance.now() };
  };
  state.click = (button) => state.pulses.push({ startedAt: performance.now(), right: button === "right" });
  state.key = (text) => { state.badge = { text: String(text || "Key"), startedAt: performance.now() }; };
  state.remove = () => { state.stopped = true; canvas.remove(); delete globalThis.__chromeDebuggerRecordingOverlay; };
  globalThis.__chromeDebuggerRecordingOverlay = state;
  resize();
  requestAnimationFrame(draw);
}

async function ensureRecordingOverlay(tabId) {
  await cdp(tabId, "Runtime.evaluate", { expression: `(${installRecordingOverlay.toString()})()` });
}

async function callRecordingOverlay(tabId, method, args = []) {
  await ensureRecordingOverlay(tabId);
  await cdp(tabId, "Runtime.evaluate", {
    expression: `globalThis.__chromeDebuggerRecordingOverlay?.[${JSON.stringify(method)}](...${JSON.stringify(args)})`
  });
}

async function recordingMoveCursor(tabId, target, durationOverride) {
  if (!target) return;
  const configuredMoveMs = recording?.tabId === tabId ? recording.cursorMoveMs : DEFAULT_CURSOR_MOVE_MS;
  const durationMs = Math.max(0, Number(durationOverride ?? configuredMoveMs) || 0);
  await callRecordingOverlay(tabId, "move", [target.x, target.y, Math.max(1, durationMs)]);
  if (durationMs) await delay(durationMs);
}

async function recordingMarkClick(tabId, button = "left") {
  await callRecordingOverlay(tabId, "click", [button]);
}

async function recordingMarkKey(tabId, text) {
  await callRecordingOverlay(tabId, "key", [String(text)]);
}

function uploadUrlFromWebSocket(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/fs/upload";
  url.search = "";
  url.hash = "";
  return url.href;
}

async function finishActiveRecording({ recordingId, ownerId, saveToFile = true, finalHoldMs = DEFAULT_RECORDING_FINAL_HOLD_MS, stopReason = "manual" } = {}) {
  assertRecordingOwner(recordingId, ownerId);
  if (recordingFinishing) return recordingFinishing;
  recordingFinishing = (async () => {
    const finishedRecording = recording;
    const requestedHoldMs = Math.max(0, Math.min(10000, Math.floor(Number(finalHoldMs) || 0)));
    const holdMs = Math.min(requestedHoldMs, Math.max(0, finishedRecording.deadlineAt - Date.now()));
    try {
      if (holdMs > 0 && finishedRecording.capturing) {
        const tab = await resolveTab(finishedRecording.tabId);
        const finalFrame = await captureTab(tab);
        await appendRecordingCheckpoint(tab.id, finalFrame, holdMs, "final-state");
      }
      if (finishedRecording.capturing) await pauseRecordingBurst();
      const encoded = await recorderRequest("stop", {
        upload: saveToFile ? {
          url: await getUploadUrl(),
          filename: `${finishedRecording.name}.webm`
        } : null
      });
      const result = {
        success: true,
        recordingId: finishedRecording.id,
        ownerId: finishedRecording.ownerId,
        tabId: finishedRecording.tabId,
        saved: saveToFile,
        stopReason,
        filePath: encoded.filePath,
        mimeType: encoded.mimeType,
        size: encoded.size,
        originalSize: encoded.originalSize,
        remuxed: encoded.remuxed,
        mediaDurationMs: encoded.mediaDurationMs,
        durationMs: encoded.durationMs,
        finalHoldMs: holdMs,
        width: finishedRecording.width,
        height: finishedRecording.height,
        deviceScaleFactor: finishedRecording.deviceScaleFactor,
        videoBitsPerSecond: finishedRecording.videoBitsPerSecond,
        segments: finishedRecording.segments,
        actions: finishedRecording.actions
      };
      lastRecordingResult = result;
      await chrome.storage.local.set({ lastRecordingResult: result });
      return result;
    } finally {
      await chrome.alarms.clear(RECORDING_TIMEOUT_ALARM);
      recording = null;
    }
  })();
  try {
    return await recordingFinishing;
  } finally {
    recordingFinishing = null;
  }
}

async function getUploadUrl() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return uploadUrlFromWebSocket(settings.wsUrl);
}

async function uploadBase64File(data, mimeType, filename) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  const response = await fetch(await getUploadUrl(), {
    method: "POST",
    body: form
  });
  if (!response.ok) throw new Error(`MCP Center upload failed: ${response.status} ${await response.text()}`);
  const result = await response.json();
  if (!result?.path) throw new Error("MCP Center upload response did not include path");
  return String(result.path);
}

async function saveScreenshot(image, options = {}) {
  const stem = String(options.name || `tab-${options.tabId || "unknown"}`)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 80) || "screenshot";
  const filePath = await uploadBase64File(image.data, image.mimeType, `${stem}.png`);
  return { filePath, mimeType: image.mimeType };
}

async function waitForDebuggerLayout(tabId) {
  await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    awaitPromise: true,
    returnByValue: true
  });
}

function axValue(value) {
  if (value == null) return undefined;
  return typeof value === "object" && "value" in value ? value.value : value;
}

function compactAxProperties(properties = []) {
  const included = new Set(["checked", "disabled", "expanded", "focused", "level", "multiselectable", "orientation", "pressed", "readonly", "required", "selected"]);
  const result = {};
  for (const property of properties) {
    if (included.has(property.name)) result[property.name] = axValue(property.value);
  }
  return result;
}

function quoteSnapshotText(value) {
  return JSON.stringify(String(value).replace(/\s+/g, " ").trim());
}

function snapshotLimit(value) {
  return Math.max(1, Math.min(2000, Math.floor(Number(value) || DEFAULT_SNAPSHOT_MAX_NODES)));
}

async function createAccessibilitySnapshot(tabId, options = {}) {
  await ensureTabRenderer(tabId);
  const debuggerAttached = await ensureDebugger(tabId);
  if (debuggerAttached) await waitForDebuggerLayout(tabId);
  const [{ frameTree }, tree] = await Promise.all([
    chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree"),
    chrome.debugger.sendCommand({ tabId }, "Accessibility.getFullAXTree")
  ]);
  const loaderId = String(frameTree?.frame?.loaderId || "unknown");
  const key = `${AX_PREFIX}${tabId}`;
  const stored = (await chrome.storage.local.get(key))[key];
  const cache = stored?.loaderId === loaderId ? stored : {
    loaderId,
    generation: Date.now().toString(36),
    nextId: 1,
    uidByBackend: {}
  };
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const liveBackends = new Set();
  const uidToBackend = {};

  for (const node of nodes) {
    const backendNodeId = Number(node.backendDOMNodeId);
    if (!Number.isInteger(backendNodeId)) continue;
    const backendKey = String(backendNodeId);
    liveBackends.add(backendKey);
    if (!cache.uidByBackend[backendKey]) cache.uidByBackend[backendKey] = `${cache.generation}_${cache.nextId++}`;
    uidToBackend[cache.uidByBackend[backendKey]] = backendNodeId;
  }
  for (const backendKey of Object.keys(cache.uidByBackend)) {
    if (!liveBackends.has(backendKey)) delete cache.uidByBackend[backendKey];
  }
  cache.uidToBackend = uidToBackend;
  cache.updatedAt = Date.now();
  await chrome.storage.local.set({ [key]: cache });

  const root = nodes[0];
  let target = root;
  if (options.uid) {
    const backendNodeId = uidToBackend[String(options.uid)];
    if (!backendNodeId) throw new Error(`Element uid ${options.uid} no longer exists. Capture a new snapshot.`);
    target = nodes.find((node) => Number(node.backendDOMNodeId) === backendNodeId);
    if (!target) throw new Error(`Element uid ${options.uid} is not present in the current accessibility tree.`);
  }

  const lines = [];
  let included = 0;
  let truncated = false;
  const maxNodes = snapshotLimit(options.maxNodes);
  const visit = (node, depth) => {
    if (!node || included >= maxNodes) {
      truncated = true;
      return;
    }
    const role = String(axValue(node.role) || "generic");
    const name = axValue(node.name);
    const value = axValue(node.value);
    const backendNodeId = Number(node.backendDOMNodeId);
    const uid = Number.isInteger(backendNodeId) ? cache.uidByBackend[String(backendNodeId)] : undefined;
    const properties = compactAxProperties(node.properties);
    const lowSignal = node.ignored || (role === "generic" && !name && value == null && !uid);
    const emit = options.verbose || !lowSignal;
    const childDepth = emit ? depth + 1 : depth;
    if (emit) {
      const details = [role];
      if (name) details.push(quoteSnapshotText(name));
      if (value != null && String(value) !== String(name || "")) details.push(`value=${quoteSnapshotText(value)}`);
      if (uid) details.push(`uid=${uid}`);
      for (const [property, propertyValue] of Object.entries(properties)) details.push(`${property}=${JSON.stringify(propertyValue)}`);
      lines.push(`${"  ".repeat(Math.min(depth, 30))}${details.join(" ")}`);
      included++;
    }
    for (const childId of node.childIds || []) visit(nodeById.get(childId), childDepth);
  };
  visit(target, 0);
  if (truncated) lines.push(`...[truncated after ${maxNodes} nodes]`);

  return {
    text: lines.join("\n"),
    loaderId,
    nodeCount: included,
    truncated,
    uid: options.uid ? String(options.uid) : undefined,
    cache
  };
}

async function resolveUid(tabId, uid, options = {}) {
  const snapshot = await createAccessibilitySnapshot(tabId, { ...options, uid });
  const backendNodeId = snapshot.cache.uidToBackend[String(uid)];
  if (!backendNodeId) throw new Error(`Element uid ${uid} no longer exists. Capture a new snapshot.`);
  return { backendNodeId, snapshot };
}

function quadBounds(quad) {
  if (!Array.isArray(quad) || quad.length < 8) throw new Error("The element has no visible box");
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

async function getUidBounds(tabId, uid, options = {}) {
  const { backendNodeId, snapshot } = await resolveUid(tabId, uid, options);
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  await delay(50);
  const model = await cdp(tabId, "DOM.getBoxModel", { backendNodeId });
  const bounds = quadBounds(model?.model?.border || model?.model?.content);
  if (!(bounds.width > 0 && bounds.height > 0)) throw new Error(`Element uid ${uid} has an empty box`);
  return { backendNodeId, bounds, snapshot };
}

async function pointForAction(tabId, action, prefix = "") {
  const uidKey = prefix ? `${prefix}Uid` : "uid";
  const xKey = prefix ? `${prefix}X` : "x";
  const yKey = prefix ? `${prefix}Y` : "y";
  if (action[uidKey]) {
    const resolved = await getUidBounds(tabId, String(action[uidKey]));
    return {
      x: resolved.bounds.x + resolved.bounds.width / 2,
      y: resolved.bounds.y + resolved.bounds.height / 2,
      uid: String(action[uidKey]),
      bounds: resolved.bounds
    };
  }
  return { x: coordinate(action[xKey], xKey), y: coordinate(action[yKey], yKey) };
}

async function installOperation(tabId, opid, label) {
  const expression = `window.__chromeDebuggerTracer?.setNextOperation(${JSON.stringify(opid)}, ${JSON.stringify(label || "")})`;
  const result = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails || result.result?.value !== opid) {
    throw new Error("OPID tracer is unavailable on this page. Reload the tab after installing/enabling the extension.");
  }
}

async function clearOperation(tabId, opid) {
  const expression = `window.__chromeDebuggerTracer?.clearOperation(${JSON.stringify(opid)})`;
  await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression }).catch(() => {});
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coordinate(value, name, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number`);
  return number;
}

function waitDuration(value, fallback = 0) {
  return Math.max(0, Math.min(MAX_ACTION_WAIT_MS, Math.floor(Number(value) || fallback)));
}

function parseKeyAction(action) {
  const tokens = String(action.key || "").split("+").map((item) => item.trim()).filter(Boolean);
  if (!tokens.length) throw new Error("key is required");
  let modifiers = Number(action.modifiers) || 0;
  const modifierNames = new Set(["alt", "control", "ctrl", "meta", "command", "cmd", "shift"]);
  for (const token of tokens.slice(0, -1)) {
    const lower = token.toLowerCase();
    if (!modifierNames.has(lower)) throw new Error(`Unknown key modifier: ${token}`);
    if (lower === "alt") modifiers |= 1;
    if (lower === "control" || lower === "ctrl") modifiers |= 2;
    if (lower === "meta" || lower === "command" || lower === "cmd") modifiers |= 4;
    if (lower === "shift") modifiers |= 8;
  }
  const key = tokens.at(-1);
  const code = String(action.code || (key.length === 1 ? `Key${key.toUpperCase()}` : key));
  return { key, code, modifiers };
}

async function dispatchKey(tabId, action, type) {
  const key = parseKeyAction(action);
  await cdp(tabId, "Input.dispatchKeyEvent", { type, ...key });
  return key;
}

async function captureTab(tab, options = {}) {
  tab = await ensureTabRenderer(tab.id);
  const debuggerAttached = await ensureDebugger(tab.id);
  if (debuggerAttached) await waitForDebuggerLayout(tab.id);
  const params = {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: options.fullPage === true
  };
  if (options.fullPage) {
    const metrics = await cdp(tab.id, "Page.getLayoutMetrics");
    const size = metrics?.cssContentSize || metrics?.contentSize;
    if (!(size?.width > 0 && size?.height > 0)) throw new Error("Page has no capturable content size");
    params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
  }
  const result = await cdp(tab.id, "Page.captureScreenshot", params);
  return { mimeType: "image/png", data: result.data };
}

async function captureUid(tab, uid, snapshotOptions = {}) {
  tab = await ensureTabRenderer(tab.id);
  const debuggerAttached = await ensureDebugger(tab.id);
  if (debuggerAttached) await waitForDebuggerLayout(tab.id);
  const resolved = await getUidBounds(tab.id, uid, snapshotOptions);
  const metrics = await cdp(tab.id, "Page.getLayoutMetrics");
  const pageX = Number(metrics?.cssLayoutViewport?.pageX ?? metrics?.layoutViewport?.pageX) || 0;
  const pageY = Number(metrics?.cssLayoutViewport?.pageY ?? metrics?.layoutViewport?.pageY) || 0;
  const result = await cdp(tab.id, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: resolved.bounds.x + pageX,
      y: resolved.bounds.y + pageY,
      width: resolved.bounds.width,
      height: resolved.bounds.height,
      scale: 1
    }
  });
  return {
    image: { mimeType: "image/png", data: result.data },
    bounds: resolved.bounds,
    snapshot: resolved.snapshot
  };
}

const ACTIONS_WITH_OPERATION = new Set([
  "move", "hover", "click", "double_click", "right_click", "mouse_down", "mouse_up", "drag", "scroll",
  "type", "key_press", "key_down", "key_up", "select_all", "clear"
]);

async function executeCuaAction(tab, rawAction = {}) {
  const action = rawAction && typeof rawAction === "object" ? rawAction : {};
  const type = String(action.type || "");
  if (!type) throw new Error("action.type is required");
  const startedAt = Date.now();
  const opid = ACTIONS_WITH_OPERATION.has(type) ? String(action.opid || makeId("op")) : undefined;
  if (opid) await installOperation(tab.id, opid, action.label || type);
  let recordingBurstStarted = false;

  let image;
  let filePath;
  let snapshot;
  let target;
  try {
    recordingBurstStarted = await beginRecordingBurst(tab, type, { ...action, opid });
    if (type === "wait") {
      await delay(waitDuration(action.durationMs, 250));
    } else if (type === "screenshot") {
      const includeImage = action.includeImage !== false;
      const saveToFile = action.saveToFile !== false;
      if (action.uid) {
        if (!includeImage && !saveToFile) {
          const semantic = await createAccessibilitySnapshot(tab.id, action);
          snapshot = semantic.text;
          target = { uid: String(action.uid) };
        } else {
          const captured = await captureUid(tab, String(action.uid), action);
          await appendRecordingCheckpoint(tab.id, captured.image);
          if (includeImage) image = captured.image;
          if (saveToFile) filePath = (await saveScreenshot(captured.image, {
            tabId: tab.id, name: action.name
          })).filePath;
          snapshot = captured.snapshot.text;
          target = { uid: String(action.uid), bounds: captured.bounds };
        }
      } else {
        snapshot = (await createAccessibilitySnapshot(tab.id, action)).text;
        if (includeImage || saveToFile) {
          const captured = await captureTab(tab, action);
          await appendRecordingCheckpoint(tab.id, captured);
          if (includeImage) image = captured;
          if (saveToFile) filePath = (await saveScreenshot(captured, {
            tabId: tab.id, name: action.name
          })).filePath;
        }
      }
    } else if (type === "move" || type === "hover") {
      target = await pointForAction(tab.id, action);
      const { x, y } = target;
      await recordingMoveCursor(tab.id, target);
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      if (type === "hover") await delay(waitDuration(action.durationMs, 500));
    } else if (["click", "double_click", "right_click"].includes(type)) {
      target = await pointForAction(tab.id, action);
      const { x, y } = target;
      await recordingMoveCursor(tab.id, target);
      const button = type === "right_click" ? "right" : "left";
      const clickCount = type === "double_click" ? 2 : 1;
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await recordingMarkClick(tab.id, button);
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
      if (type === "double_click") {
        await delay(120);
        await recordingMarkClick(tab.id, button);
      }
    } else if (type === "mouse_down" || type === "mouse_up") {
      target = await pointForAction(tab.id, action);
      await recordingMoveCursor(tab.id, target);
      if (type === "mouse_down") await recordingMarkClick(tab.id, String(action.button || "left"));
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: type === "mouse_down" ? "mousePressed" : "mouseReleased",
        x: target.x, y: target.y,
        button: String(action.button || "left"), clickCount: Number(action.clickCount) || 1
      });
    } else if (type === "drag") {
      const from = await pointForAction(tab.id, action, "from");
      const to = await pointForAction(tab.id, action, "to");
      const { x: fromX, y: fromY } = from;
      const { x: toX, y: toY } = to;
      target = { from, to };
      const steps = Math.max(2, Math.min(50, Math.floor(Number(action.steps) || 10)));
      const dragDurationMs = waitDuration(action.durationMs, 500);
      await recordingMoveCursor(tab.id, from);
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY });
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y: fromY, button: "left", clickCount: 1 });
      for (let index = 1; index <= steps; index++) {
        const ratio = index / steps;
        await cdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: fromX + (toX - fromX) * ratio, y: fromY + (toY - fromY) * ratio,
          button: "left", buttons: 1
        });
        await recordingMoveCursor(tab.id, { x: fromX + (toX - fromX) * ratio, y: fromY + (toY - fromY) * ratio }, 0);
        if (dragDurationMs) await delay(dragDurationMs / steps);
      }
      await recordingMarkClick(tab.id);
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left", clickCount: 1 });
    } else if (type === "scroll") {
      target = action.uid ? await pointForAction(tab.id, action) : {
        x: coordinate(action.x, "x", 0), y: coordinate(action.y, "y", 0)
      };
      await recordingMoveCursor(tab.id, target);
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: target.x, y: target.y,
        deltaX: coordinate(action.deltaX, "deltaX", 0), deltaY: coordinate(action.deltaY, "deltaY", 0)
      });
    } else if (type === "type") {
      if (action.uid) {
        target = await pointForAction(tab.id, action);
        await recordingMoveCursor(tab.id, target);
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
      }
      await cdp(tab.id, "Input.insertText", { text: String(action.text ?? "") });
      await recordingMarkKey(tab.id, String(action.text ?? "").slice(0, 24) || "Text input");
    } else if (type === "key_press") {
      if (action.uid) {
        target = await pointForAction(tab.id, action);
        await recordingMoveCursor(tab.id, target);
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
      }
      await dispatchKey(tab.id, action, "keyDown");
      await dispatchKey(tab.id, action, "keyUp");
      await recordingMarkKey(tab.id, action.key);
    } else if (type === "key_down" || type === "key_up") {
      if (action.uid) {
        target = await pointForAction(tab.id, action);
        await recordingMoveCursor(tab.id, target);
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
      }
      await dispatchKey(tab.id, action, type === "key_down" ? "keyDown" : "keyUp");
      await recordingMarkKey(tab.id, action.key);
    } else if (type === "select_all") {
      if (action.uid) {
        target = await pointForAction(tab.id, action);
        await recordingMoveCursor(tab.id, target);
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
      }
      await dispatchKey(tab.id, { key: "Control+A" }, "keyDown");
      await dispatchKey(tab.id, { key: "Control+A" }, "keyUp");
      await recordingMarkKey(tab.id, "Control+A");
    } else if (type === "clear") {
      if (action.uid) {
        target = await pointForAction(tab.id, action);
        await recordingMoveCursor(tab.id, target);
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
      }
      await dispatchKey(tab.id, { key: "Control+A" }, "keyDown");
      await dispatchKey(tab.id, { key: "Control+A" }, "keyUp");
      await dispatchKey(tab.id, { key: "Backspace" }, "keyDown");
      await dispatchKey(tab.id, { key: "Backspace" }, "keyUp");
      await recordingMarkKey(tab.id, "Clear");
    } else {
      throw new Error(`Unsupported CUA action: ${type}`);
    }
    const delayAfterMs = waitDuration(action.delayAfterMs);
    if (delayAfterMs) await delay(delayAfterMs);
    const finishedAt = Date.now();
    return { type, success: true, opid, startedAt, finishedAt, durationMs: finishedAt - startedAt, image, filePath, snapshot, target };
  } finally {
    if (opid) await clearOperation(tab.id, opid);
    if (recordingBurstStarted) scheduleRecordingBurstPause(tab.id, type);
  }
}

function remoteObjectValue(object) {
  if (Object.prototype.hasOwnProperty.call(object || {}, "value")) return object.value;
  if (object?.unserializableValue) return object.unserializableValue;
  return object?.description ?? object?.preview?.description ?? object?.type ?? null;
}

function callFrame(frame) {
  if (!frame) return undefined;
  return { functionName: frame.functionName, url: frame.url, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber };
}

async function appendConsoleEntry(tabId, entry) {
  const key = `${CONSOLE_PREFIX}${tabId}`;
  await queueStorageWrite(key, async () => {
    const stored = await chrome.storage.local.get(key);
    const entries = Array.isArray(stored[key]) ? stored[key] : [];
    entries.push({ id: makeId("console"), ...entry });
    if (entries.length > MAX_CONSOLE_ENTRIES_PER_TAB) entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES_PER_TAB);
    await chrome.storage.local.set({ [key]: entries });
  });
}

function consoleEntryFromEvent(method, params) {
  if (method === "Runtime.consoleAPICalled") {
    return {
      source: "console",
      level: String(params.type || "log"),
      timestamp: Number(params.timestamp) || Date.now(),
      args: (params.args || []).map(remoteObjectValue),
      stack: params.stackTrace?.callFrames?.map(callFrame) || [],
      executionContextId: params.executionContextId
    };
  }
  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails || {};
    return {
      source: "runtime",
      level: "exception",
      timestamp: Number(params.timestamp) || Date.now(),
      text: details.exception?.description || details.text || "Uncaught exception",
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
      stack: details.stackTrace?.callFrames?.map(callFrame) || []
    };
  }
  if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    return {
      source: String(entry.source || "log"),
      level: String(entry.level || "info"),
      timestamp: Number(entry.timestamp) || Date.now(),
      text: entry.text,
      url: entry.url,
      lineNumber: entry.lineNumber,
      stack: entry.stackTrace?.callFrames?.map(callFrame) || []
    };
  }
  return null;
}

async function executeTool(name, args = {}, context = {}) {
  const allowFileSave = context.allowFileSave !== false;
  switch (name) {
    case "tab_open": {
      let url;
      try {
        url = new URL(String(args.url || ""));
      } catch {
        throw new Error("url must be a valid HTTP or HTTPS URL");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("url must use http:// or https://");
      }
      const tab = await chrome.tabs.create({ url: url.href, active: args.active === true });
      managedTabIds.add(tab.id);
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
      const group = await addTabToGroup(tab, args.groupName);
      await ensureDebugger(tab.id);
      await ensureRecordingOverlay(tab.id).catch(() => {});
      return {
        success: true,
        tabId: tab.id,
        windowId: tab.windowId,
        active: tab.active,
        autoDiscardable: false,
        group,
        url: tab.url || tab.pendingUrl || url.href
      };
    }
    case "tab_close": {
      if (args.groupName != null) {
        if (Number.isInteger(args.tabId)) throw new Error("Provide either tabId or groupName, not both");
        const groupName = String(args.groupName).trim();
        if (!groupName) throw new Error("groupName cannot be empty");
        const groups = (await chrome.tabGroups.query({})).filter((group) => group.title === groupName);
        const groupedTabs = await Promise.all(groups.map((group) => chrome.tabs.query({ groupId: group.id })));
        const closedTabIds = await closeTabs(groupedTabs.flat().map((tab) => tab.id));
        return {
          success: true,
          groupName,
          matchedGroups: groups.length,
          closed: closedTabIds.length,
          closedTabIds
        };
      }
      const tab = await resolveTab(args.tabId);
      await closeTabs([tab.id]);
      return { success: true, tabId: tab.id };
    }
    case "screenshot": {
      const tab = await resolveTab(args.tabId);
      const includeImage = args.includeImage !== false;
      const saveToFile = allowFileSave && args.saveToFile !== false;
      if (args.uid) {
        if (includeImage || saveToFile) {
          const captured = await captureUid(tab, String(args.uid), args);
          await appendRecordingCheckpoint(tab.id, captured.image);
          const filePath = saveToFile ? (await saveScreenshot(captured.image, {
            tabId: tab.id, name: args.name
          })).filePath : undefined;
          return {
            image: includeImage ? captured.image : undefined,
            filePath,
            tabId: tab.id,
            uid: String(args.uid),
            bounds: captured.bounds,
            snapshot: {
              text: captured.snapshot.text,
              nodeCount: captured.snapshot.nodeCount,
              truncated: captured.snapshot.truncated
            }
          };
        }
        const snapshot = await createAccessibilitySnapshot(tab.id, args);
        return {
          tabId: tab.id,
          uid: String(args.uid),
          snapshot: { text: snapshot.text, nodeCount: snapshot.nodeCount, truncated: snapshot.truncated }
        };
      }
      const snapshot = await createAccessibilitySnapshot(tab.id, args);
      const captured = includeImage || saveToFile ? await captureTab(tab, args) : undefined;
      if (captured) await appendRecordingCheckpoint(tab.id, captured);
      return {
        image: includeImage ? captured : undefined,
        filePath: saveToFile ? (await saveScreenshot(captured, {
          tabId: tab.id, name: args.name
        })).filePath : undefined,
        tabId: tab.id,
        snapshot: { text: snapshot.text, nodeCount: snapshot.nodeCount, truncated: snapshot.truncated }
      };
    }
    case "cua_action": {
      if (!Number.isInteger(args.tabId)) throw new Error("cua_action requires the tabId returned by tab_open");
      const tab = await resolveTab(args.tabId);
      const action = allowFileSave ? args.action : { ...args.action, saveToFile: false };
      const result = await executeCuaAction(tab, action);
      const { image, snapshot, ...step } = result;
      return {
        success: true,
        tabId: tab.id,
        step,
        snapshot: snapshot ? { text: snapshot } : undefined,
        images: image ? [{ name: String(action?.name || "screenshot"), ...image }] : []
      };
    }
    case "cua_batch": {
      if (!Number.isInteger(args.tabId)) throw new Error("cua_batch requires the tabId returned by tab_open");
      const tab = await resolveTab(args.tabId);
      const actions = Array.isArray(args.actions)
        ? args.actions.slice(0, MAX_BATCH_ACTIONS).map((action) => allowFileSave ? action : { ...action, saveToFile: false })
        : [];
      if (!actions.length) throw new Error("actions must be a non-empty array");
      if (args.actions.length > MAX_BATCH_ACTIONS) throw new Error(`actions cannot exceed ${MAX_BATCH_ACTIONS} items`);
      await ensureDebugger(tab.id);
      const startedAt = Date.now();
      const steps = [];
      const images = [];
      const stopOnError = args.stopOnError !== false;
      const defaultDelayMs = waitDuration(args.defaultDelayMs);

      for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        try {
          const step = await executeCuaAction(tab, action);
          if (step.image) images.push({ name: String(action.name || `step-${index}`), ...step.image });
          const { image: _image, ...summary } = step;
          steps.push({ index, ...summary });
        } catch (error) {
          steps.push({ index, type: String(action?.type || ""), success: false, error: error?.message || String(error) });
          if (stopOnError) break;
        }
        if (defaultDelayMs && index < actions.length - 1) await delay(defaultDelayMs);
      }

      let filePathAfter;
      if (args.screenshotAfter) {
        const captured = await captureTab(tab);
        await appendRecordingCheckpoint(tab.id, captured);
        images.push({ name: "after", ...captured });
        if (allowFileSave && args.saveToFile !== false) {
          filePathAfter = (await saveScreenshot(captured, { tabId: tab.id, name: "after" })).filePath;
        }
      }
      return {
        success: steps.length === actions.length && steps.every((step) => step.success),
        tabId: tab.id,
        requested: actions.length,
        completed: steps.filter((step) => step.success).length,
        steps,
        durationMs: Date.now() - startedAt,
        images,
        filePathAfter
      };
    }
    case "mouse_click": {
      const tab = await resolveTab(args.tabId);
      const step = await executeCuaAction(tab, { type: "click", ...args });
      return { success: true, tabId: tab.id, opid: step.opid, x: Number(args.x), y: Number(args.y) };
    }
    case "type_text": {
      const tab = await resolveTab(args.tabId);
      const step = await executeCuaAction(tab, { type: "type", ...args });
      return { success: true, tabId: tab.id, opid: step.opid, length: String(args.text).length };
    }
    case "key_press": {
      const tab = await resolveTab(args.tabId);
      const step = await executeCuaAction(tab, { type: "key_press", ...args });
      return { success: true, tabId: tab.id, opid: step.opid, key: String(args.key) };
    }
    case "scroll": {
      const tab = await resolveTab(args.tabId);
      const step = await executeCuaAction(tab, { type: "scroll", ...args });
      return { success: true, tabId: tab.id, opid: step.opid };
    }
    case "evaluate_script": {
      const tab = await resolveTab(args.tabId);
      const evaluated = await cdp(tab.id, "Runtime.evaluate", {
        expression: String(args.expression || ""),
        awaitPromise: args.awaitPromise !== false,
        returnByValue: true,
        userGesture: true
      });
      if (evaluated.exceptionDetails) {
        const details = evaluated.exceptionDetails;
        throw new Error(details.exception?.description || details.text || "Script evaluation failed");
      }
      return {
        success: true,
        tabId: tab.id,
        type: evaluated.result?.type,
        value: remoteObjectValue(evaluated.result)
      };
    }
    case "console_list": {
      const tab = await resolveTab(args.tabId);
      await ensureDebugger(tab.id);
      const key = `${CONSOLE_PREFIX}${tab.id}`;
      const stored = (await chrome.storage.local.get(key))[key];
      const level = args.level == null ? "" : String(args.level).toLowerCase();
      const limit = Math.max(1, Math.min(500, Math.floor(Number(args.limit) || 100)));
      const entries = (Array.isArray(stored) ? stored : [])
        .filter((entry) => !level || String(entry.level).toLowerCase() === level)
        .slice(-limit);
      return { tabId: tab.id, count: entries.length, entries };
    }
    case "console_clear": {
      const tab = await resolveTab(args.tabId);
      await ensureDebugger(tab.id);
      await chrome.storage.local.remove(`${CONSOLE_PREFIX}${tab.id}`);
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.discardConsoleEntries").catch(() => {});
      return { success: true, tabId: tab.id };
    }
    case "recording_start": {
      const ownerId = String(args.ownerId || "").trim();
      if (!ownerId) throw new Error("ownerId is required");
      let replacedRecording;
      if (recording) {
        const busy = {
          recordingId: recording.id,
          ownerId: recording.ownerId,
          tabId: recording.tabId,
          startedAt: recording.startedAt,
          deadlineAt: recording.deadlineAt,
          remainingMs: Math.max(0, recording.deadlineAt - Date.now())
        };
        if (recording.ownerId !== ownerId || args.replaceExisting !== true) {
          return {
            success: false,
            started: false,
            reason: "recording-busy",
            sameOwner: recording.ownerId === ownerId,
            canReplace: recording.ownerId === ownerId,
            recording: busy
          };
        }
        const previous = await finishActiveRecording({
          recordingId: recording.id,
          ownerId,
          saveToFile: allowFileSave && recording.autoSaveToFile,
          finalHoldMs: 0,
          stopReason: "replaced-by-owner"
        });
        replacedRecording = {
          recordingId: previous.recordingId,
          filePath: previous.filePath,
          saved: previous.saved,
          durationMs: previous.durationMs
        };
      }
      const tab = await resolveTab(args.tabId);
      await ensureTabRenderer(tab.id);
      await ensureDebugger(tab.id);
      const metrics = await cdp(tab.id, "Page.getLayoutMetrics");
      const viewport = metrics?.cssVisualViewport || metrics?.visualViewport || {};
      const viewportWidth = Math.max(1, Number(viewport.clientWidth) || Number(tab.width) || 1280);
      const viewportHeight = Math.max(1, Number(viewport.clientHeight) || Number(tab.height) || 720);
      const dprResult = await cdp(tab.id, "Runtime.evaluate", {
        expression: "window.devicePixelRatio || 1",
        returnByValue: true
      });
      const deviceScaleFactor = Math.max(0.5, Math.min(4, Number(dprResult?.result?.value) || 1));
      const physicalWidth = viewportWidth * deviceScaleFactor;
      const physicalHeight = viewportHeight * deviceScaleFactor;
      const maxWidth = Math.max(320, Math.min(3840, Math.floor(Number(args.maxWidth) || DEFAULT_RECORDING_MAX_WIDTH)));
      const maxHeight = Math.max(240, Math.min(2160, Math.floor(Number(args.maxHeight) || DEFAULT_RECORDING_MAX_HEIGHT)));
      const scale = Math.min(1, maxWidth / physicalWidth, maxHeight / physicalHeight);
      const width = Math.max(2, Math.round(physicalWidth * scale / 2) * 2);
      const height = Math.max(2, Math.round(physicalHeight * scale / 2) * 2);
      const fps = Math.max(5, Math.min(30, Math.floor(Number(args.fps) || DEFAULT_RECORDING_FPS)));
      const name = String(args.name || `tab-${tab.id}`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 80) || `tab-${tab.id}`;
      const settings = {
        width,
        height,
        viewportWidth,
        viewportHeight,
        deviceScaleFactor,
        fps,
        videoBitsPerSecond: Math.max(250000, Math.min(20000000, Math.floor(Number(args.videoBitsPerSecond) || DEFAULT_RECORDING_BITRATE))),
        showCursor: false
      };
      const encoder = await recorderRequest("start", { options: settings });
      const maxDurationMs = Math.max(1000, Math.min(DEFAULT_RECORDING_MAX_DURATION_MS, Math.floor(
        args.maxDurationMs == null ? DEFAULT_RECORDING_MAX_DURATION_MS : Number(args.maxDurationMs) || 0
      )));
      recording = {
        id: makeId("recording"),
        ownerId,
        tabId: tab.id,
        name,
        state: "starting",
        capturing: false,
        maxDurationMs,
        deadlineAt: Date.now() + maxDurationMs,
        autoSaveToFile: allowFileSave && args.saveToFile !== false,
        cursorMoveMs: Math.max(0, Math.min(2000, Math.floor(args.cursorMoveMs == null ? DEFAULT_CURSOR_MOVE_MS : Number(args.cursorMoveMs) || 0))),
        quality: Math.max(20, Math.min(100, Math.floor(Number(args.quality) || DEFAULT_RECORDING_QUALITY))),
        width,
        height,
        deviceScaleFactor,
        videoBitsPerSecond: settings.videoBitsPerSecond,
        fps,
        startedAt: Date.now(),
        segments: 0,
        actions: [],
        mimeType: encoder.mimeType
      };
      lastRecordingResult = null;
      await chrome.storage.local.remove("lastRecordingResult");
      try {
        await ensureRecordingOverlay(tab.id);
        await startContinuousRecordingCapture(tab.id);
        await chrome.alarms.create(RECORDING_TIMEOUT_ALARM, { when: recording.deadlineAt });
      } catch (error) {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.stopScreencast").catch(() => {});
        await recorderRequest("cancel").catch(() => {});
        recording = null;
        throw error;
      }
      return { success: true, started: true, ...recording, actions: [], replacedRecording };
    }
    case "recording_status": {
      if (!recording) {
        if (!lastRecordingResult) {
          const stored = await chrome.storage.local.get("lastRecordingResult");
          lastRecordingResult = stored.lastRecordingResult || null;
        }
        return { active: false, lastResult: lastRecordingResult || undefined };
      }
      return {
        active: true,
        recordingId: recording.id,
        ownerId: recording.ownerId,
        tabId: recording.tabId,
        name: recording.name,
        state: recording.state,
        capturing: recording.capturing,
        width: recording.width,
        height: recording.height,
        deviceScaleFactor: recording.deviceScaleFactor,
        videoBitsPerSecond: recording.videoBitsPerSecond,
        segments: recording.segments,
        actionCount: recording.actions.length,
        startedAt: recording.startedAt,
        maxDurationMs: recording.maxDurationMs,
        deadlineAt: recording.deadlineAt,
        remainingMs: Math.max(0, recording.deadlineAt - Date.now()),
        error: recording.error
      };
    }
    case "recording_stop": {
      const finalHoldMs = Math.max(0, Math.min(10000, Math.floor(
        args.finalHoldMs == null ? DEFAULT_RECORDING_FINAL_HOLD_MS : Number(args.finalHoldMs) || 0
      )));
      return finishActiveRecording({
        recordingId: args.recordingId,
        ownerId: args.ownerId,
        saveToFile: allowFileSave && args.saveToFile !== false,
        finalHoldMs,
        stopReason: "manual"
      });
    }
    case "recording_cancel": {
      assertRecordingOwner(args.recordingId, args.ownerId);
      const cancelledId = recording.id;
      if (recording.capturing) {
        await chrome.debugger.sendCommand({ tabId: recording.tabId }, "Page.stopScreencast").catch(() => {});
      }
      await recorderRequest("cancel");
      await chrome.alarms.clear(RECORDING_TIMEOUT_ALARM);
      recording = null;
      return { success: true, recordingId: cancelledId, cancelled: true };
    }
    case "operation_create":
      return { opid: makeId("op"), label: String(args.label || ""), createdAt: Date.now() };
    case "operation_get_requests": {
      const opid = String(args.opid || "");
      const documents = await queryTraceDocuments(args.tabId);
      const requests = documents.flatMap((document) => Object.values(document.requests || {})
        .filter((request) => request.opid === opid)
        .map((request) => ({
          ...(args.includeBodies ? request : withoutBodies(request)),
          tabId: document.tabId,
          documentId: document.documentId,
          pageUrl: document.pageUrl
        })));
      requests.sort((a, b) => Number(a.startedAt) - Number(b.startedAt));
      return {
        opid,
        count: requests.length,
        requests,
        correlation: "best-effort-zone-style",
        warning: "OPID propagation can be lost across native, navigation, service-worker, or unusual asynchronous chains. Zero matches do not prove that no HTTP request occurred; use network_list_requests to inspect CDP Network traffic for the same tab and time window."
      };
    }
    case "network_list_requests": {
      const tab = await resolveTab(args.tabId);
      await ensureDebugger(tab.id);
      if (args.resourceType && args.resourceTypes) throw new Error("Provide either resourceType or resourceTypes, not both");
      const urlContains = String(args.urlContains || "").toLowerCase();
      const method = String(args.method || "").toUpperCase();
      const resourceType = String(args.resourceType || "").toLowerCase();
      const resourceTypes = new Set((Array.isArray(args.resourceTypes) ? args.resourceTypes : [])
        .map((value) => String(value).toLowerCase()));
      const statusMin = args.statusMin == null ? null : Number(args.statusMin);
      const statusMax = args.statusMax == null ? null : Number(args.statusMax);
      const since = args.since == null ? null : Number(args.since);
      const until = args.until == null ? null : Number(args.until);
      const limit = Math.max(1, Math.min(1000, Math.floor(Number(args.limit) || 100)));
      const requests = (await queryNetworkRequests(tab.id)).filter((request) => {
        if (urlContains && !String(request.url || "").toLowerCase().includes(urlContains)) return false;
        if (method && String(request.method || "").toUpperCase() !== method) return false;
        if (resourceType && String(request.resourceType || "").toLowerCase() !== resourceType) return false;
        if (resourceTypes.size && !resourceTypes.has(String(request.resourceType || "").toLowerCase())) return false;
        if (statusMin != null && !(Number(request.status) >= statusMin)) return false;
        if (statusMax != null && !(Number(request.status) <= statusMax)) return false;
        if (since != null && !(Number(request.startedAt) >= since)) return false;
        if (until != null && !(Number(request.startedAt) <= until)) return false;
        return true;
      }).sort((a, b) => Number(a.startedAt) - Number(b.startedAt)).slice(-limit)
        .map((request) => args.includeHeaders === true ? request : withoutNetworkHeaders(request));
      return {
        tabId: tab.id,
        count: requests.length,
        requests,
        source: "cdp-network",
        note: "CDP requests are independent of OPID correlation. Use startedAt and URL filters to align them with the interaction under test."
      };
    }
    case "request_get_details": {
      const requestId = String(args.requestId || "");
      const documents = await queryTraceDocuments(args.tabId);
      for (const document of documents) {
        if (document.requests?.[requestId]) {
          return { ...document.requests[requestId], tabId: document.tabId, documentId: document.documentId, pageUrl: document.pageUrl };
        }
      }
      throw new Error(`Request not found: ${requestId}`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function resultFilePaths(result) {
  const paths = [result?.filePath, result?.filePathAfter, result?.step?.filePath];
  for (const step of result?.steps || []) paths.push(step?.filePath);
  return [...new Set(paths.filter(Boolean).map(String))];
}

function formatToolResult(result) {
  const images = result?.image ? [{ name: "screenshot", ...result.image }] : (result?.images || []);
  const snapshotText = result?.snapshot?.text || (typeof result?.snapshot === "string" ? result.snapshot : "");
  const filePaths = resultFilePaths(result);
  const fileFields = filePaths.length === 1 ? { filePath: filePaths[0] } : (filePaths.length ? { filePaths } : {});
  if (images.length || snapshotText) {
    const { image: _image, images: _images, snapshot: _snapshot, ...metadata } = result;
    if (result?.snapshot && typeof result.snapshot === "object") {
      const { text: _text, ...snapshotMetadata } = result.snapshot;
      metadata.snapshot = snapshotMetadata;
    }
    return {
      ...fileFields,
      content: [
        ...images.map((item) => ({ type: "image", mimeType: item.mimeType, data: item.data })),
        ...(snapshotText ? [{ type: "text", text: snapshotText }] : []),
        { type: "text", text: JSON.stringify({ ...metadata, screenshots: images.map((item) => item.name) }) }
      ]
    };
  }
  return { ...fileFields, content: [{ type: "text", text: JSON.stringify(result) }] };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id == null ? null : id, error: { code, message } };
}

function toolsForTransport(transport) {
  if (transport !== "external") return TOOLS;
  const tools = structuredClone(TOOLS);
  const markFileSavingUnavailable = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "saveToFile" && child && typeof child === "object") {
        child.const = false;
        child.description = "Cross-extension calls cannot upload files. Omit this field or set it to false.";
      } else {
        markFileSavingUnavailable(child);
      }
    }
  };
  for (const tool of tools) {
    markFileSavingUnavailable(tool.inputSchema);
    if (["screenshot", "cua_action", "cua_batch", "recording_start", "recording_stop"].includes(tool.name)) {
      tool.description += " Cross-extension calls return inline data where applicable and never upload files.";
    }
  }
  return tools;
}

function queueToolCall(name, args, context) {
  const run = executionQueue.then(() => executeTool(name, args, context));
  executionQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function handleRpc(message, context = {}) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return rpcError(message?.id, -32600, "Invalid Request: expected jsonrpc 2.0");
  }
  const { id, method, params } = message;
  if (id == null) return null;
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: params?.protocolVersion || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "browsertrace", version: chrome.runtime.getManifest().version }
    });
  } else if (method === "tools/list") {
    return rpcResult(id, { tools: toolsForTransport(context.transport) });
  } else if (method === "tools/call") {
    if (!params?.name) return rpcError(id, -32602, "Invalid params: tools/call requires params.name");
    try {
      const result = await queueToolCall(params.name, params.arguments || {}, {
        allowFileSave: context.transport !== "external",
        transport: context.transport || "websocket",
        senderId: context.senderId
      });
      return rpcResult(id, formatToolResult(result));
    } catch (error) {
      const message = error?.message || String(error);
      return rpcError(id, /^Unknown tool:/.test(message) ? -32601 : -32000, message);
    }
  } else if (method === "ping") {
    return rpcResult(id, { pong: true, version: chrome.runtime.getManifest().version });
  } else {
    return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  const delay = reconnectDelays[Math.min(reconnectAttempt++, reconnectDelays.length - 1)];
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  running = settings.enabled === true;
  if (!running || !/^wss?:\/\//.test(settings.wsUrl || "")) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  try {
    socket = new WebSocket(settings.wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    reconnectAttempt = 0;
    void chrome.storage.local.set({ bridgeStatus: { connected: true, url: settings.wsUrl, updatedAt: Date.now() } });
  };
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message?.jsonrpc === "2.0" && message.id != null && message.method) {
        void handleRpc(message, { transport: "websocket" }).then((response) => {
          if (response) send(response);
        });
      }
    } catch {
      // Ignore malformed bridge messages.
    }
  };
  socket.onclose = () => {
    socket = null;
    void chrome.storage.local.set({ bridgeStatus: { connected: false, url: settings.wsUrl, updatedAt: Date.now() } });
    scheduleReconnect();
  };
  socket.onerror = () => socket?.close();
}

function restartConnection() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  running = false;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  reconnectAttempt = 0;
  void connect();
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "trace-record") void saveTraceRecord(sender, message.payload);
  if (message?.type === "bridge-reconnect") restartConnection();
});
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void handleRpc(message, { transport: "external", senderId: sender.id }).then((response) => {
    if (response) sendResponse(response);
  }).catch((error) => {
    sendResponse(rpcError(message?.id, -32000, error?.message || String(error)));
  });
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "trace-bridge") {
    port.onMessage.addListener((message) => {
      if (message?.type === "trace-record") void saveTraceRecord(port.sender, message.payload);
    });
    port.onDisconnect.addListener(() => {
      // BFCache closes both ends of a content-script Port. Consume Chrome's
      // expected lifecycle error so it is not reported as an unchecked error.
      void chrome.runtime.lastError;
    });
    return;
  }
  if (port.name === "recording-offscreen") {
    recorderPort = port;
    for (const ready of recorderPortWaiters.splice(0)) ready();
    port.onMessage.addListener((message) => {
      const pending = message?.replyTo && recorderRequests.get(message.replyTo);
      if (!pending) return;
      recorderRequests.delete(message.replyTo);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (recorderPort === port) recorderPort = null;
      for (const [id, pending] of recorderRequests) {
        recorderRequests.delete(id);
        pending.reject(new Error("Offscreen recorder disconnected"));
      }
      if (recording) recording.error = "Offscreen recorder disconnected";
    });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["wsUrl", "enabled"]);
  if (existing.wsUrl === LEGACY_DEFAULT_WS_URL) delete existing.wsUrl;
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing });
  void connect();
});

chrome.runtime.onStartup.addListener(() => void connect());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECORDING_TIMEOUT_ALARM || !recording || recordingFinishing) return;
  const timedOutOwnerId = recording.ownerId;
  void finishActiveRecording({
    recordingId: recording.id,
    ownerId: timedOutOwnerId,
    saveToFile: recording.autoSaveToFile,
    finalHoldMs: 0,
    stopReason: "max-duration"
  }).catch(async (error) => {
    const result = {
      success: false,
      ownerId: timedOutOwnerId,
      stopReason: "max-duration",
      error: error?.message || String(error),
      finishedAt: Date.now()
    };
    lastRecordingResult = result;
    await chrome.storage.local.set({ lastRecordingResult: result });
  });
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  managedTabIds.delete(tabId);
  void removeDebuggerDataForTab(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) void removeDebuggerDataForTab(tabId);
  if (changeInfo.status === "complete" && managedTabIds.has(tabId)) {
    void ensureDebugger(tabId).then(() => ensureRecordingOverlay(tabId)).catch(() => {});
  }
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  if (method === "Network.requestWillBeSent") {
    const startedAt = Number(params.wallTime) > 0 ? Math.round(Number(params.wallTime) * 1000) : Date.now();
    void updateNetworkRequest(source.tabId, params.requestId, (existing) => ({
      requestId: params.requestId,
      loaderId: params.loaderId,
      frameId: params.frameId,
      documentUrl: params.documentURL,
      url: params.request?.url,
      method: params.request?.method,
      requestHeaders: params.request?.headers,
      postData: params.request?.postData,
      hasPostData: params.request?.hasPostData === true,
      resourceType: params.type,
      initiator: params.initiator ? {
        type: params.initiator.type,
        url: params.initiator.url,
        lineNumber: params.initiator.lineNumber,
        columnNumber: params.initiator.columnNumber
      } : undefined,
      startedAt,
      redirects: params.redirectResponse && existing ? [
        ...(existing.redirects || []),
        {
          url: existing.url,
          method: existing.method,
          status: params.redirectResponse.status,
          statusText: params.redirectResponse.statusText,
          responseHeaders: params.redirectResponse.headers,
          location: params.redirectResponse.headers?.location || params.redirectResponse.headers?.Location
        }
      ] : (existing?.redirects || [])
    })).catch(() => {});
    return;
  }
  if (method === "Network.responseReceived") {
    void updateNetworkRequest(source.tabId, params.requestId, (existing) => ({
      ...(existing || { requestId: params.requestId, startedAt: Date.now() }),
      resourceType: params.type || existing?.resourceType,
      status: params.response?.status,
      statusText: params.response?.statusText,
      responseUrl: params.response?.url,
      responseHeaders: params.response?.headers,
      mimeType: params.response?.mimeType,
      protocol: params.response?.protocol,
      remoteIPAddress: params.response?.remoteIPAddress,
      remotePort: params.response?.remotePort,
      fromDiskCache: params.response?.fromDiskCache === true,
      fromServiceWorker: params.response?.fromServiceWorker === true,
      fromPrefetchCache: params.response?.fromPrefetchCache === true,
      responseAt: Date.now()
    })).catch(() => {});
    return;
  }
  if (method === "Network.loadingFinished") {
    const finishedAt = Date.now();
    void updateNetworkRequest(source.tabId, params.requestId, (existing) => ({
      ...(existing || { requestId: params.requestId, startedAt: finishedAt }),
      finishedAt,
      durationMs: Math.max(0, finishedAt - Number(existing?.startedAt || finishedAt)),
      encodedDataLength: params.encodedDataLength,
      completed: true
    })).catch(() => {});
    return;
  }
  if (method === "Network.loadingFailed") {
    const finishedAt = Date.now();
    void updateNetworkRequest(source.tabId, params.requestId, (existing) => ({
      ...(existing || { requestId: params.requestId, startedAt: finishedAt }),
      finishedAt,
      durationMs: Math.max(0, finishedAt - Number(existing?.startedAt || finishedAt)),
      failed: true,
      canceled: params.canceled === true,
      errorText: params.errorText,
      blockedReason: params.blockedReason,
      corsErrorStatus: params.corsErrorStatus
    })).catch(() => {});
    return;
  }
  if (method === "Page.screencastFrame") {
    void chrome.debugger.sendCommand({ tabId: source.tabId }, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    if (recording?.capturing && recording.tabId === source.tabId && !recordingFrameForwarding) {
      recordingFrameForwarding = true;
      void recorderRequest("frame", { data: params.data }).catch((error) => {
        if (recording) recording.error = error?.message || String(error);
      }).finally(() => {
        recordingFrameForwarding = false;
      });
    }
    return;
  }
  const entry = consoleEntryFromEvent(method, params);
  if (entry) void appendConsoleEntry(source.tabId, entry);
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

void connect();
