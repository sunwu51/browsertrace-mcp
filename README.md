# BrowserTrace MCP

An unpacked Chrome MV3 extension that exposes screenshots, trusted mouse/keyboard
input, and click-to-fetch/XHR tracing through the WebSocket bridge in
[`sunwu51/mcp-center`](https://github.com/sunwu51/mcp-center).

The tracer does not add an OPID header or otherwise modify page requests. It
records the operation context locally in `chrome.storage.local` and deletes a
tab's records when the tab closes or its main document navigates.
The extension requests `unlimitedStorage` because captured request/response
bodies can exceed Chrome's default extension storage quota.

## Build

```powershell
npm install
npm run build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select the generated `dist` directory. Refresh pages that were already open
before installing or reloading the extension.

By default the extension connects to:

```text
ws://localhost:3000/ws/browsertrace
```

Click the extension action to change the URL or disable the bridge. MCP Center
exposes the tools with its normal server prefix, for example
`browsertrace_screenshot`.
This switch controls only the MCP Center WebSocket connection; direct calls
from other extensions remain available.

## Direct calls from another extension

BrowserTrace also exposes the same JSON-RPC 2.0 MCP surface directly to other
installed Chrome extensions. The receiving manifest uses
`externally_connectable.ids: ["*"]` with `matches: []`, so extension callers are
allowed but ordinary web pages are not. A caller only needs the BrowserTrace
extension ID shown on `chrome://extensions`:

```js
const BROWSERTRACE_ID = "<browsertrace-extension-id>";

chrome.runtime.sendMessage(
  BROWSERTRACE_ID,
  { jsonrpc: "2.0", id: 1, method: "tools/list" },
  (response) => console.log(response.result.tools)
);

chrome.runtime.sendMessage(
  BROWSERTRACE_ID,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "screenshot",
      arguments: { tabId: 123, includeImage: true }
    }
  },
  (response) => console.log(response)
);
```

Both transports support `initialize`, `tools/list`, `tools/call`, and `ping`.
Direct extension calls can receive inline MCP image content, snapshots, and
normal JSON results, but cannot upload screenshots or recordings to MCP Center.
`saveToFile` is forced to `false` for direct calls even if the caller supplies
`true`; this applies to screenshots, CUA screenshot actions, batch final
screenshots, and recording start/stop. A stopped direct-call recording therefore
does not return a video file. Restrict `externally_connectable.ids` to known
extension IDs if the local Chrome profile contains untrusted extensions.

## Typical agent loop

1. Call `tab_open` and keep its returned `tabId`. New tabs open in the background by default.
2. Call `screenshot`. It returns a viewport image and a compact accessibility snapshot with element UIDs.
3. Call `cua_action` with an element `uid`, or use `mouse_click` with viewport coordinates. Keep the returned `opid`.
4. Wait for the page operation to settle.
5. Call `operation_get_requests` with that `opid`.
6. If OPID results are empty or incomplete, call `network_list_requests` with
   the same `tabId`, time window, and a URL/method filter. This CDP-level list
   does not depend on Zone-style context propagation. For normal API traffic,
   use `"resourceTypes": ["XHR", "Fetch"]` to hide Font, Script, Stylesheet,
   Image, and other static-resource noise. Use `"resourceType": "Document"`
   when checking native form submissions or navigation.
7. Call `request_get_details` for bodies and complete page-tracer request details.

`mouse_click` accepts a caller-provided OPID, so an agent may also call
`operation_create` first and use that value for the click.

`tab_open` defaults to `active: false`, sets `autoDiscardable: false`, and puts
created tabs in the `BrowserTrace MCP` tab group. Supply `groupName` to use a
different group in that Chrome window. The debugger is attached immediately,
so its indicator is present before coordinates are measured.

All screenshots use CDP `Page.captureScreenshot`; they do not activate the tab
or focus its window. Set `fullPage: true` to capture the entire rendered page.
If a tab was manually discarded despite `autoDiscardable: false`, screenshot
and snapshot operations restore it with a background reload first.

## Semantic snapshots and element screenshots

`screenshot` always returns a compact accessibility tree. It is not a complete
HTML DOM dump: it focuses on semantic content such as buttons, links, inputs,
headings, menus, and element state. Nodes that resolve to DOM elements have
stable UIDs for the lifetime of that document.

Screenshots are uploaded to MCP Center temporary storage by default, and the MCP
result returns `filePath` as an absolute filename on the MCP Center machine.
`includeImage` controls only whether the PNG is also returned as MCP image
content. This avoids passing base64 through a shell command when an agent needs
a local file:

```json
{
  "tabId": 123,
  "includeImage": false,
  "saveToFile": true,
  "name": "sign-in"
}
```

The upload URL is derived from the configured WebSocket URL, for example
`ws://localhost:3000/ws/browsertrace` becomes
`http://localhost:3000/fs/upload`. Files are sent as binary
`multipart/form-data` in the `file` field; videos are not converted to Base64.
Set both `includeImage: false` and
`saveToFile: false` for a semantic-only snapshot with no PNG capture. UID and
CUA screenshot actions use the same behavior; `cua_batch.screenshotAfter` is
also uploaded automatically.

Example snapshot output:

```text
RootWebArea "Sign in" uid=mabc_1
  textbox "Username" uid=mabc_4 required=true
  textbox "Password" uid=mabc_5 required=true
  button "Sign in" uid=mabc_6
```

Pass a UID to scroll to an element, capture only its box, and return only its
semantic subtree:

```json
{ "tabId": 123, "uid": "mabc_6", "includeImage": true, "saveToFile": true }
```

Capture the full rendered page without activating it:

```json
{ "tabId": 123, "fullPage": true, "includeImage": true }
```

UIDs are backed by the current document loader and CDP backend DOM node IDs.
They are reused while the same DOM node survives, and become invalid after
navigation or when a framework replaces the node. Capture a new snapshot after
an invalid-UID error. Canvas contents and DOM nodes excluded from the
accessibility tree still require coordinate CUA.

## Human-like actions and batches

`cua_action` accepts one action object. Supported action types are `move`,
`hover`, `click`, `double_click`, `right_click`, `mouse_down`, `mouse_up`,
`drag`, `scroll`, `type`, `key_press`, `key_down`, `key_up`, `select_all`,
`clear`, `wait`, and `screenshot`.

Mouse actions accept `uid` instead of `x`/`y`. `drag` accepts `fromUid` and
`toUid` instead of coordinate pairs. Text and keyboard actions may also include
`uid`; the element is clicked to focus it before input. Coordinate fields remain
available as a visual fallback:

```json
{
  "tabId": 123,
  "action": { "type": "click", "uid": "mabc_6", "opid": "op_login" }
}
```

Use `cua_batch` when coordinates are known and intermediate actions do not
change the layout in an unknown way:

```json
{
  "tabId": 123,
  "defaultDelayMs": 50,
  "screenshotAfter": true,
  "actions": [
    { "type": "click", "x": 300, "y": 220 },
    { "type": "clear" },
    { "type": "type", "text": "sunwu" },
    { "type": "click", "x": 300, "y": 280 },
    { "type": "type", "text": "test@example.com" }
  ]
}
```

For a hover menu whose item coordinates are not known yet, call a batch with
`hover`, `wait`, and `screenshot`; inspect the returned image, then issue the
next click or batch. A model cannot inspect a screenshot halfway through one
tool call and dynamically change later coordinates in that same batch.

## Script, console, and tab tools

- `evaluate_script` evaluates a JavaScript expression through CDP, awaits
  Promises by default, and returns a JSON-serializable value.
- `console_list` returns captured `console.*` calls, uncaught exceptions, and
  browser log entries. Use `level` and `limit` to filter it.
- `console_clear` clears both stored entries and the page console.
- `tab_close` closes a specified tab, or the active tab when omitted.
  Pass `groupName` instead to close every tab in all same-named groups across
  Chrome windows, allowing an agent to clean up all tabs it opened:

```json
{ "groupName": "BrowserTrace MCP" }
```

## Continuous WebM recording

`recording_start` immediately starts continuous evidence recording for one tab.
The page remains in the video while the agent is thinking, which preserves the
full interaction timeline. Recording stops automatically after five minutes by
default and uploads using the `saveToFile` choice supplied at start.

```json
{
  "tabId": 123,
  "ownerId": "agent-task-abc",
  "name": "login-debug",
  "maxDurationMs": 300000,
  "saveToFile": true,
  "fps": 15,
  "quality": 90
}
```

The recorder is intentionally singleton. `ownerId` is required and should be
stable for one agent task. If the same owner needs to switch tabs, call
`recording_start` with `"replaceExisting": true`; the previous recording is
stopped and saved before the new one starts. A different owner's recording is
never preempted and returns `reason: "recording-busy"`, including its remaining
lease time so the caller can retry later.

CDP source frames update the latest page image. While recording, the extension
injects a pointer-events-disabled Canvas overlay into the operated page. It
draws synthetic cursor movement, click ripples, and key labels, so these cues
are captured directly in the continuous page recording. The output uses the viewport's
physical pixel size (`CSS pixels * devicePixelRatio`), capped at 3840x2160 by
default, and WebM defaults to 12 Mbps. Supply `videoBitsPerSecond` to request up
to 20 Mbps, or lower `maxWidth` and `maxHeight` when file size matters. No video
frames pass through MCP Center.

`maxDurationMs` may be reduced but cannot exceed 300000ms. Use
`recording_status` while recording; after an automatic stop it returns the
uploaded file in `lastResult`. Stop and upload earlier with:

```json
{
  "recordingId": "recording_xxx",
  "ownerId": "agent-task-abc",
  "saveToFile": true
}
```

`recording_stop` waits for the current action's remaining tail window, uploads
the WebM, and returns the absolute temporary `filePath`. Before stopping it
captures the tab's current state and holds that final frame for 2000ms, so an
async result verified by the agent remains visible at the end of the evidence
video. Set `finalHoldMs: 0` to disable or choose up to 10000ms. Screenshots taken
while recording are also inserted as 750ms video checkpoints. Set
`saveToFile: false` to finish without uploading. Uploaded recordings are EBML
remuxed with Duration, SeekHead, and Cues metadata so players can display the
total duration and seek correctly. The result includes `remuxed`,
`mediaDurationMs`, `durationMs`, `size`, and `originalSize` diagnostics.
Both `recording_stop` and `recording_cancel` require the matching `recordingId`
and `ownerId`; omitting either cannot stop the singleton recorder.
`recording_cancel` discards the encoder state.
MCP Center currently limits uploads to 500 MiB. The five-minute cap limits time,
not exact encoded size, so unusually high-bitrate recordings can still be
rejected with HTTP 413. Only one recording can be active at a time.

## Current scope and limitations

- OPID traces page-world `fetch` and `XMLHttpRequest` but does not correlate
  browser/CDP request IDs. `network_list_requests` separately captures CDP
  Network events, including navigation and resource traffic, as a fallback.
  WebSocket frames and WebTransport activity are not currently listed.
- A lightweight page tracer propagates operation context through interaction
  listeners, Promise callbacks, timers, animation/idle callbacks, and
  `queueMicrotask` without installing Zone.js or replacing the page's global
  Promise implementation. Native async continuations or code that deliberately
  escapes these patched callbacks may appear as a background request with
  `opid: null`.
- Request and response text is capped at 64 KiB in stored records. Binary bodies
  are reported as unavailable.
- `chrome.debugger` displays Chrome's debugging indicator and conflicts with a
  DevTools/CDP debugger attached to the same tab.
- Restricted Chrome pages cannot be injected or controlled.
- The current MCP Center WebSocket bridge does not authenticate registering
  clients. Keep it local until bridge authentication is added.

## Development test page

Serve this repository with any local static server and open
`test-page/index.html`. Its button makes two delayed fetch requests, which
should appear under the single OPID returned by `mouse_click`.
