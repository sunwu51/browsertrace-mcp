import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_URL_ALLOWLIST, isUrlAllowed, normalizeUrlAllowlist } from "../src/url-allowlist.js";

test("uses HTTP and HTTPS wildcard defaults when the setting is absent", () => {
  assert.deepEqual(normalizeUrlAllowlist(undefined), DEFAULT_URL_ALLOWLIST);
  assert.equal(isUrlAllowed("http://localhost:3000/path", undefined), true);
  assert.equal(isUrlAllowed("https://example.com/path?q=1", undefined), true);
});

test("matches the entire URL with star wildcards", () => {
  const allowlist = ["https://example.com/docs/*", "http://localhost:*/health"];
  assert.equal(isUrlAllowed("https://example.com/docs/start", allowlist), true);
  assert.equal(isUrlAllowed("https://example.com/admin", allowlist), false);
  assert.equal(isUrlAllowed("http://localhost:3000/health", allowlist), true);
});

test("an explicitly empty allowlist rejects every URL", () => {
  assert.deepEqual(normalizeUrlAllowlist([]), []);
  assert.equal(isUrlAllowed("https://example.com/", []), false);
});

test("glob punctuation is treated literally", () => {
  assert.equal(isUrlAllowed("https://example.com/file.js?x=1", ["https://example.com/file.js?x=1"]), true);
  assert.equal(isUrlAllowed("https://exampleXcom/fileZjs?x=1", ["https://example.com/file.js?x=1"]), false);
});
