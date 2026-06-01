// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComicalHostIOS",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "ComicalHostIOS", targets: ["ComicalHostIOS"]),
    ],
    targets: [
        .target(
            name: "ComicalHostIOS",
            path: "Sources/ComicalHostIOS",
            resources: [
                // The runtime harness is bundled as a resource and evaluated on startup.
                .copy("Resources")
            ]
        ),
        .testTarget(
            name: "ComicalHostIOSTests",
            dependencies: ["ComicalHostIOS"],
            path: "Tests/ComicalHostIOSTests"
        ),
    ]
)
