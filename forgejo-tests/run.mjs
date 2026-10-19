#!/usr/bin/env -S npx --yes zx

/**
 * This is what was used to "record" the API calls. 
 * 
 * This should be open if new recordings are needed.
 * 
 * Before --run, perform --restore. Maybe somebody has updated the data and --backup.
 * 
 * We use an archive because the data dir contains dir w/ `.git`. And this being a git repo, not OK.
 * 
 * You can checkout `sample-repo` in this dir. It is `.gitignore`d.
 * 
 * @see extension/src/node/test/ForgejoFileSystemProvider.test.ts
 */

// to avoid: $({stdio: "inherit"})`...`
$.stdio = "inherit";
$.verbose = true;

if (argv["run"]) {
    await $`docker compose run --rm --service-ports server`;
} else if (argv["backup"]) {
    await $`sudo tar -czf volume-data.tar.gz volume-data/`;
    await $`sudo chown "$USER:$USER" volume-data.tar.gz`;
} else if (argv["restore"]) {
    await $`sudo rm -rf volume-data`;
    // Root extraction restores both the owner and the mode stored in the tar, so you do not need a separate chmod or chown pass.
    // volume-data is in .gitignore
    await $`sudo tar -xzf volume-data.tar.gz`;
} else {
    console.log("Please supply an arg: --run, --backup, --restore");
    process.exit(1);
}
