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

       GPIO16        → L298N IN1   the lift actuator: 1/0 up, 0/1 down, 0/0 coast
       GPIO17        → L298N IN2
       GPIO4         → L298N ENA   PWM speed — take the ENA jumper off
                       L298N GND must be common with the ESP32 and the motor supply
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
// Moved off GPIO18, which sat with two of its four relays latched at boot while
// GPIO19 drove an identical bank cleanly. Both pins measured a clean 3.3 V, so
// if the relays still latch here the pin was never the cause — a 3.3 V high is
// not a reliable "off" for an input stage referenced to 5 V.
//
// GPIO5 is a strapping pin. It carries a weak pull-up at reset, which for an
// active-LOW relay input is the right way to fail — the coil stays off through
// the boot window without an external resistor. The cost is that it is sampled
// at reset and glitches briefly as the ROM starts: do not let anything hold it
// LOW while the board comes up. GPIO27 and GPIO33 are free if that bites.
const int PIN_REV_26 = 5;     // direction relay for the GPIO26 wheel

// ── the lift, through an L298N ───────────────────────────────────────
// One DC actuator that raises and lowers the load, on one half of an L298N:
//
//     IN1, IN2  direction. 1/0 extends, 0/1 retracts, 0/0 coasts.
//     ENA       speed, as PWM. Take the jumper off ENA or it is stuck at full.
//
// The L298N's logic runs off 5 V and its inputs are happy with 3.3 V, so the
// three wires go straight to the ESP32. Grounds must be common — the driver's
// GND, the ESP32's GND and the motor supply's GND — or the inputs float and
// the bridge does whatever it likes.
//
// The drive controllers are analog and the two DACs belong to them; this is a
// bridge, so it wants digital direction and a PWM. That is why the actuator is
// not simply a third throttle channel.
const int PIN_LIFT_IN1 = 16;
const int PIN_LIFT_IN2 = 17;
const int PIN_LIFT_PWM = 4;    // ENA
const int LIFT_PWM_HZ = 1000;  // low enough that a geared actuator does not sing

// Reversing an H-bridge while the motor is still turning throws the winding's
// stored energy back through the bridge. The same rule as the wheel relays,
// for the same reason: pass through zero and wait before going the other way.
const uint32_t LIFT_FLIP_MS = 250;
// An actuator at the end of its travel is a stalled motor drawing locked-rotor
// current, and it will sit there doing that for as long as you hold the button.
// This is the limit switch the cheap ones do not come with: after this long in
// one continuous run the bridge is cut, and it re-arms only on a command of 0.
const uint32_t LIFT_MAX_RUN_MS = 8000;

// ── sonar ────────────────────────────────────────────────────────────
// One HC-SR04, bolted to the front and pointing straight ahead. Change these to
// match your wiring — the board reports them in its status, so the pages follow
// whatever you set here.
//
// HC-SR04 runs at 5 V and its ECHO pin swings to 5 V, which will damage a 3.3 V
// GPIO. Put a divider on the echo line (1k series, 2k to ground gives 3.3 V).
// TRIG is an input on the sensor and is happy with 3.3 V.
const int PIN_TRIG_FWD  = 14;
const int PIN_ECHO_FWD  = 32;

// One ping every 50 ms. Faster and the previous burst is still rattling around
// the room when the next goes out, which reads as a phantom object at whatever
// distance the old echo came from.
const uint32_t PING_PERIOD_MS = 50;
// Sound covers 4 m and back in about 23 ms. Anything still silent after 25 ms
// is not a distant object, it is no object — report nothing, not a big number.
const uint32_t ECHO_TIMEOUT_US = 25000;

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
// 4, 16 and 17 are the L298N's — see PIN_LIFT_* above. A page that could put a
// raw value on ENA while the lift was running would be a second driver for the
// same motor, and the two would not agree.
// 13, 27 and 33 used to be the scanning sensor's servo, trigger and echo. That
// module is gone, so they are ordinary spare pins now, and so is 18 — the
// GPIO26 wheel's direction relay moved off it onto 5, which leaves this list.
const int TEST_PINS[] = { 21, 22, 2, 15, 13, 27, 33, 18 };
const int TEST_PIN_COUNT = sizeof(TEST_PINS) / sizeof(TEST_PINS[0]);
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
volatile uint32_t echoStartFwd = 0;
volatile uint32_t echoUsFwd = 0;
volatile bool     echoNewFwd = false;

float    fwdCm = -1;                       // -1 means "no echo", never 0
uint32_t lastPingMs = 0;
bool     heardFwd = false;

// ── spare-pin state ──────────────────────────────────────────────────
uint8_t  testVal[TEST_PIN_COUNT] = {0};

// The lift. `wantLift` is what the last packet asked for, `liftOut` is what the
// bridge is actually doing — they differ while a direction change passes
// through zero, and while the run limit is holding it off.
int      wantLift = 0;             // -255..255; sign is direction, 0 is coast
int      liftOut  = 0;             // what is on the pins right now
uint32_t liftFlipMs = 0;           // when the pass-through-zero started
uint32_t liftRunMs  = 0;           // when this continuous run started
bool     liftCut    = false;       // the run limit fired; needs a 0 to re-arm

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
  ledcWrite(gpio, v);           // 8-bit resolution: the value IS the duty
  return true;
}

