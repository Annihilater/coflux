import Foundation
import IOKit.pwr_mgt

/// While a session exists the remote must neither idle-sleep its display nor auto-lock: two
/// IOPM assertions plus periodic user-activity declarations (the latter also wakes sleeping
/// displays, which WindowServer needs before any display configuration takes effect).
public final class PowerAssertions {
    private var displayAssertion: IOPMAssertionID = 0
    private var systemAssertion: IOPMAssertionID = 0
    private var activityTimer: DispatchSourceTimer?
    private var activityID: IOPMAssertionID = 0

    public init() {}

    public var held: Bool { displayAssertion != 0 }

    public func acquire() {
        guard displayAssertion == 0 else { return }
        // The assertion type names spelled out: the kIOPMAssertionType* macros import unevenly.
        IOPMAssertionCreateWithName(
            "PreventUserIdleDisplaySleep" as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            "Coflux remote screen session" as CFString,
            &displayAssertion
        )
        IOPMAssertionCreateWithName(
            "PreventUserIdleSystemSleep" as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            "Coflux remote screen session" as CFString,
            &systemAssertion
        )
        declareActivity()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in self?.declareActivity() }
        timer.resume()
        activityTimer = timer
    }

    public func release() {
        activityTimer?.cancel()
        activityTimer = nil
        if displayAssertion != 0 {
            IOPMAssertionRelease(displayAssertion)
            displayAssertion = 0
        }
        if systemAssertion != 0 {
            IOPMAssertionRelease(systemAssertion)
            systemAssertion = 0
        }
    }

    /// Counts as local user activity: keeps the idle-lock timer from firing and wakes displays.
    public func declareActivity() {
        IOPMAssertionDeclareUserActivity(
            "Coflux remote screen" as CFString,
            kIOPMUserActiveLocal,
            &activityID
        )
    }
}
