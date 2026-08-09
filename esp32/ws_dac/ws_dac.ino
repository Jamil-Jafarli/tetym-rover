/* ═══════════════════════════════════════════════════════════════════════
   ESP32 WebSocket DAC — GPIO25 / GPIO26

   No USB, no Raspberry Pi. The ESP32 joins your wifi, opens a WebSocket
   server, and writes whatever voltage you send straight to its two DACs.

       ws://192.168.4.1:81/       out of the box (its own access point)
       ws://<esp-ip>:81/          once you put it on your own wifi
       ws://esp32-dac.local:81/

   Send JSON:
       {"cmd":"set","v25":1.80,"v26":1.50,"en":true,"r25":false,"r26":false}
       {"cmd":"stop"}                            both channels to idle
   You get a status object back at 10 Hz.

   `en` drives the digital ENABLE pin: LOW at rest, HIGH only while you are
   actively commanding. That is the pin to wire to your driver's enable /
   brake-release / relay input.

   `r25` / `r26` drive the two direction relays, one per wheel. THE BOARD
   ENFORCES ITS OWN INTERLOCK: it will not move either pin until BOTH DACs have
   sat at idle for REV_SETTLE_MS. Switching phase wires under load destroys the
   controller's MOSFETs, and a wheel that is being dragged along by the robot
   is still turning — so the rule covers both wheels, and does not depend on
   the network behaving.

   Idle is 1.00 V — the motor controller reads that as zero throttle — so
   that is what we output on boot, when nobody is connected, and whenever
   the link goes quiet. It is never 0 V.

   Wiring
   ------
       GPIO25 (DAC1) → left  controller throttle signal wire
       GPIO26 (DAC2) → right controller throttle signal wire
       GPIO23        → ENABLE: LOW at rest, HIGH while running
                       (other side of the board from the DACs, on purpose)
       GPIO19        → GPIO25 wheel's direction relay
       GPIO18        → GPIO26 wheel's direction relay
                       LOW = forward, HIGH = that wheel runs backwards.
                       One high  = the robot pivots on the spot.
                       Both high = the robot backs up.
       GND           → both controller GNDs      (required, common ground)

   Libraries (Arduino Library Manager)
   -----------------------------------
       "WebSockets"  by Markus Sattler   (arduinoWebSockets)
       "ArduinoJson" by Benoit Blanchon  (v7)

   Safety
   ------
     * 300 ms watchdog: no valid packet → idle. So the client must keep
       streaming, ~20 Hz. A frozen sender must never leave the throttle up.
     * No WebSocket client connected → idle immediately.
     * ENABLE goes LOW on every one of those paths, and on boot. It is HIGH
       only while a client is actively commanding with en:true.
     * Every value is clamped to [V_MIN, V_MAX] before it reaches a pin.
     * Slew limiting so a big jump ramps instead of lurching.
   ═══════════════════════════════════════════════════════════════════════ */

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

/* ───────────────────────────── WIFI
   Out of the box this board makes its OWN network — no router, no config,
   nothing to look up. Flash it and it is immediately reachable at:

       ssid      ESP32-DAC
       password  dac12345
       address   ws://192.168.4.1:81/

   That is the default because it always works: on a bench, in a hall, at a
   competition, with no DHCP server and no IP to hunt for.

   To put it on your own wifi instead, fill in WIFI_SSID / WIFI_PASS below.
   It then joins that network and prints its IP on the serial monitor, and
   falls back to the access point above if the network is unreachable — so
   you can never end up locked out. */

const char* WIFI_SSID = "Tetym";              // leave empty for access-point mode
const char* WIFI_PASS = "TETYM2024!";

const char* AP_SSID = "ESP32-DAC";       // the default network
const char* AP_PASS = "dac12345";        // >= 8 chars
const char* MDNS_NAME = "esp32-dac";     // -> esp32-dac.local

const uint32_t WIFI_CONNECT_TIMEOUT_MS = 12000;

