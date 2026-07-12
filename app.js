import { createCloudSync, isCloudConfigured } from "./cloud.js";

const KEYS = {
  settings: "focusglass:settings:v1",
  sessions: "focusglass:sessions:v1",
  timer: "focusglass:timer:v1",
  question: "focusglass:question:v1"
};

const DEFAULT_SETTINGS = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
  questionSeconds: 120,
  autoStartBreak: false,
  autoStartFocus: false,
  soundEnabled: true,
  vibrationEnabled: true,
  wakeLockEnabled: true,
  updatedAt: Date.now()
};

const MODE_META = {
  focus: { badge: "集中", label: "集中時間" },
  shortBreak: { badge: "小休憩", label: "短い休憩" },
  longBreak: { badge: "長休憩", label: "長めの休憩" }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let settings = loadJSON(KEYS.settings, DEFAULT_SETTINGS);
let sessions = loadJSON(KEYS.sessions, []);
let timerState = loadJSON(KEYS.timer, makeTimerState("focus"));
let questionState = loadJSON(KEYS.question, makeQuestionState(settings.questionSeconds));
let intervalId = null;
let cloud = null;
let cloudUser = null;
let wakeLock = null;
let toastTimeout = null;
let deferredInstallPrompt = null;
let suppressCloudSettings = false;

const elements = {
  timerRing: $("#timerRing"), mainTime: $("#mainTime"), modeBadge: $("#modeBadge"), modeLabel: $("#modeLabel"), timerHint: $("#timerHint"), cycleLabel: $("#cycleLabel"),
  startButton: $("#startButton"), startButtonText: $("#startButtonText"), startIcon: $("#startIcon"), resetButton: $("#resetButton"), skipButton: $("#skipButton"),
  questionCard: $("#questionCard"), questionTime: $("#questionTime"), questionState: $("#questionState"), questionCountBadge: $("#questionCountBadge"), questionDurationLabel: $("#questionDurationLabel"), questionStartButton: $("#questionStartButton"), nextQuestionButton: $("#nextQuestionButton"), questionMinus: $("#questionMinus"), questionPlus: $("#questionPlus"),
  todayDate: $("#todayDate"), todayMinutes: $("#todayMinutes"), todaySessions: $("#todaySessions"), todayQuestions: $("#todayQuestions"),
  statToday: $("#statToday"), statTodaySub: $("#statTodaySub"), statWeek: $("#statWeek"), statStreak: $("#statStreak"), historyChart: $("#historyChart"), sessionList: $("#sessionList"),
  cloudButton: $("#cloudButton"), cloudStatusText: $("#cloudStatusText"), settingsCloudBadge: $("#settingsCloudBadge"), cloudDescription: $("#cloudDescription"), accountButton: $("#accountButton"), accountDialog: $("#accountDialog"), accountDialogContent: $("#accountDialogContent"),
  toast: $("#toast"), settingsSaved: $("#settingsSaved"), installDialog: $("#installDialog")
};

function loadJSON(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    return parsed ?? structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function modeDurationSec(mode) {
  if (mode === "focus") return settings.focusMinutes * 60;
  if (mode === "shortBreak") return settings.shortBreakMinutes * 60;
  return settings.longBreakMinutes * 60;
}
function makeTimerState(mode = "focus") {
  const duration = modeDurationSec(mode);
  return { mode, status: "idle", totalSec: duration, remainingSec: duration, endAt: null, startedAt: null, cycleCount: 0, questionCount: 0 };
}
function makeQuestionState(seconds = 120) {
  return { status: "idle", totalSec: seconds, remainingSec: seconds, endAt: null, hasStarted: false, timeUp: false };
}
function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
function dateKey(value = Date.now()) {
  const d = new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function uuid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function currentRemaining(state) {
  if (state.status !== "running" || !state.endAt) return state.remainingSec;
  return Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
}
function elapsedSeconds() {
  return Math.max(0, timerState.totalSec - currentRemaining(timerState));
}

function normalizeLoadedState() {
  settings = { ...DEFAULT_SETTINGS, ...settings };
  sessions = Array.isArray(sessions) ? sessions.filter((s) => s && s.id) : [];
  timerState = { ...makeTimerState("focus"), ...timerState };
  questionState = { ...makeQuestionState(settings.questionSeconds), ...questionState };

  if (!["focus", "shortBreak", "longBreak"].includes(timerState.mode)) timerState.mode = "focus";
  if (!["idle", "running", "paused"].includes(timerState.status)) timerState.status = "idle";
  if (!["idle", "running", "paused"].includes(questionState.status)) questionState.status = "idle";

  if (timerState.status === "running" && currentRemaining(timerState) <= 0) {
    completeMainTimer(true);
  }
  if (questionState.status === "running" && currentRemaining(questionState) <= 0) {
    questionTimeUp(true);
  }
}

function persistTimer() { saveJSON(KEYS.timer, timerState); }
function persistQuestion() { saveJSON(KEYS.question, questionState); }
function persistSessions() { saveJSON(KEYS.sessions, sessions); }
function persistSettings({ cloudSave = true } = {}) {
  settings.updatedAt = Date.now();
  saveJSON(KEYS.settings, settings);
  flashSaved();
  if (cloudSave && cloudUser && !suppressCloudSettings) cloud?.saveSettings(settings).catch(handleCloudError);
}

function setMode(mode, { preserveCycle = true } = {}) {
  const cycleCount = preserveCycle ? timerState.cycleCount : 0;
  timerState = makeTimerState(mode);
  timerState.cycleCount = cycleCount;
  questionState = makeQuestionState(settings.questionSeconds);
  persistTimer(); persistQuestion(); renderAll();
}

async function startOrPauseMain() {
  if (timerState.status === "running") {
    timerState.remainingSec = currentRemaining(timerState);
    timerState.status = "paused";
    timerState.endAt = null;
    pauseQuestionForMain();
    await releaseWakeLock();
  } else {
    if (timerState.status === "idle") {
      timerState.totalSec = modeDurationSec(timerState.mode);
      timerState.remainingSec = timerState.totalSec;
      timerState.startedAt = Date.now();
      timerState.questionCount = 0;
    }
    timerState.status = "running";
    timerState.endAt = Date.now() + timerState.remainingSec * 1000;
    if (settings.wakeLockEnabled) await requestWakeLock();
  }
  persistTimer();
  renderTimer();
}

function pauseQuestionForMain() {
  if (questionState.status === "running") {
    questionState.remainingSec = currentRemaining(questionState);
    questionState.status = "paused";
    questionState.endAt = null;
    persistQuestion();
  }
}

function resetMainTimer() {
  if (timerState.status === "running" && !confirm("現在のタイマーをリセットしますか？")) return;
  const cycleCount = timerState.cycleCount;
  timerState = makeTimerState(timerState.mode);
  timerState.cycleCount = cycleCount;
  questionState = makeQuestionState(settings.questionSeconds);
  releaseWakeLock();
  persistTimer(); persistQuestion(); renderAll();
}

function skipMainTimer() {
  const elapsed = elapsedSeconds();
  if (timerState.mode === "focus" && elapsed >= 60) {
    const savePartial = confirm(`${Math.max(1, Math.floor(elapsed / 60))}分の集中を途中記録として保存しますか？`);
    if (savePartial) recordFocusSession(elapsed, false);
    const cycleCount = timerState.cycleCount;
    timerState = makeTimerState("focus");
    timerState.cycleCount = cycleCount;
  } else if (timerState.mode !== "focus") {
    setMode("focus");
    return;
  } else {
    const cycleCount = timerState.cycleCount;
    timerState = makeTimerState("focus");
    timerState.cycleCount = cycleCount;
  }
  questionState = makeQuestionState(settings.questionSeconds);
  releaseWakeLock();
  persistTimer(); persistQuestion(); renderAll();
}

async function completeMainTimer(silent = false) {
  const completedMode = timerState.mode;
  const completedAt = timerState.endAt || Date.now();
  if (completedMode === "focus") recordFocusSession(timerState.totalSec, true, completedAt);

  if (!silent) notify(completedMode === "focus" ? "集中、おつかれさまでした" : "休憩が終わりました");
  await releaseWakeLock();

  if (completedMode === "focus") {
    const nextCount = timerState.cycleCount + 1;
    const longBreak = nextCount >= settings.sessionsBeforeLongBreak;
    timerState = makeTimerState(longBreak ? "longBreak" : "shortBreak");
    timerState.cycleCount = longBreak ? 0 : nextCount;
    questionState = makeQuestionState(settings.questionSeconds);
    if (settings.autoStartBreak) setTimeout(() => startOrPauseMain(), 500);
  } else {
    const cycleCount = timerState.cycleCount;
    timerState = makeTimerState("focus");
    timerState.cycleCount = cycleCount;
    if (settings.autoStartFocus) setTimeout(() => startOrPauseMain(), 500);
  }
  persistTimer(); persistQuestion(); renderAll();
}

function recordFocusSession(durationSec, completed, endedAt = Date.now()) {
  const session = {
    id: uuid(),
    type: "focus",
    startedAt: timerState.startedAt || endedAt - durationSec * 1000,
    endedAt,
    dateKey: dateKey(endedAt),
    durationSec: Math.max(1, Math.round(durationSec)),
    questions: timerState.questionCount || 0,
    completed,
    createdAt: Date.now()
  };
  mergeSessions([session]);
  cloud?.saveSession(session).catch(handleCloudError);
}

function mergeSessions(incoming) {
  const map = new Map(sessions.map((s) => [s.id, s]));
  incoming.forEach((s) => { if (s?.id) map.set(s.id, { ...map.get(s.id), ...s }); });
  sessions = [...map.values()].sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 2000);
  persistSessions();
  renderStats();
}

function startPauseQuestion() {
  if (timerState.mode !== "focus") return showToast("問題タイマーは集中時間中に使えます");
  if (questionState.timeUp) resetQuestion(false);

  if (questionState.status === "running") {
    questionState.remainingSec = currentRemaining(questionState);
    questionState.status = "paused";
    questionState.endAt = null;
  } else {
    questionState.status = "running";
    questionState.endAt = Date.now() + questionState.remainingSec * 1000;
    questionState.hasStarted = true;
  }
  persistQuestion(); renderQuestion();
}

function nextQuestion() {
  if (timerState.mode !== "focus") return showToast("集中モードで利用できます");
  if (questionState.hasStarted || questionState.timeUp) timerState.questionCount += 1;
  questionState = makeQuestionState(questionState.totalSec || settings.questionSeconds);
  questionState.status = "running";
  questionState.hasStarted = true;
  questionState.endAt = Date.now() + questionState.totalSec * 1000;
  persistTimer(); persistQuestion(); renderQuestion(); renderTodaySummary();
}

function resetQuestion(keepDuration = true) {
  const duration = keepDuration ? questionState.totalSec : settings.questionSeconds;
  questionState = makeQuestionState(duration);
  persistQuestion(); renderQuestion();
}

function adjustQuestionDuration(delta) {
  if (questionState.status === "running") return showToast("一度停止してから時間を変更してください");
  const duration = clamp((questionState.totalSec || settings.questionSeconds) + delta, 10, 1800);
  questionState.totalSec = duration;
  questionState.remainingSec = duration;
  questionState.timeUp = false;
  persistQuestion(); renderQuestion();
}

function questionTimeUp(silent = false) {
  questionState.status = "idle";
  questionState.remainingSec = 0;
  questionState.endAt = null;
  questionState.timeUp = true;
  persistQuestion(); renderQuestion();
  if (!silent) notify("1問の目標時間になりました", true);
}

function tick() {
  if (timerState.status === "running") {
    timerState.remainingSec = currentRemaining(timerState);
    if (timerState.remainingSec <= 0) completeMainTimer();
  }
  if (questionState.status === "running") {
    questionState.remainingSec = currentRemaining(questionState);
    if (questionState.remainingSec <= 0) questionTimeUp();
  }
  renderTimer(); renderQuestion();
}

function renderAll() {
  renderTimer(); renderQuestion(); renderTodaySummary(); renderStats(); renderSettings(); renderCloudUI();
}

function renderTimer() {
  const meta = MODE_META[timerState.mode];
  const remaining = currentRemaining(timerState);
  const progress = timerState.totalSec ? (1 - remaining / timerState.totalSec) * 360 : 0;
  elements.timerRing.style.setProperty("--progress", `${clamp(progress, 0, 360)}deg`);
  elements.mainTime.textContent = formatTime(remaining);
  elements.modeBadge.textContent = meta.badge;
  elements.modeLabel.textContent = meta.label;
  elements.cycleLabel.textContent = `${Math.min(timerState.cycleCount + 1, settings.sessionsBeforeLongBreak)} / ${settings.sessionsBeforeLongBreak} セット`;

  if (timerState.status === "running") {
    elements.startButtonText.textContent = "一時停止";
    elements.startIcon.innerHTML = '<path d="M8 5h3v14H8zM13 5h3v14h-3z"/>';
    elements.timerHint.textContent = timerState.mode === "focus" ? "今やることだけに意識を向ける" : "呼吸を整えて、少し離れる";
  } else if (timerState.status === "paused") {
    elements.startButtonText.textContent = "再開";
    elements.startIcon.innerHTML = '<path d="m8 5 11 7-11 7z"/>';
    elements.timerHint.textContent = "一時停止中";
  } else {
    elements.startButtonText.textContent = "スタート";
    elements.startIcon.innerHTML = '<path d="m8 5 11 7-11 7z"/>';
    elements.timerHint.textContent = timerState.mode === "focus" ? "準備ができたらスタート" : "休憩を始めましょう";
  }
  document.title = timerState.status === "running" ? `${formatTime(remaining)} · ${meta.badge}` : "Focus Glass";
}

function renderQuestion() {
  const remaining = currentRemaining(questionState);
  elements.questionTime.textContent = questionState.timeUp ? "00:00" : formatTime(remaining);
  elements.questionDurationLabel.textContent = formatCompactDuration(questionState.totalSec);
  elements.questionCountBadge.textContent = `${timerState.questionCount || 0}問`;
  elements.questionCard.classList.toggle("time-up", questionState.timeUp);
  elements.questionStartButton.disabled = timerState.mode !== "focus";
  elements.nextQuestionButton.disabled = timerState.mode !== "focus";

  if (questionState.timeUp) {
    elements.questionState.textContent = "目標時間です。区切りをつけて次へ";
    elements.questionStartButton.textContent = "やり直す";
  } else if (questionState.status === "running") {
    elements.questionState.textContent = "この問題に集中";
    elements.questionStartButton.textContent = "一時停止";
  } else if (questionState.status === "paused") {
    elements.questionState.textContent = "問題タイマー停止中";
    elements.questionStartButton.textContent = "再開";
  } else {
    elements.questionState.textContent = "集中タイマーとは独立して動きます";
    elements.questionStartButton.textContent = "開始";
  }
}

function formatCompactDuration(seconds) {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds % 60 === 0) return `${seconds / 60}分`;
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

function sessionsForDate(key) { return sessions.filter((s) => s.type === "focus" && s.dateKey === key); }
function totalSeconds(list) { return list.reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0); }
function renderTodaySummary() {
  const today = sessionsForDate(dateKey());
  const activeMinutes = timerState.mode === "focus" && timerState.status !== "idle" ? Math.floor(elapsedSeconds() / 60) : 0;
  elements.todayMinutes.textContent = Math.floor(totalSeconds(today) / 60) + activeMinutes;
  elements.todaySessions.textContent = today.length;
  elements.todayQuestions.textContent = today.reduce((sum, s) => sum + (Number(s.questions) || 0), 0) + (timerState.questionCount || 0);
  elements.todayDate.textContent = new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", weekday: "short" }).format(new Date());
}

function renderStats() {
  const todayKey = dateKey();
  const today = sessionsForDate(todayKey);
  const todayMins = Math.round(totalSeconds(today) / 60);
  elements.statToday.textContent = `${todayMins}分`;
  elements.statTodaySub.textContent = `${today.length}セッション`;

  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
  const weekSeconds = sessions.filter((s) => new Date(s.endedAt) >= monday).reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0);
  elements.statWeek.textContent = `${Math.round(weekSeconds / 60)}分`;
  elements.statStreak.textContent = `${calculateStreak()}日`;
  renderHistoryChart(); renderSessionList(); renderTodaySummary();
}

