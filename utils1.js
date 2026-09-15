'use strict';
const fs = require('fs');

function log(msg) {
  const ts = new Date().toISOString().replace('T',' ').slice(0,19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync('bot.log', line + '\n'); } catch(e) {}
}

function loadState(file, defaultFn) {
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // If saved state is from a different day, start fresh
      const today = new Date().toISOString().slice(0,10);
      if (raw.date === today) { log(`State loaded from ${file}`); return raw; }
    }
  } catch(e) { log('State load failed: ' + e.message); }
  const s = defaultFn();
  log('Starting fresh state');
  return s;
}

function saveState(file, state) {
  try { fs.writeFileSync(file, JSON.stringify(state, null, 2)); }
  catch(e) { log('State save failed: ' + e.message); }
}

module.exports = { log, loadState, saveState };