// ───────────────────────────── CONFIG
const int PIN_DAC_25 = 25;    // DAC1
const int PIN_DAC_26 = 26;    // DAC2
// Deliberately on the opposite header from the two DACs: on a DevKit V1,
// 25/26 sit on the right-hand column and 23 is at the far end of the left,
// so the enable wire does not run alongside the analog pair. Not a strapping
// pin, no boot-time constraint, free unless you are using VSPI.
const int PIN_ENABLE = 23;    // digital: LOW at rest, HIGH while running
const int PIN_REV_25 = 19;    // direction relay for the GPIO25 wheel
const int PIN_REV_26 = 18;    // direction relay for the GPIO26 wheel

// ── sonar ────────────────────────────────────────────────────────────
// Two HC-SR04s: one bolted to the front, one on a continuous-rotation servo
// that spins it round. Change these to match your wiring — the board reports
// them in its status, so the pages follow whatever you set here.
//
// HC-SR04 runs at 5 V and its ECHO pin swings to 5 V, which will damage a 3.3 V
// GPIO. Put a divider on each echo line (1k series, 2k to ground gives 3.3 V).
// TRIG is an input on the sensor and is happy with 3.3 V.
const int PIN_SERVO     = 13;   // continuous-rotation servo, 50 Hz PWM
const int PIN_TRIG_SCAN = 27;   // the spinning sensor
const int PIN_ECHO_SCAN = 33;
const int PIN_TRIG_FWD  = 14;   // the forward-facing one
const int PIN_ECHO_FWD  = 32;

// One ping per sensor every 50 ms. Faster and the previous burst is still
// rattling around the room when the next goes out, which reads as a phantom
// object at whatever distance the old echo came from.
const uint32_t PING_PERIOD_MS = 50;
// Sound covers 4 m and back in about 23 ms. Anything still silent after 25 ms
// is not a distant object, it is no object — report nothing, not a big number.
const uint32_t ECHO_TIMEOUT_US = 25000;
// Servo: 1500 us is stop on a continuous-rotation servo, and roughly ±500 us
// either side is full speed one way or the other.
const int SERVO_STOP_US = 1500;
const int SERVO_SWING_US = 500;
const int SERVO_CHANNEL = 4;    // LEDC channel; 0-3 are left alone for the DACs

// ── the spare pins, for /pins ────────────────────────────────────────
// Everything the robot does not already use, so you can put a value on a pin
// by hand and see what your hardware does with it.
//
// ONLY GPIO25 AND GPIO26 ARE ANALOG. They are the ESP32's two real DACs and
// they output an actual voltage. Every pin below is PWM: a square wave at
// 5 kHz whose duty cycle is the value you set. A multimeter reads the average
// and it looks like a voltage, an oscilloscope shows what it really is, and a
// motor controller expecting a clean analog input will not be fooled.
//
// Left out on purpose:
//   0, 12   strapping pins — a value held on them at boot changes how the chip
//           starts, and 12 can pick the wrong flash voltage
//   1, 3    the serial console
//   6-11    the flash chip. Touching these bricks the board until reflashed.
//   34-39   input only, no output driver at all
// 2 and 15 are strapping pins too, but only care what they see AT boot, so they
// are included — just do not wire something that holds them while it resets.
const int TEST_PINS[] = { 4, 5, 16, 17, 21, 22, 2, 15 };
const int TEST_PIN_COUNT = sizeof(TEST_PINS) / sizeof(TEST_PINS[0]);
const int TEST_CH0 = 5;         // LEDC channels 5..12; 0-4 are taken
const int TEST_PWM_HZ = 5000;

