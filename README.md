# WorkAdventure pour Spicetify

Extension [Spicetify](https://spicetify.app/) pour le WorkAdventure de goyan.fr : **écouter en même temps qu'un
collègue**, sur son propre ordinateur, **sans Premium**.

Une Jam Spotify ne fait jouer, avec un compte gratuit, que l'enceinte de l'hôte. Ici, pas de Jam : votre Spotify joue
lui-même le morceau du collègue, à la même position, et le suit quand il change de morceau.

## Prérequis

- Le client desktop [workadventure-desktop](https://github.com/aminekun90/workadventure-desktop) (0.1.0-beta.14 ou plus
  récent), lancé.
- Spotify desktop avec [Spicetify](https://spicetify.app/docs/getting-started).
- Le partage Spotify activé dans WorkAdventure (Réglages → Spotify).

Sans ces trois éléments, rien ne change : le bouton « Écouter en même temps » n'apparaît pas, et la Jam Spotify reste
le moyen d'écouter ensemble (Premium).

## Installer

```bash
curl -fsSL https://raw.githubusercontent.com/aminekun90/workadventure-spicetify/main/workadventure.js \
  -o "$(spicetify path userdata)/Extensions/workadventure.js"
spicetify config extensions workadventure.js
spicetify apply
```

Sous Windows (PowerShell), remplacer la première commande par :

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/aminekun90/workadventure-spicetify/main/workadventure.js `
  -OutFile "$(spicetify path userdata)\Extensions\workadventure.js"
```

Au démarrage de Spotify, la notification « WorkAdventure connecté » confirme le lien avec le client desktop.

## Utiliser

Dans WorkAdventure, cliquer sur un collègue qui écoute un morceau Spotify, puis **« Écouter en même temps »** sur sa
carte « En écoute ». Le même bouton arrête.

## Désinstaller

```bash
spicetify config extensions workadventure.js-
spicetify apply
```

## Fonctionnement

L'extension ne parle qu'au client desktop, sur cet ordinateur (`ws://127.0.0.1:47613`), qui n'accepte que l'app
Spotify. Elle lui envoie le morceau joué et sa position ; le client les partage dans WorkAdventure. Pour suivre un
collègue, le client lui demande de jouer son morceau (`Spicetify.Player.playUri`) à sa position (`seek`). Aucune
connexion directe entre ordinateurs, aucune mesure d'usage.
