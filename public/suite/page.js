/* Comportements génériques réutilisés par les pages restylées (préfixe sh-). */

function shInitDropdown(triggerId, panelId) {
  const trigger = document.getElementById(triggerId);
  const panel = document.getElementById(panelId);
  if (!trigger || !panel) return;
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.sh-dropdown-panel.open').forEach((el) => { if (el !== panel) el.classList.remove('open'); });
    panel.classList.toggle('open');
  });
}
document.addEventListener('click', () => {
  document.querySelectorAll('.sh-dropdown-panel.open').forEach((el) => el.classList.remove('open'));
});

function shOpenModal(id) { document.getElementById(id).classList.add('open'); }
function shCloseModal(id) { document.getElementById(id).classList.remove('open'); }

function shTogglePasswordReveal(inputId, btnEl) {
  const input = document.getElementById(inputId);
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  btnEl.innerHTML = isPassword
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}

function shCopyValue(inputId, btnEl) {
  const input = document.getElementById(inputId);
  navigator.clipboard?.writeText(input.value);
  const original = btnEl.textContent;
  btnEl.textContent = 'Copié !';
  setTimeout(() => { btnEl.textContent = original; }, 1600);
}

function shInitVisibilitySwitch(switchId, sectionId, onLabel, offLabel, labelId) {
  const input = document.getElementById(switchId);
  const section = document.getElementById(sectionId);
  const label = labelId ? document.getElementById(labelId) : null;
  function sync() {
    section.style.display = input.checked ? '' : 'none';
    if (label) label.textContent = input.checked ? onLabel : offLabel;
  }
  input.addEventListener('change', sync);
  sync();
}
