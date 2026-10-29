import * as vscode from 'vscode';
import { ForgejoApiGeneric } from './ForgejoApi';
import { folderName } from './commandOpenRepo';
import { embedderOrigin, listFailureMessage } from './commandOpenMyRepo';
import { CONFIG_CATEGORY, CONFIG_OPEN_ALL_MY_REPOS_AT_STARTUP } from './config';
import { RepoUri } from './RepoUri';

export const COMMAND_OPEN_MY_REPOS = 'famiprog-vscode-forgejo.openMyRepos';

/**
 * Shown when `famiprog-vscode-forgejo.embedderUrl` is set.
 * Opens every repo visible to the signed-in user. No picker.
 */
export function register() {
    const commandDisposable = vscode.commands.registerCommand(COMMAND_OPEN_MY_REPOS, command);
    if (vscode.workspace.getConfiguration(CONFIG_CATEGORY).get<boolean>(CONFIG_OPEN_ALL_MY_REPOS_AT_STARTUP)) {
        void vscode.commands.executeCommand(COMMAND_OPEN_MY_REPOS);
    }
    return commandDisposable;
}

async function command(): Promise<void> {
    const origin = embedderOrigin();
    if (!origin) {
        return;
    }
    let names: string[];
    try {
        names = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Listing Forgejo repositories' },
            () => new ForgejoApiGeneric(origin).listVisibleRepoNames(),
        );
    } catch (error) {
        await vscode.window.showErrorMessage(listFailureMessage(error));
        return;
    }
    if (names.length === 0) {
        await vscode.window.showInformationMessage('No repositories visible to you');
        return;
    }
    const open = new Set((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString()));
    const toAdd: { uri: vscode.Uri; name: string }[] = [];
    for (const ownerRepo of names) {
        let uri: vscode.Uri;
        try {
            uri = RepoUri.fromRepoUrl(`${origin}/${ownerRepo}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await vscode.window.showErrorMessage(message);
            continue;
        }
        if (!open.has(uri.toString())) {
            toAdd.push({ uri, name: folderName(uri) });
        }
    }
    if (toAdd.length === 0) {
        return;
    }
    const start = vscode.workspace.workspaceFolders?.length ?? 0;
    const added = vscode.workspace.updateWorkspaceFolders(start, 0, ...toAdd);
    if (!added) {
        await vscode.window.showErrorMessage('Could not open repositories');
    }
}
