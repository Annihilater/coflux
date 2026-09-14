//go:build ios && cgo

// Command coflux-transport-ios exposes the client half of the native Tailcat
// transport to an in-process caller over a C ABI, built with
// -buildmode=c-archive. iOS cannot spawn the helper subprocess the desktop and
// headless owners use, so the same internal/backend dependency boundary is
// linked into the app instead of talking over inherited pipes.
//
// Only low-frequency events cross the language boundary: prepare, dial, close,
// drop, probe. Each opened stream is handed back as one end of a unix
// socketpair and Go then moves bytes verbatim in both directions — it never
// reinterprets, reframes or inspects a record. The channel grant, its 32-byte
// proof key and the application handshake stay in Swift: nothing here reads or
// holds a credential, and no address, node key or grant may appear in anything
// this file returns. Failures cross as result codes, never as upstream text.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"io"
	"net"
	"os"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/myWsq/coflux/transport/tailcat/internal/backend"
)

func main() {}

// Result codes shared with the Swift façade. Zero is success; every failure is
// a distinct negative code so the caller can phrase its own message without
// upstream diagnostics leaking through the boundary.
const (
	resultOK       = 0
	resultInvalid  = -1
	resultClosed   = -2
	resultLimit    = -3
	resultDial     = -4
	resultProbe    = -5
	resultInternal = -6
)

// Ceilings match the helper's (ipc.MaxStreams) and the backend's own
// (backend.MaxDevices); iOS gets no larger budget than a desktop owner.
const maxStreams = 256

// Matches the helper's dial deadline (internal/helper: reserve).
const dialTimeout = 15 * time.Second

// Matches the helper's probe/health deadline.
const probeTimeout = 3 * time.Second

type stream struct {
	id     int64
	device string
	cancel context.CancelFunc
	mu     sync.Mutex
	conn   net.Conn
	local  net.Conn
	closed bool
}

// attach publishes the dialed pair onto a stream that has not been cancelled
// while the dial was in flight. A false return means the caller must dispose of
// both descriptors itself.
func (s *stream) attach(conn net.Conn, local net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.conn = conn
	s.local = local
	return true
}

func (s *stream) shutdown() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	conn, local := s.conn, s.local
	s.conn, s.local = nil, nil
	s.mu.Unlock()
	s.cancel()
	if conn != nil {
		conn.Close()
	}
	if local != nil {
		local.Close()
	}
}

var (
	mu      sync.Mutex
	engine  *backend.Backend
	streams = map[int64]*stream{}
	devices = map[string]struct{}{}
)

// validDevice mirrors the helper's owner-supplied identifier check: printable,
// bounded, and never used to address anything outside this process.
func validDevice(id string) bool {
	if len(id) == 0 || len(id) > 255 {
		return false
	}
	for _, c := range id {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}

// forget drops a stream from the registry when it is still the registered one.
func forget(entry *stream) {
	mu.Lock()
	if streams[entry.id] == entry {
		delete(streams, entry.id)
	}
	mu.Unlock()
	entry.shutdown()
}

// bridgePair builds the socketpair that carries one Tailcat stream across the
// language boundary. Go keeps one end as a net.Conn; the returned descriptor is
// owned by the caller from here on.
func bridgePair() (net.Conn, int, error) {
	syscall.ForkLock.RLock()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		syscall.ForkLock.RUnlock()
		return nil, 0, err
	}
	syscall.CloseOnExec(fds[0])
	syscall.CloseOnExec(fds[1])
	syscall.ForkLock.RUnlock()
	file := os.NewFile(uintptr(fds[0]), "coflux-tailcat")
	// FileConn duplicates the descriptor into the runtime poller; the original
	// must not outlive this call.
	local, err := net.FileConn(file)
	file.Close()
	if err != nil {
		syscall.Close(fds[1])
		return nil, 0, err
	}
	return local, fds[1], nil
}

// pump forwards bytes verbatim until either side closes. Record framing belongs
// to the peers, not to this bridge.
func (s *stream) pump(conn net.Conn, local net.Conn) {
	go func() {
		defer forget(s)
		io.Copy(local, conn)
	}()
	go func() {
		defer forget(s)
		io.Copy(conn, local)
	}()
}

//export coflux_tailcat_prepare
func coflux_tailcat_prepare(device *C.char, out **C.char) C.int {
	id := C.GoString(device)
	if !validDevice(id) || out == nil {
		return resultInvalid
	}
	mu.Lock()
	if _, known := devices[id]; !known && len(devices) >= backend.MaxDevices {
		mu.Unlock()
		return resultLimit
	}
	if engine == nil {
		engine = backend.New()
	}
	current := engine
	mu.Unlock()
	key, err := current.Prepare(id)
	if err != nil {
		return resultInvalid
	}
	mu.Lock()
	if engine == current {
		devices[id] = struct{}{}
	}
	mu.Unlock()
	*out = C.CString(key)
	return resultOK
}

