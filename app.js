// =============================================================================
//  HOME AUTOMATION DASHBOARD — app.js  (v2.0.0)
//  Firebase Realtime Database Web Client
//
//  Changes from v1:
//    • Real Firebase credentials hardcoded — no placeholders
//    • No authentication — Test Mode rules (open read/write)
//    • Dynamic PIR hold timer: slider writes to /Settings/PIR_Timeout_Minutes
//    • /Settings listener syncs PIR slider with current Firebase value
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE CONFIGURATION (Test Mode — No Auth Required)
//  Rules: { "rules": { ".read": true, ".write": true } }
// ─────────────────────────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:      "AIzaSyAnp0VTMBMME0WtJGHnuVLquIPeMjEfOcE",
  databaseURL: "https://myhomeauto-9122d-default-rtdb.firebaseio.com/",
  // authDomain, projectId etc. are not needed for RTDB-only access in test mode
  projectId:   "myhomeauto-9122d",
};

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const OFFLINE_THRESHOLD_SEC  = 20;       // Declare offline after this many s
const FAN_EMERGENCY_TOTAL_MS = 600_000;  // 10 min in ms (must match firmware)
const FORCE_MODE_TOTAL_MS    = 3_600_000; // 1 hr in ms

// PIR slider bounds (minutes)
const PIR_MIN_MINUTES = 1;
const PIR_MAX_MINUTES = 10;
const PIR_DEFAULT_MIN = 3;

// Firebase paths
const PATH_STATE    = '/device/state';
const PATH_COMMANDS = '/device/commands';
const PATH_PIR      = '/Settings/PIR_Timeout_Minutes';
const PATH_KILL     = '/System_Status/Master_Block';  // ← Kill switch path

// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE INIT — No signIn() call needed with Test Mode rules
// ─────────────────────────────────────────────────────────────────────────────

firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();

// ─────────────────────────────────────────────────────────────────────────────
//  GLOBAL RUNTIME STATE
// ─────────────────────────────────────────────────────────────────────────────

let state = {
  isOnline:                false,
  lastTimestamp:           0,
  voltage:                 0,
  batteryPct:              0,
  fanState:                false,
  fanLocked:               false,
  fanEmergencyActive:      false,
  fanEmergencyRemainingMs: 0,
  outsideLightState:       false,
  outsideForceMode:        0,
  outsideForceRemainingMs: 0,
  insideLightState:        false,
  ntpSynced:               false,
  currentTime:             '--:--:--',
  pirHoldMinutes:          PIR_DEFAULT_MIN,
};

let lastDataReceivedAt = null;
let uiTickInterval     = null;
let pirCommitTimer     = null;

// Kill switch runtime flag
let isKillSwitchActive = false;

