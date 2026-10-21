import * as assert from "assert";
import * as vscode from "vscode";
import { folderName } from "../../commandOpenRepo.js";

function assertFolder(uri: string, expected: string) {
    assert.strictEqual(folderName(vscode.Uri.parse(uri)), expected);
}

suite("commandOpenRepo", () => {

    test("folderName", () => {
        assertFolder("forgejo://https/some.server.org/path1/path2/owner/repo/|", "owner/repo");
        assertFolder("forgejo://https/some.server.org/path1/path2/owner/repo/|/a/b/c.md", "owner/repo");
        assertFolder("forgejo://https/some.server.org/path1/path2/owner/repo@main/|", "owner/repo@main");
        assert.throws(() => folderName(vscode.Uri.parse("forgejo://https/some.server.org/|")), /at least 3 path segments/);
    });
});
