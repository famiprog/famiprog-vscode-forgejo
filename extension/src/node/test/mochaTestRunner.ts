import Mocha from 'mocha';

const mocha = new Mocha({ ui: 'tdd' });
// Node Mocha installs `suite`/`test` when it loads a file. The bundle entry imports the test files
// right after this module, so install the globals now.
mocha.suite.emit('pre-require', globalThis, '', mocha);

export function run(): Promise<void> {

	return new Promise((resolve, reject) => {
		try {
			mocha.run(failures => {
				if (failures > 0) {
					reject(new Error(`${failures} tests failed.`));
				} else {
					resolve();
				}
			});
		} catch (err) {
			console.error(err);
			reject(err);
		}
	});
}
