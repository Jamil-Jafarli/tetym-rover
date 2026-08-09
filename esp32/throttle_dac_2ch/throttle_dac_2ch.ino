/* ═══════════════════════════════════════════════════════════════════════
   RPi → ESP32 throttle DAC — TWO CHANNELS

   This is your throttle_dac.ino extended from one throttle wire to two, so
   the Pi can drive the left and right motor controllers independently. That
   difference is the steering: both high = forward, left lower = turn left,
   right lower = turn right.

   Everything that made the original safe is unchanged:
     * idle is 1.00 V, never 0 V — the controller reads that as zero throttle
     * idle is what we output on boot and whenever the link goes quiet
     * 300 ms link watchdog
     * framed packets with a header byte so a desynced stream can resync

   Wire format (both accepted; the header says which):
     0xA5 | float32 v  LE          | XOR csum   legacy, one value → BOTH DACs
     0xA6 | float32 vL | float32 vR | XOR csum   dual channel
   csum = 0x5A XOR'd over every payload byte. Must match rpi/esp.py.

   Wiring:
     ESP32 USB    ↔ Raspberry Pi USB   (/dev/ttyUSB0) — control + debug
     ESP32 GPIO25 (DAC1) → LEFT  controller throttle signal wire
     ESP32 GPIO26 (DAC2) → RIGHT controller throttle signal wire
     ESP32 GND           → both controller GNDs   (required, common ground)

   The link stays full duplex: setpoint packets in, plain text debug out.
   ═══════════════════════════════════════════════════════════════════════ */

#include <Arduino.h>

// ───────────────────────────── CONFIG
const int PIN_DAC_L = 25;    // DAC1 → LEFT  controller throttle
const int PIN_DAC_R = 26;    // DAC2 → RIGHT controller throttle

const float V_IDLE = 1.00f;  // zero-throttle resting level
const float V_MIN  = 1.00f;  // never output below idle
const float V_MAX  = 3.30f;
const float V_REF  = 3.30f;  // DAC full scale (= VDD)

const uint32_t LINK_TIMEOUT_MS = 300;   // no valid packet → fall back to idle
const uint32_t LOG_PERIOD_MS   = 500;

// Slew limit, volts per second, applied per channel. The line follower can
// swing the setpoint hard at 20-30 Hz; ramping protects the drivetrain and
// keeps the chassis from lurching. Raise it if the robot feels sluggish.
const float V_SLEW_PER_S = 6.0f;

const uint8_t FRAME_1CH  = 0xA5;   // legacy single value
const uint8_t FRAME_2CH  = 0xA6;   // left + right
const uint8_t CSUM_SEED  = 0x5A;

// ───────────────────────────── STATE
float    targetL = V_IDLE, targetR = V_IDLE;   // commanded
float    currentL = V_IDLE, currentR = V_IDLE; // after slew limiting
bool     atIdle       = true;
uint32_t lastPacketMs = 0;
uint32_t lastLogMs    = 0;
uint32_t lastSlewMs   = 0;

// Diagnostics: raw bytes seen on the link vs. packets that actually validated.
// rx=0 means nothing is arriving at all (cable); rx>0 with pkt=0 means the
// bytes arrive but the framing or baud is wrong.
uint32_t rxBytes  = 0;
uint32_t goodPkts = 0;
uint32_t badCsum  = 0;

enum RxState { WAIT_HEADER, READ_PAYLOAD, READ_CSUM };
RxState rxState    = WAIT_HEADER;
uint8_t payload[8];
int     payloadLen = 0;
int     payloadWant = 0;
uint8_t frameKind  = 0;

// ───────────────────────────── DAC
uint8_t dacFor(float v) {
  v = constrain(v, V_MIN, V_MAX);
  long d = lroundf(v / V_REF * 255.0f);
  return (uint8_t)constrain(d, 0L, 255L);
}

