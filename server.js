require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tableau-blanc-secret-change-in-prod';

// Identité centralisée : la connexion back-office est vérifiée auprès d'Administration.
const ADMINISTRATION_URL = (process.env.ADMINISTRATION_URL || '').replace(/\/+$/, '');
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
if (!ADMINISTRATION_URL || !INTERNAL_API_SECRET) {
  console.error("\n❌ ADMINISTRATION_URL et INTERNAL_API_SECRET sont obligatoires (voir .env.example). Arrêt du serveur.\n");
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Sur le plan gratuit Render, un service endormi peut mettre 20-30s à se réveiller — un simple
// fetch sans retry peut échouer sur l'erreur de passerelle (page HTML, pas JSON) pendant ce
// laps de temps. Retry avec backoff, comme les autres outils de la suite.
async function callAdministration(path, options = {}, attempt = 0) {
  const MAX_ATTEMPTS = 4;
  let res;
  try {
    res = await fetch(`${ADMINISTRATION_URL}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET, ...(options.headers || {}) },
    });
  } catch (err) {
    if (attempt + 1 < MAX_ATTEMPTS) { await sleep(2000 * (attempt + 1)); return callAdministration(path, options, attempt + 1); }
    throw err;
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (attempt + 1 < MAX_ATTEMPTS) {
      await sleep(2000 * (attempt + 1));
      return callAdministration(path, options, attempt + 1);
    }
    throw new Error(`Réponse inattendue d'Administration (${res.status}) sur ${path} : ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

if (!process.env.TURSO_DATABASE_URL) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:./data/whiteboard.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

app.use(express.json());
app.use(express.static('public', { index: false }));

// --- Turso helpers ---
async function tursoAll(sql, args = []) {
  const res = await turso.execute({ sql, args });
  return res.rows;
}
async function tursoGet(sql, args = []) {
  const rows = await tursoAll(sql, args);
  return rows[0];
}
async function tursoRun(sql, args = []) {
  return turso.execute({ sql, args });
}

const NOTE_COLORS = ['#FFF176', '#F8BBD0', '#90CAF9', '#A5D6A7', '#FFCC80', '#CE93D8'];
const DEFAULT_NOTE_WIDTH = 200;
const DEFAULT_NOTE_HEIGHT = 180;

async function initDb() {
  await turso.batch([
    `CREATE TABLE IF NOT EXISTS whiteboards (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      client_name TEXT NOT NULL,
      project_id TEXT,
      project_name TEXT NOT NULL,
      workshop_name TEXT NOT NULL,
      password TEXT NOT NULL,
      is_public INTEGER DEFAULT 0,
      created_by TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )`,
    `CREATE TABLE IF NOT EXISTS whiteboard_notes (
      id TEXT PRIMARY KEY,
      whiteboard_id TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      width REAL NOT NULL DEFAULT ${DEFAULT_NOTE_WIDTH},
      height REAL NOT NULL DEFAULT ${DEFAULT_NOTE_HEIGHT},
      color TEXT NOT NULL DEFAULT '${NOTE_COLORS[0]}',
      text TEXT NOT NULL DEFAULT '',
      z_index INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (whiteboard_id) REFERENCES whiteboards(id)
    )`,
    // Journal d'activité, consommé par l'UX Dashboard (fil d'actu agrégé).
    `CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, actor_name TEXT NOT NULL,
      client_name TEXT, project_name TEXT, detail TEXT, created_at INTEGER DEFAULT (unixepoch())
    )`,
  ], 'write');
}

// =====================
// AUTH
// =====================

const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

const COLORS = ['#E4572E', '#29335C', '#F3A712', '#2A9D8F', '#8338EC', '#D62828', '#3A86FF', '#06A77D', '#B5179E', '#FF6B35'];
function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function adminAuth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (!d.sub) return res.status(403).json({ error: 'Accès refusé' });
    req.admin = d; next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
}

function superadminAuth(req, res, next) {
  adminAuth(req, res, () => {
    if (req.admin.role !== 'superadmin') return res.status(403).json({ error: 'Accès réservé au superadmin' });
    next();
  });
}

function internalAuth(req, res, next) {
  if (req.headers['x-internal-secret'] !== INTERNAL_API_SECRET) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

function whiteboardAuth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.whiteboardId !== req.params.whiteboardId) return res.status(403).json({ error: 'Accès refusé' });
    req.user = d; next();
  } catch { res.status(401).json({ error: 'Session invalide, merci de te reconnecter' }); }
}

// Utilisé par Vue Projet pour afficher "dernière modification" sur un contenu Tableau Blanc.
async function touchWhiteboard(whiteboardId) {
  await tursoRun('UPDATE whiteboards SET updated_at = unixepoch() WHERE id = ?', [whiteboardId]);
}

async function logActivity(eventType, actorName, clientName, projectName, detail) {
  await tursoRun(
    'INSERT INTO activity_events (id, event_type, actor_name, client_name, project_name, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidv4(), eventType, actorName, clientName || null, projectName || null, detail || null]
  );
}

function signSessionFor(user) {
  const token = jwt.sign(
    { sub: user.id, name: user.name, role: user.role, avatarColor: user.avatarColor },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  return { token, user: { id: user.id, name: user.name, role: user.role, avatarColor: user.avatarColor, avatarData: user.avatarData } };
}

app.post('/api/admin/login', ah(async (req, res) => {
  const { login, password } = req.body || {};
  if (!login?.trim() || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  const result = await callAdministration('/internal/verify-credentials', {
    method: 'POST',
    body: JSON.stringify({ login: login.trim(), password }),
  });
  if (!result.valid) return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  if (!result.user.permissions['tableau-blanc']) return res.status(403).json({ error: "Tu n'as pas accès au Tableau Blanc. Contacte le superadmin." });
  res.json(signSessionFor(result.user));
}));

app.post('/api/admin/sso-ticket', adminAuth, ah(async (req, res) => {
  const result = await callAdministration('/internal/sso-ticket', {
    method: 'POST',
    body: JSON.stringify({ userId: req.admin.sub }),
  });
  res.json(result);
}));

app.post('/api/admin/sso-login', ah(async (req, res) => {
  const { ticket } = req.body || {};
  if (!ticket) return res.status(400).json({ error: 'Jeton requis' });
  const result = await callAdministration('/internal/verify-sso-ticket', {
    method: 'POST',
    body: JSON.stringify({ ticket }),
  });
  if (!result.valid) return res.status(401).json({ error: 'Jeton invalide ou expiré' });
  if (!result.user.permissions['tableau-blanc']) return res.status(403).json({ error: "Tu n'as pas accès au Tableau Blanc. Contacte le superadmin." });
  res.json(signSessionFor(result.user));
}));

app.post('/api/admin/avatar', adminAuth, ah(async (req, res) => {
  const result = await callAdministration(`/internal/users/${req.admin.sub}/avatar`, {
    method: 'POST',
    body: JSON.stringify({ dataUri: req.body?.dataUri }),
  });
  if (result.error) return res.status(400).json(result);
  res.json(result);
}));

// =====================
// ADMIN : GESTION DES TABLEAUX
// =====================

function publicWhiteboard(w) {
  return {
    id: w.id,
    clientId: w.client_id || null,
    clientName: w.client_name,
    projectId: w.project_id || null,
    projectName: w.project_name,
    workshopName: w.workshop_name,
    password: w.password,
    isPublic: !!w.is_public,
    createdAt: w.created_at,
    createdBy: w.created_by || null,
  };
}

// Le créateur et le superadmin peuvent tout modifier ; seul le superadmin peut supprimer un tableau entier.
function canEditWhiteboard(admin, whiteboard) {
  return admin.role === 'superadmin' || (!!whiteboard.created_by && whiteboard.created_by === admin.sub);
}

app.get('/api/admin/whiteboards', adminAuth, ah(async (req, res) => {
  const whiteboards = await tursoAll('SELECT * FROM whiteboards ORDER BY created_at DESC');
  const result = [];
  for (const w of whiteboards) {
    const { n: noteCount } = await tursoGet('SELECT COUNT(*) as n FROM whiteboard_notes WHERE whiteboard_id = ?', [w.id]);
    result.push({ ...publicWhiteboard(w), noteCount });
  }
  res.json(result);
}));

app.get('/api/admin/whiteboards/:id', adminAuth, ah(async (req, res) => {
  const w = await tursoGet('SELECT * FROM whiteboards WHERE id = ?', [req.params.id]);
  if (!w) return res.status(404).json({ error: 'Introuvable' });
  res.json(publicWhiteboard(w));
}));

function validateWhiteboardPayload(body) {
  const { clientName, projectName, workshopName, password, isPublic } = body || {};
  if (!clientName?.trim() || !projectName?.trim() || !workshopName?.trim()) return 'Nom du client, du projet et du sous-titre requis';
  if (isPublic && !password?.trim()) return 'Mot de passe requis pour un tableau public';
  return null;
}

app.post('/api/admin/whiteboards', adminAuth, ah(async (req, res) => {
  const err = validateWhiteboardPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const { clientId, clientName, projectId, projectName, workshopName, password, isPublic } = req.body;
  let id = /^[a-z0-9]{6,20}$/i.test(req.body.id || '') ? req.body.id : null;
  if (id && await tursoGet('SELECT id FROM whiteboards WHERE id = ?', [id])) id = null;
  if (!id) id = uuidv4().replace(/-/g, '').slice(0, 10);
  await tursoRun(
    'INSERT INTO whiteboards (id, client_id, client_name, project_id, project_name, workshop_name, password, is_public, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, clientId || null, clientName.trim(), projectId || null, projectName.trim(), workshopName.trim(), (password || '').trim(), isPublic ? 1 : 0, req.admin.sub]
  );
  await logActivity('whiteboard_created', req.admin.name, clientName.trim(), workshopName.trim());
  res.json(publicWhiteboard(await tursoGet('SELECT * FROM whiteboards WHERE id = ?', [id])));
}));

app.put('/api/admin/whiteboards/:id', adminAuth, ah(async (req, res) => {
  const existing = await tursoGet('SELECT * FROM whiteboards WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Introuvable' });
  if (!canEditWhiteboard(req.admin, existing)) return res.status(403).json({ error: "Seul le créateur ou le superadmin peut modifier ce tableau" });
  const err = validateWhiteboardPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const { clientId, clientName, projectId, projectName, workshopName, password, isPublic } = req.body;
  await tursoRun(
    'UPDATE whiteboards SET client_id=?, client_name=?, project_id=?, project_name=?, workshop_name=?, password=?, is_public=?, updated_at=unixepoch() WHERE id=?',
    [clientId || null, clientName.trim(), projectId || null, projectName.trim(), workshopName.trim(), (password || '').trim(), isPublic ? 1 : 0, req.params.id]
  );
  res.json(publicWhiteboard(await tursoGet('SELECT * FROM whiteboards WHERE id = ?', [req.params.id])));
}));

app.delete('/api/admin/whiteboards/:id', superadminAuth, ah(async (req, res) => {
  const whiteboard = await tursoGet('SELECT * FROM whiteboards WHERE id = ?', [req.params.id]);
  if (!whiteboard) return res.status(404).json({ error: 'Introuvable' });
  await tursoRun('DELETE FROM whiteboard_notes WHERE whiteboard_id = ?', [req.params.id]);
  await tursoRun('DELETE FROM whiteboards WHERE id = ?', [req.params.id]);
  await logActivity('whiteboard_deleted', req.admin.name, whiteboard.client_name, whiteboard.workshop_name);
  res.json({ ok: true });
}));

// Permet à l'admin d'ouvrir n'importe quel tableau (y compris privé, sans mot de passe) depuis le
// back-office, en contournant la page de connexion.
app.post('/api/admin/whiteboards/:id/preview-token', adminAuth, ah(async (req, res) => {
  const whiteboard = await tursoGet('SELECT id FROM whiteboards WHERE id = ?', [req.params.id]);
  if (!whiteboard) return res.status(404).json({ error: 'Introuvable' });
  const name = req.admin.name || 'Admin';
  const token = jwt.sign({ whiteboardId: whiteboard.id, name, color: colorForName(name) }, JWT_SECRET, { expiresIn: '1d' });
  res.json({ token, name, color: colorForName(name) });
}));

// ---------- Clients / projets (délégués à Administration) ----------

app.get('/api/admin/clients', adminAuth, ah(async (req, res) => {
  res.json(await callAdministration('/internal/clients'));
}));

app.get('/api/admin/clients/:clientId/projects', adminAuth, ah(async (req, res) => {
  const q = req.query.q ? `?q=${encodeURIComponent(req.query.q)}` : '';
  res.json(await callAdministration(`/internal/clients/${req.params.clientId}/projects${q}`));
}));

app.post('/api/admin/clients/:clientId/projects', adminAuth, ah(async (req, res) => {
  if (!req.body.name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  res.json(await callAdministration(`/internal/clients/${req.params.clientId}/projects`, {
    method: 'POST',
    body: JSON.stringify({ name: req.body.name.trim() }),
  }));
}));

// ---------- Favoris (délégués à Administration) ----------

app.get('/api/admin/favorites', adminAuth, ah(async (req, res) => {
  const favorites = await callAdministration(`/internal/favorites?userId=${encodeURIComponent(req.admin.sub)}&toolKey=tableau-blanc`);
  res.json(favorites);
}));

app.post('/api/admin/favorites/toggle', adminAuth, ah(async (req, res) => {
  const { itemId, itemLabel, itemUrl } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId requis' });
  const result = await callAdministration('/internal/favorites/toggle', {
    method: 'POST',
    body: JSON.stringify({ userId: req.admin.sub, toolKey: 'tableau-blanc', itemType: 'whiteboard', itemId, itemLabel, itemUrl }),
  });
  res.json(result);
}));

// ---------- Activité (consommée directement par l'UX Dashboard) ----------

app.get('/internal/activity', internalAuth, ah(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const rows = await tursoAll('SELECT * FROM activity_events ORDER BY created_at DESC LIMIT ?', [limit]);
  res.json(rows.map(r => ({
    id: r.id, toolKey: 'tableau-blanc', eventType: r.event_type, actorName: r.actor_name,
    clientName: r.client_name, projectName: r.project_name, detail: r.detail, createdAt: r.created_at,
  })));
}));

// ---------- Consommé directement par Vue Projet (agrégation des contenus par projet) ----------

app.get('/internal/whiteboards', internalAuth, ah(async (req, res) => {
  const whiteboards = await tursoAll('SELECT * FROM whiteboards ORDER BY created_at DESC');
  res.json(whiteboards.map(w => ({
    id: w.id, clientId: w.client_id || null, projectId: w.project_id || null, workshopName: w.workshop_name,
    updatedAt: w.updated_at || w.created_at,
  })));
}));

app.post('/internal/whiteboards/:id/preview-token', internalAuth, ah(async (req, res) => {
  const whiteboard = await tursoGet('SELECT id FROM whiteboards WHERE id = ?', [req.params.id]);
  if (!whiteboard) return res.status(404).json({ error: 'Introuvable' });
  const name = req.body.name || 'Admin';
  const token = jwt.sign({ whiteboardId: whiteboard.id, name, color: colorForName(name) }, JWT_SECRET, { expiresIn: '1d' });
  res.json({ token, name, color: colorForName(name) });
}));

// =====================
// ACCÈS PARTICIPANT (rejoindre un tableau)
// =====================

app.get('/api/whiteboards/:whiteboardId/meta', ah(async (req, res) => {
  const w = await tursoGet('SELECT id, client_name, project_name, workshop_name FROM whiteboards WHERE id = ?', [req.params.whiteboardId]);
  if (!w) return res.status(404).json({ error: 'Tableau introuvable' });
  res.json({ id: w.id, clientName: w.client_name, projectName: w.project_name, workshopName: w.workshop_name });
}));

app.post('/api/whiteboards/:whiteboardId/join', ah(async (req, res) => {
  const { name, password } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Ton nom est requis' });
  const whiteboard = await tursoGet('SELECT * FROM whiteboards WHERE id = ?', [req.params.whiteboardId]);
  if (!whiteboard) return res.status(404).json({ error: 'Tableau introuvable' });
  if (!whiteboard.is_public) return res.status(403).json({ error: "Ce tableau n'est pas encore accessible" });
  if (password !== whiteboard.password) return res.status(401).json({ error: 'Mot de passe incorrect' });
  const cleanName = name.trim().slice(0, 40);
  const token = jwt.sign({ whiteboardId: whiteboard.id, name: cleanName, color: colorForName(cleanName) }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, name: cleanName, color: colorForName(cleanName) });
}));

// =====================
// REALTIME (Server-Sent Events), scopé par tableau
// =====================

// connectionId -> { res, whiteboardId, name, color, x, y }
const clients = new Map();

function broadcast(event, data, whiteboardId, exceptConnId = null) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [connId, client] of clients) {
    if (connId === exceptConnId) continue;
    if (client.whiteboardId !== whiteboardId) continue;
    client.res.write(payload);
  }
}

