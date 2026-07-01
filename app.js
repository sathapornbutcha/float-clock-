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

let pipWindow = null;            // หน้าต่าง Document-PiP (คอม Chrome/Edge)
let audioCtx = null;

// video-PiP fallback (มือถือ/iPad): วาดนาฬิกาลง canvas → stream → native video PiP
let pipVideo = null, pipCanvas = null, pipDrawTimer = null, pipStream = null;
let pipFlashOn = false;          // ธงกระพริบสำหรับโหมด canvas

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

// ---- format (helper ใช้ร่วมทั้ง DOM และ canvas-PiP) ----
const pad = (n) => String(n).padStart(2, '0');

function getTimeStr() {
  const now = new Date();
  let h = now.getHours();
  let suffix = '';
  if (!state.format24) {
    suffix = h >= 12 ? ' PM' : ' AM';
    h = h % 12 || 12;
  }
  let txt = `${pad(h)}:${pad(now.getMinutes())}`;
  if (state.showSeconds) txt += `:${pad(now.getSeconds())}`;
  return txt + suffix;
}

function getDateStr() {
  if (!state.showDate) return '';
  return new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });
}

function getTimerStr() {
  const t = state.timer;
  if (t.totalMs <= 0) return '';
  const rem = Math.max(0, Math.ceil(t.remainingMs / 1000));
  return `${pad(Math.floor(rem / 60))}:${pad(rem % 60)}`;
}

function renderClock() {
  q('#clock').textContent = getTimeStr();
  const dateEl = q('#date');
  const d = getDateStr();
  dateEl.hidden = !d;
  if (d) dateEl.textContent = d;
}

