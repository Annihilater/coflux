import XCTest
@testable import CofluxScreenCore

final class DisplayModeSelectionTests: XCTestCase {
    func testRequestedGeometryIsSanitised() {
        let hidpi = DisplayModeSelection.requested(widthPoints: 1440, heightPoints: 900, scale: 2)
        XCTAssertEqual(hidpi, DisplayGeometry(widthPoints: 1440, heightPoints: 900, scale: 2))
        XCTAssertEqual(hidpi?.widthPixels, 2880)
        XCTAssertEqual(hidpi?.heightPixels, 1800)
        // Odd point sizes at 1× are made even for the encoder; at 2× pixels are always even.
        XCTAssertEqual(DisplayModeSelection.requested(widthPoints: 1001, heightPoints: 601, scale: 1),
                       DisplayGeometry(widthPoints: 1000, heightPoints: 600, scale: 1))
        XCTAssertEqual(DisplayModeSelection.requested(widthPoints: 1001, heightPoints: 601, scale: 2)?.widthPixels, 2002)
        // Bounded on both ends, scale clamped to 1 or 2.
        XCTAssertEqual(DisplayModeSelection.requested(widthPoints: 10, heightPoints: 10, scale: 3)?.widthPoints, DisplayModeSelection.minPoints)
        XCTAssertEqual(DisplayModeSelection.requested(widthPoints: 10_000, heightPoints: 10, scale: 2)?.widthPixels, DisplayModeSelection.maxPixels)
        XCTAssertEqual(DisplayModeSelection.requested(widthPoints: 800, heightPoints: 600, scale: 0)?.scale, 1)
        XCTAssertNil(DisplayModeSelection.requested(widthPoints: 0, heightPoints: 600, scale: 2))
    }

    func testSelectsTheHiDPIModeNotTheDoubledOneTheFirstApplyLandsOn() {
        let geometry = DisplayGeometry(widthPoints: 1440, heightPoints: 900, scale: 2)
        let candidates = [
            // What the first apply lands on: 1× with doubled point size.
            DisplayModeSelection.Candidate(pixelWidth: 2880, pixelHeight: 1800, pointWidth: 2880, pointHeight: 1800, refreshRate: 60),
            DisplayModeSelection.Candidate(pixelWidth: 2880, pixelHeight: 1800, pointWidth: 1440, pointHeight: 900, refreshRate: 30),
            DisplayModeSelection.Candidate(pixelWidth: 2880, pixelHeight: 1800, pointWidth: 1440, pointHeight: 900, refreshRate: 60),
            DisplayModeSelection.Candidate(pixelWidth: 1440, pixelHeight: 900, pointWidth: 1440, pointHeight: 900, refreshRate: 60),
        ]
        XCTAssertEqual(DisplayModeSelection.select(geometry, from: candidates), 2)
        let lowdpi = DisplayGeometry(widthPoints: 1440, heightPoints: 900, scale: 1)
        XCTAssertEqual(DisplayModeSelection.select(lowdpi, from: candidates), 3)
        XCTAssertNil(DisplayModeSelection.select(DisplayGeometry(widthPoints: 1000, heightPoints: 700, scale: 2), from: candidates))
    }
}
