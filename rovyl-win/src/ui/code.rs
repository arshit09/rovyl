//! A small code editor, for the one thing in the product that is edited as text.
//!
//! The workspace dialog has two views. The first is the grid of controls; the second is this — the
//! workspace's own JSON, in a box that can be typed into. It exists because a wheel of forty
//! shortcuts is forty cards to scroll through for a change that is one search-and-replace, and
//! because a workspace someone was handed as text has nowhere else to go.
//!
//! **A character grid, not a text layout.** Every position here is a `(line, column)` pair and
//! every column is one cell wide, measured once from the monospace face. That is what makes the
//! caret cheap: its x is `column × cell`, and a click's column is the same arithmetic backwards.
//! The alternative — asking DirectWrite to hit-test a layout — means a layout per visible line per
//! frame, and `gfx::text` caches by `(style, string)`, so a file being typed into would evict the
//! cache on every keystroke.
//!
//! The grid's one cost is honest and worth naming: a glyph wider than a cell — CJK in a label,
//! most emoji — overhangs its cell. Runs are drawn from their own column rather than from the
//! previous run's end, so the drift cannot accumulate past the token it is in, and the caret stays
//! on the grid the columns are counted on. A JSON configuration is overwhelmingly ASCII; a label
//! in Chinese renders slightly loose and stays entirely usable.
//!
//! **Lines, not one string.** Every operation in here is addressed by line and column — drawing a
//! viewport, moving the caret down, numbering a gutter, pointing at a parse error. One `String`
//! would mean converting an offset to a line for all four of them, on every frame.
//!
//! **Undo is whole snapshots.** A workspace is a few kilobytes, and the editor holds at most a few
//! hundred of them. A diff-based history is the right answer for a megabyte of source and is a
//! great deal of machinery to get subtly wrong for a text this size.
//!
//! **What this is not.** There is no find, no multiple cursors, no bracket matching and no
//! auto-closing pairs. The last one is a deliberate omission rather than a missing feature: a
//! pair-closer has to guess whether the quote being typed opens or closes, and it guesses wrong
//! exactly when a value already has text after it — which, in a field being corrected, is always.

use super::widgets::{self as w};
use super::{Cursor, Frame, Input};
use crate::config::snippet::{self, Problem};
use crate::config::Workspace;
use crate::gfx::painter::Rect;
use crate::gfx::text::{Align, Family, Style};
use windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F;

// ── Measurements ────────────────────────────────────────────────────────────

/// The type size. Smaller than the panel's body text, as code always is: a line of JSON is longer
/// than a sentence and the box it has to fit in is a dialog, not a window.
const SIZE: f32 = 12.0;
/// How tall a line of it occupies. 1.45, not the 1.5 the dialog's prose uses — code is read down a
/// column of indents rather than across, and the tighter step is what keeps a nested block
/// readable as a block.
const LINE: f32 = 17.5;
/// The gutter's padding, on both sides of the numbers.
const GUTTER_PAD: f32 = 8.0;
/// The text's own left inset, past the gutter's rule.
const TEXT_PAD: f32 = 10.0;
/// The line under the box, which says what the text parses as.
const STATUS_H: f32 = 34.0;
/// How many lines one notch of the wheel moves.
const WHEEL_LINES: usize = 3;
/// One level of indent. Two spaces, which is what `snippet::to_text` writes.
const INDENT: &str = "  ";
/// How far back the history goes.
const UNDO_LIMIT: usize = 240;
/// The caret's blink, in milliseconds on and off — the platform's own rate.
const BLINK_MS: u128 = 530;

/// The monospace style. Always left to right, whatever the interface language is: JSON is a
/// left-to-right grammar, and an Arabic panel that mirrored the code would put the braces on the
/// wrong end of a structure whose nesting is read from the left.
fn mono(scale: f32) -> Style {
    Style::new(Family::Mono, SIZE * scale, 400, Align::Leading)
}

/// The gutter's numbers: the same face, a touch lighter, so they read as furniture.
fn gutter_style(scale: f32) -> Style {
    Style::new(Family::Mono, (SIZE - 0.5) * scale, 400, Align::Trailing)
}

// ── Where the caret is ──────────────────────────────────────────────────────

/// A place in the text. Columns are counted in CHARACTERS, never in bytes: the grid is a grid of
/// glyphs, and a byte column would put the caret inside a multi-byte character.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Spot {
    pub line: usize,
    pub col: usize,
}

/// One state the text was in, for the history.
#[derive(Debug, Clone)]
struct Step {
    lines: Vec<String>,
    caret: Spot,
}

/// What kind of edit the last keystroke was, so a run of them is one undo.
///
/// Typing a word and then undoing should give back the line as it was, not the word one character
/// shorter. `Other` never coalesces: a paste, a newline or a Tab is a step of its own however many
/// of them arrive in a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Group {
    Typing,
    Erasing,
    Other,
}

/// What the text last parsed as.
#[derive(Debug, Clone, Default)]
struct Verdict {
    problem: Option<Problem>,
    /// How many shortcuts the text describes, counting the ones inside folders.
    items: usize,
    /// What applying it would quietly repair. See `snippet::Parsed::healed`.
    healed: Vec<String>,
}

// ── The buffer ──────────────────────────────────────────────────────────────

/// The workspace being edited as text, and everything about that edit.
///
/// Held by `SettingsUi` rather than by the configuration, because this is a value the config has
/// not accepted yet — the same reason `Ui::editing` exists for a one-line field. It is dropped when
/// the dialog closes, which is the one place unapplied text can be lost and therefore the one place
/// that asks twice.
pub struct Buffer {
    /// The workspace this text came out of, by id. Checked on every frame: the dialog can be
    /// closed and another workspace opened, and text belonging to the previous one must not be
    /// shown over it — let alone applied to it.
    owner: String,
    lines: Vec<String>,
    caret: Spot,
    /// The other end of the selection, when there is one.
    anchor: Option<Spot>,
    /// The column a vertical move is trying to keep.
    ///
    /// Without it, moving down through a short line and on to a long one lands at the short line's
    /// end rather than back out at the column the journey started in — which is the behaviour
    /// every editor has and nobody can describe until it is missing.
    goal: usize,
    scroll_line: usize,
    scroll_col: usize,
    /// The text as the workspace currently holds it: what Revert goes back to, and what "changed"
    /// is measured against.
    saved: String,
    undo: Vec<Step>,
    redo: Vec<Step>,
    /// The group the last edit belonged to, or `None` after anything that breaks a run.
    group: Option<Group>,
    /// Bumped by every edit, so the parse can be skipped on the frames that changed nothing.
    revision: u64,
    checked: u64,
    verdict: Verdict,
    /// When the caret last moved. The blink is measured from here, so a caret that is being driven
    /// is solid — a cursor that vanishes mid-keystroke reads as a dropped key.
    moved: std::time::Instant,
    /// A drag that began inside the text, so it keeps selecting when the pointer leaves.
    dragging: bool,
}

impl Buffer {
    /// Open the editor on `workspace`.
    pub fn open(workspace: &Workspace) -> Self {
        let text = snippet::to_text(workspace);
        Self {
            owner: workspace.id.clone(),
            lines: split(&text),
            caret: Spot::default(),
            anchor: None,
            goal: 0,
            scroll_line: 0,
            scroll_col: 0,
            saved: text,
            undo: Vec::new(),
            redo: Vec::new(),
            group: None,
            revision: 0,
            checked: u64::MAX,
            verdict: Verdict::default(),
            moved: std::time::Instant::now(),
            dragging: false,
        }
    }

    pub fn owns(&self, id: &str) -> bool {
        self.owner == id
    }

    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    /// Whether the text differs from what the workspace holds.
    pub fn changed(&self) -> bool {
        self.text() != self.saved
    }

    pub fn problem(&self) -> Option<&Problem> {
        self.verdict.problem.as_ref()
    }

    /// How many times the text has changed.
    ///
    /// Read by the discard confirmation, which carries it in its key: a warning that was answered
    /// and then typed past is a warning about a different text, and the next press has to ask
    /// again rather than act on a sentence that scrolled away minutes ago.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Throw the text away and start again from the workspace.
    ///
    /// The history goes with it. An undo that reached back past a Revert would walk the text to a
    /// state the workspace never had, which is a confusing thing to then be able to Apply.
    pub fn revert(&mut self, workspace: &Workspace) {
        *self = Self::open(workspace);
    }

    /// Park the view at `line` and `col`, for the probe.
    ///
    /// A scrolled editor is reachable only with a wheel, so without this the one picture that can
    /// be taken of it is the top of the file.
    pub fn scroll_to(&mut self, line: usize, col: usize) {
        self.scroll_line = line.min(self.lines.len().saturating_sub(1));
        self.scroll_col = col;
    }

    /// Put `text` in the box, as though it had been typed there.
    ///
    /// For the probe, which photographs faces that are otherwise only reachable by typing — the
    /// broken-text one above all, which is the state the status line exists for and the one state
    /// a screenshot of a working editor can never show.
    pub fn replace_all(&mut self, text: &str) {
        self.lines = split(&normalize_pasted(text));
        self.caret = Spot::default();
        self.anchor = None;
        self.scroll_line = 0;
        self.scroll_col = 0;
        self.revision += 1;
    }

    /// Read the text as a workspace, for the Apply button.
    ///
    /// `Err` is what the status line is already showing, so the caller does not have to say it
    /// again — it only has to not apply.
    pub fn parse(&self, identity: &Workspace) -> Result<snippet::Parsed, Problem> {
        snippet::parse(&self.text(), identity)
    }

