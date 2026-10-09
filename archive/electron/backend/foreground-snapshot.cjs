/**
 * Reading the foreground helper's replies.
 *
 * `backend/foreground-focus.ps1` answers `FG` with one line shaped `FG|<bounds>|<exe>|<title>`,
 * and the two halves of understanding that line — splitting the stream into lines at all, and
 * pulling a snapshot out of one — live here so they can be tested without booting Electron.
 */

/**
 * "There is a foreground window but nothing can be learned about it."
 *
 * Distinct from `null`, which means the helper is down and the caller should fall back to spawning
 * `get-foreground-exe.ps1`. The bounds are null too, not merely the path: with bounds present and
 * no path, `isBoundsFullscreenMonitor` loses both its own-exe and shell guards and starts reporting
 * fullscreen for windows it should ignore — which would block the wheel instead of failing open.
 */
const UNKNOWN_FOREGROUND = Object.freeze({
  title: "",
  owner: Object.freeze({ path: null }),
  bounds: null,
});

/**
 * `<bounds>|<exe>|<title>` — only the first two separators are structural.
 *
 * A Windows path cannot contain '|', so the exe field is unambiguous; everything after the second
 * separator is the title and keeps any separators of its own. Real titles do contain them —
 * "Text to Speech | ElevenLabs - Google Chrome" is one — so splitting the whole line would shift
 * the fields and hand the caller a truncated title.
 */
function parseForegroundSnapshot(payload) {
  const firstBar = payload.indexOf("|");
  if (firstBar < 0) return UNKNOWN_FOREGROUND;
  const secondBar = payload.indexOf("|", firstBar + 1);
  const boundsRaw = payload.slice(0, firstBar);
  const exe = secondBar < 0 ? payload.slice(firstBar + 1) : payload.slice(firstBar + 1, secondBar);
  const title = secondBar < 0 ? "" : payload.slice(secondBar + 1);
  if (!exe) return UNKNOWN_FOREGROUND;

  let bounds = null;
  const parts = boundsRaw.split(",");
  if (parts.length === 4) {
    const numbers = parts.map((value) => Number(value));
    if (numbers.every((value) => Number.isFinite(value))) {
      bounds = { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
    }
  }
  return { title, owner: { path: exe }, bounds };
}

/**
 * Turns a stream of arbitrary chunks into whole lines.
 *
 * A `data` event is not a message: it can carry two replies, or half of one. That only became
 * load-bearing once `FG` started sharing the pipe with `FOCUS` — before, every reply was a short
 * word and a chunk happened to be a line.
 */
function createLineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      const text = line.trim();
      if (text) onLine(text);
    }
  };
}

module.exports = { UNKNOWN_FOREGROUND, parseForegroundSnapshot, createLineSplitter };
