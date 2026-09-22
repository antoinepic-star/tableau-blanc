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

// Limite relevée (défaut Express : 100kb) pour accepter les images encodées en base64 (élément image).
app.use(express.json({ limit: '8mb' }));
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

const ELEMENT_COLORS = ['#FFF176', '#F8BBD0', '#90CAF9', '#A5D6A7', '#FFCC80', '#CE93D8'];

// Valeurs par défaut à la création, selon le type d'élément — voir ELEMENT_TYPES côté client
// (public/js/board.js) pour le détail des interactions propres à chaque type.
const ELEMENT_DEFAULTS = {
  note: { width: 200, height: 180, color: ELEMENT_COLORS[0] },
  line: { width: 160, height: 6, color: '#1c1c28' },
  text: { width: 220, height: 60, color: '#1c1c28', fontSize: 18 },
  image: { width: 240, height: 240, color: null },
  rectangle: { width: 220, height: 140, color: ELEMENT_COLORS[0] },
  connector: { width: 0, height: 0, color: '#1c1c28' },
  frame: { width: 480, height: 360, color: '#EDEAE3', strokeWidth: 1, strokeColor: '#c9c4b8', fontSize: 14, titleColor: '#4a463c' },
};
const ELEMENT_TYPES = Object.keys(ELEMENT_DEFAULTS);