    /// Note that `applied` is now what the workspace holds.
    ///
    /// The text is re-written from it when the two differ, which is how a repair becomes visible:
    /// a shortcut that was given an id, or a key that was cut to one character, is in the box
    /// afterwards rather than only in a sentence under it. When they agree — the ordinary case —
    /// nothing moves, because re-writing identical text would still throw the caret back to the
    /// top of a file somebody is working down.
    pub fn applied(&mut self, applied: &Workspace) {
        let next = snippet::to_text(applied);
        self.saved = next.clone();
        if next != self.text() {
            self.lines = split(&next);
            self.anchor = None;
            self.clamp_caret();
            self.revision += 1;
        }
    }

    // ── Selection ───────────────────────────────────────────────────────────

    /// The selection, low end first, or `None` when it is empty.
    fn selection(&self) -> Option<(Spot, Spot)> {
        let anchor = self.anchor?;
        if anchor == self.caret {
            return None;
        }
        Some(if anchor < self.caret {
            (anchor, self.caret)
        } else {
            (self.caret, anchor)
        })
    }

    fn selected_text(&self) -> Option<String> {
        let (from, to) = self.selection()?;
        if from.line == to.line {
            let line = self.lines.get(from.line)?;
            return Some(slice(line, from.col, to.col));
        }
        let mut out = String::new();
        out.push_str(&tail(self.lines.get(from.line)?, from.col));
        for line in &self.lines[from.line + 1..to.line] {
            out.push('\n');
            out.push_str(line);
        }
        out.push('\n');
        out.push_str(&head(self.lines.get(to.line)?, to.col));
        Some(out)
    }

    /// Cut the selection out. True when there was one.
    fn drop_selection(&mut self) -> bool {
        let Some((from, to)) = self.selection() else {
            return false;
        };
        let merged = format!(
            "{}{}",
            head(&self.lines[from.line], from.col),
            tail(&self.lines[to.line], to.col)
        );
        self.lines.splice(from.line..=to.line, [merged]);
        self.caret = from;
        self.anchor = None;
        self.goal = from.col;
        true
    }

    fn select_all(&mut self) {
        self.anchor = Some(Spot::default());
        let line = self.lines.len().saturating_sub(1);
        self.caret = Spot { line, col: chars(&self.lines[line]) };
        self.goal = self.caret.col;
    }

    // ── Editing ─────────────────────────────────────────────────────────────

    /// Push the current state onto the history, unless it continues the run already on top.
    fn remember(&mut self, group: Group) {
        if group != Group::Other && self.group == Some(group) {
            return;
        }
        self.undo.push(Step { lines: self.lines.clone(), caret: self.caret });
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
        // Any edit at all invalidates the forward history: this is a new branch, and the states
        // that used to come after the one being left are no longer reachable from it.
        self.redo.clear();
        self.group = Some(group);
    }

    /// Insert `text` over the selection. Handles embedded newlines, which is what a paste is.
    fn insert(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.drop_selection();
        let pieces = split(&normalize_pasted(text));
        let at = self.caret;
        let line = self.lines[at.line].clone();
        let before = head(&line, at.col);
        let after = tail(&line, at.col);

        if pieces.len() == 1 {
            self.lines[at.line] = format!("{before}{}{after}", pieces[0]);
            self.caret.col = at.col + chars(&pieces[0]);
        } else {
            let last = pieces.len() - 1;
            let mut rebuilt: Vec<String> = Vec::with_capacity(pieces.len());
            rebuilt.push(format!("{before}{}", pieces[0]));
            rebuilt.extend(pieces[1..last].iter().cloned());
            rebuilt.push(format!("{}{after}", pieces[last]));
            self.caret = Spot {
                line: at.line + last,
                col: chars(&pieces[last]),
            };
            self.lines.splice(at.line..=at.line, rebuilt);
        }
        self.goal = self.caret.col;
        self.revision += 1;
    }

    /// Enter: a new line, carrying the indent, and one level more after an opening bracket.
    ///
    /// The second half is why this is not just an inserted newline. JSON is written as nested
    /// blocks, and a newline that landed at column zero after `"apps": [` would have to be
    /// indented by hand every single time.
    fn newline(&mut self) {
        self.drop_selection();
        let line = self.lines[self.caret.line].clone();
        let before = head(&line, self.caret.col);
        let after = tail(&line, self.caret.col);
        let mut indent: String = before
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect();
        if before.trim_end().ends_with(['{', '[']) {
            indent.push_str(INDENT);
        }
        // A closing bracket already sitting to the right goes to its own line, at the indent the
        // block opened on. Typing Enter between `[` and `]` is how an empty array is filled, and
        // leaving the `]` welded to the caret's new line is a bracket that has to be moved by hand.
        let closes = after.trim_start().starts_with(['}', ']']);
        let outer = indent
            .strip_suffix(INDENT)
            .map(str::to_string)
            .unwrap_or_else(|| indent.clone());

        self.lines[self.caret.line] = before;
        if closes && !after.trim().is_empty() {
            self.lines.insert(self.caret.line + 1, format!("{outer}{}", after.trim_start()));
            self.lines.insert(self.caret.line + 1, indent.clone());
        } else {
            self.lines.insert(self.caret.line + 1, format!("{indent}{after}"));
        }
        self.caret = Spot {
            line: self.caret.line + 1,
            col: chars(&indent),
        };
        self.goal = self.caret.col;
        self.revision += 1;
    }

    fn backspace(&mut self) {
        if self.drop_selection() {
            self.revision += 1;
            return;
        }
        if self.caret.col > 0 {
            // A Backspace inside the leading whitespace takes the whole indent step, so one press
            // undoes one Tab. Past the indent it takes one character, because there it is text.
            let line = self.lines[self.caret.line].clone();
            let before = head(&line, self.caret.col);
            let step = if before.chars().all(|c| c == ' ') && before.len() >= INDENT.len() {
                INDENT.len().min(self.caret.col)
            } else {
                1
            };
            let from = self.caret.col - step;
            self.lines[self.caret.line] = format!("{}{}", head(&line, from), tail(&line, self.caret.col));
            self.caret.col = from;
        } else if self.caret.line > 0 {
            let line = self.lines.remove(self.caret.line);
            self.caret.line -= 1;
            self.caret.col = chars(&self.lines[self.caret.line]);
            self.lines[self.caret.line].push_str(&line);
        } else {
            return;
        }
        self.goal = self.caret.col;
        self.revision += 1;
    }

    fn delete(&mut self) {
        if self.drop_selection() {
            self.revision += 1;
            return;
        }
        let width = chars(&self.lines[self.caret.line]);
        if self.caret.col < width {
            let line = self.lines[self.caret.line].clone();
            self.lines[self.caret.line] =
                format!("{}{}", head(&line, self.caret.col), tail(&line, self.caret.col + 1));
        } else if self.caret.line + 1 < self.lines.len() {
            let next = self.lines.remove(self.caret.line + 1);
            self.lines[self.caret.line].push_str(&next);
        } else {
            return;
        }
        self.revision += 1;
    }

    /// Tab: one indent step, or a step on every line the selection touches.
    fn indent(&mut self, out: bool) {
        match self.selection() {
            Some((from, to)) => {
                for index in from.line..=to.line {
                    let line = &mut self.lines[index];
                    if out {
                        for _ in 0..INDENT.len() {
                            if line.starts_with(' ') {
                                line.remove(0);
                            }
                        }
                    } else if !line.trim().is_empty() {
                        line.insert_str(0, INDENT);
                    }
                }
                // The selection keeps the lines it had, out to their new ends: an indent that
                // collapsed the selection would have to be re-made for every level.
                let low = Spot { line: from.line, col: 0 };
                let high = Spot { line: to.line, col: chars(&self.lines[to.line]) };
                self.anchor = Some(low);
                self.caret = high;
            }
            None if out => {
                let line = &mut self.lines[self.caret.line];
                let mut removed = 0;
                for _ in 0..INDENT.len() {
                    if line.starts_with(' ') {
                        line.remove(0);
                        removed += 1;
                    }
                }
                self.caret.col = self.caret.col.saturating_sub(removed);
            }
            None => {
                self.insert(INDENT);
                return;
            }
        }
        self.goal = self.caret.col;
        self.revision += 1;
    }

    fn undo(&mut self) {
        let Some(step) = self.undo.pop() else { return };
        self.redo.push(Step { lines: self.lines.clone(), caret: self.caret });
        self.lines = step.lines;
        self.caret = step.caret;
        self.anchor = None;
        self.group = None;
        self.clamp_caret();
        self.revision += 1;
    }

    fn redo(&mut self) {
        let Some(step) = self.redo.pop() else { return };
        self.undo.push(Step { lines: self.lines.clone(), caret: self.caret });
        self.lines = step.lines;
        self.caret = step.caret;
        self.anchor = None;
        self.group = None;
        self.clamp_caret();
        self.revision += 1;
    }

    // ── Moving ──────────────────────────────────────────────────────────────

    /// Put the caret at `to`, extending the selection or dropping it.
    fn go(&mut self, to: Spot, extend: bool) {
        if extend {
            if self.anchor.is_none() {
                self.anchor = Some(self.caret);
            }
        } else {
            self.anchor = None;
        }
        self.caret = to;
        self.clamp_caret();
        self.moved = std::time::Instant::now();
        // A move ends a typing run: undoing after moving away should give back the word, not the
        // word plus whatever was typed somewhere else afterwards.
        self.group = None;
    }

