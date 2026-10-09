//! One workspace, as the text the code view edits.
//!
//! The dialog's second view is a text editor over a single workspace, and this module is the two
//! conversions on either side of it: the workspace out as JSON, and JSON back in as a workspace.
//!
//! **Why not the whole file.** A workspace is the unit the dialog edits, so it is the unit the
//! text holds. The alternative — the whole of `config-v2.json` in the box — hands every edit the
//! power to reset the triggers, the geometry and the other workspaces, and the one fault that
//! cannot be undone from inside the editor is the one that took the editor's own settings with it.
//!
//! **What the text does NOT hold.** `id` and `hotkey` are left out, and both for the same reason:
//! they are not the user's to write. `id` is identity — the icon store, the open dialog and the
//! active-workspace index all name this workspace by it, and a workspace that renamed itself
//! mid-edit would leave three of them pointing at nothing. `hotkey` is positional and
//! `normalize::hydrate` renumbers it from the list on every read, so a value typed here would be
//! overwritten by the next load and the field would be a lie in between.
//!
//! Leaving them out rather than showing them and ignoring them is the honest half of that: every
//! key in the box is a key that is read. A workspace pasted in from the config file still carries
//! both, and both are still ignored — but nobody is invited to type one.
//!
//! **Nothing here is clamped twice.** This is `hydrate`'s job for one subtree, and it does the
//! same three things to it: `internal:*` shortcuts go, a recorded key is normalised to the one
//! character it has to be, and an item with children is marked as a folder. What it adds is
//! healing the ids, because hand-written text is the one source that can arrive with two
//! shortcuts answering to the same one — and the dialog's rows are addressed by id.

use super::model::{AppItem, ItemKind, Workspace};
use serde_json::Value;

/// Why the text could not be read, and where.
///
/// `line` and `column` are 1-based, as serde reports them and as the gutter numbers them. A fault
/// that belongs to the whole text rather than to a place in it says line 1 — there is nowhere
/// better to point, and a caret parked at the start is where someone reading the message is
/// already looking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

impl Problem {
    /// The one line the editor prints under the text.
    pub fn sentence(&self) -> String {
        format!("Line {}, column {} — {}", self.line, self.column, self.message)
    }
}

/// A workspace that was read, and what had to be done to it on the way in.
#[derive(Debug, Clone)]
pub struct Parsed {
    pub workspace: Workspace,
    /// What this module changed that the text did not ask for: ids minted, dead shortcuts dropped,
    /// a key cut to one character. Empty when the text was taken exactly as written.
    ///
    /// Reported rather than done quietly. A silent repair is indistinguishable from an editor that
    /// did not save what was typed.
    pub healed: Vec<String>,
}

/// The order keys come out in, at every depth.
///
/// Deliberate, and not the alphabetical order `serde_json`'s map gives. Alphabetically a workspace
/// leads with `apps` — the bulk of the text — and its `name`, which is the thing it is being edited
/// by, is the fifth key; a shortcut leads with `command` and `commandType` and buries its `label`
/// between `iconSource` and `launchMode`. Both lists read as a dump rather than as a description.
///
/// One list for every object and not one per type, because a rank is all this needs: the names do
/// not collide — a workspace has a `name` and a shortcut has a `label` — and a per-depth order
/// would have to decide what depth a folder's children are at.
///
/// Anything absent from the list sorts after everything in it, alphabetically. That is where a key
/// from some other build of Rovyl lands, which is the right place for it: readable, last, and not
/// quietly dropped.
const KEY_ORDER: &[&str] = &[
    // What a workspace is.
    "name",
    "enabled",
    "hotkeyKey",
    "color",
    "pickerIconName",
    "pickerIconUrl",
    "pickerIconFile",
    // What a shortcut is: its identity, then what it opens, then how it looks, then the rest.
    "id",
    "label",
    "type",
    "command",
    "commandType",
    "commandShell",
    "commandWindow",
    "workingDirectory",
    "launchMode",
    "description",
    "direction",
    "shortcut",
    "iconName",
    "iconSource",
    "customIconUrl",
    "customIconFile",
    "hasRecents",
    "openTerminal",
    "openTerminalForRecents",
    "terminalCommands",
    // The two that hold lists, last, so everything that is one line is above them.
    "children",
    "apps",
];

