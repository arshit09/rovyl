import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FolderOpen, ImagePlus, Loader2 } from 'lucide-react';
import {
  MAX_PICTURE_BYTES,
  describeIconFile,
  iconFileWithIndex,
  isIconLibraryFile,
  readBlobAsDataUrl,
  splitIconFile,
  storeIconPicture,
  type CustomIconPick,
} from '../utils/customIcon';

interface IconLibrary {
  path: string;
  count: number;
  thumbnails: string[];
  /** The icon in force, or -1 when the library was only opened to look at. */
  index: number;
}

/**
 * The icon libraries every Windows install has. Offered by name because the good ones live in
 * System32, which is not where anybody browses to on purpose.
 */
const WINDOWS_LIBRARIES = [
  { file: '%SystemRoot%\\System32\\shell32.dll', label: 'shell32.dll' },
  { file: '%SystemRoot%\\System32\\imageres.dll', label: 'imageres.dll' },
  { file: '%SystemRoot%\\System32\\ddores.dll', label: 'ddores.dll' },
];

/**
 * The last library listed, kept across mounts: the panel unmounts with its tab, and listing
 * imageres.dll again only to switch back from the glyphs would be a second of spinner for nothing.
 */
let lastLibrary: IconLibrary | null = null;

const sameFile = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The "Picture" tab of the icon modal: a picture, an .ico, or an icon out of a program, taken from
 * a file, a drop or the clipboard.
 *
 * Every result is normalized and stored before `onPick` hears of it, so the caller only ever
 * receives a finished `rovyl-icon://` reference.
 */
