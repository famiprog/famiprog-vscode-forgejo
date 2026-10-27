import * as vscode from 'vscode';
import { forgejoUriFromRepoUrl } from '../shared/forgejoUri.js';

/**
 * We use | as separator to differentiate the repo part (before) and file part (after).
 * 
 * E.g. repo URL -> repo URI
 *  * https://some.server.org/path1/path2/owner/repo/ -> forgejo://https/some.server.org/path1/path2/owner/repo/|
 *  * https://some.server.org/path1/path2/owner/repo@main -> forgejo://https/some.server.org/path1/path2/owner/repo@main/|
 * 
 * So: first 2 before | -> owner/repo. After | -> the file path.
 * 
 * The file a/b/c.md -> forgejo://https/some.server.org/path1/path2/owner/repo/|/a/b/c.md. 
 * So a file URI contains repo URI. In other words: repo URI is a the file URI of root.
 */
export class RepoUri {

    static SCHEME = 'forgejo';
    static SEPARATOR = "|";

    /**
     * @see RepoUri.test.ts
     */
    static fromRepoUrl(repoUrlStr: string): vscode.Uri {
        return vscode.Uri.from(forgejoUriFromRepoUrl(repoUrlStr));
    }

    /**
     * The parts `ForgejoApi` is constructed with.
     * 
     * `forgejo://https/some.server.org/path1/path2/owner/repo@main/|...` →
     * 
     * * origin `https://some.server.org/path1/path2`, 
     * * owner `owner`, 
     * * repoName `repo`, 
     * * ref `main`.
     * 
     * @see RepoUri.test.ts
     */
    static toRepoLocation(fileUri: vscode.Uri): { origin: string; owner: string; repoName: string; ref?: string } {
        const segments = fileUri.path.split("/").filter(Boolean);
        const marker = segments.indexOf(this.SEPARATOR);
        const before = marker === -1 ? segments : segments.slice(0, marker);
        if (before.length < 3) {
            throw new Error("Expected at least 3 path segments");
        }
        const host = before[0];
        const owner = before[before.length - 2];
        const repo = before[before.length - 1];
        const base = before.slice(1, -2);
        const at = repo.indexOf("@");
        const repoName = at === -1 ? repo : repo.slice(0, at);
        const ref = at === -1 ? undefined : repo.slice(at + 1) || undefined;
        const origin = `${fileUri.authority}://${host}${base.length ? `/${base.join("/")}` : ""}`;
        return ref ? { origin, owner, repoName, ref } : { origin, owner, repoName };
    }

    static mountPoint(repoUriStr: string) {
        return '/' + encodeURIComponent(repoUriStr);
    }

    /**
     * @see RepoUri.test.ts
     */
    static fileUriToRepoUriStrAndPath(fileUri: vscode.Uri): [string, string, string] {
        const full = fileUri.toString(true);
        const query = full.indexOf("?");
        const str = query < 0 ? full : full.substring(0, query);
        const at = str.indexOf(this.SEPARATOR);
        if (at < 0) {
            throw new Error(`URI not good; it doesn't contain separator = ${this.SEPARATOR}: ${str}`);
        }
        const path = str.substring(at + this.SEPARATOR.length);
        const repoUriStr = str.substring(0, at + this.SEPARATOR.length);
        const repoPath = path || "/";
        const mountPoint = this.mountPoint(repoUriStr);
        return [repoUriStr, repoPath, repoPath === "/" ? mountPoint : mountPoint + repoPath];
    }
}