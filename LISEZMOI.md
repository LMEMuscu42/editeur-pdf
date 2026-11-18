# Éditeur PDF

Logiciel Windows pour modifier des fichiers PDF.

## Installation

Dans le dossier `dist` :
- `EditeurPDF-installation.exe` : installe le logiciel et crée un raccourci sur le Bureau.
- `EditeurPDF-portable.exe` : se lance directement, sans installation.

Windows SmartScreen peut afficher un avertissement au premier lancement, car l'exécutable n'est pas signé : cliquez sur « Informations complémentaires » puis « Exécuter quand même ».

## Fonctions

| Outil | Raccourci | Utilisation |
|---|---|---|
| Sélection | V | Cliquer pour sélectionner, glisser pour déplacer, poignée en bas à droite pour redimensionner, double-clic sur un texte pour le modifier, flèches pour déplacer finement |
| Texte | T | Cliquer puis écrire. Entrée = nouvelle ligne, Ctrl+Entrée ou clic ailleurs = valider, Échap = annuler |
| Modifier texte | E | Cliquer sur un texte existant du PDF pour le remplacer (police, taille et couleur détectées) |
| Surligner | H | Glisser sur une zone |
| Rectangle / Ligne / Flèche | R / L / A | Glisser |
| Dessin | D | Dessin à main levée |
| Effaceur | W | Recouvre une zone de blanc |
| Image | | Insère une image PNG, JPG, WebP… (vous pouvez aussi la glisser-déposer sur la page) |
| Signature | | Dessinez une signature, elle est insérée sur la page |

Pages (barre de gauche) : pivoter, monter/descendre (ou glisser les vignettes), supprimer, insérer une page vierge, fusionner d'autres PDF, extraire la page courante.

Autres raccourcis : Ctrl+O ouvrir, Ctrl+S enregistrer, Ctrl+Maj+S enregistrer sous, Ctrl+Z / Ctrl+Y annuler / rétablir, Suppr supprimer l'élément sélectionné, Ctrl+molette zoomer, Page préc./suiv. pour changer de page.

## À savoir

- « Modifier texte » et « Effaceur » **recouvrent** le contenu d'origine d'un rectangle blanc. Visuellement le texte disparaît, mais il reste dans le fichier et on peut encore le copier ou le retrouver par une recherche. Pour supprimer réellement une information confidentielle, ces outils ne suffisent pas.
- Les polices disponibles pour le texte ajouté sont Helvetica, Times et Courier. Les caractères qu'elles ne prennent pas en charge (emoji, alphabets non latins) sont remplacés par « ? ».
- Les PDF protégés par mot de passe s'ouvrent après avoir saisi le mot de passe. À l'enregistrement, leurs pages sont converties en images.

## Développement

```
npm start        # lancer depuis les sources
npm run dist     # reconstruire les exécutables dans dist/
```

Technologies : Electron, pdf.js (affichage) et pdf-lib (écriture).