function calculateStreak() {
  const focusedDates = new Set(sessions.filter((s) => (s.durationSec || 0) >= 60).map((s) => s.dateKey));
  let cursor = new Date();
  if (!focusedDates.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (focusedDates.has(dateKey(cursor))) { streak += 1; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}

function renderHistoryChart() {
  const days = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dateKey(d);
    const minutes = Math.round(totalSeconds(sessionsForDate(key)) / 60);
    days.push({ d, key, minutes });
  }
  const max = Math.max(25, ...days.map((d) => d.minutes));
  elements.historyChart.innerHTML = days.map(({ d, minutes }) => {
    const height = minutes === 0 ? 2 : Math.max(7, (minutes / max) * 100);
    const label = d.getDate();
    const weekday = new Intl.DateTimeFormat("ja-JP", { weekday: "short" }).format(d).replace("曜日", "");
    return `<div class="chart-column" title="${d.getMonth()+1}/${d.getDate()}: ${minutes}分"><div class="bar-wrap"><div class="bar" style="height:${height}%"><span class="bar-value">${minutes || ""}</span></div></div><span class="chart-label">${label}<br>${weekday}</span></div>`;
  }).join("");
}

function renderSessionList() {
  if (!sessions.length) {
    elements.sessionList.innerHTML = '<div class="empty-state">最初の集中セッションを終えると、ここに記録されます。</div>';
    return;
  }
  elements.sessionList.innerHTML = sessions.slice(0, 30).map((s) => {
    const date = new Date(s.endedAt);
    const dayText = new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", weekday: "short" }).format(date);
    const timeText = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(date);
    const mins = Math.max(1, Math.round((s.durationSec || 0) / 60));
    return `<article class="session-item"><div class="session-icon">${s.completed === false ? "途中" : "集中"}</div><div class="session-meta"><strong>${dayText} ${timeText}</strong><small>${s.questions || 0}問 · ${s.completed === false ? "途中記録" : "完了"}</small></div><div class="session-duration"><strong>${mins}分</strong><small>focus</small></div></article>`;
  }).join("");
}

function bindSettings() {
  const numberSettings = [
    ["focusMinutes", 1, 180], ["shortBreakMinutes", 1, 60], ["longBreakMinutes", 1, 120], ["sessionsBeforeLongBreak", 2, 12], ["questionSeconds", 10, 1800]
  ];
  numberSettings.forEach(([id, min, max]) => {
    const input = $(`#${id}`);
    input.addEventListener("change", () => {
      settings[id] = clamp(Number(input.value) || DEFAULT_SETTINGS[id], min, max);
      input.value = settings[id];
      persistSettings();
      if (timerState.status === "idle") {
        timerState.totalSec = modeDurationSec(timerState.mode);
        timerState.remainingSec = timerState.totalSec;
        if (id === "sessionsBeforeLongBreak") timerState.cycleCount = Math.min(timerState.cycleCount, settings.sessionsBeforeLongBreak - 1);
        persistTimer();
      }
      if (id === "questionSeconds" && questionState.status === "idle") {
        questionState = makeQuestionState(settings.questionSeconds);
        persistQuestion();
      }
      renderAll();
    });
  });

  ["autoStartBreak", "autoStartFocus", "soundEnabled", "vibrationEnabled", "wakeLockEnabled"].forEach((id) => {
    $(`#${id}`).addEventListener("change", (event) => {
      settings[id] = event.target.checked;
      persistSettings();
      if (id === "wakeLockEnabled" && !settings.wakeLockEnabled) releaseWakeLock();
    });
  });
}

function renderSettings() {
  ["focusMinutes", "shortBreakMinutes", "longBreakMinutes", "sessionsBeforeLongBreak", "questionSeconds"].forEach((id) => { $(`#${id}`).value = settings[id]; });
  ["autoStartBreak", "autoStartFocus", "soundEnabled", "vibrationEnabled", "wakeLockEnabled"].forEach((id) => { $(`#${id}`).checked = Boolean(settings[id]); });
}

function flashSaved() {
  elements.settingsSaved.classList.remove("flash");
  void elements.settingsSaved.offsetWidth;
  elements.settingsSaved.classList.add("flash");
}

function showToast(message) {
  clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimeout = setTimeout(() => elements.toast.classList.remove("show"), 2500);
}

function notify(message, question = false) {
  showToast(message);
  if (settings.soundEnabled) playTone(question ? 650 : 520);
  if (settings.vibrationEnabled && navigator.vibrate) navigator.vibrate(question ? [120, 80, 120] : [160, 90, 220]);
}

function playTone(frequency = 520) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.82, ctx.currentTime + 0.7);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.85);
    oscillator.connect(gain); gain.connect(ctx.destination);
    oscillator.start(); oscillator.stop(ctx.currentTime + 0.9);
    oscillator.addEventListener("ended", () => ctx.close());
  } catch { /* 音声非対応時は何もしない */ }
}