// Set true if your driver's enable input is active-LOW.
const bool ENABLE_ACTIVE_LOW = false;
// Set true if your relay board is active-LOW — the input is held HIGH at rest
// and pulled LOW to pull the relay in. That is what most opto-isolated modules
// want, and it is what this robot is wired for.
//
// It also decides what a dead board does. With active-LOW, "forward" is the
// pin sitting HIGH, so the coil is de-energised — a cut wire, a flat rail or a
// crashed ESP32 all leave the robot facing forward, which is the safe way. The
// one gap is the moment between reset and setup(): the pin is an input then,
// and it is the relay board's own pull-up that holds it off. If yours has no
// pull-up, add one (10k to 3V3) — otherwise the relays click into reverse for
// as long as the board takes to boot.
const bool REVERSE_ACTIVE_LOW = true;

// How long both DACs must sit at idle before the direction relays are allowed
// to move. The motor has to be genuinely stopped, not just commanded to stop —
// give the wheel time to coast down. Raise it if your robot is heavy.
const uint32_t REV_SETTLE_MS = 1000;

// Anything above this counts as "still driving" for the interlock.
const float V_STOPPED_EPS = 0.03f;

const float V_IDLE = 1.00f;   // zero-throttle resting level
const float V_MIN  = 1.00f;   // never output below idle
const float V_MAX  = 3.30f;   // ceiling; lower it while you are still tuning
const float V_REF  = 3.30f;   // DAC full scale (= VDD)

const uint32_t LINK_TIMEOUT_MS   = 300;   // no packet → idle
const uint32_t STATUS_PERIOD_MS  = 100;   // 10 Hz status broadcast
const uint32_t LOG_PERIOD_MS     = 500;   // serial debug

// Volts per second, per channel. Raise it if the response feels sluggish.
const float V_SLEW_PER_S = 6.0f;

const uint16_t WS_PORT = 81;

// ───────────────────────────── STATE
WebSocketsServer ws(WS_PORT);

float    target25 = V_IDLE, target26 = V_IDLE;   // commanded
float    current25 = V_IDLE, current26 = V_IDLE; // after slew limiting
bool     wantEnable = false;                     // what the client asked for
bool     enableOut  = false;                     // what the pin is actually at
bool     wantRev[2] = {false, false};            // direction the client asked for
bool     revOut[2]   = {false, false};           // where the relays actually are
uint32_t idleSinceMs = 0;                        // when both DACs reached idle
bool     revBlocked  = false;                    // asked to flip, waiting to settle

// ── sonar state ──────────────────────────────────────────────────────
// The echo pins are timed by interrupt rather than pulseIn(). pulseIn blocks
// for up to 25 ms waiting for a wall that may not be there, and this loop also
// has a 20 Hz control stream and a websocket to service — a sensor must not be
// able to stall the thing that drives the motors.
volatile uint32_t echoStartFwd = 0, echoStartScan = 0;
volatile uint32_t echoUsFwd = 0, echoUsScan = 0;
volatile bool     echoNewFwd = false, echoNewScan = false;

float    fwdCm = -1, scanCm = -1;          // -1 means "no echo", never 0
int      spinCmd = 0;                      // -100..100
uint32_t spinStartMs = 0;                  // when the current spin began
uint32_t spinBankedMs = 0;                 // rotation banked before it stopped
uint32_t scanStampMs = 0;                  // rotation behind the last scan echo
uint32_t lastPingMs = 0;
bool     pingFwdNext = true;
bool     heardFwd = false, heardScan = false;

// ── spare-pin state ──────────────────────────────────────────────────
uint8_t  testVal[TEST_PIN_COUNT] = {0};

int testIndex(int gpio) {
  for (int i = 0; i < TEST_PIN_COUNT; i++) if (TEST_PINS[i] == gpio) return i;
  return -1;
}

/**
 * Put a raw 0-255 on one of the spare pins.
 *
 * The value means two different things depending on the pin, and the page says
 * which: on GPIO25/26 it is a DAC code and comes out as a real voltage; on
 * everything else it is a PWM duty cycle. Refusing an unknown pin rather than
 * writing to it is the whole safety story here — half the GPIOs on this chip
 * do something permanent if you drive them.
 */
