/* global chrome, WebMRemux */

(() => {
  "use strict";

  const canvas = document.getElementById("output");
  const context = canvas.getContext("2d", { alpha: false });
  const port = chrome.runtime.connect({ name: "recording-offscreen" });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
  });

  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let renderTimer = null;
  let latestFrame = null;
  let frameQueue = Promise.resolve();
  let config = null;
  let activeStartedAt = 0;
  let activeDurationMs = 0;
  const cursor = { visible: false, x: 0, y: 0, animation: null, pulses: [], badge: null };

  function once(target, event) {
    return new Promise((resolve, reject) => {
      const onEvent = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error?.error || new Error(`MediaRecorder ${event} failed`));
      };
      const cleanup = () => {
        target.removeEventListener(event, onEvent);
        target.removeEventListener("error", onError);
      };
      target.addEventListener(event, onEvent, { once: true });
      target.addEventListener("error", onError, { once: true });
    });
  }

  function chooseMimeType() {
    return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function stopRenderClock() {
    clearInterval(renderTimer);
    renderTimer = null;
  }

  function startRenderClock() {
    stopRenderClock();
    const interval = Math.max(16, Math.round(1000 / config.fps));
    renderFrame();
    renderTimer = setInterval(renderFrame, interval);
  }

  function scaledPoint(x, y) {
    return {
      x: Number(x) * canvas.width / config.viewportWidth,
      y: Number(y) * canvas.height / config.viewportHeight
    };
  }

  function currentCursorPosition(now) {
    const animation = cursor.animation;
    if (!animation) return { x: cursor.x, y: cursor.y };
    const ratio = Math.min(1, Math.max(0, (now - animation.startedAt) / animation.durationMs));
    const eased = 1 - Math.pow(1 - ratio, 3);
    cursor.x = animation.fromX + (animation.toX - animation.fromX) * eased;
    cursor.y = animation.fromY + (animation.toY - animation.fromY) * eased;
    if (ratio >= 1) cursor.animation = null;
    return { x: cursor.x, y: cursor.y };
  }

  function drawCursor(now) {
    if (!config.showCursor || !cursor.visible) return;
    const position = currentCursorPosition(now);
    const point = scaledPoint(position.x, position.y);
    context.save();
    context.translate(point.x, point.y);
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(4, 18);
    context.lineTo(9, 12);
    context.lineTo(15, 19);
    context.lineTo(19, 15);
    context.lineTo(12, 9);
    context.lineTo(18, 5);
    context.closePath();
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#111111";
    context.lineWidth = 2;
    context.fill();
    context.stroke();
    context.restore();

    cursor.pulses = cursor.pulses.filter((pulse) => now - pulse.startedAt < 550);
    for (const pulse of cursor.pulses) {
      const progress = Math.min(1, (now - pulse.startedAt) / 550);
      context.beginPath();
      context.arc(point.x, point.y, 8 + progress * 24, 0, Math.PI * 2);
      context.strokeStyle = `rgba(${pulse.right ? "220,60,60" : "30,120,255"},${1 - progress})`;
      context.lineWidth = 3;
      context.stroke();
    }
  }

  function drawBadge(now) {
    if (!cursor.badge || now - cursor.badge.startedAt > 900) {
      cursor.badge = null;
      return;
    }
    const label = cursor.badge.text;
    context.save();
    context.font = "600 18px system-ui, sans-serif";
    const width = context.measureText(label).width + 24;
    const x = Math.max(12, canvas.width - width - 18);
    const y = canvas.height - 52;
    context.fillStyle = "rgba(20,20,20,0.82)";
    context.fillRect(x, y, width, 36);
    context.fillStyle = "#ffffff";
    context.fillText(label, x + 12, y + 24);
    context.restore();
  }

  function renderFrame() {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (latestFrame) context.drawImage(latestFrame, 0, 0, canvas.width, canvas.height);
    const now = performance.now();
    drawCursor(now);
    drawBadge(now);
  }

  async function decodeFrame(data, mimeType = "image/jpeg") {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    latestFrame?.close?.();
    latestFrame = bitmap;
    renderFrame();
  }

  async function startRecording(options) {
    if (mediaRecorder) throw new Error("A recording is already active");
    config = options;
    canvas.width = options.width;
    canvas.height = options.height;
    chunks = [];
    activeDurationMs = 0;
    activeStartedAt = 0;
    cursor.visible = false;
    cursor.animation = null;
    cursor.pulses = [];
    cursor.badge = null;
    latestFrame?.close?.();
    latestFrame = null;
    frameQueue = Promise.resolve();
    renderFrame();

    mediaStream = canvas.captureStream(options.fps);
    const mimeType = chooseMimeType();
    mediaRecorder = new MediaRecorder(mediaStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: options.videoBitsPerSecond
    });
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    const started = once(mediaRecorder, "start");
    mediaRecorder.start(1000);
    await started;
    const paused = once(mediaRecorder, "pause");
    mediaRecorder.pause();
    await paused;
    return { mimeType: mediaRecorder.mimeType, state: "armed", width: canvas.width, height: canvas.height, fps: options.fps };
  }

  async function resumeRecording() {
    if (!mediaRecorder) throw new Error("No active recording");
    if (mediaRecorder.state === "recording") return { state: "recording" };
    const resumed = once(mediaRecorder, "resume");
    mediaRecorder.resume();
    await resumed;
    activeStartedAt = performance.now();
    startRenderClock();
    return { state: "recording" };
  }

  async function pauseRecording() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") return { state: "paused" };
    stopRenderClock();
    activeDurationMs += performance.now() - activeStartedAt;
    activeStartedAt = 0;
    mediaRecorder.requestData();
    const paused = once(mediaRecorder, "pause");
    mediaRecorder.pause();
    await paused;
    return { state: "paused", durationMs: Math.round(activeDurationMs) };
  }

  async function uploadBlob(blob, upload) {
    const form = new FormData();
    form.append("file", blob, upload.filename || "recording.webm");
    const response = await fetch(upload.url, {
      method: "POST",
      body: form
    });
    if (!response.ok) throw new Error(`MCP Center upload failed: ${response.status} ${await response.text()}`);
    const result = await response.json();
    if (!result?.path) throw new Error("MCP Center upload response did not include path");
    return String(result.path);
  }

  async function finishRecording(discard, upload) {
    if (!mediaRecorder) throw new Error("No active recording");
    stopRenderClock();
    if (activeStartedAt) activeDurationMs += performance.now() - activeStartedAt;
    const stopped = once(mediaRecorder, "stop");
    mediaRecorder.stop();
    await stopped;
    mediaStream?.getTracks().forEach((track) => track.stop());
    const mimeType = mediaRecorder.mimeType || "video/webm";
    const durationMs = Math.round(activeDurationMs);
    const originalSize = chunks.reduce((total, chunk) => total + chunk.size, 0);
    let blob = !discard && upload ? new Blob(chunks, { type: mimeType }) : null;
    let mediaDurationMs;
    let remuxed = false;
    mediaRecorder = null;
    mediaStream = null;
    chunks = [];
    config = null;
    activeStartedAt = 0;
    activeDurationMs = 0;
    if (blob) {
      const result = await WebMRemux.makeSeekable(blob);
      blob = result.blob;
      mediaDurationMs = result.durationMs;
      remuxed = true;
    }
    const size = blob?.size ?? originalSize;
    const filePath = blob ? await uploadBlob(blob, upload) : undefined;
    return { mimeType, durationMs, mediaDurationMs, size, originalSize, remuxed, filePath };
  }

  async function execute(message) {
    switch (message.command) {
      case "start": return startRecording(message.options);
      case "frame":
        frameQueue = frameQueue.catch(() => {}).then(() => decodeFrame(message.data, message.mimeType));
        await frameQueue;
        return { received: true };
      case "resume": return resumeRecording();
      case "pause": return pauseRecording();
      case "cursor": {
        const now = performance.now();
        const current = currentCursorPosition(now);
        cursor.visible = true;
        cursor.animation = {
          fromX: current.x,
          fromY: current.y,
          toX: Number(message.x),
          toY: Number(message.y),
          durationMs: Math.max(1, Number(message.durationMs) || 1),
          startedAt: now
        };
        return { visible: true };
      }
      case "click":
        cursor.pulses.push({ startedAt: performance.now(), right: message.button === "right" });
        return { marked: true };
      case "key":
        cursor.badge = { text: String(message.text || "Key"), startedAt: performance.now() };
        return { marked: true };
      case "stop": return finishRecording(false, message.upload);
      case "cancel": return finishRecording(true);
      default: throw new Error(`Unknown recorder command: ${message.command}`);
    }
  }

  port.onMessage.addListener((message) => {
    if (!message?.id || !message.command) return;
    void execute(message).then(
      (result) => port.postMessage({ replyTo: message.id, result }),
      (error) => port.postMessage({ replyTo: message.id, error: error?.message || String(error) })
    );
  });
})();
