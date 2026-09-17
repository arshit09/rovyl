import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, HelpCircle, RotateCcw } from 'lucide-react';
import type { AppItem, Workspace } from '../types';
import { resolveWebsiteIconFields } from '../siteFavicon';
import { openExternalSiteUrl } from '../utils/openExternalSiteUrl';
import {
  WORKSPACE_FILE_DOCS_URL,
  applyWorkspaceFile,
  parseWorkspaceFile,
  workspaceToFileText,
  type WorkspaceFileError,
} from '../utils/workspaceFile';

export interface WorkspaceFileEditorHandle {
  /**
   * Applies the draft if it has unsaved changes. False means the draft is invalid and the caller
   * must not leave: closing over a broken file would throw away what was typed without a word.
   */
  flush: () => boolean;
}

/** Patches one shortcut, wherever in the group tree it sits. */
function patchById(items: AppItem[], id: string, patch: Partial<AppItem>): AppItem[] {
  return items.map((item) => {
    if (item.id === id) return { ...item, ...patch };
    if (item.children?.length) return { ...item, children: patchById(item.children, id, patch) };
    return item;
  });
}

/**
 * The workspace as text. The visual editor's twin: both write the same stored workspace, and the
 * text is regenerated from it whenever there is no draft in the way, so switching back and forth
 * never shows a stale file.
 */
export const WorkspaceFileEditor = forwardRef<WorkspaceFileEditorHandle, {
  workspace: Workspace;
  isActive: boolean;
  onApply: (patch: (current: Workspace) => Partial<Workspace>) => void;
  showToast: (message: string, undo?: () => void) => void;
}>(function WorkspaceFileEditor({ workspace, isActive, onApply, showToast }, ref) {
  const saved = useMemo(() => workspaceToFileText(workspace), [workspace]);
  const [draft, setDraft] = useState(saved);
  /** The text the draft started from. A draft equal to it is not a change, whatever `saved` does meanwhile. */
  const [base, setBase] = useState(saved);
  const [error, setError] = useState<WorkspaceFileError | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const dirty = draft !== base;

  /** Someone else changed the workspace (the wheel, an undo): follow it unless there is typing to protect. */
  useEffect(() => {
    if (saved === base) return;
    if (!dirty) {
      setDraft(saved);
      setError(null);
    }
    setBase(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const fetchIcons = useCallback((items: AppItem[]) => {
    for (const item of items) {
      void (async () => {
        let patch: Partial<AppItem> | null = null;
        try {
          if (item.commandType === 'url') {
            const icon = await resolveWebsiteIconFields(item.command);
            if (icon?.customIconUrl) patch = { customIconUrl: icon.customIconUrl, iconSource: icon.iconSource };
          } else {
            const url = await window.electron?.getFileIcon?.(item.command);
            if (url) patch = { customIconUrl: url, iconSource: 'native' };
          }
        } catch {
          /* the glyph stays; the wheel draws that */
        }
        if (patch) onApply((current) => ({ apps: patchById(current.apps, item.id, patch!) }));
      })();
    }
  }, [onApply]);

  const jumpTo = useCallback((at: WorkspaceFileError) => {
    const area = textRef.current;
    if (!area) return;
    const lines = area.value.split('\n');
    let offset = 0;
    for (let i = 0; i < at.line - 1 && i < lines.length; i += 1) offset += lines[i].length + 1;
    offset += Math.max(0, at.column - 1);
    area.focus();
    area.setSelectionRange(offset, offset);
    const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 18;
    area.scrollTop = Math.max(0, (at.line - 4) * lineHeight);
  }, []);

  const apply = useCallback((): boolean => {
    const result = parseWorkspaceFile(draft);
    if ('error' in result) {
      setError(result.error);
      return false;
    }
    setError(null);
    const before = workspace;
    const { workspace: next, needsIcon } = applyWorkspaceFile(workspace, result.workspace, { isActive });
    onApply(() => ({
      name: next.name,
      enabled: next.enabled,
      pickerIconName: next.pickerIconName,
      color: next.color,
      apps: next.apps,
    }));
    fetchIcons(needsIcon);
    /** The canonical text: comments and spacing are not stored, so the draft settles on what was. */
    const canonical = workspaceToFileText(next);
    setDraft(canonical);
    setBase(canonical);
    showToast('Workspace file applied', () => {
      onApply(() => ({
        name: before.name,
        enabled: before.enabled,
        pickerIconName: before.pickerIconName,
        color: before.color,
        apps: before.apps,
      }));
    });
    return true;
  }, [draft, workspace, isActive, onApply, fetchIcons, showToast]);

  useImperativeHandle(ref, () => ({
    flush: () => {
      if (!dirty) return true;
      const ok = apply();
      if (!ok) textRef.current?.focus();
      return ok;
    },
  }), [dirty, apply]);

  const revert = () => {
    setDraft(saved);
    setBase(saved);
    setError(null);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      showToast('Copied to the clipboard');
    } catch {
      showToast('Could not reach the clipboard');
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /** Escape closes the dialog like Done does, and like Done it will not walk away from a broken draft. */
    if (event.key === 'Escape' && dirty && !apply()) {
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      apply();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const area = event.currentTarget;
      const { selectionStart, selectionEnd, value } = area;
      const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
      setDraft(next);
      requestAnimationFrame(() => area.setSelectionRange(selectionStart + 2, selectionStart + 2));
    }
  };

  const lineCount = draft.split('\n').length;

  return (
    <div className="zs-file-editor">
      <div className="zs-file-toolbar">
        <span className="zs-file-name">
          workspace.jsonc
          {dirty && <i aria-label="Unsaved changes" title="Unsaved changes" />}
        </span>
        <div className="zs-file-actions">
          <button
            type="button"
            className="zs-file-icon-btn"
            data-tip="Workspace file reference"
            aria-label="Open the workspace file reference"
            onClick={() => openExternalSiteUrl(WORKSPACE_FILE_DOCS_URL)}
          >
            <HelpCircle size={15} strokeWidth={1.8} />
          </button>
          <button type="button" className="zs-file-icon-btn" data-tip="Copy the file" aria-label="Copy the file" onClick={() => void copy()}>
            <Copy size={14} strokeWidth={1.8} />
          </button>
          <button type="button" className="zs-btn" disabled={!dirty} onClick={revert}>
            <RotateCcw size={13} /> Revert
          </button>
          <button type="button" className="zs-btn is-primary" disabled={!dirty} onClick={() => apply()} title="Ctrl+S">
            <Check size={13} /> Apply
          </button>
        </div>
      </div>

      <div className={`zs-file-code${error ? ' has-error' : ''}`}>
        <div className="zs-file-gutter" ref={gutterRef} aria-hidden>
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i} className={error?.line === i + 1 ? 'is-error' : undefined}>{i + 1}</span>
          ))}
        </div>
        <textarea
          ref={textRef}
          value={draft}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-label={`${workspace.name} as a file`}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
        />
      </div>

      {error ? (
        <button type="button" className="zs-file-error" onClick={() => jumpTo(error)}>
          <AlertTriangle size={13} strokeWidth={1.9} aria-hidden />
          <span><b>Line {error.line}, column {error.column}</b> {error.message}</span>
        </button>
      ) : (
        <p className="zs-file-hint">
          Ctrl+S applies. Paste a file someone shared to replace this workspace's contents; icons for new shortcuts are fetched after applying.
        </p>
      )}
    </div>
  );
});