bool setTestPin(int gpio, int value) {
  int v = constrain(value, 0, 255);
  if (gpio == PIN_DAC_25 || gpio == PIN_DAC_26) return false;   // the drive path owns those
  int i = testIndex(gpio);
  if (i < 0) return false;
  testVal[i] = (uint8_t)v;
  ledcWrite(TEST_CH0 + i, v);   // 8-bit resolution: the value IS the duty
  return true;
}

/** Everything back to 0. Called on stop, on idle, and when the last client goes. */
void clearTestPins() {
  for (int i = 0; i < TEST_PIN_COUNT; i++) {
    testVal[i] = 0;
    ledcWrite(TEST_CH0 + i, 0);
  }
}

void IRAM_ATTR onEchoFwd() {
  if (digitalRead(PIN_ECHO_FWD)) { echoStartFwd = micros(); }
  else if (echoStartFwd) {
    echoUsFwd = micros() - echoStartFwd;
    echoStartFwd = 0;
    echoNewFwd = true;
  }
}

void IRAM_ATTR onEchoScan() {
  if (digitalRead(PIN_ECHO_SCAN)) { echoStartScan = micros(); }
  else if (echoStartScan) {
    echoUsScan = micros() - echoStartScan;
    echoStartScan = 0;
    echoNewScan = true;
  }
}

/** Microseconds of round trip -> centimetres. 343 m/s, there and back. */
float cmFromUs(uint32_t us) {
  if (us == 0 || us > ECHO_TIMEOUT_US) return -1;
  float cm = us / 58.0f;
  return (cm < 2 || cm > 400) ? -1 : cm;    // outside the sensor's real range
}

/** Total milliseconds the scan servo has actually been turning. */
uint32_t spinElapsed() {
  return spinBankedMs + (spinCmd != 0 ? millis() - spinStartMs : 0);
}

void writeServo(int pct) {
  int us = SERVO_STOP_US + (pct * SERVO_SWING_US) / 100;
  // LEDC at 50 Hz / 16-bit: one period is 20000 us mapped onto 65535 counts.
  ledcWrite(SERVO_CHANNEL, (uint32_t)((us * 65535L) / 20000L));
}

/**
 * Ask for the spin to start, stop or change.
 *
 * Stopping banks the elapsed time instead of zeroing it, so a pause does not
 * silently rotate the whole map: the angle is derived from how long the servo
 * has turned, and that clock has to survive being paused.
 */
void setSpin(int pct) {
  int want = constrain(pct, -100, 100);
  if (want == spinCmd) return;
  if (spinCmd != 0) spinBankedMs += millis() - spinStartMs;
  spinCmd = want;
  spinStartMs = millis();
  writeServo(spinCmd);
}

/** Fire one sensor, alternating, and collect whatever came back. */
void updateSonar() {
  // Collect whatever the interrupts caught since last time.
  if (echoNewFwd) {
    noInterrupts(); uint32_t u = echoUsFwd; echoNewFwd = false; interrupts();
    fwdCm = cmFromUs(u);
    heardFwd = true;
  }
  if (echoNewScan) {
    noInterrupts(); uint32_t u = echoUsScan; echoNewScan = false; interrupts();
    scanCm = cmFromUs(u);
    scanStampMs = spinElapsed();   // stamp it with the rotation, not the wall clock
    heardScan = true;
  }

  uint32_t now = millis();
  if (now - lastPingMs < PING_PERIOD_MS) return;
  lastPingMs = now;

  // Silence is a real answer, and the one that matters most: an object too soft
  // or too angled to echo reads the same as an empty room, and leaving the
  // previous distance sitting there would make it look live. So a sensor that
  // said nothing since its last ping is cleared before the next one goes out.
  if (pingFwdNext) {
    if (!heardFwd) fwdCm = -1;
    heardFwd = false;
  } else {
    if (!heardScan) { scanCm = -1; scanStampMs = spinElapsed(); }
    heardScan = false;
  }

  int trig = pingFwdNext ? PIN_TRIG_FWD : PIN_TRIG_SCAN;
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);          // the datasheet's 10 us burst
  digitalWrite(trig, LOW);
  pingFwdNext = !pingFwdNext;
}
bool     atIdle = true;
uint8_t  clients = 0;

