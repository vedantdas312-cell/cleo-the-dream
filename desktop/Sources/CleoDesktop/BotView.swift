import AppKit
import SwiftUI

@MainActor
final class BotState: ObservableObject {
    @Published var status = "Ready · mic off"
    @Published var gaze: CGFloat = 0
    @Published var isBusy = false
}

// Native presentation of the approved companion: a quiet face and status only.
// Status remains owned by the existing voice/screen flow, never by the animation.
struct BotView: View {
    @ObservedObject var state: BotState

    private var label: String {
        switch state.status {
        case "Listening · mic on": return "Cleo is listening"
        case "Thinking · mic on": return "Cleo is thinking"
        case "Cleo speaking": return "Cleo is speaking"
        default: return state.status
        }
    }

    private var animated: Bool {
        state.isBusy || state.status.contains("mic on") || state.status == "Cleo speaking"
    }

    var body: some View {
        HStack(spacing: 6) {
            ZStack {
                Circle().fill(Color(red: 0.09, green: 0.09, blue: 0.10))
                HStack(spacing: 6) {
                    Capsule().fill(Color(white: 0.96)).frame(width: 6, height: 14)
                    Capsule().fill(Color(white: 0.96)).frame(width: 6, height: 14)
                }.offset(x: state.gaze)
            }
            .frame(width: 48, height: 48)
            .accessibilityHidden(true)

            HStack(spacing: 7) {
                CompanionDots(active: animated, working: state.isBusy || state.status == "Thinking · mic on")
                    .frame(width: 20, height: 20).accessibilityHidden(true)
                Text(label).font(.system(size: 12))
                    .lineLimit(1).truncationMode(.tail)
                    .help(state.status)
            }
            .padding(.leading, 8).padding(.trailing, 14).frame(height: 36)
            .foregroundStyle(Color(white: 0.79))
            .background(Color(red: 0.106, green: 0.114, blue: 0.118), in: Capsule())
            .overlay(Capsule().strokeBorder(Color(white: 0.29).opacity(0.8), lineWidth: 1))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .accessibilityValue(state.status)
            Spacer(minLength: 0)
        }
        .padding(6)
        .frame(width: 390, height: 60)
        .shadow(color: .black.opacity(0.14), radius: 5, y: 3)
    }
}

// A small native dotted sphere; it never drives speech or sketch timing.
private struct CompanionDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let active: Bool
    let working: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || !active)) { timeline in
            Canvas { context, size in
                let time = reduceMotion || !active ? 0 : timeline.date.timeIntervalSinceReferenceDate
                let angle = time * (working ? 0.8 : 0.25)
                let radius = min(size.width, size.height) * 0.42
                for index in 0..<42 {
                    let y = 1 - 2 * (Double(index) + 0.5) / 42
                    let ring = sqrt(1 - y * y)
                    let longitude = Double(index) * 2.399963229728653 + angle
                    let x = cos(longitude) * ring
                    let depth = sin(longitude) * ring
                    let pulse = 1 + 0.04 * sin(time * 2 + y * 3)
                    let diameter = 0.85 + (depth + 1) * 0.3
                    let point = CGRect(x: size.width / 2 + x * radius * pulse - diameter / 2,
                                       y: size.height / 2 + y * radius * pulse - diameter / 2,
                                       width: diameter, height: diameter)
                    context.fill(Path(ellipseIn: point), with: .color(.white.opacity(0.25 + (depth + 1) * 0.27)))
                }
            }
        }
    }
}
