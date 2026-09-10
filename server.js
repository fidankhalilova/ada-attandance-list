const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'instructor.html'));
});

// ---- Config ----
const TOKEN_ACTIVE_SECONDS = 30;   // how long a QR is the "current" one on screen
const SCAN_GRACE_SECONDS = 120;    // how long a student has to finish the form after scanning
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);

function now() { return Date.now(); }
function genKey() { return crypto.randomBytes(16).toString('hex'); }

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// ============ INSTRUCTOR: create a session ============
app.post('/api/sessions', (req, res) => {
  const { name, durationMinutes } = req.body;
  if (!name || !durationMinutes) {
    return res.status(400).json({ error: 'name and durationMinutes are required' });
  }
  const id = uuidv4();
  const adminKey = genKey();
  const createdAt = now();
  const endsAt = createdAt + Math.round(Number(durationMinutes) * 60 * 1000);

  const session = { id, name, adminKey, createdAt, endsAt };
  db.sessions.create(session);

  res.json({ sessionId: id, adminKey, endsAt });
});

// ============ INSTRUCTOR: get/rotate current QR token ============
app.get('/api/sessions/:id/token', (req, res) => {
  const session = db.sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.adminKey !== req.query.adminKey) return res.status(403).json({ error: 'invalid admin key' });

  const t = now();
  if (t > session.endsAt) {
    return res.json({ ended: true });
  }

  let token = db.tokens.latestForSession(session.id);

  if (!token || t > token.expiresAt) {
    const tokenStr = crypto.randomBytes(12).toString('hex');
    const expiresAt = t + TOKEN_ACTIVE_SECONDS * 1000;
    token = { token: tokenStr, sessionId: session.id, createdAt: t, expiresAt, consumed: false, consumedAt: null, submitted: false };
    db.tokens.create(token);
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
});

// ============ INSTRUCTOR: live stats ============
app.get('/api/sessions/:id/stats', (req, res) => {
  const session = db.sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.adminKey !== req.query.adminKey) return res.status(403).json({ error: 'invalid admin key' });

  const count = db.submissions.countForSession(session.id);
  const recent = db.submissions.recentForSession(session.id, 10)
    .map(s => ({ name: s.name, surname: s.surname, studentId: s.studentId, createdAt: s.createdAt }));
  res.json({ count, recent, sessionName: session.name, endsAt: session.endsAt });
});

// ============ STUDENT: open a scanned link ============
app.get('/s/:token', (req, res) => {
  const t = now();
  const token = db.tokens.get(req.params.token);

  const errorPage = (message) => res.send(renderError(message));
  const cookieName = `att_${req.params.token}`;
  const ownerSecretFromCookie = req.cookies[cookieName];

  if (!token) return errorPage('This QR code is invalid.');

  const session = db.sessions.get(token.sessionId);
  if (!session || t > session.endsAt) return errorPage('Attendance for this class has closed.');

  if (!token.consumed) {
    // Genuinely the first person to open this code.
    if (t > token.expiresAt) {
      return errorPage('This QR code has expired. Please scan the current code on the screen.');
    }
    const ownerSecret = crypto.randomBytes(8).toString('hex');
    db.tokens.update(token.token, { consumed: true, consumedAt: t, ownerSecret });
    res.cookie(cookieName, ownerSecret, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SCAN_GRACE_SECONDS * 1000,
    });
    return res.send(renderForm(token.token));
  }

  // Already consumed — is this the same browser (a refresh), or someone else?
  const isOwner = ownerSecretFromCookie && ownerSecretFromCookie === token.ownerSecret;

  if (!isOwner) {
    return errorPage('This QR code has already been used. Please scan the current code on the screen.');
  }

  // It's the same student reloading their own page.
  if (token.submitted) {
    return res.send(renderAlreadySubmitted());
  }
  if (t > token.consumedAt + SCAN_GRACE_SECONDS * 1000) {
    return errorPage('Time expired. Please scan the current QR code on the screen and try again.');
  }
  return res.send(renderForm(token.token));
});