    /// Pull the caret — and the anchor with it — back inside the text.
    ///
    /// The anchor as well as the caret, because the two are read as a PAIR by everything that
    /// touches a selection, and `drop_selection` indexes both ends. An anchor left pointing past a
    /// line that an undo or an apply shortened is a panic in a paint path, which is the worst
    /// place in the program to have one.
    fn clamp_caret(&mut self) {
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
        let last = self.lines.len() - 1;
        self.caret.line = self.caret.line.min(last);
        self.caret.col = self.caret.col.min(chars(&self.lines[self.caret.line]));
        if let Some(anchor) = self.anchor.as_mut() {
            anchor.line = anchor.line.min(last);
            anchor.col = anchor.col.min(chars(&self.lines[anchor.line]));
        }
    }

    fn left(&self) -> Spot {
        if self.caret.col > 0 {
            Spot { line: self.caret.line, col: self.caret.col - 1 }
        } else if self.caret.line > 0 {
            Spot {
                line: self.caret.line - 1,
                col: chars(&self.lines[self.caret.line - 1]),
            }
        } else {
            self.caret
        }
    }

    fn right(&self) -> Spot {
        if self.caret.col < chars(&self.lines[self.caret.line]) {
            Spot { line: self.caret.line, col: self.caret.col + 1 }
        } else if self.caret.line + 1 < self.lines.len() {
            Spot { line: self.caret.line + 1, col: 0 }
        } else {
            self.caret
        }
    }

    /// The next word boundary, forward or back.
    ///
    /// Boundaries are between CLASSES of character and not at spaces, which is what makes a word
    /// move useful in a text that is half punctuation: `"commandType":` is two stops — the end of
    /// the quoted word, then the end of the `":` that closes it — rather than one jump over the
    /// whole thing.
    ///
    /// Going forward, whitespace is crossed BEFORE the run rather than counted as a run of its
    /// own. Otherwise the stop after a word is the gap in front of the next one, and every word
    /// costs two presses to reach — which is the one thing a word move exists to avoid.
    fn word(&self, forward: bool) -> Spot {
        let line = &self.lines[self.caret.line];
        let glyphs: Vec<char> = line.chars().collect();
        let mut at = self.caret.col;
        if forward {
            if at >= glyphs.len() {
                return self.right();
            }
            while at < glyphs.len() && glyphs[at].is_whitespace() {
                at += 1;
            }
            if at < glyphs.len() {
                let start = class(glyphs[at]);
                while at < glyphs.len() && class(glyphs[at]) == start {
                    at += 1;
                }
            }
        } else {
            if at == 0 {
                return self.left();
            }
            at -= 1;
            while at > 0 && class(glyphs[at]) == Class::Space {
                at -= 1;
            }
            let start = class(glyphs[at]);
            while at > 0 && class(glyphs[at - 1]) == start {
                at -= 1;
            }
        }
        Spot { line: self.caret.line, col: at }
    }

    /// Home: the first non-space, or column zero when already there.
    ///
    /// Two stops rather than one, as every code editor has: in text that is three levels indented,
    /// "the start of the line" almost always means the start of the words.
    fn home(&self) -> Spot {
        let line = &self.lines[self.caret.line];
        let indent = line.chars().take_while(|c| c.is_whitespace()).count();
        Spot {
            line: self.caret.line,
            col: if self.caret.col == indent { 0 } else { indent },
        }
    }

    fn vertical(&self, by: isize) -> Spot {
        let line = (self.caret.line as isize + by).clamp(0, self.lines.len() as isize - 1) as usize;
        Spot {
            line,
            col: self.goal.min(chars(&self.lines[line])),
        }
    }

    /// Scroll so the caret is in view. Called after anything that moves it.
    fn reveal(&mut self, rows: usize, cols: usize) {
        if rows == 0 || cols == 0 {
            return;
        }
        if self.caret.line < self.scroll_line {
            self.scroll_line = self.caret.line;
        } else if self.caret.line >= self.scroll_line + rows {
            self.scroll_line = self.caret.line + 1 - rows;
        }
        if self.caret.col < self.scroll_col {
            self.scroll_col = self.caret.col;
        } else if self.caret.col >= self.scroll_col + cols {
            self.scroll_col = self.caret.col + 1 - cols;
        }
    }

    fn widest(&self) -> usize {
        self.lines.iter().map(|l| chars(l)).max().unwrap_or(0)
    }

    // ── Reading the text ────────────────────────────────────────────────────

    /// Parse the text, at most once per change.
    ///
    /// Once per change and not once per frame: a dialog sitting open repaints for every pointer
    /// move, and re-parsing a few kilobytes of JSON on each of those would be work nobody asked
    /// for. Once per keystroke is the rate the status line actually changes at.
    fn check(&mut self, identity: &Workspace) {
        if self.checked == self.revision {
            return;
        }
        self.checked = self.revision;
        self.verdict = match snippet::parse(&self.text(), identity) {
            Ok(parsed) => Verdict {
                problem: None,
                items: count_items(&parsed.workspace),
                healed: parsed.healed,
            },
            Err(problem) => Verdict {
                problem: Some(problem),
                items: 0,
                healed: Vec::new(),
            },
        };
    }
}

/// Every shortcut in a workspace, folders' children included.
fn count_items(workspace: &Workspace) -> usize {
    fn walk(items: &[crate::config::AppItem]) -> usize {
        items
            .iter()
            .map(|item| 1 + walk(item.child_slice()))
            .sum()
    }
    walk(&workspace.apps)
}

// ── Characters ──────────────────────────────────────────────────────────────

fn chars(line: &str) -> usize {
    line.chars().count()
}

fn byte_of(line: &str, col: usize) -> usize {
    line.char_indices().nth(col).map(|(at, _)| at).unwrap_or(line.len())
}

fn head(line: &str, col: usize) -> String {
    line[..byte_of(line, col)].to_string()
}

fn tail(line: &str, col: usize) -> String {
    line[byte_of(line, col)..].to_string()
}

fn slice(line: &str, from: usize, to: usize) -> String {
    line[byte_of(line, from)..byte_of(line, to)].to_string()
}

/// The text as lines, with at least one line.
///
/// An empty `Vec` would be a buffer with nowhere to put the caret, and every method here indexes
/// `lines[caret.line]`.
fn split(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

/// What arrives from the clipboard, made fit for a character grid.
///
/// Tabs become an indent step, because the grid draws a tab as one cell and nothing in the product
/// writes one. Carriage returns go, because a Windows clipboard is full of them and a `\r` left in
/// a line is an invisible character inside a JSON string.
fn normalize_pasted(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").replace('\t', INDENT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Space,
    Word,
    Punct,
}

fn class(c: char) -> Class {
    if c.is_whitespace() {
        Class::Space
    } else if c.is_alphanumeric() || c == '_' || c == '-' || c == '.' {
        Class::Word
    } else {
        Class::Punct
    }
}

// ── Colouring ───────────────────────────────────────────────────────────────

/// What a run of characters is, for the one thing the colour has to tell anybody: whether a string
/// is a key or a value.
///
/// That is the distinction worth a hue in a configuration file. The rest — a number against a
/// keyword against a brace — is there so the keys stand out of something rather than out of a flat
/// wall, which is the same reason the panel's captions are a weight below its titles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Token {
    /// A string with a colon after it.
    Key,
    Str,
    Num,
    /// `true`, `false`, `null` — and anything else bare, which is a fault the parser will name.
    Word,
    Punct,
}

/// Split one line into coloured runs of `(column, width, what)`.
///
/// Per line and not across the file, which is the one decision in here. A JSON string cannot
/// contain a raw newline, so no correct file has a run that crosses a line — and carrying an
/// unterminated quote onward would paint the whole rest of the workspace as a string because of
/// one typo, hiding the structure exactly when it is being looked for.
pub fn tokens(line: &str) -> Vec<(usize, usize, Token)> {
    let glyphs: Vec<char> = line.chars().collect();
    let mut runs = Vec::new();
    let mut at = 0usize;
    while at < glyphs.len() {
        let c = glyphs[at];
        if c.is_whitespace() {
            at += 1;
            continue;
        }
        if c == '"' {
            let start = at;
            at += 1;
            while at < glyphs.len() {
                if glyphs[at] == '\\' {
                    // The escape and whatever it escapes, together: a `\"` is not the end of the
                    // string, and treating it as one puts every quote after it on the wrong side.
                    at += 2;
                    continue;
                }
                if glyphs[at] == '"' {
                    at += 1;
                    break;
                }
                at += 1;
            }
            at = at.min(glyphs.len());
            // A key is a string with a colon after it, whitespace aside. That is the whole test,
            // and it is right for every pretty-printed object.
            let is_key = glyphs[at..]
                .iter()
                .find(|c| !c.is_whitespace())
                .is_some_and(|c| *c == ':');
            runs.push((start, at - start, if is_key { Token::Key } else { Token::Str }));
            continue;
        }
        if c.is_ascii_digit() || (c == '-' && glyphs.get(at + 1).is_some_and(char::is_ascii_digit)) {
            let start = at;
            at += 1;
            while at < glyphs.len()
                && (glyphs[at].is_ascii_digit()
                    || glyphs[at] == '.'
                    || glyphs[at] == 'e'
                    || glyphs[at] == 'E'
                    || ((glyphs[at] == '+' || glyphs[at] == '-')
                        && matches!(glyphs[at - 1], 'e' | 'E')))
            {
                at += 1;
            }
            runs.push((start, at - start, Token::Num));
            continue;
        }
        if c.is_alphabetic() {
            let start = at;
            while at < glyphs.len() && glyphs[at].is_alphanumeric() {
                at += 1;
            }
            runs.push((start, at - start, Token::Word));
            continue;
        }
        let start = at;
        while at < glyphs.len() && !glyphs[at].is_whitespace() && !matches!(glyphs[at], '"') && class(glyphs[at]) == Class::Punct
        {
            at += 1;
        }
        if at == start {
            at += 1;
        }
        runs.push((start, at - start, Token::Punct));
    }
    runs
}

