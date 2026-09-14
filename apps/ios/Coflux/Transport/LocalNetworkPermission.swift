import Foundation
import Network

/// iOS 不提供显式申请「本地网络」授权的 API：系统只在 app 首次真正访问本地网络时才询问，
/// 没有可调用的 request 方法（Apple 只给了事后判断被拒的 `nw_path_unsatisfied_reason_local_network_denied`）。
///
/// Tailcat 探测局域网直连端点正是这样一次访问，所以不预热的话，系统会等到用户点开设备、
/// 通道已经在拨号时才弹框——授权决定恰好卡在连接过程中间，第一次连接因此变慢甚至失败。
/// 这里在登录成功后主动做一次 Bonjour 浏览，把询问提前到刚进 app 的时候。
///
/// 浏览不连接任何东西，也不要求局域网里真有 `_coflux._tcp` 服务：它唯一的作用就是触发系统询问。
/// 拒绝授权不是致命的——只是没了同网段直连这条最快路径，通道会退回 DERP 中转。
@MainActor
enum LocalNetworkPermission {
    private static var browser: NWBrowser?

    /// 幂等：系统对每个 app 只问一次，重复预热没有意义，也不该重复占用浏览器。
    static func prime() {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjour(type: "_coflux._tcp", domain: nil), using: NWParameters())
        Self.browser = browser
        browser.start(queue: .main)
        // 询问一旦发出，浏览本身就没有用途了；留出足够时间让系统把框弹出来再收摊。
        Task {
            try? await Task.sleep(for: .seconds(10))
            browser.cancel()
            Self.browser = nil
        }
    }
}
