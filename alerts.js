const ALERT_STATE_KEY = "focusglass:alerts:v1";
const TIMER_KEY = "focusglass:timer:v1";
const QUESTION_KEY = "focusglass:question:v1";
const ALERT_MESSAGES = new Set([
  "集中、おつかれさまでした",
  "休憩が終わりました",
  "1問の目標時間になりました"
]);

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia?.("(display-mode: standalone)").matches
  || window.navigator.standalone === true;

let serviceWorkerRegistrationPromise = null;
let nativeAudioContext = window.AudioContext || window.webkitAudioContext || null;
let sharedAudioContext = null;
let helperToastTimeout = null;
let permissionRequestInFlight = false;
let lastDeliveredMessage = "";
let lastDeliveredAt = 0;

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable in private browsing or restricted contexts.
  }
}

function showHelperToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  clearTimeout(helperToastTimeout);
  toast.textContent = message;
  toast.classList.add("show");
  helperToastTimeout = window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function registerServiceWorker() {
  if (serviceWorkerRegistrationPromise) return serviceWorkerRegistrationPromise;
  if (!("serviceWorker" in navigator) || !location.protocol.startsWith("http")) {
    serviceWorkerRegistrationPromise = Promise.resolve(null);
    return serviceWorkerRegistrationPromise;
  }

  serviceWorkerRegistrationPromise = navigator.serviceWorker
    .register("./sw.js")
    .then(() => navigator.serviceWorker.ready)
    .catch((error) => {
      console.warn("Notification service worker:", error);
      return null;
    });

  return serviceWorkerRegistrationPromise;
}

function createSharedAudioContext(...args) {
  if (!nativeAudioContext) return null;
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new nativeAudioContext(...args);
    try {
      Object.defineProperty(sharedAudioContext, "close", {
        configurable: true,
        value: async () => undefined
      });
    } catch {
      // Keeping the context open is an optimization; failure is non-fatal.
    }
  }
  return sharedAudioContext;
}

function installAudioContextProxy() {
  if (!nativeAudioContext) return;

  function AudioContextProxy(...args) {
    return createSharedAudioContext(...args);
  }

  try {
    Object.setPrototypeOf(AudioContextProxy, nativeAudioContext);
    AudioContextProxy.prototype = nativeAudioContext.prototype;
    window.AudioContext = AudioContextProxy;
    if (window.webkitAudioContext) window.webkitAudioContext = AudioContextProxy;
  } catch (error) {
    console.warn("Audio setup:", error);
  }
}

function unlockAudio() {
  const context = createSharedAudioContext();
  if (!context) return;

  try {
    const resumePromise = context.state === "suspended" ? context.resume() : Promise.resolve();
    void resumePromise.then(() => {
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, context.sampleRate || 44100);
      source.connect(context.destination);
      source.start(0);
    }).catch(() => {});
  } catch {
    // Audio is optional; system notification remains available.
  }
}

function requestNotificationPermission() {
  if (permissionRequestInFlight) return;

  if (isIOS && !isStandalone) {
    showHelperToast("通知を使うには、Safariの共有からホーム画面に追加し、ホーム画面のアイコンから開いてください");
    return;
  }

  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    showHelperToast("この環境ではシステム通知を利用できません");
    return;
  }

  if (Notification.permission === "granted") return;
  if (Notification.permission === "denied") {
    showHelperToast("通知がオフです。iPhoneの設定 → 通知 → Focus Glass で許可してください");
    return;
  }

  permissionRequestInFlight = true;
  const permissionPromise = Notification.requestPermission();
  void permissionPromise.then((permission) => {
    permissionRequestInFlight = false;
    if (permission === "granted") {
      showHelperToast("終了通知を有効にしました");
    } else {
      showHelperToast("通知が許可されませんでした。iPhoneの設定から変更できます");
    }
  }).catch(() => {
    permissionRequestInFlight = false;
  });
}

async function showSystemNotification(message, question = false) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const registration = await registerServiceWorker();
  if (!registration) return;

  const tag = question ? "focus-glass-question" : "focus-glass-main";
  await registration.showNotification("Focus Glass", {
    body: message,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag,
    renotify: true,
    silent: false,
    vibrate: question ? [120, 80, 120] : [180, 100, 240],
    timestamp: Date.now(),
    data: { url: new URL("./", location.href).href }
  });
}

function deliverAlert(message, question = false) {
  const now = Date.now();
  if (message === lastDeliveredMessage && now - lastDeliveredAt < 5000) return;
  lastDeliveredMessage = message;
  lastDeliveredAt = now;
  void showSystemNotification(message, question).catch((error) => {
    console.warn("System notification:", error);
  });
}

function checkExpiredTimers() {
  const now = Date.now();
  const alertState = loadJSON(ALERT_STATE_KEY, { mainEndAt: null, questionEndAt: null });
  let changed = false;

  const main = loadJSON(TIMER_KEY, null);
  const mainEndAt = Number(main?.endAt || 0);
  if (main?.status === "running" && mainEndAt > 0 && now >= mainEndAt && alertState.mainEndAt !== mainEndAt) {
    alertState.mainEndAt = mainEndAt;
    changed = true;
    deliverAlert(main.mode === "focus" ? "集中、おつかれさまでした" : "休憩が終わりました");
  }

  const question = loadJSON(QUESTION_KEY, null);
  const questionEndAt = Number(question?.endAt || 0);
  if (question?.status === "running" && questionEndAt > 0 && now >= questionEndAt && alertState.questionEndAt !== questionEndAt) {
    alertState.questionEndAt = questionEndAt;
    changed = true;
    deliverAlert("1問の目標時間になりました", true);
  }

  if (changed) saveJSON(ALERT_STATE_KEY, alertState);
}

function observeCompletionToasts() {
  const toast = document.querySelector("#toast");
  if (!toast) return;

  const observer = new MutationObserver(() => {
    const message = toast.textContent.trim();
    if (!ALERT_MESSAGES.has(message) || !toast.classList.contains("show")) return;
    deliverAlert(message, message.startsWith("1問"));
  });

  observer.observe(toast, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
}

installAudioContextProxy();
void registerServiceWorker();
observeCompletionToasts();
checkExpiredTimers();
window.setInterval(checkExpiredTimers, 250);

document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.("#startButton, #questionStartButton, #nextQuestionButton");
  if (!trigger) return;
  unlockAudio();
  requestNotificationPermission();
}, true);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkExpiredTimers();
});
window.addEventListener("focus", checkExpiredTimers);
window.addEventListener("pageshow", checkExpiredTimers);