fn ink(f: &Frame, token: Token) -> D2D1_COLOR_F {
    let code = f.theme.code;
    match token {
        Token::Key => code.key,
        Token::Str => code.string,
        Token::Num => code.number,
        Token::Word => code.word,
        Token::Punct => code.punct,
    }
}

// ── Drawing ─────────────────────────────────────────────────────────────────

/// Draw the editor into `area`, and let it be typed into.
///
/// Geometry first, then input, then paint — in that order, and the order matters. The key handlers
/// need to know how many lines fit before Page Down can mean anything, and the caret has to be
/// drawn where this frame's keystrokes left it rather than where the last frame's did.
pub fn panel(f: &mut Frame, buffer: &mut Buffer, workspace: &Workspace, area: Rect) {
    let cell = f.p.measure("0", &mono(f.scale)).0.max(f.px(5.0));
    let line_h = f.px(LINE);
    let status_h = f.px(STATUS_H);

    let box_rect = Rect::new(area.left, area.top, area.right, (area.bottom - status_h).max(area.top + line_h));
    f.p.fill_round_rect(box_rect, f.px(8.0), f.theme.sunken);

    let digits = buffer.lines.len().to_string().len().max(2);
    let gutter_w = cell * digits as f32 + f.px(GUTTER_PAD * 2.0);
    let gutter = Rect::new(box_rect.left, box_rect.top, box_rect.left + gutter_w, box_rect.bottom);

    // Both tracks are held clear whether or not either is showing, for the reason the settings
    // column holds its own clear: a text area that narrowed by nine pixels the moment a line was
    // added would jump every line sideways, and one that shortened when a long line appeared
    // would jump them all up.
    let bar_w = f.px(9.0);
    let text_left = gutter.right + f.px(TEXT_PAD);
    let text_area = Rect::new(
        text_left,
        box_rect.top + f.px(6.0),
        box_rect.right - bar_w,
        box_rect.bottom - f.px(6.0) - bar_w,
    );
    let rows = ((text_area.height() / line_h).floor() as usize).max(1);
    let cols = ((text_area.width() / cell).floor() as usize).max(1);

    let id = "ws-code";
    // The editor is the only thing in this view that takes the keyboard, and it is useless without
    // it, so it takes it on sight rather than waiting to be clicked.
    if !f.ui.is_focused(id) && f.ui.active().is_none() {
        f.ui.focus(id);
    }
    let focused = f.ui.is_focused(id);

    if focused && !f.blocked && keys(f.input, buffer, rows, cols) {
        f.want_frame();
    }
    pointer(f, buffer, box_rect, text_area, cell, line_h, rows, cols, id);
    wheel(f, buffer, box_rect, rows, cols);

    buffer.scroll_line = buffer
        .scroll_line
        .min(buffer.lines.len().saturating_sub(1));
    buffer.check(workspace);

    paint(f, buffer, Geometry { gutter, text_area, cell, line_h, rows, cols }, focused);
    scrollbars(
        f,
        buffer,
        Rect::new(box_rect.right - bar_w, text_area.top, box_rect.right, text_area.bottom),
        Rect::new(text_area.left, text_area.bottom, text_area.right, text_area.bottom + bar_w),
        rows,
        cols,
    );

    f.p.stroke_round_rect(
        box_rect.inflate(-0.5),
        f.px(8.0),
        if buffer.verdict.problem.is_some() {
            w::alpha(crate::gfx::palette::DANGER, 0.5)
        } else if focused {
            f.theme.focus
        } else {
            f.theme.line
        },
        1.0,
    );

    status(f, buffer, Rect::new(area.left, box_rect.bottom, area.right, area.bottom));
}

/// What `paint` needs, measured once rather than passed as seven arguments.
struct Geometry {
    gutter: Rect,
    text_area: Rect,
    cell: f32,
    line_h: f32,
    rows: usize,
    cols: usize,
}

fn paint(f: &mut Frame, buffer: &Buffer, g: Geometry, focused: bool) {
    let style = mono(f.scale);
    let (_, glyph_h) = f.p.measure("0", &style);
    let gutter_ink = w::alpha(f.theme.text, 0.26);
    let selection = f.theme.code.selection;

    // The gutter's rule, which is what separates the numbers from the text without a plate.
    f.p.line(
        (g.gutter.right, g.gutter.top + f.px(6.0)),
        (g.gutter.right, g.gutter.bottom - f.px(6.0)),
        f.theme.line,
        1.0,
    );

    let last = (buffer.scroll_line + g.rows).min(buffer.lines.len());
    let fault_line = buffer.verdict.problem.as_ref().map(|p| p.line.saturating_sub(1));

    for index in buffer.scroll_line..last {
        let top = g.text_area.top + (index - buffer.scroll_line) as f32 * g.line_h;
        let row = Rect::new(g.text_area.left, top, g.text_area.right, top + g.line_h);
        let line = &buffer.lines[index];
        let width = chars(line);

        // The line the parser stopped on, marked across the whole row rather than at one
        // character: serde reports where it gave up, which is a place near the mistake and not
        // always the mistake itself.
        if fault_line == Some(index) {
            f.p.fill_rect(
                Rect::new(g.gutter.left, top, g.text_area.right, row.bottom),
                w::alpha(crate::gfx::palette::DANGER, 0.08),
            );
        } else if focused && index == buffer.caret.line && buffer.selection().is_none() {
            f.p.fill_rect(
                Rect::new(g.gutter.left, top, g.text_area.right, row.bottom),
                w::alpha(f.theme.text, 0.028),
            );
        }

        // The number, trailing-aligned against the rule.
        f.p.text(
            &(index + 1).to_string(),
            Rect::new(
                g.gutter.left + f.px(GUTTER_PAD),
                top + (g.line_h - glyph_h) / 2.0,
                g.gutter.right - f.px(GUTTER_PAD),
                row.bottom,
            ),
            &gutter_style(f.scale),
            if index == buffer.caret.line { w::alpha(f.theme.text, 0.55) } else { gutter_ink },
        );

        // The selection, as the span of this line that is inside it.
        if let Some((from, to)) = buffer.selection() {
            if index >= from.line && index <= to.line {
                let start = if index == from.line { from.col } else { 0 };
                // A selection that runs through a line covers its newline too, which is the half
                // cell past the end — without it a block selection has a ragged right edge that
                // reads as "these lines are not included".
                let end = if index == to.line { to.col } else { width + 1 };
                let x0 = g.text_area.left + (start.max(buffer.scroll_col) as f32 - buffer.scroll_col as f32) * g.cell;
                let x1 = g.text_area.left + (end.max(buffer.scroll_col) as f32 - buffer.scroll_col as f32) * g.cell;
                if x1 > x0 {
                    f.p.fill_rect(
                        Rect::new(x0, top + f.px(1.0), x1.min(g.text_area.right), row.bottom - f.px(1.0)),
                        selection,
                    );
                }
            }
        }

        // The text, one run per token. Each run is placed from its OWN column rather than from
        // where the previous one ended, so a glyph wider than its cell cannot push the rest of the
        // line out of the grid the caret is counted on.
        let text_y = top + (g.line_h - glyph_h) / 2.0;
        for (col, run_width, token) in tokens(line) {
            if col + run_width <= buffer.scroll_col || col >= buffer.scroll_col + g.cols {
                continue;
            }
            let from = col.max(buffer.scroll_col);
            let run = slice(line, from, (col + run_width).min(buffer.scroll_col + g.cols));
            if run.is_empty() {
                continue;
            }
            let x = g.text_area.left + (from - buffer.scroll_col) as f32 * g.cell;
            f.p.text(
                &run,
                Rect::new(x, text_y, g.text_area.right, row.bottom),
                &style,
                ink(f, token),
            );
        }
    }

    // The caret, on the platform's blink. Solid for as long as it is being driven: a cursor that
    // winks out mid-keystroke reads as a dropped key.
    if focused && buffer.selection().is_none() {
        let since = buffer.moved.elapsed().as_millis();
        let lit = since < BLINK_MS || (since / BLINK_MS) % 2 == 0;
        if buffer.caret.line >= buffer.scroll_line && buffer.caret.line < last.max(buffer.scroll_line + 1) {
            if lit && buffer.caret.col >= buffer.scroll_col {
                let x = g.text_area.left + (buffer.caret.col - buffer.scroll_col) as f32 * g.cell;
                let top = g.text_area.top + (buffer.caret.line - buffer.scroll_line) as f32 * g.line_h;
                if x <= g.text_area.right {
                    f.p.fill_rect(
                        Rect::new(x, top + f.px(1.5), x + f.px(1.5), top + g.line_h - f.px(1.5)),
                        f.theme.text,
                    );
                }
            }
        }
        f.want_frame();
    }
}

