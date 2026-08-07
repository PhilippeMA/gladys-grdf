# GRDF Gazpar

Cette intégration lit la consommation de gaz mesurée par votre compteur
**Gazpar** et la transforme en appareils Gladys : votre gaz apparaît alors à côté
du reste des données de votre maison — courbes quotidiennes, scènes et écran
énergie.

GRDF ne propose pas d'API publique pour les particuliers. L'intégration se
connecte donc à votre compte client comme le ferait un navigateur, sur
[monespace.grdf.fr](https://monespace.grdf.fr), et lit exactement les relevés
quotidiens que le site vous affiche.

## Ce qu'il vous faut

- un compte client GRDF (celui de monespace.grdf.fr), avec votre compteur déjà
  rattaché ;
- un compteur communicant **Gazpar** : les relevés quotidiens n'existent que
  pour ceux-là. Avec un ancien compteur relevé deux fois par an par un
  technicien, GRDF ne publie qu'un relevé global par période, et c'est tout ce
  que l'intégration pourra afficher ;
- un compte qui ne demande **pas** d'étape de vérification supplémentaire à la
  connexion (code à usage unique par SMS ou e-mail, captcha) : l'intégration ne
  sait répondre qu'à l'étape du mot de passe.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Saisissez l'**e-mail** et le **mot de passe** de votre compte GRDF. Le mot de
   passe est stocké chiffré par Gladys et n'est transmis qu'à GRDF.
3. Laissez **PCE à suivre** vide pour suivre tous les compteurs du compte. Si
   votre compte comporte plusieurs points de comptage et que vous n'en voulez
   qu'une partie, listez leurs numéros de PCE à 14 chiffres, séparés par des
   virgules. Un PCE figure sur votre facture de gaz et dans Mon Espace GRDF.
4. Choisissez l'**historique à importer** : le nombre de jours passés récupérés
   lors de la première synchronisation. GRDF conserve environ trois ans, vous
   pouvez donc importer plusieurs mois d'un coup pour obtenir des courbes qui
   ont déjà un passé. Cela ne concerne que la première synchronisation ; ensuite,
   l'intégration ne récupère que les nouveautés. Importer un long historique
   prend quelques minutes : Gladys n'accepte qu'un nombre limité de mesures par
   minute, l'intégration les injecte donc en douceur — comptez environ une
   minute par deux mois importés.
5. Cliquez sur **Tester la connexion GRDF** : elle se connecte et liste les
   points de comptage trouvés. C'est le moyen le plus rapide de vérifier vos
   identifiants.
6. Enregistrez. Les compteurs apparaissent dans l'onglet **Découverte**, prêts à
   être ajoutés à votre maison.

## Les appareils obtenus

Un appareil par point de comptage, nommé d'après l'alias que vous lui avez donné
dans Mon Espace, portant quatre capteurs en lecture seule :

| Capteur                        | Unité | Ce que c'est                                             |
| ------------------------------ | ----- | -------------------------------------------------------- |
| Consommation quotidienne       | kWh   | Énergie consommée pendant la journée gazière (facturée)  |
| Volume quotidien               | m³    | Volume brut de gaz consommé pendant la journée gazière   |
| Index compteur                 | m³    | Index du compteur à la fin de la journée gazière         |
| Température extérieure moyenne | °C    | Température extérieure moyenne associée au jour par GRDF |

Chaque valeur est enregistrée à la date du jour qu'elle concerne, et non à la
date de son téléchargement : vos courbes restent justes malgré le retard de
publication.

## Quand arrivent les données

GRDF publie un relevé avec **un à deux jours de retard**, généralement dans la
journée qui suit la mesure. Rien n'est temps réel ici : la consommation du lundi
arrive typiquement le mardi ou le mercredi. C'est une limite du réseau Gazpar
lui-même (le compteur n'émet qu'une fois par jour), pas de l'intégration.

L'intégration interroge GRDF selon son propre calendrier — toutes les six heures
par défaut, ce qui est largement suffisant pour une valeur quotidienne. L'action
**Rafraîchir les données maintenant** force une récupération immédiate si vous
ne voulez pas attendre.

## En cas de problème

**« Tester la connexion GRDF » échoue.** Essayez de vous connecter sur
[monespace.grdf.fr](https://monespace.grdf.fr) avec les mêmes identifiants dans
une fenêtre de navigation privée. Si GRDF vous y demande un code ou un captcha,
l'intégration ne passera pas non plus.

**« GRDF served its HTML app shell » ou « the session was not accepted ».** GRDF
a répondu par une page web au lieu de données. Son site fait cela quand il
n'accepte pas la session, mais aussi quand il traverse simplement un mauvais
moment — il ne dit jamais lequel des deux. L'intégration se reconnecte et
réessaie seule plusieurs fois ; si cela échoue encore, patientez quelques
minutes puis utilisez **Rafraîchir les données maintenant**. Si cela persiste,
vérifiez que monespace.grdf.fr fonctionne dans votre navigateur : GRDF freine
parfois un compte qui s'est connecté de nombreuses fois d'affilée.

**Aucune donnée nouvelle depuis plusieurs jours.** Vérifiez sur le site GRDF que
les relevés sont bien publiés pour votre compteur : un Gazpar qui a perdu sa
liaison radio n'alimente plus GRDF, et l'intégration ne peut montrer que ce que
GRDF possède.

**Les valeurs semblent fausses ou dupliquées.** L'intégration mémorise le dernier
jour publié pour chaque compteur : elle ne réimporte jamais deux fois le même
jour. Si vous supprimez un appareil puis le recréez, son historique repart de la
fenêtre d'import configurée.

Pour le détail de ce qui se passe, consultez les logs de l'intégration depuis
l'interface Gladys (ou `docker logs` sur l'hôte) ; passez `LOG_LEVEL=debug` pour
la version bavarde.

## Vie privée

Vos identifiants GRDF et vos données de consommation restent entre votre serveur
Gladys et GRDF. Rien n'est envoyé ailleurs, aucun service tiers n'intervient.
