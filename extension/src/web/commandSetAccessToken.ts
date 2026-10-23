import * as vscode from 'vscode';
import { ForgejoFileSystemProvider } from './ForgejoFileSystemProvider';
import { Repo } from './Repo';
import { RepoUri } from './RepoUri';

export function register(provider: ForgejoFileSystemProvider) {
    return vscode.commands.registerCommand('famiprog-vscode-forgejo.setAccessToken', (arg?: unknown) => command(provider, arg));
}

async function command(provider: ForgejoFileSystemProvider, arg: unknown): Promise<void> {
    const repo = await repoFor(provider, arg);
    if (!repo) {
        return;
    }
    const input = await vscode.window.showInputBox({
        title: 'Set access token',
        prompt: 'Forgejo personal access token',
        password: true,
        ignoreFocusOut: true,
    });
    const accessToken = input?.trim();
    if (!accessToken) {
        return;
    }
    await repo.setAccessToken(accessToken);
    try {
        await repo.refresh();
    } catch (error) {
        repo.reportConnectFailure(error);
        return;
    }
    provider.notifyRootChanged(repo.repoUri);
}

async function repoFor(provider: ForgejoFileSystemProvider, arg: unknown): Promise<Repo | undefined> {
    const repos = await Promise.all(Object.values(provider.repoStore).map(entry => entry instanceof Repo ? entry : entry));
    const same = repos.find(repo => repo.sourceControl === arg);
    if (same) {
        return same;
    }
    const uri = rootUri(arg);
    if (uri) {
        return resolve(provider, uri);
    }
    if (repos.length === 0) {
        void vscode.window.showErrorMessage('No Forgejo repository is open');
        return;
    }
    if (repos.length === 1) {
        return repos[0];
    }
    const picked = await vscode.window.showQuickPick(repos.map(repo => ({
        label: repo.sourceControl.label,
        repo,
    })), { placeHolder: 'Repository' });
    return picked?.repo;
}

function rootUri(arg: unknown): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    if (arg && typeof arg === 'object' && 'rootUri' in arg) {
        const root = (arg as { rootUri?: vscode.Uri }).rootUri;
        if (root instanceof vscode.Uri) {
            return root;
        }
    }
    return undefined;
}

async function resolve(provider: ForgejoFileSystemProvider, uri: vscode.Uri): Promise<Repo | undefined> {
    const [repoUriStr] = RepoUri.fileUriToRepoUriStrAndPath(uri);
    const stored = provider.repoStore[repoUriStr];
    if (!stored) {
        void vscode.window.showErrorMessage('That repository is not open');
        return;
    }
    return stored instanceof Repo ? stored : stored;
}