async function requestWakeLock() {
  if (!settings.wakeLockEnabled || !("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { wakeLock = null; }
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch { /* noop */ }
  wakeLock = null;
}

function switchView(viewId) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === viewId));
  $$(".nav-item").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === viewId));
  if (viewId === "historyView") renderStats();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderCloudUI() {
  const configured = isCloudConfigured();
  elements.cloudButton.classList.toggle("online", Boolean(cloudUser));
  elements.cloudButton.classList.toggle("syncing", configured && !cloud);

  if (cloudUser) {
    elements.cloudStatusText.textContent = "同期中";
    elements.settingsCloudBadge.textContent = "同期中";
    elements.cloudDescription.textContent = `${cloudUser.email} で同期しています。履歴と設定はログインした端末間で共有されます。`;
    elements.accountButton.textContent = "アカウントを管理";
  } else if (configured) {
    elements.cloudStatusText.textContent = "ログイン前";
    elements.settingsCloudBadge.textContent = "利用可能";
    elements.cloudDescription.textContent = "メールアドレスでログインすると、iPhone・iPad・PCで履歴と設定を同期できます。";
    elements.accountButton.textContent = "ログインして同期";
  } else {
    elements.cloudStatusText.textContent = "端末保存";
    elements.settingsCloudBadge.textContent = "未設定";
    elements.cloudDescription.textContent = "Firebaseを設定すると、iPhone・iPad・PCで同じ履歴と設定を確認できます。設定前は、この端末内に保存されます。";
    elements.accountButton.textContent = "同期を設定";
  }
}

