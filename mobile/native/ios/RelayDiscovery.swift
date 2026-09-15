import Foundation
import Network

/// Finds the relay on the local network, so nobody has to type an IP address.
///
/// The relay advertises `_webscan._tcp` over mDNS (see `lidar_discovery.js` in tetym-rover).
/// This browses for it, resolves the winner to a host and port, and hands back a
/// ready-made WebSocket URL.
///
/// DESIGN
///  * The TXT record says whether the relay is TLS and what the WebSocket path
///    is. Read them — do not assume `ws` on 8443, because the same relay behind
///    a tunnel is `wss` on 443.
///  * Exactly one relay is the normal case, and then there is nothing to
///    choose: the caller connects immediately. A picker only appears when the
///    network genuinely has more than one.
///  * The last relay that worked is remembered. If it reappears it wins, so a
///    second phone in a room with two relays keeps talking to the same one.
///
/// iOS 14+ gates all of this behind the local-network permission prompt. The
/// first browse is what triggers it, and a denial surfaces here as a browser
/// failure rather than an empty result — worth telling the user apart, because
/// "nothing found" and "you said no" need different advice.
final class RelayDiscovery {

    struct Relay: Equatable {
        /// Bonjour instance name, e.g. "webscan on Ali-MacBook".
        let name: String
        let host: String
        let port: UInt16
        let tls: Bool
        let path: String

        var url: String { "\(tls ? "wss" : "ws")://\(host):\(port)" }

        var displayHost: String { "\(host):\(port)" }
    }

    enum State: Equatable {
        case idle
        case searching
        /// Browsing works but nothing is advertising yet.
        case none
        case found([Relay])
        case failed(String)
    }

    private(set) var state: State = .idle {
        didSet { if oldValue != state { onChange?(state) } }
    }

    var onChange: ((State) -> Void)?

    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "webscan.discovery")
    private var pending: [String: NWConnection] = [:]
    private var resolved: [String: Relay] = [:]

    private static let lastRelayKey = "webscan.lastRelayName"

    // MARK: - Lifecycle

    func start() {
        stop()
        state = .searching

        // `.bonjourWithTXTRecord` delivers the TXT alongside each result, which
        // saves a second round trip just to learn the scheme and path.
        let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(type: "_webscan._tcp", domain: nil)
        let parameters = NWParameters()
        parameters.includePeerToPeer = false

        let browser = NWBrowser(for: descriptor, using: parameters)
        self.browser = browser

        browser.stateUpdateHandler = { [weak self] browserState in
            guard let self else { return }
            switch browserState {
            case .failed(let error):
                self.state = .failed(Self.describe(error))
            case .cancelled:
                break
            default:
                break
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            self?.handle(results: results)
        }

        browser.start(queue: queue)
    }

    func stop() {
        browser?.cancel()
        browser = nil
        for (_, connection) in pending { connection.cancel() }
        pending.removeAll()
        resolved.removeAll()
        state = .idle
    }

    /// Remember the relay that actually worked, so it wins next time.
    func remember(_ relay: Relay) {
        UserDefaults.standard.set(relay.name, forKey: Self.lastRelayKey)
    }

    /// Preferred pick from what is currently visible: the remembered relay if
    /// it is here, otherwise the only one, otherwise nothing (let the user choose).
    static func preferred(from relays: [Relay]) -> Relay? {
        if relays.isEmpty { return nil }
        let remembered = UserDefaults.standard.string(forKey: lastRelayKey)
        if let remembered, let match = relays.first(where: { $0.name == remembered }) {
            return match
        }
        return relays.count == 1 ? relays[0] : nil
    }

    // MARK: - Browse + resolve

    private func handle(results: Set<NWBrowser.Result>) {
        var seen = Set<String>()

        for result in results {
            guard case let .service(name, type, domain, _) = result.endpoint else { continue }
            seen.insert(name)

            var tls = false
            var path = "/ws"
            if case let .bonjour(txt) = result.metadata {
                if let value = txt["tls"] { tls = (value == "1" || value.lowercased() == "true") }
                if let value = txt["path"], !value.isEmpty { path = value }
            }

            if let existing = resolved[name] {
                // Already have host:port; only the TXT can have changed.
                if existing.tls != tls || existing.path != path {
                    resolved[name] = Relay(name: name, host: existing.host, port: existing.port,
                                           tls: tls, path: path)
                    publish()
                }
                continue
            }
            if pending[name] != nil { continue }

            resolve(name: name, type: type, domain: domain, tls: tls, path: path)
        }

        // Drop relays that went away, so a stopped server disappears from the
        // picker instead of sitting there failing to connect.
        let vanished = resolved.keys.filter { !seen.contains($0) }
        if !vanished.isEmpty {
            for name in vanished { resolved.removeValue(forKey: name) }
            publish()
        }
        for name in pending.keys where !seen.contains(name) {
            pending[name]?.cancel()
            pending.removeValue(forKey: name)
        }
        if results.isEmpty && resolved.isEmpty && pending.isEmpty {
            state = .none
        }
    }

    /// A Bonjour name is not a URL. URLSessionWebSocketTask needs a host and a
    /// port, and the only supported way to get them is to open a connection to
    /// the service endpoint and read back the path it resolved to.
    private func resolve(name: String, type: String, domain: String, tls: Bool, path: String) {
        let endpoint = NWEndpoint.service(name: name, type: type, domain: domain, interface: nil)

        let parameters = NWParameters.tcp
        // Force IPv4. Link-local IPv6 addresses carry a %interface suffix that
        // does not survive being put in a URL, and every relay we care about is
        // dual-stack anyway.
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }

        let connection = NWConnection(to: endpoint, using: parameters)
        pending[name] = connection

        connection.stateUpdateHandler = { [weak self, weak connection] connectionState in
            guard let self, let connection else { return }
            switch connectionState {
            case .ready:
                defer {
                    connection.cancel()
                    self.pending.removeValue(forKey: name)
                }
                guard case let .hostPort(host, port) = connection.currentPath?.remoteEndpoint else { return }
                self.resolved[name] = Relay(name: name,
                                            host: Self.hostString(host),
                                            port: port.rawValue,
                                            tls: tls,
                                            path: path)
                self.publish()
            case .failed, .cancelled:
                self.pending.removeValue(forKey: name)
                if self.resolved.isEmpty && self.pending.isEmpty {
                    self.state = .none
                }
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func publish() {
        let relays = resolved.values.sorted { $0.name < $1.name }
        state = relays.isEmpty ? .none : .found(relays)
    }

    private static func hostString(_ host: NWEndpoint.Host) -> String {
        switch host {
        case .ipv4(let address):
            return "\(address)"
        case .ipv6(let address):
            // Strip the zone id and bracket it, or the URL will not parse.
            let text = "\(address)".split(separator: "%").first.map(String.init) ?? "\(address)"
            return "[\(text)]"
        case .name(let name, _):
            return name
        @unknown default:
            return "\(host)"
        }
    }

    private static func describe(_ error: NWError) -> String {
        // The one failure worth naming precisely: iOS asks once, and if the
        // answer was no, nothing will ever be found and the UI should say why.
        if case let .posix(code) = error, code == .EPERM || code == .EACCES {
            return "Local network access is off. Settings → Privacy & Security → Local Network."
        }
        return error.localizedDescription
    }
}