export function CustomIconPanel({
  current,
  onPick,
}: {
  current: CustomIconPick | null;
  onPick: (pick: CustomIconPick) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<IconLibrary | null>(() => {
    if (!lastLibrary || !current?.file || !isIconLibraryFile(current.file)) return null;
    const { path, index } = splitIconFile(current.file);
    return sameFile(path, lastLibrary.path) ? { ...lastLibrary, index } : null;
  });
  const [dragging, setDragging] = useState(false);
  /** Only the newest request may land; an older one finishing late would undo the user's last click. */
  const requestRef = useRef(0);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const currentRef = useRef(current);
  currentRef.current = current;
  const available = Boolean(window.electron?.readCustomIconSource);

  useEffect(() => {
    if (library) lastLibrary = library;
  }, [library]);

  const run = useCallback(async (label: string, work: (isCurrent: () => boolean) => Promise<void>) => {
    const token = ++requestRef.current;
    const isCurrent = () => token === requestRef.current;
    setBusy(label);
    setError(null);
    try {
      await work(isCurrent);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }, []);

  /** `apply: false` opens a library to browse without changing the icon in force. */
  const openFile = useCallback((file: string, apply: boolean) => run(
    apply ? 'Reading the file…' : 'Listing its icons…',
    async (isCurrent) => {
      const read = window.electron?.readCustomIconSource;
      if (!read) throw new Error('Icon files can only be read by the desktop app.');
      const source = await read(file);
      if (!isCurrent()) return;
      if ('error' in source) throw new Error(source.error);

      if (source.kind === 'library') {
        /**
         * Only looking: the icon in force stays highlighted if it came from this same file. Compared
         * with the path as asked for too, since main expands `%SystemRoot%` and a workspace file
         * keeps it written that way.
         */
        const inForce = currentRef.current?.file ? splitIconFile(currentRef.current.file) : null;
        const sameAsInForce = Boolean(inForce) &&
          (sameFile(inForce!.path, source.path) || sameFile(inForce!.path, splitIconFile(file).path));
        setLibrary({
          path: source.path,
          count: source.count,
          thumbnails: source.thumbnails,
          index: apply ? source.index : sameAsInForce ? inForce!.index : -1,
        });
        if (!apply) return;
        if (!source.dataUrl) throw new Error(`${describeIconFile(source.path)} has no icon number ${source.index}.`);
        const url = await storeIconPicture(source.dataUrl);
        if (isCurrent()) onPickRef.current({ url, file: iconFileWithIndex(source.path, source.index) });
        return;
      }

      if (!apply) return;
      setLibrary(null);
      const url = source.kind === 'shell' ? source.ref : await storeIconPicture(source.dataUrl);
      if (isCurrent()) onPickRef.current({ url, file: source.path });
    },
  ), [run]);

  /** A pasted screenshot, or a picture dragged out of a browser: bytes with no file behind them. */
  const openBlob = useCallback((blob: Blob) => run('Reading the picture…', async (isCurrent) => {
    if (!blob.type.startsWith('image/')) throw new Error('Only a picture can be used without a file.');
    if (blob.size > MAX_PICTURE_BYTES) throw new Error('That picture is larger than 16 MB.');
    const url = await storeIconPicture(await readBlobAsDataUrl(blob));
    if (!isCurrent()) return;
    setLibrary(null);
    onPickRef.current({ url });
  }), [run]);

  const pickLibraryIcon = (index: number) => {
    if (!library) return;
    const { path } = library;
    setLibrary({ ...library, index });
    void run('Extracting the icon…', async (isCurrent) => {
      const dataUrl = await window.electron?.extractLibraryIcon?.(path, index);
      if (!isCurrent()) return;
      if (!dataUrl) throw new Error('That icon could not be extracted.');
      const url = await storeIconPicture(dataUrl);
      if (isCurrent()) onPickRef.current({ url, file: iconFileWithIndex(path, index) });
    });
  };

  /** Reopening the modal on an icon taken from a library shows that library again. */
  useEffect(() => {
    if (library || !current?.file || !isIconLibraryFile(current.file)) return;
    void openFile(current.file, false);
    // Once, on mount: afterwards the library on screen is the one the user opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Something with a path goes through main (a program has icons to list); bytes are decoded here. */
  const openDropped = useCallback((file: File) => {
    /** Electron 28 still puts the real path on a File; a picture dragged from a browser has none. */
    const filePath = (file as File & { path?: string }).path;
    if (filePath) void openFile(filePath, true);
    else void openBlob(file);
  }, [openFile, openBlob]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const file = event.clipboardData?.files?.[0];
      if (file) {
        event.preventDefault();
        openDropped(file);
        return;
      }
      /** A path copied as text — "Copy as path" in Explorer wraps it in quotes. */
      const text = event.clipboardData?.getData('text/plain')?.trim().replace(/^"([\s\S]*)"$/, '$1') ?? '';
      if (/^([A-Za-z]:[\\/]|\\\\|%[^%]+%)/.test(text) && !/[\r\n]/.test(text)) {
        event.preventDefault();
        void openFile(text, true);
      }
    };
    /**
     * A file let go anywhere else in the window would make Electron navigate to it, replacing
     * Settings with the picture. While this panel is up, a near miss is simply nothing.
     */
    const swallow = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, [openDropped, openFile]);

  const browse = async () => {
    const file = await window.electron?.chooseCustomIconFile?.();
    if (file) void openFile(file, true);
  };

  if (!available) {
    return <p className="zs-custom-icon-note">Pictures and program icons can be chosen in the desktop app.</p>;
  }

  return (
    <div className="zs-custom-icon">
      <div
        className={`zs-custom-icon-drop${dragging ? ' is-over' : ''}`}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) openDropped(file);
        }}
      >
        <span className="zs-custom-icon-preview" aria-hidden>
          {busy ? (
            <Loader2 size={20} className="zs-spin" />
          ) : current ? (
            <img src={current.url} alt="" draggable={false} />
          ) : (
            <ImagePlus size={22} strokeWidth={1.6} />
          )}
        </span>
        <div className="zs-custom-icon-copy">
          <b>{busy ?? 'Drop a picture, an icon or a program here'}</b>
          <small>PNG, JPG, SVG, WebP, ICO, or the icons inside an EXE or DLL. Ctrl+V pastes a picture or a copied path.</small>
          <button type="button" className="zs-btn" onClick={() => void browse()} disabled={Boolean(busy)}>
            <FolderOpen size={13} /> Browse…
          </button>
        </div>
      </div>

      {error && (
        <p className="zs-custom-icon-error" role="alert">
          <AlertTriangle size={13} strokeWidth={1.9} aria-hidden />
          <span>{error}</span>
        </p>
      )}

      <div className="zs-custom-icon-sources">
        <span>Windows icons</span>
        {WINDOWS_LIBRARIES.map((entry) => (
          <button
            key={entry.file}
            type="button"
            className={library && library.path.toLowerCase().endsWith(`\\${entry.label}`) ? 'is-active' : ''}
            onClick={() => void openFile(entry.file, false)}
            disabled={Boolean(busy)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {library && (
        <section className="zs-custom-icon-library" aria-label={`Icons in ${describeIconFile(library.path)}`}>
          {/* A div, not a header: `.zs-editor header` styles every header inside the dialog. */}
          <div className="zs-custom-icon-library-head">
            <b>{describeIconFile(library.path)}</b>
            <small>{library.count === 1 ? '1 icon' : `${library.count} icons`} · click one to use it</small>
          </div>
          <div className="zs-custom-icon-grid" role="listbox" aria-label="Icons">
            {library.thumbnails.map((thumbnail, index) => (
              <button
                key={index}
                type="button"
                role="option"
                aria-selected={index === library.index}
                className={index === library.index ? 'is-selected' : ''}
                title={describeIconFile(iconFileWithIndex(library.path, index))}
                onClick={() => pickLibraryIcon(index)}
              >
                {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <span aria-hidden>?</span>}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
