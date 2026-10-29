import * as vscode from 'vscode';

export const COMMAND_SHOW_COMMANDS = 'famiprog-vscode-forgejo.showCommands';

/** Command-palette value that lists this extension's commands (`Forgejo: …`). */
const FORGEJO_COMMANDS = '>Forgejo: ';

/**
 * Status-bar stand-in for a Forgejo menu. VS Code has no extension point for a custom menu,
 * so the click opens the command list pre-filtered to commands titled `Forgejo: …`.
 */
export function register() {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, Number.MAX_VALUE);
    item.name = 'Forgejo';
    item.text = '$(git-branch) Forgejo';
    item.tooltip = 'Forgejo commands';
    item.command = COMMAND_SHOW_COMMANDS;
    item.show();

    const command = vscode.commands.registerCommand(COMMAND_SHOW_COMMANDS, () => {
        return vscode.commands.executeCommand('workbench.action.quickOpen', FORGEJO_COMMANDS);
    });
    return vscode.Disposable.from(item, command);
}
