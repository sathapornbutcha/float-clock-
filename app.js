/* ============================================================
   Float Clock — นาฬิกาเรียลไทม์ + ลอยจอ (Document PiP) + ตัวเตือนนับเวลา
   Vanilla JS, ไม่มี dependency. เก็บ setting ใน localStorage.
   ============================================================ */
'use strict';

const LS_KEY = 'float-clock-settings';

// ---- state ----
const state = {
  format24: true,
  showSeconds: true,
  showDate: true,
  minutes: 25,
  seconds: 0,
  reminders: { sound: true, flash: true, notify: false, repeat: false },
  timer: { running: false, endTime: 0, remainingMs: 0, totalMs: 0 },
};

let pipWindow = null;            // หน้าต่าง PiP (ถ้าเปิดอยู่)
let audioCtx = null;

// pip-content คือ DOM ก้อนเดียวที่ย้ายไป-มา ระหว่างหน้าหลักกับ PiP
const host = document.getElementById('pip-host');
const pipContent = document.getElementById('pip-content');

// query ภายใน pipContent เสมอ → ใช้ได้ทั้งตอนอยู่หน้าหลักและตอนอยู่ใน PiP
const q = (sel) => pipContent.querySelector(sel);

// ---- โหลด/บันทึก setting ----
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (saved.format24 !== undefined) state.format24 = saved.format24;
    if (saved.showSeconds !== undefined) state.showSeconds = saved.showSeconds;
    if (saved.showDate !== undefined) state.showDate = saved.showDate;
    if (saved.minutes !== undefined) state.minutes = saved.minutes;
    if (saved.seconds !== undefined) state.seconds = saved.seconds;
    if (saved.reminders) Object.assign(state.reminders, saved.reminders);
  } catch { /* ignore corrupt storage */ }
}
function saveSettings() {
  localStorage.setItem(LS_KEY, JSON.stringify({
    format24: state.format24,
    showSeconds: state.showSeconds,
    showDate: state.showDate,
    minutes: state.minutes,
    seconds: state.seconds,
    reminders: state.reminders,
  }));
}

// ---- format ----
const pad = (n) => String(n).padStart(2, '0');

function renderClock() {
  const now = new Date();
  let h = now.getHours();
  const m = now.getMinutes();
  const s = now.getSeconds();
  let suffix = '';
  if (!state.format24) {
    suffix = h >= 12 ? ' PM' : ' AM';
    h = h % 12 || 12;
  }
  let txt = `${pad(h)}:${pad(m)}`;
  if (state.showSeconds) txt += `:${pad(s)}`;
  q('#clock').textContent = txt + suffix;

  const dateEl = q('#date');
  if (state.showDate) {
    dateEl.hidden = false;
    dateEl.textContent = now.toLocaleDateString('th-TH', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  } else {
    dateEl.hidden = true;
  }
}

function renderTimer() {
  const chip = q('#timer-chip');
  const t = state.timer;
  if (t.totalMs <= 0) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.toggle('running', t.running);
  const rem = Math.max(0, Math.ceil(t.remainingMs / 1000));
  q('#timer-remain').textContent = `${pad(Math.floor(rem / 60))}:${pad(rem % 60)}`;
}

// ---- ลูปหลัก: อัปเดตนาฬิกา + เช็คตัวจับเวลา ทุก 250ms ----
function tick() {
  renderClock();
  const t = state.timer;
  if (t.running) {
    t.remainingMs = t.endTime - Date.now();
    if (t.remainingMs <= 0) onTimerEnd();
  }
  renderTimer();
}

// ============================================================
//  ตัวเตือน
// ============================================================
function beep(times = 4) {
  if (!state.reminders.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    let t = audioCtx.currentTime;
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = i % 2 === 0 ? 880 : 660;
      o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.start(t); o.stop(t + 0.3);
      t += 0.36;
    }
  } catch (e) { console.warn('beep failed', e); }
}

function flashScreen() {
  if (!state.reminders.flash) return;
  const targets = [document.body];
  if (pipWindow && !pipWindow.closed) targets.push(pipWindow.document.body);
  targets.forEach((b) => {
    b.classList.remove('flash');
    void b.offsetWidth;            // restart animation
    b.classList.add('flash');
    setTimeout(() => b.classList.remove('flash'), 3000);
  });
}

function notifyUser(msg) {
  if (!state.reminders.notify) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification('⏰ Float Clock', { body: msg });
  }
}

function durationLabel() {
  const parts = [];
  if (state.minutes > 0) parts.push(`${state.minutes} นาที`);
  if (state.seconds > 0) parts.push(`${state.seconds} วินาที`);
  return parts.join(' ') || '0 วินาที';
}

function fireReminders() {
  beep();
  flashScreen();
  notifyUser(`ครบ ${durationLabel()} แล้ว!`);
}

function onTimerEnd() {
  fireReminders();
  if (state.reminders.repeat) {
    // วนรอบใหม่อัตโนมัติ
    state.timer.endTime = Date.now() + state.timer.totalMs;
    state.timer.remainingMs = state.timer.totalMs;
  } else {
    stopTimer(true);
  }
}

// ---- ควบคุม timer ----
function readInputs() {
  state.minutes = clampMins(parseInt(document.getElementById('mins').value, 10) || 0);
  state.seconds = clampSecs(parseInt(document.getElementById('secs').value, 10) || 0);
  return state.minutes * 60 * 1000 + state.seconds * 1000;
}

