import * as vscode from 'vscode';
import { RepoUri } from './RepoUri';

export function register() {
    return vscode.commands.registerCommand('famiprog-vscode-forgejo.openRepo', command);
}

async function command(): Promise<vscode.Uri | undefined> {
    const input = await vscode.window.showInputBox({
        title: 'Forgejo repository',
        prompt: 'URL of a Forgejo repository',
        placeHolder: 'http(s)://<server>/<owner>/<repo>(@ref)',
        ignoreFocusOut: true,
    });

    if (!input?.trim()) {
        return;
    }

    let uri: vscode.Uri;
    try {
        uri = RepoUri.fromRepoUrl(input);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(message);
        return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    const name = folderName(uri);
    const added = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name });
    if (!added) {
        await vscode.window.showErrorMessage(`Could not open ${name}`);
        return;
    }
    return uri;
}

/**
 * @see commandOpenRepo.test.ts for examples
 */
export function folderName(uri: vscode.Uri): string {
    const segments = uri.path.split("/").filter(Boolean);
    const marker = segments.indexOf(RepoUri.SEPARATOR);
    const before = marker === -1 ? segments : segments.slice(0, marker);
    if (before.length < 3) {
        throw new Error("Expected at least 3 path segments");
    }
    return `${before[before.length - 2]}/${before[before.length - 1]}`;
}