// coflux_tailcat_dial opens one reliable stream to a centrally granted address.
// It blocks for at most dialTimeout and can be cancelled from another thread
// with coflux_tailcat_close on the same caller-assigned stream id.
//
//export coflux_tailcat_dial
func coflux_tailcat_dial(id C.longlong, device *C.char, address *C.char, out *C.int) C.int {
	key := int64(id)
	name := C.GoString(device)
	target := C.GoString(address)
	if key <= 0 || out == nil || !validDevice(name) || target == "" || len(target) > 32768 {
		return resultInvalid
	}
	mu.Lock()
	if engine == nil {
		mu.Unlock()
		return resultClosed
	}
	if _, exists := streams[key]; exists {
		mu.Unlock()
		return resultInvalid
	}
	if len(streams) >= maxStreams {
		mu.Unlock()
		return resultLimit
	}
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	entry := &stream{id: key, device: name, cancel: cancel}
	streams[key] = entry
	current := engine
	mu.Unlock()

	conn, err := current.Dial(ctx, name, target)
	cancel()
	if err != nil {
		forget(entry)
		return resultDial
	}
	local, peer, pairErr := bridgePair()
	if pairErr != nil {
		conn.Close()
		forget(entry)
		return resultInternal
	}
	if !entry.attach(conn, local) {
		conn.Close()
		local.Close()
		syscall.Close(peer)
		return resultClosed
	}
	entry.pump(conn, local)
	*out = C.int(peer)
	return resultOK
}

// coflux_tailcat_close cancels a pending dial or closes an established stream.
// It is idempotent and safe to call from any thread.
//
//export coflux_tailcat_close
func coflux_tailcat_close(id C.longlong) {
	mu.Lock()
	entry := streams[int64(id)]
	delete(streams, int64(id))
	mu.Unlock()
	if entry != nil {
		entry.shutdown()
	}
}

// coflux_tailcat_drop closes that device's streams and releases its Tailcat
// client and node identity. The next prepare for the same device mints a fresh
// identity, which is also how a replaced remote endpoint is recovered from.
//
//export coflux_tailcat_drop
func coflux_tailcat_drop(device *C.char) {
	name := C.GoString(device)
	if !validDevice(name) {
		return
	}
	mu.Lock()
	current := engine
	delete(devices, name)
	doomed := []*stream{}
	for id, entry := range streams {
		if entry.device == name {
			doomed = append(doomed, entry)
			delete(streams, id)
		}
	}
	mu.Unlock()
	for _, entry := range doomed {
		entry.shutdown()
	}
	if current != nil {
		current.Drop(name)
	}
}

// coflux_tailcat_probe reports the measured path of a device's live client.
// *out_mode is "direct", "relay" or "unknown" and must be released with
// coflux_tailcat_free.
//
//export coflux_tailcat_probe
func coflux_tailcat_probe(device *C.char, outMode **C.char, outLatency *C.double) C.int {
	name := C.GoString(device)
	if !validDevice(name) || outMode == nil || outLatency == nil {
		return resultInvalid
	}
	mu.Lock()
	current := engine
	mu.Unlock()
	if current == nil {
		return resultClosed
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	path, err := current.Probe(ctx, name)
	if err != nil {
		return resultProbe
	}
	*outMode = C.CString(path.Mode)
	*outLatency = C.double(path.Latency)
	return resultOK
}

// coflux_tailcat_health reports whether the *served* region's stock DERP probe
// endpoint answers. A client-only backend never calls Serve and therefore has
// no configured region, so this reports zero: it exists for parity with the
// helper's `health` operation and must not be read as evidence that a remote
// path is down.
//
//export coflux_tailcat_health
func coflux_tailcat_health() C.int {
	mu.Lock()
	current := engine
	mu.Unlock()
	if current == nil {
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	if current.Health(ctx) {
		return 1
	}
	return 0
}

// coflux_tailcat_shutdown closes every stream and every Tailcat client. The
// next prepare starts a new backend from scratch, which is what the app's
// background transition relies on.
//
//export coflux_tailcat_shutdown
func coflux_tailcat_shutdown() {
	mu.Lock()
	current := engine
	engine = nil
	doomed := make([]*stream, 0, len(streams))
	for id, entry := range streams {
		doomed = append(doomed, entry)
		delete(streams, id)
	}
	devices = map[string]struct{}{}
	mu.Unlock()
	for _, entry := range doomed {
		entry.shutdown()
	}
	if current != nil {
		current.Close()
	}
}

// coflux_tailcat_free releases a string this bridge allocated.
//
//export coflux_tailcat_free
func coflux_tailcat_free(value *C.char) {
	C.free(unsafe.Pointer(value))
}