async function initDb() {
  // Table historique (avant l'ajout des traits/textes/images) : renommée une fois, sans effet
  // aux démarrages suivants une fois le renommage effectué.
  try { await turso.execute('ALTER TABLE whiteboard_notes RENAME TO whiteboard_elements'); } catch (_) {}

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
    `CREATE TABLE IF NOT EXISTS whiteboard_elements (
      id TEXT PRIMARY KEY,
      whiteboard_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      width REAL NOT NULL DEFAULT ${ELEMENT_DEFAULTS.note.width},
      height REAL NOT NULL DEFAULT ${ELEMENT_DEFAULTS.note.height},
      rotation REAL NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '${ELEMENT_COLORS[0]}',
      text TEXT NOT NULL DEFAULT '',
      font_size REAL,
      bold INTEGER NOT NULL DEFAULT 0,
      italic INTEGER NOT NULL DEFAULT 0,
      underline INTEGER NOT NULL DEFAULT 0,
      strikethrough INTEGER NOT NULL DEFAULT 0,
      image_data TEXT,
      grayscale INTEGER NOT NULL DEFAULT 0,
      start_cap TEXT NOT NULL DEFAULT 'none',
      end_cap TEXT NOT NULL DEFAULT 'none',
      line_style TEXT NOT NULL DEFAULT 'solid',
      background_color TEXT,
      stroke_width REAL NOT NULL DEFAULT 0,
      stroke_color TEXT,
      radius REAL NOT NULL DEFAULT 0,
      group_id TEXT,
      locked INTEGER NOT NULL DEFAULT 0,
      from_element_id TEXT,
      from_side TEXT,
      to_element_id TEXT,
      to_side TEXT,
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
    // Un seul émoji par (élément, participant) — la contrainte est gérée côté appli (pas de UNIQUE
    // SQL) pour pouvoir remplacer proprement une réaction existante en une seule requête de lecture.
    `CREATE TABLE IF NOT EXISTS whiteboard_reactions (
      id TEXT PRIMARY KEY, whiteboard_id TEXT NOT NULL, element_id TEXT NOT NULL,
      actor_name TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())
    )`,
    `CREATE TABLE IF NOT EXISTS whiteboard_comments (
      id TEXT PRIMARY KEY, whiteboard_id TEXT NOT NULL, element_id TEXT NOT NULL,
      actor_name TEXT NOT NULL, actor_color TEXT, text TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )`,
  ], 'write');

  // Ajout des colonnes trait/texte/image (ignore l'erreur si la colonne existe déjà — même
  // pattern que les autres outils de la suite pour une migration idempotente).
  for (const sql of [
    "ALTER TABLE whiteboard_elements ADD COLUMN type TEXT NOT NULL DEFAULT 'note'",
    'ALTER TABLE whiteboard_elements ADD COLUMN rotation REAL NOT NULL DEFAULT 0',
    'ALTER TABLE whiteboard_elements ADD COLUMN font_size REAL',
    'ALTER TABLE whiteboard_elements ADD COLUMN bold INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE whiteboard_elements ADD COLUMN italic INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE whiteboard_elements ADD COLUMN underline INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE whiteboard_elements ADD COLUMN strikethrough INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE whiteboard_elements ADD COLUMN image_data TEXT',
    'ALTER TABLE whiteboard_elements ADD COLUMN grayscale INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE whiteboard_elements ADD COLUMN start_cap TEXT NOT NULL DEFAULT 'none'",
    "ALTER TABLE whiteboard_elements ADD COLUMN end_cap TEXT NOT NULL DEFAULT 'none'",
    "ALTER TABLE whiteboard_elements ADD COLUMN line_style TEXT NOT NULL DEFAULT 'solid'",
    'ALTER TABLE whiteboard_elements ADD COLUMN background_color TEXT',
    'ALTER TABLE whiteboard_elements ADD COLUMN stroke_width REAL NOT NULL DEFAULT 0',
    'ALTER TABLE whiteboard_elements ADD COLUMN stroke_color TEXT',
    'ALTER TABLE whiteboard_elements ADD COLUMN radius REAL NOT NULL DEFAULT 0',
    'ALTER TABLE whiteboard_elements ADD COLUMN group_id TEXT',
    'ALTER TABLE whiteboard_elements ADD COLUMN locked INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE whiteboard_elements ADD COLUMN from_element_id TEXT',
    'ALTER TABLE whiteboard_elements ADD COLUMN from_side TEXT',
    'ALTER TABLE whiteboard_elements ADD COLUMN to_element_id TEXT',
    'ALTER TABLE whiteboard_elements ADD COLUMN to_side TEXT',
    // Frame (conteneur toujours en arrière-plan) : frame_id rattache un élément à la frame sous
    // laquelle il a été déposé (cf. containment dans batch-move/PATCH/création) ; title_color est la
    // couleur du titre de la frame elle-même (distincte de "color", son fond).
    'ALTER TABLE whiteboard_elements ADD COLUMN frame_id TEXT',
    'ALTER TABLE whiteboard_elements ADD COLUMN title_color TEXT',
  ]) {
    try { await turso.execute(sql); } catch (_) {}
  }
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
    const { n: elementCount } = await tursoGet('SELECT COUNT(*) as n FROM whiteboard_elements WHERE whiteboard_id = ?', [w.id]);
    result.push({ ...publicWhiteboard(w), elementCount });
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
  await tursoRun('DELETE FROM whiteboard_elements WHERE whiteboard_id = ?', [req.params.id]);
  await tursoRun('DELETE FROM whiteboard_reactions WHERE whiteboard_id = ?', [req.params.id]);
  await tursoRun('DELETE FROM whiteboard_comments WHERE whiteboard_id = ?', [req.params.id]);
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
// TABLEAU : ÉLÉMENTS (post-it, trait, texte, image)
// =====================

const ELEMENT_LABELS = { note: 'post-it', line: 'trait', text: 'bloc de texte', image: 'image', rectangle: 'rectangle', connector: 'connecteur', frame: 'frame' };

function parseComment(row) {
  return {
    id: row.id,
    elementId: row.element_id,
    actorName: row.actor_name,
    actorColor: row.actor_color,
    text: row.text,
    createdAt: row.created_at,
  };
}

// withImageData: false omet le champ (plutôt que de l'envoyer vide/null) pour les mises à jour qui
// ne touchent jamais l'image (déplacement en lot, PATCH sans imageData dans le corps) — une image
// tient souvent plusieurs Mo en base64, et la renvoyer en entier sur un simple déplacement rendait
// l'aller-retour largement assez lent pour que les positions arrivent après coup, hors de tout ordre
// perceptible. Le client garde sa propre copie déjà affichée quand le champ est absent (cf. board.js).
function parseElement(row, { withImageData = true } = {}) {
  return {
    id: row.id,
    type: row.type,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    rotation: row.rotation,
    color: row.color,
    text: row.text,
    fontSize: row.font_size,
    bold: !!row.bold,
    italic: !!row.italic,
    underline: !!row.underline,
    strikethrough: !!row.strikethrough,
    ...(withImageData ? { imageData: row.image_data } : {}),
    grayscale: !!row.grayscale,
    startCap: row.start_cap,
    endCap: row.end_cap,
    lineStyle: row.line_style,
    backgroundColor: row.background_color,
    strokeWidth: row.stroke_width,
    strokeColor: row.stroke_color,
    radius: row.radius,
    groupId: row.group_id,
    locked: !!row.locked,
    fromElementId: row.from_element_id,
    fromSide: row.from_side,
    toElementId: row.to_element_id,
    toSide: row.to_side,
    frameId: row.frame_id,
    titleColor: row.title_color,
    zIndex: row.z_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Une frame "contient" un élément si le CENTRE de celui-ci tombe dans ses limites — pas un simple
// chevauchement, sinon un élément à cheval sur le bord se retrouverait rattaché de façon peu
// intuitive. S'il chevauche plusieurs frames, celle avec le plus grand z_index (la plus "au-dessus"
// parmi les frames) gagne. Ne fait aucune requête : `frameRows` doit déjà avoir été chargé.
function findContainingFrame(x, y, width, height, frameRows, excludeId) {
  const cx = x + width / 2;
  const cy = y + height / 2;
  let best = null;
  for (const f of frameRows) {
    if (f.id === excludeId) continue;
    if (cx >= f.x && cx <= f.x + f.width && cy >= f.y && cy <= f.y + f.height) {
      if (!best || f.z_index > best.z_index) best = f;
    }
  }
  return best ? best.id : null;
}

app.get('/api/whiteboards/:whiteboardId', whiteboardAuth, ah(async (req, res) => {
  const whiteboard = await tursoGet('SELECT * FROM whiteboards WHERE id = ?', [req.params.whiteboardId]);
  if (!whiteboard) return res.status(404).json({ error: 'Introuvable' });
  const elementRows = await tursoAll('SELECT * FROM whiteboard_elements WHERE whiteboard_id = ? ORDER BY z_index', [req.params.whiteboardId]);
  // Votes (un simple marqueur de présence par élément/participant, cf. table whiteboard_reactions
  // héritée de l'ancien système à émojis) et nombre de commentaires, chargés en vrac pour tout le
  // tableau et rattachés ici, pour que le canvas affiche les badges dès le premier rendu.
  const voteRows = await tursoAll('SELECT element_id, actor_name FROM whiteboard_reactions WHERE whiteboard_id = ?', [req.params.whiteboardId]);
  const commentCountRows = await tursoAll('SELECT element_id, COUNT(*) as n FROM whiteboard_comments WHERE whiteboard_id = ? GROUP BY element_id', [req.params.whiteboardId]);
  const votersByElement = new Map();
  for (const r of voteRows) {
    if (!votersByElement.has(r.element_id)) votersByElement.set(r.element_id, []);
    votersByElement.get(r.element_id).push(r.actor_name);
  }
  const commentCountByElement = new Map(commentCountRows.map(r => [r.element_id, r.n]));
  res.json({
    id: whiteboard.id,
    clientName: whiteboard.client_name,
    projectName: whiteboard.project_name,
    workshopName: whiteboard.workshop_name,
    elements: elementRows.map((row) => {
      const el = parseElement(row);
      el.votes = votersByElement.get(row.id) || [];
      el.commentCount = commentCountByElement.get(row.id) || 0;
      return el;
    }),
    me: req.user,
  });
}));

app.post('/api/whiteboards/:whiteboardId/elements', whiteboardAuth, ah(async (req, res) => {
  const type = ELEMENT_TYPES.includes(req.body?.type) ? req.body.type : 'note';
  const defaults = ELEMENT_DEFAULTS[type];
  const {
    x, y, width, height, rotation, color, text, fontSize, bold, italic, underline, strikethrough, imageData, grayscale,
    startCap, endCap, lineStyle, backgroundColor, strokeWidth, strokeColor, radius, groupId, locked,
    fromElementId, fromSide, toElementId, toSide, titleColor,
  } = req.body || {};
  let { frameId } = req.body || {};
  // Une frame va toujours tout au fond (jamais au premier plan, cf. PATCH/batch-move) ; les autres
  // types rejoignent la frame sous laquelle ils atterrissent, sauf si l'appelant a déjà précisé
  // frameId explicitement (ex. duplication d'un élément déjà dans une frame).
  let zIndex;
  if (type === 'frame') {
    const { min } = await tursoGet('SELECT MIN(z_index) as min FROM whiteboard_elements WHERE whiteboard_id = ?', [req.params.whiteboardId]);
    zIndex = (min ?? 1) - 1;
  } else {
    const { max } = await tursoGet('SELECT MAX(z_index) as max FROM whiteboard_elements WHERE whiteboard_id = ?', [req.params.whiteboardId]);
    zIndex = (max ?? -1) + 1;
    if (frameId === undefined) {
      const frameRows = await tursoAll('SELECT id, x, y, width, height, z_index FROM whiteboard_elements WHERE whiteboard_id = ? AND type = ?', [req.params.whiteboardId, 'frame']);
      frameId = findContainingFrame(x ?? 0, y ?? 0, width ?? defaults.width, height ?? defaults.height, frameRows, null);
    }
  }
  const id = uuidv4();
  const columns = ['id', 'whiteboard_id', 'type', 'x', 'y', 'width', 'height', 'rotation', 'color', 'text', 'font_size',
    'bold', 'italic', 'underline', 'strikethrough', 'image_data', 'grayscale', 'start_cap', 'end_cap', 'line_style', 'background_color',
    'stroke_width', 'stroke_color', 'radius', 'group_id', 'locked', 'from_element_id', 'from_side', 'to_element_id', 'to_side',
    'frame_id', 'title_color', 'z_index'];
  const values = [
    id, req.params.whiteboardId, type, x ?? 0, y ?? 0,
    width ?? defaults.width, height ?? defaults.height, rotation ?? 0,
    color ?? defaults.color ?? '#1c1c28', text || '', fontSize ?? defaults.fontSize ?? null,
    bold ? 1 : 0, italic ? 1 : 0, underline ? 1 : 0, strikethrough ? 1 : 0, imageData || null, grayscale ? 1 : 0,
    startCap || 'none', endCap || 'none', lineStyle || 'solid', backgroundColor || null,
    strokeWidth ?? defaults.strokeWidth ?? 0, strokeColor || defaults.strokeColor || null, radius ?? 0, groupId || null, locked ? 1 : 0,
    fromElementId || null, fromSide || null, toElementId || null, toSide || null,
    frameId || null, titleColor || defaults.titleColor || null, zIndex,
  ];
  await tursoRun(
    `INSERT INTO whiteboard_elements (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values
  );
  const row = await tursoGet('SELECT * FROM whiteboard_elements WHERE id = ?', [id]);
  const element = parseElement(row);
  const whiteboard = await tursoGet('SELECT client_name, workshop_name FROM whiteboards WHERE id = ?', [req.params.whiteboardId]);
  await logActivity('element_created', req.user.name, whiteboard?.client_name, whiteboard?.workshop_name, `Nouveau ${ELEMENT_LABELS[type]}`);
  await touchWhiteboard(req.params.whiteboardId);
  broadcast('element:created', element, req.params.whiteboardId);
  res.json(element);
}));