uint32_t lastPacketMs = 0;
uint32_t lastSlewMs   = 0;
uint32_t lastStatusMs = 0;
uint32_t lastLogMs    = 0;

uint32_t goodPkts = 0;
uint32_t badPkts  = 0;
bool     apMode   = false;

// ───────────────────────────── DAC
uint8_t dacFor(float v) {
  v = constrain(v, V_MIN, V_MAX);
  long d = lroundf(v / V_REF * 255.0f);
  return (uint8_t)constrain(d, 0L, 255L);
}

void writeEnable(bool on) {
  enableOut = on;
  digitalWrite(PIN_ENABLE, (on != ENABLE_ACTIVE_LOW) ? HIGH : LOW);
}

void writeReverse(uint8_t ch, bool on) {
  revOut[ch] = on;
  digitalWrite(ch == 0 ? PIN_REV_25 : PIN_REV_26,
               (on != REVERSE_ACTIVE_LOW) ? HIGH : LOW);
}

bool revPending() {
  return wantRev[0] != revOut[0] || wantRev[1] != revOut[1];
}

/* True only when both outputs are actually sitting at idle — not merely
   commanded there. `current*` is the post-slew value, so this waits out the
   ramp as well. */
bool outputsAtIdle() {
  return current25 <= V_IDLE + V_STOPPED_EPS
      && current26 <= V_IDLE + V_STOPPED_EPS;
}

const char* dirName(const bool d[2]) {
  if (!d[0] && !d[1]) return "forward";
  if (d[0] && d[1])   return "BACK";
  return d[0] ? "PIVOT (25 rev)" : "PIVOT (26 rev)";
}

/* The interlock. Phase wires may only be crossed over with the motor stopped;
   doing it under load shorts the controller's output stage. Both relays move
   together and only when BOTH channels are idle — a wheel dragged along by the
   robot is still turning, even if it is not being driven. Nothing outside this
   function is allowed to touch the direction pins. */
void updateReverse() {
  if (!revPending()) { revBlocked = false; return; }

  if (!outputsAtIdle()) {
    revBlocked = true;
    idleSinceMs = 0;              // still moving: restart the clock
    return;
  }
  uint32_t now = millis();
  if (idleSinceMs == 0) idleSinceMs = now;
  if (now - idleSinceMs < REV_SETTLE_MS) { revBlocked = true; return; }

  writeReverse(0, wantRev[0]);
  writeReverse(1, wantRev[1]);
  revBlocked = false;
  Serial.printf("direction -> %s\n", dirName(revOut));
}

void writePins() {
  dacWrite(PIN_DAC_25, dacFor(current25));
  dacWrite(PIN_DAC_26, dacFor(current26));
}

/* Jump straight to idle with no ramp, ENABLE off — for boot, stop and the
   watchdog, where waiting for a ramp would be exactly the wrong thing. */
void forceIdle() {
  target25 = current25 = V_IDLE;
  target26 = current26 = V_IDLE;
  wantEnable = false;
  writeEnable(false);
  writePins();
  // The relays are deliberately NOT reset here. Dropping the coils mid-coast
  // would cross the phases while the wheel is still turning — exactly what the
  // interlock exists to prevent. updateReverse() returns them to forward once
  // the wheels have actually stopped.
  wantRev[0] = wantRev[1] = false;
}

float slew(float cur, float tgt, float maxStep) {
  float d = tgt - cur;
  if (d >  maxStep) return cur + maxStep;
  if (d < -maxStep) return cur - maxStep;
  return tgt;
}