function openAccountDialog() {
  if (!isCloudConfigured()) {
    elements.accountDialogContent.innerHTML = `
      <p class="eyebrow">SYNC SETUP</p><h2>Firebaseを設定</h2>
      <p class="modal-note">無料のFirebaseプロジェクトを作成し、<strong>firebase-config.js</strong> にWebアプリ設定を貼り付けると同期が有効になります。詳しい手順は同梱のREADMEにあります。</p>
      <div class="code-box">window.FOCUS_GLASS_FIREBASE_CONFIG = {<br>&nbsp;&nbsp;apiKey: "...",<br>&nbsp;&nbsp;authDomain: "...",<br>&nbsp;&nbsp;projectId: "...",<br>&nbsp;&nbsp;appId: "..."<br>};</div>
      <button class="soft-button full" data-close-dialog="accountDialog" type="button">確認</button>`;
  } else if (cloudUser) {
    elements.accountDialogContent.innerHTML = `
      <p class="eyebrow">ACCOUNT</p><h2>同期アカウント</h2>
      <p class="modal-note">このアカウントに履歴と設定を同期しています。</p>
      <div class="account-email">${escapeHTML(cloudUser.email || "ログイン中")}</div>
      <button id="dialogSignOut" class="soft-button full" type="button">ログアウト</button>`;
    $("#dialogSignOut").addEventListener("click", async () => {
      await cloud.signOut(); elements.accountDialog.close(); showToast("ログアウトしました");
    });
  } else {
    elements.accountDialogContent.innerHTML = `
      <p class="eyebrow">CLOUD SYNC</p><h2>ログインして同期</h2>
      <p class="modal-note">同じメールアドレスでログインした端末間で、集中記録と設定を共有します。</p>
      <form id="authForm" class="auth-form">
        <label>メールアドレス<input id="authEmail" type="email" autocomplete="email" required placeholder="name@example.com"></label>
        <label>パスワード<input id="authPassword" type="password" minlength="6" autocomplete="current-password" required placeholder="6文字以上"></label>
        <p id="authError" class="auth-error"></p>
        <div class="auth-actions"><button id="registerButton" class="soft-button" type="button">新規登録</button><button class="soft-button emphasized" type="submit">ログイン</button></div>
      </form>`;
    const form = $("#authForm");
    const runAuth = async (mode) => {
      const email = $("#authEmail").value.trim();
      const password = $("#authPassword").value;
      const errorEl = $("#authError");
      if (!email || password.length < 6) { errorEl.textContent = "メールアドレスと6文字以上のパスワードを入力してください。"; return; }
      errorEl.textContent = "接続中…";
      try {
        if (mode === "register") await cloud.register(email, password); else await cloud.signIn(email, password);
        elements.accountDialog.close();
        showToast(mode === "register" ? "アカウントを作成しました" : "ログインしました");
      } catch (error) { errorEl.textContent = authErrorMessage(error); }
    };
    form.addEventListener("submit", (e) => { e.preventDefault(); runAuth("signIn"); });
    $("#registerButton").addEventListener("click", () => runAuth("register"));
  }
  elements.accountDialog.showModal();
}

