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
| Sélection | V | Cliquer pour sélectionner, glisser pour déplacer, poignée en bas à droite pour redimensionner, double-clic sur un texte pour le modifier, flèches pour déplacer finement. Les champs de formulaire se remplissent dans ce mode |
| Texte | T | Cliquer puis écrire. Entrée = nouvelle ligne, Ctrl+Entrée ou clic ailleurs = valider, Échap = annuler |
| Modifier texte | E | Cliquer sur un texte existant du PDF pour le remplacer (police, taille et couleur détectées) |
| Surligner | H | Glisser sur une zone |
| Note | N | Cliquer pour poser une note (commentaire). Cliquer sur la note pour la relire ou la modifier |
| Rectangle / Ligne / Flèche | R / L / A | Glisser |
| Dessin | D | Dessin à main levée |
| Effaceur | W | Recouvre une zone de blanc |
| Image | | Insère une image PNG, JPG, WebP… (vous pouvez aussi la glisser-déposer sur la page) |
| Signature | | Dessinez une signature, elle est insérée sur la page |
| Numéros | | Numérote toutes les pages (position, format « Page 1 sur 10 »…, premier numéro, première page ignorée) |
| Filigrane | | Ajoute un texte en diagonale ou horizontal au centre de chaque page (couleur, taille, opacité) |

**Affichage** : les pages défilent en continu. La loupe (Ctrl+F) cherche un mot dans tout le document, sans tenir compte des accents ni des majuscules ; Entrée ou F3 passe au résultat suivant, Maj+Entrée au précédent.

**Formulaires** : les champs d'un PDF remplissable (texte, cases à cocher, boutons radio, listes) apparaissent en bleu clair et se remplissent directement. Ils restent remplissables dans le PDF enregistré.

**Commentaires** : l'onglet « Commentaires » de la barre de gauche liste vos notes et celles déjà présentes dans le document. Les notes sont enregistrées comme de vrais commentaires PDF, lisibles dans Acrobat, Edge, etc.

**Pages** (barre de gauche) : pivoter, monter/descendre (ou glisser les vignettes), supprimer, insérer une page vierge, fusionner d'autres PDF, extraire la page courante.

**Récents** : le menu « Récents » et l'écran d'accueil proposent les derniers fichiers ouverts.

**Mode sombre** : bouton lune/soleil en haut à droite. Par défaut, l'application suit le thème de Windows.

Autres raccourcis : Ctrl+O ouvrir, Ctrl+S enregistrer, Ctrl+Maj+S enregistrer sous, Ctrl+Z / Ctrl+Y annuler / rétablir, Suppr supprimer l'élément sélectionné, Ctrl+molette zoomer, Page préc./suiv., Début/Fin pour changer de page.

## À savoir

- « Modifier texte » et « Effaceur » **recouvrent** le contenu d'origine d'un rectangle blanc. Visuellement le texte disparaît, mais il reste dans le fichier et on peut encore le copier ou le retrouver par une recherche. Pour supprimer réellement une information confidentielle, ces outils ne suffisent pas.
- Les polices disponibles pour le texte ajouté sont Helvetica, Times et Courier. Les caractères qu'elles ne prennent pas en charge (emoji, alphabets non latins) sont remplacés par « ? ».
- Les PDF protégés par mot de passe s'ouvrent après avoir saisi le mot de passe. À l'enregistrement, leurs pages sont converties en images.
- Les valeurs saisies dans les formulaires ne passent pas par Annuler / Rétablir.

## Développement

```
npm start        # lancer depuis les sources
npm run dist     # reconstruire les exécutables dans dist/
```

Test automatique des fonctions : `electron test/v11.js <formulaire.pdf> <dossier-de-sortie>`.

Technologies : Electron, pdf.js (affichage) et pdf-lib (écriture).
