import { expect } from 'chai';
import M3U8Parser from '../../../src/loader/m3u8-parser';
import { PlaylistLevelType } from '../../../src/types/loader';
import {
  exportPlaylistWindow,
  PlaylistExportError,
  PlaylistExportErrorCode,
} from '../../../src/utils/playlist-export';

const PLAYLIST_URL = 'https://example.com/live/window/playlist.m3u8';

// Media sequence starts at 90, discontinuity sequence at 2.
// Segments 90, 91, 92 are 4s each. 90 is anchored at 12:00:00Z.
// 90 and 91 address the same media file with byte-ranges 1000@0 and 1000
// (offset omitted). 92 starts a new discontinuity at 12:00:08Z with a new
// init segment.
const SAMPLE_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MEDIA-SEQUENCE:90',
  '#EXT-X-DISCONTINUITY-SEQUENCE:2',
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:00.000Z',
  '#EXT-X-MAP:URI="init-a.mp4"',
  '#EXTINF:4.0,',
  '#EXT-X-BYTERANGE:1000@0',
  'media.ts',
  '#EXTINF:4.0,',
  '#EXT-X-BYTERANGE:1000',
  'media.ts',
  '#EXT-X-DISCONTINUITY',
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:08.000Z',
  '#EXT-X-MAP:URI="init-b.mp4"',
  '#EXTINF:4.0,',
  '#EXT-X-BYTERANGE:1000@2000',
  'media.ts',
  '',
].join('\n');

function exportSample(
  start: string,
  end: string,
  playlist: string = SAMPLE_PLAYLIST,
): string {
  return exportPlaylistWindow(playlist, PLAYLIST_URL, start, end);
}

function expectExportError(
  playlist: string,
  start: string,
  end: string,
  code: PlaylistExportErrorCode,
) {
  expect(() => exportPlaylistWindow(playlist, PLAYLIST_URL, start, end))
    .to.throw(PlaylistExportError)
    .with.property('code', code);
}

