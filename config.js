//window.DASHBOARD_CONFIG = {
 // TELEGRAM_TOKEN:   "8248545561:AAH03GqpMD58hk1rVgVLbLo5sntu1lNPY_8",
 // TELEGRAM_CHAT_ID: "5926822072",
 // BOT_URL:          "http://localhost:3001",
//};
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
  // Example: "7412345678:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  TELEGRAM_TOKEN: "8248545561:AAH03GqpMD58hk1rVgVLbLo5sntu1lNPY_8",

  // Telegram Chat ID
  // The group or channel to send signals to
  // For a group: add your bot, send a message, then visit:
  //   https://api.telegram.org/bot{YOUR_TOKEN}/getUpdates
  //   and look for "chat": { "id": -XXXXXXXXX }
  // Example: "-1001234567890"
  TELEGRAM_CHAT_ID: "5926822072",


  // ── Auto-Trader Backend ───────────────────────────────────────
  // URL of your running server.js
  // Local (same machine):  "http://localhost:3001"
  // Remote VPS:            "http://YOUR_SERVER_IP:3001"
  // Leave empty to run dashboard-only (no auto-trading)
  //BOT_URL: "https://localhost:3001",
 BOT_URL: "https://mini-sol-dashboard.onrender.com/",
};
