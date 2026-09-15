import Foundation

/// WebSocket link to the Node relay.
///
/// Same contract the browser sender honours: binary frames carry scans, text
/// frames carry JSON control messages, and the client drops frames rather than
/// queueing when the uplink cannot keep up. A phone's upstream is the narrowest
/// part of the pipeline; a growing queue does not "catch up later", it just
/// pushes the viewer further into the past until something gives out.
///
/// At ~560 bytes per scan and 10 Hz that is 5.6 KB/s, so backpressure is rarely
/// the binding constraint here — but the guard costs nothing and the failure it
/// prevents is the kind that only shows up on a bad hotel Wi-Fi.
final class RelayClient: NSObject {

    enum State: String {
        case idle, connecting, open, closed
    }

    struct Stats {
        var framesSent: Int = 0
        var framesDropped: Int = 0
        var bytesSent: Int = 0
        var rttMs: Double = 0
    }

    private(set) var state: State = .idle {
        didSet { if oldValue != state { onState?(state) } }
    }
    private var _stats = Stats()
    /// Snapshot, taken on the serial queue — the counters are written from the
    /// URLSession completion handlers and read from the AR delegate queue.
    var stats: Stats { queue.sync { _stats } }

    var onState: ((State) -> Void)?
    var onError: ((String) -> Void)?

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var url: URL?
    private var room: String = "default"

    /// Sends handed to URLSession that have not completed yet.
    private var inFlight = 0
    private let maxInFlight = 6

    private var shouldReconnect = false
    private var reconnectAttempt = 0
    private var pingTimer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "webscan.relay")

    override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    // MARK: - Lifecycle

    /// - Parameter baseURL: e.g. `wss://scan.example.com` or `ws://192.168.1.20:8443`
    func connect(baseURL: String, room: String) {
        self.room = room
        guard var components = URLComponents(string: baseURL) else {
            onError?("Malformed relay URL: \(baseURL)")
            return
        }
        // Accept http(s) for convenience and upgrade it to the ws(s) scheme.
        switch components.scheme {
        case "http": components.scheme = "ws"
        case "https": components.scheme = "wss"
        default: break
        }
        components.path = "/ws"
        components.queryItems = [
            URLQueryItem(name: "room", value: room),
            URLQueryItem(name: "role", value: "sender"),
            URLQueryItem(name: "label", value: "iPhone ARKit"),
        ]
        guard let url = components.url else {
            onError?("Could not build relay URL from: \(baseURL)")
            return
        }
        self.url = url
        shouldReconnect = true
        reconnectAttempt = 0
        openSocket()
    }

    func disconnect() {
        shouldReconnect = false
        stopPing()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .closed
    }

    private func openSocket() {
        guard let url else { return }
        state = .connecting
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receiveLoop()
    }

    private func scheduleReconnect() {
        guard shouldReconnect else { return }
        stopPing()
        reconnectAttempt += 1
        // Back off, but stay responsive: a scan session is interactive and the
        // usual cause is the operator walking out of Wi-Fi range for a moment.
        let delay = min(8.0, pow(1.6, Double(reconnectAttempt)) * 0.4)
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.shouldReconnect else { return }
            self.openSocket()
        }
    }

    // MARK: - Receiving

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                if self.shouldReconnect {
                    self.onError?(error.localizedDescription)
                    self.state = .closed
                    self.scheduleReconnect()
                }
            case .success(let message):
                if case .string(let text) = message { self.handleControl(text) }
                self.receiveLoop()
            }
        }
    }

    private func handleControl(_ text: String) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }

        switch type {
        case "pong":
            if let t = object["t"] as? Double {
                let rtt = Date().timeIntervalSince1970 * 1000 - t
                queue.sync { _stats.rttMs = rtt }
            }
        case "error":
            onError?(object["message"] as? String ?? "relay error")
        default:
            break
        }
    }

    // MARK: - Sending

    func sendScan(_ data: Data) {
        guard state == .open, let task else {
            queue.sync { _stats.framesDropped += 1 }
            return
        }
        var dropped = false
        queue.sync {
            if inFlight >= maxInFlight {
                dropped = true
                _stats.framesDropped += 1
            } else {
                inFlight += 1
            }
        }
        if dropped { return }

        task.send(.data(data)) { [weak self] error in
            guard let self else { return }
            self.queue.sync {
                self.inFlight -= 1
                if error == nil {
                    self._stats.framesSent += 1
                    self._stats.bytesSent += data.count
                }
            }
            if let error { self.onError?(error.localizedDescription) }
        }
    }

    func sendControl(_ object: [String: Any]) {
        guard state == .open, let task,
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    func sendSenderState(active: Bool, note: String? = nil) {
        var payload: [String: Any] = [
            "type": "sender-state",
            "active": active,
            "mode": "map2d",
            // ARKit depth is metric by construction — there is nothing to
            // calibrate, unlike the browser pipeline's floor step.
            "calibrated": true,
        ]
        if let note { payload["note"] = note }
        sendControl(payload)
    }

    func sendReset() {
        sendControl(["type": "reset"])
    }

    private func startPing() {
        stopPing()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self, self.state == .open else { return }
            self.sendControl(["type": "ping", "t": Date().timeIntervalSince1970 * 1000])
        }
        timer.resume()
        pingTimer = timer
    }

    private func stopPing() {
        pingTimer?.cancel()
        pingTimer = nil
    }
}

extension RelayClient: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        reconnectAttempt = 0
        queue.sync { inFlight = 0 }
        state = .open
        sendControl(["type": "hello", "role": "sender", "room": room, "label": "iPhone ARKit"])
        startPing()
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        state = .closed
        scheduleReconnect()
    }
}
