# LINE監視システム（白谷塾オンライン / ローカルメディ）

生徒・保護者・講師のグループLINEを公式LINEアカウントで監視し、日報の停止・日報への未返信・未回答の質問・個別指導後の共有漏れを自動検出するシステム。Cloudflare Workers + D1 で稼働。

- 本番URL: `https://line-monitor.<account>.workers.dev`
- 生徒グループへは**絶対に送信しない**（`send.ts` の多重ガードで講師グループ以外への送信をブロック）

## できること

| 機能 | 内容 |
|------|------|
| メッセージ収集 | webhook でリアルタイム受信。過去ログは `.txt` エクスポートをインポート |
| 定時分析（1日2回） | 朝8時・夜21時（JST）。日報停止（在籍状況に応じて2〜3日で判定）、日報への未返信（14時間・Claude判定）、未回答の質問（12時間・Claude判定・双方向）、個別指導リンク（Zoom / Google Meet）投稿後の共有漏れを検出 |
| 通知 | 対応が必要なときだけ該当講師のグループへ。全体ダイジェストはSlackへ。`ANALYSIS_NOTIFY="1"` のときのみ実送信（試運転中は分析のみ） |
| 週次チェック | 月曜朝に講師の週次報告の提出状況を確認 |
| ダッシュボード | `/dashboard`。生徒一覧（状態別サマリーカード・検索・フィルタ）、要対応タブ（←→で1人ずつ確認）、日報カレンダー、直近の会話、アラート管理（チェックで自動保存） |

## 生徒マスタの正本はNotion

担当講師・在籍状況・志望校・体験開始日は **Notionの生徒DBが正本**。D1の `students` は
「LINEグループと生徒の対応表」と、Notionから流し込んだ写しを持つだけにする。

| 向き | 何を | いつ |
|------|------|------|
| Notion → D1 | 名前・事業・在籍状況・担当講師・志望校・体験開始日 | 朝の定時（分析の前）／`POST /admin/notion-sync` |
| D1 → Notion | `日報の状況`（テキスト）・`日報最終提出日`（日付） | 分析のあと毎回／`POST /admin/notion-writeback` |

書き戻した2列を社員向けのPLダッシュボード `/students` が読む。あちらはNotionだけを見るので、
LINEの実装を持ち込まずに日報の停滞まで1画面に出せる。

`POST /admin/students` で 名前・ステータス・担当講師・志望校・体験開始日 を送っても、
既存の生徒に対しては**無視して `ignored` で返す**（次の同期で上書きされるため）。
これらはNotionで直してから `/admin/notion-sync` を実行する。

D1にしか無い項目は `student_group_id` / `teacher_group_id` / `monitor_mode` / `notion_page_id` の4つ。

### 追加が必要な設定

```bash
npx wrangler secret put NOTION_TOKEN        # 生徒DB2つ＋講師DB3つに接続したインテグレーション
npx wrangler d1 execute line-monitor --remote --file=migrations/0005-notion-sync.sql
npx wrangler deploy
```

Notion側では、そのインテグレーションを次のDBに接続しておく（`…` → 接続）。
接続していない講師DBがあると、その講師の名前だけ空で同期される。

- R8 面談・体験生徒 / R8 生徒
- R8 オンライン講師 / R8 ローカルメディ講師 / R8 英検コース講師

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
  notion.ts         Notionとの同期（生徒マスタの取り込み・日報の状況の書き戻し）
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
| `POST /admin/notion-sync` | Notion → D1 の生徒マスタ同期 |
| `POST /admin/notion-writeback` | 分析を回して日報の状況をNotionへ書き戻す |

## メモ

- 分析の実通知は `wrangler.jsonc` の `ANALYSIS_NOTIFY` を `"1"` にして deploy すると有効になる
- 初期データ投入（グループ56件・生徒49名・過去ログ57ファイル）は2026-08-31に実施済み
- 莉羽さんのグループは別の公式LINE（リマインくん）が入っているため監視ボットは未参加
