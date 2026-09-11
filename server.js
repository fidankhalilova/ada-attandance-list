const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const cookieParser = require('cookie-parser');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static assets safely
const publicPath = path.join(process.cwd(), 'public');
app.use(express.static(publicPath));

// Root route: send visitors straight to the instructor dashboard.
// A redirect touches no files at all, so it can't crash on Vercel's
// read-only filesystem the way res.sendFile() could. On Vercel itself,
// vercel.json also redirects "/" -> "/instructor.html" at the CDN edge,
// before this route is even reached; this handler is the local-dev/
// fallback path.
app.get('/', (req, res) => {
  res.redirect('/instructor.html');
});

// Config
const TOKEN_ACTIVE_SECONDS = 30;
const SCAN_GRACE_SECONDS = 120;
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);

function now() { return Date.now(); }
function genKey() { return crypto.randomBytes(16).toString('hex'); }

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// INSTRUCTOR: create a session
app.post('/api/sessions', async (req, res) => {
  try {
    const { name, durationMinutes } = req.body;
    if (!name || !durationMinutes) {
      return res.status(400).json({ error: 'name and durationMinutes are required' });
    }
    const id = crypto.randomUUID();
    const adminKey = genKey();
    const createdAt = now();
    const endsAt = createdAt + Math.round(Number(durationMinutes) * 60 * 1000);

    const session = { id, name, adminKey, createdAt, endsAt };
    await db.sessions.create(session);

    res.json({ sessionId: id, adminKey, endsAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// INSTRUCTOR: get/rotate current QR token
app.get('/api/sessions/:id/token', async (req, res) => {
  try {
    const session = await db.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (session.adminKey !== req.query.adminKey) return res.status(403).json({ error: 'invalid admin key' });

    const t = now();
    if (t > session.endsAt) {
      return res.json({ ended: true });
    }

    let token = await db.tokens.latestForSession(session.id);

    if (!token || t > token.expiresAt) {
      const tokenStr = crypto.randomBytes(12).toString('hex');
      const expiresAt = t + TOKEN_ACTIVE_SECONDS * 1000;
      token = { token: tokenStr, sessionId: session.id, createdAt: t, expiresAt, consumed: false, consumedAt: null, submitted: false };
      await db.tokens.create(token);
    }

    const scanUrl = `${baseUrl(req)}/s/${token.token}`;
    QRCode.toDataURL(scanUrl, { margin: 1, width: 320 }, (err, dataUrl) => {
      if (err) return res.status(500).json({ error: 'qr generation failed' });
      res.json({
        ended: false,
        qr: dataUrl,
        expiresInSeconds: Math.max(0, Math.round((token.expiresAt - t) / 1000)),
        sessionEndsInSeconds: Math.max(0, Math.round((session.endsAt - t) / 1000)),
      });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// INSTRUCTOR: live stats
app.get('/api/sessions/:id/stats', async (req, res) => {
  try {
    const session = await db.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (session.adminKey !== req.query.adminKey) return res.status(403).json({ error: 'invalid admin key' });

    const count = await db.submissions.countForSession(session.id);
    const recentRaw = await db.submissions.recentForSession(session.id, 10);
    const recent = recentRaw
      .map(s => ({ name: s.name, surname: s.surname, studentId: s.studentId, createdAt: s.createdAt }));
    res.json({ count, recent, sessionName: session.name, endsAt: session.endsAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// STUDENT: open a scanned link
app.get('/s/:token', async (req, res) => {
  try {
    const t = now();
    const token = await db.tokens.get(req.params.token);

    const errorPage = (message) => res.send(renderError(message));
    const cookieName = `att_${req.params.token}`;
    const ownerSecretFromCookie = req.cookies[cookieName];

    if (!token) return errorPage('This QR code is invalid.');

    const session = await db.sessions.get(token.sessionId);
    if (!session || t > session.endsAt) return errorPage('Attendance for this class has closed.');

    if (!token.consumed) {
      if (t > token.expiresAt) {
        return errorPage('This QR code has expired. Please scan the current code on the screen.');
      }
      const ownerSecret = crypto.randomBytes(8).toString('hex');
      await db.tokens.update(token.token, { consumed: true, consumedAt: t, ownerSecret });
      res.cookie(cookieName, ownerSecret, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SCAN_GRACE_SECONDS * 1000,
      });
      return res.send(renderForm(token.token));
    }

    const isOwner = ownerSecretFromCookie && ownerSecretFromCookie === token.ownerSecret;

    if (!isOwner) {
      return errorPage('This QR code has already been used. Please scan the current code on the screen.');
    }

    if (token.submitted) {
      return res.send(renderAlreadySubmitted());
    }
    if (t > token.consumedAt + SCAN_GRACE_SECONDS * 1000) {
      return errorPage('Time expired. Please scan the current QR code on the screen and try again.');
    }
    return res.send(renderForm(token.token));
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// STUDENT: submit attendance
app.post('/api/submit', async (req, res) => {
  try {
    const { token, name, surname, studentId } = req.body;
    const t = now();

    if (!token || !name || !surname || !studentId) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    const tokenRow = await db.tokens.get(token);
    if (!tokenRow) return res.status(400).json({ error: 'Invalid session link.' });
    if (!tokenRow.consumed) return res.status(400).json({ error: 'Please open this form by scanning the QR code again.' });
    if (tokenRow.submitted) return res.status(400).json({ error: 'This code has already been used to submit attendance.' });
    if (t > tokenRow.consumedAt + SCAN_GRACE_SECONDS * 1000) {
      return res.status(400).json({ error: 'Time expired. Please scan the current QR code on the screen and try again.' });
    }

    const session = await db.sessions.get(tokenRow.sessionId);
    if (!session || t > session.endsAt) {
      return res.status(400).json({ error: 'Attendance for this class has closed.' });
    }

    const cleanStudentId = String(studentId).trim();
    const ip = req.ip;

    const sub = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      studentId: cleanStudentId,
      name: name.trim(),
      surname: surname.trim(),
      token,
      ip,
      createdAt: t,
    };

    try {
      await db.submissions.insert(sub);
    } catch (e) {
      if (e.message === 'DUPLICATE') {
        return res.status(409).json({ error: 'This Student ID has already submitted attendance for this session.' });
      }
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }

    await db.tokens.update(token, { submitted: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// INSTRUCTOR: export to Excel
app.get('/api/sessions/:id/export', async (req, res) => {
  try {
    const session = await db.sessions.get(req.params.id);
    if (!session) return res.status(404).send('Session not found');
    if (session.adminKey !== req.query.adminKey) return res.status(403).send('Invalid admin key');

    const rows = await db.submissions.forSession(session.id);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Attendance');
    sheet.columns = [
      { header: 'Name', key: 'name', width: 18 },
      { header: 'Surname', key: 'surname', width: 18 },
      { header: 'Student ID', key: 'studentId', width: 18 },
      { header: 'Submitted At', key: 'submittedAt', width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };

    rows.forEach(r => {
      sheet.addRow({
        name: r.name,
        surname: r.surname,
        studentId: r.studentId,
        submittedAt: new Date(r.createdAt).toLocaleString(),
      });
    });

    const safeName = session.name.replace(/[^a-z0-9]/gi, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_attendance.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).send('Error generating export file');
  }
});

function renderAlreadySubmitted() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Attendance</title><style>${sharedStyles()}</style></head><body><div class="card"><h2>Attendance recorded</h2><p>You can close this page.</p></div></body></html>`;
}

function renderError(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Attendance</title><style>${sharedStyles()}</style></head><body><div class="card"><h2>⚠️ ${escapeHtml(message)}</h2></div></body></html>`;
}

function renderForm(token) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mark Attendance</title><style>${sharedStyles()}</style></head><body><div class="card"><h2>Mark Attendance</h2><form id="f"><input type="hidden" name="token" value="${escapeHtml(token)}"><label>First Name</label><input name="name" required><label>Surname</label><input name="surname" required><label>Student ID</label><input name="studentId" required><button type="submit">Submit</button></form><div id="msg"></div></div></body></html>`;
}

function sharedStyles() {
  return `body { font-family: sans-serif; background:#f4f5f7; display:flex; min-height:100vh; align-items:center; justify-content:center; } .card { background:#fff; padding:30px; border-radius:10px; width:300px; }`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Catch-all error handler. Without this, an error thrown in middleware
// (bad JSON body, cookie parsing, etc.) or an error passed to next(err)
// can leave the function in an undefined state instead of a clean 500.
// This must be defined last, after all routes.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Attendance app running at http://localhost:${PORT}/instructor.html`);
  });
}

module.exports = app;