// ─────────────────────────────────────────────────────────────────────────────
//  DOM CACHE
// ─────────────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const DOM = {
  // Header
  statusBadge:       $('statusBadge'),
  statusText:        $('statusText'),
  deviceClock:       $('deviceClock'),
  offlineBanner:     $('offlineBanner'),
  offlineBannerText: $('offlineBannerText'),

  // Battery
  batteryFill:        $('batteryFill'),
  batteryPctText:     $('batteryPctText'),
  batteryStatusBadge: $('batteryStatusBadge'),
  voltageVal:         $('voltageVal'),
  batteryPctVal:      $('batteryPctVal'),
  batteryHealthVal:   $('batteryHealthVal'),
  hysteresisWarning:  $('hysteresisWarning'),
  deadBatteryWarning: $('deadBatteryWarning'),

  // Fan
  fanStatePill:       $('fanStatePill'),
  fanHub:             $('fanHub'),
  fanStatusText:      $('fanStatusText'),
  btnFanToggle:       $('btnFanToggle'),
  btnFanEmergency:    $('btnFanEmergency'),
  emergencyBtnText:   $('emergencyBtnText'),
  emergencyCountdown: $('emergencyCountdown'),
  emergencyTimeLeft:  $('emergencyTimeLeft'),
  emergencyProgress:  $('emergencyProgress'),
  fanLockInfo:        $('fanLockInfo'),

  // Outside Light
  outsideLightPill:     $('outsideLightPill'),
  outsideBulb:          $('outsideBulb'),
  outsideModeLabel:     $('outsideModeLabel'),
  outsideAutoStrip:     $('outsideAutoStrip'),
  outsideForceOnStrip:  $('outsideForceOnStrip'),
  outsideForceOffStrip: $('outsideForceOffStrip'),
  forceOnTimeLeft:      $('forceOnTimeLeft'),
  forceOffTimeLeft:     $('forceOffTimeLeft'),
  forceProgressWrap:    $('forceProgressWrap'),
  forceProgress:        $('forceProgress'),

  // PIR slider
  pirSlider:       $('pirSlider'),
  pirTimerDisplay: $('pirTimerDisplay'),

  // Inside Light
  insideLightPill: $('insideLightPill'),
  insideBulb:      $('insideBulb'),
  insideBtnText:   $('insideBtnText'),

  // System
  sysConnection:  $('sysConnection'),
  sysNtp:         $('sysNtp'),
  sysDeviceTime:  $('sysDeviceTime'),
  sysLastUpdate:  $('sysLastUpdate'),
  sysPirStatus:   $('sysPirStatus'),
  sysFirebase:    $('sysFirebase'),
  sysPirTimeout:  $('sysPirTimeout'),

  // Misc
  toastContainer:    $('toastContainer'),
  cmdSpinner:        $('cmdSpinner'),
  killSwitchOverlay: $('killSwitchOverlay'),   // ← Kill switch overlay
  killTimestamp:     $('killTimestamp'),        // ← Blocked-at timestamp
};

// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE LISTENER — Device State
// ─────────────────────────────────────────────────────────────────────────────

db.ref(PATH_STATE).on('value', (snapshot) => {
  const data = snapshot.val();
  if (!data) {
    DOM.sysFirebase.textContent = 'Connected (no data yet)';
    DOM.sysFirebase.className   = 'sys-value warn';
    return;
  }

  DOM.sysFirebase.textContent = 'Connected ✓';
  DOM.sysFirebase.className   = 'sys-value good';

  // Merge received data into local state
  state.lastTimestamp           = data.timestamp            ?? state.lastTimestamp;
  state.voltage                 = data.voltage              ?? state.voltage;
  state.batteryPct              = data.batteryPct           ?? state.batteryPct;
  state.fanState                = data.fanState             ?? state.fanState;
  state.fanLocked               = data.fanLocked            ?? state.fanLocked;
  state.fanEmergencyActive      = data.fanEmergencyActive   ?? state.fanEmergencyActive;
  state.fanEmergencyRemainingMs = data.fanEmergencyRemainingMs ?? state.fanEmergencyRemainingMs;
  state.outsideLightState       = data.outsideLightState    ?? state.outsideLightState;
  state.outsideForceMode        = data.outsideForceMode     ?? state.outsideForceMode;
  state.outsideForceRemainingMs = data.outsideForceRemainingMs ?? state.outsideForceRemainingMs;
  state.insideLightState        = data.insideLightState     ?? state.insideLightState;
  state.ntpSynced               = data.ntpSynced            ?? state.ntpSynced;
  state.currentTime             = data.currentTime          ?? state.currentTime;
  // pirHoldMinutes echoed back by firmware in state so we know the device's live value
  if (data.pirHoldMinutes && data.pirHoldMinutes !== state.pirHoldMinutes) {
    state.pirHoldMinutes = data.pirHoldMinutes;
    DOM.sysPirTimeout.textContent = data.pirHoldMinutes + ' min';
  }

  lastDataReceivedAt = new Date();
  state.isOnline     = true;

  renderAll();
}, (error) => {
  console.error('[Firebase] state listener error:', error);
  DOM.sysFirebase.textContent = 'Error: ' + error.message;
  DOM.sysFirebase.className   = 'sys-value bad';
  showToast('Firebase connection error', 'error');
});

// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE LISTENER — PIR Settings
//  Keeps the slider in sync if another device or the NodeMCU changes the value.
// ─────────────────────────────────────────────────────────────────────────────

