
suite("Commands", () => {

    /**
     * Enabled if the extension + its "parent" VS Code web is "embedded"/encapsulated in a Forgejo setup. I.e. the extension is not used to browse
     * any Forgejo repos on the internet; it targets the repos of the current server. Config value = `famiprog-vscode-forgejo.embedderUrl`.
     * 
     * Similar to the generic `Forgejo: Open repo` command. Differences:
     * * it proposes a list of repos visible by me (e.g. `myUser/myRepo`, `myOrg/myRepo`). 
     * * I can also type e.g. `someUser/someRepo`. But I input only the format owner/repo. No full URL any more.
     */
    // @Scenario
    test("command_my_repos_open_repo", () => {
    })


});
