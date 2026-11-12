// Standalone runner for the playlist-export unit test. The repo's karma
// suite needs a browser; this runs the same test file under plain Node.js by
// requiring it through the esbuild hook (see tools/esbuild-register.cjs).
require('./babel-register.cjs');
const path = require('node:path');
const Mocha = require('mocha');

const mocha = new Mocha({ reporter: 'spec', ui: 'bdd' });
const files = process.argv.slice(2);
const targets = files.length
  ? files
  : [
      path.join(
        __dirname,
        '..',
        'tests',
        'unit',
        'utils',
        'playlist-export.ts',
      ),
    ];

mocha.suite.emit('pre-require', global, __filename, mocha);
for (const file of targets) {
  require(path.resolve(file));
}
mocha.run((failures) => {
  process.exitCode = failures ? 1 : 0;
});
