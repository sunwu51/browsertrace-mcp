import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("built extension exposes workflow-based CUA without compatibility or recording tools", async () => {
  const worker = await readFile(join(root, "dist", "service-worker.js"), "utf8");
  for (const tool of ["tab_open", "session_finish", "tab_close", "screenshot", "snapshot", "cua_action", "workflow_run", "macro_export", "evaluate_script", "console_list", "network_list_requests"]) {
    assert.match(worker, new RegExp(`name: "${tool}"`));
  }
  for (const removed of ["cua_batch", "mouse_click", "type_text", "recording_start", "recording_status", "recording_stop", "recording_cancel", "macro_run"]) {
    assert.doesNotMatch(worker, new RegExp(`name: "${removed}"`));
  }
  assert.match(worker, /do: CUA_ACTION_SCHEMA/);
  assert.match(worker, /Example search flow/);
  assert.match(worker, /output: \{ type: "string", enum: \["file", "base64"\]/);
  assert.match(worker, /async function pointAtCoordinates[\s\S]*DOM\.getNodeForLocation[\s\S]*locatorForBackendNode/);
});
