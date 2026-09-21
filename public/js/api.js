const Api = (() => {
  const whiteboardId = location.pathname.split('/')[2];
  const tokenKey = `tb_token_${whiteboardId}`;

  // Lien d'aperçu admin (depuis le back-office) : le token est fourni en paramètre d'URL,
  // c'est la seule façon d'ouvrir un tableau privé sans passer par la page nom + mot de passe.
  const params = new URLSearchParams(location.search);
  const adminToken = params.get('adminToken');
  if (adminToken) {
    sessionStorage.setItem(tokenKey, adminToken);
    sessionStorage.setItem(`tb_name_${whiteboardId}`, params.get('adminName') || 'Admin');
    sessionStorage.setItem(`tb_color_${whiteboardId}`, params.get('adminColor') || '#29335C');
    history.replaceState(null, '', location.pathname);
  }

  const token = sessionStorage.getItem(tokenKey);
  if (!token) window.location.href = `/w/${whiteboardId}`;

  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      sessionStorage.removeItem(tokenKey);
      window.location.href = `/w/${whiteboardId}`;
      throw new Error('Session expirée');
    }
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await res.json() : null;
    if (!res.ok) throw new Error(data?.error || 'Erreur serveur');
    return data;
  }

  const base = `/api/whiteboards/${whiteboardId}`;

  // Le PATCH élément fait un lire-modifier-écrire côté serveur : si deux PATCH pour le même
  // élément partent en parallèle (ex. double-clic rapide sur un toggle), ils peuvent être traités
  // dans le désordre et le dernier à se terminer "gagne", même si ce n'est pas le dernier envoyé.
  // On chaîne les PATCH par élément pour garantir que chacun parte une fois le précédent terminé.
  const updateChains = new Map();
  function updateElement(id, patch) {
    const prev = updateChains.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => request('PATCH', `${base}/elements/${id}`, patch));
    updateChains.set(id, next);
    return next;
  }

  return {
    token,
    whiteboardId,
    getWhiteboard: () => request('GET', base),
    createElement: (element) => request('POST', `${base}/elements`, element || {}),
    updateElement,
    liveElement: (id, patch) => request('POST', `${base}/elements/${id}/live`, patch).catch(() => {}),
    deleteElement: (id) => request('DELETE', `${base}/elements/${id}`),
    sendCursor: (x, y) => request('POST', `${base}/cursor`, { x, y }).catch(() => {}),
  };
})();
