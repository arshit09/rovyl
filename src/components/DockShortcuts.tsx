import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  File as FileGlyph,
  FilePlus2,
  FolderOpen,
  Globe2,
  GripVertical,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type { AppItem } from '../types';
import type { ShortcutDockConfig } from '../utils/screenDocks';
import { getIcon } from '../iconMap';
import { SmartIcon } from './SmartIcon';
import { NativeAppIcon, useInstalledApps } from './installedApps';
import { startMenuAppIdToLaunchCommand } from '../utils/windowsLaunchCommand';
import { resolveWebsiteIconFields } from '../siteFavicon';
import { hostLabelFromUrl, normalizeSiteUrl, resolveWebsiteTitle } from '../siteTitle';

/**
 * The list behind the shortcut dock.
 *
 * A deliberately smaller thing than `WorkspaceManager`, and not a reuse of it. That component
 * edits a WHEEL: it carries folders, per-item MRU probing, terminal commands, launch modes,
 * direction assignment and a crowding warning derived from 360°. A dock is a flat strip of icons
 * that are clicked, so the questions it has to answer are the name, the target, the glyph and the
 * order — and offering the other seven on a thing that cannot use them is worse than not offering
 * them at all.
 *
 * It lives in its own module so that none of it is reachable from the wheel's entry graph. The
 * dock's DRAWING is in `ScreenDocks.tsx`, which the wheel loads; this is Settings only.
 */

type AddMode = 'app' | 'url' | 'folder' | 'file' | null;

const APPS_PAGE_SIZE = 40;

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function fileNameLabel(path: string): string {
  const base = path.split(/[/\\]/).filter(Boolean).pop() || 'File';
  return base.replace(/\.[^.]+$/, '');
}

function targetLabel(item: AppItem): string {
  if (item.commandType === 'url') return item.command;
  if (item.commandType === 'folder') return item.command;
  if (item.commandType === 'file') return item.command;
  return item.command;
}

function kindLabel(item: AppItem): string {
  if (item.commandType === 'url') return 'Web link';
  if (item.commandType === 'folder') return 'Folder';
  if (item.commandType === 'file') return 'File';
  if (item.commandType === 'command') return 'Command';
  return 'Application';
}

/** The glyph an item wears when it has no bitmap and nothing has been picked for it. */
function fallbackIconName(item: AppItem): string {
  const picked = item.iconName?.trim();
  if (picked) return picked;
  if (item.commandType === 'folder') return 'Folder';
  if (item.commandType === 'url') return 'Globe';
  if (item.commandType === 'file') return 'File';
  if (item.commandType === 'command') return 'TerminalSquare';
  return 'AppWindow';
}

/**
 * The item's bitmap, with its glyph behind it.
 *
 * `customIconUrl` names a file the main process keeps in userData and there are ordinary ways for
 * it to be gone. Choosing between image and glyph in the parent renders NOTHING when the image
 * fails, which is the failure both the wheel and the workspace list already learned to avoid.
 */
function DockItemIcon({ item }: { item: AppItem }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.customIconUrl]);
  const Glyph = getIcon(fallbackIconName(item));
  return (
    <span className="zs-workspace-app-icon" aria-hidden>
      {item.customIconUrl && !failed ? (
        <SmartIcon
          src={item.customIconUrl}
          className="zs-workspace-native-icon"
          displayScale={0.78}
          onError={() => setFailed(true)}
        />
      ) : (
        <Glyph size={17} strokeWidth={1.8} />
      )}
    </span>
  );
}

export interface DockShortcutsManagerProps {
  dock: ShortcutDockConfig;
  onChange: (items: AppItem[]) => void;
  /** Same toast the workspace list uses, so a deleted icon can be put back. */
  showToast: (message: string, undo?: () => void) => void;
  /** Opens the shared glyph picker for one item; the caller owns the modal. */
  onPickIcon: (itemId: string) => void;
}

