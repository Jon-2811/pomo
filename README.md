# Focus Glass

Liquid Glass風の落ち着いたUIで使える、iPhone向けポモドーロPWAです。ビルド不要のHTML/CSS/JavaScriptだけで動きます。

## 実装済み機能

- 集中・短い休憩・長い休憩の時間を自由に設定
- 初期設定では4セットごとに長い休憩（回数も変更可能）
- 一時停止・再開・リセット・途中集中の保存
- 集中タイマーとは独立した「1問ごとの制限時間」
- 「次の問題」で問題数を記録し、問題タイマーを即時再スタート
- 今日・今週・連続日数・過去14日グラフ・セッション履歴
- localStorageによる端末内保存
- Firebase Authentication + Firestoreによる複数端末同期
- PWA対応、ホーム画面追加、オフライン起動
- 終了音、振動、Wake Lock（対応ブラウザのみ）
- ライト／ダークモード自動対応

## まずローカルで確認

`index.html`を直接開くのではなく、フォルダ内で簡易サーバーを起動してください。

```bash
python -m http.server 8080
```

ブラウザで `http://localhost:8080` を開きます。Firebase未設定でも、端末内保存で全タイマー機能を使えます。

## 無料で公開する方法：GitHub Pages

1. GitHubで新しいリポジトリを作成
2. このフォルダ内のファイルをすべてアップロード
3. リポジトリの **Settings → Pages** を開く
4. **Deploy from a branch** を選択
5. `main` / `root` を選んで保存
6. 発行されたHTTPSのURLをiPhoneのSafariで開く
7. 共有ボタン → **ホーム画面に追加**

## 複数端末同期の設定（Firebase無料枠）

### 1. Firebaseプロジェクト

1. Firebase Consoleでプロジェクトを作成
2. **Authentication → Sign-in method** で「メール／パスワード」を有効化
3. **Firestore Database** を作成（Standard editionで可）
4. プロジェクト設定からWebアプリを追加
5. 表示された `firebaseConfig` の値を `firebase-config.js` に貼り付け

### 2. Firestoreルール

Firestoreの **Rules** に、同梱の `firestore.rules` の内容を貼り付けて公開します。これにより、ログインした本人のデータだけを読み書きできます。

### 3. 公開ドメインを許可

Firebase Authenticationの **Settings → Authorized domains** に、GitHub Pagesのドメイン（例：`username.github.io`）を追加します。`localhost` はローカル確認用です。

### 4. アプリから登録

公開したFocus Glassを開き、右上の「ログイン前」または設定画面の「ログインして同期」から、メールアドレスとパスワードを登録します。別端末でも同じアカウントでログインすると同期されます。

## 保存されるデータ

Firestoreでは次のパスに保存されます。

- `users/{uid}/sessions/{sessionId}`: 集中セッション
- `users/{uid}/meta/settings`: タイマー設定

FirebaseのWeb設定値は秘密鍵ではありません。データ保護には必ずFirestoreルールを適用してください。

## iPhone上の注意

- iOSはバックグラウンド中にJavaScriptを停止する場合があります。本アプリは「終了予定時刻」から残り時間を再計算するため、アプリを戻した時に時間がずれない設計です。
- 終了音と振動は、ブラウザや端末の消音設定によって動作しないことがあります。
- 画面消灯抑制はWake Lock API対応環境だけで有効です。

## 主なファイル

- `index.html`：画面構造
- `styles.css`：Liquid Glass UI
- `app.js`：タイマー、履歴、設定
- `cloud.js`：Firebase同期
- `firebase-config.js`：Firebase設定
- `sw.js` / `manifest.webmanifest`：PWA
- `firestore.rules`：同期データのアクセス制御