function onlineUsers(whiteboardId) {
  const byName = new Map();
  for (const client of clients.values()) {
    if (client.whiteboardId !== whiteboardId) continue;
    if (!byName.has(client.name)) byName.set(client.name, { name: client.name, color: client.color });
  }
  return [...byName.values()];
}

app.get('/api/whiteboards/:whiteboardId/stream', (req, res) => {
  let user;
  try { user = jwt.verify(req.query.token || '', JWT_SECRET); }
  catch { return res.status(401).end(); }
  if (user.whiteboardId !== req.params.whiteboardId) return res.status(403).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const whiteboardId = req.params.whiteboardId;
  const connId = uuidv4();
  clients.set(connId, { res, whiteboardId, name: user.name, color: user.color, x: 0, y: 0 });

  res.write(`event: presence:snapshot\ndata: ${JSON.stringify({ users: onlineUsers(whiteboardId) })}\n\n`);
  broadcast('presence:snapshot', { users: onlineUsers(whiteboardId) }, whiteboardId, connId);

  const heartbeat = setInterval(() => res.write(':\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(connId);
    broadcast('presence:snapshot', { users: onlineUsers(whiteboardId) }, whiteboardId);
    broadcast('cursor:leave', { name: user.name }, whiteboardId);
  });
});

app.post('/api/whiteboards/:whiteboardId/cursor', whiteboardAuth, (req, res) => {
  const { x, y } = req.body || {};
  broadcast('cursor:update', { name: req.user.name, color: req.user.color, x, y }, req.params.whiteboardId);
  res.status(204).end();
});

