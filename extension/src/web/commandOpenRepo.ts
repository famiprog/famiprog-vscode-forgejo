import * as vscode from 'vscode';
import { SCHEME } from './forgejoFileSystemProviderPrototype.js';

export function register() {
    return vscode.commands.registerCommand('famiprog-vscode-forgejo.openRepo', command);
}

async function command(): Promise<vscode.Uri | undefined> {
    const input = await vscode.window.showInputBox({
        title: 'Forgejo repository',
        prompt: 'URL of a Forgejo repository',
        placeHolder: 'http://<server>/<owner>/<repo>',
        ignoreFocusOut: true,
    });
    if (!input?.trim()) {
        return;
    }

    let uri: vscode.Uri;
    try {
        uri = toForgejoUri(input);
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

function toForgejoUri(input: string): vscode.Uri {
    input = input.trim();
    if (input.endsWith('.git')) {
        input = input.slice(0, -'.git'.length);
    }
    if (input.startsWith("https://")) {
        input = input.replace("https://", SCHEME + "://");
    } else if (input.startsWith("http://")) {
        input = input.replace("http://", SCHEME + "://");
    } else {
        throw new Error(`Invalid Forgejo repository URL: ${input}`);
    }
    return vscode.Uri.parse(input);
}

function folderName(uri: vscode.Uri): string {
    const segments = uri.path.split('/');
    if (segments.length < 3) {
        throw new Error("Expected at least 3 path segments");
    }
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}