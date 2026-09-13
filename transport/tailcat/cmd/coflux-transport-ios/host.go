//go:build !ios || !cgo

// Command coflux-transport-ios has no host build. Its only real artifact is the
// iOS c-archive emitted by scripts/build-ios-transport.mjs with GOOS=ios and
// CGO_ENABLED=1. This placeholder keeps `go build ./...`, `go vet ./...` and
// `go test ./...` working under the CGO-free host toolchain CI uses, which
// would otherwise reject a package whose every file is excluded.
package main

func main() {}
