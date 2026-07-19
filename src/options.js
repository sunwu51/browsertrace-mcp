const defaults = {
  wsUrl: "ws://localhost:3000/ws/browsertrace",
  enabled: true,
  bridgeStatus: { connected: false }
};

const enabled = document.querySelector("#enabled");
const wsUrl = document.querySelector("#wsUrl");
const status = document.querySelector("#status");

async function render() {
  const settings = await chrome.storage.local.get(defaults);
  enabled.checked = settings.enabled === true;
  wsUrl.value = settings.wsUrl;
  status.textContent = settings.bridgeStatus?.connected ? "已连接" : "未连接";
  status.dataset.connected = String(settings.bridgeStatus?.connected === true);
}

document.querySelector("#save").addEventListener("click", async () => {
  const url = wsUrl.value.trim();
  if (!/^wss?:\/\//.test(url)) {
    status.textContent = "URL 必须以 ws:// 或 wss:// 开头";
    return;
  }
  await chrome.storage.local.set({ enabled: enabled.checked, wsUrl: url });
  await chrome.runtime.sendMessage({ type: "bridge-reconnect" });
  status.textContent = "正在重连";
  setTimeout(render, 800);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.bridgeStatus) void render();
});

void render();
