import { isAxiosError } from 'axios';
import * as vscode from 'vscode';
import { ForgejoApi } from './ForgejoApi';
import { addRepoFolder } from './commandOpenRepo';
import { RepoUri } from './RepoUri';

/**
 * Shown when `famiprog-vscode-forgejo.embedderUrl` is set: this workbench is embedded in one Forgejo server.
 * The quick pick lists repos visible to the signed-in user, and also accepts a typed `owner/repo`.
 */
export function register() {
    return vscode.commands.registerCommand('famiprog-vscode-forgejo.openMyRepo', command);
}

async function command(): Promise<vscode.Uri | undefined> {
    const origin = embedderOrigin();
    if (!origin) {
        return;
    }
    const ownerRepo = await pickOwnerRepo(ForgejoApi.listVisibleRepoNames(origin));
    if (!ownerRepo) {
        return;
    }
    let uri: vscode.Uri;
    try {
        uri = RepoUri.fromRepoUrl(`${origin}/${ownerRepo}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(message);
        return;
    }
    return addRepoFolder(uri);
}

/** Origin from `famiprog-vscode-forgejo.embedderUrl`, without a trailing slash. */
export function embedderOrigin(): string | undefined {
    const value = vscode.workspace.getConfiguration('famiprog-vscode-forgejo').get<string>('embedderUrl')?.trim();
    if (!value) {
        return undefined;
    }
    return value.replace(/\/+$/, '');
}

/** `owner/repo`, the only input this command accepts. A full URL has more than one slash. */
export function isOwnerRepo(value: string): boolean {
    const parts = value.split('/');
    return parts.length === 2 && parts.every(part => part.length > 0 && !/\s/.test(part));
}

/**
 * The visible repos, plus the typed `owner/repo` when it is not already in that list.
 * @see commandOpenMyRepo.test.ts
 */
export function repoQuickPickItems(names: readonly string[], typed: string): vscode.QuickPickItem[] {
    const value = typed.trim();
    const items = names.map(label => ({ label }));
    if (isOwnerRepo(value) && !names.some(name => name.toLowerCase() === value.toLowerCase())) {
        items.unshift({ label: value });
    }
    return items;
}

function pickOwnerRepo(load: Promise<string[]>): Promise<string | undefined> {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = 'Forgejo repository';
    quickPick.placeholder = 'owner/repo';
    quickPick.ignoreFocusOut = true;
    quickPick.busy = true;
    let names: string[] = [];
    let choice: string | undefined;
    let gone = false;
    const refresh = () => {
        quickPick.items = repoQuickPickItems(names, quickPick.value);
    };
    return new Promise(resolve => {
        quickPick.onDidChangeValue(refresh);
        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems[0]?.label;
            const typed = quickPick.value.trim();
            const next = selected ?? (isOwnerRepo(typed) ? typed : undefined);
            if (!next || !isOwnerRepo(next)) {
                return;
            }
            choice = next;
            quickPick.hide();
        });
        quickPick.onDidHide(() => {
            gone = true;
            quickPick.dispose();
            resolve(choice);
        });
        quickPick.show();
        load.then(loaded => {
            if (gone) {
                return;
            }
            names = loaded;
            quickPick.busy = false;
            refresh();
        }).catch(error => {
            if (gone) {
                return;
            }
            quickPick.busy = false;
            void vscode.window.showErrorMessage(listFailureMessage(error));
        });
    });
}

function listFailureMessage(error: unknown): string {
    if (isAxiosError(error) && error.response) {
        const status = error.response.status;
        if (status === 401 || status === 403) {
            return `Not authorized to list repositories (HTTP ${status})`;
        }
        return `Could not list repositories (HTTP ${status})`;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not list repositories: ${detail}`;
}