db.ref(PATH_PIR).on('value', (snapshot) => {
  const val = snapshot.val();
  if (val === null) {
    // Key doesn't exist yet — write the default
    db.ref(PATH_PIR).set(PIR_DEFAULT_MIN);
    return;
  }
  const minutes = parseInt(val, 10);
  if (minutes >= PIR_MIN_MINUTES && minutes <= PIR_MAX_MINUTES) {
    // Update slider and display without triggering another Firebase write
    DOM.pirSlider.value        = minutes;
    DOM.pirTimerDisplay.textContent = minutes + ' min';
    DOM.sysPirTimeout.textContent   = minutes + ' min';
    state.pirHoldMinutes           = minutes;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE LISTENER — Master Kill Switch
//  Watches /System_Status/Master_Block in real-time.
//  A change from the PHP server propagates here within ~1 second.
// ─────────────────────────────────────────────────────────────────────────────

db.ref(PATH_KILL).on('value', (snapshot) => {
  const blocked = snapshot.val() === true;

  if (blocked && !isKillSwitchActive) {
    activateKillSwitch();
  } else if (!blocked && isKillSwitchActive) {
    deactivateKillSwitch();
  }
}, (error) => {
  console.error('[KillSwitch] Listener error:', error);
});

// ─────────────────────────────────────────────────────────────────────────────
//  KILL SWITCH — UI ACTIVATE / DEACTIVATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when Master_Block becomes TRUE.
 * Shows the full-screen overlay, dims cards, and disables every control.
 */
function activateKillSwitch() {
  isKillSwitchActive = true;

  // Show overlay
  DOM.killSwitchOverlay.classList.remove('hidden');

  // Record the time the block was received
  const now = new Date();
  const timeStr = now.toLocaleTimeString();
  DOM.killTimestamp.textContent = `Blocked at: ${timeStr}`;

  // Apply locked-state theme to body (dims cards, changes orbs/header)
  document.body.classList.add('system-locked');

  // Disable EVERY button on the page
  document.querySelectorAll('.btn').forEach(btn => {
    btn.dataset.killedDisabled = btn.disabled ? '1' : '0'; // remember prior state
    btn.disabled = true;
  });

  // Disable PIR slider
  DOM.pirSlider.disabled = true;

  // Update header badge to show locked
  DOM.statusBadge.className  = 'status-badge status-offline';
  DOM.statusText.textContent = '🔒 Locked';

  showToast('⚠️ System blocked by external signal!', 'error', 'shield-off', 0);
  console.warn('[KillSwitch] ███ SYSTEM LOCKED ███');
}

/**
 * Called when Master_Block becomes FALSE.
 * Hides overlay, restores cards, and re-enables controls.
 */
function deactivateKillSwitch() {
  isKillSwitchActive = false;

  // Hide overlay
  DOM.killSwitchOverlay.classList.add('hidden');

  // Remove locked theme
  document.body.classList.remove('system-locked');

  // Re-enable all buttons (respecting their pre-lock disabled state)
  document.querySelectorAll('.btn').forEach(btn => {
    const wasPreviouslyDisabled = btn.dataset.killedDisabled === '1';
    btn.disabled = wasPreviouslyDisabled;
    delete btn.dataset.killedDisabled;
  });

  // Re-enable PIR slider
  DOM.pirSlider.disabled = false;

  showToast('✅ System unblocked — all controls restored', 'success', 'shield-check');
  console.info('[KillSwitch] System UNLOCKED.');

  // Re-render to restore correct BMS-based button states
  renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
//  PIR SLIDER HANDLERS
//  oninput  → visual feedback only (called from HTML)
//  onchange → commit to Firebase (called from HTML)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called on every slider drag step — updates the display label instantly.
 * @param {string|number} value
 */
function onPirSliderInput(value) {
  const minutes = parseInt(value, 10);
  DOM.pirTimerDisplay.textContent = minutes + ' min';
}

/**
 * Called when the slider is released — writes the new value to Firebase.
 * Debounced to avoid rapid-fire writes during keyboard arrow-key input.
 * @param {string|number} value
 */
function onPirSliderCommit(value) {
  const minutes = parseInt(value, 10);
  if (minutes < PIR_MIN_MINUTES || minutes > PIR_MAX_MINUTES) return;

  clearTimeout(pirCommitTimer);
  pirCommitTimer = setTimeout(async () => {
    try {
      await db.ref(PATH_PIR).set(minutes);
      console.log('[PIR] Timeout written to Firebase:', minutes, 'min');
      showToast(
        `PIR hold timer set to ${minutes} minute${minutes !== 1 ? 's' : ''}`,
        'success',
        'radio'
      );
    } catch (err) {
      console.error('[PIR] Write failed:', err);
      showToast('Failed to update PIR timer', 'error');
    }
  }, 300);  // 300 ms debounce
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEND COMMAND TO DEVICE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes a command to /device/commands.
 * NodeMCU polls this, executes, then deletes the node.
 * @param {string} cmd
 */
async function sendCommand(cmd) {
  // Hard guard — reject silently if kill switch is active
  if (isKillSwitchActive) {
    showToast('🔒 System blocked — command rejected', 'error', 'shield-off');
    return;
  }
  showSpinner(true);
  try {
    await db.ref(PATH_COMMANDS).set({
      cmd,
      ts: Math.floor(Date.now() / 1000),
    });
    console.log('[CMD] Sent:', cmd);
    showToast(`Command sent: ${cmd}`, 'success', 'send');
  } catch (err) {
    console.error('[CMD] Failed:', err);
    showToast('Failed to send command', 'error');
  } finally {
    showSpinner(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RENDER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

function renderAll() {
  renderBattery();
  renderFan();
  renderOutsideLight();
  renderInsideLight();
  renderSystem();
}

// ── Online / Offline ──────────────────────────────────────────────────────────

function renderOnlineStatus(online, secondsSince) {
  if (online) {
    DOM.statusBadge.className    = 'status-badge status-online';
    DOM.statusText.textContent   = 'Online';
    DOM.offlineBanner.classList.add('hidden');
    DOM.deviceClock.textContent  = state.currentTime;
    DOM.sysConnection.textContent = 'Online';
    DOM.sysConnection.className  = 'sys-value good';
  } else {
    DOM.statusBadge.className    = 'status-badge status-offline';
    DOM.statusText.textContent   = 'Offline';
    DOM.offlineBanner.classList.remove('hidden');
    const ago = formatDuration(secondsSince);
    DOM.offlineBannerText.textContent =
      `Device offline — Last Data Received: ${ago} ago`;
    DOM.sysConnection.textContent = `Offline (${ago} ago)`;
    DOM.sysConnection.className  = 'sys-value bad';
  }

  if (lastDataReceivedAt) {
    DOM.sysLastUpdate.textContent = formatDuration(secondsSince) + ' ago';
  }
}

// ── Battery ───────────────────────────────────────────────────────────────────

function renderBattery() {
  const pct  = state.batteryPct;
  const volt = state.voltage;

  DOM.batteryFill.style.width    = Math.max(0, Math.min(100, pct)) + '%';
  DOM.batteryPctText.textContent = pct + '%';
  DOM.batteryPctVal.textContent  = pct + '%';
  DOM.voltageVal.textContent     = volt.toFixed(2) + ' V';
  DOM.batteryStatusBadge.textContent = pct + '%';

  // Fill colour
  DOM.batteryFill.classList.remove('level-high', 'level-medium', 'level-low', 'level-critical');
  if      (pct >= 60) DOM.batteryFill.classList.add('level-high');
  else if (pct >= 30) DOM.batteryFill.classList.add('level-medium');
  else if (pct >= 15) DOM.batteryFill.classList.add('level-low');
  else                DOM.batteryFill.classList.add('level-critical');

  // Health label
  let hText = 'Good', hClass = 'good';
  if      (pct < 15) { hText = 'Critical!'; hClass = 'bad'; }
  else if (pct < 30) { hText = 'Low';       hClass = 'warn'; }
  else if (pct < 60) { hText = 'Medium';    hClass = ''; }
  DOM.batteryHealthVal.textContent = hText;
  DOM.batteryHealthVal.className   = 'stat-value ' + hClass;

  toggleEl(DOM.hysteresisWarning,  state.fanLocked && pct >= 15);
  toggleEl(DOM.deadBatteryWarning, pct < 15);
}

// ── Fan ───────────────────────────────────────────────────────────────────────

function renderFan() {
  const { fanState: on, fanLocked: locked, fanEmergencyActive: emerg,
          fanEmergencyRemainingMs: remMs } = state;

  setPill(DOM.fanStatePill, on);

  DOM.fanHub.classList.remove('spinning', 'spinning-fast');
  if (emerg) {
    DOM.fanHub.classList.add('spinning-fast');
    DOM.fanStatusText.textContent = 'Emergency Mode — Running';
  } else if (on) {
    DOM.fanHub.classList.add('spinning');
    DOM.fanStatusText.textContent = 'Fan is ON';
  } else {
    DOM.fanStatusText.textContent = 'Fan is OFF';
  }

  DOM.btnFanToggle.disabled    = locked;
  DOM.btnFanEmergency.disabled = (state.batteryPct < 15);
  toggleEl(DOM.fanLockInfo, locked);

  DOM.emergencyBtnText.textContent = emerg ? 'Cancel Emergency' : 'Emergency 10 Min';
  DOM.btnFanEmergency.classList.toggle('active', emerg);

  if (emerg && remMs > 0) {
    DOM.emergencyCountdown.classList.remove('hidden');
    DOM.emergencyProgress.style.width = Math.max(0, (remMs / FAN_EMERGENCY_TOTAL_MS) * 100) + '%';
    DOM.emergencyTimeLeft.textContent = formatMsToMMSS(remMs);
  } else {
    DOM.emergencyCountdown.classList.add('hidden');
  }
}

// ── Outside Light ─────────────────────────────────────────────────────────────

function renderOutsideLight() {
  const { outsideLightState: on, outsideForceMode: mode,
          outsideForceRemainingMs: remMs } = state;

  setPill(DOM.outsideLightPill, on);
  DOM.outsideBulb.classList.toggle('on', on);

  DOM.outsideAutoStrip.classList.toggle('hidden',    mode !== 0);
  DOM.outsideForceOnStrip.classList.toggle('hidden', mode !== 1);
  DOM.outsideForceOffStrip.classList.toggle('hidden',mode !== 2);

  if (mode !== 0 && remMs > 0) {
    DOM.forceProgressWrap.classList.remove('hidden');
    DOM.forceProgress.style.width = Math.max(0, (remMs / FORCE_MODE_TOTAL_MS) * 100) + '%';
    const ts = formatMsToMMSS(remMs);
    if (mode === 1) {
      DOM.forceOnTimeLeft.textContent  = ts;
      DOM.outsideModeLabel.textContent = 'Force ON';
    } else {
      DOM.forceOffTimeLeft.textContent = ts;
      DOM.outsideModeLabel.textContent = 'Force OFF';
    }
  } else {
    DOM.forceProgressWrap.classList.add('hidden');
    DOM.outsideModeLabel.textContent = mode === 0 ? 'Auto (PIR)' : '--';
  }
}

// ── Inside Light ─────────────────────────────────────────────────────────────

function renderInsideLight() {
  const on = state.insideLightState;
  setPill(DOM.insideLightPill, on);
  DOM.insideBulb.classList.remove('on', 'on-purple');
  if (on) DOM.insideBulb.classList.add('on-purple');
  DOM.insideBtnText.textContent = on ? 'Turn OFF Inside Light' : 'Turn ON Inside Light';
}

// ── System ────────────────────────────────────────────────────────────────────

function renderSystem() {
  DOM.sysNtp.textContent      = state.ntpSynced ? 'Yes ✓' : 'Not synced';
  DOM.sysNtp.className        = 'sys-value ' + (state.ntpSynced ? 'good' : 'warn');
  DOM.sysDeviceTime.textContent = state.currentTime;

  const pirActive = state.outsideForceMode === 0 && state.outsideLightState;
  DOM.sysPirStatus.textContent = pirActive ? 'Motion detected' : 'No motion';
  DOM.sysPirStatus.className   = 'sys-value ' + (pirActive ? 'warn' : '');

  DOM.sysPirTimeout.textContent = state.pirHoldMinutes + ' min';
}

// ─────────────────────────────────────────────────────────────────────────────
//  OFFLINE DETECTION (1-second tick)
// ─────────────────────────────────────────────────────────────────────────────

function checkOnlineStatus() {
  if (!lastDataReceivedAt) return;
  const secondsSince = (Date.now() - lastDataReceivedAt.getTime()) / 1000;

  if (secondsSince > OFFLINE_THRESHOLD_SEC) {
    if (state.isOnline) {
      state.isOnline = false;
      showToast('Device went offline', 'warning', 'wifi-off');
    }
    renderOnlineStatus(false, secondsSince);
  } else {
    renderOnlineStatus(true, secondsSince);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOCAL TIMER TICK-DOWN (smooth countdown between Firebase updates)
// ─────────────────────────────────────────────────────────────────────────────

function uiTick() {
  checkOnlineStatus();

  // Tick down emergency timer locally
  if (state.fanEmergencyActive && state.fanEmergencyRemainingMs > 0) {
    state.fanEmergencyRemainingMs = Math.max(0, state.fanEmergencyRemainingMs - 1000);
    if (state.fanEmergencyRemainingMs === 0) {
      state.fanEmergencyActive = false;
      state.fanState           = false;
    }
    renderFan();
  }

  // Tick down force mode timer locally
  if (state.outsideForceMode !== 0 && state.outsideForceRemainingMs > 0) {
    state.outsideForceRemainingMs = Math.max(0, state.outsideForceRemainingMs - 1000);
    if (state.outsideForceRemainingMs === 0) state.outsideForceMode = 0;
    renderOutsideLight();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE SDK CONNECTION INDICATOR
// ─────────────────────────────────────────────────────────────────────────────

db.ref('.info/connected').on('value', (snap) => {
  if (snap.val()) {
    DOM.sysFirebase.textContent = 'SDK connected';
    DOM.sysFirebase.className   = 'sys-value good';
    // Only show "connecting" if we haven't received actual device data yet
    if (!lastDataReceivedAt) {
      DOM.statusBadge.className = 'status-badge status-connecting';
      DOM.statusText.textContent = 'Waiting for device…';
    }
  } else {
    DOM.sysFirebase.textContent = 'SDK disconnected';
    DOM.sysFirebase.className   = 'sys-value bad';
    DOM.statusBadge.className   = 'status-badge status-offline';
    DOM.statusText.textContent  = 'No Internet';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function toggleEl(el, show) {
  if (show) el.classList.remove('hidden');
  else      el.classList.add('hidden');
}

function setPill(el, on) {
  el.textContent = on ? 'ON' : 'OFF';
  el.classList.toggle('on',  on);
  el.classList.toggle('off', !on);
}

/**
 * Format milliseconds as MM:SS.
 */
function formatMsToMMSS(ms) {
  if (ms <= 0) return '00:00';
  const sec  = Math.floor(ms / 1000);
  const mins = Math.floor(sec / 60);
  const secs = sec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format seconds into a human-readable "X minutes ago" string.
 */
function formatDuration(seconds) {
  if (seconds < 5)    return 'just now';
  if (seconds < 60)   return `${Math.floor(seconds)} seconds`;
  const m = Math.floor(seconds / 60);
  if (seconds < 3600) return `${m} minute${m !== 1 ? 's' : ''}`;
  const h = Math.floor(seconds / 3600);
  return `${h} hour${h !== 1 ? 's' : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOAST NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

const TOAST_ICONS = { success: 'check-circle', error: 'x-circle',
                      warning: 'alert-triangle', info: 'info' };

function showToast(message, type = 'info', iconOverride = null, ms = 3500) {
  const icon  = iconOverride || TOAST_ICONS[type] || 'info';
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i data-lucide="${icon}"></i><span>${message}</span>`;
  DOM.toastContainer.appendChild(toast);
  lucide.createIcons({ nodes: [toast] });

  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, ms);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SPINNER
// ─────────────────────────────────────────────────────────────────────────────

function showSpinner(visible) {
  DOM.cmdSpinner.classList.toggle('hidden', !visible);
}

// ─────────────────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────────────────

// Start 1-second UI tick (offline detection + smooth countdown)
uiTickInterval = setInterval(uiTick, 1000);

showToast('Connecting to Firebase…', 'info', 'database', 2500);
console.log('[App] Home Automation Dashboard v2.0 loaded.');

// ─────────────────────────────────────────────────────────────────────────────
//  END OF app.js
// ─────────────────────────────────────────────────────────────────────────────
