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

  // Nombre de requêtes DE CE CLIENT actuellement en vol pour un élément donné (tous champs confondus :
  // position, couleur, verrouillage, vote, groupe...), exposé via isPending. board.js s'en sert pour
  // ignorer complètement un écho serveur (sa propre réponse en retard, ou la diffusion SSE qu'il
  // déclenche — reçue par l'auteur aussi, cf. broadcast côté serveur) tant qu'un changement plus
  // récent pour ce MÊME élément est encore en vol : sans ça, une réponse/diffusion arrivée dans le
  // désordre peut écraser un état plus frais déjà affiché localement (l'élément "revient en arrière"
  // ou semble se figer après plusieurs actions rapprochées). updateElement/updateElementsBatch
  // l'incrémentent à l'appel et le décrémentent à leur résolution (succès, échec, ou "superseded").
  const pendingCounts = new Map();
  function markPending(id) { pendingCounts.set(id, (pendingCounts.get(id) || 0) + 1); }
  function unmarkPending(id) {
    const n = (pendingCounts.get(id) || 1) - 1;
    if (n <= 0) pendingCounts.delete(id); else pendingCounts.set(id, n);
  }
  function isPending(id) { return pendingCounts.has(id); }

  // Le PATCH élément fait un lire-modifier-écrire côté serveur : si deux PATCH pour le même
  // élément partent en parallèle (ex. double-clic rapide sur un toggle), ils peuvent être traités
  // dans le désordre et le dernier à se terminer "gagne", même si ce n'est pas le dernier envoyé.
  // On chaîne les PATCH par élément pour garantir que chacun parte une fois le précédent terminé.
  const updateChains = new Map();
  function updateElement(id, patch) {
    markPending(id);
    const prev = updateChains.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => request('PATCH', `${base}/elements/${id}`, patch));
    updateChains.set(id, next);
    return next.then(
      (result) => { unmarkPending(id); return result; },
      (err) => { unmarkPending(id); throw err; }
    );
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

  function batchMoveKey(moves) {
    return moves.map(m => m.id).sort().join(',');
  }

  function pumpBatchMoveQueue() {
    if (batchMoveInFlight || !batchMoveQueue.length) return;
    const { key, moves, bringToFront, resolve, reject } = batchMoveQueue.shift();
    batchMoveInFlight = true;
    request('POST', `${base}/elements/batch-move`, { moves, bringToFront })
      .then(result => {
        // Un lot pour ce même ensemble d'éléments attend-il déjà de partir ? Si oui, cette réponse
        // correspond à une position qu'on sait déjà dépassée (une image peut mettre plusieurs
        // secondes à faire l'aller-retour) : on ne l'applique pas, celle du dessus arrivera de toute
        // façon sous peu. Un simple compteur de version ne suffit pas ici : tant que ce lot suivant
        // n'est pas réellement PARTI (juste posé en file derrière celui-ci), il n'aurait pas encore
        // incrémenté ce compteur au moment où cette réponse arrive.
        const isLatest = !batchMoveQueue.some(entry => entry.key === key);
        resolve({ ...result, isLatest });
      }, reject)
      .finally(() => { batchMoveInFlight = false; pumpBatchMoveQueue(); });
  }

  function updateElementsBatch(moves, bringToFront = true) {
    const key = batchMoveKey(moves);
    const ids = moves.map(m => m.id);
    ids.forEach(markPending);
    const unmarkAll = () => ids.forEach(unmarkPending);
    return new Promise((resolve, reject) => {
      const last = batchMoveQueue[batchMoveQueue.length - 1];
      if (last && last.key === key) {
        last.resolve({ elements: [], superseded: true });
        batchMoveQueue[batchMoveQueue.length - 1] = { key, moves, bringToFront, resolve, reject };
      } else {
        batchMoveQueue.push({ key, moves, bringToFront, resolve, reject });
      }
      pumpBatchMoveQueue();
    }).then(
      (result) => { unmarkAll(); return result; },
      (err) => { unmarkAll(); throw err; }
    );
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

  // "Ordonner" (bouton d'action ponctuelle, pas un mode) : range une fois le contenu actuel de la
  // frame. Un double-clic accidentel ne doit pas partir deux fois en parallèle — la seconde requête
  // attend que la première soit terminée plutôt que d'être ignorée, comme la file de updateElement.
  const arrangeChains = new Map();
  function arrangeFrame(frameId) {
    const prev = arrangeChains.get(frameId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => request('POST', `${base}/elements/${frameId}/arrange`));
    arrangeChains.set(frameId, next);
    return next;
  }

  // Le vote est un bascule lire-puis-écrire côté serveur (voté ? je retire : j'ajoute) : deux clics
  // rapprochés partis en parallèle peuvent tous les deux lire "pas encore voté" et tous les deux
  // ajouter une ligne, ou se marcher dessus dans l'autre sens — même défaut que le PATCH élément
  // (cf. updateElement plus haut), donc même remède : chaîné sur updateChains (partagé avec les PATCH
  // de cet élément, un vote et un changement de couleur par ex. n'ont pas plus de raison de se
  // chevaucher que deux votes).
  function toggleVote(elementId) {
    markPending(elementId);
    const prev = updateChains.get(elementId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => request('POST', `${base}/elements/${elementId}/vote`));
    updateChains.set(elementId, next);
    return next.then(
      (result) => { unmarkPending(elementId); return result; },
      (err) => { unmarkPending(elementId); throw err; }
    );
  }

  return {
    token,
    whiteboardId,
    getWhiteboard: () => request('GET', base),
    createElement: (element) => request('POST', `${base}/elements`, element || {}),
    updateElement,
    updateElementsBatch,
    isPending,
    arrangeFrame,
    liveElement,
    cancelLiveElement,
    deleteElement: (id, { deleteContents } = {}) => request('DELETE', `${base}/elements/${id}`, deleteContents ? { deleteContents: true } : undefined),
    sendCursor: (x, y) => request('POST', `${base}/cursor`, { x, y }).catch(() => {}),
    toggleVote,
    getComments: (elementId) => request('GET', `${base}/elements/${elementId}/comments`),
    createComment: (elementId, text) => request('POST', `${base}/elements/${elementId}/comments`, { text }),
    deleteComment: (elementId, commentId) => request('DELETE', `${base}/elements/${elementId}/comments/${commentId}`),
  };
})();