/// The two the text does not carry. See the module's note.
const DERIVED: &[&str] = &["id", "hotkey"];

/// One level of indent. Two spaces, which is also what the editor's Tab inserts.
const INDENT: &str = "  ";

// ─── Out ────────────────────────────────────────────────────────────────────

/// The workspace as JSON, in `KEY_ORDER`, two spaces to a level, with no trailing newline.
///
/// No trailing newline on purpose: the editor shows the text as lines, and a file's conventional
/// last newline would read as an empty line under the closing brace that nobody typed.
pub fn to_text(workspace: &Workspace) -> String {
    let Ok(Value::Object(mut map)) = serde_json::to_value(workspace) else {
        // Unreachable for a struct of plain fields; `{}` rather than a panic because this runs
        // inside a frame that is painting.
        return "{}".to_string();
    };
    for key in DERIVED {
        map.remove(*key);
    }
    let mut out = String::new();
    emit(&Value::Object(map), 0, &mut out);
    out
}

/// Where a key sorts. Everything named comes before everything unnamed.
fn rank(key: &str) -> usize {
    KEY_ORDER
        .iter()
        .position(|known| *known == key)
        .unwrap_or(KEY_ORDER.len())
}

/// Pretty-print `value` at `indent` levels.
///
/// Written here rather than taken from `to_string_pretty` for one reason: the key order. Serde
/// prints a map in the map's own order, and `serde_json::Map` is a `BTreeMap`, so its order is
/// alphabetical at every depth and there is no hook to change it.
///
/// An empty object or array stays on one line. `[]` spread over three is noise, and a workspace
/// with no shortcuts in it would open with a hole in the middle of the text.
fn emit(value: &Value, indent: usize, out: &mut String) {
    match value {
        Value::Object(map) if !map.is_empty() => {
            out.push_str("{\n");
            let mut fields: Vec<(&String, &Value)> = map.iter().collect();
            fields.sort_by(|(a, _), (b, _)| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
            let last = fields.len() - 1;
            for (at, (key, nested)) in fields.iter().enumerate() {
                pad(out, indent + 1);
                out.push_str(&Value::String((*key).clone()).to_string());
                out.push_str(": ");
                emit(nested, indent + 1, out);
                if at < last {
                    out.push(',');
                }
                out.push('\n');
            }
            pad(out, indent);
            out.push('}');
        }
        Value::Array(items) if !items.is_empty() => {
            out.push_str("[\n");
            let last = items.len() - 1;
            for (at, nested) in items.iter().enumerate() {
                pad(out, indent + 1);
                emit(nested, indent + 1, out);
                if at < last {
                    out.push(',');
                }
                out.push('\n');
            }
            pad(out, indent);
            out.push(']');
        }
        // Scalars, and the two empty containers. `Value`'s own `Display` is compact JSON, which is
        // exactly right here: it escapes what has to be escaped and leaves text alone.
        scalar => out.push_str(&scalar.to_string()),
    }
}

fn pad(out: &mut String, levels: usize) {
    for _ in 0..levels {
        out.push_str(INDENT);
    }
}

// ─── In ─────────────────────────────────────────────────────────────────────

/// Read `text` as the workspace that replaces `identity`.
///
/// `identity` is the workspace on screen, and it is a parameter rather than something the caller
/// patches afterwards so that `id` and `hotkey` cannot be forgotten: there is no way to call this
/// and come away with a workspace whose identity came out of the text.
pub fn parse(text: &str, identity: &Workspace) -> Result<Parsed, Problem> {
    if text.trim().is_empty() {
        return Err(Problem {
            message: "there is nothing here. A workspace is an object: \
                      { \"name\": \"Work\", \"apps\": [] }"
                .to_string(),
            line: 1,
            column: 1,
        });
    }

    // Two parses, and both are wanted.
    //
    // The first is the SHAPE, and it is what catches a missing comma or an unclosed brace. The
    // second is the TYPE, and it is what catches `"commandType": "aplication"`. Running them in
    // this order is what decides which message a broken text gets: a syntax fault reported by the
    // typed parse comes back against whatever field the parser had reached, which is rarely the
    // field the mistake is in.
    let value: Value = serde_json::from_str(text).map_err(problem_of)?;
    if !value.is_object() {
        return Err(Problem {
            message: format!(
                "a workspace is an object, and this is {}. It opens with {{ and closes with }}",
                kind_of(&value)
            ),
            line: 1,
            column: 1,
        });
    }

    // `from_str` and not `from_value`, for the line and the column. `from_value` has no text to
    // point into, so an enum it cannot read becomes a message with no place in it — and "unknown
    // variant `aplication`" is not much help in a text with forty shortcuts in it.
    let mut workspace: Workspace = serde_json::from_str(text).map_err(problem_of)?;

    let mut healed = Vec::new();

    workspace.id = identity.id.clone();
    workspace.hotkey = identity.hotkey;

    // The same normalisation the recorder applies, because the field means the same thing however
    // it arrived. `Some("")` is the deliberate "no key" and survives as itself; `None` is "follow
    // the position" and is equally deliberate. Only a value that is neither is cut down.
    if let Some(stored) = workspace.hotkey_key.clone() {
        if !stored.trim().is_empty() {
            let normalized = super::normalize_workspace_key(Some(&stored));
            if normalized != stored {
                healed.push(if normalized.is_empty() {
                    format!("\"hotkeyKey\": {stored:?} is not a single key, so it was dropped")
                } else {
                    format!("\"hotkeyKey\": {stored:?} became {normalized:?}")
                });
            }
            workspace.hotkey_key = Some(normalized);
        }
    }

    let mut repairs = Repairs::default();
    let mut seen: Vec<String> = Vec::new();
    heal(&mut workspace.apps, &mut seen, &mut repairs);
    if repairs.dropped > 0 {
        healed.push(format!(
            "{} shortcut{} pointed at a widget this build no longer has, and went",
            repairs.dropped,
            plural(repairs.dropped)
        ));
    }
    if repairs.minted > 0 {
        healed.push(format!(
            "{} shortcut{} had no id of {} own, or shared one, and was given a fresh id",
            repairs.minted,
            plural(repairs.minted),
            if repairs.minted == 1 { "its" } else { "their" }
        ));
    }
    if repairs.foldered > 0 {
        healed.push(format!(
            "{} shortcut{} had children, so {} marked as a folder",
            repairs.foldered,
            plural(repairs.foldered),
            if repairs.foldered == 1 { "it was" } else { "they were" }
        ));
    }

    Ok(Parsed { workspace, healed })
}

fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

/// What `heal` had to do, counted so it can be reported in one sentence each.
#[derive(Debug, Default)]
struct Repairs {
    minted: usize,
    dropped: usize,
    foldered: usize,
}

/// The three repairs, down the whole tree.
///
/// Ids are healed here and nowhere else, because hand-written text is the only source that can
/// produce two shortcuts with one id. Everywhere else they are minted one at a time from the
/// clock. The dialog's rows, the open-row state and the icon picker all address a shortcut by id —
/// two rows with one id is two rows that expand together and one that can never be edited alone.
fn heal(items: &mut Vec<AppItem>, seen: &mut Vec<String>, repairs: &mut Repairs) {
    let before = items.len();
    items.retain(|item| !item.command.starts_with("internal:"));
    repairs.dropped += before - items.len();

    for item in items.iter_mut() {
        if item.id.trim().is_empty() || seen.contains(&item.id) {
            item.id = mint_id(repairs.minted);
            repairs.minted += 1;
        }
        seen.push(item.id.clone());

        // An item with children that is not marked a folder is a folder the wheel would draw as a
        // shortcut and launch as an empty command. `is_folder` reads the mark and not the
        // children, so the mark is what has to be right.
        if item.kind.is_none() && item.children.as_ref().is_some_and(|c| !c.is_empty()) {
            item.kind = Some(ItemKind::Folder);
            repairs.foldered += 1;
        }

        if let Some(children) = item.children.as_mut() {
            heal(children, seen, repairs);
        }
    }
}

/// A fresh id, from the clock and a counter.
///
/// The counter is what the clock cannot do here: a workspace of forty shortcuts is healed inside
/// one millisecond, and `item-<millis>` forty times over is the collision this function exists to
/// remove.
fn mint_id(nth: usize) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("item-{millis}-{nth}")
}

