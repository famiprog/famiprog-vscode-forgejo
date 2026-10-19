import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const extensionDir = path.resolve(import.meta.dirname, '..');

await runTests({
    extensionDevelopmentPath: extensionDir,
    extensionTestsPath: path.join(extensionDir, 'dist/node/test/extensionTests.cjs'),
    // The extension only has a `browser` entry, so VS Code would otherwise run these tests
    // in the web worker, where Node built-ins such as `node:path` do not exist.
    launchArgs: ['--extensionDevelopmentKind=workspace'],
});
