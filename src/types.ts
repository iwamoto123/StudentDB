export interface Env {
  DB: D1Database;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ADMIN_TOKEN: string;
  SLACK_WEBHOOK_URL: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL?: string; // 未設定なら claude-haiku-4-5
  ANALYSIS_NOTIFY?: string; // "1" のときだけ定時実行が実際に通知する（wrangler.jsonc の vars で切り替え）
}