void writeChannels() {
  dacWrite(PIN_DAC_L, dacFor(currentL));
  dacWrite(PIN_DAC_R, dacFor(currentR));
}

/* Jump straight to a level with no ramp — used for idle, boot and watchdog,
   where waiting for a ramp would be exactly the wrong thing. */
void forceVoltage(float vl, float vr) {
  targetL  = currentL = constrain(vl, V_MIN, V_MAX);
  targetR  = currentR = constrain(vr, V_MIN, V_MAX);
  writeChannels();
}

void setTarget(float vl, float vr) {
  targetL = constrain(vl, V_MIN, V_MAX);
  targetR = constrain(vr, V_MIN, V_MAX);
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
  if (maxStep <= 0.0f) return;

  currentL = slew(currentL, targetL, maxStep);
  currentR = slew(currentR, targetR, maxStep);
  writeChannels();
}

// ───────────────────────────── LINK
void applyPayload() {
  float vl, vr;
  if (frameKind == FRAME_2CH) {
    memcpy(&vl, payload,     sizeof(vl));
    memcpy(&vr, payload + 4, sizeof(vr));
  } else {
    memcpy(&vl, payload, sizeof(vl));
    vr = vl;                     // legacy single-channel: both wheels alike
  }
  if (isnan(vl) || isinf(vl) || isnan(vr) || isinf(vr)) return;

  setTarget(vl, vr);             // clamps to [V_MIN, V_MAX]
  atIdle       = false;
  lastPacketMs = millis();
  goodPkts++;
}

void pollLink() {
  while (Serial.available()) {
    uint8_t b = (uint8_t)Serial.read();
    rxBytes++;

    switch (rxState) {
      case WAIT_HEADER:
        if (b == FRAME_1CH || b == FRAME_2CH) {
          frameKind   = b;
          payloadWant = (b == FRAME_2CH) ? 8 : 4;
          payloadLen  = 0;
          rxState     = READ_PAYLOAD;
        }
        break;

      case READ_PAYLOAD:
        payload[payloadLen++] = b;
        if (payloadLen == payloadWant) rxState = READ_CSUM;
        break;

      case READ_CSUM: {
        uint8_t want = CSUM_SEED;
        for (int i = 0; i < payloadWant; i++) want ^= payload[i];
        if (b == want) applyPayload();
        else           badCsum++;
        rxState = WAIT_HEADER;            // resync either way
        break;
      }
    }
  }
}

// ───────────────────────────── SETUP / LOOP
void setup() {
  Serial.begin(115200);   // control link from the Pi + debug output
  forceVoltage(V_IDLE, V_IDLE);   // before anything else, so the pins never float
  lastPacketMs = millis();
  lastSlewMs   = millis();
  Serial.printf("throttle DAC ready — L=GPIO%d R=GPIO%d, idle %.2f V (dac %u)\n",
                PIN_DAC_L, PIN_DAC_R, V_IDLE, dacFor(V_IDLE));
}

void loop() {
  pollLink();

  // Watchdog: if the Pi stops talking, drop to idle rather than holding the
  // last commanded throttle indefinitely.
  if (!atIdle && millis() - lastPacketMs > LINK_TIMEOUT_MS) {
    forceVoltage(V_IDLE, V_IDLE);
    atIdle = true;
    Serial.println("link timeout → idle");
  } else {
    updateOutputs();
  }

  if (millis() - lastLogMs >= LOG_PERIOD_MS) {
    lastLogMs = millis();
    // v=/dac= repeat the left channel so the original panel's parser still
    // works; vL/vR/dacL/dacR carry the full picture.
    Serial.printf("v=%.2f dac=%u rx=%lu pkt=%lu bad=%lu vL=%.2f vR=%.2f "
                  "dacL=%u dacR=%u %s\n",
                  currentL, dacFor(currentL), rxBytes, goodPkts, badCsum,
                  currentL, currentR, dacFor(currentL), dacFor(currentR),
                  atIdle ? "(idle)" : "");
  }
}
