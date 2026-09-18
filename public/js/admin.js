(() => {
  const TOKEN_KEY = 'tb_admin_token';
  const USER_KEY = 'tb_admin_user';
  let token = sessionStorage.getItem(TOKEN_KEY);
  let me = JSON.parse(sessionStorage.getItem(USER_KEY) || 'null');
  let favorites = [];
  let clients = [];
  let clientsLoaded = false; // distinct de clients.length : évite de confondre "chargé, 0 client" et "échec du chargement"

  const SUITE_URLS = {
    dashboard: 'https://ux-dashboard.onrender.com/login',
    kanban: 'https://trello-collaboratif.onrender.com/admin.html',
    designReview: 'https://wireframe-review.onrender.com/admin',
    administration: 'https://administration-u3wi.onrender.com/login',
    vueProjet: 'https://vue-projet.onrender.com/login',
  };
  document.getElementById('shToolDashboard').addEventListener('click', (e) => {
    e.preventDefault();
    shGoToTool('/api/admin/sso-ticket', token, SUITE_URLS.dashboard);
  });
  document.getElementById('shToolKanban').addEventListener('click', (e) => {
    e.preventDefault();
    shGoToTool('/api/admin/sso-ticket', token, SUITE_URLS.kanban);
  });
  document.getElementById('shToolDesignReview').addEventListener('click', (e) => {
    e.preventDefault();
    shGoToTool('/api/admin/sso-ticket', token, SUITE_URLS.designReview);
  });
  document.getElementById('shToolAdmin').addEventListener('click', (e) => {
    e.preventDefault();
    shGoToTool('/api/admin/sso-ticket', token, SUITE_URLS.administration);
  });
  document.getElementById('shToolVueProjet').addEventListener('click', (e) => {
    e.preventDefault();
    shGoToTool('/api/admin/sso-ticket', token, SUITE_URLS.vueProjet);
  });

  const loginScreen = document.getElementById('loginScreen');
  const adminApp = document.getElementById('adminApp');
  const whiteboardListView = document.getElementById('whiteboardListView');
  const whiteboardDetailView = document.getElementById('whiteboardDetailView');

  function initials(name) {
    return (name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  }

  function paintAvatar(el, user) {
    if (user.avatarData) {
      el.style.backgroundImage = `url(${user.avatarData})`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.textContent = '';
    } else {
      el.style.backgroundImage = 'none';
      el.style.background = user.avatarColor || '#5b4fe9';
      el.textContent = initials(user.name);
    }
  }

  function renderHeader() {
    if (!me) return;
    paintAvatar(document.getElementById('shHeaderAvatar'), me);
    document.getElementById('shHeaderName').textContent = me.name;
    paintAvatar(document.getElementById('shAccountAvatar'), me);
    document.getElementById('shAccountName').value = me.name;
    document.getElementById('shAccountNote').style.display = me.role === 'superadmin' ? 'none' : '';
  }

  document.getElementById('shAccountAvatarFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = await api('POST', '/api/admin/avatar', { dataUri: reader.result });
        me.avatarData = data.avatarData;
        sessionStorage.setItem(USER_KEY, JSON.stringify(me));
        paintAvatar(document.getElementById('shAccountAvatar'), me);
        paintAvatar(document.getElementById('shHeaderAvatar'), me);
      } catch (err) {
        alert(err.message);
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('shLogoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    token = null;
    me = null;
    window.location.href = SUITE_URLS.dashboard + '?loggedOut=1';
  });

  // Un service Render gratuit endormi répond par une page d'erreur HTML (pas du JSON) le temps de
  // se réveiller, ou le fetch échoue tout court.
  function showServiceUnavailable(redirectUrl) {
    if (document.getElementById('suiteUnavailableOverlay')) return;
    const el = document.createElement('div');
    el.id = 'suiteUnavailableOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(26,26,30,.92);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;z-index:99999;text-align:center;padding:24px;';
    el.textContent = 'Connexion au serveur perdue — redirection vers la page de connexion…';
    document.body.appendChild(el);
    setTimeout(() => { window.location.href = redirectUrl; }, 2500);
  }

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      showServiceUnavailable(SUITE_URLS.dashboard);
      return new Promise(() => {});
    }
    const isJson = res.headers.get('content-type')?.includes('application/json');
    if (!isJson) {
      showServiceUnavailable(SUITE_URLS.dashboard);
      return new Promise(() => {});
    }
    const data = await res.json();
    if (res.status === 401 || res.status === 403) {
      sessionStorage.removeItem(TOKEN_KEY);
      token = null;
      showLogin();
      throw new Error(data?.error || 'Session expirée');
    }
    if (!res.ok) throw new Error(data?.error || 'Erreur serveur');
    return data;
  }

  function showLogin() {
    window.location.href = SUITE_URLS.dashboard;
  }
  function showApp() {
    document.getElementById('ssoLoading').style.display = 'none';
    loginScreen.style.display = 'none';
    adminApp.style.display = '';
    renderHeader();
    loadFavorites().catch(() => {});
    showWhiteboardList();
  }

  function showWhiteboardList() {
    whiteboardDetailView.style.display = 'none';
    whiteboardListView.style.display = '';
    loadWhiteboards().catch(err => alert(err.message));
  }

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('loginError');
    errorEl.textContent = '';
    try {
      const data = await api('POST', '/api/admin/login', {
        login: document.getElementById('loginUser').value,
        password: document.getElementById('loginPassword').value,
      });
      token = data.token;
      me = data.user;
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(me));
      showApp();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  const ssoTicket = new URLSearchParams(window.location.search).get('ssoTicket');
  if (ssoTicket) {
    const remaining = new URLSearchParams(window.location.search);
    remaining.delete('ssoTicket');
    const newSearch = remaining.toString();
    history.replaceState(null, '', window.location.pathname + (newSearch ? '?' + newSearch : ''));
    document.getElementById('ssoLoading').style.display = 'flex';
  }

  if (token && me) {
    showApp();
  } else if (!ssoTicket) {
    showLogin();
  }

  if (ssoTicket) {
    (async function tryTicketLogin() {
      try {
        const res = await fetch('/api/admin/sso-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: ssoTicket }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Jeton invalide ou expiré');
        token = data.token; me = data.user;
        sessionStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(USER_KEY, JSON.stringify(me));
        showApp();
      } catch (err) {
        showLogin();
      }
    })();
  }

  // ---------- Favoris ----------

  async function loadFavorites() {
    favorites = await api('GET', '/api/admin/favorites');
  }

  function isFavorite(whiteboardId) {
    return favorites.some(f => f.itemType === 'whiteboard' && f.itemId === whiteboardId);
  }

  async function toggleFavorite(whiteboard, btn) {
    try {
      const { isFavorite: nowFav } = await api('POST', '/api/admin/favorites/toggle', {
        itemId: whiteboard.id,
        itemLabel: `${whiteboard.clientName} — ${whiteboard.projectName}`,
        itemUrl: `${location.origin}/admin?whiteboard=${whiteboard.id}`,
      });
      await loadFavorites();
      btn.classList.toggle('sh-is-fav', nowFav);
      btn.title = nowFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- Liste des tableaux ----------

  async function loadWhiteboards() {
    const whiteboards = await api('GET', '/api/admin/whiteboards');
    renderWhiteboardList(whiteboards);
    const wantedId = new URLSearchParams(window.location.search).get('whiteboard');
    if (wantedId) {
      history.replaceState(null, '', window.location.pathname);
      const whiteboard = whiteboards.find(w => w.id === wantedId);
      if (whiteboard) openWhiteboardDetail(whiteboard);
    }
  }

  function renderWhiteboardList(whiteboards) {
    const listEl = document.getElementById('whiteboardList');
    listEl.innerHTML = '';
    if (!whiteboards.length) {
      listEl.innerHTML = '<div class="sh-empty-state">Aucun tableau pour l’instant — crée le premier avec le bouton ci-dessus.</div>';
      return;
    }
    whiteboards.forEach(w => {
      const fav = isFavorite(w.id);
      const row = document.createElement('div');
      row.className = 'sh-list-row';
      row.innerHTML = `
        <button type="button" class="sh-fav-btn${fav ? ' sh-is-fav' : ''}" title="${fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
          <svg width="16" height="16" viewBox="0 0 24 24" stroke-width="1.8" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>
        <div class="sh-list-row-main">
          <span class="sh-eyebrow"></span>
          <span class="sh-list-row-title"></span>
          <span class="sh-list-row-subtitle"></span>
        </div>
        <div class="sh-list-row-right">
          <span class="sh-tag ${w.isPublic ? 'sh-tag--public' : 'sh-tag--private'}">${w.isPublic ? 'Public' : 'Privé'}</span>
          <svg class="sh-chevron-right" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      `;
      row.querySelector('.sh-eyebrow').textContent = w.clientName.toUpperCase();
      row.querySelector('.sh-list-row-title').textContent = w.projectName;
      row.querySelector('.sh-list-row-subtitle').textContent = `${w.workshopName} · ${w.noteCount} post-it${w.noteCount > 1 ? 's' : ''}`;
      row.querySelector('.sh-fav-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(w, e.currentTarget);
      });
      row.addEventListener('click', () => openWhiteboardDetail(w));
      listEl.appendChild(row);
    });
  }

  document.getElementById('newWhiteboardBtn').addEventListener('click', () => openWhiteboardForm(null));
  document.getElementById('backToListBtn').addEventListener('click', showWhiteboardList);

  // ---------- Clients / projets ----------

  async function ensureClientsLoaded() {
    if (clientsLoaded) return;
    try {
      clients = await api('GET', '/api/admin/clients');
      clientsLoaded = true;
    } catch {
      clients = [];
    }
  }

  function populateClientSelect(selectedClientId, selectedClientName) {
    const select = document.getElementById('wfClient');
    const hasMatch = !!selectedClientId && clients.some(c => c.id === selectedClientId);
    let optionsHtml = clients.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    if (!hasMatch && selectedClientName) {
      optionsHtml = `<option value="" disabled selected>${selectedClientName} (à rattacher à un client)</option>` + optionsHtml;
    } else if (!selectedClientId) {
      optionsHtml = `<option value="" disabled selected>Choisir un client</option>` + optionsHtml;
    }
    select.innerHTML = optionsHtml;
    if (hasMatch) select.value = selectedClientId;
  }

  let projectSearchTimer = null;
  function initProjectAutocomplete() {
    const clientSelect = document.getElementById('wfClient');
    const input = document.getElementById('wfProject');
    const list = document.getElementById('wfProjectList');

    async function render() {
      const clientId = clientSelect.value;
      if (!clientId) { list.classList.remove('open'); return; }
      const query = input.value.trim();
      let projects = [];
      try { projects = await api('GET', `/api/admin/clients/${clientId}/projects?q=${encodeURIComponent(query)}`); } catch { projects = []; }
      list.innerHTML = '';
      if (projects.length) {
        projects.forEach((p) => {
          const item = document.createElement('div');
          item.className = 'sh-autocomplete-item';
          item.textContent = p.name;
          item.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = p.name; list.classList.remove('open'); });
          list.appendChild(item);
        });
      } else {
        const empty = document.createElement('div');
        empty.className = 'sh-autocomplete-empty';
        empty.textContent = 'Aucun projet existant pour ce client.';
        list.appendChild(empty);
      }
      if (query && !projects.some(p => p.name.toLowerCase() === query.toLowerCase())) {
        const create = document.createElement('div');
        create.className = 'sh-autocomplete-item sh-create-new';
        create.textContent = `+ Créer « ${query} »`;
        create.addEventListener('mousedown', (e) => { e.preventDefault(); list.classList.remove('open'); });
        list.appendChild(create);
      }
      list.classList.add('open');
    }

    clientSelect.onchange = () => { input.value = ''; render(); };
    input.onfocus = render;
    input.oninput = () => { clearTimeout(projectSearchTimer); projectSearchTimer = setTimeout(render, 200); };
    input.onblur = () => setTimeout(() => list.classList.remove('open'), 120);
  }
  initProjectAutocomplete();

  // ---------- Drawer : créer / modifier un tableau ----------

  let editingWhiteboardId = null;
  let whiteboardFormReadonly = false;

  function canEditWhiteboard(whiteboard) {
    return me.role === 'superadmin' || (!!whiteboard.createdBy && whiteboard.createdBy === me.id);
  }

  async function openWhiteboardForm(whiteboard) {
    await ensureClientsLoaded();
    editingWhiteboardId = whiteboard ? whiteboard.id : null;
    whiteboardFormReadonly = whiteboard ? !canEditWhiteboard(whiteboard) : false;

    document.getElementById('whiteboardFormTitle').textContent = whiteboard ? 'Modifier le tableau' : 'Nouveau tableau';
    populateClientSelect(whiteboard ? whiteboard.clientId : null, whiteboard ? whiteboard.clientName : null);
    document.getElementById('wfProject').value = whiteboard ? whiteboard.projectName : '';
    document.getElementById('wfSubtitle').value = whiteboard ? whiteboard.workshopName : '';
    document.getElementById('wfVisibility').checked = whiteboard ? whiteboard.isPublic : true;
    document.getElementById('wfVisibility').dispatchEvent(new Event('change'));
    document.getElementById('wfPassword').value = whiteboard ? whiteboard.password : '';

    ['wfClient', 'wfProject', 'wfSubtitle', 'wfVisibility', 'wfPassword'].forEach((id) => {
      document.getElementById(id).disabled = whiteboardFormReadonly;
    });
    document.getElementById('whiteboardFormSaveBtn').style.display = whiteboardFormReadonly ? 'none' : '';
    document.getElementById('whiteboardFormSaveBtn').textContent = whiteboard ? 'Enregistrer' : 'Créer le tableau';
    shOpenDrawer('whiteboardFormDrawer', 'whiteboardFormOverlay');
  }

  shInitVisibilitySwitch('wfVisibility', 'wfPasswordSection', 'Public', 'Privé', 'wfVisibilityLabel');

  document.getElementById('whiteboardFormSaveBtn').addEventListener('click', async () => {
    const clientSelect = document.getElementById('wfClient');
    const clientId = clientSelect.value;
    const clientName = clientSelect.selectedOptions[0]?.textContent.replace(' (non rattaché)', '') || '';
    const projectNameRaw = document.getElementById('wfProject').value.trim();
    const workshopName = document.getElementById('wfSubtitle').value.trim();
    const isPublic = document.getElementById('wfVisibility').checked;
    const password = document.getElementById('wfPassword').value.trim();
    if (!clientId || !projectNameRaw || !workshopName) { alert('Merci de remplir le client, le projet et le sous-titre.'); return; }
    if (isPublic && !password) { alert('Merci de choisir un mot de passe.'); return; }
    const btn = document.getElementById('whiteboardFormSaveBtn');
    btn.disabled = true;
    try {
      const project = await api('POST', `/api/admin/clients/${clientId}/projects`, { name: projectNameRaw });
      const payload = { clientId, clientName, projectId: project.id, projectName: project.name, workshopName, isPublic, password };
      const whiteboard = editingWhiteboardId
        ? await api('PUT', `/api/admin/whiteboards/${editingWhiteboardId}`, payload)
        : await api('POST', '/api/admin/whiteboards', payload);
      shCloseDrawer('whiteboardFormDrawer', 'whiteboardFormOverlay');
      await loadWhiteboards();
      openWhiteboardDetail(whiteboard);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Page détail d'un tableau ----------

  let currentWhiteboard = null;
  let detailEditable = true;

  async function openWhiteboardDetail(whiteboard) {
    currentWhiteboard = whiteboard;

    document.getElementById('ehClient').textContent = whiteboard.clientName;
    document.getElementById('ehProject').textContent = whiteboard.projectName;
    document.getElementById('ehSubtitle').textContent = whiteboard.workshopName;

    const fav = document.getElementById('detailFavBtn');
    const isFav = isFavorite(whiteboard.id);
    fav.classList.toggle('sh-is-fav', isFav);
    fav.title = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
    fav.onclick = () => toggleFavorite(whiteboard, fav);

    document.getElementById('deleteWhiteboardMenuBtn').style.display = me.role === 'superadmin' ? '' : 'none';
    detailEditable = canEditWhiteboard(whiteboard);
    document.getElementById('readOnlyNote').style.display = detailEditable ? 'none' : '';
    document.getElementById('ehVisibility').disabled = !detailEditable;

    renderVisibility(whiteboard);

    whiteboardListView.style.display = 'none';
    whiteboardDetailView.style.display = '';
  }

  function renderVisibility(whiteboard) {
    document.getElementById('ehVisibility').checked = whiteboard.isPublic;
    document.getElementById('ehVisibilityLabel').textContent = whiteboard.isPublic ? 'Public' : 'Privé';
    document.getElementById('ehPublicSection').style.display = whiteboard.isPublic ? '' : 'none';
    document.getElementById('ehPrivateNote').style.display = whiteboard.isPublic ? 'none' : '';
    if (whiteboard.isPublic) {
      document.getElementById('ehLink').value = `${location.origin}/w/${whiteboard.id}`;
      const pwInput = document.getElementById('ehPassword');
      pwInput.value = whiteboard.password;
      pwInput.type = 'password';
    }
  }

  document.getElementById('ehVisibility').addEventListener('change', async (e) => {
    const isPublic = e.target.checked;
    if (isPublic && !currentWhiteboard.password) {
      alert('Ce tableau n\'a pas encore de mot de passe : ouvre "Modifier" pour en définir un avant de le rendre public.');
      e.target.checked = false;
      return;
    }
    try {
      const payload = {
        clientId: currentWhiteboard.clientId, clientName: currentWhiteboard.clientName,
        projectId: currentWhiteboard.projectId, projectName: currentWhiteboard.projectName,
        workshopName: currentWhiteboard.workshopName, password: currentWhiteboard.password,
        isPublic,
      };
      currentWhiteboard = await api('PUT', `/api/admin/whiteboards/${currentWhiteboard.id}`, payload);
      renderVisibility(currentWhiteboard);
    } catch (err) {
      alert(err.message);
      e.target.checked = !isPublic;
    }
  });

  shInitDropdown('whiteboardKebabBtn', 'whiteboardKebabMenu');
  document.getElementById('editWhiteboardMenuBtn').addEventListener('click', () => openWhiteboardForm(currentWhiteboard));
  document.getElementById('previewWhiteboardMenuBtn').addEventListener('click', async () => {
    try {
      const { token: previewToken, name, color } = await api('POST', `/api/admin/whiteboards/${currentWhiteboard.id}/preview-token`);
      const params = new URLSearchParams({ adminToken: previewToken, adminName: name, adminColor: color });
      window.open(`${location.origin}/w/${currentWhiteboard.id}/board?${params.toString()}`, '_blank');
    } catch (err) {
      alert(err.message);
    }
  });
  document.getElementById('deleteWhiteboardMenuBtn').addEventListener('click', () => shOpenModal('deleteWhiteboardModal'));
  document.getElementById('confirmDeleteWhiteboardBtn').addEventListener('click', async () => {
    try {
      await api('DELETE', `/api/admin/whiteboards/${currentWhiteboard.id}`);
      shCloseModal('deleteWhiteboardModal');
      showWhiteboardList();
    } catch (err) {
      alert(err.message);
    }
  });
})();
