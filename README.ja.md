<div align="center">

# Rovyl

**ひと振りで、どこへでも。**

Windows のためのラジアルランチャー。どこでもマウスの中ボタンを長押しし、狙って、離すだけ。

[English](README.md) · **日本語**

[![Rovyl を Windows 用にダウンロード](https://img.shields.io/badge/Download%20for%20Windows-2ea44f?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/arshit09/rovyl/releases/latest)

![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4?style=flat-square)
![Rust](https://img.shields.io/badge/Rust-1.80%2B-dea584?style=flat-square&logo=rust&logoColor=white)
![Native](https://img.shields.io/badge/Win32-Direct2D-6e56cf?style=flat-square)
![Size](https://img.shields.io/badge/download-3.5%20MB-2ea44f?style=flat-square)

<img src="docs/media/banner.png" alt="" width="720">

</div>

---

## 2.0.0 の新機能 — Rovyl はネイティブな Windows アプリになりました

Rovyl はこれまで Electron アプリでした。いまは Rust 製の実行ファイル 1 つで、ホイールを
Direct2D と DirectComposition で描きます。ホイールも、ワークスペースも、設定も同じです。
**すでに Rovyl を使っているなら、自分でこの版に更新されます。** `%APPDATA%\Rovyl` の中身には
何も手を触れないので、ワークスペース、カスタムアイコン、設定はそのまま引き継がれます。

| | 1.19.0（Electron） | 2.0.0（ネイティブ） |
| --- | --- | --- |
| ダウンロード | 85.7 MB | **3.5 MB** — 24 分の 1 |
| ディスク上の大きさ | 296 MB | **3.5 MB** — 83 分の 1 |
| インストールされるファイル | 138 | **1** |
| 動作中のプロセス | メインプロセス、ウィンドウごとの Chromium レンダラー、マウスフック・前面化・システム表示のための別々のヘルパー | **1** |
| 更新のたびにダウンロードする量 | 85.7 MB | **3.5 MB** |

公開されている 1.19.0 のリリースとそのインストール先の展開後フォルダーを、2.0.0 のリリースと
比べた値で、Windows 10 上で測りました。通知領域で待機しているとき、2.0.0 は作業セットで約 60 MB
を使います。それも、その 1 つのプロセスの中だけです。

**小さいだけでなく、速い理由**

- **最初のフレームは、ウィンドウより先に存在します。** ホイールは、すでに常駐している描画面から
  描かれるので、ジェスチャがプロセス境界をまたぐ描画の握手を待つことはありません。Electron 版が
  必要としたのはそれで、それを保つために検証スクリプトまで必要でした。
- **実行中に何も起動しません。** マウスとキーボードのフックは、このプロセスのスレッド上の
  コールバックです。Electron 版は、マウスフック用に PowerShell を、前面化用にもう 1 つ、アイコンの
  取り出し用にもう 1 つ、さらにシステム表示用に C# のヘルパーを、常駐させていました。
- **座標系は 1 つです。** フックと描画が同じプロセスなので、DPI を認識しないヘルパーに DIP の
  矩形を渡すことがありません。Electron 版が抱えていた、混在 DPI の恒常的な不具合は、回避したの
  ではなく、そもそも生じません。
- **前面を奪いません。** キー入力はフックから来るので、ホイールが開いているあいだも、いま入力して
  いたウィンドウがキーボードを持ち続けます。

ネイティブ版がいまのリポジトリです。ルートは Rust で、置き換えられた Electron 版は
[`archive/electron/`](archive/electron/) に残してあります。1.x のインストールがどう 2.0.0 に引き継がれるかは
[docs/BUILD.md](docs/BUILD.md#succession-from-1x) にあります。

## なぜ

どのランチャーも、まず今していることを中断させます。ウィンドウを開き、何文字か打ち、一覧を読み、行を選ぶ。速くはあっても、やはり中断ですし、手はマウスから離れます。

Rovyl は別の賭けに出ています。**あなたは自分のものがどこにあるか、もう知っている。** 中ボタンを長押しすると、画面の真ん中にホイールが咲きます。欲しいものの方へ動かし、離す。全部で 1 秒もかからず、いま居た場所でそのまま起き、あなたと作業のあいだにウィンドウを挟みません。

<div align="center">
<img src="docs/media/wheel.png" alt="デスクトップの上に開いた Rovyl のホイール" width="620">
</div>

## できること

- **どんな画面の上にも** — 全画面のアプリを含め、どのウィンドウの上でも開きます
- **好きな場所に** — メイン画面の中央、ポインターのあるモニター、またはポインターの真下
- **なんでも起動** — アプリケーション、フォルダー、ファイル、ウェブサイト、自由なコマンド
- **自動で見つける** — スタートメニューを読み、アプリの本物のアイコンを取り出します
- **カスタムアイコン** — ワークスペースもショートカットも、グリフ、画像（PNG、JPG、SVG、WebP、ICO…）、あるいは EXE や DLL の中のどのアイコンでも身にまとえます
- **ワークスペース** — 仕事用、ゲーム用、配信用とホイールを分け、選択画面か数字キーで切り替え。よく使うものに直接開いたり、ワークスペースごとにグローバルショートカットを割り当てたりもできます
- **ワークスペースをのぞく** — 任意。ワークスペースの上で止まると、そのショートカットが周りに広がり、入らずに 1 つ実行できます
- **呼び出し方は自由** — マウスの中ボタン、サイドボタン、グローバルホットキー、またはその両方。それぞれ個別にオフにできます
- **3 つの狙い方** — 速さなら向きで、正確さならポインターで、あるいは各項目の取り分を画面に描く領域で
- **キーボードで操作** — 任意。1〜9 で扇形を開き、Q でフォルダーから 1 つ戻ります
- **ドック** — 任意。自分のショートカットと、システムドック（時計、バッテリー、ネットワーク、音量）をホイールの脇に
- **クリックなしで起動** — 任意。ポインターを隠し、向きで選び、そのまま開きます
- **フォーカスの保護** — 全画面のゲーム中は邪魔しません
- **完全オフライン** — アカウントなし、計測なし、広告なし。あなたの PC から何も出ていきません

## インストール

<div align="center">

[![Rovyl を Windows 用にダウンロード](https://img.shields.io/badge/Download%20for%20Windows-2ea44f?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/arshit09/rovyl/releases/latest)

**Windows 10 と 11 — 無料、アカウント不要、登録するものは何もありません。**

</div>

ボタンを押すと GitHub の最新リリースが開きます。GitHub からダウンロードしたことがなくても、手順は 4 つだけです。

1. **Assets** の下にある **`.exe`** で終わるファイルをクリックします。ほかのファイルと同じように `Downloads` フォルダーに保存されます。
2. ブラウザーのダウンロードバーから、または `Downloads` でダブルクリックして開きます。
3. このファイルには署名がないため、Windows が青い **「Windows によって PC が保護されました」** の画面を出します。**詳細情報** をクリックし、**実行** を選んでください。
4. ウィンドウが 1 つ出るので、**インストール** を押します。あとは Rovyl が通知領域に常駐します。ウィザードも、フォルダーの選択も、管理者権限の確認もありません。プログラムの全体がその 3.5 MB のファイル 1 つで、あなた自身のアカウントの中に自分でインストールされるからです。

**ソースから** — 下の [ビルド](#ビルド) を参照してください。

## 使い方

<table>
<tr>
<td width="50%" valign="top">

**長押し**

Windows のどこでも、マウスの中ボタンを押したままにします。画面が暗転してホイールが現れ、どの向きへひと振りしてもすべてのショートカットに届きます。既定では中央に開きますが、「外観」→ **開く位置** でポインターの下に出すこともできます。モニターが 2 枚あるなら、「呼び出し」→ **モニター** で **メイン画面** と **ポインターを追う** を選べます。

</td>
<td width="50%" valign="top">

**狙う**

欲しいショートカットの方へ動かします。方向モードでは、画面のどこからでも指した扇形が光ります。領域モードも同じように振る舞い、各項目の取り分を描き分けます。ポインターモードでは、カーソルの下のアイコンだけが光ります。キーボード起動を有効にすれば、数字キーで扇形を直接選べます。

</td>
</tr>
<tr>
<td valign="top">

**離す**

対象が開き、ホイールは消えます。中央で離すか Escape を押せば、何も起動せずに取り消せます。

</td>
<td valign="top">

**切り替える**

既定では、ホイールは最初にワークスペースの選択画面を開きます。数字キーの方が好みなら、「一般」→ **ワークスペースの切り替え** → **キー**。ホイールが開いているあいだ、1〜9 で移動できます。
ほとんど 1 つしか使わないなら、「ワークスペース」→ **Open the wheel on** で選択画面を飛ばせます。中央のボタンからはいつでも選択画面に戻れます。ワークスペースの **Global shortcut** を設定すると、どこからでもそのワークスペースの中でホイールが開きます。

</td>
</tr>
</table>

## スクリーンショット

<div align="center">
<img src="docs/media/workspaces.png" alt="それぞれのホイールをプレビューするワークスペースのカード" width="440">
<img src="docs/media/settings.png" alt="ホイールをその場でプレビューする外観の設定" width="440">
</div>

## ビルド

**Windows 10 または 11**、MSVC ツールチェーン（`stable-x86_64-pc-windows-msvc`）の [Rust](https://rustup.rs) 1.80 以上、そして「C++ によるデスクトップ開発」を含む Visual Studio Build Tools が必要です。ビルドは `link.exe` でリンクします。Windows 専用なのは設計です。呼び出し、アイコンの取り出し、コンポジター、ウィンドウの扱いのいずれも Win32 だからです。

```powershell
git clone https://github.com/arshit09/rovyl
cd rovyl
cargo build --release
```

これでプログラムの全体、`target\release\rovyl.exe` ができます。作るべきインストーラーはありません。実行ファイルが、管理者権限の確認なしに、`%LOCALAPPDATA%` と `HKEY_CURRENT_USER` の下へ自分でインストールします。

```powershell
.\target\release\rovyl.exe --install
```

開発するときは、セッションが実際の設定を読み書きしないよう、使い捨てのプロファイルを指定し、ラッパー経由でビルドしてください。動作中の実行ファイルは自分自身のファイルを開いたままにするので、ふつうに再ビルドすると「アクセスが拒否されました」で失敗します。

```powershell
$env:ROVYL_USER_DATA = "$env:TEMP\rovyl-dev"
scripts\dev.ps1 cargo build
.\target\debug\rovyl.exe --seed
```

**[docs/BUILD.md](docs/BUILD.md)** に、すべてを書いてあります。インストールのフラグ、1.x のインストールがどう引き継がれるか、フレームや設定ウィンドウをオフスクリーンで描く診断用のフラグ、生成されるアイコンと言語のテーブル、同梱の 3 つの書体です。

### 1.x の Electron 版

2.0.0 が置き換えた Electron アプリは **[`archive/electron/`](archive/electron/)** に残してあります。レンダラー、メインプロセスと PowerShell のヘルパー、インストーラーの設定、そして独自の[アーキテクチャノート](archive/electron/docs/ARCHITECTURE.md)です。そこから出荷されるものはもうありません。読むために残してあり、またこのビルドが生成する 2 つのテーブルが、手で打ち直したものではなくそこから導かれているためでもあります。[docs/BUILD.md](docs/BUILD.md#development) を参照してください。

## コントリビュート

Issue と Pull Request を歓迎します。一見すると恣意的に見えるものを変える前に、その周りのコメントを読んでください。コメントは *何を* ではなく *なぜ* を説明していて、その大半は、かつて何かが壊れたから書かれています。

`cargo test` は、ウィンドウなしで確かめられることを確かめます。残りは、本物のフレームを描いて確かめます。[docs/BUILD.md](docs/BUILD.md#development) の `--probe`、`--probe-settings`、`--bench` はオフスクリーンで描いて終了するので、マウスに手を置かなくても、ホイールや設定ウィンドウの変更を目で確かめられます。

## リンク

- **ダウンロード** — [最新リリース](https://github.com/arshit09/rovyl/releases/latest)
- **サイトとドキュメント** — [rovyl.arshitvaghasiya.com/ja](https://rovyl.arshitvaghasiya.com/ja)
- **すべてのリリース** — [github.com/arshit09/rovyl/releases](https://github.com/arshit09/rovyl/releases)、または[変更履歴](https://rovyl.arshitvaghasiya.com/changelog)
- **上流** — [HenryCauan/rovyl](https://github.com/HenryCauan/rovyl)
- **プライバシーポリシー** — [rovyl.arshitvaghasiya.com/ja/privacy](https://rovyl.arshitvaghasiya.com/ja/privacy)

## ライセンス

Copyright © 2026 Henry Cauan.

Rovyl はフリーソフトウェアであり、**GNU General Public License v3.0** のもとで提供されています（[LICENSE](LICENSE) を参照）。使用、研究、改変、共有ができます。改変版を配布する場合は、そのソースを同じライセンスで公開する必要があります。

著作権者は、利用者に付与するこのライセンスには拘束されないため、Microsoft Store で販売されるビルドは Microsoft の標準的な条項のもとで配布されています。どちらも同じコードです。