function authErrorMessage(error) {
  const code = error?.code || "";
  const map = {
    "auth/invalid-credential": "メールアドレスまたはパスワードが違います。",
    "auth/email-already-in-use": "このメールアドレスは登録済みです。",
    "auth/invalid-email": "メールアドレスの形式を確認してください。",
    "auth/weak-password": "より長いパスワードを設定してください。",
    "auth/too-many-requests": "試行回数が多いため、少し時間を空けてください。"
  };
  return map[code] || "接続できませんでした。設定と通信環境を確認してください。";
}
function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));
}
function handleCloudError(error) {
  console.error(error);
  showToast("同期に失敗しました。端末には保存されています");
}

async function initializeCloud() {
  if (!isCloudConfigured()) { renderCloudUI(); return; }
  try {
    cloud = await createCloudSync({
      onStatus: () => renderCloudUI(),
      onAuth: (user) => {
        cloudUser = user;
        renderCloudUI();
        if (user) {
          window.setTimeout(async () => {
            if (!cloud) return;
            try {
              const result = await cloud.initialSync(sessions, settings);
              if (result.sessions?.length) mergeSessions(result.sessions);
              if (result.settings) applyCloudSettings(result.settings);
              showToast("クラウドと同期しました");
            } catch (error) { handleCloudError(error); }
          }, 0);
        }
      },
      onSessions: (cloudSessions) => mergeSessions(cloudSessions),
      onSettings: (cloudSettings) => {
        if ((cloudSettings.updatedAt || 0) > (settings.updatedAt || 0)) applyCloudSettings(cloudSettings);
      },
      onError: handleCloudError
    });
  } catch (error) {
    console.error(error);
    cloud = null;
    showToast("Firebaseへの接続に失敗しました");
  }
  renderCloudUI();
}

