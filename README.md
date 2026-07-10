# GSNS — 流れるゲームSNS 🎮

TikTokのような縦スワイプフィードに、動画ではなく**遊べるゲーム**が流れてくるSNS。

**コアルール:** 各ゲームは「一番最初に閲覧した人」だけが実際に操作でき、そのプレイが記録されます。2人目以降の閲覧者には、最初のプレイヤーの操作が**2倍速リプレイ**として流れます。

*A TikTok-style vertical feed of playable games. The first viewer plays; everyone after watches the recorded run at 2x speed.*

## 機能

- 縦スワイプのゲームフィード(スクロールスナップ)
- ゲームのアップロード(単一HTMLファイル、2MBまで)
- 初回閲覧者のみ操作可能 → 操作を記録 → 以降は2倍速リプレイ
- 現在のゲーム+**次の2つを先読み**(ロード済み・時間停止状態で待機)
- いいね・コメント・シェア(ディープリンク `/?g=<id>`)
- PWA: ホーム画面に追加(Android/デスクトップはインストールプロンプト、iOSはSafariの共有→ホーム画面に追加)
- 日本語/英語UI(端末の言語で自動切替)

## 構成

- **データ**(ゲーム情報・いいね・コメント・リプレイ記録): Supabase **Database**(PostgreSQL)
- **ゲームHTMLファイル**: Supabase **Storage**(バケット `games`)。`SUPABASE_URL` 未設定時はローカルの `data/games/` に保存(開発用)
- **サーバー**: Node.js + Express(Render等の無料枠で稼働)

Supabaseにデータを置くため、**サーバーが再起動してもデータは消えません**(Render無料枠でもOK)。

## 起動方法

```bash
npm install
cp .env.example .env   # DATABASE_URL 等を記入(下記・READMEのSupabase手順参照)
npm start              # http://localhost:3000
```

初回起動時にテーブルが自動作成され、サンプルゲーム9本が自動投入されます(追加されたサンプルは既存環境でも次回起動時に投入されます)。

### 必要な環境変数(.env)

| 変数 | 取得場所 |
|---|---|
| `DATABASE_URL` | Supabase → 「Connect」→ Transaction pooler のURI(パスワードを埋める) |
| `SUPABASE_URL` | Supabase → Project Settings → Data API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API Keys → `service_role`(**秘密**) |

Supabase側の事前準備は2つだけ:
1. プロジェクトを作成(リージョンは Northeast Asia (Tokyo) 推奨)
2. Storage でバケット **`games`** を作成(Privateのままで良い)

## リプレイの仕組み

動画を録画・保存する方式はストレージ/帯域コストが高く「無料運営」と両立しないため、**入力リプレイ方式**を採用しています。

1. すべてのゲームに `harness.js` が注入され、実行環境を**決定的**にします:
   - `Math.random` → シード付き乱数(シードは記録に保存)
   - `performance.now` / `Date` / `requestAnimationFrame` / `setTimeout` / `setInterval` → 仮想時計
2. 初回プレイヤーのポインター/キー操作を仮想時刻付きで記録(最大90秒・座標は正規化)
3. リプレイ時は仮想時計を**2倍速**で進め、記録された操作を同じ仮想時刻に再ディスパッチ

仮想時計は親ページから `go` が届くまで0で停止するため、**先読みしたゲームは「ロード完了・開始前」で静止**し、スワイプした瞬間に始まります。

### ゲーム開発ガイド(リプレイを正確にするために)

- 乱数は `Math.random()` を使う(シード化されます)
- 時間は `requestAnimationFrame` のタイムスタンプか `performance.now()` を使う
- 物理演算は**固定タイムステップ**(蓄積方式)にするとリプレイが完全一致します
- アセットはHTML内にインライン(data URI等)で埋め込む(外部リクエスト不可)
- 入力は pointer / touch / mouse / keyboard イベント(リプレイ時は3系統すべて合成されます)
- 画面上部約60pxはアプリのUIと重なるためHUDは避ける

## セキュリティ

アップロードされたゲームは `sandbox="allow-scripts allow-pointer-lock"` の iframe(**allow-same-origin なし** = opaque origin)で実行され、本体ページ・Cookie・localStorage にアクセスできません。ただし**コンテンツのモデレーション(不適切な内容の通報・削除)は未実装**なので、公開運用の前に追加してください。

## デプロイ(無料構成)

**Render Free + Supabase Free = 月0円でデータ永続**の構成です。

1. Supabaseでプロジェクト作成 + バケット `games` 作成(上記)
2. [Render](https://render.com) → New → Web Service → このリポジトリを接続
   (`render.yaml` 同梱。Build: `npm install` / Start: `npm start`)
3. RenderのEnvironmentタブで `DATABASE_URL` / `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` を設定

| 無料枠の制限 | 内容 |
|---|---|
| Render Free | 15分アクセスがないとスリープ(次のアクセスで数十秒の起床待ち) |
| Supabase Free | DB 500MB / Storage 1GB / 帯域 5GB/月。**1週間アクセスがないとプロジェクトが一時停止**(ダッシュボードから再開可) |

> ゲーム1本平均100KBなら Storage 1GB ≒ 約1万本。リプレイはJSONでDB側なので軽量です。ユーザーが増えたら Supabase Pro ($25/mo) か帯域の安い構成へ。

## 既知の制限

- リプレイは決定的なゲームでは正確に再現されますが、フレームタイミング依存の物理(可変Δt)を使うゲームは2倍速再生時にわずかにズレることがあります(固定タイムステップで回避可能)
- 記録は最初の90秒まで
- 認証なし(匿名ID)。いいね・コメントは端末単位
- モデレーション機能なし
