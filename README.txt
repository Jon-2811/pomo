# Focus Glass Windows機能追加

このフォルダ内の3ファイルを、GitHubリポジトリ `pomo` のルートへアップロードしてください。

- `desktop.js`：Windows用の常時最前面ミニタイマー
- `cloud.js`：`desktop.js` を読み込むよう更新済み
- `sw.js`：`desktop.js` をオフラインキャッシュへ追加済み

## 反映方法

1. GitHubで `Jon-2811/pomo` を開く
2. `Add file` → `Upload files`
3. このZIP内の `desktop.js`、`cloud.js`、`sw.js` をまとめてドラッグ
4. `cloud.js` と `sw.js` の上書きを確認
5. `Commit changes` を押す
6. 1〜3分後に `https://jon-2811.github.io/pomo/` を開く
7. WindowsのChromeまたはEdgeで `Ctrl + Shift + R` を押して強制再読み込み

## 使い方

1. アプリの「設定」→「動作」を開く
2. 「Windows ミニタイマー」欄の「ミニタイマーを表示」を押す
3. 「開始時に自動表示」をオンにすると、タイマー開始時に自動で小窓が開く
4. 「通知を許可」を押すとWindows右下にテスト通知が届く

ミニタイマーから以下を操作できます。

- スタート／一時停止／再開
- リセット
- 終了・スキップ
- メイン画面を開く
- Windows上で移動・サイズ変更

## 注意

- 常時最前面表示はWindows版Chrome／EdgeのDocument Picture-in-Picture対応環境で動作します。
- 通知はFocus Glassのページまたはミニタイマーが開いている間に動作します。
- iPhone側の表示や既存通知処理には影響しないよう、Windows端末でのみ有効化されます。