function renderTimer() {
  const chip = q('#timer-chip');
  const t = state.timer;
  if (t.totalMs <= 0) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.toggle('running', t.running);
  q('#timer-remain').textContent = getTimerStr();
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
  // โหมด video-PiP (มือถือ/iPad): กระพริบบน canvas
  pipFlashOn = true;
  setTimeout(() => { pipFlashOn = false; }, 3000);
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
  const idle = t.totalMs <= 0 || t.remainingMs <= 0;

  const pauseBtn = document.getElementById('pause-btn');
  pauseBtn.disabled = idle;
  pauseBtn.textContent = t.running ? 'หยุดชั่วคราว' : 'เล่นต่อ';

  // ปุ่มควบคุมในหน้าต่างลอย (PiP)
  const pipPause = q('#pip-pause');
  if (pipPause) {
    pipPause.disabled = idle;
    pipPause.textContent = t.running ? '⏸' : '▶';
    pipPause.title = t.running ? 'หยุด' : 'เล่นต่อ';
  }
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

// ปุ่ม "ลอยจอ" — เลือกวิธีตามความสามารถของเบราว์เซอร์
async function popOut() {
  // 1) คอม Chrome/Edge → Document PiP (การ์ดเต็ม)
  if ('documentPictureInPicture' in window) return popOutDocument();
  // 2) มือถือ/iPad/Android → Video PiP (วาด canvas เป็นวิดีโอลอย)
  if (canUseVideoPip()) return popOutVideo();
  // 3) ไม่รองรับเลย → แนะนำทางเลือก
  alert(
    'เบราว์เซอร์นี้ลอยจอแบบลอยทับแอปอื่นไม่ได้\n\n' +
    '• iPhone/iPad: เปิดด้วย Safari แล้วลองใหม่ (ใช้ Video PiP) หรือ\n' +
    '  iPad: ใช้ Split View/Slide Over วางหน้านี้คู่กับแอปอื่น\n' +
    '• คอม: ใช้ Chrome หรือ Edge เวอร์ชันใหม่\n' +
    '• เพิ่มลงหน้าโฮม (Add to Home Screen) เพื่อใช้เป็นแอปเต็มจอ'
  );
}

// ---------- (1) Document PiP : คอม ----------
async function popOutDocument() {
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

// ---------- (2) Video PiP : มือถือ/iPad ----------
function canUseVideoPip() {
  const v = document.createElement('video');
  return !!(
    ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) ||
    typeof v.webkitSetPresentationMode === 'function'  // iOS Safari
  );
}

function buildPipVideo() {
  pipCanvas = document.createElement('canvas');
  pipCanvas.width = 640;
  pipCanvas.height = 360;

  pipVideo = document.createElement('video');
  pipVideo.muted = true;
  pipVideo.defaultMuted = true;
  pipVideo.playsInline = true;
  pipVideo.setAttribute('playsinline', '');
  pipVideo.setAttribute('autoplay', '');
  // ซ่อนนอกจอ (ต้องอยู่ใน DOM และมีขนาด ไม่งั้น iOS ไม่เล่น)
  pipVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;left:-10px;top:-10px;pointer-events:none;';
  document.body.appendChild(pipVideo);

  pipVideo.addEventListener('leavepictureinpicture', stopPipDraw);
  pipVideo.addEventListener('webkitendfullscreen', stopPipDraw);
}

function drawPipFrame() {
  const ctx = pipCanvas.getContext('2d');
  const W = pipCanvas.width, H = pipCanvas.height;
  const flash = pipFlashOn;

  // พื้นหลัง (กระพริบแดงตอนเตือน)
  ctx.fillStyle = flash ? '#F04438' : '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // เวลา
  ctx.fillStyle = flash ? '#FFFFFF' : '#111827';
  ctx.font = "700 150px Inter, 'Segoe UI', system-ui, sans-serif";
  const timerStr = getTimerStr();
  const hasSub = state.showDate || timerStr;
  ctx.fillText(getTimeStr(), W / 2, hasSub ? H / 2 - 30 : H / 2);

  // บรรทัดล่าง: วันที่ + ตัวจับเวลา
  const sub = [getDateStr(), timerStr ? '⏱ ' + timerStr : ''].filter(Boolean).join('   ');
  if (sub) {
    ctx.fillStyle = flash ? '#FFE4E1' : '#98A2B3';
    ctx.font = "500 40px Inter, 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(sub, W / 2, H / 2 + 95);
  }
}

function startPipDraw() {
  if (pipDrawTimer) return;
  drawPipFrame();
  pipDrawTimer = setInterval(drawPipFrame, 250);
}

function stopPipDraw() {
  if (pipDrawTimer) { clearInterval(pipDrawTimer); pipDrawTimer = null; }
}

async function popOutVideo() {
  if (!pipVideo) buildPipVideo();
  if (!pipStream) {
    pipStream = pipCanvas.captureStream(4);   // 4fps พอสำหรับนาฬิกา
    pipVideo.srcObject = pipStream;
  }
  startPipDraw();
  try { await pipVideo.play(); } catch { /* iOS อาจ resolve ช้า */ }

  try {
    if (pipVideo.requestPictureInPicture && document.pictureInPictureEnabled) {
      await pipVideo.requestPictureInPicture();
    } else if (typeof pipVideo.webkitSetPresentationMode === 'function') {
      pipVideo.webkitSetPresentationMode('picture-in-picture');   // iOS Safari
    } else {
      throw new Error('ไม่รองรับ video PiP');
    }
  } catch (e) {
    stopPipDraw();
    alert('เปิดโหมดลอยจอไม่สำเร็จ: ' + (e && e.message ? e.message : e) +
      '\n\nลองอีกครั้ง หรือบน iPad ใช้ Split View/Slide Over แทน');
  }
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

  // ปุ่ม timer (หน้าหลัก)
  document.getElementById('start-btn').addEventListener('click', startTimer);
  document.getElementById('pause-btn').addEventListener('click', pauseTimer);
  document.getElementById('reset-btn').addEventListener('click', () => stopTimer(false));

  // ปุ่ม timer (ในหน้าต่างลอย PiP) — ใช้ฟังก์ชันเดียวกัน
  q('#pip-start').addEventListener('click', startTimer);
  q('#pip-pause').addEventListener('click', pauseTimer);
  q('#pip-reset').addEventListener('click', () => stopTimer(false));

  // PiP
  document.getElementById('pop-btn').addEventListener('click', popOut);

  syncTimerButtons();
}

// ---- boot ----
loadSettings();
initUI();
tick();
setInterval(tick, 250);