fn problem_of(error: serde_json::Error) -> Problem {
    Problem {
        message: without_place(&error.to_string()),
        // Serde reports 0 for a fault it cannot place — an empty input, or an IO error that cannot
        // happen for a `&str`. The gutter starts at 1, and a caret cannot be put on line 0.
        line: error.line().max(1),
        column: error.column().max(1),
    }
}

/// Drop the ` at line N column M` serde appends.
///
/// The place is shown separately, at the head of the sentence and in the gutter, and a message
/// that ends with it says the same thing twice in a box with room for one line.
fn without_place(message: &str) -> String {
    match message.find(" at line ") {
        Some(at) => message[..at].to_string(),
        None => message.to_string(),
    }
}

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "nothing",
        Value::Bool(_) => "a true/false",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CommandType, IconSource};

    fn workspace() -> Workspace {
        Workspace {
            id: "ws-1".into(),
            name: "Work".into(),
            hotkey: 3,
            apps: vec![AppItem {
                id: "item-a".into(),
                label: "Code".into(),
                command: "Microsoft.VisualStudioCode".into(),
                command_type: Some(CommandType::App),
                icon_source: Some(IconSource::Native),
                ..AppItem::default()
            }],
            ..Workspace::default()
        }
    }

    #[test]
    fn a_workspace_survives_the_round_trip() {
        let ws = workspace();
        let text = to_text(&ws);
        let back = parse(&text, &ws).expect("own output").workspace;
        assert_eq!(back.name, "Work");
        assert_eq!(back.apps.len(), 1);
        assert_eq!(back.apps[0].label, "Code");
        assert_eq!(back.apps[0].command_type, Some(CommandType::App));
        // And it is STABLE: the text of the parsed workspace is the text it came from, so a view
        // that re-serialises after every apply does not creep.
        assert_eq!(to_text(&back), text);
    }

    #[test]
    fn the_name_comes_before_the_shortcuts() {
        // Alphabetically `apps` wins and the name is the fifth key of the thing it names.
        let text = to_text(&workspace());
        let name_at = text.find("\"name\"").expect("a name");
        let apps_at = text.find("\"apps\"").expect("some apps");
        assert!(name_at < apps_at, "{text}");
    }

    #[test]
    fn identity_is_not_the_texts_to_give() {
        // Both are in the text as written, and both are ignored: the workspace on screen keeps the
        // id three other things address it by, and the position keeps the digit.
        let ws = workspace();
        let parsed = parse(
            r#"{ "id": "somebody-elses", "hotkey": 9, "name": "Renamed" }"#,
            &ws,
        )
        .expect("valid");
        assert_eq!(parsed.workspace.id, "ws-1");
        assert_eq!(parsed.workspace.hotkey, 3);
        assert_eq!(parsed.workspace.name, "Renamed");
    }

    #[test]
    fn neither_is_offered_in_the_first_place() {
        // At the TOP level. A shortcut keeps its own `id` — that one is the user's to move around,
        // and the two mean different things.
        let text = to_text(&workspace());
        let top: serde_json::Map<String, Value> = serde_json::from_str(&text).expect("own output");
        assert!(!top.contains_key("id"), "{text}");
        assert!(!top.contains_key("hotkey"), "{text}");
        assert!(text.contains("\"id\": \"item-a\""), "but the shortcut's is there: {text}");
    }

    #[test]
    fn a_missing_comma_is_reported_where_it_is() {
        let ws = workspace();
        let problem = parse("{\n  \"name\": \"Work\"\n  \"enabled\": true\n}", &ws)
            .expect_err("a comma is missing");
        assert_eq!(problem.line, 3, "{problem:?}");
        assert!(!problem.message.contains("at line"), "{}", problem.message);
    }

    #[test]
    fn a_misspelt_enum_is_reported_where_it_is() {
        // The reason there are two parses. `from_value` would report this with no place at all.
        let ws = workspace();
        let text = "{\n  \"name\": \"Work\",\n  \"apps\": [\n    { \"id\": \"a\",\n      \"commandType\": \"aplication\" }\n  ]\n}";
        let problem = parse(text, &ws).expect_err("no such command type");
        assert_eq!(problem.line, 5, "{problem:?}");
        assert!(problem.message.contains("aplication"), "{}", problem.message);
    }

    #[test]
    fn a_list_is_not_a_workspace() {
        let ws = workspace();
        let problem = parse("[]", &ws).expect_err("a list");
        assert!(problem.message.contains("a list"), "{}", problem.message);
        assert_eq!((problem.line, problem.column), (1, 1));
    }

    #[test]
    fn an_empty_box_says_what_one_looks_like() {
        let ws = workspace();
        let problem = parse("   \n  ", &ws).expect_err("empty");
        assert!(problem.message.contains("\"apps\""), "{}", problem.message);
        assert_eq!(problem.line, 1);
    }

    #[test]
    fn shared_ids_are_healed_and_said_so() {
        let ws = workspace();
        let parsed = parse(
            r#"{ "apps": [ { "id": "x", "label": "A" }, { "id": "x", "label": "B" },
                           { "label": "C" } ] }"#,
            &ws,
        )
        .expect("valid");
        let ids: Vec<&str> = parsed.workspace.apps.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids[0], "x", "the first claim keeps it");
        assert_ne!(ids[1], "x");
        assert!(!ids[2].is_empty());
        assert_ne!(ids[1], ids[2], "and the two fresh ones differ");
        assert!(
            parsed.healed.iter().any(|note| note.contains("fresh id")),
            "{:?}",
            parsed.healed
        );
    }

    #[test]
    fn dead_widget_shortcuts_go_as_they_do_on_load() {
        let ws = workspace();
        let parsed = parse(
            r#"{ "apps": [ { "id": "a", "command": "internal:notes" },
                           { "id": "b", "command": "notepad.exe" } ] }"#,
            &ws,
        )
        .expect("valid");
        assert_eq!(parsed.workspace.apps.len(), 1);
        assert_eq!(parsed.workspace.apps[0].id, "b");
        assert!(parsed.healed.iter().any(|note| note.contains("widget")));
    }

    #[test]
    fn children_without_the_mark_become_a_folder() {
        // `is_folder` reads the mark, not the children, so an unmarked parent is drawn as a
        // shortcut and launches an empty command.
        let ws = workspace();
        let parsed = parse(
            r#"{ "apps": [ { "id": "f", "label": "Dev",
                             "children": [ { "id": "c", "label": "Inner" } ] } ] }"#,
            &ws,
        )
        .expect("valid");
        assert!(parsed.workspace.apps[0].is_folder());
        assert_eq!(parsed.workspace.apps[0].child_slice().len(), 1);
        assert!(parsed.healed.iter().any(|note| note.contains("folder")));
    }

    #[test]
    fn ids_are_healed_down_the_tree_as_well() {
        let ws = workspace();
        let parsed = parse(
            r#"{ "apps": [ { "id": "dup", "type": "folder",
                             "children": [ { "id": "dup", "label": "Inner" } ] } ] }"#,
            &ws,
        )
        .expect("valid");
        let outer = &parsed.workspace.apps[0];
        assert_eq!(outer.id, "dup");
        assert_ne!(outer.child_slice()[0].id, "dup");
    }

    #[test]
    fn a_recorded_key_is_cut_to_one_character() {
        let ws = workspace();
        let parsed = parse(r#"{ "hotkeyKey": "q" }"#, &ws).expect("valid");
        assert_eq!(parsed.workspace.hotkey_key.as_deref(), Some("Q"));

        // The deliberate silence survives untouched, and says nothing about itself.
        let quiet = parse(r#"{ "hotkeyKey": "" }"#, &ws).expect("valid");
        assert_eq!(quiet.workspace.hotkey_key.as_deref(), Some(""));
        assert!(quiet.healed.is_empty(), "{:?}", quiet.healed);

        // So does "follow the position".
        let absent = parse(r#"{ "name": "x" }"#, &ws).expect("valid");
        assert_eq!(absent.workspace.hotkey_key, None);
    }

    #[test]
    fn a_text_taken_as_written_reports_no_repairs() {
        let ws = workspace();
        let parsed = parse(&to_text(&ws), &ws).expect("own output");
        assert!(parsed.healed.is_empty(), "{:?}", parsed.healed);
    }

    #[test]
    fn keys_this_build_does_not_know_are_kept() {
        // `Workspace::extra` is lossless on purpose, so the Electron build's own keys survive a
        // save from here. A view that hid them would be a view that stripped them on apply.
        let ws = workspace();
        let parsed = parse(r#"{ "name": "Work", "someFutureKey": 7 }"#, &ws).expect("valid");
        assert_eq!(
            parsed.workspace.extra.get("someFutureKey"),
            Some(&Value::from(7))
        );
        assert!(to_text(&parsed.workspace).contains("someFutureKey"));
    }

    #[test]
    fn nesting_is_indented_under_its_key() {
        let ws = workspace();
        let text = to_text(&ws);
        // The `apps` array opens after its key, and a shortcut inside it is a level further in.
        assert!(text.contains("  \"apps\": [\n    {\n      \"id\""), "{text}");
        // No trailing newline: the editor would show it as an empty line nobody typed.
        assert!(!text.ends_with('\n'), "{text:?}");
    }

    #[test]
    fn a_shortcut_leads_with_what_it_is_rather_than_with_the_alphabet() {
        // Alphabetically a shortcut opens `command`, `commandType`, `description`, `iconName`,
        // `iconSource`, and its label is sixth. That reads as a dump of a struct.
        let text = to_text(&workspace());
        let at = |key: &str| text.find(key).unwrap_or_else(|| panic!("{key} missing from {text}"));
        assert!(at("\"id\"") < at("\"label\""));
        assert!(at("\"label\"") < at("\"command\""));
        assert!(at("\"command\"") < at("\"description\""));
        assert!(at("\"description\"") < at("\"iconSource\""));
    }

    #[test]
    fn an_empty_list_stays_on_one_line() {
        // `[]` over three lines is a hole in the middle of a workspace that has no shortcuts yet.
        let bare = Workspace { id: "ws-1".into(), name: "New".into(), ..Workspace::default() };
        let text = to_text(&bare);
        assert!(text.contains("\"apps\": []"), "{text}");
        // And it is still readable back.
        assert!(parse(&text, &bare).is_ok());
    }

    #[test]
    fn a_folders_children_are_ordered_the_same_way_down_the_tree() {
        // One rank list for every object, at every depth — which is what stops a folder's
        // children reading differently from the shortcuts beside it.
        let ws = workspace();
        let parsed = parse(
            r#"{ "apps": [ { "id": "f", "type": "folder", "children": [
                 { "iconName": "Box", "label": "Inner", "id": "c" } ] } ] }"#,
            &ws,
        )
        .expect("valid");
        let text = to_text(&parsed.workspace);
        let inner = text.split("\"children\"").nth(1).expect("the children");
        let at = |key: &str| inner.find(key).expect("present");
        assert!(at("\"id\"") < at("\"label\""));
        assert!(at("\"label\"") < at("\"iconName\""));
    }
}
