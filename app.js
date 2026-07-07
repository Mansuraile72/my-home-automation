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
const PATH_KILL     = '/System_Status/Master_Block';
const PATH_SENSOR   = '/Sensor_Data';
const PATH_VOLT_CAL = '/Settings/voltageCalibration'; // ← Cloud calibration

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
  // DHT-11
  temperature:             null,
  humidity:                null,
};

let lastDataReceivedAt = null;
let uiTickInterval     = null;
let pirCommitTimer     = null;

// Kill switch runtime flag
let isKillSwitchActive = false;

// ─────────────────────────────────────────────────────────────────────────────
//  BATTERY TIME-REMAINING HISTORY
//  Stores a rolling 5-minute window of { ts, pct } readings.
//  Each entry is added when a fresh Firebase heartbeat arrives.
//  Rate = (Δpct / Δtime).  If the battery is charging (Δpct > 0)
//  we show "Charging" instead of a countdown.
// ─────────────────────────────────────────────────────────────────────────────
const BAT_HISTORY_WINDOW_MS = 10 * 60 * 1000; // 10-minute rolling window for accuracy
const BAT_MIN_SAMPLES       = 3;               // absolute minimum entry count
let   batHistory            = [];              // [{ ts: ms, pct: number }, ...]
let   lastBatPushTs         = 0;               // Throttle: push at most once per heartbeat

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
  gearBtn:           $('gearBtn'),

  // Battery
  batteryFill:        $('batteryFill'),
  batteryPctText:     $('batteryPctText'),
  batteryStatusBadge: $('batteryStatusBadge'),
  voltageVal:         $('voltageVal'),
  batteryPctVal:      $('batteryPctVal'),
  batteryHealthVal:   $('batteryHealthVal'),
  batteryTimeLeft:    $('batteryTimeLeft'),
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
  killSwitchOverlay: $('killSwitchOverlay'),
  killTimestamp:     $('killTimestamp'),

  // Settings drawer
  settingsDrawer:  $('settingsDrawer'),
  settingsOverlay: $('settingsOverlay'),

  // Sensor card
  sensorCard:         $('sensorCard'),
  sensorStatusBadge:  $('sensorStatusBadge'),
  sensorOfflineNote:  $('sensorOfflineNote'),
  tempValue:          $('tempValue'),
  humValue:           $('humValue'),
  tempArc:            $('tempArc'),
  humArc:             $('humArc'),
  tempGauge:          $('tempGauge'),
  humGauge:           $('humGauge'),

  // Voltage calibration
  calInput:       $('calInput'),
  calActiveMult:  $('calActiveMult'),
  btnCalUpdate:   $('btnCalUpdate'),
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

  // ════════════════════════════════════════════════════════════════════════════
  //  TIMESTAMP NORMALISATION + IMMEDIATE STALENESS CHECK
  // ════════════════════════════════════════════════════════════════════════════

  const NTP_OFFSET_SEC = 19800; // must match firmware NTP_OFFSET_SEC (UTC+5:30)
  const rawDeviceTs    = data.timestamp ?? 0;

  // ── GUARD 1: Invalid / zero timestamp ──────────────────────────────────────
  // A timestamp of 0 means the NodeMCU has not yet acquired an NTP lock and
  // wrote its initial payload before the clock was valid.  0 evaluates to
  // ageSec ≈0 which is below the threshold and would falsely show "Online".
  // Treat any ts ≤ 0 or implausibly small value as "device not ready".
  if (rawDeviceTs <= 0) {
    state.isOnline = false;
    renderOnlineStatus(false, Infinity); // Infinity → formatDuration shows correct msg
    renderBattery();
    renderFan();
    renderOutsideLight();
    renderInsideLight();
    renderSystem();
    console.warn('[Timestamp] rawDeviceTs is 0 or missing — NTP not yet synced on device.',
      'Treating as OFFLINE.');
    return;
  }

  // ── GUARD 2: Normalise seconds → ms ──────────────────────────────────────
  // NodeMCU sends seconds (10-digit).  JS Date.now() is ms (13-digit).
  const rawSec = rawDeviceTs < 1_000_000_000_000
    ? rawDeviceTs
    : Math.floor(rawDeviceTs / 1000);

  // ── GUARD 3: Strip IST offset ────────────────────────────────────────────
  // NTPClient with NTP_OFFSET_SEC=19800 returns an IST epoch, not UTC.
  // JS Date.now() is always UTC. Subtracting the offset aligns the bases.
  const utcSec = rawSec - NTP_OFFSET_SEC;
  const tsMs   = utcSec * 1000;
  lastDataReceivedAt = new Date(tsMs);

  // ── Diagnostics ──────────────────────────────────────────────────────────
  const ageMs  = Date.now() - tsMs;
  const ageSec = ageMs / 1000;
  console.log(
    '[Timestamp] raw:', rawDeviceTs,
    '| utcMs:', tsMs,
    '| now:', Date.now(),
    '| ageSec:', ageSec.toFixed(1)
  );

  // ── Staleness decision ──────────────────────────────────────────────────
  // Clamp to 0: tiny negative values can occur if device clock is slightly
  // ahead of the browser (normal NTP jitter — not a bug).
  const clampedAge = Math.max(0, ageSec);

  if (clampedAge > OFFLINE_THRESHOLD_SEC) {
    state.isOnline = false;
    renderOnlineStatus(false, clampedAge);
    renderBattery();
    renderFan();
    renderOutsideLight();
    renderInsideLight();
    renderSystem();
    console.warn('[Online] Device OFFLINE. Stale by', clampedAge.toFixed(1), 's');
    return;
  }

  // Timestamp is valid and fresh — device is genuinely online.
  state.isOnline = true;
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
//  FIREBASE LISTENER — Voltage Calibration
//  Keeps the input and badge in sync when the NodeMCU seeds the value on
//  first boot, or if another device changes the setting.
// ─────────────────────────────────────────────────────────────────────────────