/** Everything back to 0. Called on stop, on idle, and when the last client goes. */
void clearTestPins() {
  for (int i = 0; i < TEST_PIN_COUNT; i++) {
    testVal[i] = 0;
    ledcWrite(TEST_PINS[i], 0);
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

/** Microseconds of round trip -> centimetres. 343 m/s, there and back. */
float cmFromUs(uint32_t us) {
  if (us == 0 || us > ECHO_TIMEOUT_US) return -1;
  float cm = us / 58.0f;
  return (cm < 2 || cm > 400) ? -1 : cm;    // outside the sensor's real range
}

/** Fire the sensor and collect whatever came back. */
void updateSonar() {
  // Collect whatever the interrupts caught since last time.
  if (echoNewFwd) {
    noInterrupts(); uint32_t u = echoUsFwd; echoNewFwd = false; interrupts();
    fwdCm = cmFromUs(u);
    heardFwd = true;
  }

  uint32_t now = millis();
  if (now - lastPingMs < PING_PERIOD_MS) return;
  lastPingMs = now;

  // Silence is a real answer, and the one that matters most: an object too soft
  // or too angled to echo reads the same as an empty room, and leaving the
  // previous distance sitting there would make it look live. So a sensor that
  // said nothing since its last ping is cleared before the next one goes out.
  if (!heardFwd) fwdCm = -1;
  heardFwd = false;

  digitalWrite(PIN_TRIG_FWD, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG_FWD, HIGH);
  delayMicroseconds(10);          // the datasheet's 10 us burst
  digitalWrite(PIN_TRIG_FWD, LOW);
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

/* Put a signed value on the bridge. Sign picks the direction pins, magnitude
   is the PWM. Zero drops both inputs, which coasts rather than brakes — a
   loaded actuator braked hard is a shock through the gearbox, and it holds its
   position on the screw anyway. */
void writeLift(int v) {
  v = constrain(v, -255, 255);
  liftOut = v;
  digitalWrite(PIN_LIFT_IN1, v > 0 ? HIGH : LOW);
  digitalWrite(PIN_LIFT_IN2, v < 0 ? HIGH : LOW);
  ledcWrite(PIN_LIFT_PWM, (uint32_t)abs(v));
}

/* The lift's own interlock, run once per loop.

   Three things can stop it, and all three are the same shape as the wheel
   relays: never reverse under load, never run past the end of the travel, and
   never keep running because nobody said stop. The third one is not here — it
   is the link watchdog in updateOutputs(), which the lift shares precisely
   because it is movement. */
void updateLift() {
  uint32_t now = millis();

  // Asked for zero: that clears the run limit as well. The button was let go,
  // so the next press starts a fresh run.
  if (wantLift == 0) {
    liftCut = false;
    liftRunMs = 0;
    if (liftOut != 0) writeLift(0);
    return;
  }
  if (liftCut) { if (liftOut != 0) writeLift(0); return; }

  // Direction change: through zero, and wait there.
  const bool flipping = (liftOut > 0 && wantLift < 0) || (liftOut < 0 && wantLift > 0);
  if (flipping) {
    writeLift(0);
    liftFlipMs = now;
    liftRunMs = 0;
    return;
  }
  if (liftFlipMs && now - liftFlipMs < LIFT_FLIP_MS) return;
  liftFlipMs = 0;

  if (liftRunMs == 0) liftRunMs = now;
  if (now - liftRunMs >= LIFT_MAX_RUN_MS) {
    liftCut = true;
    writeLift(0);
    Serial.println("lift: run limit — released. Let go and press again.");
    return;
  }
  if (liftOut != wantLift) writeLift(wantLift);
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
  // The lift stops with everything else. It is the one output on this board
  // that can still be doing work while the wheels are stopped, which is exactly
  // why forgetting it here would be the bug that matters.
  wantLift = 0;
  liftRunMs = 0;
  liftCut = false;
  writeLift(0);
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

  updateLift();

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
  JsonObject sp = son["pin"].to<JsonObject>();
  sp["trig_f"] = PIN_TRIG_FWD;
  sp["echo_f"] = PIN_ECHO_FWD;
  doc["lift"]     = liftOut;        // what the bridge is doing, not what was asked
  doc["lift_set"] = wantLift;
  doc["lift_cut"] = liftCut;        // run limit fired; let go to re-arm
  JsonArray liftPin = doc["lift_pin"].to<JsonArray>();
  liftPin.add(PIN_LIFT_IN1);
  liftPin.add(PIN_LIFT_IN2);
  liftPin.add(PIN_LIFT_PWM);
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
  // Same rule for the lift, and for a better reason: this one moves a load.
  // Absent means stop, so a client that never mentions the lift cannot leave it
  // running, and a client that stops sending stops the actuator by the same
  // 300 ms watchdog that stops the wheels.
  wantLift = doc["lift"].is<int>() ? constrain(doc["lift"].as<int>(), -255, 255) : 0;
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

  // Before Serial, like the relays and for the same reason: until pinMode runs
  // these are inputs, and a floating IN1/IN2 pair on an L298N is a coin toss.
  pinMode(PIN_LIFT_IN1, OUTPUT);   digitalWrite(PIN_LIFT_IN1, LOW);
  pinMode(PIN_LIFT_IN2, OUTPUT);   digitalWrite(PIN_LIFT_IN2, LOW);
  ledcAttach(PIN_LIFT_PWM, LIFT_PWM_HZ, 8);
  ledcWrite(PIN_LIFT_PWM, 0);

  pinMode(PIN_TRIG_FWD, OUTPUT);   digitalWrite(PIN_TRIG_FWD, LOW);
  pinMode(PIN_ECHO_FWD, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_ECHO_FWD), onEchoFwd, CHANGE);

  for (int i = 0; i < TEST_PIN_COUNT; i++) {
    ledcAttach(TEST_PINS[i], TEST_PWM_HZ, 8);  // 8-bit, so 0-255 maps straight on
    ledcWrite(TEST_PINS[i], 0);
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