describe('playlist-export', function () {
  describe('exportPlaylistWindow', function () {
    it('exports the segments intersecting [start, end) as a finite playlist', function () {
      const output = exportSample(
        '2026-11-12T12:00:04Z',
        '2026-11-12T12:00:12Z',
      );
      const lines = output.split('\n');
      expect(lines[0]).to.equal('#EXTM3U');
      expect(output).to.contain('#EXT-X-MEDIA-SEQUENCE:91');
      expect(output).to.contain('#EXT-X-DISCONTINUITY-SEQUENCE:2');
      expect(output).to.contain('#EXT-X-ENDLIST');
      // exactly two media segments
      expect(
        lines.filter((line) => line && !line.startsWith('#')),
      ).to.deep.equal([
        'https://example.com/live/window/media.ts',
        'https://example.com/live/window/media.ts',
      ]);
    });

    it('rewrites the omitted byte-range offset of segment 91 as an explicit offset', function () {
      const output = exportSample(
        '2026-11-12T12:00:04Z',
        '2026-11-12T12:00:12Z',
      );
      expect(output).to.contain('#EXT-X-BYTERANGE:1000@1000');
      expect(output).to.contain('#EXT-X-BYTERANGE:1000@2000');
      expect(output).to.not.contain('#EXT-X-BYTERANGE:1000\n');
    });

    it('keeps the discontinuity before segment 92 and switches the init segment', function () {
      const output = exportSample(
        '2026-11-12T12:00:04Z',
        '2026-11-12T12:00:12Z',
      );
      const lines = output.split('\n');
      const discontinuityIndex = lines.indexOf('#EXT-X-DISCONTINUITY');
      expect(discontinuityIndex).to.be.greaterThan(-1);
      // The discontinuity directly precedes the second segment's block
      expect(lines[discontinuityIndex + 1]).to.equal(
        '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:08.000Z',
      );
      expect(output).to.contain(
        '#EXT-X-MAP:URI="https://example.com/live/window/init-a.mp4"',
      );
      expect(output).to.contain(
        '#EXT-X-MAP:URI="https://example.com/live/window/init-b.mp4"',
      );
      expect(discontinuityIndex).to.be.greaterThan(
        lines.indexOf(
          '#EXT-X-MAP:URI="https://example.com/live/window/init-a.mp4"',
        ),
      );
    });

    it('emits extrapolated program-date-time for the first exported segment', function () {
      const output = exportSample(
        '2026-11-12T12:00:04Z',
        '2026-11-12T12:00:12Z',
      );
      expect(output).to.contain(
        '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:04.000Z',
      );
    });

    it('adjusts media and discontinuity sequences when exporting from segment 92', function () {
      const output = exportSample(
        '2026-11-12T12:00:08Z',
        '2026-11-12T12:00:12Z',
      );
      expect(output).to.contain('#EXT-X-MEDIA-SEQUENCE:92');
      expect(output).to.contain('#EXT-X-DISCONTINUITY-SEQUENCE:3');
      expect(output).to.not.contain('#EXT-X-DISCONTINUITY\n');
      expect(output).to.not.contain('init-a.mp4');
      expect(output).to.contain(
        '#EXT-X-MAP:URI="https://example.com/live/window/init-b.mp4"',
      );
      expect(output).to.contain('#EXT-X-BYTERANGE:1000@2000');
    });

    it('produces output that the parser reads back with correct sequences, discontinuities, init segments and byte-ranges', function () {
      const output = exportSample(
        '2026-11-12T12:00:04Z',
        '2026-11-12T12:00:12Z',
      );
      // Parse back as if served from a different directory
      const details = M3U8Parser.parseLevelPlaylist(
        output,
        'https://cdn.example.org/exports/clip.m3u8',
        0,
        PlaylistLevelType.MAIN,
        0,
        null,
      );
      expect(details.playlistParsingError).to.equal(null);
      expect(details.live).to.equal(false);
      expect(details.startSN).to.equal(91);
      expect(details.startCC).to.equal(2);
      expect(details.endSN).to.equal(92);
      expect(details.endCC).to.equal(3);
      const [frag91, frag92] = details.fragments;
      expect(frag91.sn).to.equal(91);
      expect(frag91.cc).to.equal(2);
      expect(frag91.programDateTime).to.equal(
        Date.parse('2026-11-12T12:00:04.000Z'),
      );
      expect(frag91.byteRange).to.deep.equal([1000, 2000]);
      expect(frag91.url).to.equal('https://example.com/live/window/media.ts');
      expect(frag91.initSegment?.url).to.equal(
        'https://example.com/live/window/init-a.mp4',
      );
      expect(frag92.sn).to.equal(92);
      expect(frag92.cc).to.equal(3);
      expect(frag92.programDateTime).to.equal(
        Date.parse('2026-11-12T12:00:08.000Z'),
      );
      expect(frag92.byteRange).to.deep.equal([2000, 3000]);
      expect(frag92.initSegment?.url).to.equal(
        'https://example.com/live/window/init-b.mp4',
      );
    });

    it('fails with TIME_GAP when the window spans a gap in the timeline', function () {
      const playlistWithGap = SAMPLE_PLAYLIST.replace(
        '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:08.000Z',
        '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:12.000Z',
      );
      expectExportError(
        playlistWithGap,
        '2026-11-12T12:00:04Z',
        '2026-11-12T12:00:12Z',
        PlaylistExportErrorCode.TimeGap,
      );
    });

    it('fails with MISSING_TIME_ANCHOR when the window crosses an unanchored discontinuity', function () {
      const playlistWithoutAnchor = SAMPLE_PLAYLIST.replace(
        '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:08.000Z\n',
        '',
      );
      expectExportError(
        playlistWithoutAnchor,
        '2026-11-12T12:00:04Z',
        '2026-11-12T12:00:12Z',
        PlaylistExportErrorCode.MissingTimeAnchor,
      );
    });

    it('fails with TIME_CONFLICT when anchors within one run disagree', function () {
      const conflicting = SAMPLE_PLAYLIST.replace(
        '#EXT-X-BYTERANGE:1000\n',
        '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T12:00:10.000Z\n#EXT-X-BYTERANGE:1000\n',
      );
      expectExportError(
        conflicting,
        '2026-11-12T12:00:00Z',
        '2026-11-12T12:00:08Z',
        PlaylistExportErrorCode.TimeConflict,
      );
    });

    it('fails with OUT_OF_WINDOW when the window is outside the available media time', function () {
      expectExportError(
        SAMPLE_PLAYLIST,
        '2026-11-12T13:00:00Z',
        '2026-11-12T13:00:30Z',
        PlaylistExportErrorCode.OutOfWindow,
      );
      expectExportError(
        SAMPLE_PLAYLIST,
        '2026-11-12T12:00:10Z',
        '2026-11-12T12:00:30Z',
        PlaylistExportErrorCode.OutOfWindow,
      );
    });

    it('fails with ENCRYPTED_PLAYLIST for playlists with EXT-X-KEY', function () {
      const encrypted = SAMPLE_PLAYLIST.replace(
        '#EXT-X-MAP:URI="init-a.mp4"',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init-a.mp4"',
      );
      expectExportError(
        encrypted,
        '2026-11-12T12:00:04Z',
        '2026-11-12T12:00:12Z',
        PlaylistExportErrorCode.EncryptedPlaylist,
      );
    });

    it('fails with UNSUPPORTED_PLAYLIST for multivariant playlists', function () {
      const multivariant = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
        'playlist.m3u8',
        '',
      ].join('\n');
      expectExportError(
        multivariant,
        '2026-11-12T12:00:04Z',
        '2026-11-12T12:00:12Z',
        PlaylistExportErrorCode.UnsupportedPlaylist,
      );
    });

    it('fails with INVALID_INPUT for an invalid time range', function () {
      expectExportError(
        SAMPLE_PLAYLIST,
        '2026-11-12T12:00:12Z',
        '2026-11-12T12:00:04Z',
        PlaylistExportErrorCode.InvalidInput,
      );
      expectExportError(
        SAMPLE_PLAYLIST,
        'not-a-date',
        '2026-11-12T12:00:04Z',
        PlaylistExportErrorCode.InvalidInput,
      );
    });
  });
});
