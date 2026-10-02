(() => {
  // Groupées par famille de teinte (rouge/orangé/jaune, verts, bleus, violet/rose), puis les
  // neutres (noir, gris, blancs) tout à la fin.
  const ELEMENT_COLORS = ['#F38071', '#FFD7B8', '#FEEEBB', '#FFF083', '#9FCDA8', '#A9F3D5', '#9CD2D5', '#C2EBF7', '#DECCFA', '#FDD5E7', '#131114', '#D8D8D8', '#F8F8F8', '#FFFFFF'];
  // Pile de post-its en mode "aléatoire" (cf. iconShuffle/applyStackStyle) : plutôt qu'une couleur
  // unique, on garde une PAIRE [dessus, dessous] toujours différentes — le dessous, entraperçu au
  // survol (cf. .stack-visual:hover dans board.css), est la surprise qu'on découvre une fois le
  // dessus pris. `entry._stackColors` n'est qu'un état d'affichage local (ni persisté, ni synchronisé
  // entre participants) : un simple confort visuel, pas une garantie inter-participants.
  function pickColorDifferentFrom(color) {
    const candidates = ELEMENT_COLORS.filter(c => c !== color);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  function ensureStackRandomPreview(entry) {
    if (!entry._stackColors) {
      const top = ELEMENT_COLORS[Math.floor(Math.random() * ELEMENT_COLORS.length)];
      entry._stackColors = [top, pickColorDifferentFrom(top)];
    }
    return entry._stackColors;
  }
  // Le dessus de la pile est distribué (donc jamais revu) et le dessous prend sa place — qui devient
  // à son tour le prochain dessus la fois suivante : deux dessus consécutifs sont donc toujours
  // différents, par construction (dessus(n+1) = dessous(n) ≠ dessus(n)).
  function pickStackNoteColor(entry) {
    if (entry.data.color !== 'random') return entry.data.color;
    const [top, under] = ensureStackRandomPreview(entry);
    entry._stackColors = [under, pickColorDifferentFrom(under)];
    applyStackStyle(entry);
    return top;
  }

  // ---------- Arborescence (bloc "arbo") ----------
  // Toute la structure (titre + texte riche de chaque nœud, imbrication) vit dans UN SEUL élément
  // plateau : sérialisée en JSON dans `data.text` (racine ArboNode = {id,title,body,children}, cf.
  // ELEMENT_DEFAULTS.arbo/sanitizeArboText côté serveur). `entry.arboTree` est la copie de travail
  // locale (parsée une fois au rendu, mutée directement par les frappes/ajouts/suppressions, cf.
  // wireArboTree) — jamais reparsée depuis `entry.data.text` tant qu'on édite dans cet élément, pour
  // ne pas perdre une frappe en cours sur un écho serveur.
  const ARBO_MAX_DEPTH = 2; // profondeur max d'un nœud : 0 (racine, gris) à 2 (N-2) — pas de "+" au-delà.

  function newArboNode(title = '', body = '') {
    return { id: randomId(), title, body, children: [] };
  }

  function findArboNode(tree, id) {
    if (!tree) return null;
    if (tree.id === id) return tree;
    for (const child of tree.children) {
      const found = findArboNode(child, id);
      if (found) return found;
    }
    return null;
  }

  // Retire le nœud `id` de l'arbre (jamais la racine elle-même, qui se supprime comme n'importe quel
  // élément via le mécanisme générique) en le cherchant parmi les enfants à tous les niveaux.
  function removeArboNode(tree, id) {
    const idx = tree.children.findIndex(c => c.id === id);
    if (idx !== -1) { tree.children.splice(idx, 1); return true; }
    return tree.children.some(child => removeArboNode(child, id));
  }

  function countArboDescendants(node) {
    let count = 0;
    node.children.forEach((c) => { count += 1 + countArboDescendants(c); });
    return count;
  }

  // Trouve le PARENT direct du nœud `id` (pour restaurer sa position exacte — index compris — à
  // l'annulation d'une suppression, cf. showArboDeleteConfirm).
  function findArboParent(tree, id) {
    for (const child of tree.children) {
      if (child.id === id) return tree;
      const found = findArboParent(child, id);
      if (found) return found;
    }
    return null;
  }
  // Échelle nommée plutôt qu'un choix de tailles en pixels — mêmes valeurs que les tailles fixes du
  // bloc "consigne" pour "Sous-titre"/"Texte" (cf. .instruction-title/.instruction-desc dans board.css),
  // pour rester visuellement cohérent d'un bloc à l'autre.
  const FONT_SIZE_PRESETS = [['Gros titre', 52], ['Titre', 28], ['Sous-titre', 15], ['Texte', 13], ['Légende', 11]];
  function fontSizeOptionsHtml(current) {
    return FONT_SIZE_PRESETS.map(([label, s]) => `<option value="${s}"${Number(current) === s ? ' selected' : ''}>${label}</option>`).join('');
  }
  function webpageTypeOptionsHtml(current) {
    return WEBPAGE_TYPES.map(t => `<option value="${t.key}"${current === t.key ? ' selected' : ''}>${t.label}</option>`).join('');
  }
  const LINE_THICKNESSES = [2, 4, 6, 10];
  const LINE_STYLES = [['solid', 'Continu'], ['dashed', 'Pointillés']];
  const STROKE_WIDTHS = [0, 1, 2, 4, 6];
  const RADIUS_PRESETS = [['Aucun', 0, 0], ['Léger', 8, 3], ['Moyen', 20, 6], ['Complet', 999, 8]];
  const LINK_COLOR = '#1a56db'; // couleur "lien" forcée sur le texte d'un rectangle qui en a un (cf. applyRectangleTextStyle)
  const MIN_W = 60;
  const MIN_H = 40;
  const MIN_LINE_LENGTH = 30;
  const MIN_CROP_SIZE = 24;
  const MAX_IMAGE_DIM = 320;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  // ---- Import PDF (une page = une image, posées en mosaïque dans une frame, cf. plus bas) ----
  const MAX_PDF_BYTES = 40 * 1024 * 1024;
  const MAX_PDF_PAGES = 150;
  // Résolution de rendu de chaque page (qualité de la source) : découplée de sa taille d'AFFICHAGE
  // dans la mosaïque (PDF_MOSAIC_CELL_WIDTH) — on peut zoomer sur une page sans qu'elle devienne floue
  // plus vite qu'une image classique, sans pour autant peser le poids d'un rendu plein écran par page.
  const PDF_PAGE_RENDER_WIDTH = 1000;
  const PDF_PAGE_JPEG_QUALITY = 0.82; // JPEG plutôt que PNG : les pages (texte/diagrammes) compressent
                                      // beaucoup mieux ainsi, pour un rendu visuellement équivalent ici
  const PDF_MOSAIC_CELL_WIDTH = 240; // largeur d'affichage d'une page dans la mosaïque, hauteur au prorata
  const PDF_MOSAIC_COLUMNS = 3;
  const PDF_MOSAIC_PADDING = 20; // même valeur que côté serveur (cf. PDF_MOSAIC_PADDING dans server.js)
  // Nombre de pages envoyées par requête /elements/batch : borne la taille de chaque requête (indépen-
  // damment de la limite du serveur) plutôt que de compter sur une seule requête géante pour tout le
  // PDF, qui grossirait sans limite avec le nombre de pages.
  const PDF_BATCH_CHUNK = 25;
  // Reflète le même calcul que côté serveur (cf. FRAME_TITLE_HEIGHT/FRAME_MIN_HEIGHT dans server.js) —
  // utilisé uniquement pour l'aperçu live pendant le redimensionnement d'une mosaïque (cf.
  // liveReflowMosaic), jamais persisté directement : le serveur reste la seule source de vérité, ce
  // calcul ne fait qu'éviter d'attendre sa réponse pour voir les colonnes bouger.
  const FRAME_TITLE_HEIGHT = 40;
  const FRAME_MIN_HEIGHT = 100;
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 2.5;
  const TEXT_PAD_X_RATIO = 0.55;
  const TEXT_PAD_Y_RATIO = 0.35;
  const TEXT_LINE_HEIGHT_RATIO = 1.35;
  const TEXT_MIN_CONTENT_WIDTH = 30;
  const BOX_TYPES = ['note', 'text', 'image', 'rectangle', 'frame', 'instruction', 'tip', 'webpage', 'arbo']; // types "boîte" (points d'ancrage pour les connecteurs)
  const NOTE_DEFAULT_SIZE = 130; // post-it par défaut : carré, plus petit qu'avant (grandit ensuite avec le texte)
  const DRAG_Z_BOOST = 100000; // cf. startGroupDrag : conserve l'ordre relatif du groupe pendant le geste
  const GRID_SIZE = 10; // pas de la grille d'accrochage (glisser + flèches du clavier)
  const GRID_DOT_SPACING = GRID_SIZE * 5; // espacement (en unités monde) des points du fond — 5 pas de grille, donc 5 appuis de flèche entre deux points
  const ALIGN_SNAP_PX = 6; // seuil (en pixels écran) pour s'aligner sur le bord/centre d'un autre élément
  const UNLOCK_HOLD_MS = 2000;
  const COMMENT_RELATIVE_DAYS = 7; // au-delà, on affiche la date plutôt que "il y a X jours"

  const viewportEl = document.getElementById('canvasViewport');
  const layerEl = document.getElementById('canvasLayer');
  const zoomPctEl = document.getElementById('zoomPct');
  const hintPill = document.getElementById('hintPill');
  const busyPill = document.getElementById('busyPill');
  const topbarMoreBtn = document.getElementById('topbarMoreBtn');
  const topbarMoreMenu = document.getElementById('topbarMoreMenu');
  const gridToggleMenuBtn = document.getElementById('gridToggleMenuBtn');
  const gridToggleMenuLabel = document.getElementById('gridToggleMenuLabel');
  const saveTemplateMenuBtn = document.getElementById('saveTemplateMenuBtn');
  const templateDrawer = document.getElementById('templateDrawer');
  const templateDrawerOverlay = document.getElementById('templateDrawerOverlay');
  const templateDrawerCloseBtn = document.getElementById('templateDrawerCloseBtn');
  const templateNameInput = document.getElementById('templateNameInput');
  const templateTagsInput = document.getElementById('templateTagsInput');
  const templateSaveBtn = document.getElementById('templateSaveBtn');
  const addToolbar = document.getElementById('addToolbar');
  const addToolbarCollapseBtn = document.getElementById('addToolbarCollapseBtn');
  const addToolbarRevealBtn = document.getElementById('addToolbarRevealBtn');
  const addFlyout = document.getElementById('addFlyout');
  const addSubFlyout = document.getElementById('addSubFlyout');
  const imageFileInput = document.getElementById('imageFileInput');
  const pdfFileInput = document.getElementById('pdfFileInput');
  const toolbarEl = document.getElementById('elementToolbar');
  const richTextToolbarEl = document.getElementById('richTextToolbar');
  const commentDrawer = document.getElementById('commentDrawer');
  const commentDrawerOverlay = document.getElementById('commentDrawerOverlay');
  const commentDrawerCloseBtn = document.getElementById('commentDrawerCloseBtn');
  const commentDrawerBody = document.getElementById('commentDrawerBody');
  const commentInput = document.getElementById('commentInput');
  const commentSendBtn = document.getElementById('commentSendBtn');
  const historyBtn = document.getElementById('historyBtn');
  const historyDot = document.getElementById('historyDot');
  const historyDrawer = document.getElementById('historyDrawer');
  const historyDrawerOverlay = document.getElementById('historyDrawerOverlay');
  const historyDrawerCloseBtn = document.getElementById('historyDrawerCloseBtn');
  const historyDrawerBody = document.getElementById('historyDrawerBody');

  const elements = new Map(); // id -> { data, el, textEl? }
  const connectorsByElementId = new Map(); // elementId -> Set<connectorId>
  let pan = { x: 0, y: 0 };
  let zoom = 1;
  let creationCount = 0;
  let editingElementId = null;
  let selectedElementId = null;
  let myName = null;
  let activeCommentElementId = null;
  let multiSelectedIds = new Set();
  let didInitialCenter = false;
  let pendingImagePlacement = null;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function randomId() { return `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

  function worldToScreen(x, y) { return { x: x * zoom + pan.x, y: y * zoom + pan.y }; }
  function screenToWorld(x, y) { return { x: (x - pan.x) / zoom, y: (y - pan.y) / zoom }; }

  function applyTransform() {
    layerEl.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    // Le fond en grille est un décor CSS sur #canvasViewport (donc hors du calque zoomé/panné) : sans
    // ça il resterait fixe à l'écran, sans rapport avec les coordonnées monde — un coin d'élément posé
    // pile sur un trait n'aurait alors aucune raison de retomber sur le suivant après quelques appuis
    // de flèche. On le recale ici sur la grille d'accrochage, mis à l'échelle/positionné comme le
    // reste du contenu (cf. worldToScreen) : deux jeux de traits superposés (cf. board.css), un tous
    // les GRID_DOT_SPACING (majeur) et un tous les GRID_SIZE (mineur), tous deux alignés sur l'origine
    // monde (contrairement à l'ancien fond à points, un trait n'a pas besoin d'un décalage d'un demi-
    // pas : il est déjà au bord de sa tuile, pas en son centre).
    const majorSize = GRID_DOT_SPACING * zoom;
    const minorSize = GRID_SIZE * zoom;
    viewportEl.style.backgroundSize = `${majorSize}px ${majorSize}px, ${majorSize}px ${majorSize}px, ${minorSize}px ${minorSize}px, ${minorSize}px ${minorSize}px`;
    viewportEl.style.backgroundPosition = `${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px`;
    zoomPctEl.textContent = `${Math.round(zoom * 100)}%`;
    Realtime.repositionAll();
    if (selectedElementId) {
      const entry = elements.get(selectedElementId);
      if (entry) {
        repositionToolbar(entry);
        if (entry.data.locked) showGroupFrame(entry);
      }
    }
    if (multiSelectedIds.size >= 2) repositionMultiToolbar();
  }

  function getViewportPoint(e) {
    const rect = viewportEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hideHint() { hintPill.classList.add('is-hidden'); }

  // ---------- Grille (afficher/masquer) ----------
  // Préférence propre à ce navigateur (pas une donnée du tableau partagée) : chacun choisit s'il
  // affiche la grille ou pas.
  const GRID_VISIBLE_KEY = 'tb_grid_visible';
  let gridVisible = localStorage.getItem(GRID_VISIBLE_KEY) !== '0';
  function applyGridVisibility() {
    viewportEl.classList.toggle('grid-hidden', !gridVisible);
    gridToggleMenuLabel.textContent = gridVisible ? 'Masquer la grille' : 'Afficher la grille';
  }
  applyGridVisibility();

  // ---------- Menu "…" de la barre du haut (grille, enregistrer en tant que template) ----------
  function closeTopbarMoreMenu() { topbarMoreMenu.classList.remove('is-open'); }
  topbarMoreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = topbarMoreMenu.classList.contains('is-open');
    closeTopbarMoreMenu();
    if (wasOpen) return;
    topbarMoreMenu.classList.add('is-open');
    const r = topbarMoreBtn.getBoundingClientRect();
    const mRect = topbarMoreMenu.getBoundingClientRect();
    topbarMoreMenu.style.left = `${clamp(r.right - mRect.width, 8, window.innerWidth - mRect.width - 8)}px`;
    topbarMoreMenu.style.top = `${r.bottom + 8}px`;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!topbarMoreMenu.contains(e.target) && e.target !== topbarMoreBtn && !topbarMoreBtn.contains(e.target)) closeTopbarMoreMenu();
  });

  gridToggleMenuBtn.addEventListener('click', () => {
    gridVisible = !gridVisible;
    try { localStorage.setItem(GRID_VISIBLE_KEY, gridVisible ? '1' : '0'); } catch (_) {}
    applyGridVisibility();
    closeTopbarMoreMenu();
  });

  function openTemplateDrawer() {
    templateNameInput.value = '';
    templateTagsInput.value = '';
    templateDrawer.classList.add('is-open');
    templateDrawerOverlay.classList.add('is-open');
    setTimeout(() => templateNameInput.focus(), 50);
  }
  function closeTemplateDrawer() {
    templateDrawer.classList.remove('is-open');
    templateDrawerOverlay.classList.remove('is-open');
  }
  saveTemplateMenuBtn.addEventListener('click', () => { closeTopbarMoreMenu(); openTemplateDrawer(); });
  templateDrawerCloseBtn.addEventListener('click', closeTemplateDrawer);
  templateDrawerOverlay.addEventListener('click', closeTemplateDrawer);

  // Capture TOUT le contenu actuel du tableau (cf. snapshotForCreate, même forme que pour copier/
  // coller) — verrouillage et votes/commentaires ne sont jamais repris (snapshotForCreate ne les
  // transporte déjà pas) : un template est un point de départ propre, pas un clone exact de l'activité.
  templateSaveBtn.addEventListener('click', () => {
    const name = templateNameInput.value.trim();
    if (!name) { alert('Merci de donner un titre au template.'); return; }
    const data = [...elements.values()].map(en => snapshotForCreate(en.data));
    if (!data.length) { alert('Le tableau est vide.'); return; }
    const tags = templateTagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
    withBusy(Api.createTemplate({ name, tags, data }))
      .then(() => {
        const original = templateSaveBtn.textContent;
        templateSaveBtn.textContent = 'Enregistré !';
        setTimeout(() => { templateSaveBtn.textContent = original; closeTemplateDrawer(); }, 900);
      })
      .catch(err => alert(err.message));
  });

  // ---------- Indicateur "en cours" ----------
  // Une action groupée (annuler la suppression de nombreux éléments, coller une grosse sélection)
  // peut prendre quelques secondes sur une base distante : sans repère, on ne sait pas si le clic a
  // été pris en compte. N'apparaît qu'après un court délai (les actions rapides, largement
  // majoritaires, ne doivent pas faire clignoter un loader inutilement).
  const BUSY_SHOW_DELAY_MS = 400;
  let busyDepth = 0;
  let busyShowTimer = null;
  function beginBusy() {
    busyDepth++;
    if (busyDepth === 1) busyShowTimer = setTimeout(() => busyPill.classList.add('is-visible'), BUSY_SHOW_DELAY_MS);
  }
  function endBusy() {
    busyDepth = Math.max(0, busyDepth - 1);
    if (busyDepth === 0) {
      clearTimeout(busyShowTimer);
      busyPill.classList.remove('is-visible');
    }
  }
  function withBusy(promise) {
    beginBusy();
    return promise.finally(endBusy);
  }

  // ---------- Annuler (Ctrl/Cmd+Z) ----------
  // Pile de désactions locales à cette session : chaque entrée sait comment annuler LA dernière
  // action (pas un vrai historique partagé/rejouable pour tout le monde). Une action qui touche
  // plusieurs éléments d'un coup (dupliquer une frame avec son contenu, supprimer une sélection,
  // coller) pousse UNE seule entrée qui annule tout le lot ensemble.
  const undoStack = [];
  const UNDO_LIMIT = 50;
  function recordUndo(fn) {
    undoStack.push(fn);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }
  async function undoLastAction() {
    const fn = undoStack.pop();
    if (!fn) return;
    try { await withBusy(fn()); } catch (_) { /* au pire l'annulation échoue silencieusement */ }
  }

  // Pousse un cran d'annulation pour un ou plusieurs champs changés sur UN SEUL élément — le pattern
  // le plus courant du toolbar (couleur, police, bordure, épaisseur de trait...) : un simple PATCH qui
  // restaure exactement les valeurs d'avant, confirmé comme les autres (cf. applyRemoteUpdate).
  function recordFieldUndo(id, beforePatch) {
    recordUndo(() => Api.updateElement(id, beforePatch).then(applyRemoteUpdate).catch(() => {}));
  }

  // Même principe mais pour PLUSIEURS éléments à la fois (verrouillage/groupement d'un groupe entier) :
  // chaque élément restaure SA PROPRE valeur d'avant (elles peuvent différer, ex. grouper des éléments
  // venant de groupes différents), d'où `items` plutôt qu'une seule valeur appliquée à tous.
  function recordMultiFieldUndo(items, column) {
    if (!items.length) return;
    recordUndo(() => Promise.all(items.map(({ id, before }) =>
      Api.updateElement(id, { [column]: before }).then(applyRemoteUpdate).catch(() => {})
    )));
  }

  // ---------- Accrochage (grille + alignement sur les autres éléments) ----------

  function snapToGrid(v) { return Math.round(v / GRID_SIZE) * GRID_SIZE; }

  let guideVEl = null, guideHEl = null;
  function ensureGuideEls() {
    if (!guideVEl) { guideVEl = document.createElement('div'); guideVEl.className = 'align-guide align-guide-v'; viewportEl.appendChild(guideVEl); }
    if (!guideHEl) { guideHEl = document.createElement('div'); guideHEl.className = 'align-guide align-guide-h'; viewportEl.appendChild(guideHEl); }
  }
  function showGuideV(worldX) {
    ensureGuideEls();
    guideVEl.style.left = `${worldToScreen(worldX, 0).x}px`;
    guideVEl.style.display = 'block';
  }
  function showGuideH(worldY) {
    ensureGuideEls();
    guideHEl.style.top = `${worldToScreen(0, worldY).y}px`;
    guideHEl.style.display = 'block';
  }
  function hideGuides() {
    if (guideVEl) guideVEl.style.display = 'none';
    if (guideHEl) guideHEl.style.display = 'none';
  }

  // Calcule la position accrochée d'une boîte (coin haut-gauche visé rawX/rawY, de taille
  // width/height) : d'abord sur la grille, puis — si assez proche — remplacée par un alignement exact
  // avec le bord/centre d'un autre élément (comme Figma/Miro), qui l'emporte sur la grille pour l'axe
  // concerné. `excludeIds` écarte les éléments eux-mêmes en cours de déplacement (et leurs éventuels
  // enfants de frame) de la comparaison.
  function computeSnappedPosition(width, height, rawX, rawY, excludeIds) {
    let x = snapToGrid(rawX);
    let y = snapToGrid(rawY);
    const threshold = ALIGN_SNAP_PX / zoom;
    let bestDx = threshold, bestDy = threshold;
    let guideVWorldX = null, guideHWorldY = null;
    const movingX = [rawX, rawX + width / 2, rawX + width];
    const movingY = [rawY, rawY + height / 2, rawY + height];

    elements.forEach((en) => {
      if (excludeIds.has(en.data.id) || en.data.type === 'connector') return;
      const d = en.data;
      const targetsX = [d.x, d.x + d.width / 2, d.x + d.width];
      const targetsY = [d.y, d.y + d.height / 2, d.y + d.height];
      movingX.forEach((moving, i) => {
        targetsX.forEach((target) => {
          const dx = Math.abs(moving - target);
          if (dx < bestDx) { bestDx = dx; x = target - [0, width / 2, width][i]; guideVWorldX = target; }
        });
      });
      movingY.forEach((moving, i) => {
        targetsY.forEach((target) => {
          const dy = Math.abs(moving - target);
          if (dy < bestDy) { bestDy = dy; y = target - [0, height / 2, height][i]; guideHWorldY = target; }
        });
      });
    });

    // Toujours un multiple de GRID_SIZE au final, même quand l'alignement sur un autre élément a pris
    // le dessus ci-dessus (son bord/centre visé n'en est pas forcément un — ex. le centre d'un "rond"
    // de largeur 150) : le calage sur la grille prime toujours sur l'alignement fin.
    return { x: snapToGrid(x), y: snapToGrid(y), guideVWorldX, guideHWorldY };
  }

  // Utilisée par un glisser (simple/groupé) : applique l'accrochage, affiche/masque les repères, et
  // renvoie le delta monde à appliquer à tout le lot déplacé (le calcul se fait sur l'élément
  // "meneur" du geste, cf. wireBodyDrag/startGroupDrag).
  function applyDragSnap(width, height, rawX, rawY, excludeIds, bypass) {
    if (bypass) { hideGuides(); return { x: rawX, y: rawY }; }
    const snapped = computeSnappedPosition(width, height, rawX, rawY, excludeIds);
    if (snapped.guideVWorldX !== null) showGuideV(snapped.guideVWorldX); else if (guideVEl) guideVEl.style.display = 'none';
    if (snapped.guideHWorldY !== null) showGuideH(snapped.guideHWorldY); else if (guideHEl) guideHEl.style.display = 'none';
    return snapped;
  }

  // Restaure un instantané de positions (id/x/y) — utilisé pour annuler un déplacement (glisser,
  // flèches du clavier). Un simple lot en position seule (comme un glisser), sans repasser au
  // premier plan : annuler ne doit pas rejouer la bataille de z-index.
  function restoreMovedPositions(snapshot) {
    if (!snapshot.length) return Promise.resolve();
    return Api.updateElementsBatch(snapshot.map(s => ({ id: s.id, x: s.x, y: s.y })), false)
      .then(({ elements: updated, superseded, isLatest }) => { if (!superseded && isLatest) updated.forEach(applyRemoteUpdate); })
      .catch(() => {});
  }

  // ---------- Zoom / pan (molette et trackpad uniquement — le glisser du fond sert à la sélection) ----------

  viewportEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    hideHint();
    if (e.ctrlKey || e.metaKey) {
      const { x: sx, y: sy } = getViewportPoint(e);
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const factor = Math.exp(-e.deltaY * 0.012);
      const newZoom = clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX);
      pan.x = sx - wx * newZoom;
      pan.y = sy - wy * newZoom;
      zoom = newZoom;
    } else {
      pan.x -= e.deltaX;
      pan.y -= e.deltaY;
    }
    applyTransform();
  }, { passive: false });

  function zoomBy(factor) {
    const rect = viewportEl.getBoundingClientRect();
    const sx = rect.width / 2, sy = rect.height / 2;
    const { x: wx, y: wy } = screenToWorld(sx, sy);
    const newZoom = clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX);
    pan.x = sx - wx * newZoom;
    pan.y = sy - wy * newZoom;
    zoom = newZoom;
    applyTransform();
  }
  document.getElementById('zoomInBtn').addEventListener('click', () => zoomBy(1.25));
  document.getElementById('zoomOutBtn').addEventListener('click', () => zoomBy(0.8));
  document.getElementById('zoomResetBtn').addEventListener('click', () => {
    zoom = 1;
    centerView(contentBounds());
    applyTransform();
  });

  // Boîte englobante d'une liste d'éléments (coordonnées monde) — pour centrer la vue dessus plutôt
  // que sur l'origine (0,0), qui n'a souvent aucun rapport avec où se trouve le contenu. `null` pour
  // une liste vide (repli sur l'origine, cf. centerView).
  function boundsOfList(list) {
    if (!list.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach((d) => {
      minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
      maxX = Math.max(maxX, d.x + d.width); maxY = Math.max(maxY, d.y + d.height);
    });
    return { minX, minY, maxX, maxY };
  }
  function contentBounds() { return boundsOfList([...elements.values()].map(e => e.data)); }

  function centerView(bounds) {
    const rect = viewportEl.getBoundingClientRect();
    const cx = bounds ? (bounds.minX + bounds.maxX) / 2 : 0;
    const cy = bounds ? (bounds.minY + bounds.maxY) / 2 : 0;
    pan.x = rect.width / 2 - cx * zoom;
    pan.y = rect.height / 2 - cy * zoom;
  }

  // ---------- Sélection rectangle (glisser sur le fond) ----------

  let isSelecting = false;
  let selectionMoved = false;
  let selectionStartScreen = null;
  let selectionBoxEl = null;

  function updateSelectionBoxVisual(x1, y1, x2, y2) {
    if (!selectionBoxEl) {
      selectionBoxEl = document.createElement('div');
      selectionBoxEl.className = 'selection-box';
      document.body.appendChild(selectionBoxEl);
    }
    const left = Math.min(x1, x2), top = Math.min(y1, y2);
    selectionBoxEl.style.left = `${left}px`;
    selectionBoxEl.style.top = `${top}px`;
    selectionBoxEl.style.width = `${Math.abs(x2 - x1)}px`;
    selectionBoxEl.style.height = `${Math.abs(y2 - y1)}px`;
  }

  function rectsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  viewportEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.element')) return;
    deselectElement();
    clearMultiSelection();
    closeConfirmPopover();
    closeAddFlyout();
    isSelecting = true;
    selectionMoved = false;
    selectionStartScreen = { x: e.clientX, y: e.clientY };
    viewportEl.setPointerCapture(e.pointerId);
    hideHint();
  });

  window.addEventListener('pointermove', (e) => {
    if (isSelecting) {
      const dx = e.clientX - selectionStartScreen.x;
      const dy = e.clientY - selectionStartScreen.y;
      if (!selectionMoved && Math.hypot(dx, dy) > 4) selectionMoved = true;
      if (selectionMoved) updateSelectionBoxVisual(selectionStartScreen.x, selectionStartScreen.y, e.clientX, e.clientY);
    }
    const { x: sx, y: sy } = getViewportPoint(e);
    const { x: wx, y: wy } = screenToWorld(sx, sy);
    Realtime.notifyLocalPointer(wx, wy);
  });

  window.addEventListener('pointerup', (e) => {
    if (!isSelecting) return;
    isSelecting = false;
    if (selectionBoxEl) { selectionBoxEl.remove(); selectionBoxEl = null; }
    if (!selectionMoved) return;
    const selRect = {
      left: Math.min(selectionStartScreen.x, e.clientX),
      right: Math.max(selectionStartScreen.x, e.clientX),
      top: Math.min(selectionStartScreen.y, e.clientY),
      bottom: Math.max(selectionStartScreen.y, e.clientY),
    };
    const captured = [];
    elements.forEach((entry) => {
      if (entry.data.locked) return;
      const r = entry.el.getBoundingClientRect();
      if (rectsIntersect(selRect, r)) captured.push(entry.data.id);
    });
    if (captured.length === 1) selectElement(captured[0]);
    else if (captured.length >= 2) setMultiSelection(captured);
  });

  // ---------- Barre "ajouter" flottante (façon Miro) ----------
  // Chaque bouton "arme" un outil de pose (cf. armPlacement) : le curseur est suivi d'une pastille
  // représentant l'élément, et c'est le PROCHAIN CLIC SUR LE CANVAS qui le crée, à cet endroit précis —
  // jamais de création directe au centre de l'écran. Les familles à plusieurs variantes (Formes, Blocs)
  // et les deux réglages "à choisir avant de poser" (couleur du post-it, taille du texte) passent par
  // le même sous-menu #addFlyout, positionné à droite du bouton cliqué ; y choisir une option arme
  // aussitôt l'outil correspondant.

  const ADD_TOOLBAR_COLLAPSED_KEY = 'tb_add_toolbar_collapsed';

  // Bloc "page web" (mini wireframe + titre + description, cf. plus bas dans le fichier pour son
  // rendu/édition) : chaque type a son wireframe fixe, construit à partir de simples rectangles/traits/
  // ronds (pas précis, juste illustratif — cf. la demande d'Antoine) — même contenu SVG utilisé en
  // grand dans l'élément posé et en petit comme icône de son entrée dans le sous-menu (cf. wpSvg).
  const WEBPAGE_TYPES = [
    { key: 'accueil', label: 'Accueil' },
    { key: 'connexion', label: 'Connexion' },
    { key: 'liste', label: 'Liste' },
    { key: 'fiche-produit', label: 'Fiche produit' },
    { key: 'formulaire', label: 'Formulaire' },
    { key: 'paiement', label: 'Paiement' },
    { key: 'landing', label: 'Landing Page' },
  ];
  const WEBPAGE_INNER = {
    accueil: `
      <rect x="10" y="20" width="20" height="6" rx="1" fill="#d5d5dc"/>
      <rect x="94" y="21" width="12" height="4" fill="#e6e6ea"/><rect x="110" y="21" width="12" height="4" fill="#e6e6ea"/><rect x="126" y="21" width="14" height="4" fill="#e6e6ea"/>
      <rect x="10" y="32" width="130" height="26" rx="3" fill="#f0e4bd"/>
      <rect x="10" y="66" width="36" height="22" rx="3" fill="#f2f2f5"/><rect x="52" y="66" width="36" height="22" rx="3" fill="#f2f2f5"/><rect x="94" y="66" width="36" height="22" rx="3" fill="#f2f2f5"/>
      <circle cx="28" cy="74" r="4" fill="#E0A62B"/><circle cx="70" cy="74" r="4" fill="#E0A62B"/><circle cx="112" cy="74" r="4" fill="#E0A62B"/>
    `,
    connexion: `
      <rect x="45" y="22" width="60" height="64" rx="4" fill="#f7f7f9" stroke="#e4e4ec"/>
      <rect x="60" y="30" width="30" height="6" rx="1" fill="#d5d5dc"/>
      <rect x="53" y="44" width="44" height="10" rx="2" fill="#fff" stroke="#ddd"/>
      <rect x="53" y="58" width="44" height="10" rx="2" fill="#fff" stroke="#ddd"/>
      <rect x="53" y="74" width="44" height="9" rx="3" fill="#E0A62B"/>
    `,
    liste: `
      <rect x="10" y="20" width="14" height="14" rx="2" fill="#e6e6ea"/><rect x="30" y="21" width="80" height="5" fill="#d5d5dc"/><rect x="30" y="28" width="50" height="4" fill="#e6e6ea"/>
      <rect x="10" y="38" width="14" height="14" rx="2" fill="#e6e6ea"/><rect x="30" y="39" width="80" height="5" fill="#d5d5dc"/><rect x="30" y="46" width="50" height="4" fill="#e6e6ea"/>
      <rect x="10" y="56" width="14" height="14" rx="2" fill="#e6e6ea"/><rect x="30" y="57" width="80" height="5" fill="#d5d5dc"/><rect x="30" y="64" width="50" height="4" fill="#e6e6ea"/>
      <rect x="10" y="74" width="14" height="14" rx="2" fill="#e6e6ea"/><rect x="30" y="75" width="80" height="5" fill="#d5d5dc"/><rect x="30" y="82" width="50" height="4" fill="#e6e6ea"/>
    `,
    'fiche-produit': `
      <rect x="10" y="20" width="58" height="66" rx="3" fill="#e6e6ea"/>
      <rect x="78" y="24" width="60" height="7" fill="#d5d5dc"/>
      <rect x="78" y="38" width="30" height="6" fill="#E0A62B"/>
      <rect x="78" y="52" width="60" height="4" fill="#e6e6ea"/><rect x="78" y="60" width="55" height="4" fill="#e6e6ea"/><rect x="78" y="68" width="40" height="4" fill="#e6e6ea"/>
      <rect x="78" y="78" width="45" height="9" rx="3" fill="#E0A62B"/>
    `,
    formulaire: `
      <rect x="10" y="20" width="30" height="4" fill="#d5d5dc"/><rect x="10" y="26" width="130" height="9" rx="2" fill="#fff" stroke="#ddd"/>
      <rect x="10" y="40" width="30" height="4" fill="#d5d5dc"/><rect x="10" y="46" width="130" height="9" rx="2" fill="#fff" stroke="#ddd"/>
      <rect x="10" y="60" width="25" height="4" fill="#d5d5dc"/><rect x="10" y="66" width="60" height="9" rx="2" fill="#fff" stroke="#ddd"/>
      <rect x="80" y="60" width="25" height="4" fill="#d5d5dc"/><rect x="80" y="66" width="60" height="9" rx="2" fill="#fff" stroke="#ddd"/>
      <rect x="10" y="82" width="40" height="9" rx="3" fill="#E0A62B"/>
    `,
    paiement: `
      <rect x="10" y="20" width="60" height="14" rx="2" fill="#f2f2f5"/><rect x="18" y="24" width="30" height="4" fill="#d5d5dc"/>
      <rect x="10" y="38" width="60" height="14" rx="2" fill="#f2f2f5"/><rect x="18" y="42" width="30" height="4" fill="#d5d5dc"/>
      <rect x="10" y="56" width="60" height="14" rx="2" fill="#f2f2f5"/><rect x="18" y="60" width="30" height="4" fill="#d5d5dc"/>
      <rect x="85" y="20" width="55" height="56" rx="3" fill="#f7f7f9" stroke="#e4e4ec"/>
      <rect x="92" y="28" width="40" height="5" fill="#d5d5dc"/><rect x="92" y="40" width="40" height="4" fill="#e6e6ea"/><rect x="92" y="48" width="25" height="4" fill="#e6e6ea"/>
      <rect x="92" y="62" width="40" height="9" rx="3" fill="#E0A62B"/>
    `,
    landing: `
      <rect x="10" y="20" width="20" height="5" fill="#d5d5dc"/><rect x="110" y="20" width="12" height="5" fill="#e6e6ea"/><rect x="126" y="20" width="14" height="5" fill="#e6e6ea"/>
      <rect x="35" y="34" width="80" height="8" fill="#d5d5dc"/>
      <rect x="45" y="46" width="60" height="6" fill="#e6e6ea"/>
      <rect x="60" y="58" width="30" height="10" rx="5" fill="#E0A62B"/>
      <circle cx="55" cy="80" r="5" fill="#E0A62B" opacity="0.5"/><circle cx="75" cy="80" r="5" fill="#E0A62B"/><circle cx="95" cy="80" r="5" fill="#E0A62B" opacity="0.5"/>
    `,
  };
  // `w`/`h` en nombre (px) ou "100%" — même contenu, juste une taille de rendu différente (icône du
  // sous-menu vs illustration réelle dans l'élément posé, cf. .webpage-wireframe).
  function wpSvg(key, w, h) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 150 100" xmlns="http://www.w3.org/2000/svg">
      <rect width="150" height="14" fill="#eee"/>
      <circle cx="9" cy="7" r="2" fill="#c9c4b8"/><circle cx="17" cy="7" r="2" fill="#c9c4b8"/><circle cx="25" cy="7" r="2" fill="#c9c4b8"/>
      ${WEBPAGE_INNER[key] || ''}
    </svg>`;
  }

  const ADD_FLYOUTS = {
    shapes: {
      kind: 'items',
      items: [
        { type: 'rectangle', label: 'Rectangle', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/></svg>' },
        { type: 'line', label: 'Trait', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="5"/></svg>' },
        { type: 'rectangle', variant: 'ellipse', label: 'Rond', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>' },
        { type: 'rectangle', variant: 'diamond', label: 'Losange', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12,3 21,12 12,21 3,12"/></svg>' },
      ],
    },
    webpages: {
      kind: 'items',
      items: WEBPAGE_TYPES.map(t => ({ type: 'webpage', variant: t.key, label: t.label, icon: wpSvg(t.key, 22, 15) })),
    },
    notecolors: { kind: 'colors' },
    textstyles: { kind: 'textstyles' },
    uploads: { kind: 'uploads' },
    templates: { kind: 'templates' },
  };

  // Consigne/Tips sont désormais considérés comme des "templates" (les deux premiers de la liste,
  // toujours présents) — mais restent posés comme AVANT (un seul élément 'instruction'/'tip' créé
  // directement, cf. placeNewElement), pas via le mécanisme de snapshots des VRAIS templates
  // enregistrés (qui eux viennent du serveur, cf. kind:'templates' dans renderFlyoutContent).
  const BUILTIN_TEMPLATE_ITEMS = [
    { type: 'instruction', label: 'Consigne', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><path d="M6 5.5h2v3"/><line x1="4" y1="16" x2="20" y2="16"/><line x1="4" y1="20" x2="15" y2="20"/></svg>' },
    { type: 'tip', label: 'Tips', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .8 1.7v.5h5.6v-.5c0-.7.3-1.3.8-1.7A6 6 0 0 0 12 3z"/></svg>' },
    { type: 'arbo', label: 'Arborescence', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7" height="5" rx="1"/><rect x="14" y="4" width="7" height="5" rx="1"/><rect x="14" y="15" width="7" height="5" rx="1"/><path d="M6.5 9v3a2 2 0 0 0 2 2H14"/><path d="M14 17.5H8.5a2 2 0 0 1-2-2V12"/></svg>' },
  ];
  // Icône générique pour un template enregistré par un utilisateur (pas de vignette par template).
  const ICON_TEMPLATE_GENERIC = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
  // Indique que "Autres templates" ouvre un sous-menu plutôt que de poser directement quelque chose.
  const ICON_CHEVRON_RIGHT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  // Pile de post-its (bouton du sous-menu "Post-it" + pastille suivant le curseur pendant sa pose,
  // cf. armPlacement) : deux carrés décalés façon post-its empilés.
  const ICON_STACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="7" width="14" height="14" rx="1.5"/><rect x="7" y="3" width="14" height="14" rx="1.5" fill="#fff"/></svg>';
  const ICON_STACK_GHOST = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3" y="7" width="14" height="14" rx="1.5" fill="#e6c667"/><rect x="7" y="3" width="14" height="14" rx="1.5" fill="#fdf1b8"/></svg>';

  function viewportCenterWorld() {
    const rect = viewportEl.getBoundingClientRect();
    return screenToWorld(rect.width / 2, rect.height / 2);
  }

  function isPointOverCanvas(clientX, clientY) {
    const r = viewportEl.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  // Ferme aussi le sous-menu "Autres templates" (cf. openOtherTemplatesFlyout) : un élément DOM à
  // part, pas nichée dans #addFlyout, donc jamais fermée toute seule par le classList de celui-ci.
  function closeAddFlyout() { addFlyout.classList.remove('is-open'); addSubFlyout.classList.remove('is-open'); }

  // ---- Armement d'un outil de pose ----
  // Une seule pose à la fois : armer un nouvel outil (ou Échap, ou cliquer hors du canvas) désarme le
  // précédent. Le clic qui pose l'élément est intercepté en phase de capture sur `window`, AVANT que
  // le canvas ne le traite comme un clic normal (désélection, début de marquee...).

  let armedPlacement = null; // { type, variant, options }
  let placementGhostEl = null;

  function disarmPlacement() {
    if (!armedPlacement && !placementGhostEl) return;
    armedPlacement = null;
    if (placementGhostEl) { placementGhostEl.remove(); placementGhostEl = null; }
    viewportEl.classList.remove('is-drop-target');
    addToolbar.querySelectorAll('.add-toolbar-btn.is-armed').forEach(b => b.classList.remove('is-armed'));
    window.removeEventListener('pointermove', onPlacementMove);
    window.removeEventListener('pointerdown', onPlacementPointerDown, true);
    window.removeEventListener('keydown', onPlacementKeydown);
  }

  function onPlacementMove(ev) {
    if (!placementGhostEl) return;
    placementGhostEl.style.left = `${ev.clientX + 14}px`;
    placementGhostEl.style.top = `${ev.clientY + 14}px`;
    viewportEl.classList.toggle('is-drop-target', isPointOverCanvas(ev.clientX, ev.clientY));
  }

  function onPlacementKeydown(ev) {
    if (ev.key === 'Escape') disarmPlacement();
  }

  function onPlacementPointerDown(ev) {
    if (!armedPlacement) return;
    if (addToolbar.contains(ev.target) || addFlyout.contains(ev.target) || addToolbarRevealBtn.contains(ev.target)) return;
    if (!isPointOverCanvas(ev.clientX, ev.clientY)) { disarmPlacement(); return; }
    ev.preventDefault();
    ev.stopPropagation();
    const { type, variant, options } = armedPlacement;
    const r = viewportEl.getBoundingClientRect();
    const { x: wx, y: wy } = screenToWorld(ev.clientX - r.left, ev.clientY - r.top);
    disarmPlacement();
    if (type === 'template') placeTemplateSnapshots(options.snapshots, wx, wy);
    else placeNewElement(type, wx, wy, { ...options, variant });
  }

  function armPlacement(type, iconHtml, { variant = null, options = {}, sourceBtn = null, x = null, y = null } = {}) {
    disarmPlacement();
    closeAddFlyout();
    armedPlacement = { type, variant, options };
    if (sourceBtn) sourceBtn.classList.add('is-armed');
    placementGhostEl = document.createElement('div');
    placementGhostEl.className = 'drag-ghost';
    placementGhostEl.innerHTML = iconHtml;
    document.body.appendChild(placementGhostEl);
    if (x != null && y != null) {
      placementGhostEl.style.left = `${x + 14}px`;
      placementGhostEl.style.top = `${y + 14}px`;
      viewportEl.classList.toggle('is-drop-target', isPointOverCanvas(x, y));
    }
    window.addEventListener('pointermove', onPlacementMove);
    window.addEventListener('pointerdown', onPlacementPointerDown, true);
    window.addEventListener('keydown', onPlacementKeydown);
  }

  const textFlyoutBtn = addToolbar.querySelector('[data-flyout="textstyles"]');
  const frameBtn = addToolbar.querySelector('[data-type="frame"]');

  frameBtn.addEventListener('click', (e) => {
    if (armedPlacement && armedPlacement.type === 'frame') { disarmPlacement(); return; }
    armPlacement('frame', frameBtn.querySelector('svg').outerHTML, { sourceBtn: frameBtn, x: e.clientX, y: e.clientY });
  });

  // Construit le contenu du sous-menu pour une famille donnée. `items` : liste à icône+libellé
  // (Formes, Blocs) — chaque entrée arme directement son type/variante. `colors` : palette de post-it
  // (écran Miro fourni par Antoine) — arme "note" avec la couleur choisie, le curseur devenant une
  // mini pastille de cette couleur. `textstyles` : la même échelle nommée que le reste de l'app (cf.
  // FONT_SIZE_PRESETS) — arme "text" avec la taille choisie.
  function renderFlyoutContent(key, sourceBtn) {
    const cfg = ADD_FLYOUTS[key];
    if (cfg.kind === 'items') {
      addFlyout.innerHTML = cfg.items.map((it, i) => `
        <button type="button" class="add-flyout-item" data-index="${i}">
          <span class="add-flyout-item-icon">${it.icon}</span>
          <span class="add-flyout-item-label">${it.label}</span>
        </button>
      `).join('');
      addFlyout.querySelectorAll('.add-flyout-item').forEach((btn, i) => {
        btn.addEventListener('click', (e) => {
          const it = cfg.items[i];
          armPlacement(it.type, it.icon, { variant: it.variant || null, sourceBtn, x: e.clientX, y: e.clientY });
        });
      });
    } else if (cfg.kind === 'colors') {
      addFlyout.innerHTML = `
        <div class="add-flyout-colors">${ELEMENT_COLORS.map(c => `<button type="button" class="toolbar-color-swatch" data-color="${c}" style="background:${c}"></button>`).join('')}</div>
        <button type="button" class="add-flyout-stack-btn" id="addStackBtn">${ICON_STACK}Ajouter une pile</button>
      `;
      addFlyout.querySelectorAll('.toolbar-color-swatch').forEach((sw) => {
        sw.addEventListener('click', (e) => {
          const color = sw.dataset.color;
          armPlacement('note', `<div class="placement-ghost-note" style="background:${color}"></div>`, { options: { color }, sourceBtn, x: e.clientX, y: e.clientY });
        });
      });
      // Pas de choix de couleur avant la pose (contrairement au post-it seul) : la pile part avec une
      // couleur par défaut, modifiable ensuite comme n'importe quel autre réglage de son toolbar.
      addFlyout.querySelector('#addStackBtn').addEventListener('click', (e) => {
        armPlacement('stack', ICON_STACK_GHOST, { sourceBtn, x: e.clientX, y: e.clientY });
      });
    } else if (cfg.kind === 'textstyles') {
      addFlyout.innerHTML = FONT_SIZE_PRESETS.map(([label], i) => `
        <button type="button" class="add-flyout-item" data-index="${i}">
          <span class="add-flyout-item-textpreview">Aa</span>
          <span class="add-flyout-item-label">${label}</span>
        </button>
      `).join('');
      addFlyout.querySelectorAll('.add-flyout-item').forEach((btn, i) => {
        btn.addEventListener('click', (e) => {
          const fontSize = FONT_SIZE_PRESETS[i][1];
          armPlacement('text', textFlyoutBtn.querySelector('svg').outerHTML, { options: { fontSize }, sourceBtn, x: e.clientX, y: e.clientY });
        });
      });
    } else if (cfg.kind === 'uploads') {
      // Ni l'un ni l'autre ne passe par armPlacement : un import (image ou PDF) ouvre tout de suite le
      // sélecteur de fichier, pas un mode "pose au clic" — comme l'image l'a toujours fait.
      addFlyout.innerHTML = `
        <button type="button" class="add-flyout-item" data-upload="image">
          <span class="add-flyout-item-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span>
          <span class="add-flyout-item-label">Image</span>
        </button>
        <button type="button" class="add-flyout-item" data-upload="pdf">
          <span class="add-flyout-item-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9.5 17v-4h1.2a1.3 1.3 0 0 1 0 2.6H9.5"/><path d="M13 17v-4h1.6c.9 0 1.4.7 1.4 2s-.5 2-1.4 2H13z"/></svg></span>
          <span class="add-flyout-item-label">PDF</span>
        </button>
      `;
      addFlyout.querySelector('[data-upload="image"]').addEventListener('click', () => {
        closeAddFlyout();
        const { x: wx, y: wy } = viewportCenterWorld();
        placeNewElement('image', wx, wy);
      });
      addFlyout.querySelector('[data-upload="pdf"]').addEventListener('click', () => {
        closeAddFlyout();
        const { x: wx, y: wy } = viewportCenterWorld();
        startPdfImport(wx, wy);
      });
    } else if (cfg.kind === 'templates') {
      // Deux familles bien distinctes (demandé par Antoine) : les templates "officiels" (codés en dur
      // ici même, chacun sa propre icône — cf. BUILTIN_TEMPLATE_ITEMS, Consigne/Tips posés comme un
      // simple élément) toujours listés directement ; les templates créés par un·e participant·e depuis
      // n'importe quel board (tous la même icône générique 4 carrés) rangés derrière une seule entrée
      // "Autres templates", qui ouvre un second sous-menu (cf. openOtherTemplatesFlyout) plutôt que
      // d'allonger cette liste-ci au fil des enregistrements.
      addFlyout.innerHTML = BUILTIN_TEMPLATE_ITEMS.map((it, i) => `
        <button type="button" class="add-flyout-item" data-builtin="${i}">
          <span class="add-flyout-item-icon">${it.icon}</span>
          <span class="add-flyout-item-label">${it.label}</span>
        </button>
      `).join('') + `
        <span class="toolbar-menu-sep"></span>
        <button type="button" class="add-flyout-item" id="otherTemplatesBtn">
          <span class="add-flyout-item-icon">${ICON_TEMPLATE_GENERIC}</span>
          <span class="add-flyout-item-label">Autres templates</span>
          <span class="add-flyout-item-chevron">${ICON_CHEVRON_RIGHT}</span>
        </button>
      `;
      addFlyout.querySelectorAll('[data-builtin]').forEach((btn, i) => {
        btn.addEventListener('click', (e) => {
          const it = BUILTIN_TEMPLATE_ITEMS[i];
          armPlacement(it.type, it.icon, { sourceBtn, x: e.clientX, y: e.clientY });
        });
      });
      // Chargée dès l'ouverture de CE menu (pas seulement au clic sur "Autres templates") pour que le
      // sous-menu s'affiche sans latence supplémentaire — reste juste un nom+tags par template, léger
      // même chargé "pour rien" si personne ne clique dessus.
      const otherTemplatesPromise = Api.listTemplates().catch(() => []);
      document.getElementById('otherTemplatesBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (addSubFlyout.classList.contains('is-open')) { addSubFlyout.classList.remove('is-open'); return; }
        openOtherTemplatesFlyout(e.currentTarget, otherTemplatesPromise, sourceBtn);
      });
    }
  }

  // Sous-menu "Autres templates" (cf. cfg.kind === 'templates' ci-dessus) : les templates enregistrés
  // par n'importe quel·le participant·e, nom + tags, positionné à droite de la ligne "Autres templates"
  // — même mécanique de pose (armPlacement) que les templates officiels, `sourceBtn` reste le bouton de
  // la barre "ajouter" (pas cette ligne) pour que ce soit LUI qui s'allume pendant la pose.
  function openOtherTemplatesFlyout(anchorBtn, templatesPromise, sourceBtn) {
    function position() {
      const r = anchorBtn.getBoundingClientRect();
      const fRect = addSubFlyout.getBoundingClientRect();
      addSubFlyout.style.left = `${r.right + 10}px`;
      addSubFlyout.style.top = `${clamp(r.top + r.height / 2 - fRect.height / 2, 8, window.innerHeight - fRect.height - 8)}px`;
    }
    addSubFlyout.innerHTML = '<div class="add-flyout-loading">Chargement…</div>';
    addSubFlyout.classList.add('is-open');
    position();
    templatesPromise.then((templates) => {
      if (!templates.length) {
        addSubFlyout.innerHTML = '<div class="add-flyout-empty">Aucun autre template enregistré</div>';
      } else {
        addSubFlyout.innerHTML = '';
        templates.forEach((t) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'add-flyout-item';
          row.innerHTML = `
            <span class="add-flyout-item-icon">${ICON_TEMPLATE_GENERIC}</span>
            <span class="add-flyout-item-template-text">
              <span class="add-flyout-item-label">${escapeHtml(t.name)}</span>
              ${t.tags.length ? `<span class="add-flyout-item-tags">${t.tags.map(escapeHtml).join(' · ')}</span>` : ''}
            </span>
          `;
          // Le contenu complet (les snapshots) n'est récupéré qu'au clic sur CE template précis, pas
          // pour toute la liste à l'ouverture du sous-menu (cf. GET .../templates/:id côté serveur).
          row.addEventListener('click', (e) => {
            const cx = e.clientX, cy = e.clientY;
            row.disabled = true;
            Api.getTemplate(t.id)
              .then((full) => armPlacement('template', ICON_TEMPLATE_GENERIC, { options: { snapshots: full.data }, sourceBtn, x: cx, y: cy }))
              .catch(err => alert(err.message))
              .finally(() => { row.disabled = false; });
          });
          addSubFlyout.appendChild(row);
        });
      }
      // Le sous-menu a grandi après son premier positionnement (calculé avant la fin de ce chargement) :
      // on le recale s'il est toujours ouvert, pour ne pas déborder de l'écran.
      if (addSubFlyout.classList.contains('is-open')) position();
    }).catch(() => {
      addSubFlyout.innerHTML = '<div class="add-flyout-empty">Erreur de chargement.</div>';
    });
  }

  function openAddFlyout(btn, key) {
    renderFlyoutContent(key, btn);
    addFlyout.dataset.for = key;
    addFlyout.classList.add('is-open');
    const r = btn.getBoundingClientRect();
    const fRect = addFlyout.getBoundingClientRect();
    addFlyout.style.left = `${r.right + 10}px`;
    addFlyout.style.top = `${clamp(r.top + r.height / 2 - fRect.height / 2, 8, window.innerHeight - fRect.height - 8)}px`;
  }

  addToolbar.querySelectorAll('.add-toolbar-btn[data-flyout]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.flyout;
      const wasOpenForThis = addFlyout.classList.contains('is-open') && addFlyout.dataset.for === key;
      disarmPlacement();
      closeAddFlyout();
      if (!wasOpenForThis) openAddFlyout(btn, key);
    });
  });

  document.addEventListener('pointerdown', (e) => {
    if (!addFlyout.contains(e.target) && !addSubFlyout.contains(e.target) && !e.target.closest('[data-flyout]')) closeAddFlyout();
  });

  // Repliée/dépliée : mémorisé d'une session à l'autre (même principe que le quadrillage, cf.
  // applyGridVisibility plus bas), pour ne pas avoir à la remasquer à chaque ouverture du tableau.
  function setAddToolbarCollapsed(collapsed) {
    addToolbar.hidden = collapsed;
    addToolbarRevealBtn.hidden = !collapsed;
    if (collapsed) { closeAddFlyout(); disarmPlacement(); }
    try { localStorage.setItem(ADD_TOOLBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (_) {}
  }
  addToolbarCollapseBtn.addEventListener('click', () => setAddToolbarCollapsed(true));
  addToolbarRevealBtn.addEventListener('click', () => setAddToolbarCollapsed(false));
  let addToolbarInitiallyCollapsed = false;
  try { addToolbarInitiallyCollapsed = localStorage.getItem(ADD_TOOLBAR_COLLAPSED_KEY) === '1'; } catch (_) {}
  setAddToolbarCollapsed(addToolbarInitiallyCollapsed);

  // Un élément posé (toolbar, image) doit atterrir sur la grille comme un élément glissé — jamais
  // "entre deux cases". Contrairement au glisser (qui accroche aussi sur les autres éléments proches,
  // cf. computeSnappedPosition), une pose ponctuelle se contente de la grille elle-même.
  function snapPoint(x, y) { return { x: snapToGrid(x), y: snapToGrid(y) }; }

  function placeNewElement(type, wx, wy, { color = null, fontSize = null, variant = null } = {}) {
    hideHint();
    creationCount++;

    if (type === 'note') {
      const c = color || ELEMENT_COLORS[creationCount % ELEMENT_COLORS.length];
      const half = NOTE_DEFAULT_SIZE / 2;
      const { x, y } = snapPoint(wx - half, wy - half);
      createElementTracked({ type: 'note', x, y, width: NOTE_DEFAULT_SIZE, height: NOTE_DEFAULT_SIZE, color: c })
        .catch(err => alert(err.message));
    } else if (type === 'line') {
      const { x, y } = snapPoint(wx - 80, wy);
      createElementTracked({ type: 'line', x, y, width: 160, height: 6, rotation: 0, color: '#1c1c28' })
        .catch(err => alert(err.message));
    } else if (type === 'text') {
      const fs = fontSize || 15;
      const initial = computeTextBoxSize({ text: '', fontSize: fs, bold: false, italic: false });
      const { x, y } = snapPoint(wx - initial.width / 2, wy - initial.height / 2);
      createElementTracked({
        type: 'text', x, y,
        width: initial.width, height: initial.height, color: '#1c1c28', fontSize: fs,
      })
        .then(data => { const entry = ensureRendered(data); entry.enterEditing?.(); })
        .catch(err => alert(err.message));
    } else if (type === 'rectangle' && variant === 'ellipse') {
      // Un "rond" est un rectangle carré avec un rayon de coin maximal (même valeur que le préréglage
      // "Complet" du sélecteur de bordure, cf. RADIUS_PRESETS) — pas besoin d'un type d'élément dédié.
      const c = ELEMENT_COLORS[creationCount % ELEMENT_COLORS.length];
      const size = 150;
      const { x, y } = snapPoint(wx - size / 2, wy - size / 2);
      createElementTracked({
        type: 'rectangle', x, y, width: size, height: size,
        color: c, strokeWidth: 0, strokeColor: '#1c1c28', radius: 999,
        textAlign: 'center', textValign: 'center',
      }).catch(err => alert(err.message));
    } else if (type === 'rectangle' && variant === 'diamond') {
      // Losange : dessiné en SVG plutôt qu'en CSS (cf. renderElement/applyRectangleStyle) — `tag:
      // 'diamond'` marque juste la forme, pas un vrai tag affiché (même réutilisation du champ que le
      // type de page du bloc "page web").
      const c = ELEMENT_COLORS[creationCount % ELEMENT_COLORS.length];
      const w = 200, h = 140;
      const { x, y } = snapPoint(wx - w / 2, wy - h / 2);
      createElementTracked({
        type: 'rectangle', x, y, width: w, height: h,
        color: c, strokeWidth: 0, strokeColor: '#1c1c28', tag: 'diamond',
        textAlign: 'center', textValign: 'center',
      }).catch(err => alert(err.message));
    } else if (type === 'rectangle') {
      const c = ELEMENT_COLORS[creationCount % ELEMENT_COLORS.length];
      const { x, y } = snapPoint(wx - 110, wy - 70);
      createElementTracked({
        type: 'rectangle', x, y, width: 220, height: 140,
        color: c, strokeWidth: 0, strokeColor: '#1c1c28', radius: 8,
      }).catch(err => alert(err.message));
    } else if (type === 'image') {
      pendingImagePlacement = { wx, wy };
      imageFileInput.value = '';
      imageFileInput.click();
    } else if (type === 'frame') {
      // Couleur/contour/titre laissés aux valeurs par défaut du serveur (cf. ELEMENT_DEFAULTS.frame) :
      // contrairement au post-it/rectangle, on n'a pas besoin d'une couleur qui tourne à chaque
      // création, une frame est un conteneur neutre.
      const { x, y } = snapPoint(wx - 240, wy - 180);
      createElementTracked({ type: 'frame', x, y, width: 480, height: 360 })
        .catch(err => alert(err.message));
    } else if (type === 'instruction' || type === 'tip') {
      // Couleur laissée à la valeur par défaut du serveur (blanc pour consigne, gris du tableau pour
      // tips, cf. ELEMENT_DEFAULTS) — prête à taper le titre tout de suite, comme le texte libre.
      const { x, y } = snapPoint(wx - 140, wy - 85);
      createElementTracked({ type, x, y, width: 280, height: 170 })
        .then((data) => { const entry = ensureRendered(data); entry.enterField?.('title'); })
        .catch(err => alert(err.message));
    } else if (type === 'arbo') {
      // Un seul nœud racine au départ (vide, prêt à taper son titre) — cf. ELEMENT_DEFAULTS.arbo.
      const w = 320, h = 60;
      const { x, y } = snapPoint(wx - w / 2, wy - h / 2);
      const tree = newArboNode();
      createElementTracked({ type: 'arbo', x, y, width: w, height: h, text: JSON.stringify(tree) })
        .then((data) => {
          const entry = ensureRendered(data);
          entry.enterEditing?.();
        })
        .catch(err => alert(err.message));
    } else if (type === 'webpage') {
      // `variant` porte le type de page choisi dans le sous-menu (cf. ADD_FLYOUTS.webpages) — réutilise
      // le champ `tag` (cf. ELEMENT_DEFAULTS.webpage côté serveur), pas un vrai tag affiché comme pour
      // "tips", juste lequel des 7 wireframes fixes afficher.
      const { x, y } = snapPoint(wx - 190, wy - 90);
      createElementTracked({ type: 'webpage', x, y, width: 380, height: 180, tag: variant || 'accueil' })
        .then((data) => { const entry = ensureRendered(data); entry.enterField?.('title'); })
        .catch(err => alert(err.message));
    } else if (type === 'stack') {
      // Couleur par défaut (modifiable ensuite dans son toolbar, cf. wireToolbarControls) — pas de
      // choix à la pose, contrairement au post-it seul.
      const w = 280, h = 260;
      const { x, y } = snapPoint(wx - w / 2, wy - h / 2);
      createElementTracked({ type: 'stack', x, y, width: w, height: h, color: ELEMENT_COLORS[0], text: 'Pile de post-its' })
        .catch(err => alert(err.message));
    }
  }

  imageFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) { alert('Image trop lourde (max 4 Mo).'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w >= h && w > MAX_IMAGE_DIM) { h = h * (MAX_IMAGE_DIM / w); w = MAX_IMAGE_DIM; }
        else if (h > MAX_IMAGE_DIM) { w = w * (MAX_IMAGE_DIM / h); h = MAX_IMAGE_DIM; }
        const { wx, wy } = pendingImagePlacement || { wx: 0, wy: 0 };
        const { x, y } = snapPoint(wx - w / 2, wy - h / 2);
        createElementTracked({ type: 'image', x, y, width: w, height: h, imageData: reader.result })
          .catch(err => alert(err.message));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  // ---------- Import PDF (une frame "mosaïque", une image par page) ----------
  // Chaque page est rendue en image (canvas → JPEG) entièrement côté client via pdf.js, puis postée
  // comme un lot d'éléments "image" classiques rattachés à une frame taguée tag: 'pdf-mosaic' — ce tag
  // est ce qui permet à applyFrameArrangement (server.js) de la reconnaître et de la réordonner toute
  // seule au redimensionnement (cf. PATCH .../elements/:id côté serveur), sans toucher aux frames
  // normales. pdf.js lui-même n'est chargé (dynamic import) qu'au moment où l'utilisateur choisit
  // "PDF" — pas de coût pour qui ne s'en sert jamais.

  let pendingPdfPlacement = null;
  let pdfjsLoadPromise = null;

  function loadPdfJs() {
    if (!pdfjsLoadPromise) {
      pdfjsLoadPromise = import('/vendor/pdfjs/pdf.min.mjs').then((mod) => {
        mod.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
        return mod;
      });
    }
    return pdfjsLoadPromise;
  }

  function startPdfImport(wx, wy) {
    pendingPdfPlacement = { wx, wy };
    pdfFileInput.value = '';
    pdfFileInput.click();
  }

  // Rendu de chaque page à PDF_PAGE_RENDER_WIDTH (résolution/qualité de la source), avec sa taille
  // d'AFFICHAGE dans la mosaïque calculée à part (largeur fixe PDF_MOSAIC_CELL_WIDTH, hauteur au
  // prorata) : on peut zoomer sur une page sans qu'elle devienne floue plus vite qu'une image classique,
  // sans pour autant peser le poids d'un rendu pleine résolution à la taille d'affichage seulement.
  async function renderPdfPages(file) {
    const pdfjsLib = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`PDF trop long (max ${MAX_PDF_PAGES} pages).`);
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PDF_PAGE_RENDER_WIDTH / baseViewport.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const displayHeight = Math.round(PDF_MOSAIC_CELL_WIDTH * (canvas.height / canvas.width));
      pages.push({
        imageData: canvas.toDataURL('image/jpeg', PDF_PAGE_JPEG_QUALITY),
        width: PDF_MOSAIC_CELL_WIDTH, height: displayHeight,
      });
      // Libère chaque canvas tout de suite plutôt qu'à la fin de la boucle : un PDF de 100+ pages
      // accumulerait sinon autant de canvas pleine résolution en mémoire en même temps.
      canvas.width = 0; canvas.height = 0;
    }
    return pages;
  }

  async function importPdfFile(file, wx, wy) {
    const pages = await renderPdfPages(file);
    if (!pages.length) throw new Error('PDF vide (aucune page).');

    // Largeur de frame calée pour exactement PDF_MOSAIC_COLUMNS colonnes de PDF_MOSAIC_CELL_WIDTH avec
    // PDF_MOSAIC_PADDING de marge partout (même calcul que le calage en grille d'applyFrameArrangement
    // côté serveur, qui pose ensuite les positions réelles une fois la frame créée, cf. plus bas) :
    // une marge à gauche du premier + N cellules + une marge après chacune.
    const frameWidth = PDF_MOSAIC_COLUMNS * PDF_MOSAIC_CELL_WIDTH + (PDF_MOSAIC_COLUMNS + 1) * PDF_MOSAIC_PADDING;
    const initialHeight = 400; // provisoire : applyFrameArrangement (appelé juste après) la recalcule
    const title = file.name.replace(/\.pdf$/i, '');
    const { x: fx, y: fy } = snapPoint(wx - frameWidth / 2, wy - initialHeight / 2);

    let frameId = null;
    let allCreated = [];
    for (let i = 0; i < pages.length; i += PDF_BATCH_CHUNK) {
      const chunk = pages.slice(i, i + PDF_BATCH_CHUNK);
      // Position provisoire (x croissant, y=0), juste pour que l'ORDER BY y, x d'applyFrameArrangement
      // retrouve l'ordre des pages avant son propre calcul de grille — la position réelle vient de cet
      // appel, pas de celle-ci.
      const imageItems = chunk.map((p, j) => ({
        type: 'image', frameId: frameId || 'c0', x: i + j, y: 0, width: p.width, height: p.height, imageData: p.imageData,
      }));
      const items = i === 0
        ? [{ type: 'frame', clientId: 'c0', x: fx, y: fy, width: frameWidth, height: initialHeight, text: title, tag: 'pdf-mosaic' }, ...imageItems]
        : imageItems;
      const { elements: created } = await Api.createElementsBatch(items);
      allCreated = allCreated.concat(created);
      if (!frameId) frameId = created.find(el => el.type === 'frame').id;
    }

    allCreated.forEach(data => ensureRendered(data));
    const { elements: arranged } = await Api.arrangeFrame(frameId);
    arranged.forEach(applyRemoteUpdate);

    const createdIds = allCreated.map(el => el.id);
    recordUndo(() => {
      createdIds.forEach(id => removeElementLocal(id));
      return Api.deleteElement(frameId, { deleteContents: true }).catch(() => {});
    });
  }

  pdfFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_PDF_BYTES) { alert('PDF trop lourd (max 40 Mo).'); return; }
    const { wx, wy } = pendingPdfPlacement || { wx: 0, wy: 0 };
    withBusy(importPdfFile(file, wx, wy)).catch(err => alert("Impossible d'importer ce PDF : " + err.message));
  });

  // ---------- Sélection simple ----------

  function deselectElement() {
    if (selectedElementId && elements.has(selectedElementId)) {
      elements.get(selectedElementId).el.classList.remove('is-selected');
    }
    selectedElementId = null;
    hideToolbar();
  }

  function selectElement(id) {
    clearMultiSelection();
    if (selectedElementId === id) return;
    deselectElement();
    selectedElementId = id;
    const entry = elements.get(id);
    entry.el.classList.add('is-selected');
    showToolbarFor(entry);
  }

  // Enregistre la création d'un élément dans la pile d'annulation (undo = le supprimer à nouveau) —
  // pour un simple élément créé isolément (toolbar, image). Une création groupée (dupliquer une
  // frame avec son contenu, coller) construit sa propre entrée d'annulation couvrant tout le lot.
  function createElementTracked(payload) {
    return Api.createElement(payload).then((data) => {
      recordUndo(() => { removeElementLocal(data.id); return Api.deleteElement(data.id).catch(() => {}); });
      return data;
    });
  }

  // ---------- Copier / coller ----------
  // Presse-papiers en mémoire (propre à cet onglet, pas le presse-papiers système) : une photo des
  // éléments sélectionnés au moment du Ctrl/Cmd+C, recréés avec un nouvel id à chaque collage (décalage
  // cumulatif, comme dupliquer plusieurs fois de suite).
  let clipboard = [];
  let pasteCount = 0;

  function snapshotForCreate(d) {
    return {
      type: d.type, x: d.x, y: d.y, width: d.width, height: d.height, rotation: d.rotation,
      color: d.color, text: d.text, fontSize: d.fontSize, bold: d.bold, italic: d.italic,
      underline: d.underline, strikethrough: d.strikethrough, imageData: d.imageData, grayscale: d.grayscale,
      lineStyle: d.lineStyle, backgroundColor: d.backgroundColor, strokeWidth: d.strokeWidth, strokeColor: d.strokeColor,
      radius: d.radius, startCap: d.startCap, endCap: d.endCap, titleColor: d.titleColor,
      textColor: d.textColor, textAlign: d.textAlign, textValign: d.textValign, link: d.link,
      title: d.title, number: d.number, tag: d.tag,
      fromElementId: d.fromElementId, fromSide: d.fromSide, toElementId: d.toElementId, toSide: d.toSide,
      frameId: d.frameId, _sourceId: d.id,
    };
  }

  // Recrée un ensemble de snapshots (même forme que ci-dessus) — utilisé à la fois par "coller" et par
  // l'annulation d'une suppression. Un premier essai lançait une requête de création par élément (en
  // parallèle) : sur une base distante, chaque création fait déjà plusieurs aller-retours base de
  // données à elle seule, donc même lancées en parallèle depuis le client, N créations restent
  // limitées par N fois ce coût côté serveur — visible comme des éléments qui "apparaissent un par un"
  // en collant ou en annulant une suppression de plusieurs éléments. Le tout part maintenant en UNE
  // seule requête vers /elements/batch (cf. server.js), qui fait ce travail en un nombre d'aller-
  // retours fixe quel que soit N. Les frames doivent y précéder leur contenu (le serveur en a besoin
  // pour redéduire l'appartenance d'après la position, comme à la création normale) ; les connecteurs
  // y viennent en dernier, leurs extrémités indiquées par le clientId (index dans le lot) de
  // l'élément visé quand celui-ci fait partie du même lot.
  async function recreateElements(snapshots) {
    if (!snapshots.length) return [];
    const frames = snapshots.filter(s => s.type === 'frame');
    const plain = snapshots.filter(s => s.type !== 'frame' && s.type !== 'connector');
    const connectors = snapshots.filter(s => s.type === 'connector');
    const ordered = [...frames, ...plain, ...connectors];

    const clientIdBySourceId = new Map();
    ordered.forEach((s, i) => { if (s._sourceId) clientIdBySourceId.set(s._sourceId, `c${i}`); });

    const items = ordered.map((s, i) => {
      const { _sourceId, fromElementId, toElementId, frameId, ...rest } = s;
      const item = {
        ...rest,
        clientId: `c${i}`,
        fromElementId: fromElementId != null && clientIdBySourceId.has(fromElementId) ? clientIdBySourceId.get(fromElementId) : fromElementId,
        toElementId: toElementId != null && clientIdBySourceId.has(toElementId) ? clientIdBySourceId.get(toElementId) : toElementId,
      };
      // Un élément qui n'appartenait à aucune frame doit pouvoir se faire rattacher par la détection
      // automatique du serveur d'après sa nouvelle position (frameId omis, cf. server.js) — mais un
      // élément qui appartenait à une frame recréée DANS LE MÊME LOT doit explicitement rejoindre
      // CETTE COPIE (référencée par son clientId), pas se faire redétecter au hasard : sa frame
      // d'origine et sa copie ne sont décalées que de quelques px l'une de l'autre (même décalage que
      // le contenu), donc quasi toujours l'une ET l'autre à la fois — la détection par position
      // choisirait alors la frame la plus "au-dessus" (z le plus haut), presque toujours l'ORIGINALE
      // (une frame va toujours un peu plus loin en arrière-plan que la précédente à chaque création).
      // Un élément qui appartenait à une frame RESTÉE EN PLACE (non recréée ici) garde son frameId
      // d'origine tel quel, comme pour "dupliquer" un seul élément.
      if (frameId) item.frameId = clientIdBySourceId.get(frameId) || frameId;
      return item;
    });

    const { elements: created } = await Api.createElementsBatch(items);
    created.forEach(data => ensureRendered(data));
    return created;
  }

  function copySelection() {
    const ids = multiSelectedIds.size ? [...multiSelectedIds] : (selectedElementId ? [selectedElementId] : []);
    if (!ids.length) return;
    const idSet = new Set(ids);
    // Copier une frame copie aussi son contenu avec elle, même non sélectionné explicitement — sinon
    // coller une frame produit une coquille vide.
    ids.forEach((id) => {
      const en = elements.get(id);
      if (en?.data.type === 'frame') frameChildren(id).forEach(cid => idSet.add(cid));
    });
    // Un connecteur n'a de sens que si ses deux extrémités sont copiées avec lui.
    const items = [...idSet].map(id => elements.get(id)).filter(Boolean).filter((en) => {
      if (en.data.type !== 'connector') return true;
      return idSet.has(en.data.fromElementId) && idSet.has(en.data.toElementId);
    });
    if (!items.length) return;
    clipboard = items.map(en => snapshotForCreate(en.data));
    pasteCount = 0;
  }

  function pasteClipboard() {
    if (!clipboard.length) return;
    pasteCount++;
    // Un même décalage (multiple de la grille) appliqué à TOUT le lot, plutôt qu'un accrochage
    // individuel par élément : ça garde leurs positions relatives exactement intactes (important pour
    // une frame collée avec son contenu) tout en restant sur la grille si l'original y était déjà.
    const delta = GRID_SIZE * 2 * pasteCount;
    // `text` d'un connecteur porte ses points de passage en coordonnées monde (cf. renderConnectorGeometry) :
    // à décaler du même delta que x/y, MAIS seulement si ses DEUX extrémités sont elles-mêmes dans ce
    // copier-coller (donc remappées vers leurs propres copies par recreateElements, et donc décalées
    // d'autant) — sinon (connecteur copié seul, extrémités d'origine inchangées), décaler le waypoint
    // produirait une courbe qui ne correspond plus à ses propres ancres.
    const copiedSourceIds = new Set(clipboard.map(s => s._sourceId).filter(Boolean));
    const offset = clipboard.map(s => ({
      ...s, x: s.x + delta, y: s.y + delta,
      text: (s.type === 'connector' && copiedSourceIds.has(s.fromElementId) && copiedSourceIds.has(s.toElementId))
        ? offsetConnectorWaypoints(s.text, delta, delta) : s.text,
    }));
    withBusy(recreateElements(offset)).then((created) => {
      clearMultiSelection();
      if (created.length > 1) setMultiSelection(created.map(d => d.id));
      else if (created.length === 1) selectElement(created[0].id);
      recordUndo(() => Promise.all(created.map((data) => {
        removeElementLocal(data.id);
        return Api.deleteElement(data.id).catch(() => {});
      })));
    }).catch(err => alert(err.message));
  }

  // Pose d'un template (cf. barre "ajouter" → Templates) : même mécanique que coller (recreateElements
  // sur des snapshots), mais le décalage vise à centrer la boîte englobante de TOUT le lot sur le point
  // cliqué plutôt que d'ajouter un delta cumulatif — un template se pose là où on clique, pas "à côté
  // d'où il était", contrairement à un copier-coller classique.
  function placeTemplateSnapshots(snapshots, wx, wy) {
    if (!snapshots || !snapshots.length) return;
    const minX = Math.min(...snapshots.map(s => s.x));
    const minY = Math.min(...snapshots.map(s => s.y));
    const maxX = Math.max(...snapshots.map(s => s.x + s.width));
    const maxY = Math.max(...snapshots.map(s => s.y + s.height));
    const { x: snapX, y: snapY } = snapPoint(wx - (maxX - minX) / 2, wy - (maxY - minY) / 2);
    const dx = snapX - minX, dy = snapY - minY;
    const offset = snapshots.map(s => ({ ...s, x: s.x + dx, y: s.y + dy }));
    withBusy(recreateElements(offset)).then((created) => {
      if (created.length > 1) setMultiSelection(created.map(d => d.id));
      else if (created.length === 1) selectElement(created[0].id);
      recordUndo(() => Promise.all(created.map((data) => {
        removeElementLocal(data.id);
        return Api.deleteElement(data.id).catch(() => {});
      })));
    }).catch(err => alert(err.message));
  }

  // ---------- Déplacer la sélection au clavier (flèches) ----------

  function nudgeSelection(dx, dy) {
    const ids = multiSelectedIds.size ? [...multiSelectedIds] : (selectedElementId ? [selectedElementId] : []);
    const movable = ids.filter((id) => { const en = elements.get(id); return en && !en.data.locked; });
    if (!movable.length) return;
    const before = movable.map((id) => { const en = elements.get(id); return { id, x: en.data.x, y: en.data.y }; });
    movable.forEach((id) => {
      const en = elements.get(id);
      en.data.x += dx; en.data.y += dy;
      en.el.style.left = `${en.data.x}px`; en.el.style.top = `${en.data.y}px`;
      updateConnectorsFor(id);
    });
    if (selectedElementId && movable.includes(selectedElementId)) repositionToolbar(elements.get(selectedElementId));
    if (multiSelectedIds.size >= 2) repositionMultiToolbar();
    // Pas besoin ici de protéger la position "à la main" (comme le fait entry.dragging pendant un
    // glisser à la souris, qui a une phase intermédiaire sans requête en vol) : l'appel ci-dessous
    // marque l'élément "en attente" (cf. Api.isPending) dès cette ligne, avant que quoi que ce soit
    // d'autre ne puisse s'exécuter — un écho distant pour une position intermédiaire est donc déjà
    // ignoré par applyRemoteUpdate le temps que LA DERNIÈRE requête partie se confirme.
    Api.updateElementsBatch(movable.map((id) => { const en = elements.get(id); return { id, x: en.data.x, y: en.data.y }; }), false)
      .then(({ elements: updated, superseded, isLatest }) => {
        if (superseded || !isLatest) return;
        updated.forEach(applyRemoteUpdate);
        recordUndo(() => restoreMovedPositions(before));
      })
      .catch(() => {});
  }

  function isTypingInField() {
    const t = document.activeElement;
    if (!t) return false;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
  }

  // Un champ tout juste focus (simple clic qui sélectionne un post-it/bloc, cf. wireBodyDrag) n'a
  // RIEN à annuler nativement — seul un champ où on a vraiment tapé quelque chose depuis (valeur
  // différente de celle capturée à l'entrée en édition, cf. "undoBefore" posé par wireTextEditing/
  // wireMultiFieldEditing/wireArboTree) doit faire retomber Cmd+Z sur l'undo natif du navigateur.
  // Sinon Cmd+Z semblait ne "rien faire" après un simple clic sur un autre élément.
  function isFieldDirty(t) {
    if (t.dataset.undoBefore === undefined) return false;
    const current = t.isContentEditable ? t.innerHTML : t.value;
    return current !== t.dataset.undoBefore;
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    // Échap sort d'un texte en édition SANS désélectionner l'élément — utile en particulier pour
    // pouvoir enchaîner avec les flèches du clavier juste après un simple clic (qui, sur un post-
    // it/texte/rectangle/frame, entre directement en édition : cf. wireBodyDrag).
    if (e.key === 'Escape' && editingElementId) {
      // document.activeElement plutôt que entry.textEl : un bloc à plusieurs champs (consigne, tips,
      // cf. wireMultiFieldEditing) n'en a pas UN seul, celui qui a le focus est le seul repère fiable.
      if (isTypingInField()) document.activeElement.blur();
      return;
    }

    // Annuler : seul un champ activement modifié (cf. isFieldDirty) laisse le navigateur gérer son
    // propre undo natif — un champ juste focus sans frappe, ou un editingElementId resté bloqué (cf.
    // le lien abandonné dans la mini-barre riche), ne doit pas absorber Cmd+Z sans rien annuler.
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      const t = document.activeElement;
      if (isTypingInField() && isFieldDirty(t)) return;
      if (isTypingInField()) t.blur();
      editingElementId = null;
      e.preventDefault();
      undoLastAction();
      return;
    }
    if (mod && e.key.toLowerCase() === 'c') {
      if (isTypingInField() || editingElementId) return;
      if (!selectedElementId && !multiSelectedIds.size) return;
      e.preventDefault();
      copySelection();
      return;
    }
    if (mod && e.key.toLowerCase() === 'v') {
      if (isTypingInField() || editingElementId) return;
      if (!clipboard.length) return;
      e.preventDefault();
      pasteClipboard();
      return;
    }
    if (e.key.startsWith('Arrow') && !mod) {
      if (isTypingInField() || editingElementId) return;
      if (!selectedElementId && !multiSelectedIds.size) return;
      const step = e.shiftKey ? GRID_SIZE * 5 : GRID_SIZE;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      nudgeSelection(dx, dy);
      return;
    }

    if (editingElementId) return;
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    if (multiSelectedIds.size >= 2) {
      e.preventDefault();
      const ids = [...multiSelectedIds];
      if (!confirm(`Supprimer ces ${ids.length} éléments ?`)) return;
      const deletable = ids.filter((id) => { const entry = elements.get(id); return entry && !entry.data.locked; });
      const snaps = deletable.map((id) => snapshotForCreate(elements.get(id).data));
      deletable.forEach((id) => {
        removeElementLocal(id);
        Api.deleteElement(id).catch(() => {});
      });
      clearMultiSelection();
      if (snaps.length) recordUndo(() => recreateElements(snaps));
      return;
    }
    if (selectedElementId) {
      const entry = elements.get(selectedElementId);
      if (!entry || entry.data.locked) return;
      e.preventDefault();
      showDeleteConfirm(entry, entry.el.getBoundingClientRect());
    }
  });

  // ---------- Popin de confirmation de suppression ----------

  let activeConfirmPopover = null;
  let outsideClickHandler = null;

  function closeConfirmPopover() {
    if (activeConfirmPopover) { activeConfirmPopover.remove(); activeConfirmPopover = null; }
    if (outsideClickHandler) { document.removeEventListener('pointerdown', outsideClickHandler); outsideClickHandler = null; }
  }

  function showDeleteConfirm(entry, anchorRect) {
    closeConfirmPopover();
    const pop = document.createElement('div');
    pop.className = 'confirm-popover';
    const childIds = entry.data.type === 'frame' ? frameChildren(entry.data.id) : [];
    if (childIds.length) {
      pop.innerHTML = `
        <p>Cette frame contient ${childIds.length} élément${childIds.length > 1 ? 's' : ''}.</p>
        <div class="confirm-popover-actions confirm-popover-actions-stack">
          <button type="button" class="confirm-popover-confirm confirm-popover-danger" data-mode="all">Supprimer la frame et son contenu</button>
          <button type="button" class="confirm-popover-confirm" data-mode="frame-only">Supprimer la frame seule</button>
          <button type="button" class="confirm-popover-cancel">Annuler</button>
        </div>
      `;
    } else {
      pop.innerHTML = `
        <p>Supprimer cet élément ?</p>
        <div class="confirm-popover-actions">
          <button type="button" class="confirm-popover-cancel">Annuler</button>
          <button type="button" class="confirm-popover-confirm">Supprimer</button>
        </div>
      `;
    }
    pop.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.appendChild(pop);
    const popRect = pop.getBoundingClientRect();
    let left = anchorRect.left + anchorRect.width / 2 - popRect.width / 2;
    left = clamp(left, 8, window.innerWidth - popRect.width - 8);
    const top = clamp(anchorRect.bottom + 8, 8, window.innerHeight - popRect.height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    activeConfirmPopover = pop;

    pop.querySelector('.confirm-popover-cancel').addEventListener('click', closeConfirmPopover);
    pop.querySelectorAll('.confirm-popover-confirm').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeConfirmPopover();
        const mode = btn.dataset.mode;
        if (mode === 'all') {
          const snaps = [entry.data, ...childIds.map(cid => elements.get(cid)?.data).filter(Boolean)].map(snapshotForCreate);
          childIds.forEach(removeElementLocal);
          removeElementLocal(entry.data.id);
          Api.deleteElement(entry.data.id, { deleteContents: true })
            .then(() => recordUndo(() => recreateElements(snaps)))
            .catch(err => alert(err.message));
        } else {
          // "frame seule" (ou suppression normale d'un élément qui n'est pas une frame) : le contenu
          // reste sur le tableau, juste détaché (comme un dégroupement) — l'annulation recrée la frame
          // puis rattache les enfants encore présents à cette nouvelle frame.
          const frameSnap = [snapshotForCreate(entry.data)];
          const survivingChildIds = [...childIds];
          childIds.forEach((cid) => { const en = elements.get(cid); if (en) en.data.frameId = null; });
          removeElementLocal(entry.data.id);
          Api.deleteElement(entry.data.id)
            .then(() => recordUndo(async () => {
              const [newFrame] = await recreateElements(frameSnap);
              await Promise.all(survivingChildIds.map((cid) => {
                const en = elements.get(cid);
                if (!en) return null;
                return Api.updateElement(cid, { frameId: newFrame.id }).then(applyRemoteUpdate).catch(() => {});
              }));
            }))
            .catch(err => alert(err.message));
        }
      });
    });
    outsideClickHandler = (e) => { if (!pop.contains(e.target)) closeConfirmPopover(); };
    setTimeout(() => document.addEventListener('pointerdown', outsideClickHandler), 0);
  }

  // Suppression d'un NŒUD au sein d'une arborescence (pas de l'élément plateau lui-même, qui se
  // supprime via showDeleteConfirm comme n'importe quel élément) — même popover de confirmation. La
  // confirmation n'empêche pas une suppression par erreur (un clic trop rapide sur "Supprimer") : on
  // pousse quand même un cran d'annulation, comme pour tout le reste.
  function showArboDeleteConfirm(entry, nodeId, anchorRect) {
    closeConfirmPopover();
    const node = findArboNode(entry.arboTree, nodeId);
    if (!node) return;
    const parent = findArboParent(entry.arboTree, nodeId);
    const index = parent ? parent.children.findIndex(c => c.id === nodeId) : -1;
    const descendants = countArboDescendants(node);
    const pop = document.createElement('div');
    pop.className = 'confirm-popover';
    pop.innerHTML = `
      <p>${descendants > 0 ? `Supprimer cet élément et ${descendants} sous-élément${descendants > 1 ? 's' : ''} ?` : 'Supprimer cet élément ?'}</p>
      <div class="confirm-popover-actions">
        <button type="button" class="confirm-popover-cancel">Annuler</button>
        <button type="button" class="confirm-popover-confirm confirm-popover-danger">Supprimer</button>
      </div>
    `;
    pop.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.appendChild(pop);
    const popRect = pop.getBoundingClientRect();
    let left = anchorRect.left + anchorRect.width / 2 - popRect.width / 2;
    left = clamp(left, 8, window.innerWidth - popRect.width - 8);
    const top = clamp(anchorRect.bottom + 8, 8, window.innerHeight - popRect.height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    activeConfirmPopover = pop;
    pop.querySelector('.confirm-popover-cancel').addEventListener('click', closeConfirmPopover);
    pop.querySelector('.confirm-popover-confirm').addEventListener('click', () => {
      closeConfirmPopover();
      removeArboNode(entry.arboTree, nodeId);
      renderArboBody(entry);
      saveArboTree(entry, true);
      if (parent && index !== -1) {
        recordUndo(() => {
          parent.children.splice(index, 0, node);
          renderArboBody(entry);
          const json = JSON.stringify(entry.arboTree);
          entry.data.text = json;
          return Api.updateElement(entry.data.id, { text: json, width: entry.data.width, height: entry.data.height }).then(applyRemoteUpdate).catch(() => {});
        });
      }
    });
    outsideClickHandler = (e) => { if (!pop.contains(e.target)) closeConfirmPopover(); };
    setTimeout(() => document.addEventListener('pointerdown', outsideClickHandler), 0);
  }

  // ---------- Mesure / redimensionnement automatique du texte ----------

  let textMeasurer = null;
  function measureTextWidth(text, fontSize, bold, italic) {
    if (!textMeasurer) {
      textMeasurer = document.createElement('span');
      textMeasurer.style.cssText = 'position:absolute; visibility:hidden; white-space:pre; top:-9999px; left:-9999px; font-family:inherit;';
      document.body.appendChild(textMeasurer);
    }
    textMeasurer.style.fontSize = `${fontSize}px`;
    textMeasurer.style.fontWeight = bold ? '700' : '400';
    textMeasurer.style.fontStyle = italic ? 'italic' : 'normal';
    textMeasurer.textContent = text;
    return textMeasurer.getBoundingClientRect().width;
  }

  function computeTextBoxSize(data) {
    const size = data.fontSize || 15;
    const raw = (data.text && data.text.length) ? data.text : 'Texte…';
    const lines = raw.split('\n');
    let maxLineWidth = 0;
    lines.forEach((line) => {
      const w = measureTextWidth(line.length ? line : ' ', size, data.bold, data.italic);
      if (w > maxLineWidth) maxLineWidth = w;
    });
    const padX = size * TEXT_PAD_X_RATIO;
    const padY = size * TEXT_PAD_Y_RATIO;
    const lineHeight = size * TEXT_LINE_HEIGHT_RATIO;
    return {
      width: Math.max(TEXT_MIN_CONTENT_WIDTH, maxLineWidth) + padX * 2,
      height: lines.length * lineHeight + padY * 2,
      padX, padY, lineHeight,
    };
  }

  function applyTextAutoSize(entry) {
    if (entry.data.type !== 'text') return;
    const { width, height, padX, padY, lineHeight } = computeTextBoxSize(entry.data);
    entry.data.width = width;
    entry.data.height = height;
    entry.el.style.width = `${width}px`;
    entry.el.style.height = `${height}px`;
    if (entry.textEl) {
      entry.textEl.style.top = `${padY}px`;
      entry.textEl.style.bottom = `${padY}px`;
      entry.textEl.style.left = `${padX}px`;
      entry.textEl.style.right = `${padX}px`;
      entry.textEl.style.lineHeight = `${lineHeight}px`;
    }
    updateConnectorsFor(entry.data.id);
    if (selectedElementId === entry.data.id) repositionToolbar(entry);
  }

  // ---------- Rendu du toolbar flottant ----------

  // dotStyle 'ring' : rond blanc cerclé de la couleur (pour un contour/stroke) plutôt qu'un rond
  // plein (pour un fond) — sinon les deux se ressemblent trop et on ne sait plus lequel est lequel.
  // `allowRandom` ajoute, en dernier dans la liste, une pastille "aléatoire" (sentinel `'random'`,
  // cf. ELEMENT_DEFAULTS.stack côté serveur et pickStackNoteColor) — seule la pile de post-its s'en
  // sert pour l'instant.
  function colorDropdownHtml(role, currentColor, allowNone, title, dotStyle = 'fill', allowRandom = false) {
    const colors = allowNone ? [null, ...ELEMENT_COLORS] : ELEMENT_COLORS;
    const isRing = dotStyle === 'ring';
    const isRandom = allowRandom && currentColor === 'random';
    const hasColor = currentColor && !isRandom;
    const dotStyleAttr = isRing ? `border-color:${hasColor ? currentColor : '#ccc'}` : (hasColor ? `background:${currentColor}` : '');
    return `
      <div class="toolbar-dropdown" data-role="${role}-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="${role}-trigger" title="${title}">
          <span class="toolbar-color-dot${isRing ? ' toolbar-color-dot-ring' : ''}${!isRing && !hasColor && !isRandom ? ' toolbar-color-dot-none' : ''}${isRandom ? ' toolbar-color-dot-random' : ''}" style="${dotStyleAttr}">${isRandom ? iconShuffle(11) : ''}</span>
        </button>
        <div class="toolbar-popover toolbar-color-popover" data-role="${role}-popover">
          ${colors.map(c => `<button type="button" class="toolbar-color-swatch${c ? '' : ' is-none'}${(c || null) === (currentColor || null) ? ' is-active' : ''}" data-color="${c || ''}" style="${c ? `background:${c}` : ''}"></button>`).join('')}
          ${allowRandom ? `<button type="button" class="toolbar-color-swatch toolbar-color-swatch-random${isRandom ? ' is-active' : ''}" data-color="random" title="Aléatoire">${iconShuffle()}</button>` : ''}
        </div>
      </div>
    `;
  }

  function formatDropdownHtml(data) {
    return `
      <div class="toolbar-dropdown" data-role="format-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="format-trigger" title="Style de texte">B</button>
        <div class="toolbar-popover toolbar-format-popover" data-role="format-popover">
          <button type="button" class="element-format-btn${data.bold ? ' is-active' : ''}" data-format="bold" title="Gras">B</button>
          <button type="button" class="element-format-btn is-italic${data.italic ? ' is-active' : ''}" data-format="italic" title="Italique">I</button>
          <button type="button" class="element-format-btn is-underline${data.underline ? ' is-active' : ''}" data-format="underline" title="Souligné">U</button>
          <button type="button" class="element-format-btn is-strike${data.strikethrough ? ' is-active' : ''}" data-format="strikethrough" title="Barré">S</button>
        </div>
      </div>
    `;
  }

  function radiusIconSvg(iconRx) {
    return `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="2" y="2" width="14" height="14" rx="${iconRx}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  }

  // Icône fixe (4 coins) pour le déclencheur — un rectangle à coins arrondis ressemblait trop au
  // rond du contour ; ces coins isolés se lisent sans ambiguïté comme "arrondi des angles".
  function radiusCornersIconSvg() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 9V6a2 2 0 0 1 2-2h3"/><path d="M15 4h3a2 2 0 0 1 2 2v3"/><path d="M20 15v3a2 2 0 0 1-2 2h-3"/><path d="M9 20H6a2 2 0 0 1-2-2v-3"/></svg>`;
  }

  // Alignement du texte : une rangée horizontale, et (withVertical) une seconde rangée verticale, dans
  // UN seul popover — cliquer une option ne le referme pas (comme borderDropdownHtml ci-dessous), pour
  // pouvoir ajuster les deux sans rouvrir le menu. Partagé par rectangle et post-it (le texte libre
  // n'en a pas : sa boîte épouse toujours exactement son contenu, cf. applyTextAutoSize, un alignement
  // n'y aurait aucun effet visible).
  function alignDropdownHtml(data) {
    const h = data.textAlign || 'left';
    const v = data.textValign || 'center';
    const hIcon = { left: iconTextAlignLeft, center: iconTextAlignCenter, right: iconTextAlignRight }[h]();
    return `
      <div class="toolbar-dropdown" data-role="align-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="align-trigger" title="Alignement du texte">${hIcon}</button>
        <div class="toolbar-popover toolbar-thickness-popover" data-role="align-popover">
          <div class="toolbar-thickness-row">
            <button type="button" class="toolbar-thickness-option${h === 'left' ? ' is-active' : ''}" data-align-h="left" title="Aligné à gauche">${iconTextAlignLeft()}</button>
            <button type="button" class="toolbar-thickness-option${h === 'center' ? ' is-active' : ''}" data-align-h="center" title="Centré">${iconTextAlignCenter()}</button>
            <button type="button" class="toolbar-thickness-option${h === 'right' ? ' is-active' : ''}" data-align-h="right" title="Aligné à droite">${iconTextAlignRight()}</button>
          </div>
          <div class="toolbar-thickness-row">
            <button type="button" class="toolbar-thickness-option${v === 'top' ? ' is-active' : ''}" data-align-v="top" title="Aligné en haut">${iconValignTop()}</button>
            <button type="button" class="toolbar-thickness-option${v === 'center' ? ' is-active' : ''}" data-align-v="center" title="Centré verticalement">${iconValignMiddle()}</button>
            <button type="button" class="toolbar-thickness-option${v === 'bottom' ? ' is-active' : ''}" data-align-v="bottom" title="Aligné en bas">${iconValignBottom()}</button>
          </div>
        </div>
      </div>
    `;
  }

  function linkDropdownHtml(data) {
    const hasLink = !!data.link;
    const escaped = hasLink ? data.link.replace(/"/g, '&quot;') : '';
    return `
      <div class="toolbar-dropdown" data-role="link-wrap">
        <button type="button" class="toolbar-dropdown-trigger${hasLink ? ' is-active' : ''}" data-role="link-trigger" title="${hasLink ? 'Modifier le lien' : 'Ajouter un lien'}">${iconLinkChain()}</button>
        <div class="toolbar-popover toolbar-link-popover" data-role="link-popover">
          <input type="text" class="toolbar-link-input" data-role="link-input" placeholder="https://…" value="${escaped}">
          <div class="toolbar-link-actions">
            <button type="button" class="toolbar-link-remove" data-role="link-remove"${hasLink ? '' : ' hidden'}>Retirer le lien</button>
            <button type="button" class="primary-btn toolbar-link-apply" data-role="link-apply">OK</button>
          </div>
        </div>
      </div>
    `;
  }

  // Un seul bouton pour arrondi + épaisseur/style du contour + couleur du contour (façon Miro) — trois
  // réglages qui décrivaient auparavant trois boutons distincts. Comme align/link ci-dessus, on
  // n'échappe pas le popover après un choix : plusieurs réglages s'enchaînent souvent (ex. choisir le
  // style ET la couleur du contour). withRadius: false pour la frame, qui reste toujours à angles
  // droits (cf. applyRectangleStyle).
  function borderDropdownHtml(data, { withRadius = true } = {}) {
    const r = data.radius || 0;
    const w = data.strokeWidth || 0;
    const style = data.lineStyle === 'dashed' ? 'dashed' : 'solid';
    return `
      <div class="toolbar-dropdown" data-role="border-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="border-trigger" title="Bordure">${withRadius ? radiusCornersIconSvg() : iconBorderSquare()}</button>
        <div class="toolbar-popover toolbar-border-popover" data-role="border-popover">
          ${withRadius ? `
            <div class="toolbar-popover-label">Angles</div>
            <div class="toolbar-thickness-row">
              ${RADIUS_PRESETS.map(([label, val, iconRx]) => `<button type="button" class="toolbar-thickness-option${r === val ? ' is-active' : ''}" data-radius="${val}" title="${label}">${radiusIconSvg(iconRx)}</button>`).join('')}
            </div>
          ` : ''}
          <div class="toolbar-popover-label">Épaisseur du contour</div>
          <div class="toolbar-thickness-row">
            ${STROKE_WIDTHS.map(sw => `<button type="button" class="toolbar-thickness-option${w === sw ? ' is-active' : ''}" data-strokewidth="${sw}" title="${sw === 0 ? 'Aucun contour' : sw + 'px'}"><span class="toolbar-thickness-bar" style="height:${sw || 2}px; opacity:${sw ? 1 : 0.3}"></span></button>`).join('')}
          </div>
          <div class="toolbar-popover-label">Style du trait</div>
          <div class="toolbar-thickness-row">
            ${LINE_STYLES.map(([s, label]) => `<button type="button" class="toolbar-thickness-option${style === s ? ' is-active' : ''}" data-linestyle="${s}" title="${label}"><span class="toolbar-thickness-bar${s === 'dashed' ? ' is-dashed' : ''}" style="height:4px"></span></button>`).join('')}
          </div>
          <div class="toolbar-popover-label">Couleur du contour</div>
          <div class="toolbar-color-popover-inline">
            ${ELEMENT_COLORS.map(c => `<button type="button" class="toolbar-color-swatch${c === (data.strokeColor || null) ? ' is-active' : ''}" data-strokecolor="${c}" style="background:${c}"></button>`).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function iconArrowCapStart() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/></svg>'; }
  function iconArrowCapEnd() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>'; }
  function iconTextLabel() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="9" y1="20" x2="15" y2="20"/></svg>'; }

  // Bouton "Style et épaisseur" du trait/connecteur : continu/pointillé + épaisseur, dans UN popover
  // (reste ouvert après un choix) — la couleur, elle, garde son propre bouton séparé (colorDropdownHtml),
  // comme pour les autres types, plutôt que d'être regroupée ici. Pour un connecteur, les pointes de
  // flèche (début/fin) rejoignent ce MÊME popover (showCaps) plutôt que deux boutons séparés dans la
  // barre — un seul bouton d'action pour "tout ce qui concerne le trait", comme demandé.
  function lineDropdownHtml(data, { showCaps = false } = {}) {
    const currentStyle = data.lineStyle || 'solid';
    return `
      <div class="toolbar-dropdown" data-role="linestyle-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="linestyle-trigger" title="Style du trait">
          <span class="toolbar-thickness-preview${currentStyle === 'dashed' ? ' is-dashed' : ''}" style="height:${clamp(data.height, 2, 12)}px"></span>
        </button>
        <div class="toolbar-popover toolbar-thickness-popover" data-role="linestyle-popover">
          ${LINE_STYLES.map(([style, label]) => `
            <div class="toolbar-thickness-row">
              ${LINE_THICKNESSES.map(t => `<button type="button" class="toolbar-thickness-option${data.height === t && currentStyle === style ? ' is-active' : ''}" data-thickness="${t}" data-style="${style}" title="${label} ${t}px"><span class="toolbar-thickness-bar${style === 'dashed' ? ' is-dashed' : ''}" style="height:${t}px"></span></button>`).join('')}
            </div>
          `).join('')}
          ${showCaps ? `
            <div class="toolbar-popover-label">Pointes de flèche</div>
            <div class="toolbar-thickness-row">
              <button type="button" class="toolbar-thickness-option${data.startCap === 'arrow' ? ' is-active' : ''}" data-capside="start" title="Flèche au début">${iconArrowCapStart()}</button>
              <button type="button" class="toolbar-thickness-option${data.endCap === 'arrow' ? ' is-active' : ''}" data-capside="end" title="Flèche à la fin">${iconArrowCapEnd()}</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // Menu "⋮" : regroupe dupliquer / premier plan / arrière-plan / supprimer, plutôt que quatre icônes
  // séparées dans la barre (cf. la maquette Miro fournie) — généralisé à tous les types d'éléments,
  // pas seulement le rectangle. Une frame n'a pas de premier/arrière-plan (elle reste toujours tout
  // au fond, cf. server.js) : showFront/showBack les masquent pour elle.
  function moreMenuHtml({ showFront = true, showBack = true } = {}) {
    return `
      <div class="toolbar-dropdown" data-role="more-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="more-trigger" title="Plus d'options">${iconMoreDots()}</button>
        <div class="toolbar-popover toolbar-menu-popover" data-role="more-popover">
          <button type="button" class="toolbar-menu-item" data-role="more-duplicate">Dupliquer</button>
          ${showFront ? `<button type="button" class="toolbar-menu-item" data-role="more-front">Mettre au premier plan</button>` : ''}
          ${showBack ? `<button type="button" class="toolbar-menu-item" data-role="more-back">Envoyer à l'arrière-plan</button>` : ''}
          <span class="toolbar-menu-sep"></span>
          <button type="button" class="toolbar-menu-item toolbar-menu-danger" data-role="more-delete">Supprimer</button>
        </div>
      </div>
    `;
  }

  // Le clic sur "Verrouiller" porte toujours sur le groupe entier d'un élément groupé (jamais
  // élément par élément au sein d'un groupe, cf. wireToolbarControls) : ce libellé le précise avant
  // même de cliquer plutôt que de le découvrir seulement après. Une frame seule (pas groupée) ne
  // verrouille qu'elle-même, donc pas de mention spéciale dans ce cas.
  function lockButtonTitle(data) {
    const members = data.groupId ? groupMembers(data.groupId) : [];
    return members.length > 1 ? `Verrouiller le groupe de ${members.length} éléments` : 'Verrouiller';
  }

  // Barre d'action d'un rectangle (façon Miro, cf. maquette fournie) : assez différente du gabarit
  // partagé ci-dessous (ordre des contrôles, séparateurs, dupliquer/premier plan/arrière-plan/
  // supprimer regroupés dans un menu "⋮" plutôt qu'en icônes séparées) pour avoir sa propre mise en
  // page plutôt que de complexifier buildToolbarHtml avec des cas particuliers partout.
  function buildRectangleToolbarHtml(data) {
    const voted = (data.votes || []).includes(myName);
    return `
      <select class="element-fontsize-select" data-role="rect-fontsize" title="Taille du texte">${fontSizeOptionsHtml(data.fontSize)}</select>
      ${formatDropdownHtml(data)}
      ${alignDropdownHtml(data)}
      ${colorDropdownHtml('textcolor', data.textColor, false, 'Couleur du texte')}
      ${linkDropdownHtml(data)}
      <span class="element-toolbar-sep"></span>
      ${colorDropdownHtml('color', data.color, false, 'Couleur de fond')}
      ${borderDropdownHtml(data, { withRadius: data.tag !== 'diamond' })}
      <span class="element-toolbar-sep"></span>
      <button type="button" class="element-icon-btn element-vote-btn${voted ? ' is-active' : ''}" title="${voted ? 'Retirer mon vote' : 'Voter'}">${iconVote()}</button>
      <button type="button" class="element-icon-btn element-comment-btn" title="Commenter">${iconComment()}</button>
      <span class="element-toolbar-sep"></span>
      <button type="button" class="element-icon-btn element-lock-btn" title="${lockButtonTitle(data)}">${iconLock()}</button>
      <span class="element-toolbar-sep"></span>
      ${moreMenuHtml()}
    `;
  }

  function buildToolbarHtml(data) {
    if (data.type === 'rectangle') return buildRectangleToolbarHtml(data);
    let controls = '';
    if (data.type === 'note') {
      // Couleur du texte volontairement absente pour le moment : le post-it reste noir fixe. Pas de
      // taille de police non plus : un post-it garde une typo uniforme, plutôt que de risquer des
      // tailles disparates d'un post-it à l'autre sur le même tableau.
      controls = formatDropdownHtml(data)
        + alignDropdownHtml(data)
        + `<span class="element-toolbar-sep"></span>`
        + colorDropdownHtml('color', data.color, false, 'Couleur de fond');
    } else if (data.type === 'line' || data.type === 'connector') {
      controls = colorDropdownHtml('color', data.color, false, 'Couleur') + lineDropdownHtml(data, { showCaps: data.type === 'connector' });
      if (data.type === 'connector') {
        controls += `<button type="button" class="element-icon-btn element-connector-label-btn" title="${data.title ? 'Modifier le texte' : 'Ajouter du texte'}">${iconTextLabel()}</button>`;
        // Taille du libellé : seulement une fois qu'il y en a un. Pas de couleur dédiée : le texte
        // prend celle du trait (cf. syncConnectorLabelContent). Même valeur par défaut (15) que pour
        // l'affichage réel, sinon la taille sélectionnée différerait de celle affichée.
        if (data.title) {
          controls += `<select class="element-fontsize-select" data-role="connectorlabel-fontsize" title="Taille du texte">${fontSizeOptionsHtml(data.fontSize || 15)}</select>`;
        }
      }
    } else if (data.type === 'text') {
      // Pas d'alignement ici : sa boîte épouse toujours exactement son contenu (cf.
      // applyTextAutoSize), ça n'aurait pas d'effet visible.
      controls = `<select class="element-fontsize-select" data-role="fontsize" title="Taille">${fontSizeOptionsHtml(data.fontSize)}</select>`
        + formatDropdownHtml(data)
        + colorDropdownHtml('color', data.color, false, 'Couleur du texte')
        + linkDropdownHtml(data)
        + `<span class="element-toolbar-sep"></span>`
        + colorDropdownHtml('bg', data.backgroundColor, true, 'Couleur de fond');
    } else if (data.type === 'image') {
      controls = `
        <button type="button" class="element-icon-btn element-grayscale-btn${data.grayscale ? ' is-active' : ''}" title="Noir et blanc">
          <svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>
        </button>
        <button type="button" class="element-icon-btn element-crop-btn" title="Rogner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>
        </button>
      `;
    } else if (data.type === 'frame') {
      controls = colorDropdownHtml('color', data.color, false, 'Couleur de fond')
        + borderDropdownHtml(data, { withRadius: false })
        + `<span class="element-toolbar-sep"></span>`
        + `<button type="button" class="element-icon-btn element-arrange-btn" title="Ordonner (ranger le contenu actuel en grille)">${iconArrange()}</button>`
        + `<span class="element-toolbar-sep"></span>`
        + `<select class="element-fontsize-select" data-role="title-fontsize" title="Taille du titre">${fontSizeOptionsHtml(data.fontSize)}</select>`
        + colorDropdownHtml('title', data.titleColor, false, 'Couleur du titre');
    } else if (data.type === 'instruction' || data.type === 'tip') {
      // Pas de format/alignement ici : le titre/numéro/tag ont une mise en forme fixe, et le texte
      // riche du bloc "tips" se met en forme via la mini barre qui apparaît sur sa sélection (cf.
      // richTextToolbarHtml), pas depuis cette barre d'action principale.
      controls = colorDropdownHtml('color', data.color, false, 'Couleur de fond');
    } else if (data.type === 'webpage') {
      // Le wireframe n'est pas un texte éditable : on change de type de page via ce sélecteur plutôt
      // qu'en cliquant dessus (rien n'y est interactif) — la description se met en forme via la mini
      // barre de sélection (cf. richTextToolbarHtml), pas depuis cette barre-ci.
      controls = `<select class="element-fontsize-select webpage-pagetype-select" data-role="pagetype" title="Type de page">${webpageTypeOptionsHtml(data.tag)}</select>`
        + colorDropdownHtml('color', data.color, false, 'Couleur de fond');
    } else if (data.type === 'stack') {
      controls = colorDropdownHtml('color', data.color, false, 'Couleur des post-its', 'fill', true)
        + `<button type="button" class="element-icon-btn element-showauthor-btn${data.grayscale ? ' is-active' : ''}" title="Afficher l'auteur">${iconAuthor()}</button>`;
    }
    const sep = controls ? '<span class="element-toolbar-sep"></span>' : '';
    const voted = (data.votes || []).includes(myName);
    // Un trait/connecteur n'a pas de contenu sur lequel voter ou commenter : ces deux boutons ne
    // s'affichent pas pour ces deux types — une pile de post-its non plus, c'est un outil, pas un
    // contenu du board.
    const hasVoteComment = data.type !== 'line' && data.type !== 'connector' && data.type !== 'stack';
    const voteCommentHtml = hasVoteComment ? `
      <button type="button" class="element-icon-btn element-vote-btn${voted ? ' is-active' : ''}" title="${voted ? 'Retirer mon vote' : 'Voter'}">${iconVote()}</button>
      <button type="button" class="element-icon-btn element-comment-btn" title="Commenter">${iconComment()}</button>
      <span class="element-toolbar-sep"></span>
    ` : '';
    // Une frame reste toujours tout au fond (cf. server.js) : le menu "⋮" n'y propose pas de
    // premier/arrière-plan, ce serait sans effet.
    const isFrame = data.type === 'frame';
    return `
      ${controls}${sep}
      ${voteCommentHtml}
      <button type="button" class="element-icon-btn element-lock-btn" title="${lockButtonTitle(data)}">${iconLock()}</button>
      <span class="element-toolbar-sep"></span>
      ${moreMenuHtml({ showFront: !isFrame, showBack: !isFrame })}
    `;
  }

  // Barre affichée à la place du toolbar normal quand l'élément sélectionné est verrouillé : un
  // seul bouton "appui long pour déverrouiller", dont le fond se remplit pendant l'appui (façon Miro).
  // Le verrouillage étant toujours appliqué à un groupe entier d'un coup (jamais élément par élément
  // au sein d'un groupe), le libellé précise le nombre d'éléments quand il s'agit d'un groupe — une
  // frame seule (pas groupée) ne verrouille qu'elle-même, pas ce qu'elle contient (cf. le clic du
  // bouton "Verrouiller" dans wireToolbarControls).
  function buildLockedToolbarHtml(entry) {
    const members = entry.data.groupId ? groupMembers(entry.data.groupId) : [];
    const label = members.length > 1
      ? `Appui long pour déverrouiller le groupe (${members.length} éléments)`
      : 'Appui long pour déverrouiller';
    return `
      <button type="button" class="unlock-hold-btn">
        <span class="unlock-hold-fill"></span>
        <svg class="unlock-hold-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
        <span class="unlock-hold-label">${label}</span>
      </button>
    `;
  }

  function iconAlignLeft() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="3" x2="4" y2="21"/><rect x="7" y="6" width="12" height="5"/><rect x="7" y="13" width="7" height="5"/></svg>'; }
  function iconAlignCenter() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="3" x2="12" y2="21"/><rect x="6" y="6" width="12" height="5"/><rect x="8.5" y="13" width="7" height="5"/></svg>'; }
  function iconAlignRight() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="20" y1="3" x2="20" y2="21"/><rect x="5" y="6" width="12" height="5"/><rect x="10" y="13" width="7" height="5"/></svg>'; }
  function iconGroup() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="9" height="9" rx="1.5"/><rect x="12" y="12" width="9" height="9" rx="1.5"/></svg>'; }
  function iconUngroup() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="8" height="8" rx="1.5"/><rect x="14" y="14" width="8" height="8" rx="1.5"/><line x1="9.5" y1="9.5" x2="14.5" y2="14.5" stroke-dasharray="2 2"/></svg>'; }
  function iconLock() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'; }
  function iconAuthor() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>'; }
  // Bascule "couleurs aléatoires" d'une pile de post-its (icône façon lecture aléatoire, cf. iconVote
  // pour le même style de trait).
  function iconShuffle(size = 14) { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>`; }
  // Boutons révélés au survol d'un nœud d'arborescence (cf. wireArboTree) : ajouter un sous-élément /
  // supprimer ce nœud.
  function iconPlus() { return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'; }
  function iconTrash() { return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>'; }
  function iconComment() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'; }
  // "Vote" simple (façon +1) : un simple "+", même style trait que les autres icônes pour rester
  // cohérent au zoom (contrairement aux glyphes émoji, qui redimensionnent moins proprement).
  function iconVote() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'; }
  function iconToFront() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="12" height="12" rx="1.5"/><rect x="9" y="9" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/></svg>'; }
  function iconToBack() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/><rect x="9" y="9" width="12" height="12" rx="1.5"/></svg>'; }
  function iconArrange() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'; }
  // Alignement du TEXTE dans une forme (distinct des icônes d'alignement d'ÉLÉMENTS ci-dessus,
  // iconAlignLeft/Center/Right, qui représentent le calage d'objets les uns par rapport aux autres) :
  // trois lignes de longueurs différentes, calées comme le ferait le texte lui-même.
  function iconTextAlignLeft() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="17" y2="18"/></svg>'; }
  function iconTextAlignCenter() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="6" y1="18" x2="18" y2="18"/></svg>'; }
  function iconTextAlignRight() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="7" y1="18" x2="20" y2="18"/></svg>'; }
  function iconValignTop() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="1"/><line x1="7.5" y1="8" x2="16.5" y2="8"/></svg>'; }
  function iconValignMiddle() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="1"/><line x1="7.5" y1="12" x2="16.5" y2="12"/></svg>'; }
  function iconValignBottom() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="1"/><line x1="7.5" y1="16" x2="16.5" y2="16"/></svg>'; }
  function iconLinkChain() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15l6-6"/><path d="M13 5.5l1-1a3.54 3.54 0 0 1 5 5l-1.5 1.5"/><path d="M11 18.5l-1 1a3.54 3.54 0 0 1-5-5l1.5-1.5"/></svg>'; }
  function iconMoreDots() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>'; }
  // Déclencheur du bouton "Bordure" quand l'arrondi n'est pas proposé (frame) : un simple rectangle à
  // angles droits, pour ne pas laisser croire qu'on peut y régler un arrondi (cf. radiusCornersIconSvg).
  function iconBorderSquare() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>'; }

  function groupMembers(groupId) {
    if (!groupId) return [];
    const ids = [];
    elements.forEach((entry) => { if (entry.data.groupId === groupId) ids.push(entry.data.id); });
    return ids;
  }

  function buildMultiToolbarHtml() {
    const ids = [...multiSelectedIds];
    const groupIds = new Set(ids.map(id => elements.get(id)?.data.groupId).filter(Boolean));
    let isFullGroup = false;
    if (groupIds.size === 1) {
      const gid = [...groupIds][0];
      const members = groupMembers(gid);
      isFullGroup = members.length === ids.length && members.every(id => ids.includes(id));
    }
    return `
      <button type="button" class="element-icon-btn" data-action="align-left" title="Aligner à gauche">${iconAlignLeft()}</button>
      <button type="button" class="element-icon-btn" data-action="align-center" title="Centrer horizontalement">${iconAlignCenter()}</button>
      <button type="button" class="element-icon-btn" data-action="align-right" title="Aligner à droite">${iconAlignRight()}</button>
      <span class="element-toolbar-sep"></span>
      <button type="button" class="element-icon-btn${isFullGroup ? ' is-active' : ''}" data-action="${isFullGroup ? 'ungroup' : 'group'}" title="${isFullGroup ? 'Dégrouper' : 'Grouper'}">${isFullGroup ? iconUngroup() : iconGroup()}</button>
      <button type="button" class="element-icon-btn" data-action="lock" title="Verrouiller">${iconLock()}</button>
    `;
  }

  // ---------- Barre d'outils flottante (un seul nœud partagé, jamais imbriqué dans un élément) ----------

  function closeAllToolbarPopovers() {
    toolbarEl.querySelectorAll('.toolbar-popover.is-open').forEach(p => p.classList.remove('is-open'));
  }
  document.addEventListener('pointerdown', (e) => {
    if (!toolbarEl.contains(e.target)) closeAllToolbarPopovers();
  });

  function repositionToolbar(entry) {
    if (!toolbarEl.classList.contains('is-open') || selectedElementId !== entry.data.id) return;
    const rect = entry.el.getBoundingClientRect();
    const tRect = toolbarEl.getBoundingClientRect();
    let top = rect.top - tRect.height - 8;
    if (top < 4) top = Math.min(rect.bottom + 8, window.innerHeight - tRect.height - 4);
    const left = clamp(rect.left, 4, window.innerWidth - tRect.width - 4);
    toolbarEl.style.left = `${left}px`;
    toolbarEl.style.top = `${top}px`;
  }

  function showToolbarFor(entry) {
    if (entry.data.locked) {
      toolbarEl.innerHTML = buildLockedToolbarHtml(entry);
      toolbarEl.classList.add('is-open');
      wireUnlockButton(entry);
      repositionToolbar(entry);
      showGroupFrame(entry);
      return;
    }
    hideGroupFrame();
    toolbarEl.innerHTML = buildToolbarHtml(entry.data);
    toolbarEl.classList.add('is-open');
    wireToolbarControls(entry);
    repositionToolbar(entry);
  }

  function hideToolbar() {
    toolbarEl.classList.remove('is-open');
    toolbarEl.innerHTML = '';
    hideGroupFrame();
  }

  // ---------- Cadre de groupe (visible quand un élément verrouillé appartenant à un groupe est
  // sélectionné, puisque le clic ne montre alors que lui seul, pas toute la multi-sélection) ----------

  let groupFrameEl = null;
  function ensureGroupFrameEl() {
    if (!groupFrameEl) {
      groupFrameEl = document.createElement('div');
      groupFrameEl.className = 'group-frame';
      document.body.appendChild(groupFrameEl);
    }
    return groupFrameEl;
  }

  function showGroupFrame(entry) {
    const members = entry.data.groupId ? groupMembers(entry.data.groupId).map(id => elements.get(id)).filter(Boolean) : [];
    if (members.length < 2) { hideGroupFrame(); return; }
    const frame = ensureGroupFrameEl();
    let rect = null;
    members.forEach((en) => {
      const r = en.el.getBoundingClientRect();
      if (!rect) rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      else {
        rect.left = Math.min(rect.left, r.left);
        rect.top = Math.min(rect.top, r.top);
        rect.right = Math.max(rect.right, r.right);
        rect.bottom = Math.max(rect.bottom, r.bottom);
      }
    });
    const pad = 8;
    frame.style.left = `${rect.left - pad}px`;
    frame.style.top = `${rect.top - pad}px`;
    frame.style.width = `${rect.right - rect.left + pad * 2}px`;
    frame.style.height = `${rect.bottom - rect.top + pad * 2}px`;
    frame.classList.add('is-visible');
  }

  function hideGroupFrame() {
    if (groupFrameEl) groupFrameEl.classList.remove('is-visible');
  }

  function refreshToolbarIfSelected(entry) {
    if (selectedElementId !== entry.data.id || !toolbarEl.classList.contains('is-open')) return;
    // Un écho serveur (bringToFront, etc.) peut arriver pendant que l'utilisateur vient d'ouvrir un
    // popover (couleur, épaisseur...) : le rebuild ci-dessous recrée le DOM du toolbar, ce qui le
    // refermerait aussitôt. On mémorise le popover ouvert pour le rouvrir après reconstruction.
    const openPopover = toolbarEl.querySelector('.toolbar-popover.is-open');
    const openRole = openPopover ? openPopover.dataset.role : null;
    showToolbarFor(entry);
    if (openRole) {
      const popover = toolbarEl.querySelector(`[data-role="${openRole}"]`);
      if (popover) popover.classList.add('is-open');
    }
  }

  // ---------- Barre d'outils multi-sélection ----------

  function multiSelectionBoundingRect() {
    let rect = null;
    multiSelectedIds.forEach((id) => {
      const entry = elements.get(id);
      if (!entry) return;
      const r = entry.el.getBoundingClientRect();
      if (!rect) rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      else {
        rect.left = Math.min(rect.left, r.left);
        rect.top = Math.min(rect.top, r.top);
        rect.right = Math.max(rect.right, r.right);
        rect.bottom = Math.max(rect.bottom, r.bottom);
      }
    });
    return rect;
  }

  function repositionMultiToolbar() {
    if (!toolbarEl.classList.contains('is-open-multi')) return;
    const rect = multiSelectionBoundingRect();
    if (!rect) return;
    const tRect = toolbarEl.getBoundingClientRect();
    let top = rect.top - tRect.height - 8;
    if (top < 4) top = Math.min(rect.bottom + 8, window.innerHeight - tRect.height - 4);
    const left = clamp(rect.left + (rect.right - rect.left) / 2 - tRect.width / 2, 4, window.innerWidth - tRect.width - 4);
    toolbarEl.style.left = `${left}px`;
    toolbarEl.style.top = `${top}px`;
  }

  function showMultiToolbar() {
    toolbarEl.innerHTML = buildMultiToolbarHtml();
    toolbarEl.classList.add('is-open', 'is-open-multi');
    wireMultiToolbarControls();
    repositionMultiToolbar();
  }

  function hideMultiToolbar() {
    toolbarEl.classList.remove('is-open-multi');
    if (!selectedElementId) hideToolbar();
  }

  function clearMultiSelection() {
    multiSelectedIds.forEach((id) => {
      const entry = elements.get(id);
      if (entry) entry.el.classList.remove('is-multi-selected');
    });
    multiSelectedIds = new Set();
    hideMultiToolbar();
  }

  function setMultiSelection(ids) {
    deselectElement();
    clearMultiSelection();
    ids.forEach((id) => {
      const entry = elements.get(id);
      if (!entry || entry.data.locked) return;
      multiSelectedIds.add(id);
      entry.el.classList.add('is-multi-selected');
    });
    if (multiSelectedIds.size >= 2) showMultiToolbar();
    else if (multiSelectedIds.size === 1) {
      const onlyId = [...multiSelectedIds][0];
      clearMultiSelection();
      selectElement(onlyId);
    }
  }

  // Cmd/Ctrl-clic sur un élément : l'ajoute à la sélection courante (ou l'en retire s'il y était déjà)
  // au lieu de la remplacer — pendant qu'une sélection à la souris (marquee) reste une alternative
  // pour sélectionner un groupe d'un coup.
  function toggleMultiSelect(id) {
    const entry = elements.get(id);
    if (!entry || entry.data.locked) return;
    const ids = multiSelectedIds.size >= 2 ? new Set(multiSelectedIds) : new Set(selectedElementId ? [selectedElementId] : []);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    if (ids.size === 0) { deselectElement(); clearMultiSelection(); return; }
    setMultiSelection([...ids]);
  }

  function moveElementTo(entry, x, y) {
    entry.data.x = x;
    entry.data.y = y;
    entry.el.style.left = `${x}px`;
    entry.el.style.top = `${y}px`;
    updateConnectorsFor(entry.data.id);
  }

  // Une seule requête groupée pour tout le lot aligné, comme pour un glisser de groupe : cliquer
  // plusieurs fois de suite sur "aligner à gauche/droite" (ou un aller-retour entre les deux) envoyait
  // avant ça un PATCH par élément et par clic, chacun s'appliquant à son tour dès sa réponse reçue —
  // visible comme si les éléments "rejouaient" chaque alignement intermédiaire après coup.
  function moveElementsBatch(entries) {
    if (!entries.length) return;
    const moves = entries.map(en => ({ id: en.data.id, x: en.data.x, y: en.data.y }));
    Api.updateElementsBatch(moves, false)
      .then(({ elements: updated, superseded, isLatest }) => {
        if (superseded || !isLatest) return;
        updated.forEach(applyRemoteUpdate);
      })
      .catch(() => {});
  }

  function wireMultiToolbarControls() {
    toolbarEl.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => runMultiAction(btn.dataset.action));
    });
  }

  function runMultiAction(action) {
    const ids = [...multiSelectedIds];
    const entries = ids.map(id => elements.get(id)).filter(Boolean);
    if (!entries.length) return;
    // Un connecteur n'a pas de position propre (dérivée de ses deux ancres) : l'aligner n'a pas de
    // sens, et il serait de toute façon aussitôt "remis à sa place" au prochain recalcul.
    const movable = entries.filter(en => en.data.type !== 'connector');
    const isAlign = action === 'align-left' || action === 'align-right' || action === 'align-center';
    if (isAlign && !movable.length) return;

    if (isAlign) {
      // Positions d'avant capturées AVANT moveElementTo (qui mute en.data.x/y en place) — un seul cran
      // d'annulation pour tout le lot, comme pour un glisser de groupe (cf. restoreMovedPositions).
      const before = movable.map(en => ({ id: en.data.id, x: en.data.x, y: en.data.y }));
      if (action === 'align-left') {
        const minX = Math.min(...movable.map(en => en.data.x));
        movable.forEach(en => moveElementTo(en, minX, en.data.y));
      } else if (action === 'align-right') {
        const maxRight = Math.max(...movable.map(en => en.data.x + en.data.width));
        movable.forEach(en => moveElementTo(en, maxRight - en.data.width, en.data.y));
      } else {
        const minX = Math.min(...movable.map(en => en.data.x));
        const maxRight = Math.max(...movable.map(en => en.data.x + en.data.width));
        const centerX = (minX + maxRight) / 2;
        movable.forEach(en => moveElementTo(en, centerX - en.data.width / 2, en.data.y));
      }
      moveElementsBatch(movable);
      recordUndo(() => restoreMovedPositions(before));
    } else if (action === 'group') {
      // Chaque élément restaure SON propre groupId d'avant (peut différer d'un élément à l'autre —
      // ex. grouper un élément déjà dans un autre groupe avec un élément isolé).
      const before = entries.map(en => ({ id: en.data.id, before: en.data.groupId || null }));
      const gid = randomId();
      entries.forEach((en) => {
        en.data.groupId = gid;
        Api.updateElement(en.data.id, { groupId: gid }).catch(() => {});
      });
      recordMultiFieldUndo(before, 'groupId');
      showMultiToolbar();
    } else if (action === 'ungroup') {
      const before = entries.map(en => ({ id: en.data.id, before: en.data.groupId || null }));
      entries.forEach((en) => {
        en.data.groupId = null;
        Api.updateElement(en.data.id, { groupId: null }).catch(() => {});
      });
      recordMultiFieldUndo(before, 'groupId');
      showMultiToolbar();
    } else if (action === 'lock') {
      // Toujours verrouiller le(s) groupe(s) entier(s), même si la sélection (ex. rectangle de
      // sélection) n'en capturait qu'une partie — jamais un verrouillage partiel d'un groupe.
      const idsToLock = new Set();
      entries.forEach((en) => {
        if (en.data.groupId) groupMembers(en.data.groupId).forEach(id => idsToLock.add(id));
        else idsToLock.add(en.data.id);
      });
      const beforeLock = [...idsToLock].map(id => ({ id, before: elements.get(id)?.data.locked || false }));
      idsToLock.forEach((id) => {
        const en = elements.get(id);
        if (!en) return;
        en.data.locked = true;
        applyLockedState(en);
        Api.updateElement(id, { locked: true }).catch(() => {});
      });
      recordMultiFieldUndo(beforeLock, 'locked');
      clearMultiSelection();
      return;
    }
    repositionMultiToolbar();
  }

  // ---------- Verrouillage ----------

  // Pastille discrète (pas de fond plein) : juste assez visible pour repérer un élément verrouillé
  // sans attirer l'œil ; l'action se passe dans le toolbar au clic (cf buildLockedToolbarHtml).
  function applyLockedState(entry) {
    entry.el.classList.toggle('is-locked', !!entry.data.locked);
    let badge = entry.el.querySelector('.lock-badge');
    if (entry.data.locked && !badge) {
      badge = document.createElement('div');
      badge.className = 'lock-badge';
      badge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
      entry.el.appendChild(badge);
    } else if (!entry.data.locked && badge) {
      badge.remove();
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Petites pastilles accrochées sous l'élément (nombre de votes + nombre de commentaires), toujours
  // visibles — pas seulement à la sélection — pour rester repérables au premier coup d'œil, comme sur
  // Miro/Figma. Toutes deux en icône SVG (pas d'émoji) pour redimensionner proprement au zoom, comme
  // le reste de l'UI. La pastille commentaire ouvre le drawer au clic ; celle des votes montre la
  // liste des votants au survol (title natif).
  function updateElementBadges(entry) {
    const votes = entry.data.votes || [];
    const commentCount = entry.data.commentCount || 0;
    let badges = entry.el.querySelector('.element-badges');
    if (!votes.length && !commentCount) { if (badges) badges.remove(); return; }
    if (!badges) {
      badges = document.createElement('div');
      badges.className = 'element-badges';
      badges.addEventListener('pointerdown', e => e.stopPropagation());
      badges.addEventListener('click', (e) => {
        if (e.target.closest('[data-badge-action="comment"]')) openCommentDrawer(entry);
        if (e.target.closest('[data-badge-action="vote"]')) toggleVote(entry);
      });
      entry.el.appendChild(badges);
    }
    const voted = votes.includes(myName);
    const voteChip = votes.length
      ? `<span class="element-badge-chip element-badge-chip-clickable" data-badge-action="vote" title="${voted ? 'Retirer mon vote' : 'Voter'} — ont voté : ${escapeHtml(votes.join(', '))}">${iconVote()} ${votes.length}</span>`
      : '';
    const commentChip = commentCount
      ? `<span class="element-badge-chip element-badge-chip-clickable" data-badge-action="comment" title="Voir les commentaires">${iconComment()} ${commentCount}</span>`
      : '';
    badges.innerHTML = voteChip + commentChip;
  }

  function wireUnlockButton(entry) {
    const btn = toolbarEl.querySelector('.unlock-hold-btn');
    if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      startUnlockHold(entry, btn);
    });
  }

  // Le remplissage se fait DANS le bouton du toolbar (comme Miro), mais l'appui qui le déclenche peut
  // venir d'ailleurs (cf. `cancelEl`) : appuyer longtemps directement sur l'élément verrouillé marche
  // aussi (cf. wireBodyDrag), pas seulement sur ce bouton — plus besoin de viser précisément le bouton
  // une fois l'élément sélectionné. `cancelEl` (l'élément dont on écoute le survol/relâchement pour
  // annuler l'appui) vaut le bouton lui-même par défaut, ou l'élément quand l'appui vient de lui.
  function startUnlockHold(entry, btn, cancelEl = btn) {
    const fill = btn.querySelector('.unlock-hold-fill');
    const startTime = Date.now();
    let done = false;
    let raf = null;

    function cleanup() {
      done = true;
      if (raf) cancelAnimationFrame(raf);
      if (fill) fill.style.width = '0%';
      window.removeEventListener('pointerup', onUp);
      cancelEl.removeEventListener('pointerleave', onLeave);
    }
    function onUp() { cleanup(); }
    function onLeave() { cleanup(); }
    function tick() {
      if (done) return;
      const elapsed = Date.now() - startTime;
      if (fill) fill.style.width = `${Math.min(100, (elapsed / UNLOCK_HOLD_MS) * 100)}%`;
      if (elapsed >= UNLOCK_HOLD_MS) {
        cleanup();
        // Déverrouille tout le groupe d'un coup (symétrique du verrouillage) — jamais un seul membre.
        // Une frame seule (pas groupée) ne déverrouille qu'elle-même, comme au verrouillage.
        const ids = entry.data.groupId ? groupMembers(entry.data.groupId) : [entry.data.id];
        const before = ids.map(id => ({ id, before: elements.get(id)?.data.locked || false }));
        ids.forEach((id) => {
          const en = elements.get(id);
          if (!en) return;
          en.data.locked = false;
          applyLockedState(en);
          Api.updateElement(id, { locked: false }).catch(() => {});
        });
        recordMultiFieldUndo(before, 'locked');
        if (selectedElementId === entry.data.id) showToolbarFor(entry);
        return;
      }
      raf = requestAnimationFrame(tick);
    }
    window.addEventListener('pointerup', onUp);
    cancelEl.addEventListener('pointerleave', onLeave);
    raf = requestAnimationFrame(tick);
  }

  // ---------- Rendu des éléments ----------

  function renderElement(data) {
    const el = document.createElement('div');
    el.className = 'element';
    el.dataset.id = data.id;
    el.dataset.type = data.type;
    el.style.left = `${data.x}px`;
    el.style.top = `${data.y}px`;
    el.style.width = `${data.width}px`;
    el.style.height = `${data.height}px`;
    el.style.zIndex = data.zIndex;

    let textEl = null;
    const anchorsHtml = BOX_TYPES.includes(data.type)
      ? `<div class="connector-anchor" data-side="top"></div><div class="connector-anchor" data-side="right"></div><div class="connector-anchor" data-side="bottom"></div><div class="connector-anchor" data-side="left"></div>`
      : '';

    if (data.type === 'note') {
      // `title` réutilisé pour le nom de l'auteur (cf. ELEMENT_DEFAULTS.stack côté serveur) — jamais
      // posé par un post-it créé normalement, seulement par un post-it détaché d'une pile dont
      // "Afficher l'auteur" est actif ; jamais modifiable après coup, pas besoin de le suivre dans
      // applyRemoteUpdate.
      el.style.background = data.color;
      el.innerHTML = `
        <div class="element-text-frame">
          <textarea class="element-text" placeholder="Écris ici…" maxlength="4000"></textarea>
        </div>
        ${data.title ? `<div class="note-author">${escapeHtml(data.title)}</div>` : ''}
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
      textEl = el.querySelector('.element-text');
      textEl.value = data.text || '';
      applyNoteColorContrast(el, textEl, data.color);
    } else if (data.type === 'line') {
      el.style.transform = `rotate(${data.rotation}deg)`;
      el.innerHTML = `<div class="element-line-handle"></div>`;
    } else if (data.type === 'connector') {
      // Rendu en SVG (pas un div tourné comme "line") : seul moyen d'avoir une courbe, une pointe de
      // flèche posée exactement au bord (marker SVG) et une zone de clic plus large que le trait
      // visible (cf. renderConnectorGeometry/applyLineStyle/applyConnectorCaps plus bas).
      el.innerHTML = `
        <svg class="connector-svg">
          <defs>
            <marker class="connector-marker connector-marker-start" id="conn-marker-start-${data.id}" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><polygon points="0,0 0,0 0,0"/></marker>
            <marker class="connector-marker connector-marker-end" id="conn-marker-end-${data.id}" markerUnits="userSpaceOnUse" orient="auto"><polygon points="0,0 0,0 0,0"/></marker>
          </defs>
          <path class="connector-hit"></path>
          <path class="connector-line" fill="none"></path>
          <path class="connector-cap-start" fill="none"></path>
          <path class="connector-cap-end" fill="none"></path>
        </svg>
        <div class="connector-handles"></div>
        <div class="connector-label is-hidden">
          <textarea class="connector-label-text" rows="1" maxlength="200" placeholder="Texte…"></textarea>
        </div>
      `;
    } else if (data.type === 'text') {
      el.innerHTML = `
        <textarea class="element-text" placeholder="Texte…" maxlength="4000"></textarea>
        ${anchorsHtml}
      `;
      textEl = el.querySelector('.element-text');
      textEl.value = data.text || '';
    } else if (data.type === 'image') {
      el.innerHTML = `
        <img class="element-image-img" src="${data.imageData || ''}" draggable="false" alt="">
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
    } else if (data.type === 'rectangle') {
      // Losange (`tag: 'diamond'`, cf. placeNewElement) : dessiné en SVG (polygon), pas en CSS box/
      // border classique — un simple clip-path ne dessinerait le contour QUE sur les bords de la boîte
      // englobante, pas le long des quatre pointes (cf. applyRectangleStyle pour le remplissage/contour).
      const diamondShapeHtml = data.tag === 'diamond'
        ? '<svg class="rectangle-diamond-shape" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="50,0 100,50 50,100 0,50" vector-effect="non-scaling-stroke"/></svg>'
        : '';
      el.innerHTML = `
        ${diamondShapeHtml}
        <div class="element-text-frame">
          <textarea class="element-text element-text-rect" placeholder="" maxlength="4000"></textarea>
        </div>
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
      textEl = el.querySelector('.element-text');
      textEl.value = data.text || '';
    } else if (data.type === 'frame') {
      // Le titre est un simple champ mono-ligne épinglé en haut à gauche, pas une zone de texte qui
      // remplit toute la boîte.
      el.innerHTML = `
        <textarea class="frame-title" placeholder="Titre…" maxlength="200" rows="1"></textarea>
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
      textEl = el.querySelector('.frame-title');
      textEl.value = data.text || '';
    } else if (data.type === 'instruction') {
      // Trois champs indépendants (numéro/titre/description), contrairement à tous les autres types
      // qui n'en ont qu'un seul (cf. wireMultiFieldEditing, qui généralise wireTextEditing pour ce cas).
      el.style.background = data.color;
      el.innerHTML = `
        <div class="instruction-number-wrap"><textarea class="instruction-number block-field" maxlength="4" rows="1"></textarea></div>
        <textarea class="instruction-title block-field" placeholder="Titre…" maxlength="200"></textarea>
        <textarea class="instruction-desc block-field" placeholder="Description…" maxlength="4000"></textarea>
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
      el.querySelector('.instruction-number').value = data.number || '';
      el.querySelector('.instruction-title').value = data.title || '';
      el.querySelector('.instruction-desc').value = data.text || '';
    } else if (data.type === 'tip') {
      // Le corps est un texte riche (contenteditable, pas un textarea) : seul champ à supporter du
      // gras/italique/lien sur une PORTION de texte (cf. le mini-toolbar de sélection plus bas).
      el.style.background = data.color;
      el.innerHTML = `
        <textarea class="tip-tag block-field" placeholder="Tips" maxlength="40" rows="1"></textarea>
        <textarea class="tip-title block-field" placeholder="Titre…" maxlength="200"></textarea>
        <div class="tip-rich block-field" contenteditable="true" data-placeholder="Texte…"></div>
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
      el.querySelector('.tip-tag').value = data.tag || '';
      el.querySelector('.tip-title').value = data.title || '';
      el.querySelector('.tip-rich').innerHTML = data.text || '';
    } else if (data.type === 'webpage') {
      // Wireframe fixe (illustratif, cf. WEBPAGE_INNER) à gauche, jamais édité — seuls titre et
      // description (texte riche, comme "tips") le sont, à droite.
      el.style.background = data.color;
      el.innerHTML = `
        <div class="webpage-wireframe">${wpSvg(data.tag || 'accueil', '100%', '100%')}</div>
        <div class="webpage-content">
          <textarea class="webpage-title block-field" placeholder="Titre…" maxlength="200" rows="1"></textarea>
          <div class="webpage-desc block-field" contenteditable="true" data-placeholder="Description…"></div>
        </div>
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
      el.querySelector('.webpage-title').value = data.title || '';
      el.querySelector('.webpage-desc').innerHTML = data.text || '';
    } else if (data.type === 'stack') {
      // Le visuel (pile de post-its) est purement décoratif, jamais édité — seul le titre l'est,
      // comme celui d'une frame (cf. wireTextEditing, pas wireMultiFieldEditing : un seul champ).
      el.innerHTML = `
        <textarea class="stack-title" placeholder="Titre…" maxlength="200" rows="1"></textarea>
        <div class="stack-visual">
          <div class="stack-postit-back"></div>
          <div class="stack-postit-mid"></div>
          <div class="stack-postit-visual"><div class="stack-postit-fold"></div></div>
        </div>
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
      textEl = el.querySelector('.stack-title');
      textEl.value = data.text || '';
    } else if (data.type === 'arbo') {
      // Tout l'arbre (titre/texte riche de chaque nœud, imbrication) est reconstruit dans ce seul
      // conteneur par renderArboBody, une fois `entry` posé plus bas (cf. entry.arboTree) — pas de
      // champ fixe ici, contrairement aux autres types multi-champs.
      el.innerHTML = `<div class="arbo-root"></div><div class="element-resize-handle"></div>${anchorsHtml}`;
    }

    layerEl.appendChild(el);
    const entry = { data, el, textEl };
    elements.set(data.id, entry);

    if (data.type === 'text') { applyTextStyle(entry); applyElementBackground(entry); applyTextAutoSize(entry); }
    if (data.type === 'line' || data.type === 'connector') applyLineStyle(entry);
    if (data.type === 'connector') applyConnectorCaps(entry);
    if (data.type === 'image') applyImageFilters(entry);
    if (data.type === 'rectangle') { applyRectangleStyle(entry); applyRectangleTextStyle(entry); autoGrowRectangleTextarea(entry); }
    if (data.type === 'frame') { applyRectangleStyle(entry); applyFrameTitleStyle(entry); }
    if (data.type === 'note') { applyNoteTextStyle(entry); syncNoteTextareaHeight(entry); }
    if (data.type === 'instruction') {
      entry.numberEl = el.querySelector('.instruction-number');
      entry.titleEl = el.querySelector('.instruction-title');
      entry.descEl = el.querySelector('.instruction-desc');
      autoGrowInstructionBlock(entry);
    }
    if (data.type === 'tip') {
      entry.tagEl = el.querySelector('.tip-tag');
      entry.titleEl = el.querySelector('.tip-title');
      entry.richEl = el.querySelector('.tip-rich');
      autoWidthTag(entry.tagEl);
      autoGrowTipBlock(entry);
    }
    if (data.type === 'webpage') {
      entry.titleEl = el.querySelector('.webpage-title');
      entry.richEl = el.querySelector('.webpage-desc');
      autoGrowWebpageBlock(entry);
    }
    if (data.type === 'stack') applyStackStyle(entry);
    if (data.type === 'arbo') {
      let tree;
      try { tree = JSON.parse(data.text); } catch (_) { tree = null; }
      entry.arboTree = (tree && typeof tree === 'object' && tree.id) ? tree : newArboNode();
      renderArboBody(entry);
    }
    applyLockedState(entry);
    updateElementBadges(entry);

    if (data.type === 'connector') { registerConnector(entry); renderConnectorGeometry(entry); }

    wireElementInteractions(entry);
    return entry;
  }

  function ensureRendered(data) {
    return elements.get(data.id) || renderElement(data);
  }

  function removeElementLocal(id) {
    const entry = elements.get(id);
    if (!entry) return;
    unregisterConnector(entry);
    entry.el.remove();
    elements.delete(id);
    // Sans ça, supprimer l'élément actuellement sélectionné laissait son toolbar affiché, flottant
    // au-dessus du vide, jusqu'à la prochaine sélection.
    if (selectedElementId === id) { selectedElementId = null; hideToolbar(); }
    if (editingElementId === id) editingElementId = null;
    multiSelectedIds.delete(id);
  }

  function applyElementColor(entry) {
    // Un lien force sa propre couleur (cf. applyTextStyle) : passer par elle plutôt que d'écrire
    // directement la couleur choisie évite d'écraser ce forçage quand un lien est présent.
    if (entry.data.type === 'text') applyTextStyle(entry);
    else if (entry.data.type === 'line' || entry.data.type === 'connector') applyLineStyle(entry);
    else if (entry.data.type === 'rectangle' || entry.data.type === 'frame') applyRectangleStyle(entry);
    else if (entry.data.type === 'stack') applyStackStyle(entry);
    else {
      entry.el.style.background = entry.data.color;
      if (entry.data.type === 'note') applyNoteColorContrast(entry.el, entry.textEl, entry.data.color);
    }
  }

  // Style du texte libre : taille, gras/italique/souligné/barré, couleur, alignement horizontal, et —
  // s'il a un lien (cf. applyRectangleTextStyle pour le même principe côté rectangle) — le bleu
  // souligné habituel des liens plutôt que la mise en forme choisie. Pas d'alignement vertical : sa
  // boîte épouse toujours exactement son contenu (cf. applyTextAutoSize), ça n'y aurait aucun effet.
  function applyTextStyle(entry) {
    const t = entry.textEl;
    if (!t) return;
    const d = entry.data;
    const hasLink = !!d.link;
    t.style.fontWeight = d.bold ? '700' : '400';
    t.style.fontStyle = d.italic ? 'italic' : 'normal';
    const decorations = [];
    if (d.underline || hasLink) decorations.push('underline');
    if (d.strikethrough) decorations.push('line-through');
    t.style.textDecoration = decorations.join(' ') || 'none';
    t.style.fontSize = `${d.fontSize || 15}px`;
    t.style.color = hasLink ? LINK_COLOR : d.color;
    t.style.textAlign = d.textAlign || 'center';
    entry.el.classList.toggle('has-link', hasLink);
  }

  function applyElementBackground(entry) {
    if (entry.data.type !== 'text') return;
    entry.el.style.background = entry.data.backgroundColor || 'transparent';
    entry.el.style.borderRadius = entry.data.backgroundColor ? '4px' : '0';
  }

  // Aussi utilisée par les frames (même fond + contour qu'un rectangle) — une frame n'expose juste
  // pas de contrôle de style de trait dans son toolbar, donc son contour reste continu.
  function applyRectangleStyle(entry) {
    if (entry.data.type !== 'rectangle' && entry.data.type !== 'frame') return;
    const style = entry.data.lineStyle === 'dashed' ? 'dashed' : 'solid';
    if (entry.data.type === 'rectangle' && entry.data.tag === 'diamond') {
      // Le fond/contour se posent sur le <svg> (cf. renderElement), pas sur la boîte englobante elle-
      // même : elle reste invisible, seul le polygone est visible.
      entry.el.style.background = 'none';
      entry.el.style.border = 'none';
      entry.el.style.borderRadius = '0';
      const shape = entry.el.querySelector('.rectangle-diamond-shape polygon');
      if (shape) {
        shape.style.fill = entry.data.color;
        shape.style.stroke = entry.data.strokeWidth ? (entry.data.strokeColor || '#1c1c28') : 'none';
        shape.style.strokeWidth = entry.data.strokeWidth || 0;
        shape.style.strokeDasharray = entry.data.lineStyle === 'dashed' ? '6 4' : 'none';
      }
      return;
    }
    entry.el.style.background = entry.data.color;
    entry.el.style.border = entry.data.strokeWidth ? `${entry.data.strokeWidth}px ${style} ${entry.data.strokeColor || '#1c1c28'}` : 'none';
    const r = entry.data.radius || 0;
    entry.el.style.borderRadius = r >= 999 ? '999px' : `${r}px`;
  }

  // Seuls les deux post-its du dessus (visible + celui juste dessous) portent la couleur choisie —
  // le plus bas reste une simple ombre neutre (cf. .stack-postit-back dans board.css), comme dans
  // l'original Miro.
  function applyStackStyle(entry) {
    if (entry.data.type !== 'stack') return;
    const visual = entry.el.querySelector('.stack-postit-visual');
    const mid = entry.el.querySelector('.stack-postit-mid');
    if (entry.data.color === 'random') {
      const [top, under] = ensureStackRandomPreview(entry);
      if (visual) visual.style.background = top;
      if (mid) mid.style.background = under;
    } else {
      entry._stackColors = null;
      if (visual) visual.style.background = entry.data.color;
      if (mid) mid.style.background = entry.data.color;
    }
  }

  function applyFrameTitleStyle(entry) {
    if (entry.data.type !== 'frame' || !entry.textEl) return;
    // Même taille par défaut que le titre des blocs consigne/tips (cf. .instruction-title/.tip-title
    // dans board.css), pour rester cohérent visuellement entre les trois.
    const size = entry.data.fontSize || 15;
    entry.textEl.style.color = entry.data.titleColor || '#4a463c';
    entry.textEl.style.fontSize = `${size}px`;
    // La hauteur/interligne du titre était fixée (24px) dans board.css, calée sur la taille de police
    // par défaut : au-delà, le bas du texte se retrouvait tronqué par cette hauteur trop courte.
    // On les calcule plutôt ici, proportionnels à la taille choisie — un peu plus généreux (1.5 plutôt
    // que 1.3) pour qu'il respire davantage, comme demandé (cf. .frame-title dans board.css pour son
    // padding gauche/haut, sur le même principe).
    const lineHeight = Math.round(size * 1.5);
    entry.textEl.style.lineHeight = `${lineHeight}px`;
    entry.textEl.style.height = `${lineHeight}px`;
  }

  // Un textarea ne peut pas centrer verticalement son propre contenu : on le laisse plutôt grandir à
  // la hauteur exacte de son texte (comme un textarea auto-expansif classique), et c'est le cadre
  // parent (.element-text-frame, en flex) qui centre cette boîte plus courte dans le rectangle.
  function autoGrowRectangleTextarea(entry) {
    if (entry.data.type !== 'rectangle' || !entry.textEl) return;
    const t = entry.textEl;
    t.style.height = '0px';
    t.style.height = `${t.scrollHeight}px`;
  }

  // Style du texte d'un rectangle : taille, gras/italique/souligné/barré (même principe que le type
  // "texte" libre, cf. applyTextStyle), couleur, alignement horizontal/vertical, et — s'il a un lien
  // (cf. wireRectangleLink) — le bleu souligné habituel des liens plutôt que la mise en forme choisie,
  // pour qu'on le reconnaisse comme cliquable au premier coup d'œil.
  function applyRectangleTextStyle(entry) {
    if (entry.data.type !== 'rectangle' || !entry.textEl) return;
    const d = entry.data;
    const t = entry.textEl;
    const hasLink = !!d.link;
    t.style.fontSize = `${d.fontSize || 15}px`;
    t.style.fontWeight = d.bold ? '700' : '400';
    t.style.fontStyle = d.italic ? 'italic' : 'normal';
    const decorations = [];
    if (d.underline || hasLink) decorations.push('underline');
    if (d.strikethrough) decorations.push('line-through');
    t.style.textDecoration = decorations.join(' ') || 'none';
    t.style.color = hasLink ? LINK_COLOR : (d.textColor || 'rgba(0,0,0,0.82)');
    t.style.textAlign = d.textAlign || 'left';
    const frame = entry.el.querySelector('.element-text-frame');
    if (frame) {
      frame.style.justifyContent = { left: 'flex-start', center: 'center', right: 'flex-end' }[d.textAlign || 'left'];
      frame.style.alignItems = { top: 'flex-start', center: 'center', bottom: 'flex-end' }[d.textValign || 'center'];
    }
    entry.el.classList.toggle('has-link', hasLink);
  }

  // Un post-it très sombre (typiquement noir) est illisible avec le texte foncé par défaut
  // (cf. .element-text dans board.css) : on bascule en blanc dans ce cas, quelle que soit la façon
  // dont cette couleur a été choisie (pose initiale, sélecteur, pile de post-its...). Formule de
  // luminance perçue usuelle (WCAG-like) — un simple seuil suffit pour ce choix binaire clair/foncé,
  // pas besoin d'un vrai calcul de contraste.
  function isDarkColor(hex) {
    if (!hex || hex[0] !== '#') return false;
    const full = hex.length === 4 ? '#' + [...hex.slice(1)].map(c => c + c).join('') : hex;
    const r = parseInt(full.slice(1, 3), 16), g = parseInt(full.slice(3, 5), 16), b = parseInt(full.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 90;
  }
  function applyNoteColorContrast(el, textEl, color) {
    const dark = isDarkColor(color);
    if (textEl) textEl.style.color = dark ? '#fff' : '';
    const author = el.querySelector('.note-author');
    if (author) author.style.color = dark ? 'rgba(255,255,255,0.6)' : '';
  }

  // Style du texte d'un post-it : taille, gras/italique/souligné/barré (même principe que "texte"/
  // "rectangle") et alignement horizontal/vertical — la couleur du texte, elle, est gérée à part
  // (cf. applyNoteColorContrast), pas ici.
  function applyNoteTextStyle(entry) {
    if (entry.data.type !== 'note' || !entry.textEl) return;
    const d = entry.data;
    const t = entry.textEl;
    t.style.fontSize = `${d.fontSize || 14}px`;
    t.style.fontWeight = d.bold ? '700' : '400';
    t.style.fontStyle = d.italic ? 'italic' : 'normal';
    const decorations = [];
    if (d.underline) decorations.push('underline');
    if (d.strikethrough) decorations.push('line-through');
    t.style.textDecoration = decorations.join(' ') || 'none';
    t.style.textAlign = d.textAlign || 'left';
    const frame = entry.el.querySelector('.element-text-frame');
    if (frame) frame.style.alignItems = { top: 'flex-start', center: 'center', bottom: 'flex-end' }[d.textValign || 'center'];
  }

  // Un textarea ne centre pas nativement son contenu verticalement : comme pour le rectangle
  // (autoGrowRectangleTextarea), la zone de texte grandit à la hauteur exacte de son contenu, et c'est
  // le cadre parent (.element-text-frame, en flex) qui centre/aligne cette boîte plus courte dans le
  // post-it (cf. applyNoteTextStyle) — pour tout affichage qui ne vient pas d'une frappe locale (rendu
  // initial, mise à jour distante, redimensionnement manuel via la poignée).
  function syncNoteTextareaHeight(entry) {
    if (entry.data.type !== 'note' || !entry.textEl) return;
    const t = entry.textEl;
    t.style.height = '0px';
    t.style.height = `${t.scrollHeight}px`;
  }

  // Au clavier : le post-it grandit pour suivre son texte, mais ne rétrécit jamais tout seul (un
  // redimensionnement manuel plus petit reste possible tant que le texte y tient, cf. wireCornerResize).
  function autoGrowNoteOnInput(entry) {
    if (entry.data.type !== 'note' || !entry.textEl) return;
    syncNoteTextareaHeight(entry);
    const needed = entry.textEl.scrollHeight + 20;
    if (needed > entry.data.height) {
      entry.data.height = needed;
      entry.el.style.height = `${needed}px`;
    }
  }

  // Un textarea non plus auto-expansif que la description/le titre d'un bloc consigne/tips : reset à
  // 0 pour mesurer le scrollHeight réel du contenu, comme autoGrowRectangleTextarea.
  function autoGrowTextareaField(t) {
    if (!t) return;
    t.style.height = '0px';
    t.style.height = `${t.scrollHeight}px`;
  }

  // Blocs multi-champs (consigne, tips) : la largeur reste réglée à la main (poignée de
  // redimensionnement, cf. wireCornerResize), seule la hauteur grandit pour suivre le contenu. Mesurée
  // en repassant temporairement le bloc en hauteur "auto" (sa mise en page flex-column, posée en CSS,
  // fait le calcul tout seul) plutôt qu'en ajoutant à la main la hauteur de chaque champ — jamais en
  // dessous de la hauteur actuelle (un redimensionnement manuel plus petit reste possible tant que le
  // contenu y tient).
  function autoGrowFlexBlock(entry) {
    const el = entry.el;
    const prevHeight = el.style.height;
    el.style.height = 'auto';
    const natural = el.scrollHeight;
    if (natural > entry.data.height) {
      entry.data.height = natural;
      el.style.height = `${natural}px`;
    } else {
      el.style.height = prevHeight;
    }
  }

  function autoGrowInstructionBlock(entry) {
    if (entry.data.type !== 'instruction' || !entry.titleEl || !entry.descEl) return;
    autoGrowTextareaField(entry.titleEl);
    autoGrowTextareaField(entry.descEl);
    autoGrowFlexBlock(entry);
  }

  // Le texte riche (contenteditable) grandit tout seul avec son contenu comme n'importe quel bloc —
  // contrairement à un textarea, pas besoin de lui recalculer sa hauteur à la main.
  function autoGrowTipBlock(entry) {
    if (entry.data.type !== 'tip' || !entry.titleEl) return;
    autoGrowTextareaField(entry.titleEl);
    autoGrowFlexBlock(entry);
  }

  // Le wireframe (à gauche) garde toujours sa taille fixe (cf. .webpage-wireframe) : seule la colonne
  // titre/description (à droite) grandit avec son contenu, et donc la hauteur globale du bloc avec
  // elle si elle finit par dépasser la hauteur du wireframe — même mesure générique qu'ailleurs
  // (autoGrowFlexBlock), la mise en page flex-ROW (au lieu de column pour consigne/tips) ne change
  // rien à ce calcul : la hauteur naturelle du bloc suit de toute façon son enfant le plus haut.
  function autoGrowWebpageBlock(entry) {
    if (entry.data.type !== 'webpage' || !entry.titleEl) return;
    autoGrowTextareaField(entry.titleEl);
    autoGrowFlexBlock(entry);
  }

  // Contrairement à autoGrowFlexBlock (consigne/tips : grandit seulement, jamais en dessous de la
  // hauteur actuelle), une arborescence doit aussi RÉTRÉCIR quand un nœud est supprimé — toujours
  // calée exactement sur son contenu, dans les deux sens.
  function autoFitArboHeight(entry) {
    if (entry.data.type !== 'arbo') return;
    const el = entry.el;
    el.style.height = 'auto';
    const natural = Math.max(MIN_H, el.scrollHeight);
    entry.data.height = natural;
    el.style.height = `${natural}px`;
  }

  function renderArboNodeHtml(node, depth) {
    const canAddChild = depth < ARBO_MAX_DEPTH;
    const canDelete = depth > 0;
    const childrenHtml = node.children.map(c => renderArboNodeHtml(c, depth + 1)).join('');
    return `
      <div class="arbo-node" data-node-id="${node.id}">
        <div class="arbo-node-box" data-depth="${depth}">
          <textarea class="arbo-node-title block-field" placeholder="Titre…" maxlength="200" rows="1"></textarea>
          <div class="arbo-node-body block-field" contenteditable="true" data-placeholder="Texte…"></div>
          <div class="arbo-node-actions">
            ${canAddChild ? `<button type="button" class="arbo-add-btn" title="Ajouter un sous-élément">${iconPlus()}</button>` : ''}
            ${canDelete ? `<button type="button" class="arbo-delete-btn" title="Supprimer">${iconTrash()}</button>` : ''}
          </div>
        </div>
        ${childrenHtml ? `<div class="arbo-children">${childrenHtml}</div>` : ''}
      </div>
    `;
  }

  // Reconstruit tout l'arbre depuis entry.arboTree — appelé au rendu initial, après un ajout/
  // suppression de nœud (changement de STRUCTURE) et sur écho distant (cf. applyRemoteUpdate) ; jamais
  // à chaque frappe dans un champ existant (cf. wireArboTree, qui mute le texte en place pour ne pas
  // perdre le focus/curseur en cours).
  function renderArboBody(entry) {
    const root = entry.el.querySelector('.arbo-root');
    if (!root) return;
    root.innerHTML = renderArboNodeHtml(entry.arboTree, 0);
    root.querySelectorAll('.arbo-node').forEach((nodeEl) => {
      const node = findArboNode(entry.arboTree, nodeEl.dataset.nodeId);
      if (!node) return;
      const titleEl = nodeEl.querySelector(':scope > .arbo-node-box > .arbo-node-title');
      const bodyEl = nodeEl.querySelector(':scope > .arbo-node-box > .arbo-node-body');
      titleEl.value = node.title || '';
      autoGrowTextareaField(titleEl);
      bodyEl.innerHTML = node.body || '';
    });
    autoFitArboHeight(entry);
  }

  // Le tag ("Tips" par défaut) épouse la largeur de son texte plutôt que de remplir tout le bloc :
  // même technique de mesure que autoGrowTextareaField, sur l'axe horizontal (border-box, cf. board.css,
  // pour que la largeur posée corresponde exactement au scrollWidth mesuré, padding compris).
  function autoWidthTag(t) {
    if (!t) return;
    t.style.width = '0px';
    // scrollWidth d'un <textarea> mono-ligne omet son padding-right (quirk connu, contrairement au
    // padding-left qu'il inclut) : sans ce correctif, le fond du tag s'arrête juste après la dernière
    // lettre au lieu de respecter le même espace que côté gauche.
    const rightPad = parseFloat(getComputedStyle(t).paddingRight) || 0;
    t.style.width = `${t.scrollWidth + rightPad}px`;
  }

  // Trait libre ("line") : continu = simple aplat de couleur ; pointillés = dégradé répété le long de
  // la longueur (l'élément est une barre pivotée, donc "vers la droite" correspond toujours à sa
  // longueur). Connecteur : le trait est un <path> SVG (cf. renderConnectorGeometry), pas le fond du
  // div — on pose couleur/épaisseur/pointillés comme attributs du path plutôt que comme background.
  function applyLineStyle(entry) {
    if (entry.data.type !== 'line' && entry.data.type !== 'connector') return;
    const { color, height } = entry.data;
    if (entry.data.type === 'line') {
      if (entry.data.lineStyle === 'dashed') {
        const dash = Math.max(6, height * 2.2);
        const gap = Math.max(5, height * 1.6);
        entry.el.style.background = `repeating-linear-gradient(to right, ${color} 0, ${color} ${dash}px, transparent ${dash}px, transparent ${dash + gap}px)`;
      } else {
        entry.el.style.background = color;
      }
      return;
    }
    const linePath = entry.el.querySelector('.connector-line');
    if (!linePath) return;
    linePath.setAttribute('stroke', color);
    linePath.setAttribute('stroke-width', height);
    // Le libellé prend la couleur du trait (pas de couleur de texte à part).
    const labelText = entry.el.querySelector('.connector-label-text');
    if (labelText) labelText.style.color = color;
    if (entry.data.lineStyle === 'dashed') {
      const dash = Math.max(6, height * 2.2);
      const gap = Math.max(5, height * 1.6);
      linePath.setAttribute('stroke-dasharray', `${dash} ${gap}`);
    } else {
      linePath.removeAttribute('stroke-dasharray');
    }
    // Les petits bouts "sous la pointe" (cf. applyConnectorCaps/renderConnectorGeometry) ne servent
    // qu'à porter le marker : leur trait est INVISIBLE. Visible, son extrémité rectangulaire (aussi large
    // que le trait) dépasserait de la pointe triangulaire, qui s'amincit jusqu'à un point — c'est
    // justement ce qui masquait le bout de la pointe sur un trait épais.
    ['start', 'end'].forEach((which) => {
      const cap = entry.el.querySelector(`.connector-cap-${which}`);
      if (cap) { cap.setAttribute('stroke', 'transparent'); cap.setAttribute('stroke-width', height); }
    });
  }

  // Dimensions de la pointe de flèche : proportionnelles à l'épaisseur du trait SANS plafond (un
  // plafond fixe la rendait à peine plus large qu'un trait épais — le bout n'était plus lisible) ; la
  // base est nettement plus large que le trait, comme sur Miro, et reste lisible même en trait fin.
  function connectorArrowDims(thickness) {
    const t = thickness || 2;
    return { len: Math.max(10, t * 3), width: Math.max(10, t * 3.4) };
  }

  // Pointes de flèche : des <marker> SVG (pas un positionnement pixel manuel) — leur refX pose la
  // pointe exactement sur le dernier point du path auquel ils sont attachés.
  //
  // Attachés à un petit bout de tracé DÉDIÉ (.connector-cap-start/-end), jamais à .connector-line :
  // .connector-line est RACCOURCI (cf. renderConnectorGeometry) pour laisser la place à la pointe, et
  // son extrémité coupée ne correspond donc plus au vrai point d'ancrage une fois le trait courbé — un
  // marker qui y serait attaché pointerait dans la tangente du trait coupé, pas celle du trait réel à
  // CET endroit (lequel continue de courber après la coupe), créant un décrochage anguleux visible dès
  // que le trait est épais et/ou pointillé (l'épaisseur du trait ne faisant qu'accentuer l'écart).
  // Le petit bout dédié, lui, est tracé avec la géométrie RÉELLE jusqu'au vrai point d'ancrage : son
  // marker tombe donc toujours exactement au bon endroit, dans la bonne direction.
  function applyConnectorCaps(entry) {
    if (entry.data.type !== 'connector') return;
    const { len, width: w } = connectorArrowDims(entry.data.height);
    [['start', entry.data.startCap], ['end', entry.data.endCap]].forEach(([which, cap]) => {
      const capPath = entry.el.querySelector(`.connector-cap-${which}`);
      const marker = entry.el.querySelector(`.connector-marker-${which}`);
      if (!marker) return;
      marker.setAttribute('markerWidth', len);
      marker.setAttribute('markerHeight', w);
      marker.setAttribute('refX', len);
      marker.setAttribute('refY', w / 2);
      const polygon = marker.querySelector('polygon');
      if (polygon) {
        polygon.setAttribute('points', `0,0 ${len},${w / 2} 0,${w}`);
        polygon.setAttribute('fill', entry.data.color);
      }
      if (!capPath) return;
      if (cap === 'arrow') capPath.setAttribute(`marker-${which}`, `url(#conn-marker-${which}-${entry.data.id})`);
      else capPath.removeAttribute(`marker-${which}`);
    });
  }

  function applyRemoteUpdate(data) {
    const entry = elements.get(data.id);
    if (!entry) { renderElement(data); return; }
    // Une requête DE CE CLIENT est encore en vol pour cet élément (cf. Api.isPending) : cet écho —
    // sa propre réponse arrivée en retard, ou la diffusion SSE qu'il déclenche (reçue par l'auteur
    // aussi) — peut porter un état plus vieux qu'un changement déjà affiché localement en attendant sa
    // propre confirmation (couleur, verrouillage, vote, groupe, position...). Contrairement à
    // isInteracting ci-dessous (qui ne protège que position/taille/pile pendant un glisser continu),
    // on ne sait pas ici QUEL champ est en jeu : on ignore donc l'écho en entier plutôt que de risquer
    // d'en laisser passer un pas protégé — la confirmation de la DERNIÈRE requête en vol pour cet
    // élément appliquera de toute façon l'état à jour à son tour.
    if (Api.isPending(data.id)) return;
    // Le PATCH élément (déplacement, couleur, etc.) ne renvoie pas les votes/commentaires — ce n'est
    // pas son rôle — donc on les préserve explicitement au lieu de les perdre en écrasant data.
    const prevVotes = entry.data.votes;
    const prevCommentCount = entry.data.commentCount;
    const prevImageData = entry.data.imageData;
    const prevWebpageTag = entry.data.tag;
    const isInteracting = entry.dragging || entry.resizing || entry.cropping;
    // Un écho distant (une réponse ou une diffusion en retard d'un AUTRE glisser encore en vol) ne
    // doit jamais écraser la position/taille/pile qu'un glisser LOCAL est en train de piloter, même
    // seulement dans les données (sans toucher au DOM, cf. le "return" plus bas) : sinon, au
    // relâchement, on lit entry.data.x/y pour construire le batch-move et on persiste par erreur
    // cette valeur périmée — l'élément "saute" à un ancien endroit après coup.
    const prevTransform = isInteracting
      ? { x: entry.data.x, y: entry.data.y, width: entry.data.width, height: entry.data.height, rotation: entry.data.rotation, zIndex: entry.data.zIndex }
      : null;
    entry.data = data;
    if (data.votes === undefined) entry.data.votes = prevVotes;
    if (data.commentCount === undefined) entry.data.commentCount = prevCommentCount;
    // La plupart des mises à jour (déplacement en lot, PATCH sans changement d'image) omettent
    // volontairement imageData pour rester légères — une image tient souvent plusieurs Mo en base64,
    // ce serait sinon renvoyé en entier à chaque simple déplacement. On garde alors la copie déjà
    // affichée plutôt que de la perdre.
    if (data.imageData === undefined) entry.data.imageData = prevImageData;
    if (prevTransform) Object.assign(entry.data, prevTransform);
    applyLockedState(entry);
    updateElementBadges(entry);
    if (isInteracting) return; // ne pas écraser une interaction locale en cours

    if (data.type === 'connector') {
      applyLineStyle(entry);
      applyConnectorCaps(entry);
      renderConnectorGeometry(entry);
      refreshToolbarIfSelected(entry);
      return entry;
    }

    entry.el.style.left = `${data.x}px`;
    entry.el.style.top = `${data.y}px`;
    entry.el.style.width = `${data.width}px`;
    entry.el.style.height = `${data.height}px`;
    entry.el.style.zIndex = data.zIndex;

    if (data.type === 'line') {
      entry.el.style.transform = `rotate(${data.rotation}deg)`;
      applyLineStyle(entry);
    } else if (data.type === 'note') {
      entry.el.style.background = data.color;
      applyNoteColorContrast(entry.el, entry.textEl, data.color);
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
      applyNoteTextStyle(entry);
      syncNoteTextareaHeight(entry);
    } else if (data.type === 'text') {
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
      applyTextStyle(entry);
      applyElementBackground(entry);
      applyTextAutoSize(entry);
    } else if (data.type === 'image') {
      // Réassigner le src (même identique) force le navigateur à redécoder l'image, souvent plusieurs
      // Mo en base64 — visible comme un flash "disparaît puis réapparaît" sur un simple déplacement.
      // Comparer entry.data.imageData (déjà restauré ci-dessus si absent de "data") et non data.imageData
      // directement : sinon une mise à jour qui l'omet volontairement (cf. plus haut) serait lue comme
      // "image effacée" et viderait le src pour de vrai.
      if (entry.data.imageData !== prevImageData) entry.el.querySelector('.element-image-img').src = entry.data.imageData || '';
      applyImageFilters(entry);
    } else if (data.type === 'rectangle') {
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
      applyRectangleStyle(entry);
      applyRectangleTextStyle(entry);
      autoGrowRectangleTextarea(entry);
    } else if (data.type === 'frame') {
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
      applyRectangleStyle(entry);
      applyFrameTitleStyle(entry);
    } else if (data.type === 'instruction') {
      entry.el.style.background = data.color;
      if (document.activeElement !== entry.numberEl) entry.numberEl.value = data.number || '';
      if (document.activeElement !== entry.titleEl) entry.titleEl.value = data.title || '';
      if (document.activeElement !== entry.descEl) entry.descEl.value = data.text || '';
      autoGrowInstructionBlock(entry);
    } else if (data.type === 'tip') {
      entry.el.style.background = data.color;
      if (document.activeElement !== entry.tagEl) { entry.tagEl.value = data.tag || ''; autoWidthTag(entry.tagEl); }
      if (document.activeElement !== entry.titleEl) entry.titleEl.value = data.title || '';
      if (document.activeElement !== entry.richEl) entry.richEl.innerHTML = data.text || '';
      autoGrowTipBlock(entry);
    } else if (data.type === 'webpage') {
      entry.el.style.background = data.color;
      if (data.tag !== prevWebpageTag) {
        const wireframeEl = entry.el.querySelector('.webpage-wireframe');
        if (wireframeEl) wireframeEl.innerHTML = wpSvg(data.tag || 'accueil', '100%', '100%');
      }
      if (document.activeElement !== entry.titleEl) entry.titleEl.value = data.title || '';
      if (document.activeElement !== entry.richEl) entry.richEl.innerHTML = data.text || '';
      autoGrowWebpageBlock(entry);
    } else if (data.type === 'stack') {
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
      applyStackStyle(entry);
    } else if (data.type === 'arbo') {
      // Toute la structure tient dans `text` (pas de champ par champ possible ici) : tant qu'on tape
      // QUELQUE PART dans cet élément, un écho (même d'un autre participant) est ignoré plutôt que de
      // reconstruire le DOM sous les doigts de qui édite — entry.arboTree (la copie de travail locale)
      // continue de faire foi jusqu'au prochain enregistrement, cf. saveArboTree.
      if (!entry.el.contains(document.activeElement)) {
        let tree;
        try { tree = JSON.parse(data.text); } catch (_) { tree = null; }
        entry.arboTree = (tree && typeof tree === 'object' && tree.id) ? tree : newArboNode();
        renderArboBody(entry);
      }
    }

    updateConnectorsFor(data.id);
    refreshToolbarIfSelected(entry);
    return entry;
  }

  // ---------- Connecteurs ----------

  function registerConnector(entry) {
    if (entry.data.type !== 'connector') return;
    [entry.data.fromElementId, entry.data.toElementId].forEach((elId) => {
      if (!elId) return;
      if (!connectorsByElementId.has(elId)) connectorsByElementId.set(elId, new Set());
      connectorsByElementId.get(elId).add(entry.data.id);
    });
  }

  function unregisterConnector(entry) {
    if (entry.data.type !== 'connector') return;
    [entry.data.fromElementId, entry.data.toElementId].forEach((elId) => {
      connectorsByElementId.get(elId)?.delete(entry.data.id);
    });
  }

  function updateConnectorsFor(elementId) {
    const ids = connectorsByElementId.get(elementId);
    if (!ids || !ids.size) return;
    ids.forEach((cid) => {
      const centry = elements.get(cid);
      if (centry) renderConnectorGeometry(centry);
    });
  }

  function connectorAnchorWorldPoint(elId, side) {
    const entry = elements.get(elId);
    if (!entry) return null;
    const d = entry.data;
    if (side === 'top') return { x: d.x + d.width / 2, y: d.y };
    if (side === 'bottom') return { x: d.x + d.width / 2, y: d.y + d.height };
    if (side === 'left') return { x: d.x, y: d.y + d.height / 2 };
    return { x: d.x + d.width, y: d.y + d.height / 2 };
  }

  // Points de passage d'un connecteur : stockés en JSON (coordonnées monde) dans `text`, colonne
  // générique jamais utilisée par ce type — même logique de réutilisation que `tag`/`title` ailleurs
  // dans ce projet (cf. plan). Absent/invalide → aucun point de passage (comportement d'avant).
  function parseConnectorWaypoints(text) {
    if (!text) return [];
    try {
      const arr = JSON.parse(text);
      return Array.isArray(arr) ? arr.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number') : [];
    } catch (_) { return []; }
  }

  // Décale tous les points de passage d'un connecteur (duplicata/collage) du même delta que les
  // éléments reliés — sans ça, la copie garde la courbe "d'origine" alors que ses ancres, elles, ont
  // bougé : la forme paraît décalée par rapport à ses propres extrémités.
  function offsetConnectorWaypoints(text, dx, dy) {
    const wps = parseConnectorWaypoints(text);
    if (!wps.length) return text;
    return JSON.stringify(wps.map(p => ({ x: p.x + dx, y: p.y + dy })));
  }

  function connectorSideDir(side) {
    if (side === 'top') return { x: 0, y: -1 };
    if (side === 'bottom') return { x: 0, y: 1 };
    if (side === 'left') return { x: -1, y: 0 };
    return { x: 1, y: 0 };
  }

  // Tangente "de passage" en chaque point de la courbe : aux deux ancres, perpendiculaire au bord visé
  // (sortante au départ, entrante à l'arrivée — d'où le signe opposé) ; à un point de passage
  // intermédiaire, direction du point précédent vers le suivant (type Catmull-Rom) — assure une courbe
  // lisse, sans angle, à travers ce point.
  function connectorTangents(points, fromSide, toSide) {
    const n = points.length;
    return points.map((p, i) => {
      if (i === 0) return connectorSideDir(fromSide);
      if (i === n - 1) { const d = connectorSideDir(toSide); return { x: -d.x, y: -d.y }; }
      const prev = points[i - 1], next = points[i + 1];
      const dx = next.x - prev.x, dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: dx / len, y: dy / len };
    });
  }

  // Un segment de Bézier cubique par paire de points consécutifs, distance des points de contrôle
  // proportionnelle à la longueur du segment (clampée) : dégénère en ligne quasi droite quand les deux
  // tangentes sont déjà alignées avec le segment (ancres qui se font face), et produit le S-curve
  // attendu sinon (cf. captures Miro).
  function connectorSegments(points, tangents) {
    const segs = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i], p1 = points[i + 1];
      const off = clamp(Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.5, 24, 160);
      segs.push({
        p0, p1,
        c1: { x: p0.x + tangents[i].x * off, y: p0.y + tangents[i].y * off },
        c2: { x: p1.x - tangents[i + 1].x * off, y: p1.y - tangents[i + 1].y * off },
      });
    }
    return segs;
  }

  function connectorPathD(segs, origin) {
    if (!segs.length) return '';
    let d = `M ${segs[0].p0.x - origin.x} ${segs[0].p0.y - origin.y}`;
    segs.forEach((s) => {
      d += ` C ${s.c1.x - origin.x} ${s.c1.y - origin.y}, ${s.c2.x - origin.x} ${s.c2.y - origin.y}, ${s.p1.x - origin.x} ${s.p1.y - origin.y}`;
    });
    return d;
  }

  function bezierPointAt(s, t) {
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, e = t * t * t;
    return {
      x: a * s.p0.x + b * s.c1.x + c * s.c2.x + e * s.p1.x,
      y: a * s.p0.y + b * s.c1.y + c * s.c2.y + e * s.p1.y,
    };
  }

  // Découpe UN segment de Bézier cubique en deux, pile au paramètre t (De Casteljau) — utilisé pour
  // extraire une portion exacte du tracé (garder seulement [t1,t2] d'un segment), que ce soit pour
  // laisser un trou au milieu (libellé) ou raccourcir une extrémité (pointe de flèche, cf. plus bas).
  function splitBezierAt(s, t) {
    const lerp = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
    const p01 = lerp(s.p0, s.c1, t), p12 = lerp(s.c1, s.c2, t), p23 = lerp(s.c2, s.p1, t);
    const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
    const p0123 = lerp(p012, p123, t);
    return {
      left: { p0: s.p0, c1: p01, c2: p012, p1: p0123 },
      right: { p0: p0123, c1: p123, c2: p23, p1: s.p1 },
    };
  }

  // Table d'échantillons (point + segment d'origine + t + longueur cumulée depuis le départ) : base
  // commune à tout ce qui a besoin de raisonner en distance parcourue le long de la courbe plutôt qu'en
  // paramètre t brut (milieu du libellé, trou autour de lui, recul des extrémités sous les pointes de
  // flèche) — une seule passe d'échantillonnage, réutilisée partout ci-dessous.
  function connectorArcTable(segs) {
    const SAMPLES = 16;
    const table = [];
    let dist = 0;
    segs.forEach((s, segIndex) => {
      let prev = null;
      for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        const p = bezierPointAt(s, t);
        if (prev) dist += Math.hypot(p.x - prev.x, p.y - prev.y);
        table.push({ x: p.x, y: p.y, segIndex, t, dist });
        prev = p;
      }
    });
    return table;
  }

  // Retrouve le point (+ segment/t d'origine) à une distance parcourue donnée, par interpolation entre
  // les deux échantillons encadrants — jamais entre deux segments différents (un t interpolé entre deux
  // paramétrisations distinctes n'aurait aucun sens), auquel cas on se cale sur le second échantillon.
  function pointAtArcLength(table, target) {
    const last = table[table.length - 1];
    if (target <= 0) return table[0];
    if (target >= last.dist) return last;
    for (let i = 1; i < table.length; i++) {
      if (table[i].dist >= target) {
        const a = table[i - 1], b = table[i];
        if (a.segIndex !== b.segIndex) return b;
        const span = b.dist - a.dist;
        const frac = span ? (target - a.dist) / span : 0;
        return { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac, segIndex: a.segIndex, t: a.t + (b.t - a.t) * frac };
      }
    }
    return last;
  }

  // Extrait la portion de `segs` comprise entre deux points d'arc (bornes incluses), en découpant les
  // segments de départ/arrivée pile aux bons t — les segments strictement entre les deux restent
  // entiers, ceux strictement AVANT/APRÈS sont exclus.
  function connectorSubpathSegs(segs, fromInfo, toInfo) {
    const out = [];
    for (let i = fromInfo.segIndex; i <= toInfo.segIndex; i++) {
      const seg = segs[i];
      if (i === fromInfo.segIndex && i === toInfo.segIndex) {
        const afterFrom = splitBezierAt(seg, fromInfo.t).right;
        const tRel = fromInfo.t >= 1 ? 0 : clamp((toInfo.t - fromInfo.t) / (1 - fromInfo.t), 0, 1);
        out.push(splitBezierAt(afterFrom, tRel).left);
      } else if (i === fromInfo.segIndex) {
        out.push(splitBezierAt(seg, fromInfo.t).right);
      } else if (i === toInfo.segIndex) {
        out.push(splitBezierAt(seg, toInfo.t).left);
      } else {
        out.push(seg);
      }
    }
    return out;
  }

  // Fusionne/trie/clippe une liste de plages [début,fin] (en longueur d'arc) à exclure du tracé visible
  // — au cas où, sur un connecteur très court, le recul sous une pointe de flèche chevaucherait le trou
  // du libellé : mieux vaut une seule plage fusionnée qu'un découpage incohérent.
  function mergeConnectorExclusions(exclusions, totalLen) {
    const sorted = exclusions
      .map(e => ({ start: clamp(e.start, 0, totalLen), end: clamp(e.end, 0, totalLen) }))
      .filter(e => e.end > e.start)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    sorted.forEach((e) => {
      const last = merged[merged.length - 1];
      if (last && e.start <= last.end) last.end = Math.max(last.end, e.end);
      else merged.push({ ...e });
    });
    return merged;
  }

  // Construit le `d` du trait VISIBLE (pas celui, toujours entier, de la zone de clic) en retirant une
  // ou plusieurs plages de la courbe complète : sous chaque pointe de flèche (le trait ne doit pas
  // déborder dessous — cf. le fin reste de tiret visible par endroits sinon, une pointe triangulaire ne
  // couvrant pas toute l'épaisseur du trait jusqu'à son extrémité) et autour du libellé s'il y en a un.
  // Plusieurs "M" dans un seul `d` : des sous-tracés disjoints dans UN SEUL <path>, standard SVG — et
  // marker-start/marker-end continuent de ne s'appliquer qu'aux tout premier/dernier sommets du `d`
  // entier, jamais à ces coupures internes.
  function connectorVisiblePathD(segs, origin, table, totalLen, exclusions) {
    const merged = mergeConnectorExclusions(exclusions, totalLen);
    const visibleRanges = [];
    let cursor = 0;
    merged.forEach((ex) => {
      if (ex.start > cursor) visibleRanges.push({ start: cursor, end: ex.start });
      cursor = Math.max(cursor, ex.end);
    });
    if (cursor < totalLen) visibleRanges.push({ start: cursor, end: totalLen });
    return visibleRanges
      .filter(r => r.end - r.start > 0.01)
      .map(r => connectorPathD(connectorSubpathSegs(segs, pointAtArcLength(table, r.start), pointAtArcLength(table, r.end)), origin))
      .join(' ');
  }

  // Reconstruit les poignées de points de passage à chaque recalcul de géométrie (coût négligeable,
  // quelques divs) : une poignée "sommet" par point de passage EXISTANT (le glisser le repositionne),
  // une poignée "ajouter" plus discrète au milieu paramétrique de CHAQUE segment (le glisser y insère
  // un nouveau point, cf. wireConnectorHandles) — visibles seulement si le connecteur est sélectionné
  // (cf. board.css, même mécanisme que .connector-anchor).
  function renderConnectorHandles(entry, points, segs, origin) {
    const container = entry.el.querySelector('.connector-handles');
    if (!container) return;
    let html = '';
    segs.forEach((s, i) => {
      const mid = bezierPointAt(s, 0.5);
      html += `<div class="connector-addpoint-handle" data-kind="add" data-index="${i}" style="left:${mid.x - origin.x}px; top:${mid.y - origin.y}px"></div>`;
    });
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      html += `<div class="connector-waypoint-handle" data-kind="vertex" data-index="${i - 1}" style="left:${p.x - origin.x}px; top:${p.y - origin.y}px"></div>`;
    }
    container.innerHTML = html;
  }

  // Synchronise le CONTENU du libellé (valeur/taille/couleur hors édition, largeur ET hauteur auto)
  // avant tout calcul de géométrie — sa boîte conditionne le trou à laisser dans le tracé, il faut donc
  // la connaître AVANT de construire le `d` visible, pas seulement pour le positionner après coup.
  function syncConnectorLabelContent(entry) {
    const wrap = entry.el.querySelector('.connector-label');
    const textarea = entry.el.querySelector('.connector-label-text');
    if (!wrap || !textarea) return { show: false, halfWidth: 0, halfHeight: 0 };
    const editing = textarea.classList.contains('is-field-editing');
    const show = !!(entry.data.title || editing);
    wrap.classList.toggle('is-hidden', !show);
    if (!show) return { show: false, halfWidth: 0, halfHeight: 0 };
    if (document.activeElement !== textarea) {
      textarea.value = entry.data.title || '';
      textarea.style.fontSize = `${entry.data.fontSize || 15}px`;
      textarea.style.color = entry.data.color || '#1c1c28';
      autoWidthTag(textarea);
    }
    const halfWidth = wrap.offsetWidth / 2, halfHeight = wrap.offsetHeight / 2;
    return { show: true, halfWidth, halfHeight, ink: measureConnectorLabelInk(textarea, halfWidth, halfHeight) };
  }

  // Boîte des lettres VISIBLES du libellé (relative à son centre), pas celle de sa ligne de texte : une
  // ligne de texte fait environ 1,3 × la taille de police alors qu'un mot en minuscules sans hampe
  // ("non") n'en occupe que la moitié — caler le trou du trait sur la ligne laissait donc un grand vide
  // au-dessus/en dessous des lettres, bien plus que la marge voulue. Mesure par canvas (boîte réelle des
  // glyphes) ; repli sur la boîte de ligne si le navigateur ne fournit pas ces métriques.
  let connectorInkCtx = null;
  function measureConnectorLabelInk(textarea, halfWidth, halfHeight) {
    const fallback = { left: -halfWidth, right: halfWidth, top: -halfHeight, bottom: halfHeight };
    const text = textarea.value;
    if (!text) return fallback;
    if (!connectorInkCtx) connectorInkCtx = document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(textarea);
    connectorInkCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = connectorInkCtx.measureText(text);
    if (m.actualBoundingBoxAscent === undefined || m.fontBoundingBoxAscent === undefined) return fallback;
    const lineH = textarea.offsetHeight;
    const baseline = (lineH - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
    const originX = -m.width / 2; // texte centré dans la zone (text-align:center)
    return {
      left: originX - m.actualBoundingBoxLeft,
      right: originX + m.actualBoundingBoxRight,
      top: baseline - m.actualBoundingBoxAscent - lineH / 2,
      bottom: baseline + m.actualBoundingBoxDescent - lineH / 2,
    };
  }

  function positionConnectorLabel(entry, mid, origin) {
    const wrap = entry.el.querySelector('.connector-label');
    if (!wrap || wrap.classList.contains('is-hidden')) return;
    wrap.style.left = `${mid.x - origin.x}px`;
    wrap.style.top = `${mid.y - origin.y}px`;
  }

  // Trou à laisser dans le trait autour du libellé, en longueur d'arc — calé sur sa VRAIE boîte
  // (rectangle, pas un rayon symétrique le long de la courbe) : sur un tronçon qui courbe, un trou
  // "à distance de courbe égale de chaque côté" ne correspond pas au rectangle du texte (il paraît
  // rond/oblique, cf. retour). On parcourt les points échantillonnés du tracé et on retient le premier
  // et le dernier qui tombent dans le rectangle (centré sur le milieu, marge comprise) : tout ce qui
  // est entre les deux est à exclure, le reste garde la vraie forme de la courbe de chaque côté.
  function connectorLabelGapExclusion(table, mid, ink, marginX, marginTop, marginBottom) {
    const rect = { x0: mid.x + ink.left - marginX, x1: mid.x + ink.right + marginX, y0: mid.y + ink.top - marginTop, y1: mid.y + ink.bottom + marginBottom };
    let first = -1, last = -1;
    table.forEach((p, i) => {
      if (p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1) {
        if (first === -1) first = i;
        last = i;
      }
    });
    if (first === -1) return null;
    // Affine l'entrée/sortie par dichotomie entre l'échantillon dehors et le premier dedans (resp. le
    // dernier dedans et celui d'après) : sans ça, le trou déborde du rectangle d'un pas d'échantillonnage
    // entier (parfois des dizaines d'unités), donc bien plus que la marge voulue.
    const inside = (p) => p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1;
    const refine = (outer, inner) => {
      let lo = 0, hi = 1; // 0 = outer (dehors), 1 = inner (dedans)
      for (let k = 0; k < 14; k++) {
        const m = (lo + hi) / 2;
        const p = { x: outer.x + (inner.x - outer.x) * m, y: outer.y + (inner.y - outer.y) * m };
        if (inside(p)) hi = m; else lo = m;
      }
      return outer.dist + (inner.dist - outer.dist) * hi;
    };
    const start = first > 0 ? refine(table[first - 1], table[first]) : table[first].dist;
    const end = last < table.length - 1 ? refine(table[last + 1], table[last]) : table[last].dist;
    return { start, end };
  }

  function renderConnectorGeometry(entry) {
    const from = connectorAnchorWorldPoint(entry.data.fromElementId, entry.data.fromSide);
    const to = connectorAnchorWorldPoint(entry.data.toElementId, entry.data.toSide);
    if (!from || !to) return;
    const waypoints = parseConnectorWaypoints(entry.data.text);
    const points = [from, ...waypoints, to];
    const tangents = connectorTangents(points, entry.data.fromSide, entry.data.toSide);
    const segs = connectorSegments(points, tangents);

    const xs = [], ys = [];
    segs.forEach(s => { [s.p0, s.c1, s.c2, s.p1].forEach(p => { xs.push(p.x); ys.push(p.y); }); });
    const thickness = entry.data.height || 2;
    const arrowDims = connectorArrowDims(thickness);
    const arrowSize = arrowDims.len;
    const pad = Math.max(20, arrowDims.width, thickness * 2);
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const origin = { x: minX, y: minY };
    const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY);

    entry.data.x = minX;
    entry.data.y = minY;
    entry.data.width = width;
    // entry.data.height reste l'épaisseur du trait (cf. applyLineStyle) : jamais réutilisé pour la
    // hauteur de la boîte englobante, posée directement en CSS ci-dessous sans passer par data.
    entry.el.style.left = `${minX}px`;
    entry.el.style.top = `${minY}px`;
    entry.el.style.width = `${width}px`;
    entry.el.style.height = `${height}px`;

    const table = connectorArcTable(segs);
    const totalLen = table[table.length - 1].dist;
    const labelInfo = syncConnectorLabelContent(entry);
    const mid = pointAtArcLength(table, totalLen / 2);

    // Trous à laisser dans le trait VISIBLE (pas la zone de clic), en longueur d'arc : sous le
    // libellé (cf. connectorLabelGapExclusion) et sous chaque pointe de flèche. Ce dernier trou n'est
    // PAS affaire de style de trait : il existe pour laisser la place à un petit bout de tracé séparé
    // qui porte le marker (cf. applyConnectorCaps et plus bas) — jamais le trait principal lui-même,
    // dont l'extrémité coupée ne serait plus le vrai point d'ancrage une fois la courbe prise en compte.
    const exclusions = [];
    if (entry.data.startCap === 'arrow') exclusions.push({ start: 0, end: Math.max(0, arrowSize - 1) });
    if (entry.data.endCap === 'arrow') exclusions.push({ start: Math.max(0, totalLen - (arrowSize - 1)), end: totalLen });
    if (labelInfo.show) {
      // Marge verticale (identique en haut et en bas) proportionnelle à la taille de police : c'est
      // l'espace que laissait la boîte de ligne sous les lettres (environ 0,3 × la taille, plus un peu
      // de marge), celui qui convenait. Une marge fixe de quelques pixels paraissait collée dès que le
      // trait est épais et oblique (son extrémité coupée déborde du rectangle d'une demi-épaisseur).
      const marginV = 2 + 0.28 * (entry.data.fontSize || 15);
      const gap = connectorLabelGapExclusion(table, mid, labelInfo.ink, 4, marginV, marginV);
      if (gap) exclusions.push(gap);
    }

    const hitPath = entry.el.querySelector('.connector-hit');
    const linePath = entry.el.querySelector('.connector-line');
    if (hitPath) hitPath.setAttribute('d', connectorPathD(segs, origin));
    if (linePath) linePath.setAttribute('d', connectorVisiblePathD(segs, origin, table, totalLen, exclusions));

    // Bouts dédiés sous chaque pointe de flèche (cf. applyConnectorCaps) : géométrie RÉELLE et complète
    // jusqu'au vrai point d'ancrage (jamais coupée), pour que le marker qui s'y attache tombe toujours
    // exactement au bon endroit et dans la bonne direction, même quand la courbe continue de tourner
    // sur ce dernier tronçon.
    const capStart = entry.el.querySelector('.connector-cap-start');
    const capEnd = entry.el.querySelector('.connector-cap-end');
    if (capStart) {
      capStart.setAttribute('d', entry.data.startCap === 'arrow'
        ? connectorPathD(connectorSubpathSegs(segs, table[0], pointAtArcLength(table, Math.max(0, arrowSize - 1))), origin)
        : '');
    }
    if (capEnd) {
      capEnd.setAttribute('d', entry.data.endCap === 'arrow'
        ? connectorPathD(connectorSubpathSegs(segs, pointAtArcLength(table, Math.max(0, totalLen - (arrowSize - 1))), table[table.length - 1]), origin)
        : '');
    }

    renderConnectorHandles(entry, points, segs, origin);
    if (labelInfo.show) positionConnectorLabel(entry, mid, origin);
  }

  // Câblage du libellé optionnel d'un connecteur : un seul champ texte (reuse de wireMultiFieldEditing,
  // qui donne gratuitement undo/dirty-check/is-field-editing) dans la colonne générique `title` — comme
  // les points de passage dans `text`, aucune colonne dédiée n'est nécessaire.
  function wireConnectorLabel(entry) {
    const textarea = entry.el.querySelector('.connector-label-text');
    if (!textarea) return;
    wireMultiFieldEditing(entry, [{ key: 'label', el: textarea, column: 'title', dataKey: 'title' }], 'label');
    // Clic natif sur un libellé déjà affiché (pas forcément passé par le bouton "Texte" de la barre) :
    // le fait quand même entrer dans le circuit normal d'édition (sélection, undoBefore, etc.), sans
    // perturber le focus natif qui vient de se produire (cf. entry.enterField, dont le focus() en rAF
    // est un no-op silencieux sur un champ déjà actif).
    textarea.addEventListener('focus', () => {
      if (!textarea.classList.contains('is-field-editing')) entry.enterField('label');
    });
    textarea.addEventListener('input', () => {
      autoWidthTag(textarea);
      renderConnectorGeometry(entry); // la largeur du libellé a changé : son wrapper doit rester centré
      refreshToolbarIfSelected(entry); // fait apparaître taille/couleur dès le premier caractère écrit
    });
    // Après wireMultiFieldEditing (câblé juste au-dessus) : son propre blur (saveField/stopField,
    // synchrone pour un champ non riche) a déjà tout mis à jour quand celui-ci s'exécute à son tour —
    // reste à cacher le libellé s'il est redevenu vide, et les contrôles taille/couleur avec lui.
    textarea.addEventListener('blur', () => {
      renderConnectorGeometry(entry);
      refreshToolbarIfSelected(entry);
    });
  }

  function anchorScreenPoint(entry, side) {
    const r = entry.el.getBoundingClientRect();
    if (side === 'top') return { x: r.left + r.width / 2, y: r.top };
    if (side === 'bottom') return { x: r.left + r.width / 2, y: r.bottom };
    if (side === 'left') return { x: r.left, y: r.top + r.height / 2 };
    return { x: r.right, y: r.top + r.height / 2 };
  }

  function startLinking(fromEntry, fromSide, e) {
    closeConfirmPopover();
    // Les points d'ancrage d'un élément ne sont visibles (et donc "cliquables") que sur l'élément
    // sélectionné — mais un seul élément peut être sélectionné à la fois. Pendant le glissement d'un
    // lien, on montre temporairement les points de TOUS les éléments pour pouvoir viser la cible.
    document.body.classList.add('is-linking');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'link-ghost-svg');
    svg.innerHTML = '<line class="link-ghost-line" x1="0" y1="0" x2="0" y2="0"/>';
    document.body.appendChild(svg);
    const line = svg.querySelector('line');

    const start = anchorScreenPoint(fromEntry, fromSide);
    line.setAttribute('x1', start.x); line.setAttribute('y1', start.y);
    line.setAttribute('x2', start.x); line.setAttribute('y2', start.y);

    // Un point d'ancrage de 12px est un petit cible à viser précisément à la souris : plutôt que
    // d'exiger un survol pixel-perfect (elementFromPoint), on "aimante" vers le point le plus proche
    // dans un rayon raisonnable, comme le fait Miro/Figma pour les connecteurs.
    const SNAP_RADIUS = 22;
    function currentAnchorUnderPointer(ev) {
      let closest = null, closestDist = SNAP_RADIUS;
      document.querySelectorAll('.connector-anchor').forEach((dot) => {
        if (getComputedStyle(dot).display === 'none') return;
        const hostEl = dot.closest('.element');
        if (!hostEl || hostEl.dataset.id === fromEntry.data.id) return;
        const r = dot.getBoundingClientRect();
        const dist = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2));
        if (dist < closestDist) { closestDist = dist; closest = dot; }
      });
      return closest;
    }

    function onMove(ev) {
      line.setAttribute('x2', ev.clientX); line.setAttribute('y2', ev.clientY);
      document.querySelectorAll('.connector-anchor.is-hover-target').forEach(d => d.classList.remove('is-hover-target'));
      const dot = currentAnchorUnderPointer(ev);
      if (dot) dot.classList.add('is-hover-target');
    }

    function onUp(ev) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // Chercher l'ancre cible AVANT de retirer la classe is-linking : c'est elle qui rend les
      // ancres des éléments non sélectionnés visibles/détectables pendant le geste.
      const dot = currentAnchorUnderPointer(ev);
      document.body.classList.remove('is-linking');
      svg.remove();
      document.querySelectorAll('.connector-anchor.is-hover-target').forEach(d => d.classList.remove('is-hover-target'));
      if (!dot) return;
      const toEl = dot.closest('.element');
      const toId = toEl.dataset.id;
      const toSide = dot.dataset.side;
      createElementTracked({
        type: 'connector', fromElementId: fromEntry.data.id, fromSide, toElementId: toId, toSide,
        color: '#1c1c28', height: 2, lineStyle: 'solid', endCap: 'arrow', startCap: 'none',
      }).catch(err => alert(err.message));
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function wireConnectorAnchors(entry) {
    if (!BOX_TYPES.includes(entry.data.type)) return;
    entry.el.querySelectorAll('.connector-anchor').forEach((dot) => {
      dot.addEventListener('pointerdown', (e) => {
        if (entry.data.locked) return;
        e.stopPropagation();
        startLinking(entry, dot.dataset.side, e);
      });
    });
  }

  // ---------- Interactions communes (barre d'outils, glisser, édition, redimensionnement) ----------

  function applyImageFilters(entry) {
    const img = entry.el.querySelector('.element-image-img');
    if (img) img.classList.toggle('is-grayscale', !!entry.data.grayscale);
  }

  function duplicateElement(entry) {
    const d = entry.data;
    // Décalage multiple de la grille (pas +24px) : une copie doit rester sur la grille si l'original y
    // était déjà, comme n'importe quelle autre pose.
    const DUP_OFFSET = GRID_SIZE * 2;
    const payload = {
      type: d.type, x: d.x + DUP_OFFSET, y: d.y + DUP_OFFSET, width: d.width, height: d.height, rotation: d.rotation,
      // Pas de décalage des points de passage ici (contrairement à pasteClipboard) : dupliquer UN
      // connecteur seul garde ses extrémités SUR LES MÊMES éléments d'origine (fromElementId/toElementId
      // ci-dessous, non remappés) — la copie doit donc garder la même courbe, pas une courbe décalée
      // par rapport à des ancres qui, elles, n'ont pas bougé.
      color: d.color, text: d.text, fontSize: d.fontSize, bold: d.bold, italic: d.italic,
      underline: d.underline, strikethrough: d.strikethrough, imageData: d.imageData, grayscale: d.grayscale,
      lineStyle: d.lineStyle, backgroundColor: d.backgroundColor, strokeWidth: d.strokeWidth, strokeColor: d.strokeColor,
      radius: d.radius, startCap: d.startCap, endCap: d.endCap,
      fromElementId: d.fromElementId, fromSide: d.fromSide, toElementId: d.toElementId, toSide: d.toSide,
      titleColor: d.titleColor, textColor: d.textColor, textAlign: d.textAlign, textValign: d.textValign, link: d.link,
      title: d.title, number: d.number, tag: d.tag,
      // frameId explicite (plutôt que de laisser le serveur redéduire l'appartenance de la copie) :
      // avec un décalage aussi faible, une copie posée tout au bord de la frame pourrait sinon se
      // retrouver considérée hors de ses limites.
      frameId: d.type === 'frame' ? undefined : (d.frameId || null),
    };
    if (d.type !== 'frame') { createElementTracked(payload).catch(err => alert(err.message)); return; }
    // Dupliquer une frame duplique aussi son contenu, avec le même décalage, en le rattachant
    // EXPLICITEMENT à la copie (clientId 'newFrame') plutôt qu'à la frame d'origine — laisser le
    // serveur redéduire l'appartenance d'après la position ne suffit pas ici : avec un décalage aussi
    // faible sur une frame bien plus grande, la copie et l'originale se chevauchent presque
    // entièrement, et la détection par position choisirait alors la frame la plus "au-dessus" (z le
    // plus haut) — quasi toujours l'ORIGINALE, une frame allant toujours un peu plus loin en arrière-
    // plan que la précédente à chaque création (cf. recreateElements pour le cas symétrique de
    // "coller"). Toute la frame ET son contenu partent en un seul aller-retour (cf.
    // Api.createElementsBatch) plutôt qu'une création par élément — sans ça, dupliquer une frame bien
    // remplie les faisait apparaître un par un. Une seule entrée d'annulation couvre tout le lot : la
    // retirer les supprime tous ensemble (deleteContents), pas un par un.
    const children = frameChildren(d.id).map(cid => elements.get(cid)).filter(Boolean);
    const childItems = children.map((child) => {
      const cd = child.data;
      return {
        type: cd.type, x: cd.x + DUP_OFFSET, y: cd.y + DUP_OFFSET, width: cd.width, height: cd.height, rotation: cd.rotation,
        color: cd.color, text: cd.text, fontSize: cd.fontSize, bold: cd.bold, italic: cd.italic,
        underline: cd.underline, strikethrough: cd.strikethrough, imageData: cd.imageData, grayscale: cd.grayscale,
        lineStyle: cd.lineStyle, backgroundColor: cd.backgroundColor, strokeWidth: cd.strokeWidth, strokeColor: cd.strokeColor,
        radius: cd.radius, startCap: cd.startCap, endCap: cd.endCap,
        textColor: cd.textColor, textAlign: cd.textAlign, textValign: cd.textValign, link: cd.link,
        title: cd.title, number: cd.number, tag: cd.tag,
        frameId: 'newFrame',
      };
    });
    withBusy(Api.createElementsBatch([{ ...payload, frameId: undefined, clientId: 'newFrame' }, ...childItems]))
      .then(({ elements: created }) => {
        created.forEach(data => ensureRendered(data));
        const [newFrame, ...newChildren] = created;
        recordUndo(() => {
          removeElementLocal(newFrame.id);
          newChildren.forEach(c => removeElementLocal(c.id));
          return Api.deleteElement(newFrame.id, { deleteContents: true }).catch(() => {});
        });
      })
      .catch(err => alert(err.message));
  }

  // Ouvre/ferme le popover d'un contrôle "déroulant" du toolbar (couleur, épaisseur, extrémité,
  // style de texte) — un seul ouvert à la fois.
  function wireDropdownToggle(role) {
    const trigger = toolbarEl.querySelector(`[data-role="${role}-trigger"]`);
    const popover = toolbarEl.querySelector(`[data-role="${role}-popover"]`);
    if (!trigger || !popover) return null;
    trigger.addEventListener('pointerdown', e => e.stopPropagation());
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = popover.classList.contains('is-open');
      closeAllToolbarPopovers();
      if (!isOpen) popover.classList.add('is-open');
    });
    return { trigger, popover };
  }

  function wireColorDropdown(entry, role, onPick) {
    const parts = wireDropdownToggle(role);
    if (!parts) return;
    const { trigger, popover } = parts;
    popover.querySelectorAll('.toolbar-color-swatch').forEach((sw) => {
      sw.addEventListener('pointerdown', e => e.stopPropagation());
      sw.addEventListener('click', () => {
        const color = sw.dataset.color || null;
        onPick(color);
        popover.querySelectorAll('.toolbar-color-swatch').forEach(s => s.classList.remove('is-active'));
        sw.classList.add('is-active');
        const dot = trigger.querySelector('.toolbar-color-dot');
        const isRandom = color === 'random';
        dot.classList.toggle('toolbar-color-dot-random', isRandom);
        dot.innerHTML = isRandom ? iconShuffle(11) : '';
        if (dot.classList.contains('toolbar-color-dot-ring')) {
          dot.style.borderColor = isRandom ? '' : (color || '#ccc');
        } else {
          dot.style.background = isRandom ? '' : (color || '');
          dot.classList.toggle('toolbar-color-dot-none', !color && !isRandom);
        }
        popover.classList.remove('is-open');
      });
    });
  }

  // Simple bascule (pas de popover) : le serveur gère le toggle et renvoie la liste à jour des
  // votants, qu'on applique directement (le même écho arrive aussi par SSE, sans effet puisqu'il
  // pose la même liste).
  function toggleVote(entry) {
    Api.toggleVote(entry.data.id).then(({ voters }) => {
      entry.data.votes = voters;
      updateElementBadges(entry);
      refreshToolbarIfSelected(entry);
    }).catch(() => {});
  }

  function wireVoteButton(entry) {
    const btn = toolbarEl.querySelector('.element-vote-btn');
    if (!btn) return;
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', () => toggleVote(entry));
  }

  // Réutilisée par "texte", "post-it" et "rectangle" — même popover, seule la fonction de style à
  // réappliquer diffère (rectangle/post-it ont leur propre alignement en plus, cf.
  // applyRectangleTextStyle/applyNoteTextStyle).
  function wireFormatDropdown(entry) {
    const parts = wireDropdownToggle('format');
    if (!parts) return;
    const type = entry.data.type;
    const applyStyle = type === 'rectangle' ? applyRectangleTextStyle : type === 'note' ? applyNoteTextStyle : applyTextStyle;
    const autoGrow = type === 'rectangle' ? autoGrowRectangleTextarea : type === 'note' ? autoGrowNoteOnInput : applyTextAutoSize;
    parts.popover.querySelectorAll('.element-format-btn[data-format]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        const key = btn.dataset.format;
        const before = entry.data[key];
        entry.data[key] = !entry.data[key];
        btn.classList.toggle('is-active', entry.data[key]);
        applyStyle(entry);
        if (key === 'bold' || key === 'italic') autoGrow(entry);
        Api.updateElement(entry.data.id, { [key]: entry.data[key] }).catch(() => {});
        recordFieldUndo(entry.data.id, { [key]: before });
      });
    });
  }

  // Réutilisée par rectangle/post-it (deux rangées) et texte libre (rangée horizontale seule, cf.
  // alignDropdownHtml) — reste ouvert après un choix, on ajuste souvent plusieurs valeurs à la suite.
  function wireAlignDropdown(entry, applyStyle) {
    const id = entry.data.id;
    const alignParts = wireDropdownToggle('align');
    if (!alignParts) return;
    const { trigger, popover } = alignParts;
    const hIcons = { left: iconTextAlignLeft, center: iconTextAlignCenter, right: iconTextAlignRight };
    popover.querySelectorAll('[data-align-h]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        const before = entry.data.textAlign;
        entry.data.textAlign = btn.dataset.alignH;
        applyStyle(entry);
        popover.querySelectorAll('[data-align-h]').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        trigger.innerHTML = hIcons[btn.dataset.alignH]();
        Api.updateElement(id, { textAlign: entry.data.textAlign }).catch(() => {});
        if (before !== entry.data.textAlign) recordFieldUndo(id, { textAlign: before });
      });
    });
    popover.querySelectorAll('[data-align-v]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        const before = entry.data.textValign;
        entry.data.textValign = btn.dataset.alignV;
        applyStyle(entry);
        popover.querySelectorAll('[data-align-v]').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        Api.updateElement(id, { textValign: entry.data.textValign }).catch(() => {});
        if (before !== entry.data.textValign) recordFieldUndo(id, { textValign: before });
      });
    });
  }

  // Réutilisée par rectangle et texte libre : le texte devient cliquable (mis en forme "lien" forcée,
  // cf. applyRectangleTextStyle/applyTextStyle), ouvrir sur un simple clic géré dans wireTextEditing.
  function wireLinkDropdown(entry, applyStyle) {
    const id = entry.data.id;
    const linkParts = wireDropdownToggle('link');
    if (!linkParts) return;
    const { trigger, popover } = linkParts;
    const input = popover.querySelector('[data-role="link-input"]');
    const applyBtn = popover.querySelector('[data-role="link-apply"]');
    const removeBtn = popover.querySelector('[data-role="link-remove"]');
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') applyBtn.click();
    });
    applyBtn.addEventListener('pointerdown', e => e.stopPropagation());
    applyBtn.addEventListener('click', () => {
      const before = entry.data.link;
      const url = input.value.trim();
      entry.data.link = url || null;
      applyStyle(entry);
      trigger.classList.toggle('is-active', !!entry.data.link);
      removeBtn.hidden = !entry.data.link;
      popover.classList.remove('is-open');
      Api.updateElement(id, { link: entry.data.link }).catch(() => {});
      if (before !== entry.data.link) recordFieldUndo(id, { link: before });
    });
    removeBtn.addEventListener('pointerdown', e => e.stopPropagation());
    removeBtn.addEventListener('click', () => {
      const before = entry.data.link;
      input.value = '';
      entry.data.link = null;
      applyStyle(entry);
      trigger.classList.remove('is-active');
      removeBtn.hidden = true;
      popover.classList.remove('is-open');
      Api.updateElement(id, { link: null }).catch(() => {});
      if (before !== null) recordFieldUndo(id, { link: before });
    });
  }

  // Réutilisée par rectangle (avec angles) et frame (sans, cf. borderDropdownHtml) — reste ouvert
  // après un choix, style/épaisseur/couleur du contour s'ajustent souvent à la suite.
  function wireBorderDropdown(entry, { withRadius = true } = {}) {
    const id = entry.data.id;
    const borderParts = wireDropdownToggle('border');
    if (!borderParts) return;
    const { popover } = borderParts;
    if (withRadius) {
      popover.querySelectorAll('[data-radius]').forEach((btn) => {
        btn.addEventListener('pointerdown', e => e.stopPropagation());
        btn.addEventListener('click', () => {
          const before = entry.data.radius;
          entry.data.radius = Number(btn.dataset.radius);
          applyRectangleStyle(entry);
          popover.querySelectorAll('[data-radius]').forEach(b => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          Api.updateElement(id, { radius: entry.data.radius }).catch(() => {});
          if (before !== entry.data.radius) recordFieldUndo(id, { radius: before });
        });
      });
    }
    popover.querySelectorAll('[data-strokewidth]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        const before = entry.data.strokeWidth;
        entry.data.strokeWidth = Number(btn.dataset.strokewidth);
        applyRectangleStyle(entry);
        popover.querySelectorAll('[data-strokewidth]').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        Api.updateElement(id, { strokeWidth: entry.data.strokeWidth }).catch(() => {});
        if (before !== entry.data.strokeWidth) recordFieldUndo(id, { strokeWidth: before });
      });
    });
    popover.querySelectorAll('[data-linestyle]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        const before = entry.data.lineStyle;
        entry.data.lineStyle = btn.dataset.linestyle;
        applyRectangleStyle(entry);
        popover.querySelectorAll('[data-linestyle]').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        Api.updateElement(id, { lineStyle: entry.data.lineStyle }).catch(() => {});
        if (before !== entry.data.lineStyle) recordFieldUndo(id, { lineStyle: before });
      });
    });
    popover.querySelectorAll('[data-strokecolor]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        const before = entry.data.strokeColor;
        entry.data.strokeColor = btn.dataset.strokecolor;
        applyRectangleStyle(entry);
        popover.querySelectorAll('[data-strokecolor]').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        Api.updateElement(id, { strokeColor: entry.data.strokeColor }).catch(() => {});
        if (before !== entry.data.strokeColor) recordFieldUndo(id, { strokeColor: before });
      });
    });
  }

  // Bouton "Style et épaisseur" du trait/connecteur (cf. lineDropdownHtml) — la couleur a son propre
  // bouton séparé, wiré par le wireColorDropdown générique plus bas. Reste ouvert après un choix.
  function wireLineDropdown(entry) {
    const id = entry.data.id;
    const lineParts = wireDropdownToggle('linestyle');
    if (!lineParts) return;
    const { trigger, popover } = lineParts;
    popover.querySelectorAll('[data-thickness]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        const beforeH = entry.data.height, beforeStyle = entry.data.lineStyle;
        const h = Number(btn.dataset.thickness);
        const style = btn.dataset.style;
        entry.data.height = h;
        entry.data.lineStyle = style;
        applyLineStyle(entry);
        // "line" : la boîte EST le trait, sa hauteur CSS = l'épaisseur. "connector" : la boîte est la
        // bbox englobante de la courbe (jamais l'épaisseur) — recalculer sa géométrie plutôt que
        // d'écraser sa hauteur, puisque l'épaisseur influe aussi sur la marge/la taille des pointes.
        if (entry.data.type === 'connector') { applyConnectorCaps(entry); renderConnectorGeometry(entry); }
        else entry.el.style.height = `${h}px`;
        popover.querySelectorAll('[data-thickness]').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const preview = trigger.querySelector('.toolbar-thickness-preview');
        preview.style.height = `${h}px`;
        preview.classList.toggle('is-dashed', style === 'dashed');
        Api.updateElement(id, { height: h, lineStyle: style }).catch(() => {});
        repositionToolbar(entry);
        if (beforeH !== h || beforeStyle !== style) recordFieldUndo(id, { height: beforeH, lineStyle: beforeStyle });
      });
    });
    // Pointes de flèche (connecteur seulement, cf. showCaps dans lineDropdownHtml) : dans ce MÊME
    // popover plutôt que deux boutons séparés dans la barre.
    popover.querySelectorAll('[data-capside]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        const side = btn.dataset.capside;
        const column = side === 'start' ? 'startCap' : 'endCap';
        const before = entry.data[column];
        entry.data[column] = before === 'arrow' ? 'none' : 'arrow';
        btn.classList.toggle('is-active', entry.data[column] === 'arrow');
        applyConnectorCaps(entry);
        Api.updateElement(id, { [column]: entry.data[column] }).catch(() => {});
        recordFieldUndo(id, { [column]: before });
      });
    });
  }

  // Menu "⋮" (cf. moreMenuHtml) : généralisé à tous les types d'éléments.
  function wireMoreMenu(entry) {
    const id = entry.data.id;
    const moreParts = wireDropdownToggle('more');
    if (!moreParts) return;
    const { trigger, popover } = moreParts;
    const dup = popover.querySelector('[data-role="more-duplicate"]');
    if (dup) {
      dup.addEventListener('pointerdown', e => e.stopPropagation());
      dup.addEventListener('click', () => { popover.classList.remove('is-open'); duplicateElement(entry); });
    }
    const front = popover.querySelector('[data-role="more-front"]');
    if (front) {
      front.addEventListener('pointerdown', e => e.stopPropagation());
      front.addEventListener('click', () => {
        popover.classList.remove('is-open');
        Api.updateElement(id, { bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
      });
    }
    const back = popover.querySelector('[data-role="more-back"]');
    if (back) {
      back.addEventListener('pointerdown', e => e.stopPropagation());
      back.addEventListener('click', () => {
        popover.classList.remove('is-open');
        Api.updateElement(id, { sendToBack: true }).then(applyRemoteUpdate).catch(() => {});
      });
    }
    const del = popover.querySelector('[data-role="more-delete"]');
    if (del) {
      del.addEventListener('pointerdown', e => e.stopPropagation());
      del.addEventListener('click', () => {
        popover.classList.remove('is-open');
        showDeleteConfirm(entry, trigger.getBoundingClientRect());
      });
    }
  }

  function wireToolbarControls(entry) {
    const id = entry.data.id;
    const type = entry.data.type;

    if (type === 'note' || type === 'text' || type === 'rectangle' || type === 'frame' || type === 'line' || type === 'connector' || type === 'instruction' || type === 'tip' || type === 'webpage' || type === 'stack') {
      wireColorDropdown(entry, 'color', (color) => {
        const before = entry.data.color;
        entry.data.color = color;
        applyElementColor(entry);
        if (type === 'connector') applyConnectorCaps(entry);
        // Choisir une couleur fixe ici quitte implicitement le mode "aléatoire" (cf. iconShuffle) :
        // son bouton doit se désactiver visuellement, d'où ce rebuild plutôt qu'un patch DOM manuel.
        if (type === 'stack') refreshToolbarIfSelected(entry);
        Api.updateElement(id, { color }).catch(err => alert(err.message));
        if (before !== color) recordFieldUndo(id, { color: before });
      });
    }

    if (type === 'stack') {
      const authorBtn = toolbarEl.querySelector('.element-showauthor-btn');
      if (authorBtn) {
        authorBtn.addEventListener('pointerdown', e => e.stopPropagation());
        authorBtn.addEventListener('click', () => {
          const before = entry.data.grayscale;
          entry.data.grayscale = !entry.data.grayscale;
          authorBtn.classList.toggle('is-active', entry.data.grayscale);
          Api.updateElement(id, { grayscale: entry.data.grayscale }).catch(() => {});
          recordFieldUndo(id, { grayscale: before });
        });
      }
    }

    if (type === 'webpage') {
      const pageTypeSelect = toolbarEl.querySelector('[data-role="pagetype"]');
      if (pageTypeSelect) {
        pageTypeSelect.addEventListener('pointerdown', e => e.stopPropagation());
        pageTypeSelect.addEventListener('change', () => {
          const before = entry.data.tag;
          const key = pageTypeSelect.value;
          entry.data.tag = key;
          const wireframeEl = entry.el.querySelector('.webpage-wireframe');
          if (wireframeEl) wireframeEl.innerHTML = wpSvg(key, '100%', '100%');
          Api.updateElement(id, { tag: key }).catch(() => {});
          if (before !== key) recordFieldUndo(id, { tag: before });
        });
      }
    }

    if (type === 'line' || type === 'connector') {
      wireLineDropdown(entry);
    }

    if (type === 'connector') {
      const labelBtn = toolbarEl.querySelector('.element-connector-label-btn');
      if (labelBtn) {
        labelBtn.addEventListener('pointerdown', e => e.stopPropagation());
        labelBtn.addEventListener('click', () => {
          closeAllToolbarPopovers(); // le popover "style du trait" peut être resté ouvert à côté
          // Valeurs par défaut posées ici (pas avant) : tant qu'il n'y a jamais eu de libellé, elles
          // ne servent à rien et ne doivent pas polluer un connecteur resté sans texte.
          if (!entry.data.fontSize) entry.data.fontSize = 15;
          entry.enterField('label');
          renderConnectorGeometry(entry); // affiche tout de suite le champ (vide) au milieu du trait
        });
      }
      if (entry.data.title) {
        const fontsizeSelect = toolbarEl.querySelector('[data-role="connectorlabel-fontsize"]');
        if (fontsizeSelect) {
          fontsizeSelect.addEventListener('pointerdown', e => e.stopPropagation());
          fontsizeSelect.addEventListener('change', () => {
            const before = entry.data.fontSize;
            const size = Number(fontsizeSelect.value);
            entry.data.fontSize = size;
            renderConnectorGeometry(entry);
            Api.updateElement(id, { fontSize: size }).catch(() => {});
            if (before !== size) recordFieldUndo(id, { fontSize: before });
          });
        }
      }
    }

    if (type === 'note') {
      wireFormatDropdown(entry); // conscient du type post-it (cf. plus haut) : applyNoteTextStyle
      wireAlignDropdown(entry, applyNoteTextStyle);
    }

    if (type === 'rectangle') {
      wireColorDropdown(entry, 'textcolor', (color) => {
        const before = entry.data.textColor;
        entry.data.textColor = color;
        applyRectangleTextStyle(entry);
        Api.updateElement(id, { textColor: color }).catch(() => {});
        if (before !== color) recordFieldUndo(id, { textColor: before });
      });
      wireFormatDropdown(entry); // conscient du type rectangle (cf. plus haut) : applyRectangleTextStyle, pas applyTextStyle
      wireAlignDropdown(entry, applyRectangleTextStyle);
      wireLinkDropdown(entry, applyRectangleTextStyle);
      wireBorderDropdown(entry, { withRadius: entry.data.tag !== 'diamond' });

      const rectFontSizeSelect = toolbarEl.querySelector('[data-role="rect-fontsize"]');
      if (rectFontSizeSelect) {
        rectFontSizeSelect.addEventListener('pointerdown', e => e.stopPropagation());
        rectFontSizeSelect.addEventListener('change', () => {
          const before = entry.data.fontSize;
          const beforeW = entry.data.width, beforeH = entry.data.height;
          const size = Number(rectFontSizeSelect.value);
          entry.data.fontSize = size;
          applyRectangleTextStyle(entry);
          autoGrowRectangleTextarea(entry);
          Api.updateElement(id, { fontSize: size }).catch(() => {});
          if (before !== size) recordFieldUndo(id, { fontSize: before, width: beforeW, height: beforeH });
        });
      }
    }

    if (type === 'frame') {
      wireBorderDropdown(entry, { withRadius: false });
      wireColorDropdown(entry, 'title', (color) => {
        const before = entry.data.titleColor;
        entry.data.titleColor = color;
        applyFrameTitleStyle(entry);
        Api.updateElement(id, { titleColor: color }).catch(() => {});
        if (before !== color) recordFieldUndo(id, { titleColor: before });
      });
      const titleFontSizeSelect = toolbarEl.querySelector('[data-role="title-fontsize"]');
      if (titleFontSizeSelect) {
        titleFontSizeSelect.addEventListener('pointerdown', e => e.stopPropagation());
        titleFontSizeSelect.addEventListener('change', () => {
          const before = entry.data.fontSize;
          const size = Number(titleFontSizeSelect.value);
          entry.data.fontSize = size;
          applyFrameTitleStyle(entry);
          Api.updateElement(id, { fontSize: size }).catch(() => {});
          if (before !== size) recordFieldUndo(id, { fontSize: before });
        });
      }
      const arrangeBtn = toolbarEl.querySelector('.element-arrange-btn');
      if (arrangeBtn) {
        arrangeBtn.addEventListener('pointerdown', e => e.stopPropagation());
        arrangeBtn.addEventListener('click', () => {
          // Action ponctuelle (comme dupliquer) : range le contenu actuel une fois, sans laisser de
          // mode actif — ajouter/déplacer un élément après coup ne redéclenche rien. Géométrie complète
          // (pas seulement x/y) capturée avant : ranger peut aussi redimensionner le contenu — ET la
          // frame elle-même (sa hauteur s'ajuste pour tout contenir, cf. applyFrameArrangement).
          const childIds = frameChildren(id);
          const beforeFrame = { x: entry.data.x, y: entry.data.y, width: entry.data.width, height: entry.data.height };
          const before = childIds.map((cid) => {
            const en = elements.get(cid);
            return en ? { id: cid, x: en.data.x, y: en.data.y, width: en.data.width, height: en.data.height } : null;
          }).filter(Boolean);
          Api.arrangeFrame(id).then(({ elements: arranged }) => {
            arranged.forEach(applyRemoteUpdate);
            recordUndo(async () => {
              // La frame D'ABORD (attendue), puis les enfants : sinon un enfant restauré à une position
              // qui ne rentre plus dans la frame ENCORE rétrécie (cf. findContainingFrame côté serveur,
              // basé sur la taille ACTUELLE) se retrouverait détaché par erreur (frameId recalculé à
              // null) avant même que la frame n'ait retrouvé sa taille d'origine.
              await Api.updateElement(id, beforeFrame).then(applyRemoteUpdate).catch(() => {});
              await Promise.all(before.map(b =>
                Api.updateElement(b.id, { x: b.x, y: b.y, width: b.width, height: b.height }).then(applyRemoteUpdate).catch(() => {})
              ));
            });
          }).catch(() => {});
        });
      }
    }

    if (type === 'text') {
      wireFormatDropdown(entry);
      wireLinkDropdown(entry, applyTextStyle);
      wireColorDropdown(entry, 'bg', (color) => {
        const before = entry.data.backgroundColor;
        entry.data.backgroundColor = color;
        applyElementBackground(entry);
        Api.updateElement(id, { backgroundColor: color }).catch(() => {});
        if (before !== color) recordFieldUndo(id, { backgroundColor: before });
      });
      const fontSizeSelect = toolbarEl.querySelector('[data-role="fontsize"]');
      if (fontSizeSelect) {
        fontSizeSelect.addEventListener('pointerdown', e => e.stopPropagation());
        fontSizeSelect.addEventListener('change', () => {
          const before = entry.data.fontSize;
          const beforeW = entry.data.width, beforeH = entry.data.height;
          const size = Number(fontSizeSelect.value);
          entry.data.fontSize = size;
          applyTextStyle(entry);
          applyTextAutoSize(entry);
          Api.updateElement(id, { fontSize: size, width: entry.data.width, height: entry.data.height }).catch(() => {});
          if (before !== size) recordFieldUndo(id, { fontSize: before, width: beforeW, height: beforeH });
        });
      }
    }

    if (type === 'image') {
      const grayscaleBtn = toolbarEl.querySelector('.element-grayscale-btn');
      if (grayscaleBtn) {
        grayscaleBtn.addEventListener('pointerdown', e => e.stopPropagation());
        grayscaleBtn.addEventListener('click', () => {
          const before = entry.data.grayscale;
          entry.data.grayscale = !entry.data.grayscale;
          grayscaleBtn.classList.toggle('is-active', entry.data.grayscale);
          applyImageFilters(entry);
          Api.updateElement(id, { grayscale: entry.data.grayscale }).catch(() => {});
          recordFieldUndo(id, { grayscale: before });
        });
      }
      const cropBtn = toolbarEl.querySelector('.element-crop-btn');
      if (cropBtn) {
        cropBtn.addEventListener('pointerdown', e => e.stopPropagation());
        cropBtn.addEventListener('click', () => enterCropMode(entry));
      }
    }

    wireVoteButton(entry);
    const commentBtn = toolbarEl.querySelector('.element-comment-btn');
    if (commentBtn) {
      commentBtn.addEventListener('pointerdown', e => e.stopPropagation());
      commentBtn.addEventListener('click', () => openCommentDrawer(entry));
    }

    const lockBtn = toolbarEl.querySelector('.element-lock-btn');
    if (lockBtn) {
      lockBtn.addEventListener('pointerdown', e => e.stopPropagation());
      lockBtn.addEventListener('click', () => {
        // Le verrouillage porte toujours sur le groupe entier d'un coup, jamais élément par élément
        // au sein d'un même groupe — sinon un groupe pourrait finir dans un état incohérent
        // (certains membres verrouillés, d'autres non). Une frame seule (pas groupée) ne verrouille
        // qu'elle-même : ce qu'elle contient spatialement (frameChildren) n'est concerné que si c'est
        // aussi explicitement dans le même groupe qu'elle.
        const ids = entry.data.groupId ? groupMembers(entry.data.groupId) : [entry.data.id];
        const before = ids.map(id => ({ id, before: elements.get(id)?.data.locked || false }));
        ids.forEach((id) => {
          const en = elements.get(id);
          if (!en) return;
          en.data.locked = true;
          applyLockedState(en);
          Api.updateElement(id, { locked: true }).catch(() => {});
        });
        recordMultiFieldUndo(before, 'locked');
        showToolbarFor(entry);
      });
    }

    wireMoreMenu(entry);
  }

  function wireTextEditing(entry) {
    const { el, textEl, data } = entry;
    const id = data.id;

    function stopEditing(save) {
      el.classList.remove('is-editing');
      editingElementId = null;
      if (save) {
        entry.data.text = textEl.value;
        // Rien de changé depuis l'entrée en édition (cf. enterEditing) : ne RIEN renvoyer au serveur.
        // Au-delà de l'économie, c'est nécessaire pour Cmd+Z juste après un simple clic sur un champ
        // sans y taper (cf. isFieldDirty) — un PATCH envoyé ici, même sans effet, concurrence la propre
        // requête de l'annulation précédente pour CE MÊME élément et peut la faire ignorer comme
        // "dépassée" (cf. le dédoublonnage par id dans api.js), rendant l'annulation silencieusement
        // sans effet.
        const before = textEl.dataset.undoBefore;
        const beforeW = Number(textEl.dataset.undoBeforeW);
        const beforeH = Number(textEl.dataset.undoBeforeH);
        delete textEl.dataset.undoBeforeW;
        delete textEl.dataset.undoBeforeH;
        delete textEl.dataset.undoBefore;
        if (before !== undefined && before === textEl.value) return;
        const patch = { text: textEl.value };
        // Le post-it grandit avec son texte (cf. autoGrowNoteOnInput) : sa hauteur doit être persistée
        // comme pour le texte libre, contrairement au rectangle dont seule la zone de texte interne grandit.
        if (entry.data.type === 'text' || entry.data.type === 'note') { patch.width = entry.data.width; patch.height = entry.data.height; }
        Api.updateElement(id, patch).catch(() => {});
        // Un seul cran d'annulation pour TOUTE la session d'édition (pas un par frappe, cf. le
        // débounce de l'input ci-dessous).
        if (before !== undefined) {
          recordUndo(() => Api.updateElement(id, { text: before, width: beforeW, height: beforeH }).then(applyRemoteUpdate).catch(() => {}));
        }
      }
    }

    let textSaveTimer = null;
    textEl.addEventListener('input', () => {
      entry.data.text = textEl.value;
      if (entry.data.type === 'text') applyTextAutoSize(entry);
      if (entry.data.type === 'rectangle') autoGrowRectangleTextarea(entry);
      if (entry.data.type === 'note') autoGrowNoteOnInput(entry);
      clearTimeout(textSaveTimer);
      textSaveTimer = setTimeout(() => {
        const patch = { text: textEl.value };
        if (entry.data.type === 'text' || entry.data.type === 'note') { patch.width = entry.data.width; patch.height = entry.data.height; }
        Api.updateElement(id, patch).catch(() => {});
      }, 600);
    });
    textEl.addEventListener('blur', () => { clearTimeout(textSaveTimer); stopEditing(true); });
    const canHaveLink = data.type === 'rectangle' || data.type === 'text';
    textEl.addEventListener('pointerdown', (e) => {
      if (el.classList.contains('is-editing')) { e.stopPropagation(); return; }
      // Un rectangle/texte avec un lien : cliquer PILE sur le texte l'ouvre plutôt que de démarrer un
      // glisser/passer en édition (cf. le clic ci-dessous) — un double-clic reste possible pour
      // éditer, "dblclick" étant un évènement distinct qui continue de remonter jusqu'à l'élément.
      if (canHaveLink && data.link) e.stopPropagation();
    });
    if (canHaveLink) {
      textEl.addEventListener('click', (e) => {
        if (!entry.data.link || el.classList.contains('is-editing')) return;
        if (e.detail > 1) return; // laisse le double-clic (dblclick) déclencher l'édition à la place
        e.preventDefault();
        const raw = entry.data.link.trim();
        const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
        window.open(url, '_blank', 'noopener');
      });
    }

    entry.enterEditing = function enterEditing() {
      if (entry.data.locked) return;
      selectElement(id);
      editingElementId = id;
      el.classList.add('is-editing');
      // Capturé une seule fois par session d'édition (pas à chaque appel, si enterEditing est
      // rappelé sans être ressorti d'édition entre-temps) — cf. stopEditing pour l'annulation.
      if (textEl.dataset.undoBefore === undefined) {
        textEl.dataset.undoBefore = textEl.value;
        textEl.dataset.undoBeforeW = entry.data.width;
        textEl.dataset.undoBeforeH = entry.data.height;
      }
      // Éditer un élément ne doit pas changer son état (premier plan, etc.) tout seul — seule une
      // action explicite (le menu "⋮") le fait, cf. wireMoreMenu.
      requestAnimationFrame(() => textEl.focus());
    };
  }

  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Généralise wireTextEditing aux blocs à PLUSIEURS champs indépendants (consigne : numéro/titre/
  // description ; tips : tag/titre/texte riche) — chacun a son propre état "en édition" (posé sur LE
  // CHAMP lui-même, pas sur l'élément entier comme pour un champ unique) : au repos, pointer-events:none
  // le laisse traversé par le clic (glisser/sélection normale de l'élément, cf. .block-field dans
  // board.css) ; l'activer (clic dessus pendant qu'il l'est déjà, ou double-clic dessus au repos via la
  // recherche géométrique ci-dessous) lui rend l'interactivité et y place le focus.
  // `fields`: [{ key, el, column, dataKey, rich, autoGrow }] — column = nom de champ API (text/title/
  // number/tag), dataKey = clé correspondante dans entry.data, rich = true pour le contenteditable
  // (innerHTML plutôt que .value), autoGrow = fonction(entry) rappelée après une frappe dans ce champ.
  function wireMultiFieldEditing(entry, fields, defaultKey) {
    // entry.data (jamais une variable "data" figée par déstructuration) : un écho serveur de CE MÊME
    // client (cf. applyRemoteUpdate) réassigne entry.data à un tout nouvel objet en cours d'édition —
    // une référence capturée une fois au câblage se retrouverait orpheline, déconnectée de l'objet que
    // l'auto-grow (autoGrowInstructionBlock/autoGrowTipBlock) continue, lui, de muter via "entry".
    const id = entry.data.id;

    function fieldValue(f) { return f.rich ? f.el.innerHTML : f.el.value; }

    function saveField(f, immediate) {
      const value = fieldValue(f);
      entry.data[f.dataKey] = value;
      // Sauvegarde immédiate (sortie de champ) mais rien de changé depuis l'entrée en édition : ne RIEN
      // renvoyer, cf. wireTextEditing pour la raison précise (un PATCH ici, même sans effet, peut faire
      // ignorer comme "dépassée" une annulation en cours pour ce même élément — Cmd+Z sur champ propre).
      if (immediate) {
        clearTimeout(f._saveTimer);
        if (f.el.dataset.undoBefore === value) return;
      }
      const patch = { [f.column]: value };
      // Un champ dont la frappe fait grandir tout le bloc (description/titre) doit persister la
      // nouvelle taille avec lui, comme pour le post-it/texte libre (cf. wireTextEditing).
      if (f.autoGrow) { patch.width = entry.data.width; patch.height = entry.data.height; }
      if (immediate) { Api.updateElement(id, patch).catch(() => {}); return; }
      clearTimeout(f._saveTimer);
      f._saveTimer = setTimeout(() => Api.updateElement(id, patch).catch(() => {}), 600);
    }

    function stopField(f) {
      f.el.classList.remove('is-field-editing');
      if (editingElementId === id) editingElementId = null;
      if (f.rich && activeRichField && activeRichField.el === f.el) { activeRichField = null; hideRichTextToolbar(); }
      // Un seul cran d'annulation pour toute la session d'édition de CE champ (cf. wireTextEditing,
      // même principe) — jamais par frappe, et seulement si sa valeur a vraiment changé.
      const before = f.el.dataset.undoBefore;
      const after = fieldValue(f);
      if (before !== undefined && before !== after) {
        const patch = { [f.column]: before };
        if (f.autoGrow) { patch.width = Number(f.el.dataset.undoBeforeW); patch.height = Number(f.el.dataset.undoBeforeH); }
        recordUndo(() => Api.updateElement(id, patch).then(applyRemoteUpdate).catch(() => {}));
      }
      delete f.el.dataset.undoBefore;
    }

    fields.forEach((f) => {
      f.el.addEventListener('pointerdown', (e) => {
        if (f.el.classList.contains('is-field-editing')) e.stopPropagation();
      });
      f.el.addEventListener('input', () => {
        // Un contenteditable vidé de tout son texte garde souvent un "<br>" orphelin (quirk connu des
        // navigateurs) — sans ce nettoyage, le champ ne redeviendrait jamais ":empty" et perdrait
        // définitivement son placeholder (cf. board.css) après une première frappe puis un retour à vide.
        if (f.rich && f.el.innerHTML === '<br>') f.el.innerHTML = '';
        entry.data[f.dataKey] = fieldValue(f);
        if (f.autoGrow) f.autoGrow(entry);
        saveField(f, false);
      });
      f.el.addEventListener('blur', () => {
        if (f.rich) {
          // Cliquer "Lien" déplace le focus vers son propre champ URL, DANS la mini-barre de
          // sélection (cf. showRichLinkInput) — un blur normal, mais qui ne doit pas couper l'édition
          // ici. On tranche donc un tick plus tard, une fois le focus retombé quelque part de stable.
          setTimeout(() => {
            if (richTextToolbarEl.contains(document.activeElement)) return;
            saveField(f, true);
            stopField(f);
          }, 0);
          return;
        }
        saveField(f, true);
        stopField(f);
      });
      if (f.rich) {
        f.el.addEventListener('focus', () => {
          // onStop : filet de rattrapage si le champ URL de la mini-barre (cf. showRichLinkInput) est
          // abandonné sans valider — son propre blur n'a alors aucun moyen de retrouver CE champ-ci
          // autrement que via activeRichField, qui porte justement ce rappel.
          activeRichField = { entry, el: f.el, onStop: () => { saveField(f, true); stopField(f); } };
        });
      }
    });

    entry.enterField = function enterField(key) {
      if (entry.data.locked) return;
      selectElement(id);
      editingElementId = id;
      const target = fields.find(f => f.key === key) || fields.find(f => f.key === defaultKey);
      fields.forEach(f => f.el.classList.toggle('is-field-editing', f === target));
      // Capturé une seule fois par session d'édition de ce champ — cf. stopField pour l'annulation.
      if (target.el.dataset.undoBefore === undefined) {
        target.el.dataset.undoBefore = fieldValue(target);
        target.el.dataset.undoBeforeW = entry.data.width;
        target.el.dataset.undoBeforeH = entry.data.height;
      }
      // Éditer un champ ne doit pas changer l'état de l'élément (premier plan, etc.) tout seul — seule
      // une action explicite (le menu "⋮") le fait, cf. wireMoreMenu.
      requestAnimationFrame(() => {
        target.el.focus();
        // Seulement s'il est vide (rien à cliquer dessus, donc rien que le natif puisse positionner) :
        // sur un champ qui a déjà du texte, cet appel arrivant après coup (rAF) écraserait sinon une
        // sélection de mot que le double-clic natif venait tout juste de faire (le focus() du dessus
        // ne perturbe rien puisqu'il est déjà focus au 2e clic, mais forcer le curseur à la fin, lui,
        // annule silencieusement cette sélection).
        if (target.rich && !target.el.textContent) placeCaretAtEnd(target.el);
      });
    };

    // Cliquer/double-cliquer sur l'élément (hors champ actif) n'indique pas QUEL champ éditer — la
    // géométrie du clic (toujours disponible même si le champ visé a pointer-events:none, cf. plus
    // haut) tranche : celui dont le rectangle contient le point cliqué, ou le champ par défaut sinon.
    entry.enterEditing = function enterEditing(ev) {
      let key = defaultKey;
      if (ev && typeof ev.clientY === 'number') {
        const hit = fields.find((f) => {
          const r = f.el.getBoundingClientRect();
          return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
        });
        if (hit) key = hit.key;
      }
      entry.enterField(key);
    };
  }

  // Sauvegarde toute l'arborescence d'un coup (sérialisation de entry.arboTree dans `text`) — jamais
  // nœud par nœud, puisque c'est l'élément ENTIER qui porte le JSON (cf. ELEMENT_DEFAULTS.arbo côté
  // serveur). Envoie aussi width/height : une frappe peut faire grandir/rétrécir tout le bloc
  // (cf. autoFitArboHeight), comme un champ à autoGrow ailleurs.
  function saveArboTree(entry, immediate) {
    const json = JSON.stringify(entry.arboTree);
    entry.data.text = json;
    const patch = { text: json, width: entry.data.width, height: entry.data.height };
    clearTimeout(entry._arboSaveTimer);
    if (immediate) { Api.updateElement(entry.data.id, patch).catch(() => {}); return; }
    entry._arboSaveTimer = setTimeout(() => Api.updateElement(entry.data.id, patch).catch(() => {}), 600);
  }

  // Un seul cran d'annulation par session d'édition d'un CHAMP (titre ou texte riche d'un nœud),
  // jamais par frappe — même principe que wireTextEditing/wireMultiFieldEditing, mais la valeur
  // restaurée vit dans un nœud au sein de l'arbre plutôt que directement sur entry.data : la
  // fermeture retrouve ce nœud par id (il peut avoir changé de place, pas d'existence, cf. le
  // mécanisme de suppression) et renvoie tout l'arbre plutôt qu'un seul champ.
  function pushArboFieldUndo(entry, nodeId, field, before, after) {
    if (before === after) return;
    recordUndo(() => {
      const node = findArboNode(entry.arboTree, nodeId);
      if (!node) return Promise.resolve();
      node[field] = before;
      renderArboBody(entry);
      const json = JSON.stringify(entry.arboTree);
      entry.data.text = json;
      return Api.updateElement(entry.data.id, { text: json, width: entry.data.width, height: entry.data.height }).then(applyRemoteUpdate).catch(() => {});
    });
  }

  // Bascule UN champ (titre ou texte riche) d'un nœud en édition, en retirant cet état de tous les
  // autres — même principe que wireMultiFieldEditing, mais sur un ensemble de champs qui change avec
  // la structure de l'arbre (ajout/suppression de nœud), d'où une recherche DOM fraîche plutôt qu'une
  // liste figée au câblage.
  function enterArboField(entry, fieldEl) {
    if (!fieldEl) return;
    editingElementId = entry.data.id;
    entry.el.querySelectorAll('.arbo-node-title.is-field-editing, .arbo-node-body.is-field-editing').forEach((el) => {
      el.classList.remove('is-field-editing');
    });
    fieldEl.classList.add('is-field-editing');
    // Capturé une seule fois par session d'édition — cf. pushArboFieldUndo. Posé aussi (de façon
    // idempotente) dans le "focusin" de wireArboTree, pour le cas où le focus arrive par Tab plutôt
    // que par ce chemin.
    if (fieldEl.dataset.undoBefore === undefined) {
      fieldEl.dataset.undoBefore = fieldEl.classList.contains('arbo-node-body') ? fieldEl.innerHTML : fieldEl.value;
    }
    requestAnimationFrame(() => {
      fieldEl.focus();
      if (fieldEl.classList.contains('arbo-node-body') && !fieldEl.textContent) placeCaretAtEnd(fieldEl);
    });
  }

  // Câblage d'un bloc "arbo" : délégué sur le conteneur entier (plutôt qu'un câblage par champ comme
  // wireMultiFieldEditing) puisque l'ensemble des nœuds change dynamiquement — un ajout/suppression
  // reconstruit tout le DOM (renderArboBody) sans avoir à re-câbler quoi que ce soit après coup.
  function wireArboTree(entry) {
    const root = entry.el.querySelector('.arbo-root');
    if (!root) return;

    root.addEventListener('pointerdown', (e) => {
      // Sans ce stop, le pointerdown remonte jusqu'à wireBodyDrag (cf. plus bas) qui sélectionne déjà
      // l'élément et, faute de glisser détecté, appelle entry.enterEditing au relâchement — avant même
      // que le "click" des boutons +/corbeille n'ait sa chance de s'exécuter (même principe que le
      // bouton "afficher l'auteur" d'une pile de post-its, cf. wireStackDrag).
      if (e.target.closest('.arbo-node-title.is-field-editing, .arbo-node-body.is-field-editing, .arbo-add-btn, .arbo-delete-btn')) e.stopPropagation();
    });

    // Partagé entre le focusout normal du corps riche et onStop (cf. activeRichField ci-dessous) :
    // sort proprement de l'édition et pousse un cran d'annulation si le texte a changé.
    function finishArboBodyEdit(bodyEl) {
      bodyEl.classList.remove('is-field-editing');
      if (activeRichField && activeRichField.el === bodyEl) { activeRichField = null; hideRichTextToolbar(); }
      if (!root.contains(document.activeElement) && editingElementId === entry.data.id) editingElementId = null;
      const nodeId = bodyEl.closest('.arbo-node').dataset.nodeId;
      const before = bodyEl.dataset.undoBefore;
      const changed = before !== undefined && before !== bodyEl.innerHTML;
      if (changed) pushArboFieldUndo(entry, nodeId, 'body', before, bodyEl.innerHTML);
      delete bodyEl.dataset.undoBefore;
      // Rien de changé : ne rien renvoyer (cf. wireTextEditing — évite de concurrencer une annulation
      // en cours pour ce même élément quand on quitte un champ propre, ex. Cmd+Z juste après un clic).
      if (changed) saveArboTree(entry, true);
    }

    root.addEventListener('focusin', (e) => {
      const titleEl = e.target.closest('.arbo-node-title');
      const bodyEl = e.target.closest('.arbo-node-body');
      if (titleEl) {
        titleEl.classList.add('is-field-editing');
        editingElementId = entry.data.id;
        if (titleEl.dataset.undoBefore === undefined) titleEl.dataset.undoBefore = titleEl.value;
      }
      if (bodyEl) {
        bodyEl.classList.add('is-field-editing');
        editingElementId = entry.data.id;
        if (bodyEl.dataset.undoBefore === undefined) bodyEl.dataset.undoBefore = bodyEl.innerHTML;
        const nodeId = bodyEl.closest('.arbo-node').dataset.nodeId;
        activeRichField = {
          entry,
          el: bodyEl,
          onChange: (html) => {
            const node = findArboNode(entry.arboTree, nodeId);
            if (!node) return;
            node.body = html;
            saveArboTree(entry, false);
          },
          // Filet de rattrapage si le champ URL de la mini-barre (cf. showRichLinkInput) est abandonné
          // sans valider : son propre blur ne peut retrouver CE champ qu'via activeRichField.
          onStop: () => finishArboBodyEdit(bodyEl),
        };
      }
    });

    root.addEventListener('focusout', (e) => {
      const titleEl = e.target.closest('.arbo-node-title');
      const bodyEl = e.target.closest('.arbo-node-body');
      if (titleEl) {
        setTimeout(() => {
          if (root.contains(document.activeElement)) return;
          titleEl.classList.remove('is-field-editing');
          if (editingElementId === entry.data.id) editingElementId = null;
          const nodeId = titleEl.closest('.arbo-node').dataset.nodeId;
          const before = titleEl.dataset.undoBefore;
          const changed = before !== undefined && before !== titleEl.value;
          if (changed) pushArboFieldUndo(entry, nodeId, 'title', before, titleEl.value);
          delete titleEl.dataset.undoBefore;
          // Rien de changé : ne rien renvoyer (cf. wireTextEditing — évite de concurrencer une
          // annulation en cours pour ce même élément quand on quitte un champ propre).
          if (changed) saveArboTree(entry, true);
        }, 0);
      }
      if (bodyEl) {
        // Même report d'un tick que wireMultiFieldEditing : cliquer "Lien" déplace le focus vers son
        // propre champ URL dans la mini-barre, pas une vraie fin d'édition.
        setTimeout(() => {
          if (richTextToolbarEl.contains(document.activeElement)) return;
          finishArboBodyEdit(bodyEl);
        }, 0);
      }
    });

    root.addEventListener('input', (e) => {
      const titleEl = e.target.closest('.arbo-node-title');
      if (titleEl) {
        const node = findArboNode(entry.arboTree, titleEl.closest('.arbo-node').dataset.nodeId);
        if (node) node.title = titleEl.value;
        autoGrowTextareaField(titleEl);
        autoFitArboHeight(entry);
        saveArboTree(entry, false);
        return;
      }
      const bodyEl = e.target.closest('.arbo-node-body');
      if (bodyEl) {
        // Cf. wireMultiFieldEditing : un contenteditable vidé garde parfois un "<br>" orphelin, qui lui
        // ferait perdre son placeholder (cf. :empty dans board.css) même une fois réellement vide.
        if (bodyEl.innerHTML === '<br>') bodyEl.innerHTML = '';
        onRichFieldChanged();
        autoFitArboHeight(entry);
      }
    });

    root.addEventListener('click', (e) => {
      const addBtn = e.target.closest('.arbo-add-btn');
      if (addBtn) {
        e.stopPropagation();
        if (entry.data.locked) return;
        const node = findArboNode(entry.arboTree, addBtn.closest('.arbo-node').dataset.nodeId);
        if (!node) return;
        const child = newArboNode();
        node.children.push(child);
        saveArboTree(entry, true);
        renderArboBody(entry);
        const newTitleEl = entry.el.querySelector(`.arbo-node[data-node-id="${child.id}"] > .arbo-node-box > .arbo-node-title`);
        enterArboField(entry, newTitleEl);
        recordUndo(() => {
          removeArboNode(entry.arboTree, child.id);
          renderArboBody(entry);
          const json = JSON.stringify(entry.arboTree);
          entry.data.text = json;
          return Api.updateElement(entry.data.id, { text: json, width: entry.data.width, height: entry.data.height }).then(applyRemoteUpdate).catch(() => {});
        });
        return;
      }
      const delBtn = e.target.closest('.arbo-delete-btn');
      if (delBtn) {
        e.stopPropagation();
        if (entry.data.locked) return;
        const nodeId = delBtn.closest('.arbo-node').dataset.nodeId;
        showArboDeleteConfirm(entry, nodeId, delBtn.getBoundingClientRect());
      }
    });

    // Même géométrie de clic que wireMultiFieldEditing (le champ dont le rectangle contient le point
    // cliqué), mais recherchée à chaud : l'ensemble des champs change avec la structure de l'arbre.
    entry.enterEditing = function enterEditing(ev) {
      if (entry.data.locked) return;
      selectElement(entry.data.id);
      const fields = [...entry.el.querySelectorAll('.arbo-node-title, .arbo-node-body')];
      let target = fields[0];
      if (ev && typeof ev.clientY === 'number') {
        const hit = fields.find((f) => {
          const r = f.getBoundingClientRect();
          return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
        });
        if (hit) target = hit;
      }
      enterArboField(entry, target);
    };
  }

  // ---------- Mini barre de mise en forme sur sélection (texte riche du bloc "tips") ----------
  // Contrairement à la barre d'action principale (au-dessus de l'ÉLÉMENT sélectionné), celle-ci
  // apparaît au-dessus de la SÉLECTION DE TEXTE elle-même, façon Notion/Medium — seulement pendant
  // qu'on édite le texte riche d'un bloc "tips" et qu'une portion de texte y est sélectionnée.
  let activeRichField = null; // { entry, el } du champ .tip-rich actuellement en édition, ou null

  function richTextToolbarHtml() {
    return `
      <button type="button" class="element-format-btn" data-rt="bold" title="Gras">B</button>
      <button type="button" class="element-format-btn is-italic" data-rt="italic" title="Italique">I</button>
      <button type="button" class="element-format-btn is-underline" data-rt="underline" title="Souligné">U</button>
      <button type="button" class="element-format-btn is-strike" data-rt="strikeThrough" title="Barré">S</button>
      <span class="element-toolbar-sep"></span>
      <button type="button" class="toolbar-dropdown-trigger" data-rt="link" title="Lien">${iconLinkChain()}</button>
    `;
  }

  function onRichFieldChanged() {
    if (!activeRichField) return;
    const { entry, el, onChange } = activeRichField;
    // Un champ riche d'arborescence (cf. wireArboTree) n'est pas directement `entry.data.text` — il
    // fournit son propre callback plutôt que ce comportement par défaut (un seul champ riche = tout
    // le "text" de l'élément, vrai pour "tips"/"page web" mais pas pour un nœud parmi d'autres ici).
    if (onChange) { onChange(el.innerHTML); return; }
    entry.data.text = el.innerHTML;
    Api.updateElement(entry.data.id, { text: el.innerHTML }).catch(() => {});
  }

  function showRichLinkInput() {
    const sel = window.getSelection();
    const savedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    richTextToolbarEl.innerHTML = `
      <input type="text" class="toolbar-link-input" data-role="rt-link-input" placeholder="https://…">
      <button type="button" class="primary-btn toolbar-link-apply" data-role="rt-link-apply">OK</button>
    `;
    const input = richTextToolbarEl.querySelector('[data-role="rt-link-input"]');
    const applyBtn = richTextToolbarEl.querySelector('[data-role="rt-link-apply"]');
    const richField = activeRichField;
    input.addEventListener('mousedown', e => e.stopPropagation());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyBtn.click(); });
    // Le champ URL abandonné (clic ailleurs sans valider) : referme simplement la mini-barre — un tick
    // plus tard, comme pour le blur du texte riche lui-même, pour laisser un clic sur "OK" (qui déplace
    // aussi le focus) passer avant ce contrôle. Si le focus n'est pas non plus revenu sur le champ
    // riche lui-même (l'utilisateur a cliqué ailleurs sur le tableau), celui-ci ne ressortira jamais
    // de lui-même d'édition (son propre blur, lors du clic vers CE champ URL, s'était déjà arrêté en
    // le voyant dans la mini-barre, cf. wireMultiFieldEditing/wireArboTree) : onStop le fait ici, sans
    // quoi editingElementId et activeRichField resteraient bloqués indéfiniment.
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (richTextToolbarEl.contains(document.activeElement)) return;
        hideRichTextToolbar();
        if (richField && document.activeElement !== richField.el && richField.onStop) richField.onStop();
      }, 0);
    });
    applyBtn.addEventListener('mousedown', e => e.preventDefault());
    applyBtn.addEventListener('click', () => {
      const raw = input.value.trim();
      if (raw && savedRange && richField) {
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(savedRange);
        const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
        document.execCommand('createLink', false, url);
        richField.el.querySelectorAll('a:not([target])').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
        onRichFieldChanged();
      }
      hideRichTextToolbar();
      // Revient à l'édition du texte riche (le clic sur "OK" avait déplacé le focus vers ce champ
      // URL, maintenant retiré du DOM) — pour pouvoir continuer à taper juste après avoir ajouté le lien.
      if (richField) richField.el.focus();
    });
    requestAnimationFrame(() => input.focus());
  }

  function ensureRichTextToolbarWired() {
    if (richTextToolbarEl.dataset.wired) return;
    richTextToolbarEl.dataset.wired = '1';
    // Empêche le focus/la sélection de sauter au clic sur un bouton de cette barre — sinon la
    // sélection de texte visée disparaît avant même que la commande ne s'applique.
    richTextToolbarEl.addEventListener('mousedown', (e) => { if (e.target.closest('[data-rt]')) e.preventDefault(); });
    richTextToolbarEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rt]');
      if (!btn || !activeRichField) return;
      const cmd = btn.dataset.rt;
      if (cmd === 'bold' || cmd === 'italic' || cmd === 'underline' || cmd === 'strikeThrough') {
        document.execCommand(cmd);
        onRichFieldChanged();
      } else if (cmd === 'link') {
        showRichLinkInput();
      }
    });
  }

  function positionRichTextToolbarAt(rect) {
    richTextToolbarEl.classList.add('is-open');
    const tRect = richTextToolbarEl.getBoundingClientRect();
    let top = rect.top - tRect.height - 8;
    if (top < 4) top = rect.bottom + 8;
    const left = clamp(rect.left, 4, window.innerWidth - tRect.width - 4);
    richTextToolbarEl.style.left = `${left}px`;
    richTextToolbarEl.style.top = `${top}px`;
  }

  function hideRichTextToolbar() {
    richTextToolbarEl.classList.remove('is-open');
    richTextToolbarEl.innerHTML = '';
    // Ne PAS effacer dataset.wired ici : le conteneur (richTextToolbarEl) est un nœud stable, jamais
    // recréé — seul son contenu (innerHTML) l'est à chaque réapparition. Le ré-effacer forcerait
    // ensureRichTextToolbarWired à rebrancher un second écouteur "click" délégué à chaque cycle
    // masquer/réafficher, qui s'accumulerait et déclencherait chaque commande plusieurs fois de suite.
  }

  function updateRichTextToolbarFromSelection() {
    if (!activeRichField) { hideRichTextToolbar(); return; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideRichTextToolbar(); return; }
    const range = sel.getRangeAt(0);
    if (!activeRichField.el.contains(range.commonAncestorContainer)) { hideRichTextToolbar(); return; }
    if (!richTextToolbarEl.innerHTML) {
      richTextToolbarEl.innerHTML = richTextToolbarHtml();
      ensureRichTextToolbarWired();
    }
    positionRichTextToolbarAt(range.getBoundingClientRect());
  }

  document.addEventListener('selectionchange', updateRichTextToolbarFromSelection);

  // Les éléments actuellement rattachés à une frame (déposés dedans, cf. containment côté serveur).
  function frameChildren(frameId) {
    const ids = [];
    elements.forEach((entry) => { if (entry.data.frameId === frameId) ids.push(entry.data.id); });
    return ids;
  }


  // Déplacement groupé : utilisé à la fois pour un déplacement multi-sélection (rectangle de
  // sélection) et pour un groupe permanent (grouper) — un geste sur un seul membre déplace tout le
  // lot ensemble.
  function activeGroupIdsFor(entry) {
    if (entry.data.groupId) {
      const members = groupMembers(entry.data.groupId);
      if (members.length > 1) return members;
    }
    if (multiSelectedIds.has(entry.data.id) && multiSelectedIds.size > 1) return [...multiSelectedIds];
    return null;
  }

  function startGroupDrag(ids, entry, e) {
    const isRealGroup = !!entry.data.groupId;
    const startScreen = { x: e.clientX, y: e.clientY };
    const startPositions = new Map();
    ids.forEach((mid) => {
      const en = elements.get(mid);
      if (en) startPositions.set(mid, { x: en.data.x, y: en.data.y });
    });
    let moved = false;
    let lastLive = 0;

    function onMove(ev) {
      const dxScreen = ev.clientX - startScreen.x;
      const dyScreen = ev.clientY - startScreen.y;
      if (!moved && (Math.abs(dxScreen) > 4 || Math.abs(dyScreen) > 4)) moved = true;
      if (!moved) return;
      // L'accrochage (grille + alignement) se calcule sur l'élément meneur du geste, puis le même
      // delta est appliqué à tout le lot — ça conserve leurs positions relatives entre eux.
      const leaderStart = startPositions.get(entry.data.id);
      let dxWorld = dxScreen / zoom, dyWorld = dyScreen / zoom;
      if (leaderStart) {
        const rawX = leaderStart.x + dxWorld, rawY = leaderStart.y + dyWorld;
        const snapped = applyDragSnap(entry.data.width, entry.data.height, rawX, rawY, new Set(ids), ev.altKey);
        dxWorld = snapped.x - leaderStart.x;
        dyWorld = snapped.y - leaderStart.y;
      }
      ids.forEach((mid) => {
        const en = elements.get(mid);
        const start = startPositions.get(mid);
        if (!en || !start) return;
        const nx = start.x + dxWorld;
        const ny = start.y + dyWorld;
        en.data.x = nx; en.data.y = ny;
        en.el.style.left = `${nx}px`; en.el.style.top = `${ny}px`;
        en.dragging = true;
        en.el.classList.add('is-dragging');
        // ".is-dragging" impose un z-index plat (9999 !important, cf. board.css) : très bien pour un
        // geste solo, mais à plusieurs éléments simultanés (frame + son contenu, groupe, multi-
        // sélection) cette même valeur aplatit leur ordre relatif — l'ordre visuel retombe alors sur
        // l'ordre d'insertion dans le DOM plutôt que sur le z-index réel, et une frame (censée rester
        // derrière) peut se retrouver au-dessus de son propre contenu pendant le geste (elle disparaît
        // dessous, puis "réapparaît" une fois le z-index réel restauré au relâchement). On fixe donc
        // ici un z-index qui conserve l'ordre relatif du groupe (en !important, pour battre cette
        // règle CSS), tout en le faisant flotter au-dessus de tout le reste.
        en.el.style.setProperty('z-index', String(DRAG_Z_BOOST + (en.data.zIndex || 0)), 'important');
        updateConnectorsFor(mid);
      });
      repositionMultiToolbar();
      // Le toolbar mono-sélection reste affiché (au lieu du toolbar multi) quand on glisse une frame
      // avec son contenu (cf. wireBodyDrag) : il faut donc aussi le suivre pendant le geste.
      if (selectedElementId === entry.data.id) repositionToolbar(entry);
      const now = Date.now();
      if (now - lastLive > 40) {
        lastLive = now;
        ids.forEach((mid) => { const en = elements.get(mid); if (en) Api.liveElement(mid, { x: en.data.x, y: en.data.y }); });
      }
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      hideGuides();
      ids.forEach((mid) => {
        const en = elements.get(mid);
        if (en) {
          en.el.classList.remove('is-dragging');
          en.el.style.removeProperty('z-index');
          en.el.style.zIndex = en.data.zIndex;
        }
        Api.cancelLiveElement(mid);
      });
      if (moved) {
        const beforeSnapshot = ids.map((mid) => ({ id: mid, ...startPositions.get(mid) })).filter(s => s.x !== undefined);
        // entry.dragging reste vrai jusqu'à la réponse : sinon un écho "element:dragging" encore en
        // vol (le dernier envoyé pendant le glisser) peut arriver après coup et écraser la position
        // définitive par une valeur intermédiaire plus ancienne.
        // Une seule requête groupée pour tout le lot plutôt qu'un PATCH par élément : ça évite que les
        // éléments arrivent à destination à des moments différents, et que deux d'entre eux se
        // disputent le même z_index (calculé indépendamment par élément avec bringToFront individuel).
        const moves = ids.map((mid) => {
          const en = elements.get(mid);
          return en ? { id: mid, x: en.data.x, y: en.data.y } : null;
        }).filter(Boolean);
        // bringToFront: false — glisser (même un peu, ce qu'un simple clic imprécis peut suffire à
        // déclencher) ne doit pas réordonner l'élément de façon permanente ; le voir par-dessus les
        // autres PENDANT le geste est déjà assuré visuellement par DRAG_Z_BOOST ci-dessus, sans toucher
        // à son z_index persisté.
        Api.updateElementsBatch(moves, false)
          .then(({ elements: updated, superseded, isLatest }) => {
            if (superseded) return; // un glisser plus récent du même lot a pris le relais avant l'envoi
            updated.forEach((data) => {
              const en = elements.get(data.id);
              if (en) en.dragging = false;
            });
            // Une réponse plus récente arrivera de toute façon : ne pas "rejouer" cette position
            // intermédiaire à l'écran pendant qu'on l'attend (cf. commentaire dans api.js).
            if (!isLatest) return;
            updated.forEach(applyRemoteUpdate);
            recordUndo(() => restoreMovedPositions(beforeSnapshot));
          })
          .catch(() => { ids.forEach((mid) => { const en = elements.get(mid); if (en) en.dragging = false; }); });
      } else {
        ids.forEach((mid) => { const en = elements.get(mid); if (en) en.dragging = false; });
        // Cas spécifique à une frame (cf. wireBodyDrag) : un simple clic (sans glisser) doit pouvoir
        // éditer son titre, comme pour un post-it/rectangle — sinon plus aucun moyen d'entrer en
        // édition puisque son glisser passe par ce chemin "groupe" plutôt que le glisser simple.
        if (entry.data.type === 'frame' && entry.enterEditing) {
          entry.enterEditing();
        } else if (!isRealGroup) {
          clearMultiSelection();
          selectElement(entry.data.id);
        }
      }
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function wireBodyDrag(entry) {
    const { el } = entry;
    const id = entry.data.id;
    let dragState = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.element-resize-handle') || e.target.closest('.element-line-handle') || e.target.closest('.connector-anchor')) return;
      if (e.metaKey || e.ctrlKey) {
        e.stopPropagation();
        closeConfirmPopover();
        toggleMultiSelect(id);
        return;
      }
      // Verrouillé : sélectionner (montre le toolbar "appui long pour déverrouiller") ET démarrer tout
      // de suite ce décompte sur l'élément lui-même — pas besoin de relâcher puis viser précisément le
      // bouton du toolbar, un appui long sur l'élément suffit (cf. startUnlockHold).
      if (entry.data.locked) {
        e.stopPropagation();
        selectElement(id);
        closeConfirmPopover();
        const unlockBtn = toolbarEl.querySelector('.unlock-hold-btn');
        if (unlockBtn) startUnlockHold(entry, unlockBtn, el);
        return;
      }
      if (entry.cropping) return;
      // Pas de garde sur is-editing ici : un clic sur le textarea lui-même stoppe déjà la
      // propagation (cf. wireTextEditing) quand on édite, donc seul un clic sur le bord — hors
      // textarea — arrive jusqu'ici, et il doit pouvoir démarrer un glisser même en édition.

      // Glisser une frame déplace son contenu avec elle — mais contrairement à un groupe permanent ou
      // une sélection multiple, ça reste une sélection SIMPLE de la frame (son propre toolbar reste
      // affiché, pas le toolbar multi) : on réutilise juste la mécanique de glisser groupé pour le
      // mouvement, sans passer par setMultiSelection.
      if (entry.data.type === 'frame') {
        e.stopPropagation();
        selectElement(id);
        closeConfirmPopover();
        const children = frameChildren(id);
        startGroupDrag(children.length ? [id, ...children] : [id], entry, e);
        return;
      }

      // Verrouillage toujours appliqué au groupe entier (jamais partiellement, cf. plus haut) : si on
      // arrive ici, l'élément n'est pas verrouillé, donc aucun de ses coéquipiers de groupe non plus.
      const groupIds = activeGroupIdsFor(entry);
      if (groupIds) {
        e.stopPropagation();
        closeConfirmPopover();
        setMultiSelection(groupIds);
        startGroupDrag(groupIds, entry, e);
        return;
      }

      e.stopPropagation();
      selectElement(id);
      closeConfirmPopover();
      dragState = {
        startScreen: { x: e.clientX, y: e.clientY },
        startWorld: { x: entry.data.x, y: entry.data.y },
        moved: false,
        pointerId: e.pointerId,
      };
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const dxScreen = e.clientX - dragState.startScreen.x;
      const dyScreen = e.clientY - dragState.startScreen.y;
      if (Math.abs(dxScreen) > 4 || Math.abs(dyScreen) > 4) dragState.moved = true;
      if (!dragState.moved) return;
      entry.dragging = true;
      el.classList.add('is-dragging');
      const rawX = dragState.startWorld.x + dxScreen / zoom;
      const rawY = dragState.startWorld.y + dyScreen / zoom;
      const snapped = applyDragSnap(entry.data.width, entry.data.height, rawX, rawY, new Set([id]), e.altKey);
      const newX = snapped.x, newY = snapped.y;
      entry.data.x = newX;
      entry.data.y = newY;
      el.style.left = `${newX}px`;
      el.style.top = `${newY}px`;
      repositionToolbar(entry);
      updateConnectorsFor(id);
      const now = Date.now();
      if (now - (entry._lastLive || 0) > 40) {
        entry._lastLive = now;
        Api.liveElement(id, { x: newX, y: newY });
      }
    });

    el.addEventListener('pointerup', (e) => {
      if (!dragState) return;
      const wasMoved = dragState.moved;
      el.releasePointerCapture(dragState.pointerId);
      const before = dragState.startWorld;
      dragState = null;
      el.classList.remove('is-dragging');
      hideGuides();
      Api.cancelLiveElement(id);
      if (wasMoved) {
        // Un élément seul passe aussi par le déplacement en lot (ici réduit à un seul id) plutôt que
        // par un PATCH direct : ça lui donne la même protection contre les glissers rapprochés qu'un
        // groupe (positions intermédiaires jamais envoyées, réponse ignorée si dépassée avant même de
        // partir) — utile aussi pour un seul élément dès que sa réponse est lourde (une image renvoyait
        // avant ça plusieurs Mo à chaque déplacement, cf. server.js, rendant l'aller-retour assez lent
        // pour que l'ordre d'arrivée cesse d'être fiable).
        // bringToFront: false — même raison que pour un glisser groupé (cf. plus haut) : un simple
        // clic peu précis suffit à déclencher un tout petit déplacement, qui ne doit pas pour autant
        // réordonner l'élément de façon permanente.
        Api.updateElementsBatch([{ id, x: entry.data.x, y: entry.data.y }], false)
          .then(({ elements: updated, superseded, isLatest }) => {
            if (superseded) return;
            entry.dragging = false;
            if (!isLatest) return;
            const data = updated[0];
            if (data) applyRemoteUpdate(data);
            recordUndo(() => restoreMovedPositions([{ id, x: before.x, y: before.y }]));
          })
          .catch(() => { entry.dragging = false; });
      } else {
        entry.dragging = false;
        if (entry.enterEditing) entry.enterEditing(e);
      }
    });

    // Double-clic : entre en édition même si l'élément appartient à un groupe (sinon un clic simple
    // sur un membre de groupe sélectionne toujours tout le groupe, sans moyen d'éditer son texte).
    if (entry.enterEditingBypassGroup !== false) {
      el.addEventListener('dblclick', (e) => {
        if (entry.data.locked || !entry.enterEditing) return;
        e.stopPropagation();
        clearMultiSelection();
        entry.enterEditing(e);
      });
    }
  }

  // Reflow visuel immédiat (DOM seulement, rien envoyé au serveur) d'une frame "mosaïque PDF" pendant
  // qu'on la redimensionne, pour voir les colonnes s'ajouter/se supprimer en direct plutôt que d'attendre
  // la réponse du serveur au relâchement (cf. wireCornerResize). Même algorithme que applyFrameArrange
  // ment côté serveur (padding, ordre de lecture, retour à la ligne) : au relâchement, sa réponse
  // authentique ne devrait donc produire aucun saut visible, juste confirmer ce qui est déjà affiché.
  // `children` doit être dans l'ordre de lecture, figé une fois pour toutes au début du geste (cf.
  // resizeState.mosaicChildren) — le recalculer à chaque frame d'après une position qu'on vient tout
  // juste de réécrire ferait flotter l'ordre au lieu de le garder stable.
  function liveReflowMosaic(frameEntry, children, newWidth) {
    const padding = PDF_MOSAIC_PADDING;
    const maxX = Math.max(newWidth - padding, padding + 40);
    let cursorX = padding, cursorY = FRAME_TITLE_HEIGHT + padding, rowHeight = 0, placedInRow = 0;
    children.forEach((child) => {
      if (placedInRow > 0 && (cursorX + child.data.width) > maxX) {
        cursorY += rowHeight + padding;
        cursorX = padding;
        rowHeight = 0;
        placedInRow = 0;
      }
      const x = frameEntry.data.x + cursorX;
      const y = frameEntry.data.y + cursorY;
      child.data.x = x;
      child.data.y = y;
      child.el.style.left = `${x}px`;
      child.el.style.top = `${y}px`;
      cursorX += child.data.width + padding;
      rowHeight = Math.max(rowHeight, child.data.height);
      placedInRow++;
    });
    return Math.max(FRAME_MIN_HEIGHT, cursorY + rowHeight + padding);
  }

  // Pile de post-its : glisser DEPUIS le visuel (pas depuis le titre/le reste de la carte, qui bougent
  // la pile comme n'importe quel élément via wireBodyDrag) détache un post-it tout neuf sous le
  // curseur, posé où on relâche — la pile elle-même ne bouge jamais et n'est jamais "consommée". Un
  // simple clic (sans dépasser le seuil de déplacement) ne fait rien de plus que sélectionner la pile,
  // rien à détacher.
  function wireStackDrag(entry) {
    const visual = entry.el.querySelector('.stack-postit-visual');
    if (!visual) return;
    let dragState = null;

    visual.addEventListener('pointerdown', (e) => {
      // Le verrouillage protège la pile (position/taille), pas la prise d'un post-it :
      // on stoppe toujours la propagation pour ne pas retomber sur le "appui long pour
      // déverrouiller" de wireBodyDrag, mais on ne sélectionne/affiche sa toolbar que si déverrouillée.
      e.stopPropagation();
      if (!entry.data.locked) {
        selectElement(entry.data.id);
        closeConfirmPopover();
      }
      dragState = { startScreen: { x: e.clientX, y: e.clientY }, moved: false, pointerId: e.pointerId };
      visual.setPointerCapture(e.pointerId);
    });

    visual.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      if (!dragState.moved) {
        if (Math.hypot(e.clientX - dragState.startScreen.x, e.clientY - dragState.startScreen.y) < 6) return;
        dragState.moved = true;
        // Choisie une seule fois par glisser (pas à chaque pointermove ni recalculée au dépôt), pour
        // que le post-it montré pendant le geste soit bien celui effectivement déposé.
        dragState.color = pickStackNoteColor(entry);
        dragState.ghost = document.createElement('div');
        dragState.ghost.className = 'stack-pull-ghost';
        dragState.ghost.style.width = `${NOTE_DEFAULT_SIZE}px`;
        dragState.ghost.style.height = `${NOTE_DEFAULT_SIZE}px`;
        dragState.ghost.style.background = dragState.color;
        document.body.appendChild(dragState.ghost);
      }
      dragState.ghost.style.left = `${e.clientX - NOTE_DEFAULT_SIZE / 2}px`;
      dragState.ghost.style.top = `${e.clientY - NOTE_DEFAULT_SIZE / 2}px`;
      viewportEl.classList.toggle('is-drop-target', isPointOverCanvas(e.clientX, e.clientY));
    });

    visual.addEventListener('pointerup', (e) => {
      if (!dragState) return;
      visual.releasePointerCapture(dragState.pointerId);
      const wasMoved = dragState.moved;
      const color = dragState.color;
      if (dragState.ghost) dragState.ghost.remove();
      viewportEl.classList.remove('is-drop-target');
      dragState = null;
      if (!wasMoved || !isPointOverCanvas(e.clientX, e.clientY)) return;
      const r = viewportEl.getBoundingClientRect();
      const { x: wx, y: wy } = screenToWorld(e.clientX - r.left, e.clientY - r.top);
      const { x, y } = snapPoint(wx - NOTE_DEFAULT_SIZE / 2, wy - NOTE_DEFAULT_SIZE / 2);
      const payload = { type: 'note', x, y, width: NOTE_DEFAULT_SIZE, height: NOTE_DEFAULT_SIZE, color };
      // `title` réutilisé pour le nom de l'auteur (cf. ELEMENT_DEFAULTS.stack côté serveur) — seulement
      // si "Afficher l'auteur" est actif sur CETTE pile (entry.data.grayscale).
      if (entry.data.grayscale && myName) payload.title = myName;
      createElementTracked(payload).catch(err => alert(err.message));
    });
  }

  function wireCornerResize(entry) {
    const handle = entry.el.querySelector('.element-resize-handle');
    if (!handle) return;
    const aspectLocked = entry.data.type === 'image';
    let resizeState = null;

    handle.addEventListener('pointerdown', (e) => {
      if (entry.cropping || entry.data.locked) return;
      e.stopPropagation();
      selectElement(entry.data.id);
      const isMosaic = entry.data.type === 'frame' && entry.data.tag === 'pdf-mosaic';
      resizeState = {
        startScreen: { x: e.clientX, y: e.clientY },
        startSize: { w: entry.data.width, h: entry.data.height },
        pointerId: e.pointerId,
        isMosaic,
        // Même principe que la mosaïque PDF juste au-dessus : largeur seule pilotée au glisser, la
        // hauteur reste toujours celle que le contenu impose (cf. autoFitArboHeight) — "resizer tout
        // l'élément, pas cadre par cadre" ne concerne que la largeur, la hauteur n'a pas de sens à
        // régler à la main pour un arbre dont le nombre de nœuds varie.
        isArbo: entry.data.type === 'arbo',
        // Ordre de lecture figé une fois pour toutes au début du geste (cf. liveReflowMosaic) — le
        // recalculer à chaque frame d'après une position qu'on vient tout juste de réécrire ferait
        // flotter l'ordre au lieu de le garder stable.
        mosaicChildren: isMosaic
          ? frameChildren(entry.data.id).map(id => elements.get(id)).filter(Boolean).sort((a, b) => a.data.y - b.data.y || a.data.x - b.data.x)
          : null,
      };
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!resizeState) return;
      entry.resizing = true;
      entry.el.classList.add('is-resizing');
      const dxScreen = e.clientX - resizeState.startScreen.x;
      const dyScreen = e.clientY - resizeState.startScreen.y;
      let newW = Math.max(MIN_W, resizeState.startSize.w + dxScreen / zoom);
      let newH;
      if (aspectLocked) {
        const ratio = resizeState.startSize.w / resizeState.startSize.h;
        newH = newW / ratio;
        if (newH < MIN_H) { newH = MIN_H; newW = newH * ratio; }
      } else if (resizeState.isMosaic) {
        // La largeur seule pilote le geste ; la hauteur est toujours DÉRIVÉE du contenu (jamais du
        // glisser vertical, cf. liveReflowMosaic plus bas) — le serveur l'écrase de toute façon au
        // relâchement (applyFrameArrangement), autant éviter que la frame tiraille entre la hauteur
        // glissée et celle que la mosaïque impose réellement.
        if (!e.altKey) newW = Math.max(MIN_W, snapToGrid(entry.data.x + newW) - entry.data.x);
      } else if (resizeState.isArbo) {
        if (!e.altKey) newW = Math.max(MIN_W, snapToGrid(entry.data.x + newW) - entry.data.x);
      } else {
        newH = Math.max(MIN_H, resizeState.startSize.h + dyScreen / zoom);
        // Accroche à la grille aussi en taille (pas seulement en position) — pas pour une image
        // (ratio verrouillé : arrondir indépendamment largeur/hauteur le déformerait). Accroche le
        // bord DÉPLACÉ (x+largeur/y+hauteur), pas juste la largeur/hauteur elles-mêmes : le coin
        // haut-gauche ne bouge pas pendant ce geste, donc accrocher la largeur seule ne suffit à
        // remettre le bord droit sur la grille que si x y était déjà — plutôt que de compter dessus,
        // on vise directement la position d'arrivée du bord.
        if (!e.altKey) {
          newW = Math.max(MIN_W, snapToGrid(entry.data.x + newW) - entry.data.x);
          newH = Math.max(MIN_H, snapToGrid(entry.data.y + newH) - entry.data.y);
        }
      }
      entry.data.width = newW;
      entry.el.style.width = `${newW}px`;
      // Reflow visuel immédiat des pages (cf. liveReflowMosaic) : la hauteur de la frame vient de là,
      // pas du glisser vertical (cf. ci-dessus) — colonnes qui s'ajoutent/se suppriment en direct,
      // plutôt que de découvrir la disposition finale seulement à la réponse du serveur.
      if (resizeState.isMosaic) newH = liveReflowMosaic(entry, resizeState.mosaicChildren, newW);
      if (resizeState.isArbo) { autoFitArboHeight(entry); newH = entry.data.height; }
      entry.data.height = newH;
      entry.el.style.height = `${newH}px`;
      syncNoteTextareaHeight(entry);
      repositionToolbar(entry);
      updateConnectorsFor(entry.data.id);
      if (resizeState.isMosaic) resizeState.mosaicChildren.forEach(c => updateConnectorsFor(c.data.id));
      const now = Date.now();
      if (now - (entry._lastLive || 0) > 40) {
        entry._lastLive = now;
        Api.liveElement(entry.data.id, { width: newW, height: newH });
      }
    });

    handle.addEventListener('pointerup', () => {
      if (!resizeState) return;
      handle.releasePointerCapture(resizeState.pointerId);
      const before = resizeState.startSize;
      const isMosaic = resizeState.isMosaic;
      resizeState = null;
      entry.el.classList.remove('is-resizing');
      Api.cancelLiveElement(entry.data.id);
      const patched = Api.updateElement(entry.data.id, { width: entry.data.width, height: entry.data.height, bringToFront: true })
        .then((data) => {
          entry.resizing = false;
          applyRemoteUpdate(data);
          const id = entry.data.id;
          recordUndo(() => Api.updateElement(id, { width: before.w, height: before.h }).then(applyRemoteUpdate).catch(() => {}));
        })
        .catch(() => { entry.resizing = false; });
      // Filet de sécurité pour une mosaïque PDF : l'aperçu live montre déjà la bonne disposition
      // pendant le geste, mais la confirmation du serveur (qui redistribue aussi le contenu, cf.
      // applyFrameArrangement) peut prendre un instant sur une connexion lente — l'indicateur "en
      // cours" existant (cf. withBusy) couvre ce cas sans qu'il faille un indicateur dédié.
      if (isMosaic) withBusy(patched);
    });
  }

  // Trait : une seule poignée à l'extrémité libre — la faire glisser change à la fois la longueur
  // et l'angle (comme dessiner une flèche), le point de départ (x,y) restant le pivot fixe.
  function wireLineHandle(entry) {
    const handle = entry.el.querySelector('.element-line-handle');
    if (!handle) return;
    let state = null;

    handle.addEventListener('pointerdown', (e) => {
      if (entry.data.locked) return;
      e.stopPropagation();
      selectElement(entry.data.id);
      state = { pointerId: e.pointerId, startWidth: entry.data.width, startRotation: entry.data.rotation };
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!state) return;
      entry.resizing = true;
      entry.el.classList.add('is-resizing');
      const { x: sx, y: sy } = getViewportPoint(e);
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const dx = wx - entry.data.x;
      const dy = wy - entry.data.y;
      const newWidth = Math.max(MIN_LINE_LENGTH, Math.hypot(dx, dy));
      const newRotation = Math.atan2(dy, dx) * (180 / Math.PI);
      entry.data.width = newWidth;
      entry.data.rotation = newRotation;
      entry.el.style.width = `${newWidth}px`;
      entry.el.style.transform = `rotate(${newRotation}deg)`;
      repositionToolbar(entry);
      const now = Date.now();
      if (now - (entry._lastLive || 0) > 40) {
        entry._lastLive = now;
        Api.liveElement(entry.data.id, { width: newWidth, rotation: newRotation });
      }
    });

    handle.addEventListener('pointerup', () => {
      if (!state) return;
      handle.releasePointerCapture(state.pointerId);
      const before = state;
      state = null;
      entry.el.classList.remove('is-resizing');
      Api.cancelLiveElement(entry.data.id);
      Api.updateElement(entry.data.id, { width: entry.data.width, rotation: entry.data.rotation, bringToFront: true })
        .then((data) => {
          entry.resizing = false;
          applyRemoteUpdate(data);
          const id = entry.data.id;
          recordUndo(() => Api.updateElement(id, { width: before.startWidth, rotation: before.startRotation }).then(applyRemoteUpdate).catch(() => {}));
        })
        .catch(() => { entry.resizing = false; });
    });
  }

  function wireConnectorSelect(entry) {
    const hit = entry.el.querySelector('.connector-hit');
    if (!hit) return;
    hit.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      closeConfirmPopover();
      if (e.metaKey || e.ctrlKey) { toggleMultiSelect(entry.data.id); return; }
      selectElement(entry.data.id);
    });
  }

  // Poignées de points de passage (cf. renderConnectorHandles) : déléguées sur le conteneur stable
  // `.connector-handles` plutôt que posées sur chaque poignée individuellement, puisque leur DOM est
  // entièrement reconstruit à chaque renderConnectorGeometry (y compris pendant CE glisser, pour
  // prévisualiser en direct) — un listener posé sur la poignée elle-même serait perdu dès la première
  // frame. Écoute `pointermove`/`pointerup` sur `window` pour la même raison (cf. startLinking/
  // startGroupDrag), pas de setPointerCapture (sans objet, le nœud peut disparaître entre deux frames).
  function wireConnectorHandles(entry) {
    const container = entry.el.querySelector('.connector-handles');
    if (!container) return;
    container.addEventListener('pointerdown', (e) => {
      if (entry.data.locked) return;
      const handle = e.target.closest('.connector-waypoint-handle, .connector-addpoint-handle');
      if (!handle) return;
      e.stopPropagation();
      const kind = handle.dataset.kind;
      const index = Number(handle.dataset.index);
      const beforeText = entry.data.text || '';
      const working = parseConnectorWaypoints(beforeText);
      let didInsert = false;
      let moved = false;
      const startScreen = { x: e.clientX, y: e.clientY };
      entry.dragging = true;

      function onMove(ev) {
        const dxScreen = ev.clientX - startScreen.x, dyScreen = ev.clientY - startScreen.y;
        if (!moved && (Math.abs(dxScreen) > 4 || Math.abs(dyScreen) > 4)) moved = true;
        if (!moved) return;
        const { x: sx, y: sy } = getViewportPoint(ev);
        let { x: wx, y: wy } = screenToWorld(sx, sy);
        if (!ev.altKey) { const snapped = snapPoint(wx, wy); wx = snapped.x; wy = snapped.y; }
        if (kind === 'add' && !didInsert) {
          working.splice(index, 0, { x: wx, y: wy });
          didInsert = true;
        } else {
          working[index] = { x: wx, y: wy };
        }
        entry.data.text = JSON.stringify(working);
        renderConnectorGeometry(entry);
      }

      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        entry.dragging = false;
        if (!moved) return;
        const id = entry.data.id;
        const finalText = entry.data.text;
        Api.updateElement(id, { text: finalText }).then(applyRemoteUpdate).catch(() => {});
        recordUndo(() => Api.updateElement(id, { text: beforeText }).then(applyRemoteUpdate).catch(() => {}));
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function wireElementInteractions(entry) {
    if (entry.data.type === 'connector') { wireConnectorSelect(entry); wireConnectorHandles(entry); wireConnectorLabel(entry); return; }
    if (entry.data.type === 'note' || entry.data.type === 'text' || entry.data.type === 'rectangle' || entry.data.type === 'frame' || entry.data.type === 'stack') wireTextEditing(entry);
    if (entry.data.type === 'instruction') {
      wireMultiFieldEditing(entry, [
        { key: 'number', el: entry.numberEl, column: 'number', dataKey: 'number' },
        { key: 'title', el: entry.titleEl, column: 'title', dataKey: 'title', autoGrow: autoGrowInstructionBlock },
        { key: 'desc', el: entry.descEl, column: 'text', dataKey: 'text', autoGrow: autoGrowInstructionBlock },
      ], 'title');
    }
    if (entry.data.type === 'tip') {
      wireMultiFieldEditing(entry, [
        { key: 'tag', el: entry.tagEl, column: 'tag', dataKey: 'tag' },
        { key: 'title', el: entry.titleEl, column: 'title', dataKey: 'title', autoGrow: autoGrowTipBlock },
        { key: 'rich', el: entry.richEl, column: 'text', dataKey: 'text', rich: true, autoGrow: autoGrowTipBlock },
      ], 'title');
      // Purement visuel (jamais persisté, cf. autoWidthTag) : pas un "autoGrow" au sens des autres
      // champs ci-dessus, qui persistent aussi width/height du bloc entier avec eux.
      if (entry.tagEl) entry.tagEl.addEventListener('input', () => autoWidthTag(entry.tagEl));
    }
    if (entry.data.type === 'webpage') {
      // Pas de 3e champ pour le type de page (contrairement au numéro/tag de consigne/tips) : le
      // wireframe n'est pas un texte éditable, il se change via le sélecteur du toolbar principal
      // (cf. buildToolbarHtml, data-role="pagetype").
      wireMultiFieldEditing(entry, [
        { key: 'title', el: entry.titleEl, column: 'title', dataKey: 'title', autoGrow: autoGrowWebpageBlock },
        { key: 'desc', el: entry.richEl, column: 'text', dataKey: 'text', rich: true, autoGrow: autoGrowWebpageBlock },
      ], 'title');
    }
    if (entry.data.type === 'stack') wireStackDrag(entry);
    if (entry.data.type === 'arbo') wireArboTree(entry);
    wireConnectorAnchors(entry);
    wireBodyDrag(entry);
    if (entry.data.type === 'line') wireLineHandle(entry);
    else if (entry.data.type !== 'text') wireCornerResize(entry);
  }

  // ---------- Rognage d'image ----------
  // Quatre poignées de bord (haut/bas/gauche/droite) plutôt qu'un rectangle déplaçable : combinées,
  // elles permettent d'atteindre n'importe quel sous-rectangle aligné sur les axes, pour une
  // interaction plus simple qu'un rectangle à la fois déplaçable et redimensionnable.

  function enterCropMode(entry) {
    if (entry.data.type !== 'image' || entry.cropping || entry.data.locked) return;
    closeConfirmPopover();
    hideToolbar();
    entry.cropping = true;
    entry.el.classList.add('is-cropping');

    const crop = { top: 0, right: 0, bottom: 0, left: 0 };
    entry._cropState = crop;

    const overlay = document.createElement('div');
    overlay.className = 'crop-overlay';
    overlay.innerHTML = `
      <div class="crop-mask crop-mask-top"></div>
      <div class="crop-mask crop-mask-bottom"></div>
      <div class="crop-mask crop-mask-left"></div>
      <div class="crop-mask crop-mask-right"></div>
      <div class="crop-rect-border"></div>
      <div class="crop-edge-handle crop-edge-top" data-edge="top"></div>
      <div class="crop-edge-handle crop-edge-bottom" data-edge="bottom"></div>
      <div class="crop-edge-handle crop-edge-left" data-edge="left"></div>
      <div class="crop-edge-handle crop-edge-right" data-edge="right"></div>
      <div class="crop-toolbar">
        <button type="button" class="crop-toolbar-btn crop-toolbar-cancel">Annuler</button>
        <button type="button" class="crop-toolbar-btn crop-toolbar-confirm">Rogner</button>
      </div>
    `;
    overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
    entry.el.appendChild(overlay);
    entry._cropOverlay = overlay;

    function render() {
      const w = entry.data.width, h = entry.data.height;
      overlay.querySelector('.crop-mask-top').style.cssText = `top:0; left:0; right:0; height:${crop.top}px;`;
      overlay.querySelector('.crop-mask-bottom').style.cssText = `bottom:0; left:0; right:0; height:${crop.bottom}px;`;
      overlay.querySelector('.crop-mask-left').style.cssText = `top:${crop.top}px; left:0; width:${crop.left}px; height:${h - crop.top - crop.bottom}px;`;
      overlay.querySelector('.crop-mask-right').style.cssText = `top:${crop.top}px; right:0; width:${crop.right}px; height:${h - crop.top - crop.bottom}px;`;
      overlay.querySelector('.crop-rect-border').style.cssText = `top:${crop.top}px; left:${crop.left}px; right:${crop.right}px; bottom:${crop.bottom}px;`;
      const midY = crop.top + (h - crop.top - crop.bottom) / 2;
      const midX = crop.left + (w - crop.left - crop.right) / 2;
      overlay.querySelector('.crop-edge-top').style.cssText = `top:${crop.top}px; left:${midX}px;`;
      overlay.querySelector('.crop-edge-bottom').style.cssText = `top:${h - crop.bottom}px; left:${midX}px;`;
      overlay.querySelector('.crop-edge-left').style.cssText = `left:${crop.left}px; top:${midY}px;`;
      overlay.querySelector('.crop-edge-right').style.cssText = `left:${w - crop.right}px; top:${midY}px;`;
    }
    render();

    overlay.querySelectorAll('.crop-edge-handle').forEach((handle) => {
      const edge = handle.dataset.edge;
      let state = null;
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        state = { startScreen: { x: e.clientX, y: e.clientY }, start: { ...crop } };
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', (e) => {
        if (!state) return;
        const dxWorld = (e.clientX - state.startScreen.x) / zoom;
        const dyWorld = (e.clientY - state.startScreen.y) / zoom;
        const w = entry.data.width, h = entry.data.height;
        if (edge === 'top') crop.top = clamp(state.start.top + dyWorld, 0, h - crop.bottom - MIN_CROP_SIZE);
        else if (edge === 'bottom') crop.bottom = clamp(state.start.bottom - dyWorld, 0, h - crop.top - MIN_CROP_SIZE);
        else if (edge === 'left') crop.left = clamp(state.start.left + dxWorld, 0, w - crop.right - MIN_CROP_SIZE);
        else if (edge === 'right') crop.right = clamp(state.start.right - dxWorld, 0, w - crop.left - MIN_CROP_SIZE);
        render();
      });
      handle.addEventListener('pointerup', (e) => {
        if (!state) return;
        handle.releasePointerCapture(e.pointerId);
        state = null;
      });
    });

    overlay.querySelector('.crop-toolbar-cancel').addEventListener('click', () => exitCropMode(entry));
    overlay.querySelector('.crop-toolbar-confirm').addEventListener('click', () => confirmCrop(entry));
  }

  function exitCropMode(entry) {
    if (entry._cropOverlay) { entry._cropOverlay.remove(); entry._cropOverlay = null; }
    entry.cropping = false;
    entry._cropState = null;
    entry.el.classList.remove('is-cropping');
    if (selectedElementId === entry.data.id) showToolbarFor(entry);
  }

  function confirmCrop(entry) {
    const crop = entry._cropState;
    const imgEl = entry.el.querySelector('.element-image-img');
    const displayW = entry.data.width, displayH = entry.data.height;
    const naturalW = imgEl.naturalWidth || displayW;
    const naturalH = imgEl.naturalHeight || displayH;
    const scaleX = naturalW / displayW;
    const scaleY = naturalH / displayH;

    const cropDisplayW = displayW - crop.left - crop.right;
    const cropDisplayH = displayH - crop.top - crop.bottom;
    const naturalX = Math.round(crop.left * scaleX);
    const naturalY = Math.round(crop.top * scaleY);
    const naturalCropW = Math.max(1, Math.round(cropDisplayW * scaleX));
    const naturalCropH = Math.max(1, Math.round(cropDisplayH * scaleY));

    const canvas = document.createElement('canvas');
    canvas.width = naturalCropW;
    canvas.height = naturalCropH;
    canvas.getContext('2d').drawImage(imgEl, naturalX, naturalY, naturalCropW, naturalCropH, 0, 0, naturalCropW, naturalCropH);
    const newImageData = canvas.toDataURL('image/png');

    const newX = entry.data.x + crop.left;
    const newY = entry.data.y + crop.top;
    const before = { imageData: entry.data.imageData, width: entry.data.width, height: entry.data.height, x: entry.data.x, y: entry.data.y };

    entry.data.imageData = newImageData;
    entry.data.width = cropDisplayW;
    entry.data.height = cropDisplayH;
    entry.data.x = newX;
    entry.data.y = newY;
    entry.el.style.left = `${newX}px`;
    entry.el.style.top = `${newY}px`;
    entry.el.style.width = `${cropDisplayW}px`;
    entry.el.style.height = `${cropDisplayH}px`;
    imgEl.src = newImageData;

    exitCropMode(entry);
    updateConnectorsFor(entry.data.id);

    Api.updateElement(entry.data.id, {
      imageData: newImageData, width: cropDisplayW, height: cropDisplayH, x: newX, y: newY, bringToFront: true,
    }).then(applyRemoteUpdate).catch(err => alert(err.message));
    recordFieldUndo(entry.data.id, before);
  }

  // ---------- Commentaires (drawer par élément) ----------

  function formatRelativeTime(unixSeconds) {
    const now = Date.now() / 1000;
    const diff = Math.max(0, now - unixSeconds);
    if (diff < 60) return "à l'instant";
    if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
    if (diff < COMMENT_RELATIVE_DAYS * 86400) return `il y a ${Math.floor(diff / 86400)} j`;
    const d = new Date(unixSeconds * 1000);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString('fr-FR', sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Construit le DOM via textContent (jamais innerHTML) pour le nom et le texte : ce sont des
  // champs libres saisis par les participants, à ne jamais interpréter comme du HTML.
  function renderCommentItem(comment, elementId) {
    const div = document.createElement('div');
    div.className = 'comment-item';
    div.dataset.commentId = comment.id;

    const header = document.createElement('div');
    header.className = 'comment-item-header';
    const avatar = document.createElement('span');
    avatar.className = 'comment-item-avatar';
    avatar.style.background = comment.actorColor || '#8a8a9a';
    avatar.textContent = (comment.actorName || '?').trim().slice(0, 1).toUpperCase();
    const name = document.createElement('span');
    name.className = 'comment-item-name';
    name.textContent = comment.actorName;
    const time = document.createElement('span');
    time.className = 'comment-item-time';
    time.textContent = formatRelativeTime(comment.createdAt);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'comment-item-delete';
    delBtn.title = 'Supprimer ce commentaire';
    delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
    delBtn.addEventListener('click', () => {
      if (!confirm('Supprimer ce commentaire ?')) return;
      delBtn.disabled = true;
      Api.deleteComment(elementId, comment.id).catch(err => { alert(err.message); delBtn.disabled = false; });
    });
    header.append(avatar, name, time, delBtn);

    const text = document.createElement('div');
    text.className = 'comment-item-text';
    text.textContent = comment.text;

    div.append(header, text);
    return div;
  }

  const renderedCommentIds = new Set();

  function appendCommentToDrawerIfNew(comment, elementId) {
    if (renderedCommentIds.has(comment.id)) return;
    renderedCommentIds.add(comment.id);
    const empty = commentDrawerBody.querySelector('.comment-drawer-empty');
    if (empty) empty.remove();
    commentDrawerBody.appendChild(renderCommentItem(comment, elementId));
    commentDrawerBody.scrollTop = commentDrawerBody.scrollHeight;
  }

  function removeCommentFromDrawer(commentId) {
    renderedCommentIds.delete(commentId);
    const item = commentDrawerBody.querySelector(`.comment-item[data-comment-id="${commentId}"]`);
    if (item) item.remove();
    if (!commentDrawerBody.querySelector('.comment-item')) {
      commentDrawerBody.innerHTML = '<div class="comment-drawer-empty">Aucun commentaire pour le moment.</div>';
    }
  }

  function openCommentDrawer(entry) {
    activeCommentElementId = entry.data.id;
    renderedCommentIds.clear();
    commentDrawerBody.innerHTML = '<div class="comment-drawer-empty">Chargement…</div>';
    closeHistoryDrawer();
    commentDrawer.classList.add('is-open');
    commentDrawerOverlay.classList.add('is-open');
    closeAllToolbarPopovers();
    const elementId = entry.data.id;
    Api.getComments(elementId).then((comments) => {
      if (activeCommentElementId !== elementId) return; // le drawer a changé/fermé entre-temps
      commentDrawerBody.innerHTML = comments.length ? '' : '<div class="comment-drawer-empty">Aucun commentaire pour le moment.</div>';
      comments.forEach(c => appendCommentToDrawerIfNew(c, elementId));
    }).catch(() => {
      if (activeCommentElementId === elementId) commentDrawerBody.innerHTML = '<div class="comment-drawer-empty">Erreur de chargement.</div>';
    });
    requestAnimationFrame(() => commentInput.focus());
  }

  function closeCommentDrawer() {
    activeCommentElementId = null;
    commentDrawer.classList.remove('is-open');
    commentDrawerOverlay.classList.remove('is-open');
    commentInput.value = '';
  }

  // Pas de mise à jour optimiste ici : on laisse l'écho SSE (element:comment, reçu aussi par
  // l'auteur) faire tout l'affichage, comme pour la création d'élément — ça évite tout risque de
  // doublon si la réponse HTTP et l'écho SSE arrivent dans un ordre différent.
  function sendComment() {
    const text = commentInput.value.trim();
    if (!text || !activeCommentElementId) return;
    commentInput.value = '';
    commentSendBtn.disabled = true;
    Api.createComment(activeCommentElementId, text)
      .catch(err => alert(err.message))
      .finally(() => { commentSendBtn.disabled = false; });
  }

  commentDrawerCloseBtn.addEventListener('click', closeCommentDrawer);
  commentDrawerOverlay.addEventListener('click', closeCommentDrawer);
  commentSendBtn.addEventListener('click', sendComment);
  commentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); }
  });

  // ---------- Historique (toutes les actions, tous les participants) ----------

  const HISTORY_SEEN_KEY = `tb_history_seen_${Api.whiteboardId}`;
  let historyOpen = false;

  function renderHistoryItem(entry) {
    const div = document.createElement('div');
    div.className = 'comment-item';
    div.dataset.historyId = entry.id;
    const header = document.createElement('div');
    header.className = 'comment-item-header';
    const avatar = document.createElement('span');
    avatar.className = 'comment-item-avatar';
    avatar.style.background = '#8a8a9a';
    avatar.textContent = (entry.actorName || '?').trim().slice(0, 1).toUpperCase();
    const name = document.createElement('span');
    name.className = 'comment-item-name';
    name.textContent = entry.actorName;
    const time = document.createElement('span');
    time.className = 'comment-item-time';
    time.textContent = formatRelativeTime(entry.createdAt);
    header.append(avatar, name, time);
    const text = document.createElement('div');
    text.className = 'comment-item-text';
    text.textContent = entry.action;
    div.append(header, text);
    return div;
  }

  function prependHistoryItem(entry) {
    const empty = historyDrawerBody.querySelector('.comment-drawer-empty');
    if (empty) empty.remove();
    historyDrawerBody.insertBefore(renderHistoryItem(entry), historyDrawerBody.firstChild);
  }

  // La pastille "non lu" (cf. .history-dot dans board.css) disparaît dès l'ouverture du tiroir,
  // qu'il y ait eu une nouvelle entrée ou non — pas besoin de retenir la date, juste l'état "vu".
  function markHistorySeen() {
    sessionStorage.setItem(HISTORY_SEEN_KEY, '1');
    historyDot.classList.add('hidden');
  }

  function openHistoryDrawer() {
    historyOpen = true;
    closeCommentDrawer();
    historyDrawer.classList.add('is-open');
    historyDrawerOverlay.classList.add('is-open');
    closeAllToolbarPopovers();
    historyDrawerBody.innerHTML = '<div class="comment-drawer-empty">Chargement…</div>';
    Api.getHistory().then((entries) => {
      historyDrawerBody.innerHTML = entries.length ? '' : '<div class="comment-drawer-empty">Aucune activité pour le moment.</div>';
      entries.forEach(e => historyDrawerBody.appendChild(renderHistoryItem(e)));
    }).catch(() => {
      historyDrawerBody.innerHTML = '<div class="comment-drawer-empty">Erreur de chargement.</div>';
    });
    markHistorySeen();
  }

  function closeHistoryDrawer() {
    historyOpen = false;
    historyDrawer.classList.remove('is-open');
    historyDrawerOverlay.classList.remove('is-open');
  }

  historyBtn.addEventListener('click', () => {
    if (historyDrawer.classList.contains('is-open')) closeHistoryDrawer(); else openHistoryDrawer();
  });
  historyDrawerCloseBtn.addEventListener('click', closeHistoryDrawer);
  historyDrawerOverlay.addEventListener('click', closeHistoryDrawer);

  // ---------- Temps réel ----------

  Realtime.on('element:created', (element) => { if (!elements.has(element.id)) renderElement(element); });
  Realtime.on('elements:created', ({ elements: createdElements }) => createdElements.forEach((el) => { if (!elements.has(el.id)) renderElement(el); }));
  Realtime.on('element:updated', applyRemoteUpdate);
  Realtime.on('elements:updated', ({ elements: updatedElements }) => updatedElements.forEach(applyRemoteUpdate));
  Realtime.on('element:deleted', ({ id }) => removeElementLocal(id));
  Realtime.on('element:dragging', ({ id, x, y, width, height, rotation }) => {
    const entry = elements.get(id);
    if (!entry || entry.dragging || entry.resizing) return;
    if (x != null) { entry.el.style.left = `${x}px`; entry.data.x = x; }
    if (y != null) { entry.el.style.top = `${y}px`; entry.data.y = y; }
    if (width != null) { entry.el.style.width = `${width}px`; entry.data.width = width; }
    if (height != null) { entry.el.style.height = `${height}px`; entry.data.height = height; }
    if (rotation != null) {
      entry.data.rotation = rotation;
      entry.el.style.transform = `rotate(${rotation}deg)`;
    }
    updateConnectorsFor(id);
    if (selectedElementId === id) repositionToolbar(entry);
  });

  Realtime.on('element:votes', ({ elementId, voters }) => {
    const entry = elements.get(elementId);
    if (!entry) return;
    entry.data.votes = voters;
    updateElementBadges(entry);
    refreshToolbarIfSelected(entry);
  });

  Realtime.on('element:comment', ({ elementId, comment }) => {
    const entry = elements.get(elementId);
    if (entry) {
      entry.data.commentCount = (entry.data.commentCount || 0) + 1;
      updateElementBadges(entry);
    }
    if (activeCommentElementId === elementId) appendCommentToDrawerIfNew(comment, elementId);
  });

  Realtime.on('element:comment-deleted', ({ elementId, commentId }) => {
    const entry = elements.get(elementId);
    if (entry) {
      entry.data.commentCount = Math.max(0, (entry.data.commentCount || 0) - 1);
      updateElementBadges(entry);
    }
    if (activeCommentElementId === elementId) removeCommentFromDrawer(commentId);
  });

  Realtime.on('history:created', (entry) => {
    if (historyOpen) { prependHistoryItem(entry); markHistorySeen(); }
    else historyDot.classList.remove('hidden');
  });

  // ---------- Chargement initial ----------

  Api.getWhiteboard().then((whiteboard) => {
    document.getElementById('whiteboardTitle').textContent = whiteboard.workshopName;
    document.getElementById('whiteboardSubtitle').textContent = `${whiteboard.clientName} — ${whiteboard.projectName}`;
    document.title = whiteboard.workshopName;
    myName = whiteboard.me?.name || null;

    centerView(boundsOfList(whiteboard.elements));
    applyTransform();
    whiteboard.elements.forEach(renderElement);
    // Second passage : un connecteur peut avoir été rendu avant ses deux ancres (ordre par z_index),
    // on recalcule donc sa géométrie une fois tous les éléments présents.
    elements.forEach((entry) => { if (entry.data.type === 'connector') renderConnectorGeometry(entry); });
    didInitialCenter = true;

    Realtime.connect({ toScreen: worldToScreen });
  }).catch((err) => {
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#7a7a8c;">${err.message}</div>`;
  });

  window.addEventListener('resize', () => {
    if (!didInitialCenter) return;
    applyTransform();
  });

  setTimeout(hideHint, 6000);
})();
