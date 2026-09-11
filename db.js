const fs = require('fs');
const path = require('path');

const SCAN_GRACE_SECONDS = 120; // must match server.js
const TTL_BUFFER_SECONDS = 3600; // keep data around a bit past expiry, for debugging

const isVercel = Boolean(process.env.VERCEL);
const hasRedisCreds = Boolean(
  (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
  (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
);


let db;

if (isVercel && hasRedisCreds) {
  const { Redis } = require('@upstash/redis');
  const redis = Redis.fromEnv();

  db = {
    sessions: {
      async create(session) {
        const ttl = Math.max(60, Math.ceil((session.endsAt - Date.now()) / 1000) + TTL_BUFFER_SECONDS);
        await redis.set(`session:${session.id}`, session, { ex: ttl });
        return session;
      },
      async get(id) {
        const s = await redis.get(`session:${id}`);
        return s || null;
      },
    },

    tokens: {
      async create(token) {
        const ttl = Math.max(60, Math.ceil((token.expiresAt - Date.now()) / 1000) + SCAN_GRACE_SECONDS + 60);
        await redis.set(`token:${token.token}`, token, { ex: ttl });
        await redis.set(`curtoken:${token.sessionId}`, token.token, { ex: ttl });
        return token;
      },
      async get(tokenStr) {
        const t = await redis.get(`token:${tokenStr}`);
        return t || null;
      },
      async latestForSession(sessionId) {
        const tokenStr = await redis.get(`curtoken:${sessionId}`);
        if (!tokenStr) return null;
        return db.tokens.get(tokenStr);
      },
      async update(tokenStr, fields) {
        const existing = await db.tokens.get(tokenStr);
        if (!existing) return null;
        const updated = { ...existing, ...fields };
        const ttl = Math.max(60, Math.ceil((existing.expiresAt - Date.now()) / 1000) + SCAN_GRACE_SECONDS + 60);
        await redis.set(`token:${tokenStr}`, updated, { ex: ttl });
        return updated;
      },
    },

    submissions: {
      async insert(sub) {
        const key = `subs:${sub.sessionId}`;
        // HSETNX is atomic: only sets the field if it doesn't already exist.
        // This is what enforces "one submission per Student ID per session"
        // safely even if two requests race each other.
        const added = await redis.hsetnx(key, sub.studentId, sub);
        if (!added) {
          throw new Error('DUPLICATE');
        }
        await redis.expire(key, 60 * 60 * 24); // keep submissions ~24h
        return sub;
      },
      async forSession(sessionId) {
        const map = await redis.hgetall(`subs:${sessionId}`);
        if (!map) return [];
        const list = Object.values(map).map(v => (typeof v === 'string' ? JSON.parse(v) : v));
        list.sort((a, b) => a.createdAt - b.createdAt);
        return list;
      },
      async countForSession(sessionId) {
        return (await db.submissions.forSession(sessionId)).length;
      },
      async recentForSession(sessionId, n) {
        return (await db.submissions.forSession(sessionId)).slice(-n).reverse();
      },
    },
  };
} else if (isVercel) {
  console.warn(
    '[db.js] No Redis credentials found (KV_REST_API_URL/TOKEN or ' +
    'UPSTASH_REDIS_REST_URL/TOKEN). Falling back to in-memory storage, ' +
    'which will NOT be shared across serverless instances. Add an Upstash ' +
    'Redis integration from the Vercel Marketplace to fix this properly.'
  );
  const memoryStore = { sessions: {}, tokens: {}, submissions: {} };

  db = {
    sessions: {
      async create(session) {
        memoryStore.sessions[session.id] = session;
        return session;
      },
      async get(id) {
        return memoryStore.sessions[id] || null;
      },
    },
    tokens: {
      async create(token) {
        memoryStore.tokens[token.token] = token;
        return token;
      },
      async get(tokenStr) {
        return memoryStore.tokens[tokenStr] || null;
      },
      async latestForSession(sessionId) {
        const all = Object.values(memoryStore.tokens).filter(t => t.sessionId === sessionId);
        if (all.length === 0) return null;
        all.sort((a, b) => b.createdAt - a.createdAt);
        return all[0];
      },
      async update(tokenStr, fields) {
        if (!memoryStore.tokens[tokenStr]) return null;
        Object.assign(memoryStore.tokens[tokenStr], fields);
        return memoryStore.tokens[tokenStr];
      },
    },
    submissions: {
      async insert(sub) {
        const dup = Object.values(memoryStore.submissions).some(
          s => s.sessionId === sub.sessionId && s.studentId === sub.studentId
        );
        if (dup) throw new Error('DUPLICATE');
        memoryStore.submissions[sub.id] = sub;
        return sub;
      },
      async forSession(sessionId) {
        return Object.values(memoryStore.submissions)
          .filter(s => s.sessionId === sessionId)
          .sort((a, b) => a.createdAt - b.createdAt);
      },
      async countForSession(sessionId) {
        return (await db.submissions.forSession(sessionId)).length;
      },
      async recentForSession(sessionId, n) {
        return (await db.submissions.forSession(sessionId)).slice(-n).reverse();
      },
    },
  };
} else {
  // ---- Local dev backend: a JSON file on disk ----
  const DATA_DIR = path.join(process.cwd(), 'data');
  const DB_FILE = path.join(DATA_DIR, 'attendance.json');

  function load() {
    if (!fs.existsSync(DB_FILE)) return { sessions: {}, tokens: {}, submissions: {} };
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      return { sessions: {}, tokens: {}, submissions: {} };
    }
  }

  let state = load();

  function save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(state));
    } catch (err) {
      console.warn('File write skipped:', err.message);
    }
  }

  db = {
    sessions: {
      async create(session) {
        state.sessions[session.id] = session;
        save();
        return session;
      },
      async get(id) {
        return state.sessions[id] || null;
      },
    },
    tokens: {
      async create(token) {
        state.tokens[token.token] = token;
        save();
        return token;
      },
      async get(tokenStr) {
        return state.tokens[tokenStr] || null;
      },
      async latestForSession(sessionId) {
        const all = Object.values(state.tokens).filter(t => t.sessionId === sessionId);
        if (all.length === 0) return null;
        all.sort((a, b) => b.createdAt - a.createdAt);
        return all[0];
      },
      async update(tokenStr, fields) {
        if (!state.tokens[tokenStr]) return null;
        Object.assign(state.tokens[tokenStr], fields);
        save();
        return state.tokens[tokenStr];
      },
    },
    submissions: {
      async insert(sub) {
        const dup = Object.values(state.submissions).some(
          s => s.sessionId === sub.sessionId && s.studentId === sub.studentId
        );
        if (dup) throw new Error('DUPLICATE');
        state.submissions[sub.id] = sub;
        save();
        return sub;
      },
      async forSession(sessionId) {
        return Object.values(state.submissions)
          .filter(s => s.sessionId === sessionId)
          .sort((a, b) => a.createdAt - b.createdAt);
      },
      async countForSession(sessionId) {
        return (await db.submissions.forSession(sessionId)).length;
      },
      async recentForSession(sessionId, n) {
        return (await db.submissions.forSession(sessionId)).slice(-n).reverse();
      },
    },
  };
}

module.exports = db;
