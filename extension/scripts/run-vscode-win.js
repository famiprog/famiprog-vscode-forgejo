import path from 'node:path';

const mappedDriveLetter = "w:";

// /home/... -> W:\home\...
export function toWin(p) {
  return mappedDriveLetter + path.resolve(p).replaceAll("/", "\\");
}

/**
 * Developing VS Code extensions in WSL has the following limitation:
 * Cannot start code --extensionDevelopmentPath=<WSL path>. The workaround is
 * to launch, from Win, something like this:
 * 
 * code --extensionDevelopmentPath=W:\...\theDirWithExtension W:\...\theDirWithASampleWorkspace
 * 
 * W: uses `Map network drive` and points in my case to `\\wsl.localhost\Ubuntu`
 * A one liner w/ absolute path is possible:
 * cd /mnt/c && cmd.exe /c "code --extensionDevelopmentPath=W:\\...\\theDirWithExtension W:\\...\\theDirWithASampleWorkspace"
 * 
 * This script helps to realize this, but w/ relative dir.
 */
export async function run() {
  await $({ cwd: "/mnt/c" })`cmd.exe /s /c ${`code --extensionDevelopmentPath=${toWin(".")} --folder-uri=forgejo://localhost:3001/forgejo/hello-world`}`;
}

export async function install() {
  await $({ cwd: "/mnt/c" })`cmd.exe /s /c ${`code --install-extension=${toWin(".")}`}`;
}

