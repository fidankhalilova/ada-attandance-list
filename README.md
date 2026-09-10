# QR Attendance App

A simple attendance system: instructor displays a rotating QR code, students scan
and submit their name/surname/Student ID, instructor downloads an Excel sheet.

## How it prevents cheating

1. **QR rotates every 30 seconds.** Each code is only "live" for 30s, so a photo
   shared in a group chat is stale almost immediately.
2. **Each QR code is single-use.** The moment one student opens the form from a
   code, that code is marked used — a second person scanning the same code
   (even seconds later, even from a screenshot taken in time) gets rejected.
3. **One Student ID per session, enforced in the database.** This is the main
   defense against "I'll submit for my friend too" — even if someone gets a
   valid, unused code to a friend, the friend's real ID can still only be
   submitted once per class. If they try to submit with their *own* ID after
   already using their friend's, the ID mismatch or duplicate check catches it.
4. **IP address is logged per submission but NOT used to hard-block.**
   Classroom/campus WiFi commonly puts many devices behind the same public IP
   (NAT), so blocking by IP causes false positives for legitimate students.
   Instead, the exported Excel file flags "Shared IP" rows so the instructor
   can eyeball anything suspicious (e.g. 5 submissions from one IP in 10
   seconds) without blocking innocent students automatically.
5. **Optional roster check.** If you paste in a class list when creating the
   session, every submission is checked against it and flagged in the export.

### Things this does NOT fully solve (be aware)
- A student could still hand their *unlocked phone* to a friend to submit in
  person — no software fix for that, it's a supervision issue.
- IP flags are informational only, not proof of cheating (shared WiFi is normal).
- Someone very fast could photograph and forward a QR code within the 30s
  window — the single-use lock handles this as long as the real student
  scans first, but if the friend scans *before* the real student does, the
  real student would be locked out. Best practice: tell students to scan the
  QR **as soon as it appears** rather than waiting.

## Local setup

```bash
npm install
npm start
```

Then open:
- `http://localhost:3000/instructor.html` — create a session (as the instructor)
- The link it gives you (`display.html?...`) — open **that** on the
  projector/classroom screen
- Students scan the QR with their phone camera, which opens `/s/:token`

## Deploying to a real server

This is a standard Node.js + Express app, so it deploys anywhere Node runs:

**Option A — Render / Railway / Fly.io (easiest)**
1. Push this folder to a GitHub repo.
2. Create a new Web Service pointing at it. Build command: `npm install`.
   Start command: `npm start`.
3. Set the environment variable `PUBLIC_BASE_URL` to your deployed URL
   (e.g. `https://your-app.onrender.com`) — this is what gets embedded in the
   QR codes, so it must be the real public URL, not `localhost`.

**Option B — Your own VPS**
1. Install Node.js 18+, copy this folder over.
2. `npm install --production`
3. Run with a process manager so it survives reboots/crashes, e.g.:
   `npm install -g pm2 && pm2 start server.js --name attendance`
4. Put Nginx in front for HTTPS (required — camera access for QR scanning
   needs HTTPS on the student's browser) and set `PUBLIC_BASE_URL` accordingly.

**Database**: currently SQLite (a single file in `data/attendance.db`) — fine
for a single instructor / moderate class sizes. If you need multiple
instructors hitting it concurrently at scale, swap `better-sqlite3` for
Postgres later; the query patterns are simple and will translate directly.

## Config knobs (top of `server.js`)

- `TOKEN_ACTIVE_SECONDS` — how long each QR code is "current" (default 30s)
- `SCAN_GRACE_SECONDS` — how long a student has to finish the form after
  scanning, even after the QR has moved on (default 120s)

## Security notes for production

- The "admin key" generated per session is a simple shared secret — good
  enough for a solo instructor, but if multiple instructors will use this,
  add real login (e.g. a login page + sessions) before deploying widely.
- Consider rate-limiting `/api/submit` (e.g. with `express-rate-limit`) to
  block scripted submission attempts.
- Back up or export the `data/attendance.db` file periodically if you're
  running this long-term without a separate database.
