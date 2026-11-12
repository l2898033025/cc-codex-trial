// Local require hook that lets plain Node.js load the TypeScript sources
// under src/ and tests/ (used by tools/playlist-export-demo.mjs and
// tools/run-playlist-export-tests.cjs). The production build and karma tests
// use their own rollup pipelines and do not need this.
const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');

const pkg = require(path.join(__dirname, '..', 'package.json'));

// Compile-time feature flags normally injected by the rollup replace plugin
const defines = {
  __VERSION__: JSON.stringify(pkg.version),
  __USE_SUBTITLES__: 'true',
  __USE_ALT_AUDIO__: 'true',
  __USE_EME_DRM__: 'true',
  __USE_CMCD__: 'true',
  __USE_CONTENT_STEERING__: 'true',
  __USE_VARIABLE_SUBSTITUTION__: 'false',
  __USE_MEDIA_CAPABILITIES__: 'true',
  __USE_INTERSTITIALS__: 'true',
  __USE_IFRAMES__: 'true',
};

function applyDefines(source) {
  return source.replace(/__[A-Z_]+__/g, (token) => defines[token] ?? token);
}

require.extensions['.ts'] = function (module, filename) {
  const source = applyDefines(fs.readFileSync(filename, 'utf8'));
  const { code } = babel.transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    presets: [
      [require.resolve('@babel/preset-env'), { targets: { node: 'current' } }],
      require.resolve('@babel/preset-typescript'),
    ],
  });
  module._compile(code, filename);
};
