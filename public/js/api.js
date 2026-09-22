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

  async function request(method, url, body, signal) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
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

  // Même problème que updateElement ci-dessus, mais à l'échelle du lot : sans cette file, un
  // déplacement plus ancien peut répondre après un plus récent et écraser sa position/son z_index
  // (éléments qui "reviennent" tout seuls après coup, ordre d'empilement qui se remélange).
  //
  // Une simple file FIFO ne suffit pas : si l'utilisateur enchaîne plusieurs glisser-déposer du même
  // groupe plus vite que l'aller-retour réseau, chaque position intermédiaire finit quand même par
  // partir et s'appliquer à son tour — visible comme si l'élément "rejouait" tout le trajet après le
  // relâchement. Tant qu'un envoi pour un lot d'éléments donné n'est pas encore parti, un nouvel
  // appel pour EXACTEMENT le même lot le remplace au lieu de s'empiler derrière : seule la dernière
  // position compte, les intermédiaires ne sont jamais transmises. Un envoi déjà en vol ne peut pas
  // être annulé, mais une fois sa réponse arrivée son résultat est ignoré si un plus récent lui a
  // depuis succédé (repéré via `isLatest` — cf. board.js) — donc au pire un seul palier intermédiaire
  // s'affiche, jamais toute la série. Des lots portant sur des éléments différents restent chacun en
  // FIFO l'un derrière l'autre, sans se remplacer.
  const batchMoveQueue = [];
  let batchMoveInFlight = false;
  let batchMoveVersion = 0;

  function batchMoveKey(moves) {
    return moves.map(m => m.id).sort().join(',');
  }

  function pumpBatchMoveQueue() {
    if (batchMoveInFlight || !batchMoveQueue.length) return;
    const { moves, bringToFront, resolve, reject } = batchMoveQueue.shift();
    batchMoveInFlight = true;
    const version = ++batchMoveVersion;
    request('POST', `${base}/elements/batch-move`, { moves, bringToFront })
      .then(result => resolve({ ...result, isLatest: version === batchMoveVersion }), reject)
      .finally(() => { batchMoveInFlight = false; pumpBatchMoveQueue(); });
  }

  function updateElementsBatch(moves, bringToFront = true) {
    const key = batchMoveKey(moves);
    return new Promise((resolve, reject) => {
      const last = batchMoveQueue[batchMoveQueue.length - 1];
      if (last && last.key === key) {
        last.resolve({ elements: [], superseded: true });
        batchMoveQueue[batchMoveQueue.length - 1] = { key, moves, bringToFront, resolve, reject };
      } else {
        batchMoveQueue.push({ key, moves, bringToFront, resolve, reject });
      }
      pumpBatchMoveQueue();
    });
  }

  // Les positions "live" pendant un glisser/redimensionnement sont juste un aperçu visuel pour les
  // autres participants, envoyées en rafale (jusqu'à toutes les ~40ms, par élément) et jamais
  // persistées. Sur un glisser de groupe, ça fait vite beaucoup de requêtes concurrentes pour le même
  // onglet — au-delà de la limite de connexions simultanées du navigateur par origine, certaines
  // restent simplement en attente. Si le relâchement arrive avant qu'elles soient toutes parties,
  // celles encore en attente ne sont annulées par rien : elles finissent par partir 1-2 secondes plus
  // tard et rediffusent une position déjà périmée, qui s'applique bel et bien puisque le geste local
  // est terminé (élément qui "rebouge tout seul" juste après le relâchement). On annule donc la
  // requête "live" précédente pour un élément dès qu'une nouvelle la remplace, et on expose
  // cancelLiveElement pour couper net celle encore pendante au moment du relâchement.
  const liveAbortControllers = new Map();
  function liveElement(id, patch) {
    liveAbortControllers.get(id)?.abort();
    const controller = new AbortController();
    liveAbortControllers.set(id, controller);
    return request('POST', `${base}/elements/${id}/live`, patch, controller.signal).catch(() => {});
  }
  function cancelLiveElement(id) {
    liveAbortControllers.get(id)?.abort();
    liveAbortControllers.delete(id);
  }

  return {
    token,
    whiteboardId,
    getWhiteboard: () => request('GET', base),
    createElement: (element) => request('POST', `${base}/elements`, element || {}),
    updateElement,
    updateElementsBatch,
    liveElement,
    cancelLiveElement,
    deleteElement: (id) => request('DELETE', `${base}/elements/${id}`),
    sendCursor: (x, y) => request('POST', `${base}/cursor`, { x, y }).catch(() => {}),
    toggleVote: (elementId) => request('POST', `${base}/elements/${elementId}/vote`),
    getComments: (elementId) => request('GET', `${base}/elements/${elementId}/comments`),
    createComment: (elementId, text) => request('POST', `${base}/elements/${elementId}/comments`, { text }),
    deleteComment: (elementId, commentId) => request('DELETE', `${base}/elements/${elementId}/comments/${commentId}`),
  };
})();
