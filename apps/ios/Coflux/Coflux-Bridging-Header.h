// Exposes the Go c-archive's generated C ABI to Swift.
//
// CofluxTailcat.xcframework is built locally by
// `node scripts/build-ios-transport.mjs` and is deliberately not committed;
// without it this header does not resolve and the app target will not build.
#import "libcofluxtailcat.h"