void updateOutputs() {
  uint32_t now = millis();
  float maxStep = V_SLEW_PER_S * (float)(now - lastSlewMs) / 1000.0f;
  lastSlewMs = now;

  bool live = clients > 0 && (now - lastPacketMs) <= LINK_TIMEOUT_MS;

  if (!live) {
    if (!atIdle) {
      forceIdle();                       // cut now, do not ramp down
      atIdle = true;
      Serial.println(clients == 0 ? "no clients -> idle" : "link timeout -> idle");
    }
    return;
  }

  // ENABLE follows the command directly — no ramp, it is a digital pin.
  if (enableOut != wantEnable) writeEnable(wantEnable);

  // While a direction change is pending, hold both channels at idle. This is
  // what actually stops the wheels so the relays can move.
  if (revPending()) {
    target25 = V_IDLE;
    target26 = V_IDLE;
  }

  if (maxStep <= 0.0f) return;
  current25 = slew(current25, target25, maxStep);
  current26 = slew(current26, target26, maxStep);
  writePins();
}

// ───────────────────────────── WEBSOCKET
void sendStatus(int8_t only = -1) {
  JsonDocument doc;
  doc["type"]    = "status";
  doc["v25"]     = roundf(current25 * 100) / 100.0f;
  doc["v26"]     = roundf(current26 * 100) / 100.0f;
  doc["dac25"]   = dacFor(current25);
  doc["dac26"]   = dacFor(current26);
  doc["en"]      = enableOut;
  doc["en_pin"]  = PIN_ENABLE;
  JsonArray rev = doc["rev"].to<JsonArray>();
  rev.add(revOut[0]);
  rev.add(revOut[1]);
  JsonArray revPin = doc["rev_pin"].to<JsonArray>();
  revPin.add(PIN_REV_25);
  revPin.add(PIN_REV_26);

  JsonObject pins = doc["pins"].to<JsonObject>();
  for (int i = 0; i < TEST_PIN_COUNT; i++) {
    char key[6];
    snprintf(key, sizeof(key), "%d", TEST_PINS[i]);
    pins[key] = testVal[i];
  }

  JsonObject son = doc["son"].to<JsonObject>();
  if (fwdCm  > 0) son["fwd_cm"]  = fwdCm;  else son["fwd_cm"]  = (const char*)NULL;
  if (scanCm > 0) son["scan_cm"] = scanCm; else son["scan_cm"] = (const char*)NULL;
  son["scan_t"] = scanStampMs;             // ms of rotation behind that echo
  son["spin"]   = spinCmd;
  JsonObject sp = son["pin"].to<JsonObject>();
  sp["servo"]  = PIN_SERVO;
  sp["trig_s"] = PIN_TRIG_SCAN;
  sp["echo_s"] = PIN_ECHO_SCAN;
  sp["trig_f"] = PIN_TRIG_FWD;
  sp["echo_f"] = PIN_ECHO_FWD;
  doc["rev_wait"] = revBlocked;
  doc["dir"]      = dirName(revOut);
  doc["set25"]   = roundf(target25 * 100) / 100.0f;
  doc["set26"]   = roundf(target26 * 100) / 100.0f;
  doc["idle"]    = V_IDLE;
  doc["vmin"]    = V_MIN;
  doc["vmax"]    = V_MAX;
  doc["clients"] = clients;
  doc["pkt"]     = goodPkts;
  doc["bad"]     = badPkts;
  doc["stale"]   = atIdle;
  doc["uptime"]  = millis();
  doc["rssi"]    = apMode ? 0 : WiFi.RSSI();
  doc["ap"]      = apMode;

  String out;
  serializeJson(doc, out);
  if (only < 0) ws.broadcastTXT(out);
  else          ws.sendTXT((uint8_t)only, out);
}