export function DockShortcutsManager({
  dock,
  onChange,
  showToast,
  onPickIcon,
}: DockShortcutsManagerProps) {
  const [addMode, setAddMode] = useState<AddMode>(null);
  const { apps: installedApps, loading: loadingApps, error: appsError, reload } =
    useInstalledApps(addMode === 'app');
  const [appSearch, setAppSearch] = useState('');
  const [url, setUrl] = useState('');
  const [urlLabel, setUrlLabel] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [folderLabel, setFolderLabel] = useState('');
  const [filePath, setFilePath] = useState('');
  const [fileLabel, setFileLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const items = dock.items;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const add = (item: AppItem) => {
    onChange([...itemsRef.current, item]);
    setAddMode(null);
    setAppSearch('');
    setUrl('');
    setUrlLabel('');
    setFolderPath('');
    setFolderLabel('');
    setFilePath('');
    setFileLabel('');
  };

  const addAppPath = async (path: string, label?: string) => {
    const clean = path.trim();
    if (!clean) return;
    setBusy(true);
    try {
      const name =
        label?.trim() ||
        clean.split(/[/\\]/).filter(Boolean).pop()?.replace(/\.(exe|lnk|bat|cmd)$/i, '') ||
        'Application';
      let customIconUrl: string | undefined;
      try {
        customIconUrl = (await window.electron?.getFileIcon?.(clean)) || undefined;
      } catch {
        /* the glyph fallback covers extraction failing */
      }
      add({
        id: newId(),
        type: 'app',
        label: name,
        iconName: 'AppWindow',
        iconSource: customIconUrl ? 'native' : 'lucide',
        customIconUrl,
        command: clean,
        commandType: 'app',
        description: 'Application',
      });
    } finally {
      setBusy(false);
    }
  };

  const chooseAppFile = async () => {
    const path = await window.electron?.selectFile?.();
    if (path) await addAppPath(path);
  };

  const addUrl = async () => {
    const normalized = normalizeSiteUrl(url);
    if (!normalized) return;
    setBusy(true);
    try {
      const typed = urlLabel.trim();
      /** The icon and the name are two independent fetches; neither should wait on the other. */
      const [icon, title] = await Promise.all([
        resolveWebsiteIconFields(normalized),
        typed ? Promise.resolve(null) : resolveWebsiteTitle(normalized),
      ]);
      add({
        id: newId(),
        type: 'app',
        label: typed || title || hostLabelFromUrl(normalized),
        iconName: 'Globe',
        iconSource: icon?.iconSource || 'lucide',
        customIconUrl: icon?.customIconUrl,
        command: normalized,
        commandType: 'url',
        description: 'Web link',
      });
    } finally {
      setBusy(false);
    }
  };

  const chooseFolder = async () => {
    const path = await window.electron?.selectFolder?.();
    if (!path) return;
    setFolderPath(path);
    if (!folderLabel) setFolderLabel(path.split(/[/\\]/).filter(Boolean).pop() || 'Folder');
  };

  const addFolder = () => {
    if (!folderPath) return;
    add({
      id: newId(),
      type: 'app',
      label: folderLabel.trim() || 'Folder',
      iconName: 'Folder',
      iconSource: 'lucide',
      command: folderPath,
      commandType: 'folder',
      description: 'Folder shortcut',
    });
  };

  const chooseDocumentFile = async () => {
    const path = await window.electron?.selectFile?.({ mode: 'any' });
    if (!path) return;
    setFilePath(path);
    if (!fileLabel) setFileLabel(fileNameLabel(path));
  };

  const addFile = async () => {
    const clean = filePath.trim();
    if (!clean) return;
    setBusy(true);
    try {
      let customIconUrl: string | undefined;
      try {
        customIconUrl = (await window.electron?.getFileIcon?.(clean)) || undefined;
      } catch {
        /* the glyph fallback covers extraction failing */
      }
      add({
        id: newId(),
        type: 'app',
        label: fileLabel.trim() || fileNameLabel(clean),
        iconName: 'File',
        iconSource: customIconUrl ? 'native' : 'lucide',
        customIconUrl,
        command: clean,
        commandType: 'file',
        description: 'File shortcut',
      });
    } finally {
      setBusy(false);
    }
  };

  const rename = (id: string, label: string) => {
    onChange(itemsRef.current.map((item) => (item.id === id ? { ...item, label } : item)));
  };

  /**
   * Remove, and keep it for as long as the toast lives.
   *
   * Filtering inline loses an icon that was found, named and placed, to a click on a 13px target.
   * Restoring puts it back at the index it left from, not at the end of the strip — the order of a
   * dock IS its content.
   */
  const remove = (index: number) => {
    const item = itemsRef.current[index];
    if (!item) return;
    onChange(itemsRef.current.filter((_, at) => at !== index));
    showToast(`Removed “${item.label}”`, () => {
      const current = itemsRef.current;
      /** Already back — undone twice, or added again by hand. */
      if (current.some((existing) => existing.id === item.id)) return;
      const next = [...current];
      next.splice(Math.min(index, next.length), 0, item);
      onChange(next);
    });
  };

  /* -- Dragging, armed only from the handle ------------------------------- */

  const [dragArmed, setDragArmed] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropEdge, setDropEdge] = useState<{ index: number; edge: 'above' | 'below' } | null>(null);

  /** `insertBefore` refers to the ORIGINAL list: removing the source shifts everything after it. */
  const reorder = (from: number, insertBefore: number) => {
    const next = [...itemsRef.current];
    if (!next[from]) return;
    const [moved] = next.splice(from, 1);
    const target = Math.max(
      0,
      Math.min(from < insertBefore ? insertBefore - 1 : insertBefore, next.length),
    );
    if (target === from) return;
    next.splice(target, 0, moved);
    onChange(next);
  };

  const filteredApps = useMemo(() => {
    const term = appSearch.trim().toLowerCase();
    return installedApps.filter(
      (item) => !term || `${item.DisplayName || ''} ${item.Name || ''}`.toLowerCase().includes(term),
    );
  }, [installedApps, appSearch]);

  const [visibleCount, setVisibleCount] = useState(APPS_PAGE_SIZE);
  useEffect(() => setVisibleCount(APPS_PAGE_SIZE), [appSearch, installedApps]);
  const visibleApps = filteredApps.slice(0, visibleCount);

  return (
    <div className="zs-workspace-manager">
      <section className="zs-workspace-shortcuts">
        <div className="zs-workspace-section-head">
          <div><h3>Dock icons</h3></div>
          <div className="zs-add-actions" aria-label="Add to the dock">
            <button type="button" className={addMode === 'app' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'app' ? null : 'app')}><Monitor size={14} /> Application</button>
            <button type="button" className={addMode === 'url' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'url' ? null : 'url')}><Globe2 size={14} /> URL</button>
            <button type="button" className={addMode === 'folder' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'folder' ? null : 'folder')}><FolderOpen size={14} /> Folder</button>
            <button type="button" className={addMode === 'file' ? 'is-active' : ''} onClick={() => setAddMode(addMode === 'file' ? null : 'file')}><FileGlyph size={14} /> File</button>
          </div>
        </div>

        <div className={`zs-workspace-workbench${addMode ? ' is-split' : ''}`}>
          {addMode === 'app' && (
            <div className="zs-add-panel">
              <div className="zs-add-panel-head">
                <label className="zs-search is-manager-search">
                  <Search size={14} />
                  <input
                    value={appSearch}
                    onChange={(event) => setAppSearch(event.target.value)}
                    placeholder="Search applications"
                  />
                </label>
                <button type="button" className="zs-btn" onClick={() => void chooseAppFile()}>
                  <FilePlus2 size={14} /> Choose a file
                </button>
              </div>
              <div
                className="zs-installed-apps"
                onScroll={(event) => {
                  const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
                  if (scrollHeight - scrollTop - clientHeight < 180) {
                    setVisibleCount((count) => Math.min(count + APPS_PAGE_SIZE, filteredApps.length));
                  }
                }}
              >
                {loadingApps ? (
                  <div className="zs-manager-empty"><Loader2 className="zs-spin" size={18} /> Reading the Start Menu…</div>
                ) : visibleApps.length ? (
                  visibleApps.map((app, index) => (
                    <button
                      type="button"
                      key={`${app.Path}-${index}`}
                      onClick={() =>
                        void addAppPath(startMenuAppIdToLaunchCommand(app.Path!), app.DisplayName || app.Name)
                      }
                    >
                      <NativeAppIcon path={app.Path} size={28} className="zs-installed-app-icon" fallback={<Monitor size={15} />} />
                      <div><b>{app.DisplayName || app.Name}</b><small>{app.Path}</small></div>
                      <Plus size={14} />
                    </button>
                  ))
                ) : appsError ? (
                  <div className="zs-manager-empty">
                    Could not list applications.
                    <button type="button" className="zs-btn" onClick={() => reload(true)}>Try again</button>
                  </div>
                ) : (
                  <div className="zs-manager-empty">No applications found. Choose a file instead.</div>
                )}
              </div>
              {!loadingApps && installedApps.length > 0 && (
                <div className="zs-add-panel-foot">
                  <span>{visibleApps.length} / {filteredApps.length} applications</span>
                  <button type="button" onClick={() => reload(true)}>Reload the list</button>
                </div>
              )}
            </div>
          )}

          {addMode === 'url' && (
            <div className="zs-add-panel">
              <div className="zs-add-form">
                <label className="zs-field">
                  <span>Address</span>
                  <input
                    autoFocus
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://example.com"
                    onKeyDown={(event) => { if (event.key === 'Enter') void addUrl(); }}
                  />
                </label>
                <label className="zs-field">
                  <span>Name</span>
                  <input
                    value={urlLabel}
                    onChange={(event) => setUrlLabel(event.target.value)}
                    placeholder="Filled automatically"
                    onKeyDown={(event) => { if (event.key === 'Enter') void addUrl(); }}
                  />
                </label>
                <button type="button" className="zs-btn is-primary" disabled={!url.trim() || busy} onClick={() => void addUrl()}>
                  {busy ? <Loader2 size={13} className="zs-spin" /> : <Plus size={14} />} Add URL
                </button>
              </div>
            </div>
          )}

          {addMode === 'folder' && (
            <div className="zs-add-panel">
              <div className="zs-add-form">
                <button type="button" className="zs-folder-picker" onClick={() => void chooseFolder()}>
                  <FolderOpen size={20} />
                  <div>
                    <b>{folderPath ? folderPath.split(/[/\\]/).filter(Boolean).pop() : 'Select a folder'}</b>
                    <small>{folderPath || 'Opens File Explorer'}</small>
                  </div>
                  <ChevronRight size={15} />
                </button>
                <label className="zs-field">
                  <span>Name</span>
                  <input value={folderLabel} onChange={(event) => setFolderLabel(event.target.value)} placeholder="Name shown in the dock" />
                </label>
                <button type="button" className="zs-btn is-primary" disabled={!folderPath} onClick={addFolder}>
                  <Plus size={14} /> Add folder
                </button>
              </div>
            </div>
          )}

          {addMode === 'file' && (
            <div className="zs-add-panel">
              <div className="zs-add-form">
                <button type="button" className="zs-folder-picker" onClick={() => void chooseDocumentFile()}>
                  <FileGlyph size={20} />
                  <div>
                    <b>{filePath ? filePath.split(/[/\\]/).filter(Boolean).pop() : 'Select a file'}</b>
                    <small>{filePath || 'Opens with whatever Windows uses for that file type'}</small>
                  </div>
                  <ChevronRight size={15} />
                </button>
                <label className="zs-field">
                  <span>Name</span>
                  <input value={fileLabel} onChange={(event) => setFileLabel(event.target.value)} placeholder="Name shown in the dock" />
                </label>
                <button type="button" className="zs-btn is-primary" disabled={!filePath || busy} onClick={() => void addFile()}>
                  {busy ? <Loader2 size={13} className="zs-spin" /> : <Plus size={14} />} Add file
                </button>
              </div>
            </div>
          )}

          <div className="zs-workspace-items">
            {items.length === 0 && (
              <div className="zs-manager-empty">
                The dock is empty. Add an application, a website, a folder or a file — it appears in
                the corner you chose whenever the wheel is open.
              </div>
            )}
            {items.map((item, index) => (
              <div
                key={item.id}
                className={
                  'zs-workspace-item'
                  + (dragIndex === index ? ' is-dragging' : '')
                  + (dropEdge?.index === index && dropEdge.edge === 'above' ? ' is-drop-above' : '')
                  + (dropEdge?.index === index && dropEdge.edge === 'below' ? ' is-drop-below' : '')
                }
                draggable={dragArmed === index}
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', String(index));
                  event.dataTransfer.effectAllowed = 'move';
                  setDragIndex(index);
                }}
                onDragEnd={() => { setDragIndex(null); setDropEdge(null); setDragArmed(null); }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const rect = event.currentTarget.getBoundingClientRect();
                  setDropEdge({
                    index,
                    edge: event.clientY < rect.top + rect.height / 2 ? 'above' : 'below',
                  });
                }}
                onDragLeave={() => setDropEdge((current) => (current?.index === index ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = Number(event.dataTransfer.getData('text/plain'));
                  const edge = dropEdge?.index === index ? dropEdge.edge : 'above';
                  setDragIndex(null);
                  setDropEdge(null);
                  if (!Number.isInteger(from)) return;
                  reorder(from, edge === 'below' ? index + 1 : index);
                }}
              >
                <div className="zs-workspace-item-main">
                  {/* The drag only arms on the handle: a drag over the name field is a text
                      selection, and turning that into a reorder is how a rename becomes a move. */}
                  <span
                    className="zs-item-grip"
                    aria-hidden="true"
                    onPointerDown={() => setDragArmed(index)}
                    onPointerUp={() => setDragArmed(null)}
                  >
                    <GripVertical size={14} strokeWidth={1.9} />
                  </span>
                  <DockItemIcon item={item} />
                  <div className="zs-workspace-item-copy">
                    <input
                      className="zs-dock-name-input"
                      value={item.label}
                      aria-label={`Name of ${item.label}`}
                      onChange={(event) => rename(item.id, event.target.value)}
                    />
                    <small title={targetLabel(item)}>{kindLabel(item)} · {targetLabel(item)}</small>
                  </div>
                  {/* One cell, so the row keeps the four-column grid the workspace list uses. */}
                  <div className="zs-item-actions">
                    <button
                      type="button"
                      title="Change the glyph"
                      aria-label={`Change the glyph for ${item.label}`}
                      onClick={() => onPickIcon(item.id)}
                    >
                      <Pencil size={13} strokeWidth={1.9} />
                    </button>
                    <button
                      type="button"
                      title="Remove from the dock"
                      aria-label={`Remove ${item.label} from the dock`}
                      onClick={() => remove(index)}
                    >
                      <Trash2 size={13} strokeWidth={1.9} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