// =====================
// TABLEAU : NOTES (post-its)
// =====================

function parseNote(row) {
  return {
    id: row.id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    color: row.color,
    text: row.text,
    zIndex: row.z_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get('/api/whiteboards/:whiteboardId', whiteboardAuth, ah(async (req, res) => {
  const whiteboard = await tursoGet('SELECT * FROM whiteboards WHERE id = ?', [req.params.whiteboardId]);
  if (!whiteboard) return res.status(404).json({ error: 'Introuvable' });
  const noteRows = await tursoAll('SELECT * FROM whiteboard_notes WHERE whiteboard_id = ? ORDER BY z_index', [req.params.whiteboardId]);
  res.json({
    id: whiteboard.id,
    clientName: whiteboard.client_name,
    projectName: whiteboard.project_name,
    workshopName: whiteboard.workshop_name,
    notes: noteRows.map(parseNote),
    me: req.user,
  });
}));

app.post('/api/whiteboards/:whiteboardId/notes', whiteboardAuth, ah(async (req, res) => {
  const { x, y, color } = req.body || {};
  const { max } = await tursoGet('SELECT MAX(z_index) as max FROM whiteboard_notes WHERE whiteboard_id = ?', [req.params.whiteboardId]);
  const zIndex = (max ?? -1) + 1;
  const id = uuidv4();
  await tursoRun(
    'INSERT INTO whiteboard_notes (id, whiteboard_id, x, y, width, height, color, z_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, req.params.whiteboardId, x ?? 0, y ?? 0, DEFAULT_NOTE_WIDTH, DEFAULT_NOTE_HEIGHT, color || NOTE_COLORS[0], zIndex]
  );
  const row = await tursoGet('SELECT * FROM whiteboard_notes WHERE id = ?', [id]);
  const note = parseNote(row);
  const whiteboard = await tursoGet('SELECT client_name, workshop_name FROM whiteboards WHERE id = ?', [req.params.whiteboardId]);
  await logActivity('note_created', req.user.name, whiteboard?.client_name, whiteboard?.workshop_name, 'Nouveau post-it');
  await touchWhiteboard(req.params.whiteboardId);
  broadcast('note:created', note, req.params.whiteboardId);
  res.json(note);
}));

// Patch partiel : position/taille (fin de drag/resize), couleur, ou texte. Le passage au premier
// plan (z_index) est recalculé ici plutôt que confié au client, pour rester cohérent même si deux
// personnes interagissent avec des notes différentes en même temps.
app.patch('/api/whiteboards/:whiteboardId/notes/:id', whiteboardAuth, ah(async (req, res) => {
  const existing = await tursoGet('SELECT * FROM whiteboard_notes WHERE id = ? AND whiteboard_id = ?', [req.params.id, req.params.whiteboardId]);
  if (!existing) return res.status(404).json({ error: 'Introuvable' });
  const { x, y, width, height, color, text, bringToFront } = req.body || {};

  let zIndex = existing.z_index;
  if (bringToFront) {
    const { max } = await tursoGet('SELECT MAX(z_index) as max FROM whiteboard_notes WHERE whiteboard_id = ?', [req.params.whiteboardId]);
    zIndex = (max ?? -1) + 1;
  }

  const next = {
    x: x ?? existing.x,
    y: y ?? existing.y,
    width: width ?? existing.width,
    height: height ?? existing.height,
    color: color ?? existing.color,
    text: text ?? existing.text,
  };
  await tursoRun(
    'UPDATE whiteboard_notes SET x=?, y=?, width=?, height=?, color=?, text=?, z_index=?, updated_at=unixepoch() WHERE id=?',
    [next.x, next.y, next.width, next.height, next.color, next.text, zIndex, req.params.id]
  );
  const row = await tursoGet('SELECT * FROM whiteboard_notes WHERE id = ?', [req.params.id]);
  const note = parseNote(row);
  await touchWhiteboard(req.params.whiteboardId);
  broadcast('note:updated', note, req.params.whiteboardId);
  res.json(note);
}));

// Diffusion "live" pendant un drag/resize (pas de persistance ni d'activité) : la position finale
// est persistée séparément via PATCH au relâchement, comme le curseur de souris.
app.post('/api/whiteboards/:whiteboardId/notes/:id/live', whiteboardAuth, (req, res) => {
  const { x, y, width, height } = req.body || {};
  broadcast('note:dragging', { id: req.params.id, x, y, width, height }, req.params.whiteboardId);
  res.status(204).end();
});

app.delete('/api/whiteboards/:whiteboardId/notes/:id', whiteboardAuth, ah(async (req, res) => {
  const existing = await tursoGet('SELECT * FROM whiteboard_notes WHERE id = ? AND whiteboard_id = ?', [req.params.id, req.params.whiteboardId]);
  if (!existing) return res.status(404).json({ error: 'Introuvable' });
  await tursoRun('DELETE FROM whiteboard_notes WHERE id = ?', [req.params.id]);
  const whiteboard = await tursoGet('SELECT client_name, workshop_name FROM whiteboards WHERE id = ?', [req.params.whiteboardId]);
  await logActivity('note_deleted', req.user.name, whiteboard?.client_name, whiteboard?.workshop_name, 'Post-it supprimé');
  await touchWhiteboard(req.params.whiteboardId);
  broadcast('note:deleted', { id: req.params.id }, req.params.whiteboardId);
  res.json({ ok: true });
}));

// SPA routes
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/w/:whiteboardId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/w/:whiteboardId/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));

app.get('/', (req, res) => res.redirect('/admin'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 Tableau Blanc démarré sur http://localhost:${PORT}`);
      console.log(`   Back-office : http://localhost:${PORT}/admin (connexion via Administration)\n`);
    });
  })
  .catch(err => {
    console.error('Erreur de connexion à la base :', err);
    process.exit(1);
  });