// ============ STUDENT: submit attendance ============
app.post('/api/submit', (req, res) => {
  const { token, name, surname, studentId } = req.body;
  const t = now();

  if (!token || !name || !surname || !studentId) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const tokenRow = db.tokens.get(token);
  if (!tokenRow) return res.status(400).json({ error: 'Invalid session link.' });
  if (!tokenRow.consumed) return res.status(400).json({ error: 'Please open this form by scanning the QR code again.' });
  if (tokenRow.submitted) return res.status(400).json({ error: 'This code has already been used to submit attendance.' });
  if (t > tokenRow.consumedAt + SCAN_GRACE_SECONDS * 1000) {
    return res.status(400).json({ error: 'Time expired. Please scan the current QR code on the screen and try again.' });
  }

  const session = db.sessions.get(tokenRow.sessionId);
  if (!session || t > session.endsAt) {
    return res.status(400).json({ error: 'Attendance for this class has closed.' });
  }

  const cleanStudentId = String(studentId).trim();
  const ip = req.ip;

  const sub = {
    id: uuidv4(),
    sessionId: session.id,
    studentId: cleanStudentId,
    name: name.trim(),
    surname: surname.trim(),
    token,
    ip,
    createdAt: t,
  };

  try {
    db.submissions.insert(sub);
  } catch (e) {
    if (e.message === 'DUPLICATE') {
      return res.status(409).json({ error: 'This Student ID has already submitted attendance for this session.' });
    }
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  db.tokens.update(token, { submitted: true });
  res.json({ success: true });
});

// ============ INSTRUCTOR: export to Excel ============
app.get('/api/sessions/:id/export', async (req, res) => {
  const session = db.sessions.get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  if (session.adminKey !== req.query.adminKey) return res.status(403).send('Invalid admin key');

  const rows = db.submissions.forSession(session.id);

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
});

function renderAlreadySubmitted() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Attendance</title>
  <style>${sharedStyles()}</style></head>
  <body><div class="card"><h2>Attendance recorded</h2><p>You can close this page.</p></div></body></html>`;
}

function renderError(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Attendance</title>
  <style>${sharedStyles()}</style></head>
  <body><div class="card"><h2>⚠️ ${escapeHtml(message)}</h2></div></body></html>`;
}

function renderForm(token) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mark Attendance</title>
  <style>${sharedStyles()}</style></head>
  <body>
  <div class="card">
    <h2>Mark Attendance</h2>
    <form id="f">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <label>First Name</label>
      <input name="name" required autocomplete="given-name">
      <label>Surname</label>
      <input name="surname" required autocomplete="family-name">
      <label>Student ID</label>
      <input name="studentId" required autocomplete="off" inputmode="numeric">
      <button type="submit">Submit</button>
    </form>
    <div id="msg"></div>
  </div>
  <script>
    const f = document.getElementById('f');
    const msg = document.getElementById('msg');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(f).entries());
      f.querySelector('button').disabled = true;
      try {
        const r = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const j = await r.json();
        if (r.ok) {
          document.querySelector('.card').innerHTML = '<h2>Attendance recorded</h2><p>You can close this page.</p>';
        } else {
          msg.textContent = j.error || 'Something went wrong.';
          msg.className = 'error';
          f.querySelector('button').disabled = false;
        }
      } catch (err) {
        msg.textContent = 'Network error, please try again.';
        msg.className = 'error';
        f.querySelector('button').disabled = false;
      }
    });
  </script>
  </body></html>`;
}

function sharedStyles() {
  return `
    body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#f4f5f7; margin:0; display:flex; min-height:100vh; align-items:center; justify-content:center; }
    .card { background:#fff; padding:32px 28px; border-radius:14px; box-shadow:0 2px 12px rgba(0,0,0,0.08); width:90%; max-width:380px; }
    h2 { margin-top:0; }
    label { display:block; margin:14px 0 6px; font-size:14px; color:#444; }
    input { width:100%; padding:10px 12px; border:1px solid #ccc; border-radius:8px; font-size:16px; box-sizing:border-box; }
    button { margin-top:20px; width:100%; padding:12px; border:none; border-radius:8px; background:#2563eb; color:#fff; font-size:16px; font-weight:600; cursor:pointer; }
    button:disabled { opacity:0.6; }
    .error { color:#dc2626; margin-top:12px; font-size:14px; }
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Attendance app running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT}/instructor.html to create a session.`);
  });
}

module.exports = app;