/// The line under the box: what the text parses as, or why it does not.
fn status(f: &mut Frame, buffer: &Buffer, at: Rect) {
    let style = w::small_style(f.scale, false);
    let (_, th) = f.p.measure("0", &style);
    let y = at.top + (at.height() - th) / 2.0;
    let text_at = Rect::new(at.left + f.px(20.0), y, at.right, at.bottom);

    let (glyph, colour, message) = match buffer.problem() {
        // The same mark the launch-failure card and the crowded-ring note use. A product with
        // three different warning glyphs has three warnings that look like three different kinds
        // of thing.
        Some(problem) => ("AlertTriangle", crate::gfx::palette::DANGER, problem.sentence()),
        None if !buffer.verdict.healed.is_empty() => (
            "Info",
            crate::gfx::palette::CROWD_NOTE_INK,
            // One repair is named; several are counted, because the status line is one line and a
            // sentence that runs off the end of it says less than a number does.
            if buffer.verdict.healed.len() == 1 {
                format!("Applying this will tidy it — {}", buffer.verdict.healed[0])
            } else {
                format!(
                    "Applying this will tidy {} things, starting with: {}",
                    buffer.verdict.healed.len(),
                    buffer.verdict.healed[0]
                )
            },
        ),
        None => (
            "CheckCircle2",
            w::alpha(f.theme.text, 0.5),
            format!(
                "Reads as a workspace — {} shortcut{}",
                buffer.verdict.items,
                if buffer.verdict.items == 1 { "" } else { "s" }
            ),
        ),
    };

    f.p.glyph(glyph, (at.left + f.px(8.0), at.top + at.height() / 2.0), f.px(13.0), colour, 1.8);
    f.p.text(&message, text_at, &style, colour);
}

/// The two indicators. Drawn, not draggable — like the dialog's own, and for the same reason:
/// what they are for is saying how much is off screen and roughly where, and the wheel and the
/// caret are what move the text.
///
/// The sideways one earns its place in this product specifically. A `rovyl-icon://` reference is a
/// hash, so a workspace's lines run to two hundred characters, and a line that simply stops at the
/// edge of the box with nothing to say it continues reads as a line that was truncated on the way
/// in — which, in an editor over live configuration, is an alarming thing to believe.
fn scrollbars(f: &mut Frame, buffer: &Buffer, down: Rect, across: Rect, rows: usize, cols: usize) {
    let ink = w::alpha(f.theme.text, 0.15);

    let total = buffer.lines.len();
    if total > rows {
        let ratio = (rows as f32 / total as f32).clamp(0.05, 1.0);
        let thumb_h = (down.height() * ratio).max(f.px(28.0));
        let span = down.height() - thumb_h;
        let t = (buffer.scroll_line as f32 / (total - rows) as f32).clamp(0.0, 1.0);
        let top = down.top + span * t;
        f.p.fill_round_rect(
            Rect::new(down.left + f.px(2.0), top, down.right - f.px(2.0), top + thumb_h),
            f.px(3.0),
            ink,
        );
    }

    let widest = buffer.widest();
    if widest > cols {
        let ratio = (cols as f32 / widest as f32).clamp(0.05, 1.0);
        let thumb_w = (across.width() * ratio).max(f.px(28.0));
        let span = across.width() - thumb_w;
        let t = (buffer.scroll_col as f32 / (widest - cols) as f32).clamp(0.0, 1.0);
        let left = across.left + span * t;
        f.p.fill_round_rect(
            Rect::new(left, across.top + f.px(2.0), left + thumb_w, across.bottom - f.px(2.0)),
            f.px(3.0),
            ink,
        );
    }
}

// ── Input ───────────────────────────────────────────────────────────────────

fn wheel(f: &mut Frame, buffer: &mut Buffer, box_rect: Rect, rows: usize, cols: usize) {
    if f.input.scroll == 0.0 || !box_rect.contains(f.input.pointer.0, f.input.pointer.1) {
        return;
    }
    let by = (f.input.scroll * WHEEL_LINES as f32) as isize;
    if f.input.shift {
        // Sideways, which is the only way to read the end of a long line without walking the
        // caret into it — and a configuration is full of long lines, because an icon reference is
        // a hash. Shift+wheel is where every editor puts it.
        let ceiling = buffer.widest().saturating_sub(cols);
        buffer.scroll_col = (buffer.scroll_col as isize - by).clamp(0, ceiling as isize) as usize;
    } else {
        let ceiling = buffer.lines.len().saturating_sub(rows);
        buffer.scroll_line = (buffer.scroll_line as isize - by).clamp(0, ceiling as isize) as usize;
    }
    f.want_frame();
}

/// Clicks and drags: where the caret goes, and what gets selected.
#[allow(clippy::too_many_arguments)]
fn pointer(
    f: &mut Frame,
    buffer: &mut Buffer,
    box_rect: Rect,
    text_area: Rect,
    cell: f32,
    line_h: f32,
    rows: usize,
    cols: usize,
    id: &str,
) {
    if f.hovered(box_rect) {
        f.set_cursor(Cursor::Text);
    }

    let spot_at = |x: f32, y: f32| -> Spot {
        let row = ((y - text_area.top) / line_h).floor().max(0.0) as usize + buffer.scroll_line;
        let line = row.min(buffer.lines.len() - 1);
        // Rounded, not truncated: a click lands between two characters, and the caret belongs at
        // whichever boundary is nearer. Truncating puts it always to the left, which makes clicking
        // at the end of a line impossible.
        let col = (((x - text_area.left) / cell).round().max(0.0) as usize + buffer.scroll_col)
            .min(chars(&buffer.lines[line]));
        Spot { line, col }
    };

    if f.input.pressed && f.hovered(box_rect) {
        f.ui.focus(id);
        f.ui.set_active(id);
        let to = spot_at(f.input.pointer.0, f.input.pointer.1);
        buffer.go(to, f.input.shift);
        buffer.goal = to.col;
        buffer.dragging = true;
    } else if buffer.dragging && f.ui.is_active(id) {
        if f.input.down {
            // Extending, so the anchor is kept. A drag with no anchor yet is one that began with a
            // plain click, and the caret it set is the anchor.
            let to = spot_at(f.input.pointer.0, f.input.pointer.1);
            if to != buffer.caret {
                if buffer.anchor.is_none() {
                    buffer.anchor = Some(buffer.caret);
                }
                buffer.caret = to;
                buffer.clamp_caret();
                buffer.moved = std::time::Instant::now();
                buffer.reveal(rows, cols);
                f.want_frame();
            }
        } else {
            buffer.dragging = false;
            f.ui.clear_active();
        }
    }
}

