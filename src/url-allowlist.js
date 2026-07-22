export const DEFAULT_URL_ALLOWLIST = ["http://*", "https://*"];

export function normalizeUrlAllowlist(value) {
  if (!Array.isArray(value)) return [...DEFAULT_URL_ALLOWLIST];
  return value.map((pattern) => String(pattern).trim()).filter(Boolean);
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

export function isUrlAllowed(url, allowlist) {
  return normalizeUrlAllowlist(allowlist).some((pattern) => globToRegExp(pattern).test(url));
}
