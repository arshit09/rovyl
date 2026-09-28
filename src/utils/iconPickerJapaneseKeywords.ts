/**
 * Japanese words the icon picker understands, mapped to the English tokens the index already knows.
 *
 * The semantic index next door (`./iconPickerEnglishKeywords.ts`) is English by construction: its
 * keys are words like `work`, `time`, `home`, and it finds icons by meaning rather than by name.
 * Someone searching in Japanese got nothing from it at all — not because the icons were missing,
 * but because 仕事 is not a prefix of `work`.
 *
 * So this translates the query, not the index. A Japanese token is looked up here, the English
 * tokens it stands for are handed to `collectIconsForEnglishTokens`, and the index does what it
 * always did. Nothing about the index changes, and a word that is not in this table simply behaves
 * as it did before.
 *
 * Reading, not writing: the keys are what a person types, so the same concept appears under kanji,
 * kana and the loanword where all three are plausible.
 */
export const JAPANESE_KEYWORD_TO_ENGLISH: Readonly<Record<string, readonly string[]>> = {
  仕事: ['work'],
  しごと: ['work'],
  会社: ['work', 'building'],
  書類: ['document', 'file'],
  文書: ['document'],
  資料: ['document', 'folder'],
  時間: ['time'],
  時計: ['clock', 'time'],
  時: ['time', 'clock'],
  予定: ['calendar'],
  カレンダー: ['calendar'],
  家: ['home'],
  いえ: ['home'],
  ホーム: ['home'],
  音楽: ['music'],
  おんがく: ['music'],
  音: ['sound', 'music'],
  動画: ['video'],
  映像: ['video'],
  写真: ['photo', 'image'],
  画像: ['image', 'photo'],
  カメラ: ['camera', 'photo'],
  メール: ['mail'],
  郵便: ['mail'],
  連絡: ['mail', 'chat'],
  会話: ['chat'],
  チャット: ['chat'],
  電話: ['phone'],
  通話: ['phone'],
  設定: ['settings'],
  環境設定: ['settings'],
  歯車: ['settings'],
  検索: ['search'],
  探す: ['search'],
  端末: ['terminal'],
  ターミナル: ['terminal'],
  コンソール: ['terminal'],
  開発: ['code', 'terminal'],
  コード: ['code'],
  ネット: ['network', 'web'],
  通信: ['network'],
  接続: ['network'],
  ブラウザ: ['browser', 'web'],
  地図: ['map'],
  場所: ['map', 'location'],
  買い物: ['shopping', 'cart'],
  買物: ['shopping', 'cart'],
  カート: ['cart'],
  お金: ['money'],
  金: ['money'],
  電池: ['battery'],
  バッテリー: ['battery'],
  天気: ['weather'],
  ゲーム: ['game'],
  遊び: ['game'],
  本: ['book'],
  読書: ['book'],
  勉強: ['book', 'school'],
  学校: ['school'],
  鍵: ['key', 'lock'],
  ロック: ['lock'],
  安全: ['shield', 'lock'],
  保護: ['shield'],
  ごみ箱: ['trash'],
  削除: ['trash'],
  保存: ['save'],
  印刷: ['printer'],
  フォルダ: ['folder'],
  フォルダー: ['folder'],
  ファイル: ['file'],
  星: ['star'],
  お気に入り: ['star', 'heart'],
  心: ['heart'],
  好き: ['heart'],
  人: ['user'],
  ユーザー: ['user'],
  チーム: ['users', 'team'],
  雲: ['cloud'],
  クラウド: ['cloud'],
  電源: ['power'],
  再生: ['play'],
  停止: ['stop'],
  一時停止: ['pause'],
};

/**
 * Whether a token is worth expanding despite being short.
 *
 * `keywordMatchesSearchTerm` ignores single-character tokens, and it is right to: one Latin letter
 * matches half the index. One kanji does not — 時, 家, 音 and 星 each carry as much as a whole
 * English word, and they are exactly what a Japanese user types first. So the length rule is about
 * script, not about bytes.
 */
const CJK_OR_KANA = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

export function isJapaneseToken(token: string): boolean {
  return CJK_OR_KANA.test(token);
}

/**
 * The English tokens a query stands for, longest key first so 買い物 wins over 物 if both match.
 *
 * Substring rather than equality, because Japanese is written without spaces: "音楽アプリ" arrives
 * as one token and still means music.
 */
export function englishTokensForJapanese(token: string): string[] {
  const query = token.trim();
  if (!query || !isJapaneseToken(query)) return [];
  const out = new Set<string>();
  const keys = Object.keys(JAPANESE_KEYWORD_TO_ENGLISH).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (query === key || query.includes(key)) {
      for (const english of JAPANESE_KEYWORD_TO_ENGLISH[key]) out.add(english);
    }
  }
  return [...out];
}