// Patch partiel : position/taille/rotation (fin de drag/resize/rotation), couleur, texte ou mise en
// forme. Le passage au premier plan (z_index) est recalculé ici plutôt que confié au client, pour
// rester cohérent même si deux personnes interagissent avec des éléments différents en même temps.
app.patch('/api/whiteboards/:whiteboardId/elements/:id', whiteboardAuth, ah(async (req, res) => {
  const existing = await tursoGet('SELECT * FROM whiteboard_elements WHERE id = ? AND whiteboard_id = ?', [req.params.id, req.params.whiteboardId]);
  if (!existing) return res.status(404).json({ error: 'Introuvable' });
  const {
    x, y, width, height, rotation, color, text, fontSize, bold, italic, underline, strikethrough, imageData, grayscale,
    startCap, endCap, lineStyle, backgroundColor, bringToFront, sendToBack,
    strokeWidth, strokeColor, radius, groupId, locked, fromElementId, fromSide, toElementId, toSide,
    frameId, titleColor,
  } = req.body || {};

  // Une frame reste toujours tout au fond : "premier plan" n'a pas de sens pour elle et est ignoré
  // silencieusement (cf. aussi le toolbar côté client, qui ne propose pas ces actions sur une frame).
  let zIndex = existing.z_index;
  if (bringToFront && existing.type !== 'frame') {
    const { max } = await tursoGet('SELECT MAX(z_index) as max FROM whiteboard_elements WHERE whiteboard_id = ?', [req.params.whiteboardId]);
    zIndex = (max ?? -1) + 1;
  } else if (sendToBack) {
    const { min } = await tursoGet('SELECT MIN(z_index) as min FROM whiteboard_elements WHERE whiteboard_id = ?', [req.params.whiteboardId]);
    zIndex = (min ?? 1) - 1;
  }

  // Si la position ou la taille change pour un élément qui n'est pas lui-même une frame, on
  // recalcule son appartenance (entre/sort d'une frame) d'après sa position D'ARRIVÉE plutôt que de
  // faire confiance à ce qu'envoie le client — sauf si frameId est fourni explicitement (ex.
  // dissociation manuelle), auquel cas on respecte ce choix.
  let nextFrameId = frameId !== undefined ? frameId : existing.frame_id;
  if (frameId === undefined && existing.type !== 'frame' && (x !== undefined || y !== undefined || width !== undefined || height !== undefined)) {
    const frameRows = await tursoAll('SELECT id, x, y, width, height, z_index FROM whiteboard_elements WHERE whiteboard_id = ? AND type = ?', [req.params.whiteboardId, 'frame']);
    nextFrameId = findContainingFrame(x ?? existing.x, y ?? existing.y, width ?? existing.width, height ?? existing.height, frameRows, req.params.id);
  }

  const next = {
    x: x ?? existing.x,
    y: y ?? existing.y,
    width: width ?? existing.width,
    height: height ?? existing.height,
    rotation: rotation ?? existing.rotation,
    color: color ?? existing.color,
    text: text ?? existing.text,
    font_size: fontSize ?? existing.font_size,
    bold: bold != null ? (bold ? 1 : 0) : existing.bold,
    italic: italic != null ? (italic ? 1 : 0) : existing.italic,
    underline: underline != null ? (underline ? 1 : 0) : existing.underline,
    strikethrough: strikethrough != null ? (strikethrough ? 1 : 0) : existing.strikethrough,
    image_data: imageData ?? existing.image_data,
    grayscale: grayscale != null ? (grayscale ? 1 : 0) : existing.grayscale,
    start_cap: startCap ?? existing.start_cap,
    end_cap: endCap ?? existing.end_cap,
    line_style: lineStyle ?? existing.line_style,
    background_color: backgroundColor !== undefined ? backgroundColor : existing.background_color,
    stroke_width: strokeWidth ?? existing.stroke_width,
    stroke_color: strokeColor !== undefined ? strokeColor : existing.stroke_color,
    radius: radius ?? existing.radius,
    group_id: groupId !== undefined ? groupId : existing.group_id,
    locked: locked != null ? (locked ? 1 : 0) : existing.locked,
    from_element_id: fromElementId !== undefined ? fromElementId : existing.from_element_id,
    from_side: fromSide !== undefined ? fromSide : existing.from_side,
    to_element_id: toElementId !== undefined ? toElementId : existing.to_element_id,
    to_side: toSide !== undefined ? toSide : existing.to_side,
    frame_id: nextFrameId,
    title_color: titleColor !== undefined ? titleColor : existing.title_color,
    z_index: zIndex,
  };
  const setColumns = Object.keys(next);
  await tursoRun(
    `UPDATE whiteboard_elements SET ${setColumns.map(c => `${c}=?`).join(', ')}, updated_at=unixepoch() WHERE id=?`,
    [...setColumns.map(c => next[c]), req.params.id]
  );
  const row = await tursoGet('SELECT * FROM whiteboard_elements WHERE id = ?', [req.params.id]);
  const element = parseElement(row, { withImageData: imageData !== undefined });
  await touchWhiteboard(req.params.whiteboardId);
  broadcast('element:updated', element, req.params.whiteboardId);
  res.json(element);
}));