db.ref(PATH_VOLT_CAL).on('value', (snapshot) => {
  const raw = snapshot.val();

  // Node doesn't exist yet — firmware will seed it on its next fetchSettings()
  if (raw === null) return;

  const cal = parseFloat(raw);
  if (isNaN(cal) || cal < 0.50 || cal > 2.00) return;  // Ignore garbage

  // Update badge (e.g. "1.150") and input box without triggering a write
  DOM.calActiveMult.textContent = cal.toFixed(3);
  DOM.calInput.value            = cal.toFixed(2);
});

// ─────────────────────────────────────────────────────────────────────────────
//  UPDATE VOLTAGE CALIBRATION — called from onclick in index.html
// ─────────────────────────────────────────────────────────────────────────────

function updateVoltageCalibration() {
  const raw = parseFloat(DOM.calInput.value);

  // Client-side range guard — same limits as the firmware
  if (isNaN(raw) || raw < 0.50 || raw > 2.00) {
    showToast('Value must be between 0.50 and 2.00', 'error', 'alert-triangle');
    return;
  }

  // Round to 3 decimal places to keep Firebase clean
  const cal = Math.round(raw * 1000) / 1000;

  DOM.btnCalUpdate.disabled = true;

  db.ref(PATH_VOLT_CAL).set(cal)
    .then(() => {
      DOM.calActiveMult.textContent = cal.toFixed(3);
      showToast(
        `Calibration set to ${cal.toFixed(3)}× — NodeMCU will apply within ~30 s`,
        'success',
        'check-circle'
      );
    })
    .catch((err) => {
      console.error('[Cal] Firebase write failed:', err);
      showToast('Failed to save calibration — check Firebase connection', 'error', 'alert-triangle');
    })
    .finally(() => {
      DOM.btnCalUpdate.disabled = false;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE LISTENER — DHT-11 Sensor Data
//  /Sensor_Data is a separate path written only by the NodeMCU.
//  Independent of the heartbeat path so it updates on its own 10 s cadence.
// ─────────────────────────────────────────────────────────────────────────────

db.ref(PATH_SENSOR).on('value', (snapshot) => {
  const data = snapshot.val();
  if (!data) return;

  const t = (data.Temperature != null) ? parseFloat(data.Temperature) : null;
  const h = (data.Humidity    != null) ? parseFloat(data.Humidity)    : null;

  if (t !== null) state.temperature = t;
  if (h !== null) state.humidity    = h;

  renderSensors();
}, (err) => {
  console.error('[Sensor] Listener error:', err);
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

  // Dim the sensor card immediately (renderAll isn't called on lock, only on unlock)
  renderSensors();
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
  renderSensors();
  renderBattery();
  renderFan();
  renderOutsideLight();
  renderInsideLight();
  renderSystem();
}

/**
 * Animates the SVG arc ring to represent a fraction 0..1 of the full circle.
 * The full circumference of r=32 is 2π×32 ≈ 201.06.
 */
function setSensorArc(arcEl, fraction) {
  const circ = 201.06;
  const filled = Math.max(0, Math.min(1, fraction)) * circ;
  arcEl.setAttribute('stroke-dasharray', `${filled.toFixed(1)} ${circ}`);
}

/**
 * Renders the DHT-11 sensor card with live temperature and humidity.
 * Also handles the offline / kill-switch dim state.
 */
function renderSensors() {
  const offline   = !state.isOnline;
  const locked    = isKillSwitchActive;
  const dimmed    = offline || locked;

  // Dim / undim the whole card
  DOM.sensorCard.classList.toggle('sensor-dim', dimmed);

  // Show / hide the offline note strip
  toggleEl(DOM.sensorOfflineNote, dimmed);

  // Update status badge
  DOM.sensorStatusBadge.textContent = dimmed ? (locked ? '🔒 Locked' : 'Offline') : 'Live';
  DOM.sensorStatusBadge.style.color = dimmed ? 'var(--red)' : '';
  DOM.sensorStatusBadge.style.background = dimmed ? 'var(--red-dim)' : '';

  const t = state.temperature;
  const h = state.humidity;

  // ── Temperature ───────────────────────────────────────────────────────────
  if (t !== null && !dimmed) {
    DOM.tempValue.textContent = t.toFixed(1);

    // Arc: map 0–50 °C to 0..1
    setSensorArc(DOM.tempArc, t / 50);

    // Colour class
    DOM.tempGauge.classList.remove('temp-hot', 'temp-warm', 'temp-cool', 'temp-cold');
    if      (t >= 35) DOM.tempGauge.classList.add('temp-hot');
    else if (t >= 28) DOM.tempGauge.classList.add('temp-warm');
    else if (t >= 20) DOM.tempGauge.classList.add('temp-cool');
    else              DOM.tempGauge.classList.add('temp-cold');
  } else {
    DOM.tempValue.textContent = 'N/A';
    setSensorArc(DOM.tempArc, 0);
    DOM.tempGauge.classList.remove('temp-hot', 'temp-warm', 'temp-cool', 'temp-cold');
  }

  // ── Humidity ────────────────────────────────────────────────────────────
  if (h !== null && !dimmed) {
    DOM.humValue.textContent = h.toFixed(1);

    // Arc: map 0–100% humidity to 0..1
    setSensorArc(DOM.humArc, h / 100);

    // Colour class
    DOM.humGauge.classList.remove('hum-high', 'hum-low');
    if      (h >= 70) DOM.humGauge.classList.add('hum-high');
    else if (h <  30) DOM.humGauge.classList.add('hum-low');
  } else {
    DOM.humValue.textContent = 'N/A';
    setSensorArc(DOM.humArc, 0);
    DOM.humGauge.classList.remove('hum-high', 'hum-low');
  }
}

// ── Online / Offline ──────────────────────────────────────────────────────────

function renderOnlineStatus(online, secondsSince) {
  if (online) {
    DOM.statusBadge.className     = 'status-badge status-online';
    DOM.statusText.textContent    = 'Online';
    DOM.offlineBanner.classList.add('hidden');
    DOM.deviceClock.textContent   = state.currentTime;
    DOM.sysConnection.textContent = 'Online';
    DOM.sysConnection.className   = 'sys-value good';

    // Re-enable all relay buttons when back online.
    // renderFan() will re-apply BMS hysteresis locks on top of this.
    if (!isKillSwitchActive) {
      document.querySelectorAll('.btn').forEach(btn => {
        // Only re-enable buttons that aren't already locked by the kill switch
        if (!btn.dataset.killedDisabled) btn.disabled = false;
      });
      DOM.pirSlider.disabled = false;
    }
  } else {
    DOM.statusBadge.className     = 'status-badge status-offline';
    DOM.statusText.textContent    = 'Offline';
    DOM.offlineBanner.classList.remove('hidden');
    const ago = formatDuration(secondsSince);
    DOM.offlineBannerText.textContent =
      `Device offline — Last Data Received: ${ago} ago`;
    DOM.sysConnection.textContent = `Offline (${ago} ago)`;
    DOM.sysConnection.className   = 'sys-value bad';

    // Disable ALL relay/control buttons while offline so the user cannot
    // queue commands to a dead device. Kill switch overlay takes precedence
    // when active, so we only disable if not already kill-switched.
    if (!isKillSwitchActive) {
      document.querySelectorAll('.btn').forEach(btn => {
        btn.disabled = true;
      });
      DOM.pirSlider.disabled = true;
    }
  }

  if (lastDataReceivedAt) {
    DOM.sysLastUpdate.textContent = formatDuration(secondsSince) + ' ago';
  }
}

// ── Battery ───────────────────────────────────────────────────────────────────

/**
 * Push a new reading into the rolling 5-minute history window.
 * Called once per Firebase heartbeat.
 */
function pushBatHistory(pct) {
  const now = Date.now();
  // Throttle: don't push more than once per 8 seconds (matches heartbeat cadence)
  if (now - lastBatPushTs < 8000) return;
  lastBatPushTs = now;

  batHistory.push({ ts: now, pct });

  // Remove entries older than the window
  const cutoff = now - BAT_HISTORY_WINDOW_MS;
  batHistory = batHistory.filter(e => e.ts >= cutoff);
}

/**
 * Calculate remaining battery time based on the drain rate over the last 5 min.
 *
 * Algorithm:
 *   deltaPct = oldest.pct - newest.pct   (positive = draining)
 *   deltaMin = (newest.ts - oldest.ts) / 60000
 *   rate     = deltaPct / deltaMin        (% per minute)
 *   left     = newest.pct / rate          (minutes left)
 *
 * @returns {string}  e.g. "~ 3h 20m", "⚡ Charging", "Calculating…"
 */
function calcBatteryTimeLeft() {
  if (batHistory.length < BAT_MIN_SAMPLES) return 'Calculating…';

  const oldest  = batHistory[0];
  const newest  = batHistory[batHistory.length - 1];
  const deltaMin = (newest.ts - oldest.ts) / 60000;

  if (deltaMin < 2) return 'Calculating…';   // Need ≥2 min of data for first estimate

  const deltaPct = oldest.pct - newest.pct;    // positive = draining
  if (deltaPct <= 0) return '⚡ Charging / Stable';

  const ratePerMin = deltaPct / deltaMin;
  const minsLeft   = newest.pct / ratePerMin;

  if (!isFinite(minsLeft) || minsLeft <= 0) return 'Calculating…';

  const h = Math.floor(minsLeft / 60);
  const m = Math.round(minsLeft % 60);

  if (h === 0) return `~ ${m}m`;
  if (m === 0) return `~ ${h}h`;
  return `~ ${h}h ${m}m`;
}

function renderBattery() {
  const pct  = state.batteryPct;
  const volt = state.voltage;

  // Push into rolling history for time-remaining calculation
  pushBatHistory(pct);

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

  // Time remaining — powered by 5-min rolling history
  if (DOM.batteryTimeLeft) {
    DOM.batteryTimeLeft.textContent = calcBatteryTimeLeft();
  }

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

  // Only apply BMS-level enable/disable when the device is online.
  // While offline, renderOnlineStatus() already disabled all buttons;
  // overwriting disabled=false here would re-enable them erroneously.
  if (state.isOnline && !isKillSwitchActive) {
    DOM.btnFanToggle.disabled    = locked;
    DOM.btnFanEmergency.disabled = (state.batteryPct < 15);
  }
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

  const msSince    = Date.now() - lastDataReceivedAt.getTime();
  const secondsSince = msSince / 1000;

  // With the IST offset now stripped at ingestion time (in the Firebase
  // listener), secondsSince should never be wildly negative.  A small
  // negative value (< -60 s) is real clock skew — clamp to 0 and
  // treat as fresh rather than forcing an incorrect online/offline state.
  const clamped = Math.max(0, secondsSince);

  if (clamped > OFFLINE_THRESHOLD_SEC) {
    if (state.isOnline) {
      state.isOnline = false;
      showToast('Device went offline', 'warning', 'wifi-off');
    }
    renderOnlineStatus(false, clamped);
  } else {
    if (!state.isOnline) state.isOnline = true;
    renderOnlineStatus(true, clamped);
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
 * Format seconds into a human-readable "X ago" string.
 * Handles Infinity and NaN (produced when timestamp is 0 / NTP not synced).
 */
function formatDuration(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return 'unknown (device not ready)';
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
//  SETTINGS DRAWER
// ─────────────────────────────────────────────────────────────────────────────

let _drawerOpen = false;

function openSettingsDrawer() {
  _drawerOpen = true;
  DOM.settingsDrawer.classList.add('open');
  DOM.settingsOverlay.classList.add('open');
  DOM.gearBtn.classList.add('active');
  // Re-render icons inside drawer (Lucide needs this after first paint)
  lucide.createIcons();
}

function closeSettingsDrawer() {
  _drawerOpen = false;
  DOM.settingsDrawer.classList.remove('open');
  DOM.settingsOverlay.classList.remove('open');
  DOM.gearBtn.classList.remove('active');
}

function toggleSettingsDrawer() {
  _drawerOpen ? closeSettingsDrawer() : openSettingsDrawer();
}

// Close drawer on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _drawerOpen) closeSettingsDrawer();
});

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