void handleMessage(uint8_t num, const char* text) {
  JsonDocument doc;
  if (deserializeJson(doc, text)) { badPkts++; return; }

  const char* cmd = doc["cmd"] | "set";

  if (!strcmp(cmd, "stop") || !strcmp(cmd, "idle")) {
    forceIdle();
    clearTestPins();
    lastPacketMs = millis();
    atIdle = false;                 // a deliberate idle still counts as alive
    goodPkts++;
    sendStatus(num);
    return;
  }

  if (!strcmp(cmd, "ping")) { sendStatus(num); return; }

  // The scan servo is deliberately its own command. It is not movement, so it
  // has no business feeding the drive watchdog — a board quietly mapping a room
  // must not look like one that is being driven, and a page that only wants to
  // scan should not have to pretend to be a driver to do it.
  // One pin, one raw value. Not part of the drive stream and not watchdogged:
  // a bench value you set by hand should stay where you put it while you go and
  // measure it. It is cleared by stop, by idle, and by the last client leaving.
  if (!strcmp(cmd, "pin")) {
    int gpio = doc["gpio"].is<int>() ? doc["gpio"].as<int>() : -1;
    int val  = doc["val"].is<int>()  ? doc["val"].as<int>()  : 0;
    if (setTestPin(gpio, val)) goodPkts++; else badPkts++;
    sendStatus(num);
    return;
  }

  if (!strcmp(cmd, "scan")) {
    setSpin(doc["spin"].is<int>() ? doc["spin"].as<int>() : 0);
    goodPkts++;
    sendStatus(num);
    return;
  }

  if (strcmp(cmd, "set")) { badPkts++; return; }

  float a = target25, b = target26;
  bool got = false;

  if (doc["v25"].is<float>()) { a = doc["v25"].as<float>(); got = true; }
  if (doc["v26"].is<float>()) { b = doc["v26"].as<float>(); got = true; }

  if (!got || isnan(a) || isnan(b) || isinf(a) || isinf(b)) { badPkts++; return; }

  // Direction first, then throttle. Absent means forward, so a client that
  // never mentions direction can never leave a wheel running backwards — and
  // reading it first means a packet asking for a flip cannot raise the
  // throttle in the same breath. The wheel has to stop before the relays can
  // move, and this is where stopping begins.
  wantRev[0] = doc["r25"].is<bool>() ? doc["r25"].as<bool>() : false;
  wantRev[1] = doc["r26"].is<bool>() ? doc["r26"].as<bool>() : false;
  const bool pending = revPending();

  target25 = pending ? V_IDLE : constrain(a, V_MIN, V_MAX);
  target26 = pending ? V_IDLE : constrain(b, V_MIN, V_MAX);
  // Absent "en" means false: a client that never mentions it must not be able
  // to leave the driver enabled.
  wantEnable = doc["en"].is<bool>() ? doc["en"].as<bool>() : false;
  lastPacketMs = millis();
  atIdle = false;
  goodPkts++;
}

void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED: {
      clients++;
      IPAddress ip = ws.remoteIP(num);
      Serial.printf("client %u connected from %s (now %u)\n",
                    num, ip.toString().c_str(), clients);
      // A fresh client has not commanded anything yet: stay at idle until it
      // does. Not resetting lastPacketMs here is deliberate.
      sendStatus(num);
      break;
    }
    case WStype_DISCONNECTED:
      if (clients) clients--;
      Serial.printf("client %u gone (now %u)\n", num, clients);
      // Nobody watching: the drive pins go to idle and the bench pins go to
      // zero. A value left on a pin by a browser that has gone away is a thing
      // nobody is responsible for any more.
      if (clients == 0) { forceIdle(); clearTestPins(); }
      break;

    case WStype_TEXT:
      payload[len] = 0;               // the library leaves room for this
      handleMessage(num, (const char*)payload);
      break;

    default:
      break;
  }
}

// ───────────────────────────── WIFI
void startAp(const char* why) {
  apMode = true;
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.printf("%s — access point \"%s\" (pass %s) up at %s\n",
                why, AP_SSID, AP_PASS, WiFi.softAPIP().toString().c_str());
}

