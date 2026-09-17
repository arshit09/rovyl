import type { CustomIconSource } from '../types';

/**
 * Custom icons, the renderer's half: every picture a user brings — a PNG, an SVG, a pasted
 * screenshot, the 17th icon in shell32.dll — is drawn onto the same canvas `extract-icon.ps1` uses
 * for the icons Rovyl finds by itself, so on the wheel the two cannot be told apart by size.
 *
 * The normalizing happens here and not in main because Chromium decodes what GDI+ does not (WebP,
 * SVG, AVIF), and because a pasted image never had a file for main to read.
 */

/** Same canvas and the same share of it as the extractor, so a custom icon sits at the same optical size. */
const CANVAS = 256;
const CONTENT_RATIO = 0.86;
/** Alpha at or below this counts as empty margin — the extractor's threshold too. */
const ALPHA_THRESHOLD = 12;
/** Long side of the raster the margins are measured on. Plenty for a 256px result, cheap to scan. */
const WORK_SIZE = 1024;
/** Matches main's ceiling for a picture read from disk. */
export const MAX_PICTURE_BYTES = 16 * 1024 * 1024;

/** What a picker hands back: the stored picture, and the file it came from when there was one. */
export interface CustomIconPick {
  url: string;
  file?: string;
}

/** The extensions `library-icons.ps1` can list, mirrored from main for display purposes only. */
const LIBRARY_EXTENSIONS = /\.(exe|dll|icl|cpl|ocx|scr|mun)$/i;

/** `C:\x\shell32.dll` + 4 → `C:\x\shell32.dll,4`. The first icon is the bare path, as Windows writes it. */
export function iconFileWithIndex(path: string, index: number): string {
  return index === 0 ? path : `${path},${index}`;
}

/** Splits an icon location the way main does: a trailing `,<number>` is the icon's position. */
export function splitIconFile(file: string): { path: string; index: number } {
  const match = /^([\s\S]*?)\s*,\s*(-?\d+)$/.exec(file.trim());
  return match ? { path: match[1], index: Number(match[2]) } : { path: file.trim(), index: 0 };
}

/** Whether a location names a file that holds a list of icons, so the picker can show them again. */
export function isIconLibraryFile(file: string | undefined): boolean {
  return Boolean(file) && LIBRARY_EXTENSIONS.test(splitIconFile(file!).path);
}

/** `C:\Windows\System32\shell32.dll,4` → `shell32.dll,4` — short enough for a footer. */
export function describeIconFile(file: string | undefined): string {
  if (!file) return '';
  const { path, index } = splitIconFile(file);
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
  return index === 0 ? name : `${name},${index}`;
}

export function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That picture could not be read.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Any picture Chromium can decode → a 256px PNG with its transparent margins trimmed and its
 * content scaled to 86% of the canvas, centred. An opaque photo has no margin to trim and simply
 * fits the same box.
 */
export async function normalizeIconPicture(src: string): Promise<string> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    throw new Error('That picture could not be read.');
  }

  const isSvg = /^data:image\/svg\+xml[;,]/i.test(src);
  let width = image.naturalWidth;
  let height = image.naturalHeight;
  if (!width || !height) {
    /** An SVG with a viewBox and no width reports no size; it scales to whatever it is drawn at. */
    if (!isSvg) throw new Error('That picture has no size.');
    width = WORK_SIZE;
    height = WORK_SIZE;
  }

  /** A vector has no pixels to lose, so it is drawn big; a bitmap is only ever scaled down here. */
  const longSide = Math.max(width, height);
  const scale = isSvg ? WORK_SIZE / longSide : Math.min(1, WORK_SIZE / longSide);
  const workWidth = Math.max(1, Math.round(width * scale));
  const workHeight = Math.max(1, Math.round(height * scale));
  const work = document.createElement('canvas');
  work.width = workWidth;
  work.height = workHeight;
  const workContext = work.getContext('2d', { willReadFrequently: true });
  if (!workContext) throw new Error('That picture could not be drawn.');
  workContext.imageSmoothingQuality = 'high';
  workContext.drawImage(image, 0, 0, workWidth, workHeight);

  let pixels: Uint8ClampedArray;
  try {
    pixels = workContext.getImageData(0, 0, workWidth, workHeight).data;
  } catch {
    throw new Error('That picture could not be read.');
  }
  let minX = workWidth;
  let minY = workHeight;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < workHeight; y += 1) {
    const row = y * workWidth;
    for (let x = 0; x < workWidth; x += 1) {
      if (pixels[(row + x) * 4 + 3] <= ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  if (maxX < 0) throw new Error('That picture is completely transparent.');

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const fit = (CANVAS * CONTENT_RATIO) / Math.max(contentWidth, contentHeight);
  const drawWidth = Math.max(1, Math.round(contentWidth * fit));
  const drawHeight = Math.max(1, Math.round(contentHeight * fit));

  const out = document.createElement('canvas');
  out.width = CANVAS;
  out.height = CANVAS;
  const context = out.getContext('2d');
  if (!context) throw new Error('That picture could not be drawn.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    work,
    minX, minY, contentWidth, contentHeight,
    Math.round((CANVAS - drawWidth) / 2), Math.round((CANVAS - drawHeight) / 2), drawWidth, drawHeight,
  );
  return out.toDataURL('image/png');
}

/** Normalizes a picture and puts it in the icon store; resolves with its `rovyl-icon://` reference. */
export async function storeIconPicture(src: string): Promise<string> {
  const png = await normalizeIconPicture(src);
  const store = window.electron?.storeCustomIcon;
  /** Outside Electron there is no store; the config writer moves an inline PNG into it on load. */
  if (!store) return png;
  const url = await store(png);
  if (!url) throw new Error('The picture could not be saved.');
  return url;
}

/**
 * An icon location — `C:\Icons\app.png`, `%SystemRoot%\System32\shell32.dll,4`, a `.lnk` — to a
 * stored custom icon. What the workspace file uses; the picker does the same steps itself so it
 * can show a library's other icons along the way.
 */
export async function importIconFile(file: string): Promise<string> {
  const read = window.electron?.readCustomIconSource;
  if (!read) throw new Error('Icon files can only be read by the desktop app.');
  const source: CustomIconSource = await read(file);
  if ('error' in source) throw new Error(source.error);
  if (source.kind === 'shell') return source.ref;
  if (source.kind === 'library') {
    if (!source.dataUrl) throw new Error(`${describeIconFile(source.path)} has no icon number ${source.index}.`);
    return storeIconPicture(source.dataUrl);
  }
  return storeIconPicture(source.dataUrl);
}
