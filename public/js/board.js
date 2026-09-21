(() => {
  const ELEMENT_COLORS = ['#FFF176', '#F8BBD0', '#90CAF9', '#A5D6A7', '#FFCC80', '#CE93D8'];
  const FONT_SIZES = [12, 14, 16, 18, 22, 28, 36, 48];
  const MIN_W = 60;
  const MIN_H = 40;
  const MIN_LINE_LENGTH = 30;
  const MIN_CROP_SIZE = 24;
  const MAX_IMAGE_DIM = 320;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 2.5;

  const viewportEl = document.getElementById('canvasViewport');
  const layerEl = document.getElementById('canvasLayer');
  const zoomPctEl = document.getElementById('zoomPct');
  const hintPill = document.getElementById('hintPill');
  const addDrawerBtn = document.getElementById('addDrawerBtn');
  const addDrawer = document.getElementById('addDrawer');
  const addDrawerOverlay = document.getElementById('addDrawerOverlay');
  const addDrawerCloseBtn = document.getElementById('addDrawerCloseBtn');
  const imageFileInput = document.getElementById('imageFileInput');

  const elements = new Map(); // id -> { data, el, textEl? }
  let pan = { x: 0, y: 0 };
  let zoom = 1;
  let creationCount = 0;
  let editingElementId = null;
  let selectedElementId = null;
  let didInitialCenter = false;
  let pendingImagePlacement = null;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function worldToScreen(x, y) { return { x: x * zoom + pan.x, y: y * zoom + pan.y }; }
  function screenToWorld(x, y) { return { x: (x - pan.x) / zoom, y: (y - pan.y) / zoom }; }

  function applyTransform() {
    layerEl.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    zoomPctEl.textContent = `${Math.round(zoom * 100)}%`;
    Realtime.repositionAll();
  }

  function getViewportPoint(e) {
    const rect = viewportEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hideHint() { hintPill.classList.add('is-hidden'); }

  // ---------- Zoom / pan ----------

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

  let isPanning = false;
  let panStartScreen = null;
  let panStartPan = null;

  viewportEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.element')) return;
    deselectElement();
    closeConfirmPopover();
    closeAddDrawer();
    isPanning = true;
    panStartScreen = { x: e.clientX, y: e.clientY };
    panStartPan = { ...pan };
    viewportEl.setPointerCapture(e.pointerId);
    viewportEl.classList.add('is-panning');
    hideHint();
  });

  window.addEventListener('pointermove', (e) => {
    if (isPanning) {
      pan.x = panStartPan.x + (e.clientX - panStartScreen.x);
      pan.y = panStartPan.y + (e.clientY - panStartScreen.y);
      applyTransform();
    }
    const { x: sx, y: sy } = getViewportPoint(e);
    const { x: wx, y: wy } = screenToWorld(sx, sy);
    Realtime.notifyLocalPointer(wx, wy);
  });

  window.addEventListener('pointerup', () => {
    isPanning = false;
    viewportEl.classList.remove('is-panning');
  });

  // ---------- Drawer "Ajouter un élément" ----------

  function openAddDrawer() {
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
      Api.createElement({ type: 'text', x: wx - 110 + offset, y: wy - 30 + offset, width: 220, height: 60, color: '#1c1c28', fontSize: 18 })
        .then(data => { const entry = ensureRendered(data); entry.enterEditing?.(); })
        .catch(err => alert(err.message));
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

  // ---------- Sélection ----------

  function deselectElement() {
    if (selectedElementId && elements.has(selectedElementId)) {
      elements.get(selectedElementId).el.classList.remove('is-selected');
    }
    selectedElementId = null;
  }

  function selectElement(id) {
    deselectElement();
    selectedElementId = id;
    elements.get(id).el.classList.add('is-selected');
  }

  document.addEventListener('keydown', (e) => {
    if (editingElementId) return;
    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedElementId) {
      const entry = elements.get(selectedElementId);
      if (!entry) return;
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

  // ---------- Rendu des éléments ----------

  function buildToolbarHtml(data) {
    const swatches = (data.type === 'note' || data.type === 'line' || data.type === 'text')
      ? ELEMENT_COLORS.map(c => `<button type="button" class="element-swatch${c === data.color ? ' is-active' : ''}" style="background:${c}" data-color="${c}"></button>`).join('')
      : '';
    const textControls = data.type === 'text' ? `
      <button type="button" class="element-format-btn${data.bold ? ' is-active' : ''}" data-format="bold" title="Gras">B</button>
      <button type="button" class="element-format-btn is-italic${data.italic ? ' is-active' : ''}" data-format="italic" title="Italique">I</button>
      <button type="button" class="element-format-btn is-underline${data.underline ? ' is-active' : ''}" data-format="underline" title="Souligné">U</button>
      <button type="button" class="element-format-btn is-strike${data.strikethrough ? ' is-active' : ''}" data-format="strikethrough" title="Barré">S</button>
      <select class="element-fontsize-select" data-role="fontsize" title="Taille">
        ${FONT_SIZES.map(s => `<option value="${s}"${Number(data.fontSize) === s ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
    ` : '';
    const imageControls = data.type === 'image' ? `
      <button type="button" class="element-icon-btn element-grayscale-btn${data.grayscale ? ' is-active' : ''}" title="Noir et blanc">
        <svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>
      </button>
      <button type="button" class="element-icon-btn element-crop-btn" title="Rogner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>
      </button>
    ` : '';
    const prefix = swatches + textControls + imageControls;
    const sep = prefix ? '<span class="element-toolbar-sep"></span>' : '';
    return `
      ${prefix}${sep}
      <button type="button" class="element-icon-btn element-duplicate-btn" title="Dupliquer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>
      </button>
      <button type="button" class="element-icon-btn element-delete-btn" title="Supprimer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
  }

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

    if (data.type === 'note') {
      el.style.background = data.color;
      el.innerHTML = `
        <div class="element-toolbar">${buildToolbarHtml(data)}</div>
        <textarea class="element-text" placeholder="Écris ici…" maxlength="4000"></textarea>
        <div class="element-resize-handle"></div>
      `;
      textEl = el.querySelector('.element-text');
      textEl.value = data.text || '';
    } else if (data.type === 'line') {
      el.style.background = data.color;
      el.style.transform = `rotate(${data.rotation}deg)`;
      el.innerHTML = `
        <div class="element-toolbar">${buildToolbarHtml(data)}</div>
        <div class="element-line-handle"></div>
      `;
    } else if (data.type === 'text') {
      el.innerHTML = `
        <div class="element-toolbar">${buildToolbarHtml(data)}</div>
        <textarea class="element-text" placeholder="Texte…" maxlength="4000"></textarea>
        <div class="element-resize-handle"></div>
      `;
      textEl = el.querySelector('.element-text');
      textEl.value = data.text || '';
    } else if (data.type === 'image') {
      el.innerHTML = `
        <div class="element-toolbar">${buildToolbarHtml(data)}</div>
        <img class="element-image-img" src="${data.imageData || ''}" draggable="false" alt="">
        <div class="element-resize-handle"></div>
      `;
    }

    layerEl.appendChild(el);
    const entry = { data, el, textEl };
    elements.set(data.id, entry);

    if (data.type === 'text') applyTextStyle(entry);
    if (data.type === 'line') updateLineToolbarCounterRotation(entry);
    if (data.type === 'image') applyImageFilters(entry);

    wireElementInteractions(entry);
    return entry;
  }

  function ensureRendered(data) {
    return elements.get(data.id) || renderElement(data);
  }

  function removeElementLocal(id) {
    const entry = elements.get(id);
    if (!entry) return;
    entry.el.remove();
    elements.delete(id);
    if (selectedElementId === id) selectedElementId = null;
    if (editingElementId === id) editingElementId = null;
  }

  function applyElementColor(entry) {
    if (entry.data.type === 'text') { if (entry.textEl) entry.textEl.style.color = entry.data.color; }
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

  function updateLineToolbarCounterRotation(entry) {
    if (entry.data.type !== 'line') return;
    const toolbar = entry.el.querySelector('.element-toolbar');
    if (toolbar) toolbar.style.transform = `rotate(${-entry.data.rotation}deg)`;
  }

  function applyRemoteUpdate(data) {
    const entry = elements.get(data.id);
    if (!entry) { renderElement(data); return; }
    entry.data = data;
    if (entry.dragging || entry.resizing || entry.cropping) return; // ne pas écraser une interaction locale en cours

    entry.el.style.left = `${data.x}px`;
    entry.el.style.top = `${data.y}px`;
    entry.el.style.width = `${data.width}px`;
    entry.el.style.height = `${data.height}px`;
    entry.el.style.zIndex = data.zIndex;

    if (data.type === 'line') {
      entry.el.style.background = data.color;
      entry.el.style.transform = `rotate(${data.rotation}deg)`;
      updateLineToolbarCounterRotation(entry);
    } else if (data.type === 'note') {
      entry.el.style.background = data.color;
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
    } else if (data.type === 'text') {
      if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
      applyTextStyle(entry);
    } else if (data.type === 'image') {
      entry.el.querySelector('.element-image-img').src = data.imageData || '';
      applyImageFilters(entry);
      const grayscaleBtn = entry.el.querySelector('.element-grayscale-btn');
      if (grayscaleBtn) grayscaleBtn.classList.toggle('is-active', !!data.grayscale);
    }

    entry.el.querySelectorAll('.element-swatch').forEach(sw => sw.classList.toggle('is-active', sw.dataset.color === data.color));
    if (data.type === 'text') {
      entry.el.querySelectorAll('.element-format-btn[data-format]').forEach(btn => {
        btn.classList.toggle('is-active', !!data[btn.dataset.format]);
      });
      const fs = entry.el.querySelector('[data-role="fontsize"]');
      if (fs) fs.value = data.fontSize || 18;
    }
    return entry;
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
    }).catch(err => alert(err.message));
  }

  function wireToolbar(entry) {
    const { el, data } = entry;
    const id = data.id;
    const toolbar = el.querySelector('.element-toolbar');
    if (!toolbar) return;

    toolbar.querySelectorAll('.element-swatch').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        selectElement(id);
        const color = btn.dataset.color;
        entry.data.color = color;
        applyElementColor(entry);
        toolbar.querySelectorAll('.element-swatch').forEach(sw => sw.classList.toggle('is-active', sw === btn));
        Api.updateElement(id, { color }).catch(err => alert(err.message));
      });
    });

    toolbar.querySelectorAll('.element-format-btn[data-format]').forEach((btn) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        selectElement(id);
        const key = btn.dataset.format;
        entry.data[key] = !entry.data[key];
        btn.classList.toggle('is-active', entry.data[key]);
        applyTextStyle(entry);
        Api.updateElement(id, { [key]: entry.data[key] }).catch(() => {});
      });
    });

    const fontSizeSelect = toolbar.querySelector('[data-role="fontsize"]');
    if (fontSizeSelect) {
      fontSizeSelect.addEventListener('pointerdown', e => e.stopPropagation());
      fontSizeSelect.addEventListener('change', () => {
        selectElement(id);
        const size = Number(fontSizeSelect.value);
        entry.data.fontSize = size;
        applyTextStyle(entry);
        Api.updateElement(id, { fontSize: size }).catch(() => {});
      });
    }

    const grayscaleBtn = toolbar.querySelector('.element-grayscale-btn');
    if (grayscaleBtn) {
      grayscaleBtn.addEventListener('pointerdown', e => e.stopPropagation());
      grayscaleBtn.addEventListener('click', () => {
        selectElement(id);
        entry.data.grayscale = !entry.data.grayscale;
        grayscaleBtn.classList.toggle('is-active', entry.data.grayscale);
        applyImageFilters(entry);
        Api.updateElement(id, { grayscale: entry.data.grayscale }).catch(() => {});
      });
    }

    const cropBtn = toolbar.querySelector('.element-crop-btn');
    if (cropBtn) {
      cropBtn.addEventListener('pointerdown', e => e.stopPropagation());
      cropBtn.addEventListener('click', () => { selectElement(id); enterCropMode(entry); });
    }

    const dupBtn = toolbar.querySelector('.element-duplicate-btn');
    dupBtn.addEventListener('pointerdown', e => e.stopPropagation());
    dupBtn.addEventListener('click', () => { selectElement(id); duplicateElement(entry); });

    const delBtn = toolbar.querySelector('.element-delete-btn');
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
        Api.updateElement(id, { text: textEl.value }).catch(() => {});
      }
    }

    let textSaveTimer = null;
    textEl.addEventListener('input', () => {
      clearTimeout(textSaveTimer);
      textSaveTimer = setTimeout(() => {
        entry.data.text = textEl.value;
        Api.updateElement(id, { text: textEl.value }).catch(() => {});
      }, 600);
    });
    textEl.addEventListener('blur', () => { clearTimeout(textSaveTimer); stopEditing(true); });
    textEl.addEventListener('pointerdown', (e) => { if (el.classList.contains('is-editing')) e.stopPropagation(); });

    entry.enterEditing = function enterEditing() {
      selectElement(id);
      editingElementId = id;
      el.classList.add('is-editing');
      Api.updateElement(id, { bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
      requestAnimationFrame(() => textEl.focus());
    };
  }

  function wireBodyDrag(entry) {
    const { el } = entry;
    const id = entry.data.id;
    let dragState = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.element-resize-handle') || e.target.closest('.element-line-handle') || e.target.closest('.element-toolbar')) return;
      if (el.classList.contains('is-editing') || entry.cropping) return;
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
  }

  function wireCornerResize(entry) {
    const handle = entry.el.querySelector('.element-resize-handle');
    if (!handle) return;
    const aspectLocked = entry.data.type === 'image';
    let resizeState = null;

    handle.addEventListener('pointerdown', (e) => {
      if (entry.cropping) return;
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
      updateLineToolbarCounterRotation(entry);
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

  function wireElementInteractions(entry) {
    wireToolbar(entry);
    if (entry.data.type === 'note' || entry.data.type === 'text') wireTextEditing(entry);
    wireBodyDrag(entry);
    if (entry.data.type === 'line') wireLineHandle(entry);
    else wireCornerResize(entry);
  }

  // ---------- Rognage d'image ----------
  // Quatre poignées de bord (haut/bas/gauche/droite) plutôt qu'un rectangle déplaçable : combinées,
  // elles permettent d'atteindre n'importe quel sous-rectangle aligné sur les axes, pour une
  // interaction plus simple qu'un rectangle à la fois déplaçable et redimensionnable.

  function enterCropMode(entry) {
    if (entry.data.type !== 'image' || entry.cropping) return;
    closeConfirmPopover();
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
      updateLineToolbarCounterRotation(entry);
    }
  });

  // ---------- Chargement initial ----------

  Api.getWhiteboard().then((whiteboard) => {
    document.getElementById('whiteboardTitle').textContent = whiteboard.workshopName;
    document.getElementById('whiteboardSubtitle').textContent = `${whiteboard.clientName} — ${whiteboard.projectName}`;
    document.title = whiteboard.workshopName;

    centerView();
    applyTransform();
    whiteboard.elements.forEach(renderElement);
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