function startTimer() {
  let totalMs = readInputs();
  if (totalMs < 1000) {           // อย่างน้อย 1 วินาที
    totalMs = 1000;
    state.seconds = Math.max(state.seconds, 1);
    document.getElementById('secs').value = state.seconds;
  }
  state.timer.totalMs = totalMs;
  state.timer.endTime = Date.now() + totalMs;
  state.timer.remainingMs = totalMs;
  state.timer.running = true;
  saveSettings();
  syncTimerButtons();
  renderTimer();
}

function pauseTimer() {
  const t = state.timer;
  if (t.running) {
    t.remainingMs = t.endTime - Date.now();
    t.running = false;
  } else if (t.totalMs > 0 && t.remainingMs > 0) {
    t.endTime = Date.now() + t.remainingMs;
    t.running = true;
  }
  syncTimerButtons();
}

function stopTimer(keepCount = false) {
  state.timer.running = false;
  if (!keepCount) {
    state.timer.totalMs = 0;
    state.timer.remainingMs = 0;
  }
  syncTimerButtons();
  renderTimer();
}

function clampMins(v) {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 600) return 600;
  return v;
}

function clampSecs(v) {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 59) return 59;
  return v;
}

function syncTimerButtons() {
  const t = state.timer;
  const pauseBtn = document.getElementById('pause-btn');
  pauseBtn.disabled = t.totalMs <= 0 || t.remainingMs <= 0;
  pauseBtn.textContent = t.running ? 'หยุดชั่วคราว' : 'เล่นต่อ';
}

// ============================================================
//  Document Picture-in-Picture (หน้าต่างลอย)
// ============================================================
function copyStyles(target) {
  for (const sheet of document.styleSheets) {
    try {
      const cssText = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      const styleEl = document.createElement('style');
      styleEl.textContent = cssText;
      target.head.appendChild(styleEl);
    } catch {
      // cross-origin (เช่น Google Fonts) → link ผ่าน href แทน
      if (sheet.href) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
}

async function popOut() {
  if (!('documentPictureInPicture' in window)) {
    alert('เบราว์เซอร์นี้ยังไม่รองรับ Picture-in-Picture แบบเอกสาร\nกรุณาใช้ Chrome หรือ Edge เวอร์ชันใหม่ (เปิดผ่าน http://localhost หรือ https)');
    return;
  }
  if (pipWindow && !pipWindow.closed) { pipWindow.focus(); return; }

  pipWindow = await window.documentPictureInPicture.requestWindow({
    width: 280, height: 160,
  });

  copyStyles(pipWindow.document);
  pipWindow.document.body.classList.add('pip-body');
  pipWindow.document.body.appendChild(pipContent);  // ย้ายก้อนนาฬิกาเข้า PiP

  document.getElementById('pip-note').hidden = false;
  host.style.display = 'none';

  pipWindow.addEventListener('pagehide', () => {
    host.appendChild(pipContent);     // ย้ายกลับหน้าหลัก
    host.style.display = '';
    document.getElementById('pip-note').hidden = true;
    pipWindow = null;
  });
}

// ============================================================
//  Wire up UI
// ============================================================
function bindCheckbox(id, getter, setter) {
  const el = document.getElementById(id);
  el.checked = getter();
  el.addEventListener('change', () => { setter(el.checked); saveSettings(); });
}

function initUI() {
  // นาฬิกา
  bindCheckbox('opt-24', () => state.format24, (v) => state.format24 = v);
  bindCheckbox('opt-sec', () => state.showSeconds, (v) => state.showSeconds = v);
  bindCheckbox('opt-date', () => state.showDate, (v) => state.showDate = v);

  // ตัวเตือน
  bindCheckbox('opt-sound', () => state.reminders.sound, (v) => state.reminders.sound = v);
  bindCheckbox('opt-flash', () => state.reminders.flash, (v) => state.reminders.flash = v);
  bindCheckbox('opt-repeat', () => state.reminders.repeat, (v) => state.reminders.repeat = v);
  bindCheckbox('opt-notify', () => state.reminders.notify, (v) => {
    state.reminders.notify = v;
    if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  });

  // นาที + วินาที + presets
  const minsInput = document.getElementById('mins');
  const secsInput = document.getElementById('secs');
  minsInput.value = state.minutes;
  secsInput.value = state.seconds;
  const presetBtns = [...document.querySelectorAll('.preset')];
  const highlightPreset = () => {
    presetBtns.forEach((b) =>
      b.classList.toggle('active', +b.dataset.min === +minsInput.value && +b.dataset.sec === +secsInput.value));
  };
  highlightPreset();
  presetBtns.forEach((b) => b.addEventListener('click', () => {
    minsInput.value = b.dataset.min;
    secsInput.value = b.dataset.sec;
    state.minutes = +b.dataset.min;
    state.seconds = +b.dataset.sec;
    saveSettings();
    highlightPreset();
  }));
  minsInput.addEventListener('input', () => { state.minutes = clampMins(+minsInput.value); highlightPreset(); });
  secsInput.addEventListener('input', () => { state.seconds = clampSecs(+secsInput.value); highlightPreset(); });

  // ปุ่ม timer
  document.getElementById('start-btn').addEventListener('click', startTimer);
  document.getElementById('pause-btn').addEventListener('click', pauseTimer);
  document.getElementById('reset-btn').addEventListener('click', () => stopTimer(false));

  // PiP
  document.getElementById('pop-btn').addEventListener('click', popOut);

  syncTimerButtons();
}

// ---- boot ----
loadSettings();
initUI();
tick();
setInterval(tick, 250);
