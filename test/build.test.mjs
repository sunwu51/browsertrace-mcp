import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1");

test("built extension contains the required MV3 capabilities", async () => {
  const manifest = JSON.parse(await readFile(join(root, "dist", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(!manifest.permissions.includes("downloads"));
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
  assert.ok(manifest.permissions.includes("tabGroups"));
  assert.ok(manifest.host_permissions.includes("<all_urls>"));
  assert.deepEqual(manifest.externally_connectable, { ids: ["*"], matches: [] });
  assert.deepEqual(manifest.content_scripts[0].js, ["trace-runtime.js"]);
  await readFile(join(root, "dist", "recorder.html"), "utf8");
  await readFile(join(root, "dist", "recorder.js"), "utf8");
  const remux = await readFile(join(root, "dist", "webm-remux.js"), "utf8");
  assert.match(remux, /makeMetadataSeekable/);
  assert.match(remux, /globalThis\.Buffer =/);
});

test("trace runtime records OPIDs without adding an OPID request header", async () => {
  const runtime = await readFile(join(root, "src", "trace-runtime.js"), "utf8");
  assert.match(runtime, /opid: operation\?\.id \|\| null/);
  assert.doesNotMatch(runtime, /x-op-id/i);
  assert.doesNotMatch(runtime, /headers\.set\([^)]*op/i);
});

test("service worker exposes the debugging and trace query tools", async () => {
  const worker = await readFile(join(root, "src", "service-worker.js"), "utf8");
  for (const tool of [
    "tab_open",
    "tab_close",
    "screenshot",
    "cua_action",
    "cua_batch",
    "mouse_click",
    "type_text",
    "evaluate_script",
    "console_list",
    "console_clear",
    "recording_start",
    "recording_status",
    "recording_stop",
    "recording_cancel",
    "operation_create",
    "operation_get_requests",
    "network_list_requests",
    "request_get_details"
  ]) {
    assert.match(worker, new RegExp(`name: \\\"${tool}\\\"`));
  }
  assert.doesNotMatch(worker, /name: "tabs_list"/);
  assert.doesNotMatch(worker, /case "tabs_list"/);
  assert.match(worker, /case "tab_open":[\s\S]*chrome\.tabs\.create[\s\S]*ensureDebugger\(tab\.id\)/);
  assert.match(worker, /async function captureTab[\s\S]*Page\.captureScreenshot/);
  assert.match(worker, /case "screenshot":[\s\S]*captureTab\(tab, args\)/);
  assert.match(worker, /async function saveScreenshot/);
  assert.match(worker, /url\.pathname = "\/fs\/upload"/);
  assert.match(worker, /form\.append\("file", new Blob\(\[bytes\], \{ type: mimeType \}\), filename\)/);
  assert.match(worker, /body: form/);
  assert.doesNotMatch(worker, /JSON\.stringify\(\{ data, mimeType, filename \}\)/);
  assert.match(worker, /filePath: saveToFile/);
  assert.match(worker, /const saveToFile = allowFileSave && args\.saveToFile !== false/);
  assert.match(worker, /chrome\.tabs\.create\(\{ url: url\.href, active: args\.active === true \}\)/);
  assert.match(worker, /autoDiscardable: false/);
  assert.match(worker, /addTabToGroup\(tab, args\.groupName\)/);
  assert.match(worker, /case "tab_close":[\s\S]*chrome\.tabGroups\.query\(\{\}\)[\s\S]*chrome\.tabs\.query\(\{ groupId: group\.id \}\)[\s\S]*closeTabs/);
  assert.match(worker, /Provide either tabId or groupName, not both/);
  assert.doesNotMatch(worker, /captureVisibleTab/);
  assert.doesNotMatch(worker, /chrome\.windows\.update/);
  assert.doesNotMatch(worker, /chrome\.tabs\.update\(tab\.id, \{ active: true \}\)/);
  assert.match(worker, /Accessibility\.getFullAXTree/);
  assert.match(worker, /DOM\.scrollIntoViewIfNeeded/);
  assert.match(worker, /Page\.captureScreenshot/);
  assert.match(worker, /uidByBackend/);
  assert.match(worker, /case "evaluate_script":[\s\S]*Runtime\.evaluate/);
  assert.match(worker, /Runtime\.consoleAPICalled/);
  assert.match(worker, /"Network\.enable"/);
  assert.match(worker, /method === "Network\.requestWillBeSent"/);
  assert.match(worker, /method === "Network\.responseReceived"/);
  assert.match(worker, /method === "Network\.loadingFinished"/);
  assert.match(worker, /method === "Network\.loadingFailed"/);
  assert.match(worker, /case "network_list_requests"/);
  assert.match(worker, /resourceTypes to \[\\"XHR\\", \\"Fetch\\"\]/);
  assert.match(worker, /Provide either resourceType or resourceTypes, not both/);
  assert.match(worker, /Zero matches do not prove/);
  assert.match(worker, /Page\.startScreencast/);
  assert.match(worker, /Page\.screencastFrameAck/);
  assert.match(worker, /window\.devicePixelRatio \|\| 1/);
  assert.match(worker, /physicalWidth = viewportWidth \* deviceScaleFactor/);
  assert.match(worker, /DEFAULT_RECORDING_MAX_WIDTH = 3840/);
  assert.match(worker, /DEFAULT_RECORDING_MAX_HEIGHT = 2160/);
  assert.match(worker, /DEFAULT_RECORDING_BITRATE = 12000000/);
  assert.match(worker, /DEFAULT_RECORDING_FINAL_HOLD_MS = 2000/);
  assert.match(worker, /DEFAULT_RECORDING_MAX_DURATION_MS = 300000/);
  assert.match(worker, /required: \["recordingId", "ownerId"\]/);
  assert.match(worker, /reason: "recording-busy"/);
  assert.match(worker, /recording\.ownerId !== ownerId \|\| args\.replaceExisting !== true/);
  assert.match(worker, /stopReason: "replaced-by-owner"/);
  assert.match(worker, /function assertRecordingOwner/);
  assert.match(worker, /async function startContinuousRecordingCapture/);
  assert.match(worker, /function installRecordingOverlay/);
  assert.match(worker, /canvas\.dataset\.chromeDebuggerRecordingOverlay/);
  assert.match(worker, /pointerEvents: "none"/);
  assert.match(worker, /showCursor: false/);
  assert.match(worker, /const managedTabIds = new Set/);
  assert.match(worker, /case "tab_open":[\s\S]*managedTabIds\.add\(tab\.id\)[\s\S]*ensureRecordingOverlay\(tab\.id\)/);
  assert.match(worker, /changeInfo\.status === "complete" && managedTabIds\.has\(tabId\)/);
  assert.doesNotMatch(worker, /recording\?\.capturing \|\| recording\.tabId !== tabId \|\| !recording\.showCursor/);
  assert.match(worker, /chrome\.alarms\.create\(RECORDING_TIMEOUT_ALARM/);
  assert.match(worker, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(worker, /stopReason: "max-duration"/);
  assert.match(worker, /lastResult: lastRecordingResult/);
  assert.match(worker, /async function appendRecordingCheckpoint/);
  assert.match(worker, /appendRecordingCheckpoint\(tab\.id, finalFrame, holdMs, "final-state"\)/);
  assert.match(worker, /chrome\.offscreen\.createDocument/);
  assert.doesNotMatch(worker, /chrome\.downloads/);
  assert.match(worker, /case "cua_batch":[\s\S]*executeCuaAction/);
  assert.match(worker, /cua_action requires the tabId returned by tab_open/);
  assert.match(worker, /cua_batch requires the tabId returned by tab_open/);
  assert.match(worker, /required: \["tabId", "action"\]/);
  assert.match(worker, /required: \["tabId", "actions"\]/);
  assert.match(worker, /chrome\.runtime\.onMessageExternal\.addListener/);
  assert.match(worker, /transport: "external"/);
  assert.match(worker, /allowFileSave: context\.transport !== "external"/);
  assert.match(worker, /const allowFileSave = context\.allowFileSave !== false/);
  assert.match(worker, /const saveToFile = allowFileSave && args\.saveToFile !== false/);
  assert.match(worker, /autoSaveToFile: allowFileSave && args\.saveToFile !== false/);
  assert.match(worker, /saveToFile: allowFileSave && recording\.autoSaveToFile/);
  assert.match(worker, /if \(allowFileSave && args\.saveToFile !== false\)/);
  assert.match(worker, /child\.const = false/);
  assert.match(worker, /type === "hover"[\s\S]*durationMs/);
  assert.match(worker, /pointForAction\(tab\.id, action/);
  assert.match(worker, /const CUA_ACTION_SCHEMA = \{/);
  assert.match(worker, /enum: \["move", "hover", "click"/);
  assert.match(worker, /action: CUA_ACTION_SCHEMA/);
  assert.match(worker, /items: CUA_ACTION_SCHEMA/);
});

test("offscreen recorder encodes fixed-clock Canvas frames as continuous WebM", async () => {
  const recorder = await readFile(join(root, "src", "recorder.js"), "utf8");
  assert.match(recorder, /canvas\.captureStream\(options\.fps\)/);
  assert.match(recorder, /new MediaRecorder/);
  assert.match(recorder, /video\/webm;codecs=vp9/);
  assert.match(recorder, /mediaRecorder\.pause\(\)/);
  assert.match(recorder, /mediaRecorder\.resume\(\)/);
  assert.match(recorder, /setInterval\(renderFrame, interval\)/);
  assert.match(recorder, /drawCursor/);
  assert.match(recorder, /decodeFrame\(data, mimeType/);
  assert.match(recorder, /async function uploadBlob/);
  assert.match(recorder, /form\.append\("file", blob, upload\.filename/);
  assert.doesNotMatch(recorder, /blobToBase64/);
  assert.match(recorder, /MCP Center upload failed/);
  assert.match(recorder, /WebMRemux\.makeSeekable\(blob\)/);
  assert.match(recorder, /mediaDurationMs/);
});

test("trace runtime keeps an injected OPID for all events in one CUA action", async () => {
  const runtime = await readFile(join(root, "src", "trace-runtime.js"), "utf8");
  assert.match(runtime, /let injectedOperation = null/);
  assert.match(runtime, /let currentOperation = null/);
  assert.match(runtime, /Promise\.prototype\.then = function/);
  assert.match(runtime, /\["setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "queueMicrotask"\]/);
  assert.doesNotMatch(runtime, /window\.Zone|ZoneCtor|\.fork\(/);
  assert.match(runtime, /clearOperation\(id\)/);
  assert.doesNotMatch(runtime, /pendingOperation = null/);
});

test("content bridge reconnects after BFCache without logging an unchecked runtime error", async () => {
  const bridge = await readFile(join(root, "src", "content-bridge.js"), "utf8");
  assert.match(bridge, /chrome\.runtime\.connect\(\{ name: "trace-bridge" \}\)/);
  assert.match(bridge, /nextPort\.onDisconnect\.addListener/);
  assert.match(bridge, /void chrome\.runtime\.lastError/);
  assert.match(bridge, /window\.addEventListener\("pageshow", handlePageShow\)/);
  assert.match(bridge, /if \(event\.persisted\) connectPort\(\)/);
  assert.match(bridge, /currentPort\.postMessage\(\{ type: "trace-record", payload \}\)/);
  assert.doesNotMatch(bridge, /chrome\.runtime\.sendMessage/);

  const worker = await readFile(join(root, "src", "service-worker.js"), "utf8");
  assert.match(worker, /chrome\.runtime\.onConnect\.addListener/);
  assert.match(worker, /port\.name === "trace-bridge"[\s\S]*port\.onDisconnect\.addListener[\s\S]*void chrome\.runtime\.lastError/);
  assert.match(worker, /port\.name === "recording-offscreen"/);
  assert.match(worker, /port\.name === "recording-offscreen"[\s\S]*port\.onDisconnect\.addListener[\s\S]*void chrome\.runtime\.lastError/);

  const recorder = await readFile(join(root, "src", "recorder.js"), "utf8");
  assert.match(recorder, /chrome\.runtime\.connect\(\{ name: "recording-offscreen" \}\)[\s\S]*port\.onDisconnect\.addListener[\s\S]*void chrome\.runtime\.lastError/);
});
