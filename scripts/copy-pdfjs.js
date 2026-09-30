// Copie les deux fichiers navigateur de pdfjs-dist (déjà buildés dans le paquet npm) vers
// public/vendor/pdfjs, servis tels quels par express.static — pas de bundler dans ce projet, donc pas
// moyen d'importer directement depuis node_modules côté client. Tourne à chaque `npm install`
// (postinstall) plutôt que d'être committé : ce sont des fichiers générés par une dépendance, pas du
// code du projet (cf. .gitignore).
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build');
const DEST_DIR = path.join(__dirname, '..', 'public', 'vendor', 'pdfjs');
const FILES = ['pdf.min.mjs', 'pdf.worker.min.mjs'];

fs.mkdirSync(DEST_DIR, { recursive: true });
for (const file of FILES) {
  fs.copyFileSync(path.join(SRC_DIR, file), path.join(DEST_DIR, file));
}
console.log(`pdfjs-dist : ${FILES.length} fichiers copiés vers public/vendor/pdfjs`);
