/**
 * `http(s)://<server>/<owner>/<repo>` → `forgejo://http(s)/<server>/<owner>/<repo>/|`.
 * The boot script uses this, and so does `RepoUri.fromRepoUrl`. The page cannot import `vscode`.
 */
export function forgejoUriFromRepoUrl(repoUrlStr: string): { scheme: 'forgejo'; authority: string; path: string } {
    repoUrlStr = repoUrlStr.trim();
    if (repoUrlStr.endsWith('.git')) {
        repoUrlStr = repoUrlStr.slice(0, -'.git'.length);
    }
    let url: URL;
    try {
        url = new URL(repoUrlStr);
    } catch {
        throw new Error(`Invalid Forgejo repository URL: ${repoUrlStr}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Invalid Forgejo repository URL: ${repoUrlStr}`);
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (path.split('/').filter(Boolean).length < 2) {
        throw new Error(`Expected at least <owner>/<repo> in ${repoUrlStr}`);
    }
    return {
        scheme: 'forgejo',
        authority: url.protocol.slice(0, -1),
        path: `/${url.host}${path}/|`,
    };
}
