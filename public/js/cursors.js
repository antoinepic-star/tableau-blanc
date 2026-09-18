const Realtime = (() => {
  const listeners = {};
  const remoteCursors = new Map(); // name -> { color, x, y, el }
  let cursorLayer, avatarsEl;
  let worldToScreen = (x, y) => ({ x, y });
  let myName = sessionStorage.getItem(`tb_name_${Api.whiteboardId}`);

  function on(event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
  }
  function emit(event, data) {
    (listeners[event] || []).forEach(cb => cb(data));
  }

  function initials(name) {
    return name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  function renderAvatars(users) {
    avatarsEl.innerHTML = '';
    users.forEach(u => {
      const el = document.createElement('div');
      el.className = 'avatar-bubble';
      el.style.background = u.color;
      el.title = u.name;
      el.textContent = initials(u.name);
      avatarsEl.appendChild(el);
    });
  }

  function svgArrow(color) {
    return `<svg width="20" height="24" viewBox="0 0 20 24" fill="none">
      <path d="M2 1L2 19L7 15L10 22L13.5 20.5L10.3 13.5L17 13.5L2 1Z" fill="${color}" stroke="white" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>`;
  }

  function ensureCursorEl(name, color) {
    let entry = remoteCursors.get(name);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.innerHTML = `${svgArrow(color)}<span class="cursor-label" style="background:${color}">${name}</span>`;
      cursorLayer.appendChild(el);
      entry = { color, x: 0, y: 0, el };
      remoteCursors.set(name, entry);
    }
    return entry;
  }

  function removeCursor(name) {
    const entry = remoteCursors.get(name);
    if (entry) {
      entry.el.remove();
      remoteCursors.delete(name);
    }
  }

  // Repositionne tous les curseurs distants à l'écran à partir de leur position "monde" stockée
  // et de la transform (pan/zoom) courante du canvas — appelé par board.js à chaque pan/zoom.
  function repositionAll() {
    remoteCursors.forEach(entry => {
      const { x: sx, y: sy } = worldToScreen(entry.x, entry.y);
      entry.el.style.transform = `translate(${sx}px, ${sy}px)`;
    });
  }

  function handleCursorUpdate({ name, color, x, y }) {
    if (name === myName) return;
    const entry = ensureCursorEl(name, color);
    entry.x = x;
    entry.y = y;
    repositionAll();
  }

  let lastSent = 0;
  // Appelé par board.js à chaque déplacement du pointeur, avec la position "monde" déjà calculée.
  function notifyLocalPointer(worldX, worldY) {
    const now = Date.now();
    if (now - lastSent < 45) return;
    lastSent = now;
    Api.sendCursor(worldX, worldY);
  }

  function connect({ toScreen }) {
    cursorLayer = document.getElementById('cursorLayer');
    avatarsEl = document.getElementById('onlineAvatars');
    worldToScreen = toScreen;

    const es = new EventSource(`/api/whiteboards/${Api.whiteboardId}/stream?token=${encodeURIComponent(Api.token)}`);
    es.addEventListener('presence:snapshot', e => {
      const { users } = JSON.parse(e.data);
      renderAvatars(users);
      const activeNames = new Set(users.map(u => u.name));
      [...remoteCursors.keys()].forEach(name => { if (!activeNames.has(name)) removeCursor(name); });
    });
    es.addEventListener('cursor:update', e => handleCursorUpdate(JSON.parse(e.data)));
    es.addEventListener('cursor:leave', e => removeCursor(JSON.parse(e.data).name));

    ['element:created', 'element:updated', 'element:deleted', 'element:dragging'].forEach(evt => {
      es.addEventListener(evt, e => emit(evt, JSON.parse(e.data)));
    });
  }

  return { on, connect, repositionAll, notifyLocalPointer };
})();
