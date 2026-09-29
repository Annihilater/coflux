// coflux-screen: the controlled side of the remote screen tab (plan 20260929-remote-desktop).
//
// Started by the worker as a detached process with `--socket <path>`; serves the worker over that
// Unix socket, owns the session and exits by itself when it has no session and no worker.
import CofluxScreenCore
import Darwin
import Foundation

let version = ProcessInfo.processInfo.environment["COFLUX_SCREEN_VERSION"] ?? "dev"

func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write(Data("\(stamp) [coflux-screen] \(message)\n".utf8))
}

var socketPath: String?
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
    switch argument {
    case "--socket":
        socketPath = arguments.next()
    case "--version":
        print(version)
        exit(0)
    default:
        log("unknown argument \(argument)")
        exit(2)
    }
}
guard let socketPath, !socketPath.isEmpty else {
    log("usage: coflux-screen --socket <path>")
    exit(2)
}

let server = HelperServer(path: socketPath)
do {
    try server.start()
} catch {
    log("cannot listen on \(socketPath): \(error)")
    exit(1)
}
log("version \(version) listening on \(socketPath)")
let helper = ScreenHelper(server: server, version: version, log: log)

signal(SIGPIPE, SIG_IGN)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
terminate.setEventHandler {
    log("SIGTERM: ending the session and exiting")
    helper.shutdown()
    exit(0)
}
terminate.resume()
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
signal(SIGINT, SIG_IGN)
interrupt.setEventHandler {
    helper.shutdown()
    exit(0)
}
interrupt.resume()

dispatchMain()