/// Every key the editor answers to. True when anything moved or changed.
///
/// Frame-free on purpose. This function IS the editor as far as a keyboard is concerned — every
/// caret move, every edit and every chord goes through it — which makes it the part most worth
/// being sure about, and a function taking a `Frame` could not be tested without a GPU and a
/// window. What it needs from the frame is one struct of plain data, so it takes that instead.
pub(crate) fn keys(input: &Input, buffer: &mut Buffer, rows: usize, cols: usize) -> bool {
    let shift = input.shift;
    let ctrl = input.ctrl;

    // The chords first, because they share their keys with characters: Ctrl+V is a paste and `v`
    // is a letter, and the `typed` run below is only reached when no modifier claimed it.
    if ctrl {
        // 0x5A Z, 0x59 Y, 0x41 A, 0x43 C, 0x58 X, 0x56 V
        if input.key_pressed(0x5A) {
            if shift {
                buffer.redo();
            } else {
                buffer.undo();
            }
            buffer.reveal(rows, cols);
            return true;
        }
        if input.key_pressed(0x59) {
            buffer.redo();
            buffer.reveal(rows, cols);
            return true;
        }
        if input.key_pressed(0x41) {
            buffer.select_all();
            buffer.reveal(rows, cols);
            return true;
        }
        let copy = input.key_pressed(0x43);
        let cut = input.key_pressed(0x58);
        if copy || cut {
            if let Some(text) = buffer.selected_text() {
                // Straight to the clipboard rather than out through a `Request`, as the file
                // dialogs go. The reason those go through the host is that they are modal and
                // hold the message loop; this is one synchronous call that returns in
                // microseconds, and a paste that arrived a frame late would land at wherever the
                // caret had moved to in the meantime.
                crate::sys::clipboard::put(&text);
                if cut {
                    buffer.remember(Group::Other);
                    buffer.drop_selection();
                    buffer.revision += 1;
                }
            }
            buffer.reveal(rows, cols);
            return true;
        }
        if input.key_pressed(0x56) {
            if let Some(text) = crate::sys::clipboard::get() {
                buffer.remember(Group::Other);
                buffer.insert(&text);
            }
            buffer.reveal(rows, cols);
            return true;
        }
    }

    // Movement. `key_repeats` and not `key_pressed`: a held arrow sends one message per repeat,
    // and a frame that ran late is holding several of them.
    let mut moved = false;
    for _ in 0..input.key_repeats(0x25) {
        // Left with a selection and no Shift collapses to its START rather than stepping back
        // from the caret. That is what every text control does, and it is what makes "select,
        // then nudge" land where it looks like it will.
        let to = match (shift, buffer.selection()) {
            (false, Some((from, _))) => from,
            _ if ctrl => buffer.word(false),
            _ => buffer.left(),
        };
        buffer.go(to, shift);
        buffer.goal = buffer.caret.col;
        moved = true;
    }
    for _ in 0..input.key_repeats(0x27) {
        let to = match (shift, buffer.selection()) {
            (false, Some((_, end))) => end,
            _ if ctrl => buffer.word(true),
            _ => buffer.right(),
        };
        buffer.go(to, shift);
        buffer.goal = buffer.caret.col;
        moved = true;
    }
    for _ in 0..input.key_repeats(0x26) {
        let to = buffer.vertical(-1);
        buffer.go(to, shift);
        moved = true;
    }
    for _ in 0..input.key_repeats(0x28) {
        let to = buffer.vertical(1);
        buffer.go(to, shift);
        moved = true;
    }
    if input.key_pressed(0x24) {
        // Ctrl+Home is the top of the text; Home alone is the start of the line.
        let to = if ctrl { Spot::default() } else { buffer.home() };
        buffer.go(to, shift);
        buffer.goal = buffer.caret.col;
        moved = true;
    }
    if input.key_pressed(0x23) {
        let to = if ctrl {
            let line = buffer.lines.len() - 1;
            Spot { line, col: chars(&buffer.lines[line]) }
        } else {
            Spot {
                line: buffer.caret.line,
                col: chars(&buffer.lines[buffer.caret.line]),
            }
        };
        buffer.go(to, shift);
        buffer.goal = buffer.caret.col;
        moved = true;
    }
    for _ in 0..input.key_repeats(0x21) {
        let to = buffer.vertical(-(rows as isize));
        buffer.go(to, shift);
        buffer.scroll_line = buffer.scroll_line.saturating_sub(rows);
        moved = true;
    }
    for _ in 0..input.key_repeats(0x22) {
        let to = buffer.vertical(rows as isize);
        buffer.go(to, shift);
        buffer.scroll_line = (buffer.scroll_line + rows).min(buffer.lines.len().saturating_sub(1));
        moved = true;
    }

    // Editing.
    let mut edited = false;
    for _ in 0..input.key_repeats(0x08) {
        buffer.remember(Group::Erasing);
        buffer.backspace();
        edited = true;
    }
    for _ in 0..input.key_repeats(0x2E) {
        buffer.remember(Group::Erasing);
        buffer.delete();
        edited = true;
    }
    for _ in 0..input.key_repeats(0x0D) {
        buffer.remember(Group::Other);
        buffer.newline();
        edited = true;
    }
    if input.key_pressed(0x09) {
        buffer.remember(Group::Other);
        buffer.indent(shift);
        edited = true;
    }

    // And the characters. `WM_CHAR` has already dropped the control codes, which is what keeps a
    // Ctrl chord from also arriving here as a glyph.
    if !ctrl && !input.typed.is_empty() {
        let typed: String = input.typed.chars().filter(|c| !c.is_control()).collect();
        if !typed.is_empty() {
            buffer.remember(Group::Typing);
            buffer.insert(&typed);
            edited = true;
        }
    }

    if moved || edited {
        buffer.moved = std::time::Instant::now();
        buffer.reveal(rows, cols);
        return true;
    }
    false
}
#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> Workspace {
        Workspace { id: "ws-1".into(), name: "Work".into(), ..Workspace::default() }
    }

    fn from(text: &str) -> Buffer {
        let mut buffer = Buffer::open(&ws());
        buffer.lines = split(text);
        buffer.saved = text.to_string();
        buffer.caret = Spot::default();
        buffer
    }

    // ── Tokens ──────────────────────────────────────────────────────────────

    #[test]
    fn a_string_before_a_colon_is_a_key() {
        let runs = tokens(r#"  "name": "Work","#);
        assert_eq!(runs[0].2, Token::Key, "{runs:?}");
        assert_eq!(runs[1].2, Token::Punct, "the colon");
        assert_eq!(runs[2].2, Token::Str, "and the value is not a key");
    }

    #[test]
    fn an_escaped_quote_does_not_end_the_string() {
        // Without this every quote after a `\"` lands on the wrong side and the colouring inverts
        // for the rest of the line.
        let runs = tokens(r#"{ "command": "say \"hi\"" }"#);
        let strings: Vec<&(usize, usize, Token)> =
            runs.iter().filter(|r| r.2 == Token::Str).collect();
        assert_eq!(strings.len(), 1, "{runs:?}");
    }

    #[test]
    fn an_unterminated_quote_stops_at_the_line_end() {
        // The decision in `tokens`: a stray quote must not paint the rest of the workspace as a
        // string, which is what hides the structure exactly when it is being looked for.
        let runs = tokens(r#"  "label": "Half"#);
        let last = runs.last().expect("a run");
        assert_eq!(last.0 + last.1, chars(r#"  "label": "Half"#));
        assert_eq!(tokens(r#"  "next": 3"#)[2].2, Token::Num, "the next line is unaffected");
    }

    #[test]
    fn numbers_keywords_and_punctuation_are_told_apart() {
        let runs = tokens("[ true, -2.5e3, null ]");
        let kinds: Vec<Token> = runs.iter().map(|r| r.2).collect();
        assert!(kinds.contains(&Token::Word));
        assert!(kinds.contains(&Token::Num));
        assert!(kinds.contains(&Token::Punct));
        // The whole number, exponent and sign included.
        let number = runs.iter().find(|r| r.2 == Token::Num).expect("a number");
        assert_eq!(number.1, "-2.5e3".len());
    }

    #[test]
    fn every_character_of_a_line_lands_in_exactly_one_run_or_a_gap() {
        // The grid's invariant: runs are drawn from their own columns, so an overlap would paint
        // two glyphs on one cell and a gap would lose a character.
        let line = r#"  "a": [1, {"b": null}], "#;
        let runs = tokens(line);
        let mut covered = vec![false; chars(line)];
        for (col, width, _) in runs {
            for cell in covered.iter_mut().skip(col).take(width) {
                assert!(!*cell, "overlapping runs in {line:?}");
                *cell = true;
            }
        }
        for (at, c) in line.chars().enumerate() {
            assert_eq!(covered[at], !c.is_whitespace(), "column {at} of {line:?}");
        }
    }

    // ── Editing ─────────────────────────────────────────────────────────────

    #[test]
    fn typing_inserts_at_the_caret() {
        let mut b = from("{}");
        b.caret = Spot { line: 0, col: 1 };
        b.insert("\"a\"");
        assert_eq!(b.text(), "{\"a\"}");
        assert_eq!(b.caret.col, 4);
    }

    #[test]
    fn a_paste_with_newlines_splits_the_line() {
        let mut b = from("{}");
        b.caret = Spot { line: 0, col: 1 };
        b.insert("\n  \"a\": 1\n");
        assert_eq!(b.text(), "{\n  \"a\": 1\n}");
        assert_eq!(b.caret, Spot { line: 2, col: 0 });
    }

    #[test]
    fn a_pasted_tab_becomes_an_indent_and_a_cr_goes() {
        // The grid draws a tab as one cell, and a `\r` inside a JSON string is an invisible
        // character that the parser accepts and nothing else does.
        let mut b = from("");
        b.insert("\ta\r\nb\r");
        assert_eq!(b.text(), "  a\nb\n");
    }

    #[test]
    fn enter_carries_the_indent() {
        let mut b = from("    \"a\": 1,");
        b.caret = Spot { line: 0, col: chars("    \"a\": 1,") };
        b.newline();
        assert_eq!(b.lines[1], "    ");
        assert_eq!(b.caret.col, 4);
    }

    #[test]
    fn enter_after_an_opening_bracket_indents_one_more() {
        let mut b = from("  \"apps\": [");
        b.caret = Spot { line: 0, col: chars("  \"apps\": [") };
        b.newline();
        assert_eq!(b.lines[1], "    ");
    }

    #[test]
    fn enter_between_brackets_puts_the_closer_on_its_own_line() {
        let mut b = from("  \"apps\": []");
        b.caret = Spot { line: 0, col: chars("  \"apps\": [") };
        b.newline();
        assert_eq!(b.lines[0], "  \"apps\": [");
        assert_eq!(b.lines[1], "    ");
        assert_eq!(b.lines[2], "  ]");
        assert_eq!(b.caret, Spot { line: 1, col: 4 });
    }

    #[test]
    fn backspace_in_the_indent_takes_the_whole_step() {
        let mut b = from("    \"a\"");
        b.caret = Spot { line: 0, col: 4 };
        b.backspace();
        assert_eq!(b.lines[0], "  \"a\"");
        // Past the indent it is one character again, because there it is text.
        b.caret = Spot { line: 0, col: 5 };
        b.backspace();
        assert_eq!(b.lines[0], "  \"a");
    }

    #[test]
    fn backspace_at_column_zero_joins_the_line_above() {
        let mut b = from("{\n}");
        b.caret = Spot { line: 1, col: 0 };
        b.backspace();
        assert_eq!(b.text(), "{}");
        assert_eq!(b.caret, Spot { line: 0, col: 1 });
        // And at the very start it does nothing rather than panicking on line -1.
        b.caret = Spot::default();
        b.backspace();
        assert_eq!(b.text(), "{}");
    }

    #[test]
    fn delete_at_the_end_joins_the_line_below_and_stops_at_the_last() {
        let mut b = from("{\n}");
        b.caret = Spot { line: 0, col: 1 };
        b.delete();
        assert_eq!(b.text(), "{}");
        b.caret = Spot { line: 0, col: 2 };
        b.delete();
        assert_eq!(b.text(), "{}", "nothing past the end");
    }

    #[test]
    fn a_selection_is_replaced_by_what_is_typed() {
        let mut b = from("{\n  \"a\": 1\n}");
        b.anchor = Some(Spot { line: 0, col: 1 });
        b.caret = Spot { line: 2, col: 0 };
        b.insert("X");
        assert_eq!(b.text(), "{X}");
        assert_eq!(b.caret, Spot { line: 0, col: 2 });
        assert!(b.selection().is_none(), "and the selection is gone");
    }

    #[test]
    fn a_multi_line_selection_reads_back_whole() {
        let mut b = from("one\ntwo\nthree");
        b.anchor = Some(Spot { line: 0, col: 1 });
        b.caret = Spot { line: 2, col: 2 };
        assert_eq!(b.selected_text().as_deref(), Some("ne\ntwo\nth"));
    }

    #[test]
    fn select_all_reaches_the_last_character() {
        let mut b = from("one\ntwo");
        b.select_all();
        assert_eq!(b.selected_text().as_deref(), Some("one\ntwo"));
    }

    #[test]
    fn tab_indents_every_line_the_selection_touches() {
        let mut b = from("a\nb\nc");
        b.anchor = Some(Spot { line: 0, col: 0 });
        b.caret = Spot { line: 1, col: 1 };
        b.indent(false);
        assert_eq!(b.text(), "  a\n  b\nc");
        // And the selection still covers them, so the next level does not have to be re-made.
        assert_eq!(b.selection().map(|(f, _)| f.line), Some(0));
        b.indent(true);
        assert_eq!(b.text(), "a\nb\nc");
    }

    #[test]
    fn tab_with_no_selection_is_an_indent_step() {
        let mut b = from("{}");
        b.caret = Spot { line: 0, col: 1 };
        b.indent(false);
        assert_eq!(b.text(), "{  }");
    }

    // ── Moving ──────────────────────────────────────────────────────────────

    #[test]
    fn a_vertical_move_keeps_the_column_it_started_in() {
        // Down through a short line and on to a long one lands back out at the original column.
        let mut b = from("longest line here\nab\nanother long line");
        b.caret = Spot { line: 0, col: 12 };
        b.goal = 12;
        let down = b.vertical(1);
        assert_eq!(down.col, 2, "clamped to the short line");
        b.caret = down;
        assert_eq!(b.vertical(1).col, 12, "and back out again");
    }

    #[test]
    fn word_moves_stop_between_classes() {
        // `"commandType"` is three stops, which is what makes Ctrl+Left useful in a text made
        // mostly of punctuation.
        let mut b = from("  \"commandType\": \"app\"");
        b.caret = Spot { line: 0, col: 0 };
        let mut stops = Vec::new();
        for _ in 0..5 {
            b.caret = b.word(true);
            stops.push(b.caret.col);
        }
        // The end of each token: the opening quote, the word, the `":` that closes it, the next
        // opening quote, then `app`. Never the gap in front of a word.
        assert_eq!(stops, vec![3, 14, 16, 18, 21], "{stops:?}");
    }

    #[test]
    fn a_word_move_at_the_edge_crosses_the_line() {
        let mut b = from("ab\ncd");
        b.caret = Spot { line: 0, col: 2 };
        assert_eq!(b.word(true), Spot { line: 1, col: 0 });
        b.caret = Spot { line: 1, col: 0 };
        assert_eq!(b.word(false), Spot { line: 0, col: 2 });
    }

    #[test]
    fn home_has_two_stops() {
        let mut b = from("    \"a\": 1");
        b.caret = Spot { line: 0, col: 8 };
        assert_eq!(b.home().col, 4, "the first non-space");
        b.caret = Spot { line: 0, col: 4 };
        assert_eq!(b.home().col, 0, "then column zero");
    }

    #[test]
    fn the_caret_cannot_leave_the_text() {
        let mut b = from("ab");
        b.caret = Spot { line: 9, col: 9 };
        b.clamp_caret();
        assert_eq!(b.caret, Spot { line: 0, col: 2 });
        assert_eq!(b.left(), Spot { line: 0, col: 1 });
        b.caret = Spot::default();
        assert_eq!(b.left(), Spot::default(), "and does not step off the front");
    }

    #[test]
    fn scrolling_follows_the_caret_both_ways() {
        let mut b = from(&(0..100).map(|n| n.to_string()).collect::<Vec<_>>().join("\n"));
        b.caret = Spot { line: 60, col: 0 };
        b.reveal(20, 40);
        assert_eq!(b.scroll_line, 41, "the caret is the last visible line");
        b.caret = Spot { line: 5, col: 0 };
        b.reveal(20, 40);
        assert_eq!(b.scroll_line, 5, "and the first on the way back");
    }

    #[test]
    fn a_long_line_scrolls_sideways() {
        let mut b = from(&"x".repeat(200));
        b.caret = Spot { line: 0, col: 150 };
        b.reveal(10, 40);
        assert_eq!(b.scroll_col, 111);
        b.caret = Spot { line: 0, col: 3 };
        b.reveal(10, 40);
        assert_eq!(b.scroll_col, 3);
    }

    // ── History ─────────────────────────────────────────────────────────────

    #[test]
    fn a_run_of_typing_is_one_undo() {
        let mut b = from("{}");
        b.caret = Spot { line: 0, col: 1 };
        for ch in ["a", "b", "c"] {
            b.remember(Group::Typing);
            b.insert(ch);
        }
        assert_eq!(b.text(), "{abc}");
        b.undo();
        assert_eq!(b.text(), "{}", "the word goes back, not one letter of it");
    }

    #[test]
    fn a_caret_move_breaks_the_run() {
        let mut b = from("{}");
        b.caret = Spot { line: 0, col: 1 };
        b.remember(Group::Typing);
        b.insert("a");
        b.go(Spot { line: 0, col: 0 }, false);
        b.remember(Group::Typing);
        b.insert("z");
        assert_eq!(b.text(), "z{a}");
        b.undo();
        assert_eq!(b.text(), "{a}", "only the second insertion");
    }

    #[test]
    fn redo_comes_back_and_a_new_edit_throws_it_away() {
        let mut b = from("{}");
        b.caret = Spot { line: 0, col: 1 };
        b.remember(Group::Other);
        b.insert("a");
        b.undo();
        assert_eq!(b.text(), "{}");
        b.redo();
        assert_eq!(b.text(), "{a}");

        b.undo();
        b.remember(Group::Other);
        b.insert("q");
        assert!(b.redo.is_empty(), "the forward history is not reachable from here");
    }

    #[test]
    fn the_history_is_bounded() {
        let mut b = from("");
        for n in 0..UNDO_LIMIT + 50 {
            b.remember(Group::Other);
            b.insert(&n.to_string());
        }
        assert_eq!(b.undo.len(), UNDO_LIMIT);
    }

    // ── The workspace behind it ─────────────────────────────────────────────

    // ── The keyboard ────────────────────────────────────────────────────────
    //
    // The mapping from keys to edits, which is the whole editor as far as anybody using it is
    // concerned. Driven through `keys` with a hand-made `Input`, exactly as the window procedure
    // fills one — no clipboard chords, because those would reach past the test and take the
    // machine's real clipboard with them.

    fn typed(text: &str) -> Input {
        Input { typed: text.to_string(), ..Default::default() }
    }

    fn vk(codes: &[u16]) -> Input {
        Input { keys: codes.to_vec(), ..Default::default() }
    }

    fn chord(codes: &[u16], ctrl: bool, shift: bool) -> Input {
        Input { keys: codes.to_vec(), ctrl, shift, ..Default::default() }
    }

    /// Enough room that nothing in these tests scrolls.
    const ROOM: (usize, usize) = (40, 120);

    fn press(b: &mut Buffer, input: &Input) -> bool {
        keys(input, b, ROOM.0, ROOM.1)
    }

    #[test]
    fn characters_arrive_and_a_quiet_frame_changes_nothing() {
        let mut b = from("{}");
        b.caret = Spot { line: 0, col: 1 };
        assert!(press(&mut b, &typed("ab")));
        assert_eq!(b.text(), "{ab}");
        // A frame with no keys in it must not report that something happened, or the panel asks
        // for another frame forever.
        assert!(!press(&mut b, &Input::default()));
    }

    #[test]
    fn a_held_key_repeats_as_many_times_as_it_arrived() {
        // The reason `key_repeats` exists. Windows sends one WM_KEYDOWN per repeat, and a frame
        // that ran late is holding several — collapsed to one, a held Backspace would delete at
        // frame rate instead of at the keyboard's.
        let mut b = from("abcdef");
        b.caret = Spot { line: 0, col: 6 };
        press(&mut b, &vk(&[0x08, 0x08, 0x08]));
        assert_eq!(b.text(), "abc");
    }

    #[test]
    fn enter_and_tab_come_through_as_keys_rather_than_characters() {
        // `WM_CHAR` drops the control codes, so neither ever reaches `typed` — if these were
        // read from there, the two most-used keys in an indented format would do nothing.
        let mut b = from("  \"a\": [");
        b.caret = Spot { line: 0, col: 8 };
        press(&mut b, &vk(&[0x0D]));
        assert_eq!(b.lines[1], "    ", "Enter, carrying the indent");
        press(&mut b, &vk(&[0x09]));
        assert_eq!(b.lines[1], "      ", "and Tab, one step further");
    }

    #[test]
    fn shift_extends_and_a_plain_arrow_collapses() {
        let mut b = from("abcdef");
        b.caret = Spot { line: 0, col: 2 };
        press(&mut b, &chord(&[0x27], false, true));
        press(&mut b, &chord(&[0x27], false, true));
        assert_eq!(b.selected_text().as_deref(), Some("cd"));
        // Left with a selection goes to its start rather than one back from the caret.
        press(&mut b, &vk(&[0x25]));
        assert_eq!(b.caret.col, 2);
        assert!(b.selection().is_none());
    }

    #[test]
    fn ctrl_a_then_typing_replaces_everything() {
        let mut b = from("{\n  \"a\": 1\n}");
        press(&mut b, &chord(&[0x41], true, false));
        assert!(press(&mut b, &typed("{}")));
        assert_eq!(b.text(), "{}");
    }

    #[test]
    fn ctrl_z_and_ctrl_shift_z_walk_the_history() {
        let mut b = from("{}");
        b.caret = Spot { line: 0, col: 1 };
        press(&mut b, &typed("abc"));
        assert_eq!(b.text(), "{abc}");
        press(&mut b, &chord(&[0x5A], true, false));
        assert_eq!(b.text(), "{}");
        press(&mut b, &chord(&[0x5A], true, true));
        assert_eq!(b.text(), "{abc}");
        // Ctrl+Y is the other spelling of redo, for the same reason every Windows editor has it.
        press(&mut b, &chord(&[0x5A], true, false));
        press(&mut b, &chord(&[0x59], true, false));
        assert_eq!(b.text(), "{abc}");
    }

    #[test]
    fn ctrl_arrows_move_by_word_and_plain_ones_by_character() {
        let mut b = from("  \"commandType\": \"app\"");
        b.caret = Spot::default();
        press(&mut b, &chord(&[0x27], true, false));
        assert_eq!(b.caret.col, 3, "a word move");
        press(&mut b, &vk(&[0x27]));
        assert_eq!(b.caret.col, 4, "and a character one");
    }

    #[test]
    fn ctrl_home_and_ctrl_end_reach_the_ends_of_the_text() {
        let mut b = from("one\ntwo\nthree");
        b.caret = Spot { line: 1, col: 1 };
        press(&mut b, &chord(&[0x23], true, false));
        assert_eq!(b.caret, Spot { line: 2, col: 5 });
        press(&mut b, &chord(&[0x24], true, false));
        assert_eq!(b.caret, Spot::default());
    }

    #[test]
    fn a_ctrl_chord_does_not_also_arrive_as_a_letter() {
        // `WM_CHAR` turns Ctrl+A into 0x01 and the window procedure drops it, so `typed` is
        // empty. This guards the other half: a `typed` that somehow carried the letter must not
        // be inserted on top of the chord that was meant.
        let mut b = from("{}");
        b.caret = Spot { line: 0, col: 1 };
        let mut input = chord(&[0x41], true, false);
        input.typed = "a".to_string();
        press(&mut b, &input);
        assert_eq!(b.text(), "{}", "select-all, not an inserted 'a'");
    }

    #[test]
    fn page_keys_move_by_a_screenful_and_stop_at_the_ends() {
        let mut b = from(&(0..100).map(|n| n.to_string()).collect::<Vec<_>>().join("\n"));
        keys(&vk(&[0x22]), &mut b, 20, 80);
        assert_eq!(b.caret.line, 20);
        keys(&vk(&[0x22]), &mut b, 20, 80);
        assert_eq!(b.caret.line, 40);
        for _ in 0..10 {
            keys(&vk(&[0x21]), &mut b, 20, 80);
        }
        assert_eq!(b.caret.line, 0, "and it stops rather than going negative");
    }

    #[test]
    fn shift_tab_takes_a_level_back_off_the_selected_lines() {
        let mut b = from("    a\n    b");
        b.anchor = Some(Spot::default());
        b.caret = Spot { line: 1, col: 5 };
        press(&mut b, &chord(&[0x09], false, true));
        assert_eq!(b.text(), "  a\n  b");
    }

    #[test]
    fn typing_into_a_selection_replaces_it_in_one_step() {
        let mut b = from("{\n  \"a\": 1\n}");
        press(&mut b, &chord(&[0x41], true, false));
        press(&mut b, &vk(&[0x2E]));
        assert_eq!(b.text(), "");
        // And one undo gives the whole thing back.
        press(&mut b, &chord(&[0x5A], true, false));
        assert_eq!(b.text(), "{\n  \"a\": 1\n}");
    }

    #[test]
    fn the_glyphs_this_view_names_all_resolve() {
        // A name with no path behind it draws a placeholder, silently. The status line's mark is
        // the one piece of this view that is never seen during development, because it only shows
        // the state where something is wrong.
        for name in ["AlertTriangle", "Info", "CheckCircle2", "Grid2x2", "FileCode"] {
            assert!(crate::gfx::lucide::exists(name), "{name}");
        }
    }

    #[test]
    fn a_fresh_buffer_is_unchanged_and_valid() {
        let workspace = ws();
        let mut b = Buffer::open(&workspace);
        assert!(!b.changed());
        b.check(&workspace);
        assert!(b.problem().is_none(), "{:?}", b.problem());
        assert!(b.owns("ws-1") && !b.owns("ws-2"));
    }

    #[test]
    fn breaking_the_text_is_reported_and_then_forgiven() {
        let workspace = ws();
        let mut b = Buffer::open(&workspace);
        b.caret = Spot::default();
        b.remember(Group::Typing);
        b.insert("oops");
        b.check(&workspace);
        assert!(b.problem().is_some());
        assert!(b.changed());

        b.undo();
        b.check(&workspace);
        assert!(b.problem().is_none(), "{:?}", b.problem());
        assert!(!b.changed(), "and it is back to what the workspace holds");
    }

    #[test]
    fn the_parse_is_skipped_until_something_changes() {
        // A dialog repaints for every pointer move; re-reading the text on each would be work
        // nobody asked for.
        let workspace = ws();
        let mut b = Buffer::open(&workspace);
        b.check(&workspace);
        let first = b.checked;
        b.check(&workspace);
        assert_eq!(b.checked, first);
        b.insert("x");
        b.check(&workspace);
        assert_ne!(b.checked, first);
    }

    #[test]
    fn shortcuts_are_counted_through_folders() {
        let workspace = ws();
        let mut b = Buffer::open(&workspace);
        b.select_all();
        b.insert(
            r#"{ "apps": [ { "id": "f", "type": "folder", "children": [
                 { "id": "a" }, { "id": "b" } ] }, { "id": "c" } ] }"#,
        );
        b.check(&workspace);
        assert!(b.problem().is_none(), "{:?}", b.problem());
        assert_eq!(b.verdict.items, 4, "the folder and its two children, plus one");
    }

    #[test]
    fn applying_rewrites_the_box_only_when_the_text_would_change() {
        let workspace = ws();
        let mut b = Buffer::open(&workspace);
        // Text the parser accepts but would not have written: one line, and a key it reorders.
        b.select_all();
        b.insert(r#"{"apps":[],"name":"Renamed"}"#);
        let parsed = b.parse(&workspace).expect("valid");
        b.applied(&parsed.workspace);
        assert!(!b.changed(), "it now matches the workspace");
        assert!(b.text().contains("\"name\": \"Renamed\""), "{}", b.text());
        assert!(b.text().starts_with("{\n"), "and it is pretty-printed: {}", b.text());

        // A second apply of text that is already canonical leaves the caret where it was.
        b.caret = Spot { line: 1, col: 3 };
        let again = b.parse(&workspace).expect("valid");
        b.applied(&again.workspace);
        assert_eq!(b.caret, Spot { line: 1, col: 3 });
    }

    #[test]
    fn revert_goes_back_to_the_workspace_and_drops_the_history() {
        let workspace = ws();
        let mut b = Buffer::open(&workspace);
        b.remember(Group::Other);
        b.insert("rubbish");
        b.revert(&workspace);
        assert!(!b.changed());
        assert!(b.undo.is_empty(), "an undo past a revert reaches a state nothing ever had");
        assert_eq!(b.caret, Spot::default());
    }

    #[test]
    fn a_buffer_always_has_a_line_to_put_the_caret_on() {
        let mut b = from("a");
        b.select_all();
        b.drop_selection();
        assert_eq!(b.lines.len(), 1);
        assert_eq!(b.text(), "");
        b.clamp_caret();
        assert_eq!(b.caret, Spot::default());
    }

    #[test]
    fn an_anchor_cannot_outlive_the_lines_it_points_at() {
        // Both ends of a selection are indexed by `drop_selection`, so an anchor left past the end
        // of a text that something shortened is a panic inside a paint.
        let mut b = from("one\ntwo\nthree\nfour");
        b.anchor = Some(Spot { line: 3, col: 4 });
        b.caret = Spot { line: 0, col: 0 };
        b.lines = split("a");
        b.clamp_caret();
        assert_eq!(b.anchor, Some(Spot { line: 0, col: 1 }));
        // And the selection it describes can still be read and cut without panicking.
        assert_eq!(b.selected_text().as_deref(), Some("a"));
        assert!(b.drop_selection());
        assert_eq!(b.text(), "");
    }

    #[test]
    fn columns_are_counted_in_characters_not_bytes() {
        // A byte column would put the caret inside a multi-byte character and `head`/`tail` would
        // panic on a boundary that is not one.
        let mut b = from("\"日本語\"");
        b.caret = Spot { line: 0, col: 2 };
        b.insert("x");
        assert_eq!(b.text(), "\"日x本語\"");
        assert_eq!(b.widest(), 6);
    }
}
