import M3U8Parser from '../loader/m3u8-parser';
import { PlaylistLevelType } from '../types/loader';
import type { MediaFragment } from '../loader/fragment';
import type { LevelDetails } from '../loader/level-details';

/**
 * Distinguishable error codes returned by exportPlaylistWindow so that
 * operators can tell why a playback-window export was refused.
 */
export enum PlaylistExportErrorCode {
  /** Invalid function input (bad time range, unparseable dates). */
  InvalidInput = 'INVALID_INPUT',
  /** The playlist text could not be parsed as a valid media playlist. */
  InvalidPlaylist = 'INVALID_PLAYLIST',
  /** Valid playlist, but of a kind this tool does not export
   *  (multivariant, delta update with EXT-X-SKIP, or Low-Latency parts). */
  UnsupportedPlaylist = 'UNSUPPORTED_PLAYLIST',
  /** The playlist carries EXT-X-KEY encrypted segments. */
  EncryptedPlaylist = 'ENCRYPTED_PLAYLIST',
  /** The window crosses a discontinuity (or playlist edge) whose segments
   *  have no explicit EXT-X-PROGRAM-DATE-TIME anchor. */
  MissingTimeAnchor = 'MISSING_TIME_ANCHOR',
  /** Two EXT-X-PROGRAM-DATE-TIME anchors within one continuity run disagree
   *  with the timeline extrapolated from segment durations. */
  TimeConflict = 'TIME_CONFLICT',
  /** Known wall-clock timeline has a hole inside the requested window. */
  TimeGap = 'TIME_GAP',
  /** The requested window falls (partly) outside the available media time. */
  OutOfWindow = 'OUT_OF_WINDOW',
}

export class PlaylistExportError extends Error {
  public readonly code: PlaylistExportErrorCode;

  public constructor(code: PlaylistExportErrorCode, message: string) {
    super(message);
    this.name = 'PlaylistExportError';
    this.code = code;
  }
}

// Tolerances in milliseconds
const COVERAGE_EPSILON_MS = 1;
const PDT_CONFLICT_TOLERANCE_MS = 500;

type TimedFragment = {
  frag: MediaFragment;
  // Wall-clock start of the fragment in epoch ms, or null when the fragment
  // belongs to a continuity run without an explicit PDT anchor.
  pdt: number | null;
};

/**
 * Exports a finite, self-contained media playlist covering the UTC window
 * [windowStart, windowEnd) from a live-window media playlist.
 *
 * - Segments intersecting the half-open window are kept whole and in order.
 * - Wall-clock times are only extrapolated within a continuity run (between
 *   EXT-X-DISCONTINUITY boundaries) from explicit EXT-X-PROGRAM-DATE-TIME
 *   anchors and segment durations.
 * - Media and init-segment URIs are resolved against playlistUrl, so the
 *   result can be served from any other directory.
 * - EXT-X-BYTERANGE tags are rewritten with explicit offsets so each one is
 *   interpretable on its own.
 *
 * @throws {PlaylistExportError} with a distinguishable code when the window
 *         cannot be exported completely.
 */
export function exportPlaylistWindow(
  playlistText: string,
  playlistUrl: string,
  windowStart: string | number | Date,
  windowEnd: string | number | Date,
): string {
  const startMs = toEpochMs(windowStart, 'windowStart');
  const endMs = toEpochMs(windowEnd, 'windowEnd');
  if (!(startMs < endMs)) {
    throw new PlaylistExportError(
      PlaylistExportErrorCode.InvalidInput,
      'window start (' +
        new Date(startMs).toISOString() +
        ') must be before window end (' +
        new Date(endMs).toISOString() +
        ')',
    );
  }

  const details = parseMediaPlaylist(playlistText, playlistUrl);
  const timedFragments = computeFragmentTimes(details);
  const selected = selectWindowFragments(timedFragments, startMs, endMs);
  return renderPlaylist(details, selected);
}

function toEpochMs(value: string | number | Date, name: string): number {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new PlaylistExportError(
      PlaylistExportErrorCode.InvalidInput,
      name + ' is not a valid UTC time: ' + String(value),
    );
  }
  return ms;
}

