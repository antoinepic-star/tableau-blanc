(() => {
  const NOTE_COLORS = ['#FFF176', '#F8BBD0', '#90CAF9', '#A5D6A7', '#FFCC80', '#CE93D8'];
  const DEFAULT_W = 200;
  const DEFAULT_H = 180;
  const MIN_W = 110;
  const MIN_H = 90;
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 2.5;

  const viewportEl = document.getElementById('canvasViewport');
  const layerEl = document.getElementById('canvasLayer');
  const zoomPctEl = document.getElementById('zoomPct');
  const hintPill = document.getElementById('hintPill');

  const notes = new Map(); // id -> { data, el, textEl }
  let pan = { x: 0, y: 0 };
  let zoom = 1;
  let creationCount = 0;
  let editingNoteId = null;
  let selectedNoteId = null;
  let didInitialCenter = false;

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
    if (e.target.closest('.note')) return;
    deselectNote();
    isPanning = true;
    panStartScreen = { x: e.clientX, y: e.clientY };
    panStartPan = { ...pan };
    viewportEl.classList.add('is-panning');
    viewportEl.setPointerCapture(e.pointerId);
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

  // ---------- Sélection ----------

  function deselectNote() {
    if (selectedNoteId && notes.has(selectedNoteId)) {
      notes.get(selectedNoteId).el.classList.remove('is-selected');
    }
    selectedNoteId = null;
  }

  function selectNote(id) {
    deselectNote();
    selectedNoteId = id;
    notes.get(id).el.classList.add('is-selected');
  }

  document.addEventListener('keydown', (e) => {
    if (editingNoteId) return;
    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedNoteId) {
      e.preventDefault();
      removeNoteLocal(selectedNoteId);
      Api.deleteNote(selectedNoteId).catch(err => alert(err.message));
    }
  });

  // ---------- Rendu des post-its ----------

  function renderNote(data) {
    const el = document.createElement('div');
    el.className = 'note';
    el.dataset.id = data.id;
    el.style.left = `${data.x}px`;
    el.style.top = `${data.y}px`;
    el.style.width = `${data.width}px`;
    el.style.height = `${data.height}px`;
    el.style.background = data.color;
    el.style.zIndex = data.zIndex;

    const swatches = NOTE_COLORS.map(c => `<button type="button" class="note-swatch${c === data.color ? ' is-active' : ''}" style="background:${c}" data-color="${c}"></button>`).join('');
    el.innerHTML = `
      <div class="note-toolbar">
        ${swatches}
        <button type="button" class="note-delete-btn" title="Supprimer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <textarea class="note-text" placeholder="Écris ici…" maxlength="2000"></textarea>
      <div class="note-resize-handle"></div>
    `;

    const textEl = el.querySelector('.note-text');
    textEl.value = data.text || '';

    layerEl.appendChild(el);
    const entry = { data, el, textEl };
    notes.set(data.id, entry);
    wireNoteInteractions(entry);
    return entry;
  }

  function removeNoteLocal(id) {
    const entry = notes.get(id);
    if (!entry) return;
    entry.el.remove();
    notes.delete(id);
    if (selectedNoteId === id) selectedNoteId = null;
    if (editingNoteId === id) editingNoteId = null;
  }

  function applyRemoteUpdate(data) {
    let entry = notes.get(data.id);
    if (!entry) { renderNote(data); return; }
    entry.data = data;
    if (entry.dragging || entry.resizing) return; // ne pas écraser une interaction locale en cours
    entry.el.style.left = `${data.x}px`;
    entry.el.style.top = `${data.y}px`;
    entry.el.style.width = `${data.width}px`;
    entry.el.style.height = `${data.height}px`;
    entry.el.style.background = data.color;
    entry.el.style.zIndex = data.zIndex;
    if (document.activeElement !== entry.textEl) entry.textEl.value = data.text || '';
    entry.el.querySelectorAll('.note-swatch').forEach(sw => sw.classList.toggle('is-active', sw.dataset.color === data.color));
  }

  // ---------- Interactions sur un post-it (drag / resize / édition / couleur / suppression) ----------

  function wireNoteInteractions(entry) {
    const { el, textEl } = entry;
    const id = entry.data.id;

    el.querySelectorAll('.note-swatch').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        entry.data.color = color;
        el.style.background = color;
        el.querySelectorAll('.note-swatch').forEach(sw => sw.classList.toggle('is-active', sw === btn));
        Api.updateNote(id, { color }).catch(err => alert(err.message));
      });
    });

    el.querySelector('.note-delete-btn').addEventListener('pointerdown', (e) => e.stopPropagation());
    el.querySelector('.note-delete-btn').addEventListener('click', () => {
      removeNoteLocal(id);
      Api.deleteNote(id).catch(err => alert(err.message));
    });

    function stopEditing(save) {
      el.classList.remove('is-editing');
      editingNoteId = null;
      if (save) {
        entry.data.text = textEl.value;
        Api.updateNote(id, { text: textEl.value }).catch(() => {});
      }
    }

    let textSaveTimer = null;
    textEl.addEventListener('input', () => {
      clearTimeout(textSaveTimer);
      textSaveTimer = setTimeout(() => {
        entry.data.text = textEl.value;
        Api.updateNote(id, { text: textEl.value }).catch(() => {});
      }, 600);
    });
    textEl.addEventListener('blur', () => { clearTimeout(textSaveTimer); stopEditing(true); });
    textEl.addEventListener('pointerdown', (e) => { if (el.classList.contains('is-editing')) e.stopPropagation(); });

    function enterEditing() {
      selectNote(id);
      editingNoteId = id;
      el.classList.add('is-editing');
      Api.updateNote(id, { bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
      requestAnimationFrame(() => { textEl.focus(); });
    }

    // ---- Drag (déplacement) ----
    let dragState = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.note-resize-handle') || e.target.closest('.note-toolbar')) return;
      if (el.classList.contains('is-editing')) return; // laisser le texte gérer le clic
      e.stopPropagation();
      selectNote(id);
      dragState = {
        startScreen: { x: e.clientX, y: e.clientY },
        startWorld: { x: entry.data.x, y: entry.data.y },
        moved: false,
        pointerId: e.pointerId,
      };
      el.setPointerCapture(e.pointerId);
    });

    let lastLiveSent = 0;
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
      if (now - lastLiveSent > 40) {
        lastLiveSent = now;
        Api.liveNote(id, { x: newX, y: newY });
      }
    });

    el.addEventListener('pointerup', (e) => {
      if (!dragState) return;
      const wasMoved = dragState.moved;
      el.releasePointerCapture(dragState.pointerId);
      dragState = null;
      entry.dragging = false;
      el.classList.remove('is-dragging');
      if (wasMoved) {
        Api.updateNote(id, { x: entry.data.x, y: entry.data.y, bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
      } else {
        enterEditing();
      }
    });

    // ---- Resize ----
    let resizeState = null;
    const handle = el.querySelector('.note-resize-handle');
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectNote(id);
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
      el.classList.add('is-resizing');
      const dxScreen = e.clientX - resizeState.startScreen.x;
      const dyScreen = e.clientY - resizeState.startScreen.y;
      const newW = Math.max(MIN_W, resizeState.startSize.w + dxScreen / zoom);
      const newH = Math.max(MIN_H, resizeState.startSize.h + dyScreen / zoom);
      entry.data.width = newW;
      entry.data.height = newH;
      el.style.width = `${newW}px`;
      el.style.height = `${newH}px`;
      const now = Date.now();
      if (now - lastLiveSent > 40) {
        lastLiveSent = now;
        Api.liveNote(id, { width: newW, height: newH });
      }
    });
    handle.addEventListener('pointerup', () => {
      if (!resizeState) return;
      handle.releasePointerCapture(resizeState.pointerId);
      resizeState = null;
      entry.resizing = false;
      el.classList.remove('is-resizing');
      Api.updateNote(id, { width: entry.data.width, height: entry.data.height, bringToFront: true }).then(applyRemoteUpdate).catch(() => {});
    });
  }

  // ---------- Création ----------

  document.getElementById('addNoteBtn').addEventListener('click', () => {
    hideHint();
    const rect = viewportEl.getBoundingClientRect();
    const { x: wx, y: wy } = screenToWorld(rect.width / 2, rect.height / 2);
    const offset = (creationCount % 6) * 18;
    creationCount++;
    const color = NOTE_COLORS[creationCount % NOTE_COLORS.length];
    Api.createNote({ x: wx - DEFAULT_W / 2 + offset, y: wy - DEFAULT_H / 2 + offset, color }).catch(err => alert(err.message));
  });

  // ---------- Temps réel ----------

  Realtime.on('note:created', (note) => { if (!notes.has(note.id)) renderNote(note); });
  Realtime.on('note:updated', applyRemoteUpdate);
  Realtime.on('note:deleted', ({ id }) => removeNoteLocal(id));
  Realtime.on('note:dragging', ({ id, x, y, width, height }) => {
    const entry = notes.get(id);
    if (!entry || entry.dragging || entry.resizing) return;
    if (x != null) { entry.el.style.left = `${x}px`; entry.data.x = x; }
    if (y != null) { entry.el.style.top = `${y}px`; entry.data.y = y; }
    if (width != null) { entry.el.style.width = `${width}px`; entry.data.width = width; }
    if (height != null) { entry.el.style.height = `${height}px`; entry.data.height = height; }
  });

  // ---------- Chargement initial ----------

  Api.getWhiteboard().then((whiteboard) => {
    document.getElementById('whiteboardTitle').textContent = whiteboard.workshopName;
    document.getElementById('whiteboardSubtitle').textContent = `${whiteboard.clientName} — ${whiteboard.projectName}`;
    document.title = whiteboard.workshopName;

    centerView();
    applyTransform();
    whiteboard.notes.forEach(renderNote);
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
