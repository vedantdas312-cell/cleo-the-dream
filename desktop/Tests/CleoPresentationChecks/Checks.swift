// Executable checks also run with Apple Command Line Tools, without XCTest.
@main
struct Checks {
    @MainActor static func main() async throws { try await presentationChecks(); try audioChecks() }
}
