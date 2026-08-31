# LINE監視システム（白谷塾オンライン / ローカルメディ）

生徒・保護者・講師のグループLINEを公式LINEアカウントで監視し、日報の停止・未回答の質問・個別指導後の共有漏れを自動検出するシステム。Cloudflare Workers + D1 で稼働。

- 本番URL: `https://line-monitor.<account>.workers.dev`
- 生徒グループへは**絶対に送信しない**（`send.ts` の多重ガードで講師グループ以外への送信をブロック）

## できること

| 機能 | 内容 |
|------|------|
| メッセージ収集 | webhook でリアルタイム受信。過去ログは `.txt` エクスポートをインポート |
| 定時分析（1日2回） | 朝8時・夜21時（JST）。日報停止（在籍状況に応じて2〜3日で判定）、24時間以上未回答の質問（Claude判定・双方向）、個別指導リンク（Zoom / Google Meet）投稿後の共有漏れを検出 |
| 通知 | 対応が必要なときだけ該当講師のグループへ。全体ダイジェストはSlackへ。`ANALYSIS_NOTIFY="1"` のときのみ実送信（試運転中は分析のみ） |
| 週次チェック | 月曜朝に講師の週次報告の提出状況を確認 |
| ダッシュボード | `/dashboard`。生徒一覧（状態別サマリーカード・検索・フィルタ）、要対応タブ（←→で1人ずつ確認）、日報カレンダー、直近の会話、アラート管理（チェックで自動保存） |

## 構成

```
src/
  index.ts          エントリ（webhook / admin API / cron / ルーティング）
  importer.ts       LINEトーク履歴 .txt のパーサ（冪等インポート）
  analyzer.ts       定時分析・通知文の生成
  queries.ts        analyzer/dashboard 共用のSQLヘルパ
  send.ts           LINE送信（講師グループ限定ガード）・Slack送信
  dashboard.ts      ダッシュボードAPI（アクセスキー認証）
  dashboard-html.ts ダッシュボード画面（単一HTML）
  types.ts          Env型
schema.sql          D1スキーマ
```

## セットアップ / 運用コマンド

```bash
npm install
npx tsc --noEmit                 # 型チェック
npx wrangler dev                 # ローカル起動（.dev.vars を使用）
npx wrangler deploy              # 本番デプロイ
npx wrangler d1 execute line-monitor --remote --file=schema.sql   # スキーマ適用
```

本番シークレット（`npx wrangler secret put <NAME>`）:
`LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` / `ADMIN_TOKEN` / `SLACK_WEBHOOK_URL` / `ANTHROPIC_API_KEY`

## 主なエンドポイント

| パス | 用途 |
|------|------|
| `POST /webhook` | LINE webhook（署名検証あり） |
| `GET /dashboard` | ダッシュボード（`?key=<token>` でログイン、以降Cookie） |
| `POST /admin/import` | 過去ログインポート（`Authorization: Bearer <ADMIN_TOKEN>`） |
| `GET/POST /admin/groups` | グループの種別・事業の設定 |
| `GET/POST /admin/students` | 生徒の登録・更新（Notionページ・グループ紐付け） |
| `POST /admin/dashboard-users` | ダッシュボード利用者の発行 |
| `POST /admin/run-analysis` | 分析の手動実行（`{"notify":false}` でドライラン） |

## メモ

- 分析の実通知は `wrangler.jsonc` の `ANALYSIS_NOTIFY` を `"1"` にして deploy すると有効になる
- 初期データ投入（グループ56件・生徒49名・過去ログ57ファイル）は2026-08-31に実施済み
- 莉羽さんのグループは別の公式LINE（リマインくん）が入っているため監視ボットは未参加
