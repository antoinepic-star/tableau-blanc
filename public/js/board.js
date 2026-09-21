(() => {
  const ELEMENT_COLORS = ['#FFF176', '#FFCC80', '#F8BBD0', '#EF9A9A', '#A5D6A7', '#80CBC4', '#90CAF9', '#CE93D8', '#FFFFFF', '#989898', '#232323'];
  const FONT_SIZES = [12, 14, 16, 18, 22, 28, 36, 48];
  const LINE_THICKNESSES = [2, 4, 6, 10];
  const LINE_STYLES = [['solid', 'Continu'], ['dashed', 'Pointillés']];
  const STROKE_WIDTHS = [0, 1, 2, 4, 6];
  const RADIUS_PRESETS = [['Aucun', 0], ['Léger', 8], ['Moyen', 20], ['Complet', 999]];
  const MIN_W = 60;
  const MIN_H = 40;
  const MIN_LINE_LENGTH = 30;
  const MIN_CROP_SIZE = 24;
  const MAX_IMAGE_DIM = 320;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 2.5;
  const TEXT_PAD_X_RATIO = 0.55;
  const TEXT_PAD_Y_RATIO = 0.35;
  const TEXT_LINE_HEIGHT_RATIO = 1.35;
  const TEXT_MIN_CONTENT_WIDTH = 30;
  const BOX_TYPES = ['note', 'text', 'image', 'rectangle']; // types "boîte" (points d'ancrage pour les connecteurs)
  const UNLOCK_HOLD_MS = 2000;

  const viewportEl = document.getElementById('canvasViewport');
  const layerEl = document.getElementById('canvasLayer');
  const zoomPctEl = document.getElementById('zoomPct');
  const hintPill = document.getElementById('hintPill');
  const addDrawerBtn = document.getElementById('addDrawerBtn');
  const addDrawer = document.getElementById('addDrawer');
  const addDrawerOverlay = document.getElementById('addDrawerOverlay');
  const addDrawerCloseBtn = document.getElementById('addDrawerCloseBtn');
  const imageFileInput = document.getElementById('imageFileInput');
  const toolbarEl = document.getElementById('elementToolbar');

  const elements = new Map(); // id -> { data, el, textEl? }
  const connectorsByElementId = new Map(); // elementId -> Set<connectorId>
  let pan = { x: 0, y: 0 };
  let zoom = 1;
  let creationCount = 0;
  let editingElementId = null;
  let selectedElementId = null;
  let multiSelectedIds = new Set();
  let didInitialCenter = false;
  let pendingImagePlacement = null;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function randomId() { return `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

  function worldToScreen(x, y) { return { x: x * zoom + pan.x, y: y * zoom + pan.y }; }
  function screenToWorld(x, y) { return { x: (x - pan.x) / zoom, y: (y - pan.y) / zoom }; }

  function applyTransform() {
    layerEl.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    zoomPctEl.textContent = `${Math.round(zoom * 100)}%`;
    Realtime.repositionAll();
    if (selectedElementId) {
      const entry = elements.get(selectedElementId);
      if (entry) repositionToolbar(entry);
    }
    if (multiSelectedIds.size >= 2) repositionMultiToolbar();
  }

  function getViewportPoint(e) {
    const rect = viewportEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hideHint() { hintPill.classList.add('is-hidden'); }

  // Message furtif non bloquant — contrairement à alert(), il n'interrompt pas un geste en cours.
  let activeToastTimer = null;
  function showToast(message) {
    let toast = document.querySelector('.app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'app-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    clearTimeout(activeToastTimer);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    activeToastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 250);
    }, 3200);
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
    centerView();
    applyTransform();
  });

  function centerView() {
    const rect = viewportEl.getBoundingClientRect();
    pan.x = rect.width / 2;
    pan.y = rect.height / 2;
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
    closeAddDrawer();
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
      if (entry.data.type === 'connector' || entry.data.locked) return;
      const r = entry.el.getBoundingClientRect();
      if (rectsIntersect(selRect, r)) captured.push(entry.data.id);
    });
    if (captured.length === 1) selectElement(captured[0]);
    else if (captured.length >= 2) setMultiSelection(captured);
  });

  // ---------- Drawer "Ajouter un élément" ----------

  function openAddDrawer() {
    deselectElement();
    clearMultiSelection();
    addDrawer.classList.add('is-open');
    addDrawerOverlay.classList.add('is-open');
  }
  function closeAddDrawer() {
    addDrawer.classList.remove('is-open');
    addDrawerOverlay.classList.remove('is-open');
  }

  addDrawerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddDrawer();
  });
  addDrawerCloseBtn.addEventListener('click', closeAddDrawer);
  addDrawerOverlay.addEventListener('click', closeAddDrawer);
  addDrawer.querySelectorAll('.add-tile').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => startTileDrag(e, btn));
  });

  function viewportCenterWorld() {
    const rect = viewportEl.getBoundingClientRect();
    return screenToWorld(rect.width / 2, rect.height / 2);
  }

  function isPointOverCanvas(clientX, clientY) {
    const r = viewportEl.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  // Glisser-déposer d'un bloc du drawer vers le tableau : le drawer se ferme dès que le geste est
  // reconnu comme un glissement (au-delà d'un petit seuil), une pastille suit le curseur, et le
  // dépôt sur le canvas crée l'élément centré sur le point de relâchement. Un simple clic (sans
  // dépasser le seuil) garde l'ancien comportement : création au centre de la vue courante.
  function startTileDrag(e, btn) {
    const type = btn.dataset.type;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    let ghost = null;

    function onMove(ev) {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) {
        dragging = true;
        closeAddDrawer();
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.appendChild(btn.querySelector('.add-tile-icon').cloneNode(true));
        document.body.appendChild(ghost);
      }
      if (dragging) {
        ghost.style.left = `${ev.clientX + 14}px`;
        ghost.style.top = `${ev.clientY + 14}px`;
        viewportEl.classList.toggle('is-drop-target', isPointOverCanvas(ev.clientX, ev.clientY));
      }
    }

    function onUp(ev) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      viewportEl.classList.remove('is-drop-target');
      if (ghost) ghost.remove();

      if (!dragging) {
        closeAddDrawer();
        createElementOfType(type);
        return;
      }
      if (isPointOverCanvas(ev.clientX, ev.clientY)) {
        const r = viewportEl.getBoundingClientRect();
        const { x: wx, y: wy } = screenToWorld(ev.clientX - r.left, ev.clientY - r.top);
        placeNewElement(type, wx, wy);
      }
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function createElementOfType(type) {
    const { x: wx, y: wy } = viewportCenterWorld();
    placeNewElement(type, wx, wy, { cascade: true });
  }

  function placeNewElement(type, wx, wy, { cascade = false } = {}) {
    hideHint();
    const offset = cascade ? (creationCount % 6) * 18 : 0;
    creationCount++;

    if (type === 'note') {
      const color = ELEMENT_COLORS[creationCount % ELEMENT_COLORS.length];
      Api.createElement({ type: 'note', x: wx - 100 + offset, y: wy - 90 + offset, width: 200, height: 180, color })
        .catch(err => alert(err.message));
    } else if (type === 'line') {
      Api.createElement({ type: 'line', x: wx - 80 + offset, y: wy + offset, width: 160, height: 6, rotation: 0, color: '#1c1c28' })
        .catch(err => alert(err.message));
    } else if (type === 'text') {
      const initial = computeTextBoxSize({ text: '', fontSize: 18, bold: false, italic: false });
      Api.createElement({
        type: 'text', x: wx - initial.width / 2 + offset, y: wy - initial.height / 2 + offset,
        width: initial.width, height: initial.height, color: '#1c1c28', fontSize: 18,
      })
        .then(data => { const entry = ensureRendered(data); entry.enterEditing?.(); })
        .catch(err => alert(err.message));
    } else if (type === 'rectangle') {
      const color = ELEMENT_COLORS[creationCount % ELEMENT_COLORS.length];
      Api.createElement({
        type: 'rectangle', x: wx - 110 + offset, y: wy - 70 + offset, width: 220, height: 140,
        color, strokeWidth: 0, strokeColor: '#1c1c28', radius: 8,
      }).catch(err => alert(err.message));
    } else if (type === 'image') {
      pendingImagePlacement = { wx, wy, offset };
      imageFileInput.value = '';
      imageFileInput.click();
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
        const { wx, wy, offset } = pendingImagePlacement || { wx: 0, wy: 0, offset: 0 };
        Api.createElement({ type: 'image', x: wx - w / 2 + offset, y: wy - h / 2 + offset, width: w, height: h, imageData: reader.result })
          .catch(err => alert(err.message));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
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

  document.addEventListener('keydown', (e) => {
    if (editingElementId) return;
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    if (multiSelectedIds.size >= 2) {
      e.preventDefault();
      const ids = [...multiSelectedIds];
      if (!confirm(`Supprimer ces ${ids.length} éléments ?`)) return;
      ids.forEach((id) => {
        const entry = elements.get(id);
        if (!entry || entry.data.locked) return;
        removeElementLocal(id);
        Api.deleteElement(id).catch(() => {});
      });
      clearMultiSelection();
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
    pop.innerHTML = `
      <p>Supprimer cet élément ?</p>
      <div class="confirm-popover-actions">
        <button type="button" class="confirm-popover-cancel">Annuler</button>
        <button type="button" class="confirm-popover-confirm">Supprimer</button>
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
      removeElementLocal(entry.data.id);
      Api.deleteElement(entry.data.id).catch(err => alert(err.message));
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
    const size = data.fontSize || 18;
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

  function colorDropdownHtml(role, currentColor, allowNone, title) {
    const colors = allowNone ? [null, ...ELEMENT_COLORS] : ELEMENT_COLORS;
    return `
      <div class="toolbar-dropdown" data-role="${role}-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="${role}-trigger" title="${title}">
          <span class="toolbar-color-dot${currentColor ? '' : ' toolbar-color-dot-none'}" style="${currentColor ? `background:${currentColor}` : ''}"></span>
        </button>
        <div class="toolbar-popover toolbar-color-popover" data-role="${role}-popover">
          ${colors.map(c => `<button type="button" class="toolbar-color-swatch${c ? '' : ' is-none'}${(c || null) === (currentColor || null) ? ' is-active' : ''}" data-color="${c || ''}" style="${c ? `background:${c}` : ''}"></button>`).join('')}
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

  function thicknessDropdownHtml(data) {
    const currentStyle = data.lineStyle || 'solid';
    return `
      <div class="toolbar-dropdown" data-role="thickness-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="thickness-trigger" title="Épaisseur et style">
          <span class="toolbar-thickness-preview${currentStyle === 'dashed' ? ' is-dashed' : ''}" style="height:${clamp(data.height, 2, 12)}px"></span>
        </button>
        <div class="toolbar-popover toolbar-thickness-popover" data-role="thickness-popover">
          ${LINE_STYLES.map(([style, label]) => `
            <div class="toolbar-thickness-row">
              ${LINE_THICKNESSES.map(t => `<button type="button" class="toolbar-thickness-option${data.height === t && currentStyle === style ? ' is-active' : ''}" data-thickness="${t}" data-style="${style}" title="${label} ${t}px"><span class="toolbar-thickness-bar${style === 'dashed' ? ' is-dashed' : ''}" style="height:${t}px"></span></button>`).join('')}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function strokeWidthDropdownHtml(data) {
    const w = data.strokeWidth || 0;
    return `
      <div class="toolbar-dropdown" data-role="strokewidth-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="strokewidth-trigger" title="Épaisseur du contour">
          <span class="toolbar-thickness-preview" style="height:${w ? clamp(w, 2, 10) : 2}px; opacity:${w ? 1 : 0.35}"></span>
        </button>
        <div class="toolbar-popover toolbar-thickness-popover" data-role="strokewidth-popover">
          <div class="toolbar-thickness-row">
            ${STROKE_WIDTHS.map(sw => `<button type="button" class="toolbar-thickness-option${w === sw ? ' is-active' : ''}" data-strokewidth="${sw}" title="${sw === 0 ? 'Aucun contour' : sw + 'px'}"><span class="toolbar-thickness-bar" style="height:${sw || 2}px; opacity:${sw ? 1 : 0.3}"></span></button>`).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function radiusDropdownHtml(data) {
    const r = data.radius || 0;
    return `
      <div class="toolbar-dropdown" data-role="radius-wrap">
        <button type="button" class="toolbar-dropdown-trigger" data-role="radius-trigger" title="Arrondi des angles">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4H8a4 4 0 0 0-4 4v1"/><path d="M4 16v1a3 3 0 0 0 3 3h1"/><path d="M15 20h1a3 3 0 0 0 3-3v-1"/><path d="M20 9V8a4 4 0 0 0-4-4h-1"/></svg>
        </button>
        <div class="toolbar-popover toolbar-format-popover" data-role="radius-popover">
          ${RADIUS_PRESETS.map(([label, val]) => `<button type="button" class="element-format-btn${r === val ? ' is-active' : ''}" data-radius="${val}" title="${label}">${label.slice(0, 1)}</button>`).join('')}
        </div>
      </div>
    `;
  }

  function buildToolbarHtml(data) {
    let controls = '';
    if (data.type === 'note') {
      controls = colorDropdownHtml('color', data.color, false, 'Couleur');
    } else if (data.type === 'line' || data.type === 'connector') {
      controls = colorDropdownHtml('color', data.color, false, 'Couleur')
        + thicknessDropdownHtml(data);
      if (data.type === 'connector') {
        controls += `
          <button type="button" class="element-icon-btn element-arrow-start-btn${data.startCap === 'arrow' ? ' is-active' : ''}" title="Flèche au début">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/></svg>
          </button>
          <button type="button" class="element-icon-btn element-arrow-end-btn${data.endCap === 'arrow' ? ' is-active' : ''}" title="Flèche à la fin">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>
          </button>
        `;
      }
    } else if (data.type === 'text') {
      controls = colorDropdownHtml('color', data.color, false, 'Couleur du texte')
        + colorDropdownHtml('bg', data.backgroundColor, true, 'Couleur de fond')
        + formatDropdownHtml(data)
        + `<select class="element-fontsize-select" data-role="fontsize" title="Taille">${FONT_SIZES.map(s => `<option value="${s}"${Number(data.fontSize) === s ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
    } else if (data.type === 'image') {
      controls = `
        <button type="button" class="element-icon-btn element-grayscale-btn${data.grayscale ? ' is-active' : ''}" title="Noir et blanc">
          <svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>
        </button>
        <button type="button" class="element-icon-btn element-crop-btn" title="Rogner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>
        </button>
      `;
    } else if (data.type === 'rectangle') {
      controls = colorDropdownHtml('color', data.color, false, 'Couleur de fond')
        + strokeWidthDropdownHtml(data)
        + colorDropdownHtml('stroke', data.strokeColor, false, 'Couleur du contour')
        + radiusDropdownHtml(data);
    }
    const sep = controls ? '<span class="element-toolbar-sep"></span>' : '';
    return `
      ${controls}${sep}
      <button type="button" class="element-icon-btn element-lock-btn" title="Verrouiller">${iconLock()}</button>
      <button type="button" class="element-icon-btn element-duplicate-btn" title="Dupliquer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>
      </button>
      <button type="button" class="element-icon-btn element-delete-btn" title="Supprimer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
  }

  // Barre affichée à la place du toolbar normal quand l'élément sélectionné est verrouillé : un
  // seul bouton "appui long pour déverrouiller", dont le fond se remplit pendant l'appui (façon Miro).
  function buildLockedToolbarHtml() {
    return `
      <button type="button" class="unlock-hold-btn">
        <span class="unlock-hold-fill"></span>
        <svg class="unlock-hold-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
        <span class="unlock-hold-label">Appui long pour déverrouiller</span>
      </button>
    `;
  }

  function iconAlignLeft() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="3" x2="4" y2="21"/><rect x="7" y="6" width="12" height="5"/><rect x="7" y="13" width="7" height="5"/></svg>'; }
  function iconAlignCenter() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="3" x2="12" y2="21"/><rect x="6" y="6" width="12" height="5"/><rect x="8.5" y="13" width="7" height="5"/></svg>'; }
  function iconAlignRight() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="20" y1="3" x2="20" y2="21"/><rect x="5" y="6" width="12" height="5"/><rect x="10" y="13" width="7" height="5"/></svg>'; }
  function iconGroup() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="9" height="9" rx="1.5"/><rect x="12" y="12" width="9" height="9" rx="1.5"/></svg>'; }
  function iconUngroup() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="8" height="8" rx="1.5"/><rect x="14" y="14" width="8" height="8" rx="1.5"/><line x1="9.5" y1="9.5" x2="14.5" y2="14.5" stroke-dasharray="2 2"/></svg>'; }
  function iconLock() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'; }

  function groupMembers(groupId) {
    if (!groupId) return [];
    const ids = [];
    elements.forEach((entry) => { if (entry.data.groupId === groupId) ids.push(entry.data.id); });
    return ids;
  }

  function groupHasLockedMember(groupId) {
    return groupMembers(groupId).some((id) => elements.get(id)?.data.locked);
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
      toolbarEl.innerHTML = buildLockedToolbarHtml();
      toolbarEl.classList.add('is-open');
      wireUnlockButton(entry);
      repositionToolbar(entry);
      return;
    }
    toolbarEl.innerHTML = buildToolbarHtml(entry.data);
    toolbarEl.classList.add('is-open');
    wireToolbarControls(entry);
    repositionToolbar(entry);
  }

  function hideToolbar() {
    toolbarEl.classList.remove('is-open');
    toolbarEl.innerHTML = '';
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

  function moveElementTo(entry, x, y) {
    entry.data.x = x;
    entry.data.y = y;
    entry.el.style.left = `${x}px`;
    entry.el.style.top = `${y}px`;
    updateConnectorsFor(entry.data.id);
    Api.updateElement(entry.data.id, { x, y }).then(applyRemoteUpdate).catch(() => {});
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
    const isAlign = action === 'align-left' || action === 'align-right' || action === 'align-center';
    if (isAlign && entries.some(en => en.data.locked)) {
      showToast("Cette sélection contient des éléments verrouillés : dégroupe-la d'abord si tu veux les aligner.");
      return;
    }

    if (action === 'align-left') {
      const minX = Math.min(...entries.map(en => en.data.x));
      entries.forEach(en => moveElementTo(en, minX, en.data.y));
    } else if (action === 'align-right') {
      const maxRight = Math.max(...entries.map(en => en.data.x + en.data.width));
      entries.forEach(en => moveElementTo(en, maxRight - en.data.width, en.data.y));
    } else if (action === 'align-center') {
      const minX = Math.min(...entries.map(en => en.data.x));
      const maxRight = Math.max(...entries.map(en => en.data.x + en.data.width));
      const centerX = (minX + maxRight) / 2;
      entries.forEach(en => moveElementTo(en, centerX - en.data.width / 2, en.data.y));
    } else if (action === 'group') {
      const gid = randomId();
      entries.forEach((en) => {
        en.data.groupId = gid;
        Api.updateElement(en.data.id, { groupId: gid }).catch(() => {});
      });
      showMultiToolbar();
    } else if (action === 'ungroup') {
      entries.forEach((en) => {
        en.data.groupId = null;
        Api.updateElement(en.data.id, { groupId: null }).catch(() => {});
      });
      showMultiToolbar();
    } else if (action === 'lock') {
      entries.forEach((en) => {
        en.data.locked = true;
        applyLockedState(en);
        Api.updateElement(en.data.id, { locked: true }).catch(() => {});
      });
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

  function wireUnlockButton(entry) {
    const btn = toolbarEl.querySelector('.unlock-hold-btn');
    if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      startUnlockHold(entry, btn);
    });
  }

  // Le remplissage se fait DANS le bouton du toolbar (comme Miro) — plus d'overlay sur l'élément
  // lui-même. On annule si le bouton est relâché ou si le pointeur le quitte avant la fin.
  function startUnlockHold(entry, btn) {
    const fill = btn.querySelector('.unlock-hold-fill');
    const startTime = Date.now();
    let done = false;
    let raf = null;

    function cleanup() {
      done = true;
      if (raf) cancelAnimationFrame(raf);
      if (fill) fill.style.width = '0%';
      window.removeEventListener('pointerup', onUp);
      btn.removeEventListener('pointerleave', onLeave);
    }
    function onUp() { cleanup(); }
    function onLeave() { cleanup(); }
    function tick() {
      if (done) return;
      const elapsed = Date.now() - startTime;
      if (fill) fill.style.width = `${Math.min(100, (elapsed / UNLOCK_HOLD_MS) * 100)}%`;
      if (elapsed >= UNLOCK_HOLD_MS) {
        cleanup();
        entry.data.locked = false;
        applyLockedState(entry);
        Api.updateElement(entry.data.id, { locked: false }).catch(() => {});
        if (selectedElementId === entry.data.id) showToolbarFor(entry);
        return;
      }
      raf = requestAnimationFrame(tick);
    }
    window.addEventListener('pointerup', onUp);
    btn.addEventListener('pointerleave', onLeave);
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
      el.style.background = data.color;
      el.innerHTML = `
        <textarea class="element-text" placeholder="Écris ici…" maxlength="4000"></textarea>
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
      textEl = el.querySelector('.element-text');
      textEl.value = data.text || '';
    } else if (data.type === 'line') {
      el.style.transform = `rotate(${data.rotation}deg)`;
      el.innerHTML = `<div class="element-line-handle"></div>`;
    } else if (data.type === 'connector') {
      el.style.transform = `rotate(${data.rotation}deg)`;
      el.innerHTML = `<div class="line-cap line-cap-start"></div><div class="line-cap line-cap-end"></div>`;
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
      el.innerHTML = `
        <textarea class="element-text element-text-rect" placeholder="" maxlength="4000"></textarea>
        <div class="element-resize-handle"></div>
        ${anchorsHtml}
      `;
      textEl = el.querySelector('.element-text');
      textEl.value = data.text || '';
    }

    layerEl.appendChild(el);
    const entry = { data, el, textEl };
    elements.set(data.id, entry);

    if (data.type === 'text') { applyTextStyle(entry); applyElementBackground(entry); applyTextAutoSize(entry); }
    if (data.type === 'line' || data.type === 'connector') applyLineStyle(entry);
    if (data.type === 'connector') applyConnectorCaps(entry);
    if (data.type === 'image') applyImageFilters(entry);
    if (data.type === 'rectangle') applyRectangleStyle(entry);
    applyLockedState(entry);

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
    if (selectedElementId === id) selectedElementId = null;
    if (editingElementId === id) editingElementId = null;
    multiSelectedIds.delete(id);
  }

  function applyElementColor(entry) {
    if (entry.data.type === 'text') { if (entry.textEl) entry.textEl.style.color = entry.data.color; }
    else if (entry.data.type === 'line' || entry.data.type === 'connector') applyLineStyle(entry);
    else if (entry.data.type === 'rectangle') applyRectangleStyle(entry);
    else entry.el.style.background = entry.data.color;
  }

  function applyTextStyle(entry) {
    const t = entry.textEl;
    if (!t) return;
    t.style.fontWeight = entry.data.bold ? '700' : '400';
    t.style.fontStyle = entry.data.italic ? 'italic' : 'normal';
    const decorations = [];
    if (entry.data.underline) decorations.push('underline');
    if (entry.data.strikethrough) decorations.push('line-through');
    t.style.textDecoration = decorations.join(' ') || 'none';
    t.style.fontSize = `${entry.data.fontSize || 18}px`;
    t.style.color = entry.data.color;
  }

  function applyElementBackground(entry) {
    if (entry.data.type !== 'text') return;
    entry.el.style.background = entry.data.backgroundColor || 'transparent';
    entry.el.style.borderRadius = entry.data.backgroundColor ? '4px' : '0';
  }

  function applyRectangleStyle(entry) {
    if (entry.data.type !== 'rectangle') return;
    entry.el.style.background = entry.data.color;
    entry.el.style.border = entry.data.strokeWidth ? `${entry.data.strokeWidth}px solid ${entry.data.strokeColor || '#1c1c28'}` : 'none';
    const r = entry.data.radius || 0;
    entry.el.style.borderRadius = r >= 999 ? '999px' : `${r}px`;
  }

  // Trait/connecteur continu = simple aplat de couleur ; pointillés = dégradé répété le long de la
  // longueur (l'élément est une barre pivotée, donc "vers la droite" correspond toujours à sa longueur).
  function applyLineStyle(entry) {
    if (entry.data.type !== 'line' && entry.data.type !== 'connector') return;
    const { color, height } = entry.data;
    if (entry.data.lineStyle === 'dashed') {
      const dash = Math.max(6, height * 2.2);
      const gap = Math.max(5, height * 1.6);
      entry.el.style.background = `repeating-linear-gradient(to right, ${color} 0, ${color} ${dash}px, transparent ${dash}px, transparent ${dash + gap}px)`;
    } else {
      entry.el.style.background = color;
    }
  }

  function capArrowHtml(color, thickness) {
    const s = clamp(thickness * 2.4, 10, 20);
    return `<svg width="${s + 4}" height="${s}" viewBox="0 0 ${s + 4} ${s}"><polygon points="0,0 ${s + 4},${s / 2} 0,${s}" fill="${color}"/></svg>`;
  }

  function applyConnectorCaps(entry) {
    if (entry.data.type !== 'connector') return;
    const startEl = entry.el.querySelector('.line-cap-start');
    const endEl = entry.el.querySelector('.line-cap-end');
    if (startEl) startEl.innerHTML = entry.data.startCap === 'arrow' ? capArrowHtml(entry.data.color, entry.data.height) : '';
    if (endEl) endEl.innerHTML = entry.data.endCap === 'arrow' ? capArrowHtml(entry.data.color, entry.data.height) : '';
  }

  function applyRemoteUpdate(data) {
    const entry = elements.get(data.id);
    if (!entry) { renderElement(data); return; }
    entry.data = data;
    applyLockedState(entry);
    if (entry.dragging || entry.resizing || entry.cropping) return; // ne pas écraser une interaction locale en cours

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
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
    } else if (data.type === 'text') {
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
      applyTextStyle(entry);
      applyElementBackground(entry);
      applyTextAutoSize(entry);
    } else if (data.type === 'image') {
      entry.el.querySelector('.element-image-img').src = data.imageData || '';
      applyImageFilters(entry);
    } else if (data.type === 'rectangle') {
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
      applyRectangleStyle(entry);
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

  function renderConnectorGeometry(entry) {
    const from = connectorAnchorWorldPoint(entry.data.fromElementId, entry.data.fromSide);
    const to = connectorAnchorWorldPoint(entry.data.toElementId, entry.data.toSide);
    if (!from || !to) return;
    const dx = to.x - from.x, dy = to.y - from.y;
    const width = Math.max(2, Math.hypot(dx, dy));
    const rotation = Math.atan2(dy, dx) * (180 / Math.PI);
    entry.data.x = from.x;
    entry.data.y = from.y;
    entry.data.width = width;
    entry.data.rotation = rotation;
    entry.el.style.left = `${from.x}px`;
    entry.el.style.top = `${from.y}px`;
    entry.el.style.width = `${width}px`;
    entry.el.style.transform = `rotate(${rotation}deg)`;
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
      Api.createElement({
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
    Api.createElement({
      type: d.type, x: d.x + 24, y: d.y + 24, width: d.width, height: d.height, rotation: d.rotation,
      color: d.color, text: d.text, fontSize: d.fontSize, bold: d.bold, italic: d.italic,
      underline: d.underline, strikethrough: d.strikethrough, imageData: d.imageData, grayscale: d.grayscale,
      lineStyle: d.lineStyle, backgroundColor: d.backgroundColor, strokeWidth: d.strokeWidth, strokeColor: d.strokeColor,
      radius: d.radius, startCap: d.startCap, endCap: d.endCap,
      fromElementId: d.fromElementId, fromSide: d.fromSide, toElementId: d.toElementId, toSide: d.toSide,
    }).catch(err => alert(err.message));
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
        dot.style.background = color || '';
        dot.classList.toggle('toolbar-color-dot-none', !color);
        popover.classList.remove('is-open');
      });
    });
  }

  function wireFormatDropdown(entry) {
    const parts = wireDropdownToggle('format');
    if (!parts) return;
    parts.popover.querySelectorAll('.element-format-btn[data-format]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        const key = btn.dataset.format;
        entry.data[key] = !entry.data[key];
        btn.classList.toggle('is-active', entry.data[key]);
        applyTextStyle(entry);
        if (key === 'bold' || key === 'italic') applyTextAutoSize(entry);
        Api.updateElement(entry.data.id, { [key]: entry.data[key] }).catch(() => {});
      });
    });
  }

  function wireThicknessDropdown(entry) {
    const parts = wireDropdownToggle('thickness');
    if (!parts) return;
    const { trigger, popover } = parts;
    popover.querySelectorAll('.toolbar-thickness-option').forEach((opt) => {
      opt.addEventListener('pointerdown', e => e.stopPropagation());
      opt.addEventListener('click', () => {
        const h = Number(opt.dataset.thickness);
        const style = opt.dataset.style;
        entry.data.height = h;
        entry.data.lineStyle = style;
        entry.el.style.height = `${h}px`;
        applyLineStyle(entry);
        if (entry.data.type === 'connector') applyConnectorCaps(entry);
        popover.querySelectorAll('.toolbar-thickness-option').forEach(o => o.classList.remove('is-active'));
        opt.classList.add('is-active');
        const preview = trigger.querySelector('.toolbar-thickness-preview');
        preview.style.height = `${h}px`;
        preview.classList.toggle('is-dashed', style === 'dashed');
        popover.classList.remove('is-open');
        Api.updateElement(entry.data.id, { height: h, lineStyle: style }).catch(() => {});
        repositionToolbar(entry);
      });
    });
  }

  function wireStrokeWidthDropdown(entry) {
    const parts = wireDropdownToggle('strokewidth');
    if (!parts) return;
    const { trigger, popover } = parts;
    popover.querySelectorAll('.toolbar-thickness-option').forEach((opt) => {
      opt.addEventListener('pointerdown', e => e.stopPropagation());
      opt.addEventListener('click', () => {
        const w = Number(opt.dataset.strokewidth);
        entry.data.strokeWidth = w;
        applyRectangleStyle(entry);
        popover.querySelectorAll('.toolbar-thickness-option').forEach(o => o.classList.remove('is-active'));
        opt.classList.add('is-active');
        const preview = trigger.querySelector('.toolbar-thickness-preview');
        preview.style.height = `${w ? clamp(w, 2, 10) : 2}px`;
        preview.style.opacity = w ? 1 : 0.35;
        popover.classList.remove('is-open');
        Api.updateElement(entry.data.id, { strokeWidth: w }).catch(() => {});
      });
    });
  }

  function wireRadiusDropdown(entry) {
    const parts = wireDropdownToggle('radius');
    if (!parts) return;
    const { popover } = parts;
    popover.querySelectorAll('[data-radius]').forEach((opt) => {
      opt.addEventListener('pointerdown', e => e.stopPropagation());
      opt.addEventListener('click', () => {
        const r = Number(opt.dataset.radius);
        entry.data.radius = r;
        applyRectangleStyle(entry);
        popover.querySelectorAll('[data-radius]').forEach(o => o.classList.remove('is-active'));
        opt.classList.add('is-active');
        popover.classList.remove('is-open');
        Api.updateElement(entry.data.id, { radius: r }).catch(() => {});
      });
    });
  }

  function wireToolbarControls(entry) {
    const id = entry.data.id;
    const type = entry.data.type;

    if (type === 'note' || type === 'line' || type === 'text' || type === 'rectangle' || type === 'connector') {
      wireColorDropdown(entry, 'color', (color) => {
        entry.data.color = color;
        applyElementColor(entry);
        if (type === 'connector') applyConnectorCaps(entry);
        Api.updateElement(id, { color }).catch(err => alert(err.message));
      });
    }

    if (type === 'line' || type === 'connector') {
      wireThicknessDropdown(entry);
    }

    if (type === 'connector') {
      const startBtn = toolbarEl.querySelector('.element-arrow-start-btn');
      if (startBtn) {
        startBtn.addEventListener('pointerdown', e => e.stopPropagation());
        startBtn.addEventListener('click', () => {
          entry.data.startCap = entry.data.startCap === 'arrow' ? 'none' : 'arrow';
          startBtn.classList.toggle('is-active', entry.data.startCap === 'arrow');
          applyConnectorCaps(entry);
          Api.updateElement(id, { startCap: entry.data.startCap }).catch(() => {});
        });
      }
      const endBtn = toolbarEl.querySelector('.element-arrow-end-btn');
      if (endBtn) {
        endBtn.addEventListener('pointerdown', e => e.stopPropagation());
        endBtn.addEventListener('click', () => {
          entry.data.endCap = entry.data.endCap === 'arrow' ? 'none' : 'arrow';
          endBtn.classList.toggle('is-active', entry.data.endCap === 'arrow');
          applyConnectorCaps(entry);
          Api.updateElement(id, { endCap: entry.data.endCap }).catch(() => {});
        });
      }
    }

    if (type === 'rectangle') {
      wireColorDropdown(entry, 'stroke', (color) => {
        entry.data.strokeColor = color;
        applyRectangleStyle(entry);
        Api.updateElement(id, { strokeColor: color }).catch(() => {});
      });
      wireStrokeWidthDropdown(entry);
      wireRadiusDropdown(entry);
    }

    if (type === 'text') {
      wireColorDropdown(entry, 'bg', (color) => {
        entry.data.backgroundColor = color;
        applyElementBackground(entry);
        Api.updateElement(id, { backgroundColor: color }).catch(() => {});
      });
      wireFormatDropdown(entry);
      const fontSizeSelect = toolbarEl.querySelector('[data-role="fontsize"]');
      if (fontSizeSelect) {
        fontSizeSelect.addEventListener('pointerdown', e => e.stopPropagation());
        fontSizeSelect.addEventListener('change', () => {
          const size = Number(fontSizeSelect.value);
          entry.data.fontSize = size;
          applyTextStyle(entry);
          applyTextAutoSize(entry);
          Api.updateElement(id, { fontSize: size, width: entry.data.width, height: entry.data.height }).catch(() => {});
        });
      }
    }

    if (type === 'image') {
      const grayscaleBtn = toolbarEl.querySelector('.element-grayscale-btn');
      if (grayscaleBtn) {
        grayscaleBtn.addEventListener('pointerdown', e => e.stopPropagation());
        grayscaleBtn.addEventListener('click', () => {
          entry.data.grayscale = !entry.data.grayscale;
          grayscaleBtn.classList.toggle('is-active', entry.data.grayscale);
          applyImageFilters(entry);
          Api.updateElement(id, { grayscale: entry.data.grayscale }).catch(() => {});
        });
      }
      const cropBtn = toolbarEl.querySelector('.element-crop-btn');
      if (cropBtn) {
        cropBtn.addEventListener('pointerdown', e => e.stopPropagation());
        cropBtn.addEventListener('click', () => enterCropMode(entry));
      }
    }

    const lockBtn = toolbarEl.querySelector('.element-lock-btn');
    if (lockBtn) {
      lockBtn.addEventListener('pointerdown', e => e.stopPropagation());
      lockBtn.addEventListener('click', () => {
        entry.data.locked = true;
        applyLockedState(entry);
        Api.updateElement(entry.data.id, { locked: true }).catch(() => {});
        showToolbarFor(entry);
      });
    }

    const dupBtn = toolbarEl.querySelector('.element-duplicate-btn');
    dupBtn.addEventListener('pointerdown', e => e.stopPropagation());
    dupBtn.addEventListener('click', () => duplicateElement(entry));

    const delBtn = toolbarEl.querySelector('.element-delete-btn');
    delBtn.addEventListener('pointerdown', e => e.stopPropagation());
    delBtn.addEventListener('click', () => showDeleteConfirm(entry, delBtn.getBoundingClientRect()));
  }

  function wireTextEditing(entry) {
    const { el, textEl, data } = entry;
    const id = data.id;

    function stopEditing(save) {
      el.classList.remove('is-editing');
      editingElementId = null;
      if (save) {
        entry.data.text = textEl.value;
        const patch = { text: textEl.value };
        if (entry.data.type === 'text') { patch.width = entry.data.width; patch.height = entry.data.height; }
        Api.updateElement(id, patch).catch(() => {});
      }
    }

    let textSaveTimer = null;
    textEl.addEventListener('input', () => {
      entry.data.text = textEl.value;
      if (entry.data.type === 'text') applyTextAutoSize(entry);
      clearTimeout(textSaveTimer);
      textSaveTimer = setTimeout(() => {
        const patch = { text: textEl.value };
        if (entry.data.type === 'text') { patch.width = entry.data.width; patch.height = entry.data.height; }
        Api.updateElement(id, patch).catch(() => {});
      }, 600);
    });
    textEl.addEventListener('blur', () => { clearTimeout(textSaveTimer); stopEditing(true); });
    textEl.addEventListener('pointerdown', (e) => { if (el.classList.contains('is-editing')) e.stopPropagation(); });

    entry.enterEditing = function enterEditing() {
      if (entry.data.locked) return;
      selectElement(id);
      editingElementId = id;
      el.classList.add('is-editing');
      Api.updateElement(id, { bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
      requestAnimationFrame(() => textEl.focus());
    };
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
      ids.forEach((mid) => {
        const en = elements.get(mid);
        const start = startPositions.get(mid);
        if (!en || !start) return;
        const nx = start.x + dxScreen / zoom;
        const ny = start.y + dyScreen / zoom;
        en.data.x = nx; en.data.y = ny;
        en.el.style.left = `${nx}px`; en.el.style.top = `${ny}px`;
        en.dragging = true;
        en.el.classList.add('is-dragging');
        updateConnectorsFor(mid);
      });
      repositionMultiToolbar();
      const now = Date.now();
      if (now - lastLive > 40) {
        lastLive = now;
        ids.forEach((mid) => { const en = elements.get(mid); if (en) Api.liveElement(mid, { x: en.data.x, y: en.data.y }); });
      }
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      ids.forEach((mid) => {
        const en = elements.get(mid);
        if (!en) return;
        en.dragging = false;
        en.el.classList.remove('is-dragging');
      });
      if (moved) {
        ids.forEach((mid) => {
          const en = elements.get(mid);
          if (en) Api.updateElement(mid, { x: en.data.x, y: en.data.y, bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
        });
      } else if (!isRealGroup) {
        clearMultiSelection();
        selectElement(entry.data.id);
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
      // Verrouillé : juste sélectionner (montre le bouton "appui long pour déverrouiller" dans le
      // toolbar) — le décompte de déverrouillage se déclenche sur ce bouton, pas sur l'élément lui-même.
      if (entry.data.locked) { e.stopPropagation(); selectElement(id); closeConfirmPopover(); return; }
      if (entry.cropping) return;
      // Pas de garde sur is-editing ici : un clic sur le textarea lui-même stoppe déjà la
      // propagation (cf. wireTextEditing) quand on édite, donc seul un clic sur le bord — hors
      // textarea — arrive jusqu'ici, et il doit pouvoir démarrer un glisser même en édition.

      const groupIds = activeGroupIdsFor(entry);
      if (groupIds) {
        e.stopPropagation();
        closeConfirmPopover();
        if (entry.data.groupId && groupHasLockedMember(entry.data.groupId)) {
          setMultiSelection(groupIds);
          showToast("Ce groupe contient des éléments verrouillés : dégroupe-le d'abord si tu veux déplacer celui-ci.");
          return;
        }
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
      const newX = dragState.startWorld.x + dxScreen / zoom;
      const newY = dragState.startWorld.y + dyScreen / zoom;
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

    el.addEventListener('pointerup', () => {
      if (!dragState) return;
      const wasMoved = dragState.moved;
      el.releasePointerCapture(dragState.pointerId);
      dragState = null;
      entry.dragging = false;
      el.classList.remove('is-dragging');
      if (wasMoved) {
        Api.updateElement(id, { x: entry.data.x, y: entry.data.y, bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
      } else if (entry.enterEditing) {
        entry.enterEditing();
      }
    });

    // Double-clic : entre en édition même si l'élément appartient à un groupe (sinon un clic simple
    // sur un membre de groupe sélectionne toujours tout le groupe, sans moyen d'éditer son texte).
    if (entry.enterEditingBypassGroup !== false) {
      el.addEventListener('dblclick', (e) => {
        if (entry.data.locked || !entry.enterEditing) return;
        e.stopPropagation();
        clearMultiSelection();
        entry.enterEditing();
      });
    }
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
      resizeState = {
        startScreen: { x: e.clientX, y: e.clientY },
        startSize: { w: entry.data.width, h: entry.data.height },
        pointerId: e.pointerId,
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
      } else {
        newH = Math.max(MIN_H, resizeState.startSize.h + dyScreen / zoom);
      }
      entry.data.width = newW;
      entry.data.height = newH;
      entry.el.style.width = `${newW}px`;
      entry.el.style.height = `${newH}px`;
      repositionToolbar(entry);
      updateConnectorsFor(entry.data.id);
      const now = Date.now();
      if (now - (entry._lastLive || 0) > 40) {
        entry._lastLive = now;
        Api.liveElement(entry.data.id, { width: newW, height: newH });
      }
    });

    handle.addEventListener('pointerup', () => {
      if (!resizeState) return;
      handle.releasePointerCapture(resizeState.pointerId);
      resizeState = null;
      entry.resizing = false;
      entry.el.classList.remove('is-resizing');
      Api.updateElement(entry.data.id, { width: entry.data.width, height: entry.data.height, bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
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
      state = { pointerId: e.pointerId };
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
      state = null;
      entry.resizing = false;
      entry.el.classList.remove('is-resizing');
      Api.updateElement(entry.data.id, { width: entry.data.width, rotation: entry.data.rotation, bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
    });
  }

  function wireConnectorSelect(entry) {
    entry.el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectElement(entry.data.id);
      closeConfirmPopover();
    });
  }

  function wireElementInteractions(entry) {
    if (entry.data.type === 'connector') { wireConnectorSelect(entry); return; }
    if (entry.data.type === 'note' || entry.data.type === 'text' || entry.data.type === 'rectangle') wireTextEditing(entry);
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
  }

  // ---------- Temps réel ----------

  Realtime.on('element:created', (element) => { if (!elements.has(element.id)) renderElement(element); });
  Realtime.on('element:updated', applyRemoteUpdate);
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

  // ---------- Chargement initial ----------

  Api.getWhiteboard().then((whiteboard) => {
    document.getElementById('whiteboardTitle').textContent = whiteboard.workshopName;
    document.getElementById('whiteboardSubtitle').textContent = `${whiteboard.clientName} — ${whiteboard.projectName}`;
    document.title = whiteboard.workshopName;

    centerView();
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
