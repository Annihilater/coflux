import CofluxApplePlatform
import CofluxClientCore
import Foundation
import Testing
@testable import Coflux

private struct IntegrationTokenStore: TokenStore {
    func read() throws -> String? { nil }
    func write(_: String) throws {}
    func clear() throws {}
}

@MainActor
private func integrationWaitUntil(
    timeout: Duration,
    _ condition: () -> Bool
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while clock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
}

/// A client composed without any native provider must say so promptly, and the
/// composition the app actually ships must no longer land on that message.
@MainActor
struct DeviceIntegrationTests {
    @Test(.timeLimit(.minutes(1)))
    func remoteDeviceAccessWithoutANativeProviderReportsUnavailable() async throws {
        let client = CofluxClient(
            configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:8787/client")!, buildID: "dev"),
            transport: NetworkFrameworkTransport(), tokenStore: IntegrationTokenStore()
        )
        defer { client.logout() }
        do {
            _ = try await client.listDeviceDirectory(daemonID: "remote", path: "/")
            Issue.record("iOS remote access must not silently use a removed transport")
        } catch {
            #expect(error.localizedDescription.contains("远程设备连接"))
        }
    }

    /// 注入原生 provider 后，失败原因必须变成「中心离线」这种可重试的事实，
    /// 而不是「请使用桌面客户端」——后者一出现就说明 provider 根本没接上。
    @Test(.timeLimit(.minutes(1)))
    func shippedCompositionInjectsTheNativeRemoteProvider() async throws {
        let client = CofluxClient(
            configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:8787/client")!, buildID: "dev"),
            transport: NetworkFrameworkTransport(), tokenStore: IntegrationTokenStore(),
            remoteDeviceProvider: TailcatDeviceTransportProvider(bridge: CofluxTailcatBridge())
        )
        defer { client.logout() }
        do {
            _ = try await client.listDeviceDirectory(daemonID: "remote", path: "/")
            Issue.record("A device RPC without a live control plane must fail")
        } catch {
            #expect(!error.localizedDescription.contains("桌面客户端"))
        }
    }
}
