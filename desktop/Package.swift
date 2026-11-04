// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CleoDesktop",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "CleoDesktop", targets: ["CleoDesktop"])],
    targets: [
        .target(name: "CleoPresentation"),
        .executableTarget(name: "CleoDesktop", dependencies: ["CleoPresentation"]),
        .executableTarget(name: "CleoPresentationChecks", dependencies: ["CleoPresentation"], path: "Tests/CleoPresentationChecks")
    ]
)
