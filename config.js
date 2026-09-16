// ─────────────────────────────────────────────────────────────
// DASHBOARD CONFIG — EXAMPLE
// ─────────────────────────────────────────────────────────────
// 1. Copy this file and rename it to: config.js
// 2. Fill in your values below
// 3. config.js is gitignored — it will never be committed
// ─────────────────────────────────────────────────────────────

window.DASHBOARD_CONFIG = {

  // Telegram Bot Token
  // Get this from @BotFather on Telegram
  TELEGRAM_TOKEN: "8248545561:AAH03GqpMD58hk1rVgVLbLo5sntu1lNPY_8",

  // Telegram Chat ID
  // The group or channel to send signals to
  TELEGRAM_CHAT_ID: "5926822072",

  // ── Auto-Trader Backend ───────────────────────────────────────
  // URL of your running server.js
  // Render production:     "https://mini-sol-dashboard.onrender.com"
  // Local development:     "http://localhost:3001"
  // Leave empty to run dashboard-only (no auto-trading)
  BOT_URL: "https://mini-sol-dashboard.onrender.com",
};
