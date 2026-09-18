# Tableau Blanc — Post-its collaboratifs multi-clients

Outil type Miro très simple : un tableau blanc par atelier, sur lequel n'importe qui participe sans compte — déplacer, agrandir, recolorer et éditer des post-its, zoomer/dézoomer et se déplacer dans le tableau. Présence et curseurs des participants visibles en temps réel.

Un back-office (`/admin`) permet de créer un nouveau tableau par atelier/projet, avec son propre nom, son propre mot de passe et sa propre visibilité (public/privé) — même fonctionnement que les boards Kanban.

## Démarrage en local

1. Installer les dépendances :
   ```
   npm install
   ```
2. Copier `.env.example` en `.env` et renseigner `ADMINISTRATION_URL` (pointant vers une instance locale ou déployée d'Administration) et `INTERNAL_API_SECRET` (identique à celui d'Administration).
3. Lancer le serveur :
   ```
   npm start
   ```
4. Ouvrir [http://localhost:3060/admin](http://localhost:3060/admin) pour créer/gérer les tableaux (connexion via Administration).

En local, si `TURSO_DATABASE_URL` est vide, les données sont stockées dans `data/whiteboard.db` (SQLite local) — pas besoin de compte Turso pour tester.

## Déployer sur Render

1. Créer une base Turso gratuite : [https://turso.tech](https://turso.tech) → créer une base, récupérer son URL et un token.
2. Sur [Render](https://render.com) : "New +" → "Web Service" → connecter ce dossier/repo.
   - Build command : `npm install`
   - Start command : `npm start`
3. Dans l'onglet "Environment" de Render, ajouter les variables :
   - `ADMINISTRATION_URL` → l'URL d'Administration déployée
   - `INTERNAL_API_SECRET` → identique à celui d'Administration
   - `JWT_SECRET` → une chaîne aléatoire longue (ex : générée avec `openssl rand -hex 32`)
   - `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` → récupérés à l'étape 1
   - Ne pas définir `PORT` (Render le fournit automatiquement)
4. Une fois l'URL Render connue, renseigner `WHITEBOARD_URL` (cette même URL) dans les variables d'environnement d'Administration, Vue Projet et UX Dashboard pour activer l'agrégation (compteurs de projet, fil d'activité, tuile "Nos outils").
5. L'app tourne sur une seule instance (plan gratuit/starter Render) — le temps réel (post-its, curseurs, présence) se fait en mémoire sur le process et est scopé par tableau ; si le service tourne un jour sur plusieurs instances, il faudrait un pub/sub (Redis) pour que ça se synchronise entre elles. Les post-its restent cohérents dans tous les cas grâce à Turso.

## Utilisation

1. Va sur `/admin`, connecte-toi (identité vérifiée auprès d'Administration).
2. "+ Créer un nouveau tableau" : choisis un client, un projet (existant ou à créer), un sous-titre, et un mot de passe si le tableau est public.
3. Copie le lien (`/w/<id>`) et donne-le avec le mot de passe aux participants.
4. Sur le tableau : bouton "+ Post-it" pour créer une note (couleur, position et taille modifiables), molette pour déplacer la vue, Ctrl/Cmd + molette pour zoomer. La vue (zoom/position) est propre à chaque participant ; seul le contenu des post-its est partagé.

## Fonctionnement

- **Post-its** : créer, déplacer (glisser), redimensionner (poignée en bas à droite), recolorer (palette au survol), éditer le texte (clic pour entrer en édition, sauvegarde automatique), supprimer (croix au survol ou touche Suppr sur une note sélectionnée).
- **Temps réel** : toute action est diffusée instantanément aux participants du même tableau (jamais aux autres tableaux) via Server-Sent Events, curseurs et positions en cours de glissement compris.
- **Accès** : une page d'entrée par tableau, avec nom + mot de passe partagé (pas de compte individuel).

## Notes

- Un seul type d'élément pour l'instant : le post-it. Pas de dessin libre, formes, images ou connecteurs.
- Le design cible desktop uniquement, pas d'adaptation mobile.
