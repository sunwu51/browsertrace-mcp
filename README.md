# BrowserTrace MCP

An unpacked Chrome MV3 extension that exposes screenshots, trusted mouse/keyboard
input, and click-to-fetch/XHR tracing through the
[`@sunwu51/chrome-mcp-sdk`](https://www.npmjs.com/package/@sunwu51/chrome-mcp-sdk)
WebSocket bridge for [`sunwu51/mcp-center`](https://github.com/sunwu51/mcp-center).

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
from other extensions remain enabled through the same Chrome MCP SDK tool registry.

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
Direct extension calls can receive inline MCP image content, snapshots, normal
JSON results, and upload screenshots to MCP Center. Restrict
`externally_connectable.ids` to known extension IDs if the local Chrome profile
contains untrusted extensions.

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

Every input CUA action generates an OPID when omitted. Supply `opid` directly
on the action only when a caller needs a stable custom identifier.

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
stable UIDs for the lifetime of that document. When a stable DOM attribute is
available, the line also includes a portable `locator` with ordered CSS/XPath
strategies; use that locator for a macro rather than the document-local UID.

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
`multipart/form-data` in the `file` field.
Set both `includeImage: false` and
`saveToFile: false` for a semantic-only snapshot with no PNG capture. UID and
CUA screenshot actions use the same behavior.

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

## Human-like actions

`cua_action` accepts one action object. Supported action types are `move`,
`hover`, `click`, `double_click`, `right_click`, `mouse_down`, `mouse_up`,
`drag`, `scroll`, `type`, `key_press`, `key_down`, `key_up`, `select_all`,
`clear`, `wait`, `wait_for`, and `screenshot`.

Action parameters vary by `type`:

| Action | Required parameters | Optional target / notes |
| --- | --- | --- |
| `click`, `double_click`, `right_click`, `move`, `hover`, `mouse_down`, `mouse_up` | `uid` or `locator`, or both `x` and `y` | Coordinates are the visual fallback. |
| `drag` | `fromUid` and `toUid`, or `fromX`, `fromY`, `toX`, and `toY` | `steps` and `durationMs` control interpolation. |
| `type` | `text` | Supply `uid` or `locator` to focus that control first; otherwise text goes to the currently focused control. |
| `key_press`, `key_down`, `key_up` | `key` | Supply `uid` or `locator` to focus that control first. |
| `select_all`, `clear` | None | Supply `uid` or `locator` to focus that control first; otherwise they use the current focus. |
| `scroll` | `deltaX` and/or `deltaY` | `uid` / `locator` or `x` / `y` optionally chooses the wheel position. |
| `wait` | None | `durationMs` defaults to 250 ms. |
| `wait_for` | `state` | Element states require `uid` or `locator`; `network_idle` requires neither. |
| `screenshot` | None | `uid` captures that element; otherwise it captures the viewport or `fullPage`. |

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

Portable locators can be passed instead of a UID. Strategies are tried in
order and must resolve to exactly one visible element (or specify `nth`):

```json
{
  "tabId": 123,
  "action": {
    "type": "click",
    "locator": { "strategies": [{ "kind": "css", "value": "[data-testid='sign-in']" }] }
  }
}
```

Use `wait_for` rather than fixed sleeps when a later step depends on page
state. It supports `present`, `visible`, `hidden`, `absent`, and CDP-backed
`network_idle` (WebSocket and EventSource are ignored):

```json
{ "tabId": 123, "action": { "type": "wait_for", "state": "visible", "locator": { "strategies": [{ "kind": "css", "value": ".results" }] }, "timeoutMs": 10000 } }
```

## Workflows and macros

Use `workflow_run` for every multi-step operation, including a simple linear
sequence. It also supports bounded control flow: a step is `{ "do": <CUA
action> }`, `{ "waitFor": <wait_for
fields> }`, `{ "if": { "when": ..., "then": [...], "else": [...] } }`, or
`{ "while": { "when": ..., "maxIterations": 20, "steps": [...] } }`.
Conditions use the same element-state or `network_idle` fields as `wait_for`.

```json
{ "tabId": 123, "workflow": { "steps": [
  { "do": { "type": "click", "x": 300, "y": 220 } },
  { "do": { "type": "type", "text": "sunwu" } },
  { "do": { "type": "key_press", "key": "Enter" } }
] } }
```

### Search workflow with visual checkpoints

Capture the state before and after entering a search, click a previously
observed button UID, wait for the resulting requests to settle, and capture the
final result:

```json
{
  "tabId": 123,
  "workflow": {
    "steps": [
      { "do": { "type": "screenshot", "output": "file", "name": "search-before" } },
      {
        "do": {
          "type": "type",
          "locator": { "strategies": [{ "kind": "css", "value": "input[type='search']" }] },
          "text": "search today's tech news"
        }
      },
      { "do": { "type": "screenshot", "output": "file", "name": "search-entered" } },
      { "do": { "type": "click", "uid": "abc" } },
      { "waitFor": { "state": "network_idle", "idleMs": 500, "timeoutMs": 10000 } },
      { "do": { "type": "screenshot", "output": "file", "name": "search-results" } }
    ]
  }
}
```

Each screenshot step returns exactly one image output: `output: "file"` returns
`steps[].filePath`, while `output: "base64"` returns `steps[].image`. Use
`snapshot` when only accessibility text/UIDs are needed. Targeted actions return `steps[].target`, including the actual
click point and, for UID or locator targets, the element bounds. A Remotion or
HyperFrames composition can use the checkpoint images plus this per-step target
data to animate cursor movement/clicks and produce an operation walkthrough.

Every completed workflow returns a short-lived `runId`. Call
`macro_export` with that ID to return a portable, versioned macro configuration. Export only
uses the locator captured while the action ran: UIDs, OPIDs, and coordinates
are deliberately omitted. It does not save browser state; pass the returned
`macro.workflow` directly to `workflow_run` to replay it later.

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

For task-scoped cleanup, supply a stable `ownerId` to every `tab_open` call,
then call `session_finish` with the same ID. It detaches the debugger and
closes every tab the task opened:

```json
{ "ownerId": "agent-task-abc" }
```

For a form field addressed by `uid`, `type` replaces the field's current value
by default (including browser-prefilled credentials). Set `append: true` only
when text should be appended deliberately.

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