// Déplacement groupé (fin de glisser d'une sélection multiple ou d'un groupe permanent) : une seule
// requête pour toutes les positions, avec un unique passage au premier plan calculé pour tout le lot
// d'un coup. Avant ce endpoint, le client envoyait un PATCH par élément avec bringToFront: true —
// chacun recalculait indépendamment MAX(z_index), ce qui pouvait attribuer le même z_index à deux
// éléments du lot (un élément passant sous un autre qui était pourtant dessus), et les N réponses
// arrivaient à des moments différents (éléments qui ne bougent pas tous en même temps à l'écran).
app.post('/api/whiteboards/:whiteboardId/elements/batch-move', whiteboardAuth, ah(async (req, res) => {
  const { moves, bringToFront } = req.body || {};
  if (!Array.isArray(moves) || !moves.length) return res.status(400).json({ error: 'Requête invalide' });

  const ids = moves.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const existingRows = await tursoAll(
    `SELECT * FROM whiteboard_elements WHERE whiteboard_id = ? AND id IN (${placeholders})`,
    [req.params.whiteboardId, ...ids]
  );
  const existingById = new Map(existingRows.map(r => [r.id, r]));

  const zIndexById = new Map();
  if (bringToFront) {
    // Garde l'ordre relatif que le lot avait déjà (son propre empilement interne) plutôt que l'ordre
    // d'arrivée dans la requête, pour ne pas mélanger la pile en la faisant passer au premier plan.
    // Une frame reste toujours tout au fond : jamais incluse dans ce recalcul, même glissée avec son
    // contenu.
    const ordered = existingRows.filter(r => r.type !== 'frame').sort((a, b) => a.z_index - b.z_index);
    if (ordered.length) {
      const { max } = await tursoGet('SELECT MAX(z_index) as max FROM whiteboard_elements WHERE whiteboard_id = ?', [req.params.whiteboardId]);
      let next = (max ?? -1) + 1;
      ordered.forEach((row) => { zIndexById.set(row.id, next); next += 1; });
    }
  }

  // Appartenance aux frames recalculée d'après la position D'ARRIVÉE de chaque élément déplacé —
  // y compris quand la frame elle-même fait partie du lot (glissée avec son contenu), auquel cas on
  // utilise sa position d'arrivée à elle plutôt que son ancienne position.
  const moveById = new Map(moves.map(m => [m.id, m]));
  const allFrameRows = await tursoAll(
    'SELECT id, x, y, width, height, z_index FROM whiteboard_elements WHERE whiteboard_id = ? AND type = ?',
    [req.params.whiteboardId, 'frame']
  );
  const frameRowsForContainment = allFrameRows.map((f) => {
    const m = moveById.get(f.id);
    return m ? { ...f, x: m.x, y: m.y } : f;
  });

  const updated = [];
  for (const move of moves) {
    const existing = existingById.get(move.id);
    if (!existing) continue;
    const zIndex = zIndexById.has(move.id) ? zIndexById.get(move.id) : existing.z_index;
    const frameId = existing.type === 'frame'
      ? existing.frame_id
      : findContainingFrame(move.x, move.y, existing.width, existing.height, frameRowsForContainment, null);
    await tursoRun(
      'UPDATE whiteboard_elements SET x = ?, y = ?, z_index = ?, frame_id = ?, updated_at = unixepoch() WHERE id = ?',
      [move.x, move.y, zIndex, frameId, move.id]
    );
    const row = await tursoGet('SELECT * FROM whiteboard_elements WHERE id = ?', [move.id]);
    updated.push(parseElement(row, { withImageData: false }));
  }

  await touchWhiteboard(req.params.whiteboardId);
  broadcast('elements:updated', { elements: updated }, req.params.whiteboardId);
  res.json({ elements: updated });
}));

