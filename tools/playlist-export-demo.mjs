/* eslint-disable no-console */
// Demo: export a playback window from a live media playlist into a finite,
// self-contained M3U8, then read the result back with the existing M3U8Parser
// to verify sequence numbers, discontinuities, init segments and byte-ranges.
//
// Usage: npm run demo:playlist-export
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('./babel-register.cjs');

const {
  exportPlaylistWindow,
  PlaylistExportError,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('../src/utils/playlist-export.ts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const M3U8Parser = require('../src/loader/m3u8-parser.ts').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PlaylistLevelType } = require('../src/types/loader.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures', 'playback-window.m3u8');
const outDir = path.join(here, 'out');
const SOURCE_URL = 'https://example.com/live/window/playlist.m3u8';
// The exported playlist is read back as if it were served from another
// directory, proving that all URIs in it are self-contained.
const EXPORT_URL = 'https://cdn.example.org/exports/clip.m3u8';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
  }
  console.log(
    (ok ? '  PASS ' : '  FAIL ') +
      label +
      ' = ' +
      JSON.stringify(actual) +
      (ok ? '' : ' (expected ' + JSON.stringify(expected) + ')'),
  );
}

function verifyExport(title, playlistText, start, end, expectations) {
  console.log('\n== ' + title + ' ==');
  console.log('window: [' + start + ', ' + end + ')');
  const output = exportPlaylistWindow(playlistText, SOURCE_URL, start, end);
  console.log(output);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, expectations.fileName);
  fs.writeFileSync(outPath, output);
  console.log('written to ' + path.relative(process.cwd(), outPath));

  // Read the generated playlist back with the existing parser
  const details = M3U8Parser.parseLevelPlaylist(
    output,
    EXPORT_URL,
    0,
    PlaylistLevelType.MAIN,
    0,
    null,
  );
  if (details.playlistParsingError) {
    failures++;
    console.log('  FAIL re-parse: ' + details.playlistParsingError.message);
    return;
  }
  check('ended (EXT-X-ENDLIST)', !details.live, true);
  check('media sequence', details.startSN, expectations.startSN);
  check('discontinuity sequence', details.startCC, expectations.startCC);
  check(
    'segment SNs',
    details.fragments.map((frag) => frag.sn),
    expectations.sns,
  );
  check(
    'segment CCs',
    details.fragments.map((frag) => frag.cc),
    expectations.ccs,
  );
  check(
    'program-date-times',
    details.fragments.map((frag) =>
      frag.programDateTime === null
        ? null
        : new Date(frag.programDateTime).toISOString(),
    ),
    expectations.pdts,
  );
  check(
    'media URIs',
    details.fragments.map((frag) => frag.url),
    expectations.mediaUrls,
  );
  check(
    'byte-ranges [start, end]',
    details.fragments.map((frag) => frag.byteRange),
    expectations.byteRanges,
  );
  check(
    'init segments',
    details.fragments.map((frag) => frag.initSegment?.url ?? null),
    expectations.initSegments,
  );
}

function verifyError(title, playlistText, start, end, expectedCode) {
  console.log('\n== ' + title + ' ==');
  console.log('window: [' + start + ', ' + end + ')');
  try {
    exportPlaylistWindow(playlistText, SOURCE_URL, start, end);
    failures++;
    console.log(
      '  FAIL expected error ' + expectedCode + ' but export succeeded',
    );
  } catch (err) {
    const code = err instanceof PlaylistExportError ? err.code : '(unexpected)';
    check('error code', code, expectedCode);
    console.log('  message: ' + err.message);
  }
}

const source = fs.readFileSync(fixturePath, 'utf8');
console.log('source playlist: ' + path.relative(process.cwd(), fixturePath));
console.log('source URL: ' + SOURCE_URL);

verifyExport(
  'Scenario 1: export [12:00:04Z, 12:00:12Z) -> segments 91 and 92',
  source,
  '2026-11-12T12:00:04Z',
  '2026-11-12T12:00:12Z',
  {
    fileName: 'clip-91-92.m3u8',
    startSN: 91,
    startCC: 2,
    sns: [91, 92],
    ccs: [2, 3],
    pdts: ['2026-11-12T12:00:04.000Z', '2026-11-12T12:00:08.000Z'],
    mediaUrls: [
      'https://example.com/live/window/media.ts',
      'https://example.com/live/window/media.ts',
    ],
    byteRanges: [
      [1000, 2000],
      [2000, 3000],
    ],
    initSegments: [
      'https://example.com/live/window/init-a.mp4',
      'https://example.com/live/window/init-b.mp4',
    ],
  },
);

verifyExport(
  'Scenario 2: export [12:00:08Z, 12:00:12Z) -> starts at segment 92',
  source,
  '2026-11-12T12:00:08Z',
  '2026-11-12T12:00:12Z',
  {
    fileName: 'clip-92.m3u8',
    startSN: 92,
    startCC: 3,
    sns: [92],
    ccs: [3],
    pdts: ['2026-11-12T12:00:08.000Z'],
    mediaUrls: ['https://example.com/live/window/media.ts'],
    byteRanges: [[2000, 3000]],
    initSegments: ['https://example.com/live/window/init-b.mp4'],
  },
);

// Move the anchor of segment 92 to 12:00:12Z, leaving a hole in the timeline
const sourceWithGap = source.replace(
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:08.000Z',
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:12.000Z',
);
verifyError(
  'Scenario 3: window crossing a timeline gap is refused',
  sourceWithGap,
  '2026-11-12T12:00:04Z',
  '2026-11-12T12:00:12Z',
  'TIME_GAP',
);

console.log(
  failures === 0
    ? '\nAll checks passed.'
    : '\n' + failures + ' check(s) FAILED.',
);
process.exit(failures === 0 ? 0 : 1);
