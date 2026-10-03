import SwiftUI

struct ContentView: View {
    @StateObject private var model = RangerModel()
    @AppStorage("host") private var host = "192.168.137.1"
    @AppStorage("role") private var role = "A"

    private var alertText: String {
        switch model.level {
        case "proximate": return "PROXIMATE"
        case "TA": return "TRAFFIC"
        case "RA": return "TOO CLOSE"
        default: return "CLEAR"
        }
    }

    private var background: Color {
        switch model.level {
        case "proximate": return Color(red: 0.55, green: 0.5, blue: 0.1)
        case "TA": return Color(red: 0.8, green: 0.45, blue: 0.05)
        case "RA": return Color(red: 0.75, green: 0.1, blue: 0.1)
        default: return Color(red: 0.05, green: 0.25, blue: 0.15)
        }
    }

    var body: some View {
        ZStack {
            background.ignoresSafeArea()
            VStack(spacing: 20) {
                Text(alertText).font(.title2.bold())
                Text(model.distance.map { String(format: "%.2f m", $0) } ?? "— m")
                    .font(.system(size: 64, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text(model.status).multilineTextAlignment(.center)
                Text(model.serverConnected ? "Server: connected" : "Server: not connected").font(.footnote)
                if !model.uwbSupported {
                    Text("This device does not support precise UWB ranging.").foregroundColor(.yellow)
                }
                Spacer()
                if !model.running {
                    Picker("Phone", selection: $role) {
                        Text("A").tag("A")
                        Text("B").tag("B")
                    }
                    .pickerStyle(.segmented)
                    TextField("Laptop address", text: $host)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numbersAndPunctuation)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                Button(model.running ? "Stop" : "Start") {
                    if model.running { model.stop() } else { model.start(host: host, role: role) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundColor(.black)
            }
            .foregroundColor(.white)
            .padding()
        }
    }
}