// Diffusion "live" pendant un drag/resize/rotation (pas de persistance ni d'activité) : la valeur
// finale est persistée séparément via PATCH au relâchement, comme le curseur de souris.
app.post('/api/whiteboards/:whiteboardId/elements/:id/live', whiteboardAuth, (req, res) => {
  const { x, y, width, height, rotation } = req.body || {};
  broadcast('element:dragging', { id: req.params.id, x, y, width, height, rotation }, req.params.whiteboardId);
  res.status(204).end();
});

app.delete('/api/whiteboards/:whiteboardId/elements/:id', whiteboardAuth, ah(async (req, res) => {
  const existing = await tursoGet('SELECT * FROM whiteboard_elements WHERE id = ? AND whiteboard_id = ?', [req.params.id, req.params.whiteboardId]);
  if (!existing) return res.status(404).json({ error: 'Introuvable' });

  // Un connecteur ancré à cet élément n'a plus de sens une fois l'élément supprimé — on le supprime
  // en cascade et on informe les autres clients pour qu'ils retirent le trait de leur canvas.
  async function deleteOne(elId) {
    const orphanConnectors = await tursoAll(
      'SELECT id FROM whiteboard_elements WHERE whiteboard_id = ? AND type = ? AND (from_element_id = ? OR to_element_id = ?)',
      [req.params.whiteboardId, 'connector', elId, elId]
    );
    await tursoRun('DELETE FROM whiteboard_elements WHERE id = ?', [elId]);
    await tursoRun('DELETE FROM whiteboard_reactions WHERE element_id = ?', [elId]);
    await tursoRun('DELETE FROM whiteboard_comments WHERE element_id = ?', [elId]);
    for (const c of orphanConnectors) {
      await tursoRun('DELETE FROM whiteboard_elements WHERE id = ?', [c.id]);
      await tursoRun('DELETE FROM whiteboard_reactions WHERE element_id = ?', [c.id]);
      await tursoRun('DELETE FROM whiteboard_comments WHERE element_id = ?', [c.id]);
      broadcast('element:deleted', { id: c.id }, req.params.whiteboardId);
    }
  }

  // Supprimer une frame : soit tout son contenu part avec elle (choix demandé côté client), soit son
  // contenu reste sur le tableau, simplement détaché (comme un dégroupement).
  if (existing.type === 'frame') {
    const children = await tursoAll('SELECT id FROM whiteboard_elements WHERE whiteboard_id = ? AND frame_id = ?', [req.params.whiteboardId, existing.id]);
    if (req.body?.deleteContents) {
      for (const c of children) {
        await deleteOne(c.id);
        broadcast('element:deleted', { id: c.id }, req.params.whiteboardId);
      }
    } else if (children.length) {
      await tursoRun('UPDATE whiteboard_elements SET frame_id = NULL WHERE whiteboard_id = ? AND frame_id = ?', [req.params.whiteboardId, existing.id]);
      for (const c of children) {
        const row = await tursoGet('SELECT * FROM whiteboard_elements WHERE id = ?', [c.id]);
        broadcast('element:updated', parseElement(row, { withImageData: false }), req.params.whiteboardId);
      }
    }
  }

  await deleteOne(req.params.id);
  const whiteboard = await tursoGet('SELECT client_name, workshop_name FROM whiteboards WHERE id = ?', [req.params.whiteboardId]);
  await logActivity('element_deleted', req.user.name, whiteboard?.client_name, whiteboard?.workshop_name, `${ELEMENT_LABELS[existing.type]} supprimé`);
  await touchWhiteboard(req.params.whiteboardId);
  broadcast('element:deleted', { id: req.params.id }, req.params.whiteboardId);
  res.json({ ok: true });
}));

