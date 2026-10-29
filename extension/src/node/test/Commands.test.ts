
suite("Commands", () => {
    
    /**
     * Menu w/ "our" commands.
     * 
     * VS Code doesn't have rich extension points for menus. We simulate such a menu w/ a status bar entry. On click, the "open command" list is opened,
     * filtered for "our" commands. I.e. "Forgejo: ...".
     */
    // @Scenario
    test("commands_menu", () => {
    })

    /**
     * `My repos -> open one`. Enabled if `embedderUrl` has value.
     * 
     * Similar to the generic `Forgejo: Open repo` command. Differences:
     * * it proposes a list of repos visible by me (e.g. `myUser/myRepo`, `myOrg/myRepo`). 
     * * I can also type e.g. `someUser/someRepo`. But I input only the format owner/repo. No full URL any more.
     */
    // @Scenario
    test("command_my_repos_open_one", () => {
    })

    /**
     * `My repos -> open all`.
     * 
     * Similar to the previous one, but w/o input box. It opens all repos visible to the user.
     */
    // @Scenario
    test("command_my_repos_open_all", () => {
    })

});
