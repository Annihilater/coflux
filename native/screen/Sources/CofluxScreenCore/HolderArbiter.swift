import Foundation

/// Who holds the one screen session of this Mac (the takeover rule of terminals, mirrored):
/// a new open preempts the current holder unless `force` is off and the holder's lane is alive;
/// the same client reattaching (a reconnect) keeps its epoch. Pure so it can be tested.
public struct HolderArbiter: Equatable {
    public struct Holder: Equatable {
        public var clientInstanceID: String
        public var controlLane: String?
        public var videoLane: String?
        public var epoch: UInt64
        public init(clientInstanceID: String, controlLane: String?, videoLane: String?, epoch: UInt64) {
            self.clientInstanceID = clientInstanceID
            self.controlLane = controlLane
            self.videoLane = videoLane
            self.epoch = epoch
        }
        public var hasLane: Bool { controlLane != nil || videoLane != nil }
    }

    public enum Outcome: Equatable {
        /// The opener holds the session with this epoch; `detachedLane` is the previous
        /// holder's control lane to notify, if it was preempted.
        case held(epoch: UInt64, detachedLane: String?)
        /// Another client holds it and `force` was not set.
        case refused
    }

    public private(set) var holder: Holder?
    private var lastEpoch: UInt64 = 0

    public init() {}

    public mutating func open(clientInstanceID: String, controlLane: String, force: Bool) -> Outcome {
        if var current = holder {
            if current.clientInstanceID == clientInstanceID {
                // A reconnect of the same client: same epoch, new control lane.
                current.controlLane = controlLane
                holder = current
                return .held(epoch: current.epoch, detachedLane: nil)
            }
            if current.hasLane && !force {
                return .refused
            }
            lastEpoch += 1
            let detached = current.controlLane
            holder = Holder(clientInstanceID: clientInstanceID, controlLane: controlLane, videoLane: nil, epoch: lastEpoch)
            return .held(epoch: lastEpoch, detachedLane: detached)
        }
        lastEpoch += 1
        holder = Holder(clientInstanceID: clientInstanceID, controlLane: controlLane, videoLane: nil, epoch: lastEpoch)
        return .held(epoch: lastEpoch, detachedLane: nil)
    }

    /// Bind a video lane; only the holder's epoch may.
    public mutating func attachVideo(lane: String, epoch: UInt64) -> Bool {
        guard var current = holder, current.epoch == epoch else { return false }
        current.videoLane = lane
        holder = current
        return true
    }

    public func isCurrent(epoch: UInt64) -> Bool {
        holder?.epoch == epoch
    }

    /// A lane went away. Returns true when the holder has no lane left (the orphan grace starts).
    public mutating func laneClosed(_ lane: String) -> Bool {
        guard var current = holder else { return false }
        if current.controlLane == lane { current.controlLane = nil }
        if current.videoLane == lane { current.videoLane = nil }
        holder = current
        return !current.hasLane
    }

    public mutating func end() {
        holder = nil
    }
}