function parseMediaPlaylist(
  playlistText: string,
  playlistUrl: string,
): LevelDetails {
  if (typeof playlistText !== 'string' || !playlistText.length) {
    throw new PlaylistExportError(
      PlaylistExportErrorCode.InvalidInput,
      'playlist text is empty',
    );
  }
  if (!M3U8Parser.isMediaPlaylist(playlistText)) {
    throw new PlaylistExportError(
      PlaylistExportErrorCode.UnsupportedPlaylist,
      'input is not a media playlist (multivariant playlists and playlists without segments are not supported)',
    );
  }
  const details = M3U8Parser.parseLevelPlaylist(
    playlistText,
    playlistUrl,
    0,
    PlaylistLevelType.MAIN,
    0,
    null,
  );
  if (details.playlistParsingError) {
    throw new PlaylistExportError(
      PlaylistExportErrorCode.InvalidPlaylist,
      'could not parse media playlist: ' + details.playlistParsingError.message,
    );
  }
  if (details.skippedSegments > 0 || details.fragments.some((frag) => !frag)) {
    throw new PlaylistExportError(
      PlaylistExportErrorCode.UnsupportedPlaylist,
      'delta playlists with EXT-X-SKIP are not supported; provide a playlist with complete segments',
    );
  }
  if (details.partList?.length || details.fragmentHint) {
    throw new PlaylistExportError(
      PlaylistExportErrorCode.UnsupportedPlaylist,
      'playlists with partial segments (LL-HLS EXT-X-PART / PRELOAD-HINT) are not supported',
    );
  }
  if (!details.fragments.length) {
    throw new PlaylistExportError(
      PlaylistExportErrorCode.InvalidPlaylist,
      'media playlist contains no segments',
    );
  }
  if (
    details.encryptedFragments.length ||
    details.fragments.some(
      (frag) => frag.levelkeys && Object.keys(frag.levelkeys).length > 0,
    )
  ) {
    throw new PlaylistExportError(
      PlaylistExportErrorCode.EncryptedPlaylist,
      'playlists with EXT-X-KEY encrypted segments are not supported',
    );
  }
  return details;
}

/**
 * Assigns a wall-clock time to every fragment, extrapolating only within a
 * continuity run (same cc) from explicit EXT-X-PROGRAM-DATE-TIME anchors and
 * segment durations. Fragments in runs without an anchor get null.
 */
function computeFragmentTimes(details: LevelDetails): TimedFragment[] {
  const fragments = details.fragments;
  const timed: TimedFragment[] = fragments.map((frag) => ({
    frag,
    pdt: null,
  }));

  let runStart = 0;
  while (runStart < fragments.length) {
    let runEnd = runStart + 1;
    while (
      runEnd < fragments.length &&
      fragments[runEnd].cc === fragments[runStart].cc
    ) {
      runEnd++;
    }
    assignRunTimes(timed, runStart, runEnd);
    runStart = runEnd;
  }
  return timed;
}

function assignRunTimes(
  timed: TimedFragment[],
  runStart: number,
  runEnd: number,
): void {
  // Cumulative media offsets (seconds) within the run
  const offsets: number[] = [];
  let offset = 0;
  for (let i = runStart; i < runEnd; i++) {
    offsets.push(offset);
    offset += timed[i].frag.duration;
  }

  // Collect explicit anchors of this run
  const anchors: { index: number; time: number }[] = [];
  for (let i = runStart; i < runEnd; i++) {
    const raw = timed[i].frag.rawProgramDateTime;
    if (raw !== null) {
      const time = Date.parse(raw);
      if (!Number.isFinite(time)) {
        throw new PlaylistExportError(
          PlaylistExportErrorCode.InvalidPlaylist,
          'invalid EXT-X-PROGRAM-DATE-TIME value "' +
            raw +
            '" on segment ' +
            timed[i].frag.sn,
        );
      }
      anchors.push({ index: i - runStart, time });
    }
  }
  if (!anchors.length) {
    return;
  }

  const base = anchors[0];
  for (let i = 0; i < offsets.length; i++) {
    timed[runStart + i].pdt =
      base.time + (offsets[i] - offsets[base.index]) * 1000;
  }

  // Additional anchors in the same run must agree with the extrapolated
  // timeline, otherwise the wall-clock information is conflicting.
  for (let a = 1; a < anchors.length; a++) {
    const anchor = anchors[a];
    const extrapolated = timed[runStart + anchor.index].pdt as number;
    if (Math.abs(extrapolated - anchor.time) > PDT_CONFLICT_TOLERANCE_MS) {
      throw new PlaylistExportError(
        PlaylistExportErrorCode.TimeConflict,
        'EXT-X-PROGRAM-DATE-TIME on segment ' +
          timed[runStart + anchor.index].frag.sn +
          ' (' +
          new Date(anchor.time).toISOString() +
          ') conflicts with the timeline extrapolated from the previous anchor (' +
          new Date(extrapolated).toISOString() +
          ')',
      );
    }
  }
}

function intersects(
  pdt: number,
  duration: number,
  startMs: number,
  endMs: number,
): boolean {
  return (
    pdt < endMs - COVERAGE_EPSILON_MS &&
    pdt + duration * 1000 > startMs + COVERAGE_EPSILON_MS
  );
}

/**
 * Selects the fragments covering [startMs, endMs), verifying that the known
 * wall-clock timeline covers the whole window without holes.
 */
