import CofluxProtocol
import Foundation
import Testing
@testable import CofluxClientCore

struct DirWorkspaceTests {
    @Test func dirWorkspaceIsExactlyTheEmptyProjectID() {
        #expect(isDirWorkspace(workspace(id: "w1", daemonID: "d1", projectID: "", createdAt: 1)))
        #expect(!isDirWorkspace(workspace(id: "w2", daemonID: "d1", projectID: "p1", createdAt: 1)))
    }

    @Test func canonicalPicksTheEarliestCreatedDirectoryWorkspaceOfTheDevice() {
        let list = [
            workspace(id: "w-late", daemonID: "d1", projectID: "", createdAt: 300),
            workspace(id: "w-early", daemonID: "d1", projectID: "", createdAt: 100),
            workspace(id: "w-mid", daemonID: "d1", projectID: "", createdAt: 200),
        ]
        #expect(canonicalDirWorkspace(daemonID: "d1", in: list)?.id == "w-early")
    }

    /// server 的复用查询在 createdAt 相同时按 id 升序取第一（hub.ts:2949-2951）；
    /// 少了这一步，客户端会解析到另一行、新终端出现在没渲染的工作区里。
    @Test func canonicalBreaksCreatedAtTiesByAscendingID() {
        let list = [
            workspace(id: "w-b", daemonID: "d1", projectID: "", createdAt: 100),
            workspace(id: "w-a", daemonID: "d1", projectID: "", createdAt: 100),
            workspace(id: "w-c", daemonID: "d1", projectID: "", createdAt: 100),
        ]
        #expect(canonicalDirWorkspace(daemonID: "d1", in: list)?.id == "w-a")
        #expect(canonicalDirWorkspace(daemonID: "d1", in: list.reversed())?.id == "w-a")
    }

    @Test func canonicalIgnoresProjectWorkspacesAndOtherDevices() {
        let list = [
            workspace(id: "w-project", daemonID: "d1", projectID: "p1", createdAt: 1),
            workspace(id: "w-other-device", daemonID: "d2", projectID: "", createdAt: 2),
            workspace(id: "w-dir", daemonID: "d1", projectID: "", createdAt: 3),
        ]
        #expect(canonicalDirWorkspace(daemonID: "d1", in: list)?.id == "w-dir")
        #expect(canonicalDirWorkspace(daemonID: "d2", in: list)?.id == "w-other-device")
    }

    @Test func canonicalIsNilWhenTheDeviceHasNoDirectoryWorkspace() {
        let list = [
            workspace(id: "w-project", daemonID: "d1", projectID: "p1", createdAt: 1),
            workspace(id: "w-other-device", daemonID: "d2", projectID: "", createdAt: 2),
        ]
        #expect(canonicalDirWorkspace(daemonID: "d1", in: list) == nil)
        #expect(canonicalDirWorkspace(daemonID: "unknown", in: list) == nil)
        #expect(canonicalDirWorkspace(daemonID: "d1", in: []) == nil)
    }

    private func workspace(id: String, daemonID: String, projectID: String, createdAt: Double) -> Coflux_V1_Workspace {
        var workspace = Coflux_V1_Workspace()
        workspace.id = id
        workspace.daemonID = daemonID
        workspace.projectID = projectID
        workspace.name = projectID.isEmpty ? "~" : "main"
        workspace.createdAt = createdAt
        return workspace
    }
}