function applyCloudSettings(incoming) {
  suppressCloudSettings = true;
  settings = { ...settings, ...incoming };
  saveJSON(KEYS.settings, settings);
  suppressCloudSettings = false;
  if (timerState.status === "idle") {
    timerState.totalSec = modeDurationSec(timerState.mode);
    timerState.remainingSec = timerState.totalSec;
    persistTimer();
  }
  renderAll();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker:", error));
  }
}

function bindEvents() {
  elements.startButton.addEventListener("click", startOrPauseMain);
  elements.resetButton.addEventListener("click", resetMainTimer);
  elements.skipButton.addEventListener("click", skipMainTimer);
  elements.questionStartButton.addEventListener("click", startPauseQuestion);
  elements.nextQuestionButton.addEventListener("click", nextQuestion);
  elements.questionMinus.addEventListener("click", () => adjustQuestionDuration(-30));
  elements.questionPlus.addEventListener("click", () => adjustQuestionDuration(30));
  $$(".nav-item").forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
  $("#refreshHistoryButton").addEventListener("click", () => { renderStats(); showToast("記録を更新しました"); });
  $("#clearHistoryButton").addEventListener("click", () => {
    if (!sessions.length || !confirm("この端末に保存された履歴を削除しますか？\nクラウド上の履歴は削除されません。")) return;
    sessions = []; persistSessions(); renderStats(); showToast("端末履歴を削除しました");
  });
  elements.cloudButton.addEventListener("click", openAccountDialog);
  elements.accountButton.addEventListener("click", openAccountDialog);
  $("#installButton").addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
    } else elements.installDialog.showModal();
  });
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      tick();
      if (timerState.status === "running" && settings.wakeLockEnabled) requestWakeLock();
    }
  });
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstallPrompt = event; });
  window.addEventListener("pagehide", () => { persistTimer(); persistQuestion(); });
}

normalizeLoadedState();
bindEvents();
bindSettings();
renderAll();
intervalId = window.setInterval(tick, 250);
registerServiceWorker();
initializeCloud();
