const DESKTOP_SETTINGS_KEY = "focusglass:desktop:v1";
const TIMER_KEY = "focusglass:timer:v1";
const APP_SETTINGS_KEY = "focusglass:settings:v1";

const DEFAULT_DESKTOP_SETTINGS = {
  autoOpenMiniTimer: true
};

const MODE_META = {
  focus: { badge: "集中", label: "集中時間" },
  shortBreak: { badge: "小休憩", label: "短い休憩" },
  longBreak: { badge: "長休憩", label: "長めの休憩" }
};

const isWindows = navigator.userAgentData?.platform === "Windows" || /Windows|Win32|Win64/i.test(navigator.userAgent);
let desktopSettings = loadJSON(DESKTOP_SETTINGS_KEY, DEFAULT_DESKTOP_SETTINGS);
let miniWindow = null;
let miniRenderTimer = null;
let helperToastTimer = null;

function loadJSON(key, fallback) {
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(key)) || {}) };
  } catch {
    return { ...fallback };
  }
}

function saveDesktopSettings() {
  try {
    localStorage.setItem(DESKTOP_SETTINGS_KEY, JSON.stringify(desktopSettings));
  } catch {
    // Storage may be unavailable in restricted browsing modes.
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  clearTimeout(helperToastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  helperToastTimer = window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getTimerSnapshot() {
  const timer = loadJSON(TIMER_KEY, {
    mode: "focus",
    status: "idle",
    totalSec: 25 * 60,
    remainingSec: 25 * 60,
    endAt: null,
    cycleCount: 0
  });
  const appSettings = loadJSON(APP_SETTINGS_KEY, { sessionsBeforeLongBreak: 4 });
  const remainingSec = timer.status === "running" && timer.endAt
    ? Math.max(0, Math.ceil((Number(timer.endAt) - Date.now()) / 1000))
    : Math.max(0, Number(timer.remainingSec) || 0);
  const meta = MODE_META[timer.mode] || MODE_META.focus;
  const totalSets = Math.max(2, Number(appSettings.sessionsBeforeLongBreak) || 4);

  return {
    ...timer,
    remainingSec,
    modeBadge: meta.badge,
    modeLabel: meta.label,
    cycleText: `${Math.min((Number(timer.cycleCount) || 0) + 1, totalSets)} / ${totalSets}`,
    startLabel: timer.status === "running" ? "一時停止" : timer.status === "paused" ? "再開" : "スタート",
    statusLabel: timer.status === "running" ? "進行中" : timer.status === "paused" ? "一時停止中" : "待機中"
  };
}

function injectDesktopStyles() {
  if (document.querySelector("#desktop-tools-style")) return;
  const style = document.createElement("style");
  style.id = "desktop-tools-style";
  style.textContent = `
    .desktop-tools { padding-top: 14px; margin-top: 4px; border-top: 1px solid rgba(255,255,255,.48); }
    .desktop-tools-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:8px; }
    .desktop-tools-heading span { display:grid; gap:3px; }
    .desktop-tools-heading strong { font-size:14px; }
    .desktop-tools-heading small, .desktop-tools-status { color:var(--muted); font-size:11px; line-height:1.55; }
    .desktop-tools-actions { display:grid; grid-template-columns:1fr 1fr; gap:9px; margin-top:11px; }
    .desktop-tools-actions .soft-button { min-height:42px; padding-inline:10px; }
    .desktop-tools-status { margin:10px 0 0; }
    @media (max-width:560px) { .desktop-tools-actions { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(style);
}

function notificationStatusText() {
  if (!("Notification" in window)) return "このブラウザではWindows通知を利用できません";
  if (Notification.permission === "granted") return "Windows通知：許可済み";
  if (Notification.permission === "denied") return "Windows通知：ブロック中（ブラウザのサイト設定から変更）";
  return "Windows通知：未許可";
}

function updateDesktopControls() {
  const autoOpen = document.querySelector("#autoOpenMiniTimer");
  const notificationButton = document.querySelector("#windowsNotificationButton");
  const status = document.querySelector("#desktopToolsStatus");
  if (autoOpen) autoOpen.checked = desktopSettings.autoOpenMiniTimer !== false;
  if (notificationButton) {
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    notificationButton.textContent = permission === "granted" ? "通知をテスト" : "通知を許可";
    notificationButton.disabled = permission === "unsupported";
  }
  if (status) {
    const pipStatus = "documentPictureInPicture" in window
      ? "最前面ミニタイマー対応"
      : "通常ポップアップで表示（常時最前面は非対応）";
    status.textContent = `${pipStatus} ／ ${notificationStatusText()}`;
  }
}

function installDesktopControls() {
  if (document.querySelector("#desktopTools")) return;
  const wakeLockToggle = document.querySelector("#wakeLockEnabled")?.closest(".toggle-row");
  const behaviorCard = wakeLockToggle?.closest(".settings-card");
  if (!behaviorCard) return;

  injectDesktopStyles();
  const section = document.createElement("div");
  section.id = "desktopTools";
  section.className = "desktop-tools";
  section.innerHTML = `
    <div class="desktop-tools-heading">
      <span>
        <strong>Windows ミニタイマー</strong>
        <small>ほかのアプリより前に、残り時間と操作ボタンを表示します</small>
      </span>
    </div>
    <label class="toggle-row">
      <span><strong>開始時に自動表示</strong><small>スタート操作と同時に最前面の小窓を開きます</small></span>
      <input id="autoOpenMiniTimer" type="checkbox" />
      <i></i>
    </label>
    <div class="desktop-tools-actions">
      <button id="openMiniTimerButton" class="soft-button emphasized" type="button">ミニタイマーを表示</button>
      <button id="windowsNotificationButton" class="soft-button" type="button">通知を許可</button>
    </div>
    <p id="desktopToolsStatus" class="desktop-tools-status"></p>
  `;
  behaviorCard.appendChild(section);

  section.querySelector("#autoOpenMiniTimer").addEventListener("change", (event) => {
    desktopSettings.autoOpenMiniTimer = event.target.checked;
    saveDesktopSettings();
    showToast(event.target.checked ? "開始時にミニタイマーを表示します" : "自動表示をオフにしました");
  });
  section.querySelector("#openMiniTimerButton").addEventListener("click", () => void openMiniTimer());
  section.querySelector("#windowsNotificationButton").addEventListener("click", () => void requestAndTestNotification());
  updateDesktopControls();
}

async function getServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator) || !location.protocol.startsWith("http")) return null;
  try {
    await navigator.serviceWorker.register("./sw.js");
    return await navigator.serviceWorker.ready;
  } catch (error) {
    console.warn("Desktop notification service worker:", error);
    return null;
  }
}

async function requestAndTestNotification() {
  if (!("Notification" in window)) {
    showToast("このブラウザではWindows通知を利用できません");
    return;
  }

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = Notification.permission;
    }
  }

  updateDesktopControls();
  if (permission === "denied") {
    showToast("通知がブロックされています。アドレスバー左のサイト設定から通知を許可してください");
    return;
  }
  if (permission !== "granted") {
    showToast("Windows通知が許可されませんでした");
    return;
  }

  const registration = await getServiceWorkerRegistration();
  if (!registration) {
    showToast("通知の準備に失敗しました。ページを再読み込みしてください");
    return;
  }

  await registration.showNotification("Focus Glass", {
    body: "Windows通知は有効です。タイマー終了時にここへ通知します。",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: "focus-glass-notification-test",
    renotify: true,
    silent: false,
    data: { url: new URL("./", location.href).href }
  });
  showToast("Windows右下へテスト通知を送りました");
}

function miniWindowIsOpen() {
  try {
    return Boolean(miniWindow && !miniWindow.closed && miniWindow.document);
  } catch {
    return false;
  }
}

function buildMiniTimerDocument(targetWindow, alwaysOnTop) {
  const doc = targetWindow.document;
  doc.open();
  doc.write(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Focus Glass Mini</title>
  <style>
    :root { color-scheme: light; font-family: Inter, "Yu Gothic UI", "Hiragino Kaku Gothic ProN", system-ui, sans-serif; }
    * { box-sizing:border-box; }
    html, body { width:100%; height:100%; margin:0; overflow:hidden; }
    body { display:grid; place-items:stretch; padding:10px; background:linear-gradient(145deg,#dceae7,#edf3f1 55%,#d9e5e2); color:#17302d; }
    .mini { min-width:270px; height:100%; padding:13px 14px 12px; border:1px solid rgba(255,255,255,.82); border-radius:18px; background:rgba(255,255,255,.58); box-shadow:0 12px 34px rgba(44,76,70,.20), inset 0 1px rgba(255,255,255,.75); backdrop-filter:blur(18px) saturate(135%); display:grid; grid-template-rows:auto 1fr auto; gap:7px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:9px; }
    .mode { display:flex; align-items:center; gap:8px; min-width:0; }
    .badge { flex:none; padding:4px 8px; border-radius:999px; background:#326f67; color:white; font-size:11px; font-weight:800; }
    .label { min-width:0; font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .top-note { font-size:9px; color:#627c77; white-space:nowrap; }
    .clock { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:56px; }
    .time { font-variant-numeric:tabular-nums; font-size:clamp(38px,13vw,58px); line-height:.95; letter-spacing:-.055em; font-weight:800; }
    .state { display:grid; justify-items:end; gap:3px; text-align:right; }
    .state strong { font-size:11px; }
    .state span { font-size:9px; color:#627c77; }
    .controls { display:grid; grid-template-columns:1fr auto auto auto; gap:7px; }
    button { min-height:34px; border:0; border-radius:11px; padding:6px 10px; font:inherit; font-size:11px; font-weight:800; cursor:pointer; color:#24423d; background:rgba(255,255,255,.74); box-shadow:inset 0 0 0 1px rgba(55,92,85,.12); }
    button:hover { background:rgba(255,255,255,.95); }
    #miniStart { color:white; background:#326f67; box-shadow:0 5px 14px rgba(50,111,103,.24); }
    .icon { width:36px; padding:0; font-size:14px; }
    @media (max-height:150px) { body { padding:6px; } .mini { padding:8px 10px; border-radius:14px; gap:3px; } .clock { min-height:42px; } .controls button { min-height:29px; } .top-note { display:none; } }
  </style>
</head>
<body>
  <main class="mini">
    <header>
      <div class="mode"><span id="miniBadge" class="badge">集中</span><span id="miniLabel" class="label">集中時間</span></div>
      <span class="top-note">${alwaysOnTop ? "常に最前面" : "移動・サイズ変更可"}</span>
    </header>
    <section class="clock">
      <div id="miniTime" class="time">25:00</div>
      <div class="state"><strong id="miniState">待機中</strong><span id="miniCycle">1 / 4 セット</span></div>
    </section>
    <section class="controls">
      <button id="miniStart" type="button">スタート</button>
      <button id="miniReset" class="icon" type="button" title="リセット" aria-label="リセット">↺</button>
      <button id="miniSkip" class="icon" type="button" title="終了・スキップ" aria-label="終了・スキップ">↠</button>
      <button id="miniOpen" class="icon" type="button" title="メイン画面を開く" aria-label="メイン画面を開く">↗</button>
    </section>
  </main>
</body>
</html>`);
  doc.close();

  doc.querySelector("#miniStart").addEventListener("click", () => document.querySelector("#startButton")?.click());
  doc.querySelector("#miniReset").addEventListener("click", () => document.querySelector("#resetButton")?.click());
  doc.querySelector("#miniSkip").addEventListener("click", () => document.querySelector("#skipButton")?.click());
  doc.querySelector("#miniOpen").addEventListener("click", () => {
    window.focus();
    document.querySelector("#timerTab")?.click();
  });

  targetWindow.addEventListener("pagehide", closeMiniTimer, { once: true });
  targetWindow.addEventListener("unload", closeMiniTimer, { once: true });
}

function renderMiniTimer() {
  if (!miniWindowIsOpen()) {
    closeMiniTimer();
    return;
  }

  const snapshot = getTimerSnapshot();
  const doc = miniWindow.document;
  const setText = (selector, value) => {
    const element = doc.querySelector(selector);
    if (element) element.textContent = value;
  };
  setText("#miniBadge", snapshot.modeBadge);
  setText("#miniLabel", snapshot.modeLabel);
  setText("#miniTime", formatTime(snapshot.remainingSec));
  setText("#miniState", snapshot.statusLabel);
  setText("#miniCycle", `${snapshot.cycleText} セット`);
  setText("#miniStart", snapshot.startLabel);
  doc.title = `${formatTime(snapshot.remainingSec)} · ${snapshot.modeBadge}`;
}

function startMiniRendering() {
  clearInterval(miniRenderTimer);
  renderMiniTimer();
  miniRenderTimer = window.setInterval(renderMiniTimer, 250);
}

function closeMiniTimer() {
  clearInterval(miniRenderTimer);
  miniRenderTimer = null;
  miniWindow = null;
}

async function openMiniTimer() {
  if (miniWindowIsOpen()) {
    miniWindow.focus();
    return;
  }

  try {
    if ("documentPictureInPicture" in window) {
      miniWindow = await window.documentPictureInPicture.requestWindow({ width: 340, height: 184 });
      buildMiniTimerDocument(miniWindow, true);
      startMiniRendering();
      showToast("最前面のミニタイマーを表示しました");
      return;
    }

    miniWindow = window.open("", "focus-glass-mini", "popup=yes,width=340,height=184,resizable=yes");
    if (!miniWindow) {
      showToast("ポップアップがブロックされました。ブラウザでポップアップを許可してください");
      return;
    }
    buildMiniTimerDocument(miniWindow, false);
    startMiniRendering();
    showToast("ミニタイマーを表示しました。常時最前面にはChromeまたはEdgeの最新版が必要です");
  } catch (error) {
    console.warn("Mini timer:", error);
    miniWindow = null;
    showToast("ミニタイマーを開けませんでした。ChromeまたはEdgeで再度お試しください");
  }
}

function handleMainControlClick(event) {
  const startButton = event.target.closest?.("#startButton");
  if (!startButton) return;

  if (desktopSettings.autoOpenMiniTimer !== false && !miniWindowIsOpen()) {
    void openMiniTimer();
  }

  if (isWindows && "Notification" in window && Notification.permission === "denied") {
    window.setTimeout(() => {
      showToast("Windows通知がブロックされています。アドレスバー左のサイト設定から通知を許可してください");
      updateDesktopControls();
    }, 0);
  }
}

function initializeDesktopFeatures() {
  if (!isWindows) return;
  installDesktopControls();
  document.addEventListener("click", handleMainControlClick, true);
  window.addEventListener("focus", updateDesktopControls);
  window.addEventListener("pageshow", () => {
    installDesktopControls();
    updateDesktopControls();
  });
}

initializeDesktopFeatures();