void startWifi() {
  if (WIFI_SSID[0] == '\0') {
    startAp("no wifi configured");
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);               // latency over power saving
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("connecting to %s", WIFI_SSID);

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT_MS) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    apMode = false;
    Serial.printf("wifi ok   ip: %s   rssi: %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    startAp("wifi unreachable");
  }

  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("ws", "tcp", WS_PORT);
    Serial.printf("mdns: %s.local\n", MDNS_NAME);
  }
}

// ───────────────────────────── SETUP / LOOP
void setup() {
  // The pins first, before Serial and before the 200 ms it waits. Until
  // pinMode runs they are inputs, and an active-LOW relay board reads a
  // floating input as "pull in" unless it has a pull-up of its own — so every
  // millisecond spent before this line is a millisecond the robot could spend
  // in reverse.
  pinMode(PIN_ENABLE, OUTPUT);
  pinMode(PIN_REV_25, OUTPUT);
  pinMode(PIN_REV_26, OUTPUT);
  writeReverse(0, false);         // always boot facing forward
  writeReverse(1, false);
  forceIdle();                    // before anything else, so the pins never float
  lastSlewMs = millis();

  pinMode(PIN_TRIG_FWD, OUTPUT);   digitalWrite(PIN_TRIG_FWD, LOW);
  pinMode(PIN_TRIG_SCAN, OUTPUT);  digitalWrite(PIN_TRIG_SCAN, LOW);
  pinMode(PIN_ECHO_FWD, INPUT);
  pinMode(PIN_ECHO_SCAN, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_ECHO_FWD),  onEchoFwd,  CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_ECHO_SCAN), onEchoScan, CHANGE);
  ledcSetup(SERVO_CHANNEL, 50, 16);
  ledcAttachPin(PIN_SERVO, SERVO_CHANNEL);
  writeServo(0);                  // a continuous servo idles at "stop", not 0 %

  for (int i = 0; i < TEST_PIN_COUNT; i++) {
    ledcSetup(TEST_CH0 + i, TEST_PWM_HZ, 8);   // 8-bit, so 0-255 maps straight on
    ledcAttachPin(TEST_PINS[i], TEST_CH0 + i);
    ledcWrite(TEST_CH0 + i, 0);
  }

  Serial.begin(115200);
  delay(200);

  Serial.printf("\nESP32 WebSocket DAC — GPIO%d / GPIO%d, enable GPIO%d, "
                "dir GPIO%d/GPIO%d, idle %.2f V (dac %u)\n",
                PIN_DAC_25, PIN_DAC_26, PIN_ENABLE, PIN_REV_25, PIN_REV_26,
                V_IDLE, dacFor(V_IDLE));

  startWifi();

  ws.begin();
  ws.onEvent(onWsEvent);
  Serial.printf("websocket: ws://%s:%u/\n",
                (apMode ? WiFi.softAPIP() : WiFi.localIP()).toString().c_str(),
                WS_PORT);
}

void loop() {
  ws.loop();
  updateOutputs();
  updateReverse();
  updateSonar();

  uint32_t now = millis();

  if (now - lastStatusMs >= STATUS_PERIOD_MS) {
    lastStatusMs = now;
    if (clients) sendStatus();
  }

  if (now - lastLogMs >= LOG_PERIOD_MS) {
    lastLogMs = now;
    Serial.printf("v25=%.2f v26=%.2f en=%d dir=%s clients=%u pkt=%lu bad=%lu %s%s\n",
                  current25, current26, enableOut ? 1 : 0,
                  dirName(revOut),
                  clients, (unsigned long)goodPkts, (unsigned long)badPkts,
                  atIdle ? "(idle)" : "", revBlocked ? " [dir waiting]" : "");
  }

  // Rejoin the wifi if it drops, unless we fell back to AP mode.
  static uint32_t lastCheck = 0;
  if (!apMode && now - lastCheck > 5000) {
    lastCheck = now;
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("wifi lost -> reconnecting");
      forceIdle();
      WiFi.reconnect();
    }
  }
}
