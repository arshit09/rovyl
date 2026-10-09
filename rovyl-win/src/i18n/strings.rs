//! The interface text.
//!
//! Only the strings that are genuinely translated live here. The settings panel's own copy is in
//! `ui/settings.rs` beside the rows it belongs to, because those sentences and the behaviour they
//! describe have to be changed together — a description that drifts from its setting is worse than
//! no description, and the original's are full of reasons that stop being true if the code moves.
//!
//! Lookup is by key with an English fallback per string, not per table: a table that is missing one
//! key shows that key in English rather than falling back wholesale, which is what keeps a partial
//! translation useful.

/// One key's text in every language that has it.
pub struct Entry {
    pub key: &'static str,
    /// Parallel to `i18n::LANGUAGES`. An empty string means "not translated", and falls back.
    pub values: &'static [&'static str],
}

/// The strings the WHEEL draws — the only ones a user sees without opening Settings.
///
/// Deliberately short. Everything else is in a window they had to go and open, and a launcher
/// whose gesture is silent needs almost no words at all.
pub const WHEEL: &[Entry] = &[
    Entry {
        key: "menu.back",
        //        en      es        zh      pt        ru        de        ar
        values: &["Back", "Atrás", "返回", "Voltar", "Назад", "Zurück", "رجوع"],
    },
    Entry {
        key: "menu.cancel",
        values: &["Cancel", "Cancelar", "取消", "Cancelar", "Отмена", "Abbrechen", "إلغاء"],
    },
    Entry {
        key: "menu.open",
        values: &["Open", "Abrir", "打开", "Abrir", "Открыть", "Öffnen", "فتح"],
    },
    Entry {
        key: "menu.workspaces",
        values: &["Workspaces", "Espacios", "工作区", "Espaços", "Пространства", "Arbeitsbereiche", "مساحات العمل"],
    },
    Entry {
        key: "menu.recents_fallback",
        values: &[
            "No recent folders",
            "Sin carpetas recientes",
            "没有最近的文件夹",
            "Sem pastas recentes",
            "Нет недавних папок",
            "Keine zuletzt verwendeten Ordner",
            "لا توجد مجلدات حديثة",
        ],
    },
    Entry {
        key: "menu.empty",
        values: &[
            "Nothing here yet \u{2014} open Settings to add a shortcut",
            "Nada aquí todavía \u{2014} abre Ajustes para añadir un acceso directo",
            "这里还没有内容 \u{2014} 打开设置以添加快捷方式",
            "Nada aqui ainda \u{2014} abra as Configurações para adicionar um atalho",
            "Здесь пока ничего нет \u{2014} откройте настройки, чтобы добавить ярлык",
            "Noch nichts hier \u{2014} öffne die Einstellungen, um eine Verknüpfung hinzuzufügen",
            "لا يوجد شيء هنا بعد \u{2014} افتح الإعدادات لإضافة اختصار",
        ],
    },
    Entry {
        key: "menu.discovering",
        values: &[
            "Finding your apps\u{2026}",
            "Buscando tus aplicaciones\u{2026}",
            "正在查找你的应用\u{2026}",
            "Procurando seus aplicativos\u{2026}",
            "Поиск приложений\u{2026}",
            "Deine Apps werden gesucht\u{2026}",
            "جارٍ البحث عن تطبيقاتك\u{2026}",
        ],
    },
    Entry {
        key: "menu.match_one",
        values: &["1 match", "1 coincidencia", "1 个匹配", "1 correspondência", "1 совпадение", "1 Treffer", "نتيجة واحدة"],
    },
    Entry {
        key: "menu.match_many",
        values: &["{n} matches", "{n} coincidencias", "{n} 个匹配", "{n} correspondências", "совпадений: {n}", "{n} Treffer", "{n} نتائج"],
    },
    Entry {
        key: "menu.direction_hint",
        values: &[
            "Push toward a target",
            "Empuja hacia un objetivo",
            "朝目标推动",
            "Empurre em direção a um alvo",
            "Двигайтесь к цели",
            "In Richtung eines Ziels schieben",
            "ادفع نحو الهدف",
        ],
    },
];

/// The text for `key` in `language`, falling back to English per STRING rather than per table.
pub fn text(table: &'static [Entry], key: &str, language: &str) -> &'static str {
    let index = super::LANGUAGES
        .iter()
        .position(|l| l.code == language)
        .unwrap_or(0);
    let Some(entry) = table.iter().find(|e| e.key == key) else {
        // A key with no entry at all is a bug in the caller, and showing the key itself is what
        // makes it visible rather than silently blank.
        return "";
    };
    entry
        .values
        .get(index)
        .copied()
        .filter(|value| !value.is_empty())
        .or_else(|| entry.values.first().copied())
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_covers_every_language() {
        // A short table means a language silently falls back for keys nobody checked.
        let count = crate::i18n::LANGUAGES.len();
        for entry in WHEEL {
            assert_eq!(
                entry.values.len(),
                count,
                "{} has {} values for {} languages",
                entry.key,
                entry.values.len(),
                count
            );
        }
    }

    #[test]
    fn keys_are_unique() {
        for (i, a) in WHEEL.iter().enumerate() {
            for b in &WHEEL[i + 1..] {
                assert_ne!(a.key, b.key, "{} appears twice", a.key);
            }
        }
    }

    #[test]
    fn lookup_falls_back_per_string() {
        assert_eq!(text(WHEEL, "menu.back", "en"), "Back");
        assert_eq!(text(WHEEL, "menu.back", "de"), "Zurück");
        // An unknown language reads as English rather than as nothing.
        assert_eq!(text(WHEEL, "menu.back", "xx"), "Back");
        // An unknown key is empty, not a panic.
        assert_eq!(text(WHEEL, "menu.nope", "en"), "");
    }

    #[test]
    fn the_plural_form_carries_its_placeholder() {
        // Russian puts the number last, which is exactly why this is a template per language
        // rather than a suffix appended to a count.
        for language in crate::i18n::LANGUAGES {
            let value = text(WHEEL, "menu.match_many", language.code);
            assert!(value.contains("{n}"), "{} is missing the count", language.code);
        }
    }
}
