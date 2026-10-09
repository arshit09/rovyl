//! Which languages exist, and what the interface says in each.
//!
//! The split between the list and the tables is the original's, and it was a performance decision
//! there: the renderer's critical chunk had to validate a stored `language` on every start, and
//! importing the tables to do it put all seven locales in the bytes the wheel waited on. That
//! particular cost does not exist in a native binary — the strings are read-only data, paged in on
//! demand — but the split is kept because it is also the right shape: "which languages are there"
//! and "what do they say" are different questions, and only one of them is asked at startup.

pub mod settings_strings;
pub mod strings;

pub struct Language {
    pub code: &'static str,
    /// The ENDONYM — what the picker shows. Someone stranded in a UI they cannot read is looking
    /// for the row that looks like their language, and "Russian" does not look like Русский.
    pub endonym: &'static str,
    /// The English name, used as the accessible label so a screen reader announces something
    /// sayable.
    pub english: &'static str,
    pub rtl: bool,
}

pub const LANGUAGES: &[Language] = &[
    Language { code: "en", endonym: "English", english: "English", rtl: false },
    Language { code: "es", endonym: "Español", english: "Spanish", rtl: false },
    Language { code: "zh", endonym: "简体中文", english: "Chinese (Simplified)", rtl: false },
    Language { code: "pt", endonym: "Português", english: "Portuguese", rtl: false },
    Language { code: "ru", endonym: "Русский", english: "Russian", rtl: false },
    Language { code: "de", endonym: "Deutsch", english: "German", rtl: false },
    Language { code: "ar", endonym: "العربية", english: "Arabic", rtl: true },
];

pub const FALLBACK: &str = "en";

pub fn is_supported(code: &str) -> bool {
    LANGUAGES.iter().any(|l| l.code == code)
}

/// A stored `config.language` is whatever some earlier build wrote there — and older configs name
/// four locales that have no table (`fr`, `it`, `ja`, `ko`), so every read goes through here.
pub fn normalize(code: &str) -> &'static str {
    LANGUAGES
        .iter()
        .find(|l| l.code == code)
        .map(|l| l.code)
        .unwrap_or(FALLBACK)
}

/// `true` for Arabic, `false` for the rest — asked, never hardcoded at the call site.
pub fn is_rtl(code: &str) -> bool {
    LANGUAGES
        .iter()
        .find(|l| l.code == code)
        .map(|l| l.rtl)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fallback_is_in_the_list() {
        assert!(is_supported(FALLBACK));
    }

    #[test]
    fn codes_are_unique() {
        for (i, a) in LANGUAGES.iter().enumerate() {
            for b in &LANGUAGES[i + 1..] {
                assert_ne!(a.code, b.code);
            }
        }
    }

    #[test]
    fn retired_locales_fall_back() {
        // `fr`, `it`, `ja` and `ko` are named by old configs and have no table.
        for code in ["fr", "it", "ja", "ko", "", "nonsense"] {
            assert_eq!(normalize(code), "en", "{code}");
        }
        assert_eq!(normalize("ru"), "ru");
    }

    #[test]
    fn exactly_one_language_is_right_to_left() {
        assert_eq!(LANGUAGES.iter().filter(|l| l.rtl).count(), 1);
        assert!(is_rtl("ar"));
        assert!(!is_rtl("en"));
    }

    #[test]
    fn every_language_shows_its_own_name() {
        // The endonym is what somebody who cannot read the rest of the UI is scanning for.
        for language in LANGUAGES {
            assert!(!language.endonym.is_empty());
            assert!(!language.english.is_empty());
        }
        // And at least the non-Latin ones are genuinely in their own script, which is the whole
        // point — a list of English names helps nobody who needs it.
        let chinese = LANGUAGES.iter().find(|l| l.code == "zh").unwrap();
        assert!(chinese.endonym.chars().any(|c| !c.is_ascii()));
    }
}

/// One of the settings panel's strings, in `language`.
///
/// Falls back per STRING rather than per table: a language that has most of the panel and is
/// missing one line shows that line in English rather than reverting the whole window.
pub fn settings_text(key: &str, language: &str) -> &'static str {
    strings::text(settings_strings::SETTINGS, key, language)
}

#[cfg(test)]
mod generated_tests {
    #[test]
    fn the_generated_table_is_in_the_same_order_as_the_languages() {
        // The values are positional. A table generated from a file whose languages are in another
        // order would show Spanish to German speakers, silently and everywhere at once.
        let codes: Vec<&str> = super::LANGUAGES.iter().map(|l| l.code).collect();
        assert_eq!(codes, super::settings_strings::CODES);
    }

    #[test]
    fn every_entry_has_a_value_for_every_language() {
        for entry in super::settings_strings::SETTINGS {
            assert_eq!(
                entry.values.len(),
                super::LANGUAGES.len(),
                "{} has {} values",
                entry.key,
                entry.values.len()
            );
            assert!(!entry.values[0].is_empty(), "{} has no English", entry.key);
        }
    }

    #[test]
    fn the_panel_speaks_the_languages_it_offers() {
        // Spot checks against the table the Electron build ships, so a regenerate that silently
        // produced empty strings fails here rather than on somebody's screen.
        assert_eq!(super::settings_text("general", "en"), "General");
        assert_eq!(super::settings_text("general", "de"), "Allgemein");
        assert_eq!(super::settings_text("workspaces", "es"), "Espacios de trabajo");
        // A key nothing defines comes back empty rather than panicking.
        assert_eq!(super::settings_text("no-such-key", "en"), "");
        // An unknown language falls back to the first, which is English.
        assert_eq!(super::settings_text("general", "xx"), "General");
    }
}
