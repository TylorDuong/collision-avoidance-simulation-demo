import Foundation
import NearbyInteraction
import UIKit

/// Ranges the other phone over UWB (Nearby Interaction) and reports it to the laptop.
///
/// The laptop relays each phone's NIDiscoveryToken to the other (ws://<host>:8080/uwb, see
/// server/uwb.js). Each phone then runs an NINearbyPeerConfiguration with the peer's token
/// and sends the measured distance back. Everything runs on the main queue.
final class RangerModel: NSObject, ObservableObject, NISessionDelegate {
    @Published var status = "Not started"
    @Published var distance: Float?
    @Published var level = "other"
    @Published var serverConnected = false
    @Published var running = false
    let uwbSupported = NISession.deviceCapabilities.supportsPreciseDistanceMeasurement

    private var host = ""
    private var role = "A"
    private var ws: URLSessionWebSocketTask?
    private var session: NISession?
    private var peerToken: String?
    private var pingTimer: Timer?
    private var reconnectPending = false

    // MARK: lifecycle

    func start(host: String, role: String) {
        guard !running else { return }
        self.host = host.trimmingCharacters(in: .whitespaces)
        self.role = role
        running = true
        status = "Connecting…"
        UIApplication.shared.isIdleTimerDisabled = true
        connectSocket()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.ping() }
    }

    func stop() {
        running = false
        pingTimer?.invalidate()
        pingTimer = nil
        ws?.cancel(with: .goingAway, reason: nil)
        ws = nil
        session?.invalidate()
        session = nil
        peerToken = nil
        distance = nil
        serverConnected = false
        status = "Stopped"
        UIApplication.shared.isIdleTimerDisabled = false
    }

    // MARK: server link

    private func connectSocket() {
        ws?.cancel(with: .goingAway, reason: nil)
        guard let url = URL(string: "ws://\(host):8080/uwb") else {
            status = "Bad server address"
            running = false
            return
        }
        let task = URLSession.shared.webSocketTask(with: url)
        ws = task
        task.resume()
        sendJSON(["t": "hello", "role": "uwb", "id": role])
        receive(task)
        if session == nil { newSession() } else { sendToken() }
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self, task === self.ws else { return }
                switch result {
                case .failure:
                    self.serverConnected = false
                    self.status = "Server unreachable, retrying…"
                    self.scheduleReconnect()
                case .success(let message):
                    self.serverConnected = true
                    if case .string(let text) = message { self.handle(text) }
                    self.receive(task)
                }
            }
        }
    }

    private func ping() {
        guard running, let task = ws else { return }
        task.sendPing { [weak self] error in
            guard error != nil else { return }
            DispatchQueue.main.async {
                guard let self = self, task === self.ws else { return }
                self.serverConnected = false
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        guard running, !reconnectPending else { return }
        reconnectPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self else { return }
            self.reconnectPending = false
            if self.running { self.connectSocket() }
        }
    }

    private func sendJSON(_ object: [String: Any]) {
        guard let task = ws,
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = msg["t"] as? String else { return }
        switch type {
        case "peerToken":
            if let token = msg["data"] as? String {
                peerToken = token
                runPeer()
            }
        case "alert":
            if let l = msg["level"] as? String { level = l }
        default:
            break
        }
    }

    // MARK: UWB

    private func newSession() {
        session?.invalidate()
        let s = NISession()
        s.delegate = self
        s.delegateQueue = .main
        session = s
        distance = nil
        sendToken()
        if peerToken != nil {
            runPeer()
        } else {
            status = "Waiting for the other phone…"
        }
    }

    private func sendToken() {
        guard let token = session?.discoveryToken,
              let data = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true) else { return }
        sendJSON(["t": "token", "data": data.base64EncodedString()])
    }

    private func runPeer() {
        guard let s = session,
              let b64 = peerToken,
              let data = Data(base64Encoded: b64),
              let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self, from: data) else { return }
        s.run(NINearbyPeerConfiguration(peerToken: token))
        status = "Ranging… bring the phones together"
    }

    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard session === self.session, let object = nearbyObjects.first, let d = object.distance else { return }
        distance = d
        status = "Ranging"
        var msg: [String: Any] = ["t": "range", "distance": Double(d)]
        if let dir = object.direction { msg["direction"] = [Double(dir.x), Double(dir.y), Double(dir.z)] }
        sendJSON(msg)
    }

    func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject], reason: NINearbyObject.RemovalReason) {
        guard session === self.session else { return }
        distance = nil
        if reason == .timeout {
            status = "Lost the other phone, retrying…"
            runPeer()
        } else {
            status = "Other phone left"
        }
    }

    func sessionWasSuspended(_ session: NISession) {
        status = "Suspended (keep the app in the foreground)"
    }

    func sessionSuspensionEnded(_ session: NISession) {
        runPeer()
    }

    func session(_ session: NISession, didInvalidateWith error: Error) {
        guard session === self.session else { return }
        if let e = error as? NIError, e.code == .userDidNotAllow {
            status = "Nearby Interaction not allowed. Enable it in Settings > UWB Ranger."
            return
        }
        status = "UWB session ended, restarting…"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            if self?.running == true { self?.newSession() }
        }
    }
}
