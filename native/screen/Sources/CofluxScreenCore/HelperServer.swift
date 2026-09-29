import Darwin
import Foundation

/// What the server tells its owner. Called on the main queue.
public protocol HelperServerDelegate: AnyObject {
    func serverAccepted(connection: Int)
    func server(connection: Int, received record: Data)
    func serverClosed(connection: Int)
}

/// The Unix socket the worker connects to: `$COFLUX_HOME/ipc/screen.sock`, mode 0600, one
/// worker at a time (a newer connection replaces an older one, which is what a worker hot
/// upgrade looks like from here). Records are `length:u32 BE || payload`. All socket work runs on
/// one serial queue; writes never block the owner: they are queued and flushed when writable.
public final class HelperServer {
    public weak var delegate: HelperServerDelegate?

    private let path: String
    private let queue = DispatchQueue(label: "dev.coflux.screen.socket")
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var current: Connection?
    private var nextConnectionID = 1

    public init(path: String) {
        self.path = path
    }

    public func start() throws {
        try queue.sync { try self.bind() }
    }

    public var hasConnection: Bool {
        queue.sync { current != nil }
    }

    /// Queue a record to the live connection; false when there is none.
    @discardableResult
    public func send(connection: Int, record: Data) -> Bool {
        let framed: Data
        do { framed = try Framing.encode(record) } catch { return false }
        return queue.sync {
            guard let current, current.id == connection else { return false }
            current.enqueue(framed)
            return true
        }
    }

    /// Stop listening and drop the connection. Idempotent.
    public func stop() {
        queue.sync {
            current?.close()
            current = nil
            self.stopListeningLocked()
        }
    }

    /// Give up the socket (no new connections; the path is free for a successor) while the
    /// connection in service, if any, stays up. Idempotent.
    public func stopListening() {
        queue.sync { self.stopListeningLocked() }
    }

    /// On the queue. The socket file is unlinked only by the call that owned it: a retired helper
    /// stops early and the replacement binds the same path — a later stop must never remove the
    /// successor's socket.
    private func stopListeningLocked() {
        acceptSource?.cancel()
        acceptSource = nil
        if listenFD >= 0 {
            Darwin.close(listenFD)
            listenFD = -1
            unlink(path)
        }
    }

    private func bind() throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HelperError.socket(String(cString: strerror(errno))) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count < capacity else {
            Darwin.close(fd)
            throw HelperError.socket("socket path too long")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
            raw[pathBytes.count] = 0
        }
        // A stale file from a previous helper is ours to replace; the worker probes before it
        // starts us, so nothing live is listening here.
        unlink(path)
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, length) }
        }
        guard bound == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(fd)
            throw HelperError.socket("bind: \(message)")
        }
        chmod(path, 0o600)
        guard listen(fd, 4) == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(fd)
            unlink(path)
            throw HelperError.socket("listen: \(message)")
        }
        listenFD = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.accept() }
        source.resume()
        acceptSource = source
    }

    private func accept() {
        let fd = Darwin.accept(listenFD, nil, nil)
        guard fd >= 0 else { return }
        // Only our own user may drive the screen: the socket is 0600 in a 0700 directory, and
        // the peer's uid is checked as well.
        var uid: uid_t = 0
        var gid: gid_t = 0
        if getpeereid(fd, &uid, &gid) != 0 || uid != getuid() {
            Darwin.close(fd)
            return
        }
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        var nosigpipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &nosigpipe, socklen_t(MemoryLayout<Int32>.size))
        var bufferSize: Int32 = 4 * 1024 * 1024
        setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &bufferSize, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &bufferSize, socklen_t(MemoryLayout<Int32>.size))
        if let old = current {
            old.close()
            let oldID = old.id
            DispatchQueue.main.async { [weak self] in self?.delegate?.serverClosed(connection: oldID) }
        }
        let id = nextConnectionID
        nextConnectionID += 1
        let connection = Connection(id: id, fd: fd, queue: queue)
        connection.onRecord = { [weak self] record in
            DispatchQueue.main.async { self?.delegate?.server(connection: id, received: record) }
        }
        connection.onClose = { [weak self] in
            guard let self else { return }
            if self.current?.id == id { self.current = nil }
            DispatchQueue.main.async { self.delegate?.serverClosed(connection: id) }
        }
        current = connection
        connection.start()
        DispatchQueue.main.async { [weak self] in self?.delegate?.serverAccepted(connection: id) }
    }
}

public enum HelperError: Error, CustomStringConvertible {
    case socket(String)
    case display(String)
    case capture(String)
    case encoder(String)

    public var description: String {
        switch self {
        case .socket(let message): return "socket: \(message)"
        case .display(let message): return "display: \(message)"
        case .capture(let message): return "capture: \(message)"
        case .encoder(let message): return "encoder: \(message)"
        }
    }
}

/// One accepted socket: non-blocking reads through the record parser, queued non-blocking
/// writes. Owned by the server's queue.
private final class Connection {
    let id: Int
    private let fd: Int32
    private let queue: DispatchQueue
    private var readSource: DispatchSourceRead?
    private var writeSource: DispatchSourceWrite?
    private var parser = RecordParser()
    private var pending = Data()
    private var closed = false
    var onRecord: ((Data) -> Void)?
    var onClose: (() -> Void)?

    init(id: Int, fd: Int32, queue: DispatchQueue) {
        self.id = id
        self.fd = fd
        self.queue = queue
    }

    func start() {
        let read = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        read.setEventHandler { [weak self] in self?.readable() }
        read.resume()
        readSource = read
        let write = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
        write.setEventHandler { [weak self] in self?.flush() }
        writeSource = write
    }

    func enqueue(_ data: Data) {
        guard !closed else { return }
        pending.append(data)
        flush()
    }

    private func readable() {
        var buffer = [UInt8](repeating: 0, count: 256 * 1024)
        let n = Darwin.read(fd, &buffer, buffer.count)
        if n > 0 {
            do {
                for record in try parser.push(Data(buffer[0..<n])) {
                    onRecord?(record)
                }
            } catch {
                close()
            }
        } else if n == 0 || (errno != EAGAIN && errno != EINTR) {
            close()
        }
    }

    private func flush() {
        guard !closed else { return }
        while !pending.isEmpty {
            let written = pending.withUnsafeBytes { raw -> Int in
                Darwin.write(fd, raw.baseAddress, raw.count)
            }
            if written > 0 {
                pending.removeSubrange(0..<written)
            } else if written < 0 && (errno == EAGAIN || errno == EINTR) {
                break
            } else {
                close()
                return
            }
        }
        if pending.isEmpty {
            if writeArmed {
                writeSource?.suspend()
                writeArmed = false
            }
        } else if !writeArmed {
            writeSource?.resume()
            writeArmed = true
        }
    }

    private var writeArmed = false

    func close() {
        guard !closed else { return }
        closed = true
        readSource?.cancel()
        readSource = nil
        if let writeSource {
            if !writeArmed { writeSource.resume() }
            writeSource.cancel()
        }
        writeSource = nil
        Darwin.close(fd)
        pending.removeAll()
        onClose?()
    }
}
