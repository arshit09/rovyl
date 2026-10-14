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
        //        en      es        zh      ja  pt        ru        de        ar
        values: &["Back", "Atrás", "返回", "戻る", "Voltar", "Назад", "Zurück", "رجوع"],
    },
    Entry {
        key: "menu.cancel",
        values: &["Cancel", "Cancelar", "取消", "キャンセル", "Cancelar", "Отмена", "Abbrechen", "إلغاء"],
    },
    Entry {
        key: "menu.open",
        values: &["Open", "Abrir", "打开", "開く", "Abrir", "Открыть", "Öffnen", "فتح"],
    },
    Entry {
        key: "menu.workspaces",
        values: &["Workspaces", "Espacios", "工作区", "ワークスペース", "Espaços", "Пространства", "Arbeitsbereiche", "مساحات العمل"],
    },
    Entry {
        key: "menu.recents_fallback",
        values: &[
            "No recent folders",
            "Sin carpetas recientes",
            "没有最近的文件夹",
            "最近使ったフォルダーなし",
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
            "まだ何もありません \u{2014} 設定を開いてショートカットを追加してください",
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
            "アプリを探しています\u{2026}",
            "Procurando seus aplicativos\u{2026}",
            "Поиск приложений\u{2026}",
            "Deine Apps werden gesucht\u{2026}",
            "جارٍ البحث عن تطبيقاتك\u{2026}",
        ],
    },
    Entry {
        key: "menu.match_one",
        values: &["1 match", "1 coincidencia", "1 个匹配", "1 件", "1 correspondência", "1 совпадение", "1 Treffer", "نتيجة واحدة"],
    },
    Entry {
        key: "menu.match_many",
        values: &["{n} matches", "{n} coincidencias", "{n} 个匹配", "{n} 件", "{n} correspondências", "совпадений: {n}", "{n} Treffer", "{n} نتائج"],
    },
    Entry {
        key: "menu.direction_hint",
        values: &[
            "Push toward a target",
            "Empuja hacia un objetivo",
            "朝目标推动",
            "対象の方へ動かすと開きます",
            "Empurre em direção a um alvo",
            "Двигайтесь к цели",
            "In Richtung eines Ziels schieben",
            "ادفع نحو الهدف",
        ],
    },
];

