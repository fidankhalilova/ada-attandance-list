const fs = require('fs');
const path = require('path');

// Memory store for Vercel / serverless runtime
const memoryStore = { sessions: {}, tokens: {}, submissions: {} };

const isVercel = Boolean(process.env.VERCEL);
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'attendance.json');

function load() {
  if (isVercel) return memoryStore;
  if (!fs.existsSync(DB_FILE)) return { sessions: {}, tokens: {}, submissions: {} };
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { sessions: {}, tokens: {}, submissions: {} };
  }
}

let state = load();

function save() {
  if (isVercel) return; // Skip disk writes on Vercel
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(state));
  } catch (err) {
    console.warn('File write skipped:', err.message);
  }
}

const db = {
  sessions: {
    create(session) {
      state.sessions[session.id] = session;
      save();
      return session;
    },
    get(id) {
      return state.sessions[id] || null;
    },
  },

  tokens: {
    create(token) {
      state.tokens[token.token] = token;
      save();
      return token;
    },
    get(token) {
      return state.tokens[token] || null;
    },
    latestForSession(sessionId) {
      const all = Object.values(state.tokens).filter(t => t.sessionId === sessionId);
      if (all.length === 0) return null;
      all.sort((a, b) => b.createdAt - a.createdAt);
      return all[0];
    },
    update(token, fields) {
      if (!state.tokens[token]) return null;
      Object.assign(state.tokens[token], fields);
      save();
      return state.tokens[token];
    },
  },

  submissions: {
    insert(sub) {
      const dup = Object.values(state.submissions).some(
        s => s.sessionId === sub.sessionId && s.studentId === sub.studentId
      );
      if (dup) {
        throw new Error('DUPLICATE');
      }
      state.submissions[sub.id] = sub;
      save();
      return sub;
    },
    forSession(sessionId) {
      return Object.values(state.submissions)
        .filter(s => s.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    countForSession(sessionId) {
      return this.forSession(sessionId).length;
    },
    recentForSession(sessionId, n) {
      return this.forSession(sessionId).slice(-n).reverse();
    },
  },
};

module.exports = db;