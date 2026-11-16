const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const db = require('./db');

const REPO = 'SINOBI-Melloflex/Optima-SN';
const HTTP_PORT = 4015;
const BK = process.env.OPTIMASN_BACKUP || path.join(__dirname, 'data', 'backups');
const UPD_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'OptimaSN-Update');
let busy = false;

function version() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch (e) { return '0.0.0'; } }
function newer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
function newest(dir, depth) {
  let best = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0) best = Math.max(best, newest(f, depth - 1)); }
      else if (/^optimasn_.*\.db$/i.test(e.name)) { try { best = Math.max(best, fs.statSync(f).mtimeMs); } catch (x) {} }
    }
  } catch (x) {}
  return best;
}
function fmtT(ms) {
  if (!ms) return 'none yet';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function lan() {
  const out = [], n = os.networkInterfaces();
  for (const k of Object.keys(n)) for (const a of (n[k] || [])) {
    if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push({ name: k, ip: a.address });
  }
  return out;
}
function configured() { return REPO.indexOf('/') > 0 && REPO.indexOf('__') !== 0 && REPO.indexOf('YOUR-NAME') !== 0; }
async function latest() {
  if (!configured()) throw new Error('The update source is not set up yet. Please contact your supplier.');
  const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
    headers: { 'User-Agent': 'OptimaSN-Updater', 'Accept': 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000)
  });
  if (r.status === 404) throw new Error('No update has been published yet.');
  if (!r.ok) throw new Error('The update server answered with code ' + r.status + '.');
  const j = await r.json();
  const a = (j.assets || []).find(x => /^OptimaSN-Setup-.*\.exe$/i.test(x.name));
  return { tag: String(j.tag_name || ''), url: a ? a.browser_download_url : '', digest: a && a.digest ? String(a.digest) : '' };
}
function run(exe, args) {
  return new Promise(resolve => execFile(exe, args, { windowsHide: true, timeout: 60000 }, (err, so, se) => resolve({ ok: !err, text: String(so || '') + String(se || '') })));
}

module.exports = function (app) {
  app.post('/api/system/sync-backup', (req, res) => {
    if (!isAdm(req)) return res.status(403).json({ ok: false, msg: 'Admins only.' });
    const guardPath = path.join(__dirname, 'tunnel', 'guard.js');
    execFile(process.execPath, [guardPath], { timeout: 30000 }, (err, so, se) => {
      const out = String(so || '') + String(se || '');
      let logTail = '';
      try { const lg = path.join(__dirname, 'data', 'guard.log'); logTail = fs.readFileSync(lg, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch (e) {}
      res.json({ ok: !err, output: out.trim(), log: logTail });
    });
  });

  app.get('/api/system/guard-log', (req, res) => {
    if (!isAdm(req)) return res.status(403).json({ ok: false, msg: 'Admins only.' });
    try {
      const lg = path.join(__dirname, 'data', 'guard.log');
      const lines = fs.readFileSync(lg, 'utf8').trim().split('\n').slice(-5);
      res.json({ ok: true, lines });
    } catch (e) { res.json({ ok: true, lines: [] }); }
  });

  app.post('/api/system/sync-backup', (req, res) => {
    if (!isAdm(req)) return res.status(403).json({ ok: false, msg: 'Admins only.' });
    const guardPath = path.join(__dirname, 'tunnel', 'guard.js');
    execFile(process.execPath, [guardPath], { timeout: 30000 }, (err, so, se) => {
      const out = String(so || '') + String(se || '');
      let logTail = '';
      try { const lg = path.join(__dirname, 'data', 'guard.log'); logTail = fs.readFileSync(lg, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch (e) {}
      res.json({ ok: !err, output: out.trim(), log: logTail });
    });
  });

  app.get('/api/system/guard-log', (req, res) => {
    if (!isAdm(req)) return res.status(403).json({ ok: false, msg: 'Admins only.' });
    try {
      const lg = path.join(__dirname, 'data', 'guard.log');
      const lines = fs.readFileSync(lg, 'utf8').trim().split('\n').slice(-5);
      res.json({ ok: true, lines });
    } catch (e) { res.json({ ok: true, lines: [] }); }
  });

  const isAdm = req => !!(req.user && req.user.admin);

  app.get('/system', (req, res) => {
    if (!isAdm(req)) return res.status(403).send('Only an admin can open this page.');
    let health = 'unknown';
    try { health = db.pragma('quick_check', { simple: true }) === 'ok' ? 'Healthy' : 'DAMAGED'; } catch (e) {}
    res.render('system', { health, backup: fmtT(newest(BK, 3)), version: version() });
  });

  app.get('/api/system/info', (req, res) => {
    if (!isAdm(req)) return res.status(403).json({ ok: false, msg: 'Admins only.' });
    res.json({ ok: true, version: version(), addrs: lan(), httpPort: HTTP_PORT });
  });

  app.get('/api/system/update/check', async (req, res) => {
    if (!isAdm(req)) return res.status(403).json({ ok: false, msg: 'Admins only.' });
    try {
      const L = await latest();
      res.json({ ok: true, current: version(), latest: L.tag.replace(/^v/i, ''), available: newer(L.tag, version()) && !!L.url });
    } catch (e) {
      res.json({ ok: false, msg: (e && e.message) ? e.message : 'Could not check for updates. Please check your internet connection.' });
    }
  });

  app.post('/api/system/update/install', async (req, res) => {
    if (!isAdm(req)) return res.status(403).json({ ok: false, msg: 'Admins only.' });
    if (!req.is('json')) return res.status(400).json({ ok: false, msg: 'Bad request.' });
    if (busy) return res.json({ ok: false, msg: 'An update is already in progress.' });
    busy = true;
    try {
      const L = await latest();
      if (!newer(L.tag, version())) return res.json({ ok: false, msg: 'You already have the latest version.' });
      if (!L.url || L.url.indexOf('https://github.com/' + REPO + '/releases/download/') !== 0) return res.json({ ok: false, msg: 'The update file was not found.' });
      fs.mkdirSync(UPD_DIR, { recursive: true });
      const file = path.join(UPD_DIR, 'OptimaSN-Setup-update.exe');
      const r = await fetch(L.url, { redirect: 'follow', signal: AbortSignal.timeout(20 * 60 * 1000) });
      if (!r.ok) return res.json({ ok: false, msg: 'Download failed (code ' + r.status + ').' });
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(file));
      if (/^sha256:/i.test(L.digest)) {
        const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (h.toLowerCase() !== L.digest.slice(7).toLowerCase()) { fs.unlinkSync(file); return res.json({ ok: false, msg: 'The downloaded file is damaged. Nothing was changed. Please try again.' }); }
      }
      const cmd = path.join(UPD_DIR, 'run-update.cmd');
      fs.writeFileSync(cmd, '@echo off\r\n"' + file + '" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\r\nschtasks /Delete /TN OptimaSN-Update /F\r\ndel "' + file + '"\r\n');
      await run('schtasks', ['/Create', '/TN', 'OptimaSN-Update', '/TR', cmd, '/SC', 'ONCE', '/ST', '00:00', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F']);
      const g = await run('schtasks', ['/Run', '/TN', 'OptimaSN-Update']);
      if (!g.ok) return res.json({ ok: false, msg: 'Could not start the update: ' + g.text.trim() });
      res.json({ ok: true, msg: 'Update downloaded and started. Your data is not touched.' });
    } catch (e) {
      res.json({ ok: false, msg: 'Update failed: ' + ((e && e.message) ? e.message : e) });
    } finally { busy = false; }
  });
};