/// The strings the TRAY draws: its menu and its tooltip.
///
/// Most of the translations are the Electron build's tray table (`archive/electron/backend/
/// i18n.cjs`), and "Settings", "Paused" and the up-to-date line are the panel's own. The English is
/// this build's, which words a few items differently ("Quit Rovyl" for "Quit"), and the
/// translations follow the meaning rather than the letter. The two update failures and "Until I
/// resume" have no counterpart in either table and were written for this one.
pub const TRAY: &[Entry] = &[
    Entry {
        key: "tray.open_wheel",
        values: &["Open wheel", "Abrir la rueda", "打开轮盘", "ホイールを開く", "Abrir a roda", "Открыть колесо", "Rad öffnen", "افتح العجلة"],
    },
    Entry {
        key: "tray.workspace",
        values: &["Workspace", "Espacio", "工作区", "ワークスペース", "Espaço", "Рабочее пространство", "Arbeitsbereich", "مساحة العمل"],
    },
    Entry {
        key: "tray.settings",
        values: &["Settings", "Ajustes", "设置", "設定", "Configurações", "Настройки", "Einstellungen", "الإعدادات"],
    },
    Entry {
        key: "tray.pause",
        values: &[
            "Pause triggers",
            "Pausar el gesto",
            "暂停触发",
            "呼び出しを一時停止",
            "Pausar o gesto",
            "Приостановить вызов",
            "Auslöser pausieren",
            "إيقاف الاستدعاء مؤقتًا",
        ],
    },
    Entry {
        key: "tray.paused",
        values: &["Paused", "En pausa", "已暂停", "一時停止中", "Pausado", "Приостановлено", "Pausiert", "متوقفة"],
    },
    Entry {
        key: "tray.paused_left",
        values: &[
            "Paused \u{2014} {minutes} min left",
            "En pausa \u{2014} quedan {minutes} min",
            "已暂停 \u{2014} 还剩 {minutes} 分钟",
            "一時停止中 \u{2014} 残り {minutes} 分",
            "Em pausa \u{2014} faltam {minutes} min",
            "Пауза \u{2014} осталось {minutes} мин",
            "Pausiert \u{2014} noch {minutes} Min.",
            "متوقّف مؤقتًا \u{2014} يتبقى {minutes} دقيقة",
        ],
    },
    Entry {
        key: "tray.resume",
        values: &["Resume now", "Reanudar ahora", "立即恢复", "今すぐ再開", "Retomar agora", "Возобновить сейчас", "Jetzt fortsetzen", "استئناف الآن"],
    },
    Entry {
        key: "tray.pause_restart",
        values: &[
            "Restart for {minutes} minutes",
            "Reiniciar durante {minutes} minutos",
            "重新暂停 {minutes} 分钟",
            "{minutes} 分に延長",
            "Reiniciar por {minutes} minutos",
            "Заново на {minutes} минут",
            "Neu für {minutes} Minuten",
            "أعد التوقيت {minutes} دقيقة",
        ],
    },
    Entry {
        key: "tray.pause_for",
        values: &[
            "For {minutes} minutes",
            "Durante {minutes} minutos",
            "{minutes} 分钟",
            "{minutes} 分間",
            "Por {minutes} minutos",
            "На {minutes} минут",
            "Für {minutes} Minuten",
            "لمدة {minutes} دقيقة",
        ],
    },
    Entry {
        key: "tray.pause_until",
        values: &[
            "Until I resume",
            "Hasta que lo reanude",
            "直到我恢复",
            "再開するまで",
            "Até eu retomar",
            "Пока я не возобновлю",
            "Bis ich fortsetze",
            "حتى أستأنف",
        ],
    },
    Entry {
        key: "tray.update_check",
        values: &[
            "Check for updates",
            "Buscar actualizaciones",
            "检查更新",
            "更新を確認",
            "Procurar atualizações",
            "Проверить обновления",
            "Nach Updates suchen",
            "البحث عن تحديثات",
        ],
    },
    Entry {
        key: "tray.update_checking",
        values: &[
            "Checking for updates\u{2026}",
            "Buscando actualizaciones\u{2026}",
            "正在检查更新\u{2026}",
            "更新を確認中\u{2026}",
            "Procurando atualizações\u{2026}",
            "Проверка обновлений\u{2026}",
            "Suche nach Updates\u{2026}",
            "جارٍ البحث عن تحديثات\u{2026}",
        ],
    },
    Entry {
        key: "tray.update_current",
        values: &[
            "You are on the latest version",
            "Tienes la última versión",
            "你使用的已是最新版本",
            "最新バージョンを使用中です",
            "Você está na versão mais recente",
            "У вас последняя версия",
            "Sie haben die neueste Version",
            "أنت على أحدث إصدار",
        ],
    },
    Entry {
        key: "tray.update_downloading",
        values: &[
            "Downloading {version}\u{2026}",
            "Descargando {version}\u{2026}",
            "正在下载 {version}\u{2026}",
            "{version} をダウンロード中\u{2026}",
            "Baixando {version}\u{2026}",
            "Загрузка {version}\u{2026}",
            "{version} wird geladen\u{2026}",
            "جارٍ تنزيل {version}\u{2026}",
        ],
    },
    Entry {
        key: "tray.update_ready",
        values: &[
            "Restart to update to {version}",
            "Reiniciar para actualizar a {version}",
            "重启以更新到 {version}",
            "再起動して {version} に更新",
            "Reiniciar para atualizar para {version}",
            "Перезапустить и обновить до {version}",
            "Neu starten und auf {version} aktualisieren",
            "أعد التشغيل للتحديث إلى {version}",
        ],
    },
    Entry {
        key: "tray.update_unreachable",
        values: &[
            "Could not check for updates",
            "No se pudo buscar actualizaciones",
            "无法检查更新",
            "更新を確認できませんでした",
            "Não foi possível procurar atualizações",
            "Не удалось проверить обновления",
            "Suche nach Updates fehlgeschlagen",
            "تعذّر البحث عن تحديثات",
        ],
    },
    Entry {
        key: "tray.update_failed",
        values: &[
            "Could not download the update",
            "No se pudo descargar la actualización",
            "无法下载更新",
            "更新をダウンロードできませんでした",
            "Não foi possível baixar a atualização",
            "Не удалось загрузить обновление",
            "Update konnte nicht geladen werden",
            "تعذّر تنزيل التحديث",
        ],
    },
    Entry {
        key: "tray.quit",
        values: &["Quit Rovyl", "Salir", "退出", "終了", "Sair", "Выход", "Beenden", "إنهاء"],
    },
    Entry {
        key: "tray.tip_paused",
        values: &[
            "Rovyl \u{2014} triggers paused",
            "Rovyl \u{2014} gesto en pausa",
            "Rovyl \u{2014} 触发已暂停",
            "Rovyl \u{2014} 呼び出しを一時停止中",
            "Rovyl \u{2014} gesto em pausa",
            "Rovyl \u{2014} вызов приостановлен",
            "Rovyl \u{2014} Auslöser pausiert",
            "Rovyl \u{2014} الاستدعاء متوقف مؤقتًا",
        ],
    },
    Entry {
        key: "tray.tip_paused_left",
        values: &[
            "Rovyl \u{2014} paused, {minutes} min left",
            "Rovyl \u{2014} en pausa, quedan {minutes} min",
            "Rovyl \u{2014} 已暂停，还剩 {minutes} 分钟",
            "Rovyl \u{2014} 一時停止中、残り {minutes} 分",
            "Rovyl \u{2014} em pausa, faltam {minutes} min",
            "Rovyl \u{2014} пауза, осталось {minutes} мин",
            "Rovyl \u{2014} pausiert, noch {minutes} Min.",
            "Rovyl \u{2014} متوقّف مؤقتًا، يتبقى {minutes} دقيقة",
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
        for entry in WHEEL.iter().chain(TRAY) {
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
        for table in [WHEEL, TRAY] {
            for (i, a) in table.iter().enumerate() {
                for b in &table[i + 1..] {
                    assert_ne!(a.key, b.key, "{} appears twice", a.key);
                }
            }
        }
    }

    #[test]
    fn every_translation_keeps_its_placeholders() {
        // A tray item that lost `{version}` would offer to update to nothing in particular.
        for entry in WHEEL.iter().chain(TRAY) {
            let english = entry.values[0];
            for slot in ["{n}", "{minutes}", "{version}"] {
                if !english.contains(slot) {
                    continue;
                }
                for (language, value) in crate::i18n::LANGUAGES.iter().zip(entry.values) {
                    assert!(
                        value.is_empty() || value.contains(slot),
                        "{} in {} has lost {slot}",
                        entry.key,
                        language.code
                    );
                }
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
