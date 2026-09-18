/* Comportement générique du header/drawers communs (ouverture/fermeture par id). */
function shOpenDrawer(drawerId, overlayId) {
  document.getElementById(drawerId).classList.add('open');
  document.getElementById(overlayId).classList.add('open');
}
function shCloseDrawer(drawerId, overlayId) {
  document.getElementById(drawerId).classList.remove('open');
  document.getElementById(overlayId).classList.remove('open');
}

/* SSO : demande un jeton de transfert court à l'outil courant (mintUrl), puis navigue dans le
   même onglet vers un autre outil de la suite avec ce jeton en paramètre — évite d'avoir à
   ressaisir son mot de passe en changeant d'outil. En cas d'échec (réseau, pas de permission...),
   on navigue quand même vers l'outil cible, qui redemandera simplement une connexion normale. */
async function shGoToTool(mintUrl, token, targetUrl) {
  try {
    const res = await fetch(mintUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
    const data = await res.json();
    if (res.ok && data.ticket) {
      window.location.href = `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}ssoTicket=${encodeURIComponent(data.ticket)}`;
      return;
    }
  } catch (_) {}
  window.location.href = targetUrl;
}
