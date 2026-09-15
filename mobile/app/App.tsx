import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ARScannerPreview } from './src/native/ARScanner';
import type { Relay } from './src/types';
import { useScanner } from './src/useScanner';

const C = {
  bg: '#0b0e14',
  panel: '#141a26',
  panel2: '#1b2333',
  line: '#26314a',
  fg: '#e6ecf5',
  muted: '#8b9ab5',
  good: '#4ade80',
  warn: '#fbbf24',
  bad: '#f87171',
  accent: '#38bdf8',
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone ? { color: tone } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function App(): React.JSX.Element {
  const { status, capabilities, relays, error, available, start, stop, setSliceHeight, resetMap } =
    useScanner();

  const [room, setRoom] = useState('demo');
  const [sliceHeight, setSlice] = useState('1.0');
  const [manualURL, setManualURL] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const tracking = status.trackingState === 'normal';
  const connected = status.relayState === 'open';
  const searching = status.discovery === 'searching';

  const chosen: Relay | undefined = useMemo(() => {
    if (relays.length === 0) return undefined;
    if (picked) return relays.find((r) => r.name === picked) ?? relays[0];
    return relays.length === 1 ? relays[0] : undefined;
  }, [relays, picked]);

  const canStart =
    available && (chosen != null || manualURL.trim().length > 0) && !status.running;

  const viewerHint = useMemo(() => {
    const base = chosen?.url ?? manualURL;
    if (!base) return null;
    return `${base.replace(/^ws/, 'http').replace(/\/$/, '')}/viewer.html?room=${room || 'default'}`;
  }, [chosen, manualURL, room]);

  const onToggle = async () => {
    if (status.running) {
      await stop();
      return;
    }
    const h = Number(sliceHeight);
    await start({
      room: room.trim() || 'default',
      sliceHeightM: Number.isFinite(h) ? h : 1.0,
      // Empty means "use whatever discovery found" — the normal path.
      relayURL: manualURL.trim() || (chosen ? chosen.url : undefined),
    });
  };

  const relayLine = (() => {
    if (manualURL.trim()) return `manual · ${manualURL.trim()}`;
    if (chosen) return `${chosen.name} · ${chosen.displayHost}`;
    if (relays.length > 1) return `${relays.length} relays found — pick one`;
    if (searching) return 'searching the network…';
    if (status.discovery === 'failed') return 'local network access blocked';
    return 'no relay found yet';
  })();

  const relayTone = chosen || manualURL.trim() ? C.good : searching ? C.muted : C.warn;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>webscan · ARKit</Text>
          <Text style={styles.subtitle}>
            LiDAR floor mapping. Finds the relay by itself — nothing to type.
          </Text>

          <View style={styles.previewWrap}>
            {available ? (
              <ARScannerPreview style={styles.preview} showFeaturePoints={status.running} />
            ) : (
              <View style={[styles.preview, styles.previewEmpty]}>
                <Text style={styles.muted}>Preview needs a real device</Text>
              </View>
            )}
            {status.running ? (
              <View style={styles.badge}>
                <View style={[styles.dot, { backgroundColor: tracking ? C.good : C.warn }]} />
                <Text style={styles.badgeText}>
                  {tracking ? 'tracking' : status.trackingState}
                </Text>
              </View>
            ) : null}
          </View>

          {capabilities && !capabilities.sceneDepth ? (
            <View style={styles.warnBox}>
              <Text style={styles.warnText}>
                This iPhone has no LiDAR. ARKit tracking still works, but there is no dense
                depth to slice, so the map will be empty. A Pro model is required.
              </Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Relay: discovered, not typed. */}
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>Relay</Text>
              {searching ? <ActivityIndicator size="small" color={C.muted} /> : null}
            </View>
            <Text style={[styles.relayLine, { color: relayTone }]}>{relayLine}</Text>

            {relays.length > 1 && !manualURL.trim() ? (
              <View style={styles.pickList}>
                {relays.map((r) => {
                  const active = chosen?.name === r.name;
                  return (
                    <TouchableOpacity
                      key={r.name}
                      style={[styles.pickRow, active ? styles.pickRowActive : null]}
                      onPress={() => setPicked(r.name)}>
                      <Text style={[styles.pickName, active ? { color: C.accent } : null]}>
                        {r.name}
                      </Text>
                      <Text style={styles.pickHost}>{r.displayHost}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}

            <TouchableOpacity onPress={() => setShowAdvanced((v) => !v)}>
              <Text style={styles.link}>
                {showAdvanced ? 'Hide manual address' : 'Enter an address manually'}
              </Text>
            </TouchableOpacity>
            {showAdvanced ? (
              <>
                <TextInput
                  style={styles.input}
                  value={manualURL}
                  onChangeText={setManualURL}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="ws://192.168.1.20:8443"
                  placeholderTextColor={C.muted}
                  editable={!status.running}
                />
                <Text style={styles.hint}>
                  Only needed where mDNS is blocked — some guest and corporate Wi-Fi drop
                  multicast. Leave empty to use discovery.
                </Text>
              </>
            ) : null}

            <Text style={styles.fieldLabel}>Room</Text>
            <TextInput
              style={styles.input}
              value={room}
              onChangeText={setRoom}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!status.running}
            />
            {viewerHint ? <Text style={styles.hint}>Viewer: {viewerHint}</Text> : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Slice plane</Text>
            <Text style={styles.hint}>
              The map is a horizontal cut through the room. ARKit finds the floor, so this
              height is measured from the floor — not from however you happen to hold the
              phone. Move your hand freely.
            </Text>
            <Text style={styles.fieldLabel}>Height above floor (m)</Text>
            <TextInput
              style={styles.input}
              value={sliceHeight}
              onChangeText={(t) => {
                setSlice(t);
                const v = Number(t);
                if (Number.isFinite(v) && v > 0.1 && v < 3) void setSliceHeight(v);
              }}
              keyboardType="decimal-pad"
            />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Live</Text>
            <Stat label="relay" value={status.relayState} tone={connected ? C.good : C.warn} />
            <Stat label="tracking" value={status.trackingState} tone={tracking ? C.good : C.warn} />
            <Stat
              label="floor"
              value={status.floorFound ? `${status.floorY.toFixed(2)} m` : 'searching…'}
              tone={status.floorFound ? C.good : C.warn}
            />
            <Stat label="slice" value={`${status.sliceHeightM.toFixed(2)} m`} />
            <Stat label="position" value={`${status.x.toFixed(2)}, ${status.z.toFixed(2)}`} />
            <Stat label="heading" value={`${status.yawDeg.toFixed(0)}°`} />
            <Stat label="scans/s" value={status.fps.toFixed(1)} />
            <Stat label="bins" value={`${status.validBins}/256`} />
            <Stat label="slice hits" value={String(status.bandSamples)} />
            <Stat label="sent" value={fmtBytes(status.bytesSent)} />
            <Stat label="skipped (still)" value={String(status.framesSkipped)} />
            <Stat label="dropped" value={String(status.framesDropped)} />
            <Stat label="rtt" value={`${status.rttMs.toFixed(0)} ms`} />
            <Stat
              label="LiDAR"
              value={capabilities ? (capabilities.sceneDepth ? 'yes' : 'no') : '…'}
              tone={capabilities?.sceneDepth ? C.good : C.warn}
            />
            {status.note ? <Text style={styles.hint}>{status.note}</Text> : null}
          </View>

          {/* Profiler — the numbers that tell you where the frame budget goes. */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Profiler</Text>
            <Stat label="slice extract" value={`${status.extractMs.toFixed(2)} ms`} />
            <Stat label="encode" value={`${status.encodeMs.toFixed(3)} ms`} />
            <Stat label="frame total" value={`${status.frameMs.toFixed(2)} ms`} />
            <Stat label="camera format" value={status.videoFormat || '—'} />
            <Stat
              label="plane detection"
              value={status.planeDetectionOn ? 'on' : 'off (floor locked)'}
              tone={status.planeDetectionOn ? C.warn : C.good}
            />
            <Text style={styles.hint}>
              Frame total is our own work, not ARKit's. If it stays well under the send
              interval ({(1000 / 10).toFixed(0)} ms at 10 Hz) the scanner is not the
              bottleneck — the camera, the LiDAR and the radio are.
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.button,
              status.running ? styles.buttonStop : styles.buttonPrimary,
              !canStart && !status.running ? styles.buttonDisabled : null,
            ]}
            onPress={onToggle}
            disabled={!status.running && !canStart}>
            {!capabilities && available ? (
              <ActivityIndicator color={C.bg} />
            ) : (
              <Text
                style={[
                  styles.buttonText,
                  status.running ? styles.buttonTextStop : styles.buttonTextPrimary,
                ]}>
                {status.running
                  ? 'Stop scanning'
                  : chosen || manualURL.trim()
                    ? 'Start scanning'
                    : 'Waiting for a relay…'}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.buttonGhost} onPress={() => void resetMap()}>
            <Text style={styles.buttonGhostText}>Clear map on every viewer</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  flex: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 48 },
  title: { color: C.fg, fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  subtitle: { color: C.muted, fontSize: 13, marginTop: 4, marginBottom: 16 },

  previewWrap: { marginBottom: 14 },
  preview: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  previewEmpty: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(11,14,20,0.82)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  badgeText: { color: C.fg, fontSize: 12 },

  card: {
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: {
    color: C.muted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  relayLine: { fontSize: 14, fontWeight: '600', marginBottom: 10 },
  pickList: { marginBottom: 10 },
  pickRow: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
    backgroundColor: C.panel2,
  },
  pickRowActive: { borderColor: C.accent },
  pickName: { color: C.fg, fontSize: 14, fontWeight: '600' },
  pickHost: { color: C.muted, fontSize: 12, marginTop: 2 },
  link: { color: C.accent, fontSize: 13, marginBottom: 6 },

  fieldLabel: { color: C.muted, fontSize: 12, marginBottom: 4, marginTop: 8 },
  input: {
    backgroundColor: C.panel2,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 10,
    color: C.fg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  hint: { color: C.muted, fontSize: 12, marginTop: 8, lineHeight: 17 },
  muted: { color: C.muted, fontSize: 13 },

  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: 3,
  },
  statLabel: { color: C.muted, fontSize: 13 },
  statValue: { color: C.fg, fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },

  warnBox: { borderLeftWidth: 2, borderLeftColor: C.warn, paddingLeft: 12, marginBottom: 14 },
  warnText: { color: C.warn, fontSize: 13, lineHeight: 18 },
  errorBox: {
    backgroundColor: '#2a1a1f',
    borderWidth: 1,
    borderColor: '#4a2630',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  errorText: { color: '#fecaca', fontSize: 13, lineHeight: 18 },

  button: { borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  buttonPrimary: { backgroundColor: C.accent },
  buttonStop: { backgroundColor: C.panel2, borderWidth: 1, borderColor: '#4a2630' },
  buttonDisabled: { backgroundColor: C.panel2, opacity: 0.6 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  buttonTextPrimary: { color: '#06202e' },
  buttonTextStop: { color: C.bad },
  buttonGhost: { paddingVertical: 12, alignItems: 'center' },
  buttonGhostText: { color: C.muted, fontSize: 13 },
});