// =====================
// VOTES ET COMMENTAIRES (par élément)
// =====================

// Un simple marqueur de présence par (élément, participant) : re-cliquer retire son vote. On
// réutilise la table whiteboard_reactions de l'ancien système à émojis (colonne "emoji" ignorée,
// toujours écrite avec la même valeur), pour ne pas avoir à migrer les votes déjà posés en prod.
app.post('/api/whiteboards/:whiteboardId/elements/:elementId/vote', whiteboardAuth, ah(async (req, res) => {
  const element = await tursoGet('SELECT id FROM whiteboard_elements WHERE id = ? AND whiteboard_id = ?', [req.params.elementId, req.params.whiteboardId]);
  if (!element) return res.status(404).json({ error: 'Introuvable' });
  const existing = await tursoGet(
    'SELECT id FROM whiteboard_reactions WHERE element_id = ? AND actor_name = ?',
    [req.params.elementId, req.user.name]
  );
  if (existing) {
    await tursoRun('DELETE FROM whiteboard_reactions WHERE id = ?', [existing.id]);
  } else {
    await tursoRun(
      'INSERT INTO whiteboard_reactions (id, whiteboard_id, element_id, actor_name, emoji) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), req.params.whiteboardId, req.params.elementId, req.user.name, '+1']
    );
  }
  const rows = await tursoAll('SELECT actor_name FROM whiteboard_reactions WHERE element_id = ?', [req.params.elementId]);
  const voters = rows.map(r => r.actor_name);
  broadcast('element:votes', { elementId: req.params.elementId, voters }, req.params.whiteboardId);
  res.json({ voters });
}));

