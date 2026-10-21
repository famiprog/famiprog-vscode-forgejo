import * as assert from "assert";
import { RepoUri } from "../../RepoUri.js";
import * as vscode from "vscode";

function assertUri(input: string, expected: string) {
    const uri = RepoUri.fromRepoUrl(input);
    assert.strictEqual(`${uri.scheme}://${uri.authority}${uri.path}`, expected);
}

function assertComponents(uri: string, expected: { origin: string; owner: string; repoName: string; ref?: string }) {
    assert.deepStrictEqual(RepoUri.toRepoLocation(vscode.Uri.parse(uri)), expected);
}

suite("RepoUri", () => {

    test("fromRepoUrl", () => {
        assertUri("https://some.server.org/path1/path2/owner/repo/", "forgejo://https/some.server.org/path1/path2/owner/repo/|");
        assertUri("http://localhost:3001/forgejo/hello-world", "forgejo://http/localhost:3001/forgejo/hello-world/|");
        assertUri("  https://codeberg.org/forgejo/hello-world.git  ", "forgejo://https/codeberg.org/forgejo/hello-world/|");
        assertUri("https://some.server.org/path1/path2/owner/repo@main", "forgejo://https/some.server.org/path1/path2/owner/repo@main/|");
        assert.throws(() => RepoUri.fromRepoUrl("https://some.server.org/owner"), /<owner>\/<repo>/);
        assert.throws(() => RepoUri.fromRepoUrl("ftp://some.server.org/owner/repo"), /Invalid Forgejo repository URL/);
        assert.throws(() => RepoUri.fromRepoUrl("not a url"), /Invalid Forgejo repository URL/);
    });

    test("toRepoLocation", () => {
        assertComponents("forgejo://https/some.server.org/path1/path2/owner/repo/|", { origin: "https://some.server.org/path1/path2", owner: "owner", repoName: "repo" });
        assertComponents("forgejo://https/some.server.org/path1/path2/owner/repo@main/|", { origin: "https://some.server.org/path1/path2", owner: "owner", repoName: "repo", ref: "main" });
        assertComponents("forgejo://https/some.server.org/path1/path2/owner/repo/|/a/b/c.md", { origin: "https://some.server.org/path1/path2", owner: "owner", repoName: "repo" });
        assertComponents("forgejo://http/localhost:3001/forgejo/hello-world/|", { origin: "http://localhost:3001", owner: "forgejo", repoName: "hello-world" });
        assert.throws(() => RepoUri.toRepoLocation(vscode.Uri.parse("forgejo://https/some.server.org/|")), /at least 3 path segments/);
    });

    test("fileUriToRepoUriStrAndPath", () => {
        assert.deepStrictEqual(RepoUri.fileUriToRepoUriStrAndPath(vscode.Uri.parse("forgejo://https/some.server.org/path1/path2/owner/repo/|/a/b/c.md")), ["forgejo://https/some.server.org/path1/path2/owner/repo/|", "/a/b/c.md", "/" + encodeURIComponent("forgejo://https/some.server.org/path1/path2/owner/repo/|") + "/a/b/c.md"]);
        assert.deepStrictEqual(RepoUri.fileUriToRepoUriStrAndPath(vscode.Uri.parse("forgejo://https/some.server.org/path1/path2/owner/repo/|")), ["forgejo://https/some.server.org/path1/path2/owner/repo/|", "/", "/" + encodeURIComponent("forgejo://https/some.server.org/path1/path2/owner/repo/|")]);
        assert.deepStrictEqual(RepoUri.fileUriToRepoUriStrAndPath(vscode.Uri.parse("forgejo://https/some.server.org/path1/path2/owner/repo/|/a/b/c.md?layer=original")), ["forgejo://https/some.server.org/path1/path2/owner/repo/|", "/a/b/c.md", "/" + encodeURIComponent("forgejo://https/some.server.org/path1/path2/owner/repo/|") + "/a/b/c.md"]);
        assert.deepStrictEqual(RepoUri.fileUriToRepoUriStrAndPath(vscode.Uri.parse("forgejo://https/some.server.org/path1/path2/owner/repo/|?layer=original")), ["forgejo://https/some.server.org/path1/path2/owner/repo/|", "/", "/" + encodeURIComponent("forgejo://https/some.server.org/path1/path2/owner/repo/|")]);
        assert.throws(() => RepoUri.fileUriToRepoUriStrAndPath(vscode.Uri.parse("forgejo://https/some.server.org/owner/repo")), /separator/);
    });
});