function selectWindowFragments(
  timed: TimedFragment[],
  startMs: number,
  endMs: number,
): TimedFragment[] {
  // Walk the playlist in order, advancing a coverage frontier over the
  // window. Unknown-time fragments (unanchored runs) and EXT-X-GAP segments
  // never advance the frontier.
  let frontier = startMs;
  let pendingUnknown = false;
  for (
    let i = 0;
    i < timed.length && frontier < endMs - COVERAGE_EPSILON_MS;
    i++
  ) {
    const { frag, pdt } = timed[i];
    if (pdt === null) {
      pendingUnknown = true;
      continue;
    }
    const fragStart = pdt;
    const fragEnd = pdt + frag.duration * 1000;
    if (fragEnd <= frontier + COVERAGE_EPSILON_MS) {
      continue;
    }
    if (fragStart > frontier + COVERAGE_EPSILON_MS || frag.gap) {
      throw classifyHole(timed, frontier, pendingUnknown, startMs, endMs);
    }
    frontier = Math.max(frontier, fragEnd);
    pendingUnknown = false;
  }
  if (frontier < endMs - COVERAGE_EPSILON_MS) {
    throw classifyHole(timed, frontier, pendingUnknown, startMs, endMs);
  }

  return timed.filter(
    ({ frag, pdt }) =>
      pdt !== null && intersects(pdt, frag.duration, startMs, endMs),
  );
}

function classifyHole(
  timed: TimedFragment[],
  position: number,
  pendingUnknown: boolean,
  startMs: number,
  endMs: number,
): PlaylistExportError {
  const windowLabel =
    '[' +
    new Date(startMs).toISOString() +
    ', ' +
    new Date(endMs).toISOString() +
    ')';
  const at = new Date(position).toISOString();
  if (pendingUnknown) {
    return new PlaylistExportError(
      PlaylistExportErrorCode.MissingTimeAnchor,
      'window ' +
        windowLabel +
        ' reaches a discontinuity run without an EXT-X-PROGRAM-DATE-TIME anchor near ' +
        at,
    );
  }
  const hasKnownBefore = timed.some(
    ({ frag, pdt }) =>
      pdt !== null &&
      pdt + frag.duration * 1000 <= position + COVERAGE_EPSILON_MS,
  );
  const hasKnownAfter = timed.some(
    ({ pdt }) => pdt !== null && pdt >= position - COVERAGE_EPSILON_MS,
  );
  if (hasKnownBefore && hasKnownAfter) {
    return new PlaylistExportError(
      PlaylistExportErrorCode.TimeGap,
      'window ' + windowLabel + ' spans a gap in the media timeline at ' + at,
    );
  }
  return new PlaylistExportError(
    PlaylistExportErrorCode.OutOfWindow,
    'window ' +
      windowLabel +
      ' extends beyond the available media time at ' +
      at,
  );
}

function renderPlaylist(
  details: LevelDetails,
  selected: TimedFragment[],
): string {
  const first = selected[0].frag;
  const needsMapByteRange = selected.some(
    ({ frag }) => frag.initSegment?.byteRange.length,
  );
  const lines: string[] = ['#EXTM3U'];
  const version = Math.max(details.version || 0, needsMapByteRange ? 4 : 0);
  if (version > 0) {
    lines.push('#EXT-X-VERSION:' + version);
  }
  const targetduration =
    details.targetduration ||
    Math.ceil(
      selected.reduce((max, { frag }) => Math.max(max, frag.duration), 0),
    );
  lines.push('#EXT-X-TARGETDURATION:' + targetduration);
  lines.push('#EXT-X-MEDIA-SEQUENCE:' + first.sn);
  lines.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + first.cc);

  let previousCc = first.cc;
  let previousMapKey: string | null = null;
  for (let i = 0; i < selected.length; i++) {
    const { frag, pdt } = selected[i];
    const discontinuity = frag.cc !== previousCc;
    if (discontinuity) {
      lines.push('#EXT-X-DISCONTINUITY');
      previousCc = frag.cc;
    }
    if (i === 0 || discontinuity || frag.rawProgramDateTime !== null) {
      lines.push(
        '#EXT-X-PROGRAM-DATE-TIME:' +
          new Date(Math.round(pdt as number)).toISOString(),
      );
    }
    const init = frag.initSegment;
    const mapKey = init ? init.url + '|' + init.byteRange.join(',') : '(none)';
    if (mapKey !== previousMapKey) {
      if (init) {
        lines.push(renderMap(init));
      }
      previousMapKey = mapKey;
    }
    lines.push(
      '#EXTINF:' + formatDuration(frag.duration) + ',' + (frag.title || ''),
    );
    const byteRange = frag.byteRange;
    if (byteRange.length === 2) {
      // Always emit an explicit offset so the tag is self-contained
      lines.push(
        '#EXT-X-BYTERANGE:' +
          (byteRange[1] - byteRange[0]) +
          '@' +
          byteRange[0],
      );
    }
    lines.push(frag.url);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

function renderMap(init: NonNullable<MediaFragment['initSegment']>): string {
  let tag = '#EXT-X-MAP:URI="' + init.url + '"';
  const byteRange = init.byteRange;
  if (byteRange.length === 2) {
    tag +=
      ',BYTERANGE="' + (byteRange[1] - byteRange[0]) + '@' + byteRange[0] + '"';
  }
  return tag;
}

function formatDuration(duration: number): string {
  return String(Math.round(duration * 1000) / 1000);
}
