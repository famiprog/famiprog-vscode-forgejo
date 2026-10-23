import esbuild from 'esbuild';
import { glob } from 'glob';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * This plugin hooks into the build process to print errors in a format that the problem matcher in
 * Visual Studio Code can understand.
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};


/**
 * For web extension, all tests, including the test runner, need to be bundled into
 * a single module that has a exported `run` function .
 * This plugin bundles implements a virtual file extensionTests.ts that bundles all these together.
 * @type {import('esbuild').Plugin}
 */
const testBundlePlugin = {
	name: 'testBundlePlugin',
	setup(build) {
		build.onResolve({ filter: /[\/\\]extensionTests\.ts$/ }, args => {
			if (args.kind === 'entry-point') {
				return { path: path.resolve(args.path) };
			}
		});
		build.onLoad({ filter: /[\/\\]extensionTests\.ts$/ }, async args => {
			const testsRoot = path.dirname(args.path);
			const files = await glob('*.test.{ts,tsx}', { cwd: testsRoot, posix: true });
			return {
				contents:
					`export { run } from './mochaTestRunner.ts';` +
					files.map(f => `import('./${f}');`).join(''),
				watchDirs: files.map(f => path.dirname(path.resolve(testsRoot, f))),
				watchFiles: files.map(f => path.resolve(testsRoot, f))
			};
		});
	}
};

async function main() {
	const shared = {
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		outExtension: { '.js': '.cjs' },
		external: ['vscode'],
		logLevel: 'silent',
	};
	// The extension and its browser tests run in a web worker.
	const web = await esbuild.context({
		...shared,
		entryPoints: [
			'src/web/extension.ts',
			'src/web/test/suite/extensionTests.ts'
		],
		platform: 'browser',
		outdir: 'dist/web',
		// Node.js global to browser globalThis
		define: {
			global: 'globalThis',
		},
		plugins: [
			NodeGlobalsPolyfillPlugin({
				process: true,
				buffer: true,
			}),
			testBundlePlugin,
			esbuildProblemMatcherPlugin, /* add to the end of plugins array */
		],
	});
	// `src/node/test` runs in the Node extension host. See the "Extension Tests (Node)" launch config.
	// `extensionTests.ts` is virtual: the plugin exports `run` and imports every `*.test.ts` next to it.
	const nodeTests = await esbuild.context({
		...shared,
		entryPoints: {
			// Loaded by the Node extension host (`main` in package.json); `activate` registers the provider.
			extension: 'src/web/extension.ts',
			'test/extensionTests': 'src/node/test/extensionTests.ts',
		},
		platform: 'node',
		outdir: 'dist/node',
		plugins: [
			testBundlePlugin,
			esbuildProblemMatcherPlugin,
		],
	});
	// Page script imported by forgejo-tests/index.html and vscode-web/index.html. ESM so the page can import it.
	const webIndexHtml = await esbuild.context({
		bundle: true,
		format: 'esm',
		platform: 'browser',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		entryPoints: ['src/web-index-html/index.ts'],
		outdir: 'dist/web-index-html',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});
	if (watch) {
		await Promise.all([web.watch(), nodeTests.watch(), webIndexHtml.watch()]);
	} else {
		await web.rebuild();
		await nodeTests.rebuild();
		await webIndexHtml.rebuild();
		await web.dispose();
		await nodeTests.dispose();
		await webIndexHtml.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