app.get('/api/whiteboards/:whiteboardId/elements/:elementId/comments', whiteboardAuth, ah(async (req, res) => {
  const rows = await tursoAll(
    'SELECT * FROM whiteboard_comments WHERE element_id = ? AND whiteboard_id = ? ORDER BY created_at ASC',
    [req.params.elementId, req.params.whiteboardId]
  );
  res.json(rows.map(parseComment));
}));

app.post('/api/whiteboards/:whiteboardId/elements/:elementId/comments', whiteboardAuth, ah(async (req, res) => {
  const text = (req.body?.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Commentaire vide' });
  const element = await tursoGet('SELECT id FROM whiteboard_elements WHERE id = ? AND whiteboard_id = ?', [req.params.elementId, req.params.whiteboardId]);
  if (!element) return res.status(404).json({ error: 'Introuvable' });
  const id = uuidv4();
  await tursoRun(
    'INSERT INTO whiteboard_comments (id, whiteboard_id, element_id, actor_name, actor_color, text) VALUES (?, ?, ?, ?, ?, ?)',
    [id, req.params.whiteboardId, req.params.elementId, req.user.name, req.user.color, text]
  );
  const row = await tursoGet('SELECT * FROM whiteboard_comments WHERE id = ?', [id]);
  const comment = parseComment(row);
  broadcast('element:comment', { elementId: req.params.elementId, comment }, req.params.whiteboardId);
  res.json(comment);
}));

// v1 : pas de droits, n'importe quel participant peut supprimer n'importe quel commentaire.
app.delete('/api/whiteboards/:whiteboardId/elements/:elementId/comments/:commentId', whiteboardAuth, ah(async (req, res) => {
  const existing = await tursoGet(
    'SELECT id FROM whiteboard_comments WHERE id = ? AND element_id = ? AND whiteboard_id = ?',
    [req.params.commentId, req.params.elementId, req.params.whiteboardId]
  );
  if (!existing) return res.status(404).json({ error: 'Introuvable' });
  await tursoRun('DELETE FROM whiteboard_comments WHERE id = ?', [req.params.commentId]);
  broadcast('element:comment-deleted', { elementId: req.params.elementId, commentId: req.params.commentId }, req.params.whiteboardId);
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
