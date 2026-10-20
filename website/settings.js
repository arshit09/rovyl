/* ══════════════════════════════════════════════════════════════════════════
   Rovyl - the settings panel, working

   A screenshot of a settings window answers one question and refuses every
   other. This is the panel itself: the six sections the app ships, their real
   rows, and controls that actually move. Nothing persists and nothing is
   pretend-wired to a backend - flipping a switch here changes this page's copy
   of the config and the things that read it, exactly as the app's does.

   The rows are the app's own, from `PrecisionSettings`: same groups, same
   titles, same descriptions, and the same conditional rows that appear only
   once the feature above them is on. Starting values come from `workspaces.js`,
   so the panel opens on the machine's real configuration.

   The Sound section is the one that reaches past the window: it edits the
   page's single copy of the sound settings (`sound.js`), so a note picked here
   is the note the wheel at the top of the page plays.
   ══════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const DATA = window.ROVYL || {};
  const LOOK = DATA.look || {};
  const SPACES = (DATA.workspaces || []).filter((w) => w.items && w.items.length);
  const SOUND = window.RovylSound || null;

  const win = document.getElementById('settingsWin');
  const nav = document.getElementById('winNav');
  const main = document.getElementById('winMain');
  if (!win || !nav || !main) return;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* The six places a dock may sit. Same list, same order, in src/utils/screenDocks.ts. */
  const DOCK_POSITION_CHOICES = [
    ['top-left', 'Top left'],
    ['top-center', 'Top center'],
    ['top-right', 'Top right'],
    ['bottom-left', 'Bottom left'],
    ['bottom-center', 'Bottom center'],
    ['bottom-right', 'Bottom right'],
  ];
  const DOCK_LABELS = Object.fromEntries(DOCK_POSITION_CHOICES);
  /* The same six as the screen lays them out - `DOCK_POSITION_GRID`. Also the
     order the arrow keys walk: on a picture, Right has to mean right. */
  const DOCK_GRID = [
    ['top-left', 'top-center', 'top-right'],
    ['bottom-left', 'bottom-center', 'bottom-right'],
  ];

  /* The seven the app ships, in the app's order, each under its own name for itself.
     Someone stranded in a UI they cannot read is looking for the row that LOOKS like
     their language, and "Russian" does not look like Русский. The English name rides
     along as support, as it does in `src/i18n/languages.ts`. */
  /* ── Japanese ────────────────────────────────────────────────────────────
     The page under /ja is the same replica with the same rows, and a Japanese
     landing page whose centrepiece demo is in English argues against itself.

     Keyed by the English string rather than by a row id on purpose: the rows
     below are data, not components, and a second parallel structure is how one
     of two lists goes stale. A string with no entry falls through to English,
     so adding a row never breaks the page - it just leaves that row untranslated
     until someone adds the line. The wording matches `src/i18n/translations.ts`;
     this is the app's own copy, not a second translation of it. */
  const JA = {
    'A note each time the highlight moves to a different item.':
      'ハイライトが別の項目に移るたびに一音。',
    'A strip of your own icons beside the open wheel - Chrome, Steam, a project folder, anything. Nothing is drawn until you add some.':
      '開いたホイールの脇に並ぶ、自分のアイコンの帯 — Chrome、Steam、作業中のフォルダー、なんでも。追加するまでは何も描かれません。',
    'Activation':
      '呼び出し',
    'Activation zone':
      '確定までの距離',
    'Add icons':
      'アイコンを追加',
    'Advanced':
      '詳細',
    'All':
      'すべて',
    'All fullscreen apps or only a selected list.':
      '全画面のアプリすべてか、選んだ一覧だけか。',
    'Appearance':
      '外観',
    'Applies to the window and title bar. The wheel remains dark.':
      'ウィンドウとタイトルバーに適用されます。ホイールは暗いままです。',
    'Back':
      '戻る',
    'Background dimming':
      '背景を暗くする',
    'Battery':
      'バッテリー',
    'Black':
      'ブラック',
    'Bottom center':
      '下中央',
    'Bottom left':
      '左下',
    'Bottom right':
      '右下',
    'Cancel':
      '取り消し',
    'Charge level, and whether it is on the charger. Nothing is drawn on a machine with no battery.':
      '充電残量と、充電器につながっているかどうか。バッテリーのない機械では何も描きません。',
    'Check for updates':
      '更新を確認',
    'Check now':
      '今すぐ確認',
    'Choose apps':
      'アプリを選ぶ',
    'Choose installed applications visually. No executable names required.':
      'インストール済みのアプリを見ながら選べます。実行ファイル名を入力する必要はありません。',
    'Choose interface display language.':
      '画面の表示言語を選びます。',
    'Click':
      'クリック',
    'Click keeps the wheel open; hold runs the selection on release.':
      'クリックではホイールが開いたままになり、長押しでは離した時点で実行します。',
    'Clock':
      '時計',
    'Color used by the target under the pointer.':
      'ポインターが指している対象に使われる色。',
    'Contexts and their shortcuts.':
      'コンテキストと、そのショートカット。',
    'Core Rovyl behavior.':
      'Rovyl の基本の動き。',
    'Current':
      '現在',
    'Cursor distance required to confirm a target.':
      '対象を確定するのに必要なカーソルの移動距離。',
    'Data':
      'データ',
    'Detect games automatically':
      'ゲームを自動で判別',
    'Direction':
      '方向',
    'Direction sensitivity':
      '方向の感度',
    'Draws each position’s digit on its icon. Turn it off once the wheel is in your hands - the keys go on working.':
      '各位置の数字をアイコンの上に描きます。ホイールに慣れたら切って構いません。キーはそのまま使えます。',
    'Draws the seams between the shares and fills the one you are aiming at with the hover color. Off, the aim is identical and only the icon lights up.':
      '取り分の境目を描き、狙っている扇形をホバー色で塗ります。オフでも狙いは変わらず、アイコンだけが光ります。',
    'Enable keyboard trigger':
      'キーボードでの呼び出しを有効にする',
    'Enable mouse trigger':
      'マウスでの呼び出しを有効にする',
    'Erase everything':
      'すべて消去',
    'Erase local settings and start over.':
      'この PC の設定を消して、最初からやり直します。',
    'Every workspace, shortcut, icon and preference on this PC is deleted and Rovyl restarts. This cannot be undone - use Export settings first if you want a copy.':
      'この PC のワークスペース・ショートカット・アイコン・設定がすべて削除され、Rovyl が再起動します。取り消せません。控えが要るなら、先に設定の書き出しを。',
    'Export':
      '書き出す',
    'Export settings':
      '設定を書き出す',
    'Follow pointer':
      'ポインターを追う',
    'Forward':
      '進む',
    'Free space between items.':
      '項目のあいだの余白。',
    'Fullscreen protection':
      '全画面時の保護',
    'General':
      '一般',
    'Gesture behavior':
      'ジェスチャの挙動',
    'GitHub':
      'GitHub',
    'Global shortcut':
      'グローバルショートカット',
    'Hands-free':
      'ハンズフリー',
    'Hides the pointer and picks by direction - move toward a target and it opens by itself. Escape closes the wheel without opening anything.':
      'ポインターを隠し、向きで選びます。対象の方へ動かすとそのまま開きます。Escape を押せば何も開かずにホイールを閉じます。',
    'High':
      '高',
    'Hold':
      '長押し',
    'Hover color':
      'ホバー時の色',
    'Hover sound':
      '移動時の音',
    'Hover time':
      '待ち時間',
    'How and where the wheel appears.':
      'ホイールをどこで、どう開くか。',
    'How big each icon is drawn.':
      'アイコン1つの大きさ。',
    'How big the glyphs are drawn. The readouts beside them are set to match.':
      '記号の大きさ。隣の数値もそれに合わせます。',
    'How far your hand must travel before that direction is chosen. High picks on the smallest movement.':
      'その向きが選ばれるまでに手をどれだけ動かす必要があるか。「高」ならわずかな動きで選ばれます。',
    'How long a target must stay aimed before it opens. Drag to zero and the direction opens the moment it commits.':
      '対象を狙ったまま何秒待つと開くか。ゼロまで下げると、向きが決まった瞬間に開きます。',
    'How loud both sounds play. Windows volume still applies on top.':
      '2つの音の大きさ。この上に Windows 側の音量もかかります。',
    'How much the rest of the screen recedes. At 100% it goes: the desktop is covered edge to edge.':
      '画面のほかの部分がどれだけ後ろに下がるか。100% では見えなくなり、デスクトップが端まで覆われます。',
    'How the global keyboard shortcut activates the menu.':
      'グローバルショートカットでメニューをどう呼び出すか。',
    'Icon size':
      'アイコンの大きさ',
    'Icons':
      'アイコン',
    'Import':
      '読み込む',
    'Import settings':
      '設定を読み込む',
    'Instant':
      '即時',
    'Keep every target name visible.':
      'すべての対象の名前を表示したままにします。',
    'Key to leave a folder':
      'フォルダーから戻るキー',
    'Keyboard':
      'キーボード',
    'Language':
      '言語',
    'Launch without clicking':
      'クリックなしで起動',
    'List':
      '一覧',
    'Low':
      '低',
    'Main screen':
      'メイン画面',
    'Medium':
      '中',
    'Monitor':
      'ディスプレイ',
    'Mouse':
      'マウス',
    'Names under the icons':
      'アイコンの下に名前',
    'Network':
      'ネットワーク',
    'New workspace':
      '新しいワークスペース',
    'Notes for opening and moving around the wheel.':
      'ホイールを開くときと、項目を移るときの音。',
    'Number keys':
      '数字キー',
    'Off by default: a strip of eight names is a menu, and the wheel is already that.':
      '既定はオフ。名前が8つ並べばそれはメニューで、ホイールがすでにそれです。',
    'One note as the wheel blooms open, and again when you aim back at the center.':
      'ホイールが咲くように開くときに一音、中心に狙いを戻したときにもう一音。',
    'Only the icon under the pointer highlights. Release away from every icon to cancel.':
      'ポインターの下のアイコンだけが光ります。どのアイコンからも離れた場所で離せば取り消しです。',
    'Open':
      '開く',
    'Open the wheel over any application.':
      'どのアプリの上でもホイールを開きます。',
    'Open the wheel with a keyboard shortcut.':
      'キーボードショートカットでホイールを開きます。',
    'Open the wheel with a mouse button.':
      'マウスのボタンでホイールを開きます。',
    'Opening sound':
      '開くときの音',
    'Orbital radius':
      'ホイールの半径',
    'Output level, with a slider you can drag. Click the glyph to mute.':
      '出力レベル。スライダーで動かせます。記号をクリックでミュート。',
    'Paused':
      '一時停止中',
    'Perceived wheel diameter.':
      'ホイールの見た目の大きさ。',
    'Persistent labels':
      'ラベルを常に表示',
    'Pick the corner or edge on the screen below.':
      '下の画面で角か辺を選びます。',
    'Pick the corner or edge on the screen below. The wheel opens over the whole screen while a dock is on - everything but the taskbar - so the corner is a real one.':
      '下の画面で角か辺を選びます。ドックが出ているあいだホイールは画面全体 — タスクバー以外のすべて — に開くので、角は本当の角です。',
    'Picker':
      '選択画面',
    'Pointer':
      'ポインター',
    'Position':
      '位置',
    'Presence':
      '存在感',
    'Press play beside a name to hear it before choosing.':
      '名前の横の再生ボタンで、選ぶ前に聴けます。',
    'Prevent accidental openings during games and videos.':
      'ゲームや動画の最中に誤って開くのを防ぎます。',
    'Protected applications':
      '保護するアプリ',
    'Protection':
      '保護',
    'Quick launch with number keys':
      '数字キーでのクイック起動',
    'Reset to default':
      '既定に戻す',
    'Restore':
      '戻す',
    'Restore defaults':
      '初期設定に戻す',
    'Rovyl checks automatically a few seconds after launch.':
      '起動の数秒後に Rovyl が自動で確認します。',
    'Rovyl is ready as soon as you sign in to Windows.':
      'Windows にサインインした時点で Rovyl が使えるようになります。',
    'Rovyl surfaces':
      'Rovyl の画面',
    'Save a portable copy of your configuration.':
      '設定の持ち運べる控えを保存します。',
    'Scope':
      '適用範囲',
    'Settings button on the wheel':
      'ホイール上の設定ボタン',
    'Settings shortcut':
      '設定へのショートカット',
    'Shape, presence, and theme.':
      '形、存在感、テーマ。',
    'Short bass notes as the wheel opens and as you move between items.':
      'ホイールが開くとき、項目を移るときに鳴る短い低音。',
    'Shortcut behavior':
      'ショートカットの挙動',
    'Shortcut dock':
      'ショートカットドック',
    'Show numbers on the wheel':
      'ホイールに数字を表示',
    'Show the pill under the wheel with the current workspace and folder.':
      'ホイールの下に、今のワークスペースとフォルダーを示す帯を出します。',
    'Sound':
      '音',
    'Sound effects':
      '効果音',
    'Source code, releases, and issues.':
      'ソースコード、リリース、Issue。',
    'Spacing':
      '間隔',
    'Start with Windows':
      'Windows と同時に起動',
    'System dock':
      'システムドック',
    'Target spacing':
      '対象どうしの間隔',
    'Targeting':
      '狙い方',
    'The gap between neighbouring icons.':
      '隣り合うアイコンのあいだの空き。',
    'The gap between neighbouring readouts.':
      '隣り合う表示のあいだの空き。',
    'The time, with the date under it.':
      '時刻と、その下に日付。',
    'The wheel always opens on the main screen, wherever the pointer happens to be.':
      'ポインターがどこにあっても、ホイールは常にメイン画面に開きます。',
    'The wheel opens on the screen the pointer is already on, so what you launch lands where you are working.':
      'ポインターのある画面にホイールが開くので、起動したものは作業している場所に出ます。',
    'Theme':
      'テーマ',
    'Time, battery, network and volume, read live, beside the open wheel.':
      '時刻・バッテリー・ネットワーク・音量を、開いたホイールの脇に実時間で。',
    'Time, battery, network and volume, read live, beside the open wheel. The volume slider and the mute button work from here.':
      '時刻・バッテリー・ネットワーク・音量を、開いたホイールの脇に実時間で。音量スライダーとミュートはここから操作できます。',
    'Toggle':
      'トグル',
    'Top center':
      '上中央',
    'Top left':
      '左上',
    'Top right':
      '右上',
    'Trigger button':
      '呼び出しボタン',
    'Try it':
      '試す',
    'Uses game-store folders and engine files; protection still applies only in fullscreen.':
      'ゲームストアのフォルダーとエンジンのファイルを手がかりにします。保護が働くのは全画面のときだけです。',
    'Visible wedges':
      '扇形を表示',
    'Visual weight of each target.':
      '一つひとつの対象の見た目の重さ。',
    'Volume':
      '音量',
    'Wheel':
      'ホイール',
    'When moving between items':
      '項目を移るとき',
    'When the wheel opens':
      'ホイールが開くとき',
    'Where it opens':
      '開く場所',
    'Where it sits':
      '置く場所',
    'Where the gear sits. It steps inboard if the battery or weather pill is already there.':
      '歯車を置く位置。バッテリーや天気の表示が先にある場合は内側にずれます。',
    'Which corner':
      'どの角に置くか',
    'White':
      'ホワイト',
    'Wi-Fi signal, or a wired connection. Click it for the Windows network panel.':
      'Wi-Fi の電波、または有線接続。クリックすると Windows のネットワークパネルが開きます。',
    'Workspace name':
      'ワークスペース名',
    'Workspaces':
      'ワークスペース',
    'Area':
      '領域',
    'At pointer':
      'ポインターの位置',
    'Screen center':
      '画面の中央',
    'Protection, shortcuts, and data.':
      '保護、ショートカット、データ。',
  
  };

  const isJapanese = document.documentElement.lang === 'ja';
  const tr = (value) => (isJapanese && value && JA[value]) || value;

  const LANGUAGES = [
    ['en', 'English', 'English'],
    ['es', 'Español', 'Spanish'],
    ['zh', '简体中文', 'Chinese (Simplified)'],
    ['ja', '日本語', 'Japanese'],
    ['pt', 'Português', 'Portuguese'],
    ['ru', 'Русский', 'Russian'],
    ['de', 'Deutsch', 'German'],
    ['ar', 'العربية', 'Arabic'],
  ];

  /* ── The mouse trigger's grammar ──────────────────────────────────────────
     Ported from src/constants/mouseTrigger.ts. A binding is a button plus the
     modifiers held with it, written as one string: `middle`, `Ctrl+left`,
     `Alt+Shift+x2`. Left and right are refused bare - they are how Windows
     clicks everything - and are click-only even with a modifier. */

  const MOUSE_LABELS = { middle: 'Wheel', x1: 'Mouse 4', x2: 'Mouse 5', left: 'Left', right: 'Right' };
  const BUTTON_BY_CODE = { 0: 'left', 1: 'middle', 2: 'right', 3: 'x1', 4: 'x2' };
  const MODIFIER_ALIASES = {
    ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
    super: 'meta', win: 'meta', windows: 'meta', meta: 'meta', cmd: 'meta',
  };
  const BUTTON_ALIASES = {
    middle: 'middle', wheel: 'middle', mouse3: 'middle',
    x1: 'x1', mouse4: 'x1', xbutton1: 'x1', back: 'x1',
    x2: 'x2', mouse5: 'x2', xbutton2: 'x2', forward: 'x2',
    left: 'left', mouse1: 'left', leftclick: 'left',
    right: 'right', mouse2: 'right', rightclick: 'right',
  };
  const NEEDS_MODIFIER = new Set(['left', 'right']);

  function rejectTrigger(trigger) {
    if (!NEEDS_MODIFIER.has(trigger.button)) return null;
    if (trigger.ctrl || trigger.alt || trigger.shift || trigger.meta) return null;
    return trigger.button === 'left'
      ? 'The left button on its own is how Windows clicks everything. Hold Ctrl, Alt, Shift or Win and click again.'
      : 'The right button on its own is every context menu in Windows. Hold Ctrl, Alt, Shift or Win and click again.';
  }

  function parseTrigger(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return null;
    const trigger = { button: 'middle', ctrl: false, alt: false, shift: false, meta: false };
    let button = null;
    for (const part of parts) {
      const modifier = MODIFIER_ALIASES[part];
      if (modifier) { trigger[modifier] = true; continue; }
      const named = BUTTON_ALIASES[part];
      if (!named || button) return null;
      button = named;
    }
    if (!button) return null;
    trigger.button = button;
    return rejectTrigger(trigger) ? null : trigger;
  }

  function formatTrigger(trigger) {
    const parts = [];
    if (trigger.ctrl) parts.push('Ctrl');
    if (trigger.alt) parts.push('Alt');
    if (trigger.shift) parts.push('Shift');
    if (trigger.meta) parts.push('Super');
    parts.push(trigger.button);
    return parts.join('+');
  }

  const triggerOrDefault = (value) => parseTrigger(value) || parseTrigger('middle');
  const allowsHold = (value) => !NEEDS_MODIFIER.has(triggerOrDefault(value).button);

  function triggerFromEvent(event) {
    const button = BUTTON_BY_CODE[event.button];
    if (!button) return null;
    return { button, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
  }

  function triggerChips(value) {
    const trigger = triggerOrDefault(value);
    const chips = [];
    if (trigger.ctrl) chips.push('Ctrl');
    if (trigger.alt) chips.push('Alt');
    if (trigger.shift) chips.push('Shift');
    if (trigger.meta) chips.push('Win');
    chips.push(MOUSE_LABELS[trigger.button]);
    return chips;
  }

  /* ── State ──────────────────────────────────────────────────────────────
     Seeded from the real config so the panel opens on what is actually set. */
  const S = {
    language: 'en',
    openAtLogin: true,

    enableKeyboardTrigger: LOOK.keyboardTrigger !== false,
    globalShortcut: LOOK.globalShortcut || 'Alt+Z',
    shortcutTriggerMode: LOOK.shortcutMode === 'hold' ? 'hold' : 'toggle',
    enableMouseTrigger: LOOK.mouseTrigger === true,
    mouseTriggerButton: formatTrigger(triggerOrDefault(LOOK.mouseButton)),
    mouseTriggerMode: LOOK.mouseMode === 'hold' && allowsHold(LOOK.mouseButton) ? 'hold' : 'click',
    radialMonitor: LOOK.radialMonitor === 'cursor' ? 'cursor' : 'primary',
    activationThreshold: LOOK.activationThreshold ?? 60,

    appearanceTheme: LOOK.theme === 'white' ? 'white' : 'black',
    menuRadius: LOOK.menuRadius ?? 140,
    iconSize: LOOK.iconSize ?? 64,
    appSpacing: LOOK.appSpacing ?? 10,
    radialHoverColor: LOOK.hoverColor || '#FFFFFF',
    radialSelectionMode: LOOK.selectionMode === 'cursor' ? 'cursor' : 'area',
    radialAreaWedges: LOOK.areaWedges === true,
    alwaysShowAppLabels: LOOK.alwaysShowLabels === true,
    showWorkspacePill: LOOK.showPill !== false,
    radialPlacement: LOOK.placement === 'cursor' ? 'cursor' : 'center',
    backdropOpacity: LOOK.backdropOpacity ?? 0.9,
    shortcutDock: false,
    shortcutDockPosition: 'bottom-left',
    shortcutDockIconSize: 40,
    shortcutDockGap: 12,
    shortcutDockLabels: false,
    statusDock: false,
    statusDockPosition: 'bottom-right',
    statusDockIconSize: 18,
    statusDockGap: 10,
    statusDockVolume: true,
    statusDockNetwork: true,
    statusDockBattery: true,
    statusDockClock: true,

    gameMode: false,
    gameScope: 'list',
    gameAutoDetect: false,
    radialInstantActivate: LOOK.handsFree ? 'dwell' : 'off',
    radialInstantSensitivity: LOOK.handsFreeSensitivity || 'medium',
    radialInstantDwellMs: LOOK.handsFreeDwellMs ?? 400,
    radialNumberLaunch: false,
    radialNumberLabels: true,
    radialBackKey: 'Q',
    showSettingsCorner: true,
    settingsCorner: 'top-right',

    /* Where the app's panel opens. */
    section: 'spaces',
  };

  /* The sound keys live in `sound.js`, not here: the page has ONE copy of them,
     shared with the wheel at the top. Read and written through `get`/`put`. */
  const SOUND_KEYS = new Set([
    'radialSounds', 'radialSoundVolume',
    'radialOpenSound', 'radialOpenSoundId', 'radialHoverSound', 'radialHoverSoundId',
  ]);
  const soundState = SOUND ? SOUND.settings : {
    radialSounds: true, radialSoundVolume: 100,
    radialOpenSound: true, radialOpenSoundId: 'sub-tick', radialHoverSound: true, radialHoverSoundId: 'thump',
  };
  const get = (key) => (SOUND_KEYS.has(key) ? soundState[key] : S[key]);
  /** Set by the panel's own sound writes, so the echo back from `sound.js` is not a second render. */
  let writingSound = false;
  function put(key, value) {
    if (!SOUND_KEYS.has(key)) {
      S[key] = value;
      return;
    }
    writingSound = true;
    if (SOUND) SOUND.set({ [key]: value });
    else soundState[key] = value;
    writingSound = false;
  }

  /* ── Defaults ───────────────────────────────────────────────────────────
     What `DEFAULT_UI_CONFIG` holds for the keys the panel offers a revert on.
     Only these: the app derives the revert from `configKey`, and a row without one
     (the shortcut, Fullscreen protection, the docks' own rows) is
     never offered it. One rule for every row, so a row that stops matching cannot
     go on claiming it is at its default. */
  const DEFAULTS = {
    openAtLogin: true,
    language: 'en',
    enableKeyboardTrigger: true,
    shortcutTriggerMode: 'toggle',
    enableMouseTrigger: true,
    mouseTriggerButton: 'middle',
    mouseTriggerMode: 'click',
    radialMonitor: 'primary',
    activationThreshold: 60,
    radialSounds: true,
    radialSoundVolume: 100,
    radialOpenSound: true,
    radialOpenSoundId: 'sub-tick',
    radialHoverSound: true,
    radialHoverSoundId: 'thump',
    appearanceTheme: 'black',
    menuRadius: 140,
    iconSize: 64,
    appSpacing: 10,
    radialHoverColor: '#FFFFFF',
    radialSelectionMode: 'area',
    radialAreaWedges: false,
    alwaysShowAppLabels: false,
    showWorkspacePill: true,
    radialPlacement: 'center',
    backdropOpacity: 0.9,
    statusDock: false,
    radialInstantActivate: 'off',
    radialInstantSensitivity: 'medium',
    radialInstantDwellMs: 400,
    radialNumberLaunch: false,
    radialNumberLabels: true,
    radialBackKey: 'Q',
    showSettingsCorner: true,
    settingsCorner: 'top-right',
  };

  /* In the app's order, with the app's glyphs: SquareStack, Mouse, Volume2,
     Shield, Palette, Settings. */
  const SECTIONS = [
    { id: 'spaces', label: 'Workspaces', icon: 'i-stack', caption: 'Contexts and their shortcuts.' },
    { id: 'trigger', label: 'Activation', icon: 'i-mouse', caption: 'How and where the wheel appears.' },
    { id: 'sound', label: 'Sound', icon: 'i-volume', caption: 'Notes for opening and moving around the wheel.' },
    { id: 'advanced', label: 'Advanced', icon: 'i-shield', caption: 'Protection, shortcuts, and data.' },
    { id: 'appearance', label: 'Appearance', icon: 'i-palette', caption: 'Shape, presence, and theme.' },
    { id: 'general', label: 'General', icon: 'i-cog', caption: 'Core Rovyl behavior.' },
  ];

  /* ── Rows ───────────────────────────────────────────────────────────────
     Built per render, because several of them only exist while the feature
     above them is on - a control that stays on screen controlling nothing is
     worse than one that is not offered. */

  const px = (v) => `${Math.round(v)} px`;
  const soundName = (id) => {
    const found = SOUND && SOUND.SOUNDS.find((sound) => sound.id === id);
    return found ? found.name : id;
  };
  const resolveSounds = () => (SOUND ? SOUND.resolve() : { open: null, hover: null });
  const previewSound = (id) => { if (SOUND && id) SOUND.preview(id); };

  /**
   * Turning off the last trigger would leave no way in, so the other one comes on in
   * the same change - the pair behaves like a choice of route rather than two switches
   * that can both be down. The press is never refused; it is answered.
   */
  function toggleTrigger(key) {
    const other = key === 'enableKeyboardTrigger' ? 'enableMouseTrigger' : 'enableKeyboardTrigger';
    if (S[key] && !S[other]) {
      S[key] = false;
      S[other] = true;
      showToast(key === 'enableKeyboardTrigger' ? 'Switched to the mouse trigger' : 'Switched to the keyboard trigger');
      render();
      return;
    }
    set(key, !S[key]);
  }

  function rowsFor(id) {
    /* One unnamed group: three rows under three headings was a heading per row,
       which labels nothing the row's own title does not already say. */
    if (id === 'general') return [
      { group: '', title: 'Start with Windows', desc: 'Rovyl is ready as soon as you sign in to Windows.',
        kind: 'bool', key: 'openAtLogin' },
      /* A select, not the segmented control this was while it held two languages:
         seven buttons are wider than the control column and would wrap into a block
         of chips no eye can scan. */
      { group: '', title: 'Language', desc: 'Choose interface display language.',
        kind: 'select', key: 'language', choices: LANGUAGES },
      { group: '', title: 'Check for updates', desc: 'Rovyl checks automatically a few seconds after launch.',
        kind: 'action', label: 'Check now', icon: 'i-refresh' },
      { group: '', title: 'GitHub', desc: 'Source code, releases, and issues.',
        kind: 'action', label: 'Open', icon: 'i-github', href: 'https://github.com/arshit09/rovyl' },
    ];

    /* Each way in is a switch that owns its own settings, and the settings only
       exist while the switch is on. Position is about the wheel once it is open,
       however it got there, so it stays put. */
    if (id === 'trigger') return [
      { group: 'Keyboard', title: 'Enable keyboard trigger', desc: 'Open the wheel with a keyboard shortcut.',
        kind: 'bool', key: 'enableKeyboardTrigger', toggle: () => toggleTrigger('enableKeyboardTrigger') },
      ...(S.enableKeyboardTrigger ? [
        { group: 'Keyboard', title: 'Global shortcut', desc: 'Open the wheel over any application.',
          kind: 'open', value: S.globalShortcut },
        /* A dropdown, because "Toggle" and "Hold" mean nothing without saying what
           they do: the label names the mode, and the sentence waits behind each
           option's help mark. */
        { group: 'Keyboard', title: 'Shortcut behavior', desc: 'How the global keyboard shortcut activates the menu.',
          kind: 'select', key: 'shortcutTriggerMode', choices: [
            ['toggle', 'Toggle', '', 'Press the shortcut once to open the wheel, and again to close it.'],
            ['hold', 'Hold', '', 'Hold the shortcut to keep the wheel up, and release it to launch whatever you are aiming at.'],
          ] },
      ] : []),
      { group: 'Mouse', title: 'Enable mouse trigger', desc: 'Open the wheel with a mouse button.',
        kind: 'bool', key: 'enableMouseTrigger', toggle: () => toggleTrigger('enableMouseTrigger') },
      ...(S.enableMouseTrigger ? [
        { group: 'Mouse', title: 'Trigger button',
          desc: allowsHold(S.mouseTriggerButton)
            ? 'Press Record, then press the button you want. Side buttons are usually free; left and right need Ctrl, Alt, Shift or Win held with them.'
            : 'Press Record, then press the button you want. Left and right always open the wheel on the click - holding one down is a drag everywhere else in Windows, so there is no gesture to choose.',
          kind: 'mouse', key: 'mouseTriggerButton' },
        /* Only where there is a gesture to choose. */
        ...(allowsHold(S.mouseTriggerButton) ? [
          { group: 'Mouse', title: 'Gesture behavior', desc: 'Click keeps the wheel open; hold runs the selection on release.',
            kind: 'seg', key: 'mouseTriggerMode', choices: [['click', 'Click'], ['hold', 'Hold']] },
        ] : []),
      ] : []),
      { group: 'Position', title: 'Monitor',
        desc: S.radialPlacement === 'cursor'
          ? 'Appearance opens the wheel under the pointer, so it is already on the screen the pointer is on - this choice has nothing left to decide.'
          : S.radialMonitor === 'cursor'
            ? 'The wheel opens on the screen the pointer is already on, so what you launch lands where you are working.'
            : 'The wheel always opens on the main screen, wherever the pointer happens to be.',
        kind: 'seg', key: 'radialMonitor', choices: [['primary', 'Main screen'], ['cursor', 'Follow pointer']] },
      { group: 'Position', title: 'Activation zone', desc: 'Cursor distance required to confirm a target.',
        kind: 'range', key: 'activationThreshold', min: 20, max: 120, step: 1, format: px },
    ];

    /* One unnamed group, as in General: under a section already called Sound, a
       "Sound" heading labels nothing. Everything under the master switch is
       withdrawn rather than disabled while it is off. */
    if (id === 'sound') {
      const on = get('radialSounds') !== false;
      const openOn = get('radialOpenSound') !== false;
      const hoverOn = get('radialHoverSound') !== false;
      const openId = SOUND ? SOUND.normalize(get('radialOpenSoundId'), 'sub-tick') : 'sub-tick';
      const hoverId = SOUND ? SOUND.normalize(get('radialHoverSoundId'), 'thump') : 'thump';
      const choices = SOUND ? SOUND.SOUNDS.map((sound) => [sound.id, sound.name]) : [];
      const sounds = resolveSounds();
      const tryDesc = sounds.open && sounds.hover
        ? `Move around the wheel: items play ${soundName(sounds.hover)}, and aiming back at the center plays ${soundName(sounds.open)}. Click the wheel to open it again.`
        : sounds.hover
          ? `Move around the wheel to hear ${soundName(sounds.hover)} on every item.`
          : `Aim out and back at the center, or click the wheel to open it again, to hear ${soundName(openId)}.`;

      return [
        { group: '', title: 'Sound effects', desc: 'Short bass notes as the wheel opens and as you move between items.',
          kind: 'bool', key: 'radialSounds',
          /* Turning it on plays the note once, so the switch answers with the thing it switched on. */
          toggle: () => {
            set('radialSounds', !on);
            if (!on) { const next = resolveSounds(); previewSound(next.open || next.hover); }
          } },
        ...(on ? [
          /* First, straight under the switch: turning sound on is a request to hear it,
             so the wheel that plays it is the answer, and the rows below tune it. */
          ...(openOn || hoverOn ? [
            { group: '', title: 'Try it', desc: tryDesc, kind: 'widget', build: tryWheel },
          ] : []),
          /* One level for both notes. Every dot the thumb lands on plays the hover
             note, the one heard most, at that level, so the drag is heard as it goes.
             The drag moves in tens, one dot each; the readout takes a typed number for
             anything in between. */
          ...(openOn || hoverOn ? [
            { group: '', title: 'Volume', desc: 'How loud both sounds play. Windows volume still applies on top.',
              kind: 'range', key: 'radialSoundVolume', min: 0, max: 100, step: 10, ticks: true, unit: '%',
              format: (v) => `${Math.round(v)}%`,
              heard: () => previewSound(sounds.hover || sounds.open || hoverId) },
          ] : []),
          { group: '', title: 'When the wheel opens',
            desc: 'One note as the wheel blooms open, and again when you aim back at the center.',
            kind: 'bool', key: 'radialOpenSound',
            toggle: () => { set('radialOpenSound', !openOn); if (!openOn) previewSound(openId); } },
          ...(openOn ? [
            { group: '', title: 'Opening sound', desc: 'Press play beside a name to hear it before choosing.',
              kind: 'select', key: 'radialOpenSoundId', choices, preview: previewSound },
          ] : []),
          { group: '', title: 'When moving between items',
            desc: 'A note each time the highlight moves to a different item.',
            kind: 'bool', key: 'radialHoverSound',
            toggle: () => { set('radialHoverSound', !hoverOn); if (!hoverOn) previewSound(hoverId); } },
          ...(hoverOn ? [
            { group: '', title: 'Hover sound', desc: 'Press play beside a name to hear it before choosing.',
              kind: 'select', key: 'radialHoverSoundId', choices, preview: previewSound },
          ] : []),
        ] : []),
      ];
    }

    if (id === 'appearance') {
      const statusActive = S.statusDock
        && (S.statusDockClock || S.statusDockBattery || S.statusDockNetwork || S.statusDockVolume);
      return [
        { kind: 'preview' },
        { group: 'Theme', title: 'Rovyl surfaces', desc: 'Applies to the window and title bar. The wheel remains dark.',
          kind: 'seg', key: 'appearanceTheme', choices: [['black', 'Black'], ['white', 'White']] },
        { group: 'Wheel', title: 'Orbital radius', desc: 'Perceived wheel diameter.',
          kind: 'range', key: 'menuRadius', min: 90, max: RADIUS_MAX, step: 1, format: px },
        { group: 'Wheel', title: 'Icon size', desc: 'Visual weight of each target.',
          kind: 'range', key: 'iconSize', min: 36, max: 92, step: 1, format: px },
        { group: 'Wheel', title: 'Target spacing', desc: 'Free space between items.',
          kind: 'range', key: 'appSpacing', min: 0, max: 40, step: 1, format: px },
        { group: 'Wheel', title: 'Hover color', desc: 'Color used by the target under the pointer.',
          kind: 'color', key: 'radialHoverColor' },
        /* Two choices, because there were never three: "Direction" was this same
           targeting with the wedges unpainted, so it became the switch below. */
        { group: 'Wheel', title: 'Targeting',
          desc: S.radialSelectionMode === 'cursor'
            ? S.radialInstantActivate === 'dwell'
              ? 'Launch without clicking hides the pointer and aims by direction, so while it is on every shortcut owns an equal share of the screen regardless of this.'
              : 'Only the icon under the pointer highlights. Release away from every icon to cancel.'
            : S.radialAreaWedges
              ? 'The wheel is cut into equal wedges - one per shortcut - and the one you point at fills up. Click anywhere inside it.'
              : 'Every shortcut owns an equal share of the screen: point toward one and it highlights from anywhere. Click anywhere in its share.',
          kind: 'seg', key: 'radialSelectionMode', choices: [['area', 'Area'], ['cursor', 'Pointer']] },
        ...(S.radialSelectionMode !== 'cursor' ? [
          { group: 'Wheel', title: 'Visible wedges',
            desc: 'Draws the seams between the shares and fills the one you are aiming at with the hover color. Off, the aim is identical and only the icon lights up.',
            kind: 'bool', key: 'radialAreaWedges' },
        ] : []),
        { group: 'Wheel', title: 'Persistent labels', desc: 'Keep every target name visible.',
          kind: 'bool', key: 'alwaysShowAppLabels' },
        { group: 'Wheel', title: 'Workspace name', desc: 'Show the pill under the wheel with the current workspace and folder.',
          kind: 'bool', key: 'showWorkspacePill' },
        { group: 'Position', title: 'Where it opens',
          desc: S.radialPlacement === 'cursor'
            ? 'The wheel blooms under the pointer, so nothing is further away than the gesture that opened it. Near an edge it steps inward just enough to keep every target on screen.'
            : 'The wheel always blooms at the middle of the screen, wherever the pointer happens to be.',
          kind: 'seg', key: 'radialPlacement', choices: [['center', 'Screen center'], ['cursor', 'At pointer']] },
        { group: 'Presence', title: 'Background dimming',
          desc: 'How much the rest of the screen recedes. At 100% it goes: the desktop is covered edge to edge.',
          kind: 'range', key: 'backdropOpacity', min: 0, max: 1, step: 0.01,
          format: (v) => `${Math.round(v * 100)}%` },
        /* The docks, in the order they are met: the one you fill yourself first, the
           one that reads the machine second. */
        { group: 'Shortcut dock', title: 'Shortcut dock',
          desc: 'A strip of your own icons beside the open wheel - Chrome, Steam, a project folder, anything. Nothing is drawn until you add some.',
          kind: 'bool', key: 'shortcutDock' },
        ...(S.shortcutDock ? [
          { group: 'Shortcut dock', title: 'Icons', desc: '0 icons in the dock.',
            kind: 'open', value: 'Add icons' },
          { group: 'Shortcut dock', title: 'Where it sits',
            desc: 'Pick the corner or edge on the screen below. The wheel opens over the whole screen while a dock is on - everything but the taskbar - so the corner is a real one.',
            kind: 'dock', key: 'shortcutDockPosition',
            occupied: statusActive ? { position: S.statusDockPosition, label: 'System dock' } : null },
          { group: 'Shortcut dock', title: 'Icon size', desc: 'How big each icon is drawn.',
            kind: 'range', key: 'shortcutDockIconSize', min: 24, max: 88, step: 1, format: px },
          { group: 'Shortcut dock', title: 'Spacing', desc: 'The gap between neighbouring icons.',
            kind: 'range', key: 'shortcutDockGap', min: 0, max: 48, step: 1, format: px },
          { group: 'Shortcut dock', title: 'Names under the icons',
            desc: 'Off by default: a strip of eight names is a menu, and the wheel is already that.',
            kind: 'bool', key: 'shortcutDockLabels' },
        ] : []),
        { group: 'System dock', title: 'System dock',
          desc: 'Time, battery, network and volume, read live, beside the open wheel. The volume slider and the mute button work from here.',
          kind: 'bool', key: 'statusDock' },
        ...(S.statusDock ? [
          /* The shortcut dock only takes a corner once it holds icons, and this one holds none. */
          { group: 'System dock', title: 'Where it sits', desc: 'Pick the corner or edge on the screen below.',
            kind: 'dock', key: 'statusDockPosition', occupied: null },
          { group: 'System dock', title: 'Icon size', desc: 'How big the glyphs are drawn. The readouts beside them are set to match.',
            kind: 'range', key: 'statusDockIconSize', min: 12, max: 32, step: 1, format: px },
          { group: 'System dock', title: 'Spacing', desc: 'The gap between neighbouring readouts.',
            kind: 'range', key: 'statusDockGap', min: 0, max: 48, step: 1, format: px },
          { group: 'System dock', title: 'Volume', desc: 'Output level, with a slider you can drag. Click the glyph to mute.',
            kind: 'bool', key: 'statusDockVolume' },
          { group: 'System dock', title: 'Network', desc: 'Wi-Fi signal, or a wired connection. Click it for the Windows network panel.',
            kind: 'bool', key: 'statusDockNetwork' },
          { group: 'System dock', title: 'Battery', desc: 'Charge level, and whether it is on the charger. Nothing is drawn on a machine with no battery.',
            kind: 'bool', key: 'statusDockBattery' },
          { group: 'System dock', title: 'Clock', desc: 'The time, with the date under it.',
            kind: 'bool', key: 'statusDockClock' },
        ] : []),
      ];
    }

    if (id === 'spaces') return [{ kind: 'spaces' }];

    const numberLaunch = S.radialNumberLaunch;
    return [
      { group: 'Protection', title: 'Fullscreen protection', desc: 'Prevent accidental openings during games and videos.',
        kind: 'bool', key: 'gameMode' },
      ...(S.gameMode ? [
        { group: 'Protection', title: 'Scope', desc: 'All fullscreen apps or only a selected list.',
          kind: 'seg', key: 'gameScope', choices: [['all', 'All'], ['list', 'List']] },
      ] : []),
      ...(S.gameMode && S.gameScope === 'list' ? [
        { group: 'Protection', title: 'Detect games automatically',
          desc: 'Uses game-store folders and engine files; protection still applies only in fullscreen.',
          kind: 'bool', key: 'gameAutoDetect' },
        { group: 'Protection', title: 'Protected applications',
          desc: 'Choose installed applications visually. No executable names required.',
          kind: 'open', value: 'Choose apps' },
      ] : []),
      /* It lives here and not in Appearance: this decides how the wheel is DRIVEN -
         it hides the pointer and trades aiming by position for aiming by direction. */
      { group: 'Hands-free', title: 'Launch without clicking',
        desc: 'Hides the pointer and picks by direction - move toward a target and it opens by itself. Escape closes the wheel without opening anything.',
        kind: 'bool', key: 'radialInstantActivate', on: 'dwell', off: 'off' },
      ...(S.radialInstantActivate === 'dwell' ? [
        { group: 'Hands-free', title: 'Direction sensitivity',
          desc: 'How far your hand must travel before that direction is chosen. High picks on the smallest movement.',
          kind: 'seg', key: 'radialInstantSensitivity', choices: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
        { group: 'Hands-free', title: 'Hover time',
          desc: 'How long a target must stay aimed before it opens. Drag to zero and the direction opens the moment it commits.',
          kind: 'range', key: 'radialInstantDwellMs', min: 0, max: 1200, step: 20,
          format: (v) => (Math.round(v) === 0 ? 'Instant' : `${Math.round(v)} ms`) },
      ] : []),
      { group: 'Number keys', title: 'Quick launch with number keys',
        desc: numberLaunch
          ? 'Press 1–9 to run the shortcut in that position - no Enter. The digits are the wheel’s now, so a workspace still on its default number key cannot be reached; give it a letter instead.'
          : 'Press 1–9 to run the shortcut in that position, counting clockwise from the top - no Enter, no aiming. It takes the number keys away from workspaces still using them, and turns on the key that steps back out of a folder.',
        kind: 'bool', key: 'radialNumberLaunch' },
      ...(numberLaunch ? [
        { group: 'Number keys', title: 'Show numbers on the wheel',
          desc: 'Draws each position’s digit on its icon. Turn it off once the wheel is in your hands - the keys go on working.',
          kind: 'bool', key: 'radialNumberLabels' },
        { group: 'Number keys', title: 'Key to leave a folder',
          desc: `Press ${S.radialBackKey} inside a folder to step back out, the same as clicking the hub. At the top level it stays an ordinary letter, so searching is unaffected.`,
          kind: 'open', value: S.radialBackKey },
      ] : []),
      { group: 'Settings shortcut', title: 'Settings button on the wheel',
        desc: S.radialInstantActivate === 'dwell'
          ? 'A gear in the corner of the open wheel, one click from these settings. Launch without clicking aims by direction and hides the pointer, so the gear stays off while that is on.'
          : 'A gear in the corner of the open wheel, one click from these settings. The wheel then opens over the whole screen instead of a box around itself, so the corner is a real one.',
        kind: 'bool', key: 'showSettingsCorner' },
      ...(S.showSettingsCorner ? [
        { group: 'Settings shortcut', title: 'Which corner',
          desc: 'Where the gear sits. It steps inboard if the battery or weather pill is already there.',
          kind: 'select', key: 'settingsCorner', choices: [
            ['top-right', 'Top right'], ['top-left', 'Top left'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'],
          ] },
      ] : []),
      { group: 'Data', title: 'Export settings', desc: 'Save a portable copy of your configuration.',
        kind: 'action', label: 'Export', icon: 'i-up' },
      { group: 'Data', title: 'Import settings', kind: 'action', label: 'Import', icon: 'i-down' },
      { group: 'Data', title: 'Restore defaults', desc: 'Erase local settings and start over.',
        kind: 'action', label: 'Restore', key: 'reset',
        confirm: {
          body: 'Every workspace, shortcut, icon and preference on this PC is deleted and Rovyl restarts. This cannot be undone - use Export settings first if you want a copy.',
          cta: 'Erase everything',
        } },
    ];
  }

  /* ── Building blocks ────────────────────────────────────────────────────
     The same controls the app declares: bool, segmented, range, select,
     value-open, action, and the three that are pictures rather than values -
     the mouse recorder, the dock picker, the practice wheel. */

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const glyph = (id, cls) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls || 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  };

  function set(key, value) {
    put(key, value);
    render();
  }

  function control(row) {
    if (row.kind === 'bool') {
      const onValue = row.on !== undefined ? row.on : true;
      const offValue = row.off !== undefined ? row.off : false;
      const isOn = get(row.key) === onValue;
      const button = el('button', `toggle${isOn ? ' is-on' : ''}`);
      button.type = 'button';
      button.setAttribute('role', 'switch');
      button.setAttribute('aria-checked', String(isOn));
      button.setAttribute('aria-label', tr(row.title));
      button.addEventListener('click', () => (row.toggle ? row.toggle() : set(row.key, isOn ? offValue : onValue)));
      return button;
    }

    if (row.kind === 'seg') {
      const wrap = el('div', 'seg');
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', tr(row.title));
      for (const [value, label] of row.choices) {
        const option = el('button', get(row.key) === value ? 'is-on' : '', tr(label));
        option.type = 'button';
        option.addEventListener('click', () => set(row.key, value));
        wrap.append(option);
      }
      return wrap;
    }

    if (row.kind === 'select') return selectControl(row);
    if (row.kind === 'color') return colorControl(row);
    if (row.kind === 'mouse') return mouseControl(row);

    /* A value that opens an editor of its own - the shortcut recorder. The value
       reads as the row's answer and the chevron says there is more behind it; the
       whole row is the hit target, which is what `.is-openable` marks. */
    if (row.kind === 'open') {
      const button = el('button', 'btn is-value');
      button.type = 'button';
      button.setAttribute('aria-label', tr(row.title));
      button.append(el('b', '', row.value), glyph('i-chevron'));
      button.addEventListener('click', () => flash(button));
      return button;
    }

    if (row.kind === 'action') {
      const button = el('button', 'btn', tr(row.label));
      button.type = 'button';
      if (row.icon) button.prepend(glyph(row.icon));
      /* Deliberately inert: this is a tour of the panel, not a copy of the app
         that could write to anything. The one exception only leaves the page -
         GitHub, which is where the app's row goes too. */
      button.addEventListener('click', () => {
        if (row.href) window.open(row.href, '_blank', 'noopener');
        else if (row.confirm) askAgain(row);
        else flash(button);
      });
      return button;
    }

    return null;
  }

  /* ── Color ──────────────────────────────────────────────────────────────
     A swatch that opens the system palette and a hex field beside it, as in
     `ColorSettingControl`. */
  const normalizeHex = (value) => {
    const hex = String(value || '').trim().replace(/^#/, '');
    return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
  };

  function colorControl(row) {
    const value = normalizeHex(get(row.key)) || '#FFFFFF';
    const wrap = el('div', 'color-control');
    const swatch = el('label', 'color-swatch');
    swatch.title = 'Open color palette';
    const chip = el('span');
    chip.style.backgroundColor = value;
    const picker = el('input');
    picker.type = 'color';
    picker.value = value.toLowerCase();
    picker.setAttribute('aria-label', tr(row.title));
    picker.addEventListener('input', () => {
      const next = normalizeHex(picker.value);
      if (!next) return;
      put(row.key, next);
      chip.style.backgroundColor = next;
      hex.value = next.slice(1);
      paintPreview();
    });
    picker.addEventListener('change', render);
    swatch.append(chip, picker);

    const hex = el('input', 'color-hex');
    hex.value = value.slice(1);
    hex.maxLength = 6;
    hex.spellcheck = false;
    hex.setAttribute('aria-label', 'Hex color');
    /* Only a field that actually took a colour re-renders when it is left: a blur is
       also the mousedown on the next control, and a render would eat its click. */
    let took = false;
    hex.addEventListener('input', () => {
      hex.value = hex.value.replace(/^#/, '').replace(/[^0-9a-f]/gi, '').slice(0, 6);
      const next = normalizeHex(hex.value);
      if (!next) return;
      put(row.key, next);
      took = true;
      chip.style.backgroundColor = next;
      paintPreview();
    });
    hex.addEventListener('blur', () => {
      if (took) render();
      else hex.value = (normalizeHex(get(row.key)) || '#FFFFFF').slice(1);
    });
    hex.addEventListener('keydown', (event) => { if (event.key === 'Enter') hex.blur(); });

    wrap.append(swatch, el('span', 'color-prefix', '#'), hex);
    return wrap;
  }

  /* ── Select ─────────────────────────────────────────────────────────────
     The app's own listbox rather than a native `<select>`, and the reason is the
     reason it is not one there either: Chromium draws that popup from the OS theme,
     so it arrives as a grey Windows listbox in the middle of a panel that controls
     every other pixel of itself.

     Replacing it means owing back what the platform was doing unpaid - arrow keys,
     Home/End, type-ahead, Escape cancelling against Tab committing, focus back on
     the trigger, the active option kept in view. For anyone not using a mouse those
     are not embellishments on a dropdown, they ARE the dropdown. See
     `SelectSettingControl`.

     Two extras ride on it, as in the app. A list of sounds puts a play button on
     every option, and the arrows play what they land on. An option whose label
     means nothing alone - Toggle, Hold - carries a help mark that opens its
     sentence in a bubble. */

  /* Mirrors the CSS, and has to be kept in step with it by hand. These numbers only
     decide whether the popup flips, so drift shows up as a list that opens downward
     into a space it does not quite fit, never as a broken layout. */
  const MENU_ROW = 32;
  const MENU_PAD = 8;
  const MENU_MAX = 320;
  const MENU_MIN_W = 208;
  const MENU_GAP = 6;
  const MENU_MARGIN = 8;
  /* `.sel-tip`'s width - the bubble is measured for its height before it is placed. */
  const TIP_WIDTH = 240;

  /** The one open listbox, so a click elsewhere - or a re-render - can close it. */
  let openSelect = null;

  function closeSelect(returnFocus) {
    if (!openSelect) return;
    const { list, shade, trigger, tip } = openSelect;
    openSelect = null;
    list.remove();
    shade.remove();
    tip.remove();
    trigger.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus({ preventScroll: true });
  }

  /* Down unless down does not fit and up fits better - "better", not "at all",
     because a window short enough to squeeze both should still take the roomier
     side. Measured against `.win`, which is also what the list is painted on: the
     row itself sits in a scroller that would clip the list the moment it was taller
     than the space beneath it. */
  function place(trigger, count) {
    const rect = trigger.getBoundingClientRect();
    const box = win.getBoundingClientRect();
    const height = Math.min(count * MENU_ROW + MENU_PAD, MENU_MAX);
    const width = Math.max(rect.width, MENU_MIN_W);
    const below = box.bottom - rect.bottom - (MENU_GAP + MENU_MARGIN);
    const above = rect.top - box.top - (MENU_GAP + MENU_MARGIN);
    const down = below >= height || below >= above;
    const minLeft = box.left + MENU_MARGIN;
    const left = Math.min(
      Math.max(minLeft, rect.right - width),
      Math.max(minLeft, box.right - width - MENU_MARGIN),
    );
    const top = down
      ? rect.bottom + MENU_GAP
      : Math.max(box.top + MENU_MARGIN, rect.top - MENU_GAP - height);
    return { left: left - box.left, top: top - box.top, width, down };
  }

  /* `helpTipPlacement`: under the mark it belongs to, centred on it, dropped from
     the popup's foot so it never covers an option - and flipped above when there
     is no room below. */
  function placeTip(icon, list, height) {
    const box = win.getBoundingClientRect();
    const anchor = icon.getBoundingClientRect();
    const span = list.getBoundingClientRect();
    const minLeft = box.left + MENU_MARGIN;
    const maxLeft = box.left + box.width - MENU_MARGIN - TIP_WIDTH;
    const left = Math.max(minLeft, Math.min((anchor.left + anchor.right) / 2 - TIP_WIDTH / 2, maxLeft));
    const below = span.bottom + MENU_GAP;
    const down = below + height <= box.bottom - MENU_MARGIN;
    const top = down ? below : Math.max(box.top + MENU_MARGIN, span.top - MENU_GAP - height);
    return { left: left - box.left, top: top - box.top };
  }

  function selectControl(row) {
    const wrap = el('span', 'sel');
    const choices = row.choices;
    const selectedIndex = Math.max(0, choices.findIndex(([value]) => value === get(row.key)));
    const chosen = choices[selectedIndex] || ['', ''];

    const trigger = el('button', 'sel-trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', tr(row.title));
    trigger.append(
      el('span', '', chosen[2] && chosen[2] !== chosen[1] ? tr(chosen[1]) + ' · ' + tr(chosen[2]) : tr(chosen[1])),
      glyph('i-chevron'),
    );
    wrap.append(trigger);

    /** Which option the keyboard is ON, which is not which option is CHOSEN. Arrowing
        must not commit: on the Language row that would retranslate the whole panel
        five times on the way down to Deutsch. */
    let active = selectedIndex;
    const options = [];
    const helpMarks = [];
    const typed = { buffer: '', at: 0 };

    const shade = el('div', 'sel-shade');
    shade.setAttribute('role', 'presentation');
    shade.addEventListener('mousedown', () => closeSelect(false));

    const list = el('div', 'sel-list');
    list.id = row.key + '-listbox';
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    list.setAttribute('aria-label', tr(row.title));

    /* The help bubble. `pointer-events: none` in the stylesheet: it appears under a
       pointer already on its way to a click, and must not be what receives it. */
    const tip = el('div', 'sel-tip');
    tip.setAttribute('role', 'presentation');

    const showTip = (index) => {
      const help = index === null ? null : choices[index][3];
      if (!help || !helpMarks[index]) {
        tip.remove();
        return;
      }
      tip.textContent = help;
      tip.style.visibility = 'hidden';
      win.append(tip);
      const at = placeTip(helpMarks[index], list, tip.offsetHeight);
      tip.style.left = at.left + 'px';
      tip.style.top = at.top + 'px';
      tip.style.visibility = 'visible';
    };

    const paint = () => {
      options.forEach((node, i) => {
        node.classList.toggle('is-active', i === active);
        if (i === active) node.scrollIntoView({ block: 'nearest' });
      });
      list.setAttribute('aria-activedescendant', options[active] ? options[active].id : '');
    };

    /* The keyboard's play button, and its help mark: landing on an option by key
       plays it, or shows what it means. */
    const landed = () => {
      paint();
      if (row.preview) row.preview(choices[active][0]);
      showTip(choices[active][3] ? active : null);
    };

    const commit = (index) => {
      const value = choices[index][0];
      closeSelect(false);
      set(row.key, value);
      if (row.preview) row.preview(value);
    };

    choices.forEach(([value, label, hint, help], i) => {
      const option = el('div', 'sel-option');
      option.id = row.key + '-option-' + i;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(i === selectedIndex));
      if (help) option.setAttribute('aria-label', `${tr(label)}. ${tr(help)}`);
      /* A span, not a button: nothing focusable may live inside an option. */
      if (row.preview) {
        const play = el('span', 'sel-play');
        play.setAttribute('role', 'presentation');
        play.title = `Play ${tr(label)}`;
        play.append(glyph('i-play'));
        play.addEventListener('click', (event) => {
          event.stopPropagation();
          row.preview(value);
        });
        option.append(play);
      }
      option.append(el('b', '', tr(label)));
      if (hint && hint !== label) option.append(el('small', '', tr(hint)));
      if (help) {
        const mark = el('span', 'sel-help');
        mark.append(glyph('i-help'));
        mark.addEventListener('mouseenter', () => showTip(i));
        mark.addEventListener('mouseleave', () => showTip(null));
        helpMarks[i] = mark;
        option.append(mark);
      }
      /* Always drawn, invisible unless chosen: a check on one row only would put
         the help marks on two different columns. */
      option.append(glyph('i-check', i === selectedIndex ? 'ico' : 'ico is-blank'));
      /** Pointer moves the highlight; it does not move focus off the listbox. */
      option.addEventListener('mousemove', () => {
        if (active === i) return;
        active = i;
        paint();
      });
      option.addEventListener('click', () => commit(i));
      options.push(option);
      list.append(option);
    });

    /* Type-ahead: the affordance people use without knowing they use it. `d` jumps to
       Deutsch. A single character CYCLES, so the scan starts one past the current row;
       a longer buffer REFINES, so it includes it - `d`,`e` is still aiming at the
       Deutsch that `d` found. The buffer only accumulates while typing stays brisk.
       Endonym or English name alike: someone hunting for German may type either. */
    const jump = (key) => {
      const now = Date.now();
      typed.buffer = now - typed.at > 900 ? key : typed.buffer + key;
      typed.at = now;
      const query = typed.buffer.toLowerCase();
      const from = query.length === 1 ? active + 1 : active;
      for (let step = 0; step < choices.length; step += 1) {
        const i = (from + step) % choices.length;
        const [, label, hint] = choices[i];
        if (label.toLowerCase().startsWith(query) || (hint || '').toLowerCase().startsWith(query)) {
          active = i;
          landed();
          return;
        }
      }
    };

    list.addEventListener('keydown', (event) => {
      const step = (delta) => {
        event.preventDefault();
        const next = clamp(active + delta, 0, choices.length - 1);
        if (next === active) return;
        active = next;
        landed();
      };
      switch (event.key) {
        case 'ArrowDown': return step(1);
        case 'ArrowUp': return step(-1);
        case 'PageDown': return step(5);
        case 'PageUp': return step(-5);
        case 'Home': event.preventDefault(); active = 0; return landed();
        case 'End': event.preventDefault(); active = choices.length - 1; return landed();
        case 'Enter':
        case ' ':
          event.preventDefault();
          return commit(active);
        /** Stopped, or the page's own key handling hears an Escape meant for the list. */
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          return closeSelect(true);
        /** Tab commits everywhere else in this panel; leaving it a cancel here would surprise. */
        case 'Tab':
          return commit(active);
        default:
          if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            jump(event.key);
          }
      }
    });

    const open = () => {
      const at = place(trigger, choices.length);
      list.classList.toggle('is-up', !at.down);
      list.style.left = at.left + 'px';
      list.style.top = at.top + 'px';
      list.style.width = at.width + 'px';
      win.append(shade, list);
      trigger.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      openSelect = { list, shade, trigger, tip, count: choices.length };
      /** Every opening starts from what is selected, not from wherever the last visit
          was left. */
      active = selectedIndex;
      paint();
      list.focus({ preventScroll: true });
    };

    /* `mousedown`, not `click`, and the shade depends on it: on `click`, pressing the
       trigger to dismiss would close via the shade, unmount it, and let the release
       land on the now-uncovered trigger and reopen the list. `preventDefault` keeps
       the mousedown from pulling focus back off the list it just opened. */
    trigger.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (openSelect) closeSelect(false);
      else open();
    });
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    return wrap;
  }

  /* ── The mouse trigger, bound by pressing it ────────────────────────────
     `MouseTriggerControl`: a readout of what is bound, and a Record button. While
     it listens, every press in the window is the answer - which is why it is safe
     to let a visitor try it here: the press is read, swallowed, and goes no
     further. Escape is the way out, being the one thing that cannot be mistaken
     for a button somebody is trying to bind. */

  const recorder = { on: false, error: null };
  const CAPTURE = { capture: true };
  const SWALLOWED = ['mouseup', 'pointerup', 'click', 'auxclick', 'contextmenu'];
  let swallowTimer = 0;

  /* Everything the press would otherwise have done - activate a control, open a
     context menu, and for the side buttons, take the browser Back or Forward. */
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'mouseup' && !recorder.on) {
      window.clearTimeout(swallowTimer);
      swallowTimer = window.setTimeout(disarmSwallow, 60);
    }
  };
  const armSwallow = () => SWALLOWED.forEach((type) => window.addEventListener(type, swallow, CAPTURE));
  function disarmSwallow() {
    window.clearTimeout(swallowTimer);
    SWALLOWED.forEach((type) => window.removeEventListener(type, swallow, CAPTURE));
  }

  function onRecordPress(event) {
    const trigger = triggerFromEvent(event);
    /** A button this build has no name for: let it through rather than binding a guess. */
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    const reason = rejectTrigger(trigger);
    if (reason) {
      /* Still recording: a refusal is an invitation to press something else. */
      recorder.error = reason;
      render();
      return;
    }
    const value = formatTrigger(trigger);
    stopRecording(true);
    S.mouseTriggerButton = value;
    /* The gesture travels with the button: binding left or right takes Hold off the table. */
    if (!allowsHold(value)) S.mouseTriggerMode = 'click';
    render();
  }

  function onRecordKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopRecording(false);
    render();
  }

  function onRecordBlur() {
    stopRecording(false);
    render();
  }

  function startRecording() {
    recorder.on = true;
    recorder.error = null;
    armSwallow();
    window.addEventListener('mousedown', onRecordPress, CAPTURE);
    window.addEventListener('keydown', onRecordKey, CAPTURE);
    window.addEventListener('blur', onRecordBlur);
    render();
  }

  /** `pressed`: a button is still down, so its release is swallowed too before the guard lifts. */
  function stopRecording(pressed) {
    if (!recorder.on) return;
    recorder.on = false;
    recorder.error = null;
    window.removeEventListener('mousedown', onRecordPress, CAPTURE);
    window.removeEventListener('keydown', onRecordKey, CAPTURE);
    window.removeEventListener('blur', onRecordBlur);
    if (pressed) {
      window.clearTimeout(swallowTimer);
      swallowTimer = window.setTimeout(disarmSwallow, 1500);
    } else {
      disarmSwallow();
    }
  }

  function mouseControl(row) {
    const wrap = el('div', 'mouse-trigger');
    const line = el('div', 'mouse-trigger-row');

    const slot = el('span', `mouse-trigger-slot${recorder.on ? ' is-recording' : ''}`);
    slot.setAttribute('role', 'status');
    slot.setAttribute('aria-live', 'polite');
    if (recorder.on) {
      slot.append(el('em', '', 'Press a button…'));
    } else {
      triggerChips(S.mouseTriggerButton).forEach((chip, index) => {
        if (index > 0) slot.append(el('span', 'mouse-trigger-plus', '+'));
        slot.append(el('kbd', '', chip));
      });
    }
    line.append(slot);

    /* While it listens there is no button here, because there is nothing left that
       could be clicked. What stands in its place says how to get out. */
    if (recorder.on) {
      const stop = el('span', 'mouse-trigger-stop');
      stop.append(glyph('i-dot'), el('b', '', 'Esc to stop'));
      line.append(stop);
    } else {
      const record = el('button', 'mouse-trigger-record');
      record.type = 'button';
      record.title = 'Record a button';
      record.setAttribute('aria-label', `${row.title}: record a button`);
      record.append(glyph('i-dot'), el('b', '', 'Record'));
      record.addEventListener('click', startRecording);
      line.append(record);
    }
    wrap.append(line);

    if (recorder.on || recorder.error) {
      const note = el('p', `mouse-trigger-note${recorder.error ? ' is-warn' : ''}`);
      note.setAttribute('role', 'status');
      if (recorder.error) note.append(glyph('i-alert'));
      note.append(el('span', '', recorder.error || 'Press the button you want, anywhere in this window.'));
      wrap.append(note);
    }
    return wrap;
  }

  /* ── Where a dock sits, as the screen it sits on ────────────────────────
     `DockPositionPicker`: the box is the monitor, the ring in the middle is the
     wheel, and each strip is a dock in miniature - so the setting is answered by
     pointing rather than by translating "Bottom center" back into a corner. The
     other dock, when it is on, is drawn faint in its own region. */
  function dockPicker(row) {
    const value = get(row.key);
    const box = el('div', 'dockpick');
    box.dataset.key = row.key;
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', tr(row.title));
    box.append(el('span', 'dockpick-wheel'));

    /* The render replaces the picker, so focus is handed to the same cell in the new one. */
    const choose = (position) => {
      set(row.key, position);
      const again = main.querySelector(`.dockpick[data-key="${row.key}"] [data-position="${position}"]`);
      if (again) again.focus({ preventScroll: true });
    };

    DOCK_GRID.forEach((line) => line.forEach((position) => {
      const [band, side] = position.split('-');
      const selected = position === value;
      const shared = row.occupied && row.occupied.position === position;
      const label = DOCK_LABELS[position];
      const cell = el('button', `dockpick-cell is-${band} is-${side}${selected ? ' is-selected' : ''}${shared ? ' is-shared' : ''}`);
      cell.type = 'button';
      cell.dataset.position = position;
      cell.setAttribute('role', 'radio');
      cell.setAttribute('aria-checked', String(selected));
      cell.tabIndex = selected ? 0 : -1;
      cell.setAttribute('aria-label', shared ? `${label} - ${row.occupied.label} is here too` : label);
      cell.title = shared ? `${label} - shared with the ${row.occupied.label.toLowerCase()}` : label;
      const strip = el('span', 'dockpick-strip');
      strip.append(el('i'), el('i'), el('i'));
      cell.append(strip);
      cell.addEventListener('click', () => choose(position));
      box.append(cell);
    }));

    /* Arrow keys move the CHOICE, not just the focus - one tab stop, not six. */
    box.addEventListener('keydown', (event) => {
      const moves = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      const r = DOCK_GRID.findIndex((line) => line.includes(value));
      const c = DOCK_GRID[r].indexOf(value);
      choose(DOCK_GRID[(r + move[1] + 2) % 2][(c + move[0] + 3) % 3]);
    });
    return box;
  }

  /* ── The practice wheel (Sound → Try it) ────────────────────────────────
     `SoundTryWheel`: not a smaller copy of the wheel - the Appearance preview is
     that - but a wheel to move around in, to hear how often the notes come on a
     sweep across your own number of shortcuts, and which one the centre answers
     with. What it shares with the wheel is everything that decides a note: the
     aim and `noteForHighlight` itself. */

  const TRY_RADIUS = 80;
  /** The square the ring is centred in; the name pill gets its own strip below it. */
  const TRY_BOX = 240;
  const TRY_HEIGHT = TRY_BOX + 28;
  const TRY_HUB = 44;
  /** `RadialMenu`'s cancel zone - the hub's box, not its circle, at the scale it takes when lit. */
  const TRY_DEAD = Math.ceil((TRY_HUB / 2) * 1.06 * Math.SQRT2) + 4;

  /** `getReadableForeground`: black on a light hover colour, white on a dark one. */
  const readableForeground = (background) => {
    const hex = String(background).replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return '#000000';
    const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.56 ? '#000000' : '#FFFFFF';
  };

  /** `sectorIndexForDelta`, from src/utils/radialSectors.ts. */
  function sectorIndex(dx, dy, count) {
    if (count <= 0) return null;
    const slice = 360 / count;
    let angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
    if (angle < 0) angle += 360;
    const index = Math.floor(((angle + slice / 2) % 360) / slice);
    return index >= 0 && index < count ? index : null;
  }

  function tryWheel() {
    const HUB = SOUND ? SOUND.HUB : '__hub__';
    const items = previewItems();
    const count = items.length;
    const tileSize = Math.max(20, Math.min(44, Math.floor((2 * Math.PI * TRY_RADIUS) / Math.max(count, 1)) - 10));
    const hover = S.radialHoverColor;
    const foreground = readableForeground(hover);
    const byPointer = S.radialSelectionMode === 'cursor' && S.radialInstantActivate !== 'dwell';

    const stage = el('div', 'trywheel');
    stage.style.height = `${TRY_HEIGHT}px`;
    stage.style.setProperty('--ring-y', `${TRY_BOX / 2}px`);
    stage.tabIndex = 0;
    stage.setAttribute('role', 'group');
    stage.setAttribute('aria-roledescription', 'practice wheel');
    stage.setAttribute('aria-label', 'Try it');
    const name = el('span', 'trywheel-name');
    name.setAttribute('aria-live', 'polite');

    /* The three things the wheel keeps: what is lit, whether the aim has been out,
       when it opened. The box is already open when the page shows it, and that
       opening made no sound. */
    let lit = null;
    let aimedAway = false;
    let openedAt = Number.NEGATIVE_INFINITY;
    let ring = null;
    let hub = null;
    let tiles = [];

    const tf = (node, value) => node.style.setProperty('--tf', value);

    function buildRing(blooming) {
      const next = el('div', `trywheel-ring${blooming ? ' is-blooming' : ''}`);
      next.style.height = `${TRY_BOX}px`;
      hub = el('div', 'trywheel-hub');
      hub.style.width = `${TRY_HUB}px`;
      hub.style.height = `${TRY_HUB}px`;
      next.append(hub);
      tiles = items.map((item, index) => {
        const tile = el('div', 'trywheel-tile');
        tile.style.width = `${tileSize}px`;
        tile.style.height = `${tileSize}px`;
        tile.style.borderRadius = `${Math.round(tileSize * 0.3)}px`;
        if (item.icon) {
          const img = el('img');
          img.src = item.icon;
          img.alt = '';
          tile.append(img);
        }
        tile.dataset.index = String(index);
        next.append(tile);
        return tile;
      });
      if (ring) ring.replaceWith(next);
      else stage.prepend(next);
      ring = next;
      paintLit();
    }

    function paintLit() {
      const hubLit = lit === HUB;
      hub.style.background = hubLit ? hover : '';
      hub.style.borderColor = hubLit ? hover : '';
      tf(hub, `scale(${hubLit ? 1.06 : 1})`);
      tiles.forEach((tile, index) => {
        const rad = (index * (360 / count) - 90) * (Math.PI / 180);
        const on = index === lit;
        tile.style.background = on ? hover : '';
        tile.style.borderColor = on ? hover : '';
        tile.style.color = on ? foreground : '';
        tf(tile, `translate(${(TRY_RADIUS * Math.cos(rad)).toFixed(1)}px, ${(TRY_RADIUS * Math.sin(rad)).toFixed(1)}px) scale(${on ? 1.08 : 1})`);
      });
      name.textContent = lit === HUB ? 'Center' : lit === null ? '' : items[lit].label;
    }

    function land(target) {
      if (target === lit) return;
      lit = target;
      paintLit();
      const wasAway = aimedAway;
      if (target !== null && target !== HUB) aimedAway = true;
      if (!SOUND) return;
      const note = SOUND.noteFor(target, wasAway, performance.now() - openedAt, SOUND.resolve());
      if (note) SOUND.play(note);
    }

    function aimAt(clientX, clientY) {
      const rect = stage.getBoundingClientRect();
      if (!count) return;
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + TRY_BOX / 2);
      if (dx * dx + dy * dy < TRY_DEAD * TRY_DEAD) return land(HUB);
      const index = sectorIndex(dx, dy, count);
      if (index === null) return land(null);
      if (byPointer) {
        const rad = (index * (360 / count) - 90) * (Math.PI / 180);
        const offX = dx - TRY_RADIUS * Math.cos(rad);
        const offY = dy - TRY_RADIUS * Math.sin(rad);
        const hit = Math.max(tileSize * 0.85, 22);
        if (offX * offX + offY * offY > hit * hit) return land(null);
      }
      return land(index);
    }

    /** The wheel opening again, with its note, from wherever the aim is now. */
    function replay() {
      openedAt = performance.now();
      aimedAway = lit !== null && lit !== HUB;
      buildRing(true);
      if (!SOUND) return;
      SOUND.wake();
      const sounds = SOUND.resolve();
      if (sounds.open) SOUND.play(sounds.open);
    }

    const step = (delta) => {
      const current = typeof lit === 'number' ? lit : -1;
      const from = current === -1 ? (delta > 0 ? -1 : 0) : current;
      land((from + delta + count) % count);
    };

    const release = () => {
      land(null);
      if (SOUND) SOUND.sleep();
    };

    stage.append(name);
    buildRing(false);

    stage.addEventListener('pointerenter', () => { if (SOUND) SOUND.wake(); });
    stage.addEventListener('pointermove', (event) => aimAt(event.clientX, event.clientY));
    stage.addEventListener('pointerleave', release);
    stage.addEventListener('click', replay);
    stage.addEventListener('focus', () => { if (SOUND) SOUND.wake(); });
    stage.addEventListener('blur', release);
    stage.addEventListener('keydown', (event) => {
      if (!count) return;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          return step(1);
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          return step(-1);
        case 'Home':
          event.preventDefault();
          return land(HUB);
        case 'Enter':
        case ' ':
          event.preventDefault();
          return replay();
      }
    });
    return stage;
  }

  /* ── Small things the panel says back ───────────────────────────────── */

  let flashTimer = 0;
  function flash(button) {
    window.clearTimeout(flashTimer);
    button.classList.add('is-flash');
    flashTimer = window.setTimeout(() => button.classList.remove('is-flash'), 420);
  }

  /* The app's toast, bottom-left, for the one change the panel makes on its own:
     the other trigger coming on when the last one goes off. */
  let toastTimer = 0;
  function showToast(message) {
    const old = win.querySelector('.win-toast');
    if (old) old.remove();
    const toast = el('div', 'win-toast');
    toast.setAttribute('role', 'status');
    toast.append(glyph('i-check'), el('span', '', message));
    win.append(toast);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.remove(), 2600);
  }

  /** Which action row is mid-confirm, so a re-render can put it back the way it was. */
  let confirming = null;
  function askAgain(row) {
    confirming = row.key;
    render();
  }

  /* The revert column comes before the control and ALWAYS exists, even empty: it is
     what keeps the switch in the same place before and after the first click. The
     button inside it appears only once the row has moved off its default - one rule
     for every row, derived here rather than declared per row, so a row that stops
     matching cannot go on claiming it is at its default. */
  function revertSlot(row) {
    const slot = el('span', 'win-revert-slot');
    const key = row.key;
    if (!key || !(key in DEFAULTS) || get(key) === DEFAULTS[key]) return slot;

    const button = el('button', 'win-revert');
    button.type = 'button';
    button.setAttribute('aria-label', `Reset ${tr(row.title)} to default`);
    button.title = 'Reset to default';
    button.append(glyph('i-revert'));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      put(key, DEFAULTS[key]);
      /* The trigger button's gesture travels with it, as it does on a record. */
      if (key === 'mouseTriggerButton' && !allowsHold(DEFAULTS[key])) S.mouseTriggerMode = 'click';
      render();
    });
    slot.append(button);
    return slot;
  }

  function rangeRow(row) {
    const line = el('div', 'win-row is-slider');
    const copy = el('span', 'win-copy');
    copy.append(el('b', '', tr(row.title)));
    if (row.desc) copy.append(el('small', '', tr(row.desc)));

    const readout = row.unit ? valueField(row) : el('span', 'readout', row.format(get(row.key)));
    const control_ = el('span', 'win-control');
    control_.append(revertSlot(row), readout);

    const slider = el('span', 'slider');
    const input = el('input');
    input.type = 'range';
    input.min = row.min;
    input.max = row.max;
    input.step = row.step;
    input.value = get(row.key);
    input.setAttribute('aria-label', tr(row.title));
    /* `input`, not `change`: the readout and the preview have to follow the
       thumb, which is the whole reason the preview exists. */
    input.addEventListener('input', () => {
      put(row.key, Number(input.value));
      const box = readout.querySelector('input');
      if (box) box.value = row.format(get(row.key));
      else readout.textContent = row.format(get(row.key));
      paintPreview();
      /* A row whose result is heard - Volume - plays it at every step of the drag. */
      if (row.heard) row.heard();
    });
    /* `change` is the thumb let go: the row settles (its revert arrow). */
    input.addEventListener('change', render);
    /* The ends of the scale, flanking the track: a bare track says how far the thumb
       has come but not what it is a fraction of. */
    const rail = el('span', row.ticks ? 'slider-rail has-ticks' : 'slider-rail');
    if (row.ticks) {
      const ticks = el('span', 'slider-ticks');
      ticks.setAttribute('aria-hidden', 'true');
      const count = Math.round((row.max - row.min) / (row.step || 1)) + 1;
      for (let i = 0; i < count; i += 1) ticks.append(el('i'));
      rail.append(ticks);
    }
    rail.append(input);
    slider.append(
      el('span', 'slider-bounds', row.format(row.min)),
      rail,
      el('span', 'slider-bounds', row.format(row.max)),
    );

    line.append(copy, control_, slider);
    return line;
  }

  /* A readout that also takes a typed value: `37%` at rest, a bare `37` with the `%`
     outside the box while it has focus, so the unit reads as given rather than as
     something to type. Enter or clicking away keeps it, clamped to the slider's ends;
     Escape drops it. */
  function valueField(row) {
    const wrap = el('span', 'valuefield');
    const box = el('input', 'valuefield-input');
    box.type = 'text';
    box.inputMode = 'numeric';
    box.value = row.format(get(row.key));
    box.setAttribute('aria-label', tr(row.title));
    const unit = el('span', 'valuefield-unit', row.unit);
    unit.setAttribute('aria-hidden', 'true');
    let discard = false;

    box.addEventListener('focus', () => {
      wrap.classList.add('is-editing');
      box.maxLength = 3;
      box.value = String(Math.round(get(row.key)));
      box.select();
    });
    box.addEventListener('input', () => { box.value = box.value.replace(/\D/g, ''); });
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        box.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        discard = true;
        box.blur();
      }
    });
    box.addEventListener('blur', () => {
      /* A render that replaced this row took the box with it; nothing here to settle. */
      if (!box.isConnected) return;
      const typed = box.value.trim();
      wrap.classList.remove('is-editing');
      box.removeAttribute('maxlength');
      const next = Math.round(Math.min(row.max, Math.max(row.min, Number(typed))));
      const keep = !discard && typed !== '' && Number.isFinite(next) && next !== get(row.key);
      discard = false;
      if (!keep) {
        box.value = row.format(get(row.key));
        return;
      }
      put(row.key, next);
      render();
      if (row.heard) row.heard();
    });

    wrap.append(box, unit);
    return wrap;
  }

  /* ── The wheel preview ──────────────────────────────────────────────────
     The app puts one at the top of Appearance for a plain reason: radius, icon
     size, spacing and dimming had no visible effect until the panel was closed
     and the wheel triggered, so tuning them meant a round trip per nudge. The
     geometry is computed at full size and one `scale()` makes it small, so what
     moves here is what moves on screen.

     The scale is fitted to the BIGGEST wheel the radius slider can ask for, not
     to the wheel being drawn. Fitting every frame to its own extent divided the
     setting straight back out: the ring grew, the scale shrank by the same
     factor, and the tiles landed on the same pixels at 90 px as at 220 px. */

  const PREVIEW_H = 188;
  const PREVIEW_INSET = 14;
  const RADIUS_MAX = 220;
  let previewLayer = null;

  function previewItems() {
    const active = SPACES[LOOK.activeWorkspace ?? 0] || SPACES[0];
    return (active && active.items) || [];
  }

  function buildPreview() {
    const box = el('div', 'wheel-preview');
    const stage = el('div', 'wheel-stage');
    stage.style.height = `${PREVIEW_H}px`;
    const desk = el('div', 'wheel-desk');
    const scrim = el('div', 'wheel-scrim');
    const layer = el('div', 'wheel-layer');
    stage.append(desk, scrim, layer);
    box.append(stage, el('p', 'wheel-caption', 'Your own shortcuts, shown smaller than they open.'));
    previewLayer = { stage, scrim, layer };
    return box;
  }

  function paintPreview() {
    if (!previewLayer) return;
    const { stage, scrim, layer } = previewLayer;

    const items = previewItems();
    const count = items.length || 6;
    const hover = S.radialHoverColor;
    const dim = S.backdropOpacity;
    const labels = S.alwaysShowAppLabels;
    const space = SPACES[LOOK.activeWorkspace ?? 0] || SPACES[0];
    const pillName = (space && space.name) || 'Rovyl';
    const pillHint = LOOK.centerLabel || 'Center';

    /* The app's packing: neighbours may not touch, so a crowded ring pushes the
       radius out rather than letting the tiles overlap. */
    const ringFor = (menuRadius) => Math.max(
      menuRadius,
      count > 1 ? (S.iconSize + S.appSpacing) / 2 / Math.sin(Math.PI / count) : 0,
    );
    const longest = labels ? items.reduce((n, item) => Math.max(n, (item.label || '').length), 0) : 0;
    const extentsOf = (radius) => {
      const ring = radius + S.iconSize / 2;
      const labelOffset = S.iconSize / 2 + 10;
      let vertical = ring + (labels ? labelOffset + 26 : 0);
      let horizontal = ring + (labels ? labelOffset + 24 + longest * 7.2 : 0);
      if (S.showWorkspacePill) {
        vertical = Math.max(vertical, radius + S.iconSize * 0.75 + 34 + 32);
        horizontal = Math.max(horizontal, (48 + (pillName.length + pillHint.length) * 6.2) / 2);
      }
      return { vertical, horizontal };
    };

    const radius = ringFor(S.menuRadius);
    const now = extentsOf(radius);
    const ceiling = extentsOf(ringFor(RADIUS_MAX));
    const width = stage.clientWidth || 480;
    const scale = Math.min(
      1,
      (PREVIEW_H / 2 - PREVIEW_INSET) / Math.max(now.vertical, ceiling.vertical, 1),
      (width / 2 - PREVIEW_INSET) / Math.max(now.horizontal, ceiling.horizontal, 1),
    );

    layer.replaceChildren();
    layer.style.transform = `scale(${scale})`;
    /* Drawn on the stage, not inside the scaled layer, with the radius scaled to
       match - a gradient inside `scale()` would shrink its own falloff. */
    scrim.style.background = window.RovylScrim
      ? RovylScrim.gradient({ x: '50%', y: '50%' }, dim, Math.max(radius * scale, 1))
      : `rgba(0, 0, 0, ${dim})`;

    const hubSize = Math.round(S.iconSize * 0.84);

    /* Area with Visible wedges: the shares, the first one lit, capped to the stage.
       It sits at the bottom of the stack - the ground the wheel stands on. */
    if (S.radialSelectionMode !== 'cursor' && S.radialAreaWedges && window.RovylSectors) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'wheel-sectors');
      const outer = Math.max(Math.round(radius + S.iconSize * 0.6), Math.floor(PREVIEW_H / 2 / Math.max(scale, 0.01)));
      const pool = window.RovylScrim ? RovylScrim.radius(radius, S.iconSize, S.appSpacing) : radius + S.iconSize;
      const wedges = RovylSectors.draw(svg, {
        count,
        inner: hubSize / 2 + 8,
        outer,
        falloff: Math.min(outer * 0.55, pool),
        color: hover,
      });
      if (wedges[0]) wedges[0].style.opacity = '1';
      layer.append(svg);
    }

    const hub = el('div', 'wheel-hub');
    hub.style.width = `${hubSize}px`;
    hub.style.height = `${hubSize}px`;
    hub.style.borderColor = `${hover}55`;
    layer.append(hub);

    if (S.showWorkspacePill) {
      const pill = el('div', 'wheel-pill');
      pill.append(el('span', '', pillName), el('span', '', pillHint));
      /* `RadialMenu`'s own offset for the pill, so it lands where the real one does. */
      pill.style.transform = `translate(-50%, 0) translate(0, ${Math.round(radius + S.iconSize * 0.75 + 34)}px)`;
      layer.append(pill);
    }

    const shade = 12 + Math.round(dim * 10);
    items.forEach((item, i) => {
      const angle = (-90 + (360 / count) * i) * (Math.PI / 180);
      const slot = el('div', 'wheel-slot');
      slot.style.transform =
        `translate(${(Math.cos(angle) * radius).toFixed(1)}px, ${(Math.sin(angle) * radius).toFixed(1)}px)`;

      /* One lit slice, and always the first, so dragging a slider never moves the highlight. */
      const lit = i === 0;
      const tile = el('div', 'wheel-tile');
      tile.style.width = `${S.iconSize}px`;
      tile.style.height = `${S.iconSize}px`;
      tile.style.borderRadius = `${Math.round(S.iconSize * 0.28)}px`;
      /* The real tile is opaque and takes its grey from the dimming; so does this one. */
      tile.style.background = lit ? hover : `rgb(${shade}, ${shade}, ${shade})`;
      tile.style.borderColor = lit ? hover : `rgba(255,255,255,${(0.28 + dim * 0.08).toFixed(3)})`;
      if (item.icon) {
        const img = el('img');
        img.src = item.icon;
        img.alt = '';
        tile.append(img);
      }
      slot.append(tile);

      if (labels) {
        const label = el('span', 'wheel-label', item.label);
        /* Outward, never inward: a label under the top slice lands on the hub,
           which is the one place on the wheel that has to stay readable. */
        const below = Math.sin(angle) >= 0;
        label.style.top = below
          ? `${S.iconSize / 2 + 10}px`
          : `${-(S.iconSize / 2 + 10)}px`;
        if (!below) label.style.transform = 'translate(-50%, -100%)';
        if (lit) {
          label.style.background = hover;
          label.style.borderColor = hover;
          label.style.color = readableForeground(hover);
        }
        slot.append(label);
      }
      layer.append(slot);
    });
  }

  /* ── Workspaces page ────────────────────────────────────────────────────
     Cards, not rows: the app gave this page up on a list a while ago, because
     a tally of shortcuts read off a thumbnail that already draws every one of
     them said nothing. Each card previews its own wheel in the workspace's own
     colour, and the only lines left are the ones worth saying - Current, or
     Paused. See `WorkspaceCards` and `WorkspaceWheelPreview`. */

  const CARD_RADIUS = 34;

  function cardPreview(ws) {
    const box = el('div', 'zs-ws-preview');
    const accent = ws.color || 'currentColor';

    const ring = el('span', 'zs-ws-preview-ring');
    ring.style.borderColor = ws.color ? `${ws.color}44` : 'currentColor';
    const hub = el('span', 'zs-ws-preview-hub');
    hub.style.background = accent;
    box.append(ring, hub);

    /* Eight is what the thumbnail holds; the app slices there too. */
    const items = ws.items.slice(0, 8);
    items.forEach((item, i) => {
      const angle = ((i * (360 / items.length)) - 90) * (Math.PI / 180);
      const slot = el('span', 'zs-ws-preview-slot');
      slot.style.transform =
        `translate(${(CARD_RADIUS * Math.cos(angle)).toFixed(1)}px, ${(CARD_RADIUS * Math.sin(angle)).toFixed(1)}px)`;
      if (item.icon) {
        const img = el('img', 'zs-ws-preview-img');
        img.src = item.icon;
        img.alt = '';
        slot.append(img);
      }
      box.append(slot);
    });

    if (!items.length) box.append(el('span', 'zs-ws-preview-empty', 'empty'));
    return box;
  }

  function workspacesPage() {
    const grid = el('div', 'zs-ws-grid');

    SPACES.forEach((ws, i) => {
      const current = i === (LOOK.activeWorkspace ?? 0);
      const card = el('div', `zs-ws-card${current ? ' is-current' : ''}${ws.paused ? ' is-paused' : ''}`);
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.append(cardPreview(ws));

      const head = el('span', 'zs-ws-card-head');
      head.append(el('b', '', ws.name));
      if (ws.key) head.append(el('em', '', String(ws.key)));
      card.append(head);

      /* Only the states worth saying: a workspace that is simply available has
         no line at all. */
      if (current || ws.paused) card.append(el('small', '', current ? 'Current' : 'Paused'));

      if (SPACES.length > 1) {
        const remove = el('button', 'zs-ws-card-delete');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Delete ${ws.name}`);
        remove.append(glyph('i-trash'));
        remove.addEventListener('click', (event) => { event.stopPropagation(); flash(remove); });
        card.append(remove);
      }

      card.addEventListener('click', () => flash(card));
      grid.append(card);
    });

    const create = el('button', 'zs-ws-card is-new');
    create.type = 'button';
    create.append(glyph('i-plus'), el('small', '', 'New workspace'));
    create.addEventListener('click', () => flash(create));
    grid.append(create);

    return grid;
  }

  /* ── Render ─────────────────────────────────────────────────────────────── */

  function render() {
    /* The listbox is painted on `.win`, not inside the row, so a re-render would
       otherwise leave it floating over a trigger that no longer exists. */
    closeSelect(false);
    win.dataset.znTheme = S.appearanceTheme;

    nav.replaceChildren();
    for (const section of SECTIONS) {
      const item = el('li');
      const button = el('button', section.id === S.section ? 'is-active' : '', tr(section.label));
      button.type = 'button';
      button.prepend(glyph(section.icon));
      button.addEventListener('click', () => {
        if (recorder.on) stopRecording(false);
        S.section = section.id;
        confirming = null;
        render();
        main.scrollTop = 0;
      });
      item.append(button);
      nav.append(item);
    }

    const meta = SECTIONS.find((section) => section.id === S.section);
    main.replaceChildren();

    const head = el('div', 'win-head');
    head.append(el('h3', '', tr(meta.label)));
    head.append(el('p', '', tr(meta.caption)));
    main.append(head);

    previewLayer = null;

    if (S.section === 'spaces') {
      main.append(workspacesPage());
      return;
    }

    /* Groups keep declaration order: the group is a label, not a card. An unnamed
       group (General, Sound) is rows with no heading over them. */
    let group = null;
    let rows = null;

    for (const row of rowsFor(S.section)) {
      if (row.kind === 'preview') {
        main.append(buildPreview());
        continue;
      }
      if (rows === null || row.group !== group) {
        group = row.group;
        if (group) main.append(el('p', 'win-group', tr(group)));
        rows = el('div', 'win-rows');
        main.append(rows);
      }
      if (row.kind === 'range') {
        rows.append(rangeRow(row));
        continue;
      }
      const picture = row.kind === 'dock' || row.kind === 'widget';
      const line = el('div', `win-row${row.kind === 'open' ? ' is-openable' : ''}${picture ? ' is-picker' : ''}`);
      const copy = el('span', 'win-copy');
      copy.append(el('b', '', tr(row.title)));
      if (row.desc) copy.append(el('small', '', tr(row.desc)));
      line.append(copy);

      const control_ = el('span', 'win-control');
      control_.addEventListener('click', (event) => event.stopPropagation());
      control_.append(revertSlot(row));
      /* Mid-confirm the row swaps its one button for the pair, so the press that
         cannot be undone is never the press already under the pointer. */
      if (row.confirm && confirming === row.key) {
        const actions = el('span', 'confirm-actions');
        const cancel = el('button', 'btn', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', () => { confirming = null; render(); });
        const go = el('button', 'btn is-danger', row.confirm.cta);
        go.type = 'button';
        go.addEventListener('click', () => { confirming = null; render(); });
        actions.append(cancel, go);
        control_.append(actions);
      } else if (row.kind === 'dock') {
        /* The picture answers "where"; this says it in words. */
        control_.append(el('span', 'readout is-place', DOCK_LABELS[get(row.key)]));
      } else {
        const node = control(row);
        if (node) control_.append(node);
      }
      line.append(control_);

      /* Under the row, not over it: what it says is the reason the second press
         exists. Red only on the button that does it - a red row would read as an
         error, and nothing has gone wrong yet. */
      if (row.confirm && confirming === row.key) {
        const note = el('p', 'confirm-body');
        note.setAttribute('role', 'alert');
        note.append(glyph('i-alert'), el('span', '', row.confirm.body));
        line.append(note);
        /* Restore defaults is the last row of the section, so the reason for the
           second press opens below the fold unless the pane goes to meet it. */
        requestAnimationFrame(() => note.scrollIntoView({ block: 'nearest' }));
      }

      if (row.kind === 'dock') line.append(dockPicker(row));
      if (row.kind === 'widget') {
        const widget = el('div', 'win-widget');
        widget.append(row.build());
        line.append(widget);
      }

      if (row.kind === 'open') {
        line.addEventListener('click', () => flash(line.querySelector('.btn')));
      }
      rows.append(line);
    }

    if (previewLayer) paintPreview();
  }

  /* The list is placed against `.win` while the trigger lives in `.win-main`, so a
     scroll moves one and not the other. Re-measured rather than remembered; the
     help bubble is anchored to a row that just moved, so it is dismissed. */
  main.addEventListener('scroll', () => {
    if (!openSelect) return;
    const at = place(openSelect.trigger, openSelect.count);
    openSelect.list.classList.toggle('is-up', !at.down);
    openSelect.list.style.left = at.left + 'px';
    openSelect.list.style.top = at.top + 'px';
    openSelect.tip.remove();
  });

  /* The preview is fitted to the width it got, and the window is fluid. */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(paintPreview, 120);
  }, { passive: true });

  /* The wheel at the top of the page has its own Sound switch. When it moves,
     the section showing it has to say so too. */
  if (SOUND) {
    SOUND.subscribe(() => {
      if (!writingSound && S.section === 'sound') render();
    });
  }

  const version = document.getElementById('setVersion');
  if (version && LOOK.version) version.textContent = LOOK.version;

  render();
})();
