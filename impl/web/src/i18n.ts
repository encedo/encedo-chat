/**
 * i18n.ts — UI strings, one catalogue, no dependency.
 *
 * **The Polish source text IS the key.** `t('Usuń grupę')` looks that string up
 * and falls back to it when a locale has no entry. This is the gettext model,
 * and it is chosen over invented keys (`group.delete.confirm`) for two reasons
 * that matter more here than tidiness: the conversion is mechanical and
 * therefore safe to do across ~190 call sites, and a missing translation
 * degrades to the text the app already shipped rather than to a raw key
 * leaking into the interface. The cost is that editing the Polish invalidates
 * that entry — acceptable while there is one translation to keep in step.
 *
 * Plurals are not string interpolation and must not be treated as such. Polish
 * has three forms where English has two: 1 członek / 2 członkowie / 5 członków.
 * The code this replaced said `${n} członków` unconditionally, so it rendered
 * "2 członków" — already wrong before any translation existed. An entry may
 * therefore be a set of CLDR forms, selected with `Intl.PluralRules` for the
 * ACTIVE locale, which is the only way to get both languages right from one
 * call site.
 */

/** CLDR plural categories. Polish uses one/few/many, English one/other. */
export interface Forms { one?: string; few?: string; many?: string; other: string }
type Entry = string | Forms

/**
 * Translations by locale. Polish appears here ONLY where the source key cannot
 * express itself — that is, plurals, where one literal cannot carry three forms.
 * Everything else falls through to the key.
 *
 * **Sorted, and it has to stay sorted**, because both ways this table rots are
 * invisible otherwise. A duplicate key is not a syntax error — the later one
 * silently wins, and the table had seven of them, one pair disagreeing about
 * what the word meant. And an entry whose Polish source has since been edited
 * stops matching anything, so it lives on translating a string nobody asks for
 * while the new wording shows an English reader Polish. Sorting makes the first
 * kind impossible to miss on sight; the second needs the source checked, which
 * is what emptied twenty-one entries left behind by the removed P1–P3 profile
 * UI and the old badge wording.
 */
const CATALOG: Record<string, Record<string, Entry>> = {
  pl: {
    '{n} członków': { one: '{n} członek', few: '{n} członkowie', many: '{n} członków', other: '{n} członka' },
    '{n} poł.': { one: '{n} poł.', few: '{n} poł.', many: '{n} poł.', other: '{n} poł.' },
    '⚠️ Not secure': '⚠️ Niezabezpieczona',
    '🔐 Secure': '🔐 Bezpieczna',
    '🟢 Direct': '🟢 Bezpośrednio',
    '🤝 Securing…': '🤝 Zabezpieczam…',
  },
  en: {
    ' a klucz grupy zostanie skasowany z HEM — grupy nie da się już przywrócić.': ' and the group key will be erased from the HEM — the group cannot be restored.',
    ' Ich dotychczasowa kopia rozmowy pozostanie u nich; nie da się jej usunąć zdalnie.': ' Their existing copy of the conversation stays with them; it cannot be deleted remotely.',
    ' Obie sesje zostały zamknięte — jedna tożsamość, jedna aktywna sesja.': ' Both sessions were closed — one identity, one active session.',
    ' po {ms} ms': ' after {ms} ms',
    ' Pozostali członkowie zachowują grupę — nie da się jej usunąć u nich.': ' The other members keep the group — it cannot be deleted on their devices.',
    ' Usunąć wpis grupy z HEM? Jeśli nie, spróbuję ponownie przy następnym logowaniu.': ' Remove the group entry from the HEM? If not, it will be tried again at the next sign-in.',
    ' Zamknij nadmiarową kartę i odśwież tę, w której chcesz rozmawiać.': ' Close the extra tab and reload the one you want to talk in.',
    ' Zapisz go „tylko lokalnie” — będzie w tej przeglądarce, ale nie w HEM.': ' Save it as “this browser only” — it will live here, but not in the HEM.',
    ' · edytowano': ' · edited',
    ' · edytowano (poprawka dotarła z opóźnieniem)': ' · edited (the correction arrived late)',
    ' · edytowano — wysyłam poprawkę…': ' · edited — sending the correction…',
    ' · wysyłam ponownie…': ' · resending…',
    ' · wysyłam…': ' · sending…',
    ' · wysłano': ' · sent',
    ' · ⚠ poprawka nie dotarła': ' · ⚠ the correction did not arrive',
    ' · ⚠ niedostarczone': ' · ⚠ not delivered',
    ' — najczęściej druga zakładka zalogowana na tę samą tożsamość. Zamknij jedną z nich.': ' — usually a second tab logged in as the same identity. Close one of them.',
    ' ⏱ spóźniona': ' ⏱ late',
    '(brak dopasowań)': '(no matches)',
    '(brak grup — utwórz)': '(no groups — create one)',
    '(brak kontaktów — dodaj peera)': '(no contacts — add a peer)',
    '+ dodaj': '+ add',
    '+ Dodaj członka': '+ Add member',
    '+ Dodaj peera': '+ Add a peer',
    '+ Nowa grupa': '+ New group',
    ', a klucz kontaktu zostanie usunięty z HEM': ', and the contact\'s key will be removed from the HEM',
    '1. wybór': '1st choice',
    'Administrator nie odpowiedział. Może być offline — albo nie jesteś już członkiem tej grupy; tego nie da się rozróżnić.': 'The administrator did not answer. They may be offline — or you may no longer be a member; the two cannot be told apart.',
    'Adres HEM': 'HEM address',
    'Grupa': 'Group',
    'Jest nowa wersja {v}': 'Version {v} is available',
    'Książka kontaktów nie przeszła weryfikacji': 'The contact book failed its signature check',
    'Mam HEM — zaloguj': 'I have a HEM — sign in',
    'Mikrofon ucichł — nagrało się {got} s z {wanted} s': 'The microphone went quiet — {got} s recorded out of {wanted} s',
    'Nie ma tu jeszcze profilu.': 'No profile on this device yet.',
    'Nie ma tu jeszcze profilu. Załóż go teraz albo zaloguj się swoim HEM.': 'No profile here yet. Create one now, or sign in with your HEM.',
    'Nie udało się zaktualizować — pobierz nową wersję ręcznie': 'Could not update — download the new version by hand',
    'Offline': 'Offline',
    'Online': 'Online',
    'Pobieram aktualizację…': 'Downloading the update…',
    'Profil o tej nazwie już tu jest — wybierz inną nazwę albo wejdź w niego z listy.': 'A profile with that name is already here — pick another name, or open it from the list.',
    'Później': 'Later',
    'Ta kopia pochodzi z pakietu systemowego, więc nie podmieni się sama. Nową wersję trzeba pobrać.': 'This copy came from a system package, so it will not replace itself. The new version has to be downloaded.',
    'Wróć do profili na tym urządzeniu': 'Back to profiles on this device',
    'Wybierz profil.': 'Choose a profile.',
    'Zainstalować teraz? Aplikacja uruchomi się ponownie.': 'Install it now? The app will restart.',
    'Zainstaluj': 'Install',
    'Zarejestruj': 'Register',
    'Załóż profil': 'Create a profile',
    'Załóż profil na tym urządzeniu': 'Create a profile on this device',
    'aktywny': 'active',
    'Anuluj': 'Cancel',
    'Anuluj odpowiedź': 'Cancel reply',
    'bez HEM:': 'without a HEM:',
    'bez WebRTC': 'no WebRTC',
    'Bezpośredni kanał jest szybszy i nie przechodzi przez węzeł, ale rozmówca widzi wtedy Twój adres IP. Wybór dotyczy rozmów otwieranych od teraz — trwającej nie przełączamy, bo to zerwałoby kanał w środku zdania. Odznaka w nagłówku pokazuje stan faktyczny każdej rozmowy.':
      'A direct channel is faster and does not pass through the node, but the other side sees your IP address. This applies to conversations opened from now on — a running one is not switched, which would cut the channel mid-sentence. The badge in the header shows what each conversation is actually doing.',
    'Brak potwierdzenia mimo ponowień — rozmówca prawdopodobnie tego nie dostał': 'No acknowledgement despite retries — they probably did not receive this',
    'brak połączenia z przekaźnikiem': 'no connection to the relay',
    'Brak dostępu do kamery: ': 'No camera access: ',
    'Brak połączenia z przekaźnikiem — odśwież stronę': 'No connection to the relay — reload the page',
    'Brak profili software na tym urządzeniu.': 'No software profiles on this device.',
    'Brak sesji — zaloguj się.': 'No session — sign in.',
    'brak sygnału': 'no signal',
    'Brak tożsamości czatu na tym HEM — zarejestruj.': 'No chat identity on this HEM — register one.',
    'brak — sesja efemeryczna': 'none — ephemeral session',
    'Błąd': 'Error',
    'Błąd listy kontaktów: ': 'Contact list error: ',
    'błąd połączenia': 'connection error',
    'Błąd tożsamości software: ': 'Software identity error: ',
    'Błąd usuwania: ': 'Delete failed: ',
    'Błąd zapisu: ': 'Save failed: ',
    'Błąd: ': 'Error: ',
    'Ciemny': 'Dark',
    'Cytowanej wiadomości nie ma już w tej rozmowie': 'The quoted message is no longer in this conversation',
    'Czekam na potwierdzenie od klienta rozmówcy': 'Waiting for their client to acknowledge',
    'Członkowie': 'Members',
    'Dalej': 'Continue',
    'Dodaj kontakt': 'Add the contact',
    'Dodaj peera': 'Add a peer',
    'Dodaję…': 'Adding…',
    'dostarczone': 'delivered',
    'dostarczone z opóźnieniem': 'delivered late',
    'Dotarła po nowszych wiadomościach — wstawiona w miejscu, w którym została napisana': 'Arrived after newer messages — placed where it was written',
    'Dołącz plik': 'Attach a file',
    'Dołączono do grupy „{name}”': 'Joined the group “{name}”',
    'Dwuklik = kopiuj klucz publiczny': 'Double-click to copy the public key',
    'Edytuj': 'Edit',
    'Edytujesz wiadomość': 'Editing a message',
    'Ekran': 'Screen',
    'failover': 'failover',
    'Failover po liście węzłów: gdy pierwszy węzeł nie odpowiada, sesja przechodzi na następny. Węzły są zmeshowane, więc przełączenie nie dzieli rozmówców.': 'Failover down the node list: when the first node does not answer, the session moves to the next. The nodes are meshed, so switching does not separate you from anyone.',
    'Grupa idzie przez relay (GossipSub) — nie WebRTC': 'Groups go over the relay (GossipSub), not WebRTC',
    'Grupa — Sender Keys + per-recipient HMAC (deniable, §8)': 'Group — Sender Keys + per-recipient HMAC (deniable, §8)',
    'Grupa „{name}” jest w HEM, ale nie mam kontaktu do jej administratora.': 'The group “{name}” is in the HEM, but its administrator is not one of my contacts.',
    'Grupa „{name}” usunięta': 'Group “{name}” deleted',
    'Grupa „{name}” utworzona — rozsyłam zaproszenia…': 'Group “{name}” created — sending invitations…',
    'Grupy': 'Groups',
    'Handle (widoczny dla kontaktów)': 'Handle (visible to contacts)',
    'Handshake EH-2 uzgodniony — forward secrecy per wiadomość, hybryda PQ (ML-KEM-768)': 'EH-2 handshake agreed — per-message forward secrecy, PQ hybrid (ML-KEM-768)',
    'Handshake nie doszedł do skutku — ponowi się przy następnym Announce': 'The handshake did not complete — it will retry on the next Announce',
    'Hasła się różnią.': 'The passwords do not match.',
    'Hasło': 'Password',
    'Hasło profilu źródłowego': "The source profile's password",
    'Hasło zmienione.': 'Password changed.',
    'Podaj hasło profilu źródłowego.': "Enter the source profile's password.",
    'Złe hasło profilu źródłowego.': 'Wrong password for the source profile.',
    'Przepisz kontakty z profilu': 'Copy the contacts from a profile',
    'Pobrać ją teraz? Instalacja i restart przyjdą osobno, kiedy powiesz.': 'Download it now? Installing and restarting come separately, when you say so.',
    'Pobrane.': 'Downloaded.',
    'Aktualizacja {v} pobrana': 'Update {v} downloaded',
    'Zainstalować i uruchomić ponownie teraz?': 'Install and restart now?',
    'Uruchom ponownie': 'Restart',
    'Dobrze — zaproponuję znów po następnym uruchomieniu.': 'All right — I will offer it again after the next launch.',
    '— nie przepisuj —': '— do not copy —',
    'Profil źródłowy jest w starym formacie — nie da się z niego przepisać.': 'The source profile is in the old format — nothing can be copied from it.',
    'Nie udało się zweryfikować książki profilu źródłowego.': "The source profile's contact book could not be verified.",
    'Książka profilu źródłowego nie przechodzi weryfikacji — przepisywanie odrzucone, a książka zostaje nietknięta jako dowód.': "The source profile's contact book fails its check — the copy is refused, and the book is left untouched as evidence.",
    'Przepisano kontakty z „{name}": {n}.': 'Copied the contacts from “{name}”: {n}.',
    'Kontakty przechodzą jako nazwy i klucze. Rozmówcy znają Cię ze starego klucza — z nowego profilu muszą Cię dodać ponownie.': 'Contacts travel as names and keys. Your peers know you by the old key — from the new profile they have to add you again.',
    'HEM nie odpowiada (timeout)': 'The HEM is not answering (timeout)',
    'HEM nie odpowiedział': 'The HEM did not answer',
    'HEM nieosiągalny (adres / CORS)': 'HEM unreachable (address / CORS)',
    'Historia': 'History',
    'Historia tej sesji zniknie — jest efemeryczna i nigdzie się nie zapisuje. Tożsamość i kontakty zostają.': 'This session\u2019s transcript will be gone \u2014 it is ephemeral and is never saved anywhere. Your identity and contacts stay.',
    'Jak w systemie': 'Match the system',
    'Jasny': 'Light',
    'Język': 'Language',
    'Każdy profil to osobna tożsamość, zaszyfrowana swoim hasłem. Usunięcie jest nieodwracalne — klucza nie da się odtworzyć.':
      'Each profile is a separate identity, sealed with its own password. Deleting one cannot be undone — the key cannot be recovered.',
    'KID (klucz w HSM)': 'KID (key in the HSM)',
    'Klient rozmówcy potwierdził odbiór{when} — to nie jest „przeczytane”': 'Their client acknowledged receipt{when} — this is not “read”',
    'Klucz nie jest poprawnym base64.': 'That key is not valid base64.',
    'Klucz nie wygląda na 32-bajtowy X25519 (base64).': 'That does not look like a 32-byte X25519 key (base64).',
    'Klucz publiczny (base64, X25519) albo link zaproszenia — i nazwa, pod którą go zapiszesz.': 'Their public key (base64, X25519) or an invite link — and the name you will keep it under.',
    'Klucz publiczny albo link zaproszenia': 'Public key or invite link',
    'Kolejność decyduje o wyborze: pierwszy aktywny węzeł jest podstawowy, kolejne to zapas. Zmiany działają natychmiast — bez wylogowania.': 'Order decides: the first enabled node is the primary, the rest are its fallbacks. Changes take effect immediately — no sign-out needed.',
    'Kontakt dodany. Żeby ta osoba mogła do Ciebie napisać, musi mieć też Twój klucz — odeślij jej ten link.':
      'Contact added. For them to reach you they need your key as well — send them this link.',
    'Kto napisał — bez treści': 'Who wrote — without the text',
    'Kontakty': 'Contacts',
    'Kopiuj link': 'Copy the link',
    'Ktoś zwrócił się do Ciebie': 'Somebody called your name',
    'Ktoś przysłał Ci swój profil. Sprawdź odcisk, zanim dodasz.': 'Someone sent you their profile. Check the fingerprint before adding.',
    'Link': 'Link',
    'Link skopiowany': 'Link copied',
    'Lista węzłów': 'Node list',
    'Loguję jako {name}…': 'Signing in as {name}…',
    'Lokalnie (ta przeglądarka)': 'Locally (this browser)',
    'Masz już kontakt „{name}"': 'You already have a contact called “{name}”',
    'Masz już konto?': 'Already have an account?',
    'Masz już kontakt „{name}” z INNYM kluczem — potwierdź odcisk osobno, zanim dodasz.':
      'You already have a contact “{name}” with a DIFFERENT key — confirm the fingerprint separately before adding.',
    'Motyw': 'Theme',
    'Musi zgadzać się co do znaku z tym, co podała Ci ta osoba innym kanałem niż link. Jeśli się nie zgadza — nie dodawaj.':
      'It must match character for character what that person gave you by a channel other than the link. If it does not match, do not add it.',
    'Musi zostać co najmniej jeden węzeł.': 'At least one node must remain.',
    'Na pewno?': 'Are you sure?',
    'Najpierw dodaj kontakty — członkowie grupy muszą być kontaktami.': 'Add contacts first — group members must be contacts.',
    'Najpierw musi odpowiedzieć HEM pod podanym adresem': 'The HEM at that address has to answer first',
    'Nazwa': 'Name',
    'Nazwa + członkowie. Tylko kontakty — każdy dostaje zaproszenie (klucze) przez Wasz kanał 1:1.': 'Name + members. Contacts only — each one gets an invitation (keys) over your 1:1 channel.',
    'Nazwa grupy': 'Group name',
    'Nazwa nie może być pusta.': 'The name cannot be empty.',
    'Nazwa profilu': 'Profile name',
    'Nazwa zmieni się u wszystkich członków — klucze zostają bez zmian.': 'The name changes for every member — the keys are untouched.',
    'Nie': 'No',
    'Nie ma profilu „{name}"': 'No profile named \u201c{name}\u201d',
    'Nie masz konta?': 'No account yet?',
    'Nie mogę połączyć się z HEM': 'Cannot reach the HEM',
    'Nie pokazuj tego ostrzeżenia ponownie': 'Don\'t show this warning again',
    'Nie udało się odzyskać grupy „{name}”': 'Could not recover the group “{name}”',
    'Nie udało się usunąć grupy: ': 'Could not delete the group: ',
    'Nie udało się wczytać listy: ': 'Could not load the list: ',
    'Nie udało się zapisać przypiętej wiadomości': 'Could not save the pinned message',
    'Nie udało się zapisać — brak klucza tej tożsamości': 'Could not save — this identity has no local key',
    'Nie udało się zmienić nazwy grupy: ': 'Could not rename the group: ',
    'Nie udało się zmienić nazwy: ': 'Could not rename: ',
    'Nie udało się zmienić składu grupy': 'Could not change the group membership',
    'importuj profil': 'import exported profile',
    'nie wysłano': 'not sent',
    'Nie znaleziono profilu do zmiany.': 'No profile found to change.',
    'Niżej': 'Move down',
    'Nowa wiadomość': 'New message',
    'Nowa grupa': 'New group',
    'Nowa tożsamość na tym urządzeniu. Hasła nie da się odzyskać ani zmienić bez niego — nie ma czego z nim porównać.':
      'A new identity on this device. The password cannot be recovered, and cannot be changed without it \u2014 there is nothing stored to compare it against.',
    'Nowe hasła się różnią.': 'The new passwords do not match.',
    'Nowe hasło': 'New password',
    'Nowe rozmowy pójdą tylko przez węzeł': 'New conversations will go through the node only',
    'Nowe rozmowy spróbują połączenia bezpośredniego': 'New conversations will try a direct connection',
    'nieobecny/a': 'away',
    'nowy profil': 'new profile',
    'np. alice': 'e.g. alice',
    'np. bob': 'e.g. bob',
    'np. Lab1': 'e.g. Lab1',
    'np. Zespół': 'e.g. Team',
    'Obecne hasło': 'Current password',
    'Odepnij': 'Unpin',
    'Odepnij — skasuje z pamięci przeglądarki': 'Unpin — removes it from this browser',
    'Odpiąć wiadomość?': 'Unpin this message?',
    'Odpięcie skasuje ją z pamięci tej przeglądarki. Ten komunikat pokaże się raz na sesję.':
      'Unpinning erases it from this browser. This notice is shown once a session.',
    'Odpowiedz': 'Reply',
    'Odcisk': 'Fingerprint',
    'Odeślij swój profil': 'Send yours back',
    'Opuść': 'Leave',
    'Opuść grupę': 'Leave group',
    'Opuścić grupę?': 'Leave the group?',
    'Opuszczono grupę „{name}”': 'Left the group “{name}”',
    'onchato potrzebuje kilku funkcji, których tu brakuje. Bez nich nie da się nawet ustalić wspólnego pokoju, więc logowanie jest wyłączone.':
      'onchato needs a few capabilities this browser does not have. Without them it cannot even derive a shared room, so signing in is disabled.',
    'Otwieram…': 'Opening…',
    'Otwórz': 'Open',
    'Otwórz {host} w nowej karcie': 'Open {host} in a new tab',
    'Otwórz — uwaga, adres używa znaków spoza ASCII; przeglądarka pójdzie do {host}': 'Open — careful, this address uses non-ASCII characters; the browser will go to {host}',
    'Otworzyć link?': 'Open this link?',
    'PeerId (efemeryczny)': 'PeerId (ephemeral)',
    'PeerId węzła': 'Node PeerId',
    'Platforma': 'Platform',
    'Plik jest za duży — limit to {mb} MB': 'That file is too large — the limit is {mb} MB',
    'Plik wygasł — poproś o ponowne wysłanie': 'The file expired — ask them to send it again',
    'Pobieram…': 'Downloading…',
    'Pobierz': 'Download',
    'Podaj adres HEM i hasło.': 'Enter the HEM address and password.',
    'Podaj handle.': 'Enter a handle.',
    'Podaj hasło.': 'Enter a password.',
    'Podaj nazwę grupy.': 'Enter a group name.',
    'Podaj nazwę i klucz.': 'Enter a name and a key.',
    'Podaj nazwę profilu.': 'Enter a profile name.',
    'Podaj nazwę.': 'Enter a name.',
    'Podaj nowe hasło.': 'Enter a new password.',
    'Podaj ten odcisk osobno — głosem albo osobiście. Odbiorca porówna go z tym, co zobaczy po kliknięciu linku; to jedyne, co wykrywa podmianę klucza po drodze.':
      'Give this fingerprint separately — by voice or in person. They will compare it with what the link shows them; it is the only thing that catches a key swapped in transit.',
    'Puka do Ciebie': 'Is knocking',
    'Puknij — zwróć uwagę': 'Knock — get their attention',
    'Puknięcie działa tylko, gdy rozmówca jest w pokoju': 'A knock only works while they are in the room',
    'Poprawić można w ciągu {n} minut od wysłania': 'A message can be corrected within {n} minutes of sending it',
    'Powiadomienia': 'Notifications',
    'Szukaj grupy…': 'Search groups…',
    'Obrazy i głosówki': 'Images and voice notes',
    'Pobieraj automatycznie obrazy i głosówki od kontaktów': 'Fetch images and voice notes from contacts automatically',
    'Pokazanie obrazka i odtworzenie głosówki to za każdym razem POBRANIE — bajty lecą ze schowka plików dopiero wtedy. Dlatego przychodzące czekają na kliknięcie. To ustawienie pobiera je z góry, ale głosówki nadal nie odtwarzają się same.': 'Showing an image and playing a voice note are both a DOWNLOAD \u2014 the bytes leave the file store only then. That is why an incoming one waits for a click. This setting fetches them ahead of time; voice notes still do not play by themselves.',
    'Na Androidzie aplikacja utrzymuje połączenie tak długo, jak jest uruchomiona — pokazuje wtedy stałe powiadomienie „onchato”. To jedyny sposób, żeby system nie zamroził jej w tle; nie ma tu skrzynki, która przechowa wiadomość na później.': 'On Android the app holds its connection for as long as it is running, and shows a permanent \u201Conchato\u201D notification while it does. That is the only way to stop the system freezing it in the background \u2014 there is no mailbox here to hold a message for later.',
    'Zaloguj jako {name}': 'Sign in as {name}',
    'Nagrywam…': 'Recording…',
    'Nagranie gotowe': 'Recording ready',
    'Limit nagrania to 2 minuty.': 'A recording is capped at 2 minutes.',
    'Odsłuchaj, zanim wyślesz.': 'Listen to it before you send it.',
    'Zatrzymaj': 'Stop',
    'Wyślij': 'Send',
    'Wczytaj przeniesiony profil': 'Load a profile moved from elsewhere',
    'To nie jest profil software — tożsamości z HEM nie da się przenieść plikiem': 'This is not a software profile \u2014 a HEM identity cannot be moved with a file',
    'Przenieś profil': 'Move the profile',
    'Przeniesienie na inne urządzenie': 'Moving to another device',
    'Zapisz profil do pliku': 'Save the profile to a file',
    'software': 'software',
    'Plik profilu': 'Profile file',
    'Hasło profilu': 'Profile password',
    'Zapiszesz plik z całym profilem: tożsamością, kontaktami, grupami i ustawieniami. Otwiera go to samo hasło, którym logujesz się do profilu.': 'You will save a file with the whole profile: the identity, the contacts, the groups and the settings. It opens with the same password you sign in to the profile with.',
    'Wczytany profil zastąpi ustawienia tej przeglądarki (język, motyw, lista węzłów). To PRZENIESIENIE, nie kopia — nie używaj obu kopii naraz, bo jedna tożsamość może mieć tylko jedną aktywną sesję.': 'The loaded profile will replace this browser\u2019s settings (language, theme, node list). This is a MOVE, not a copy \u2014 do not use both copies at once, because one identity can have only one active session.',
    'Wskaż plik profilu': 'Choose a profile file',
    'To nie jest plik profilu onchato': 'This is not an onchato profile file',
    'Złe hasło': 'Wrong password',
    'Profil o nazwie „{name}” już tu jest — nie nadpiszę go': 'A profile named \u201C{name}\u201D is already here \u2014 it will not be overwritten',
    'Przeniesiono profil „{name}” — zaloguj się nim': 'Profile \u201C{name}\u201D moved in \u2014 sign in with it',
    'Zapisano plik z profilem — pamiętaj, że to przeniesienie, a nie kopia': 'Profile file saved \u2014 remember it is a move, not a copy',
    'Nie udało się zapisać pliku': 'The file could not be saved',
    'Historia rozmowy i tak nie jest przechowywana.': 'The conversation is not stored anyway.',
    'Multiaddr węzła (np. /dns4/bs2.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3Koo…):': 'The node\u2019s multiaddr (e.g. /dns4/bs2.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3Koo…):',
    'Nazwa węzła:': 'Node name:',
    'Wipeout: skasować lokalną tożsamość software, wszystkie kontakty i cały stan tej przeglądarki?': 'Wipeout: erase the local software identity, every contact and all state in this browser?',
    'Tego nie da się cofnąć — Twój klucz publiczny się zmieni, więc Ty i rozmówcy musicie wymienić się nowymi kluczami. Klucze w HSM (login HEM) zostają nietknięte.': 'This cannot be undone \u2014 your public key changes, so you and your contacts have to exchange new keys. Keys in an HSM (HEM sign-in) are left untouched.',
    'w pokoju': 'in the room',
    'zaloguj przez HEM': 'sign in with HEM',
    '{name} — połączenie się rwie: wchodzi i wychodzi ({n}×)': '{name} — the connection keeps dropping: in and out ({n}×)',
    '{n} próby': '{n} attempts',
    '(sonda jeszcze nie skończyła)': '(the probe has not finished yet)',
    'Ten pulpit nie pokazuje ikon w zasobniku (w GNOME rysuje je rozszerzenie, a ono nie działa), więc zamknięcie okna kończy aplikację — chowanie jej do niewidocznej ikony znaczyłoby, że nie da się do niej wrócić.': 'This desktop does not show tray icons (in GNOME an extension draws them, and it is not running), so closing the window quits — hiding it into an icon nobody can see would mean no way back to it.',
    'Nagraj głosówkę': 'Record a voice note',
    'Zatrzymaj nagrywanie': 'Stop recording',
    'Odrzuć nagranie': 'Discard the recording',
    'Odtwórz': 'Play',
    'Nagranie odrzucone': 'Recording discarded',
    'Nie udało się nagrać — mikrofon niedostępny albo odmówiono dostępu': 'Could not record — the microphone is unavailable or access was refused',
    'Nagranie ma limit {s} s — zatrzymane': 'A recording is capped at {s} s — stopped',
    'Diagnostyka': 'Diagnostics',
    'Sprawdź WebRTC': 'Test WebRTC',
    'Sprawdzam…': 'Testing…',
    'Kopiuj raport': 'Copy the report',
    'Raport skopiowany': 'Report copied',
    'Nie udało się skopiować — zaznacz i skopiuj ręcznie': 'Could not copy — select it and copy by hand',
    'Sprawdzenie łączy się samo ze sobą wewnątrz tego okna — bez sieci, bez węzła. Dlatego rozstrzyga, czy to ta aplikacja nie umie WebRTC, czy nie pozwala na to sieć. Ostatni wiersz jest o sieci, reszta o aplikacji.': 'The test connects this window to itself — no network, no node. That is why it settles whether it is this app that cannot do WebRTC or the network that will not allow it. The last row is about the network; the rest are about the app.',
    'aplikacja': 'the app',
    'sieć': 'the network',
    'Obrazy': 'Images',
    'Pokazuj obrazy od kontaktów automatycznie': 'Show images from contacts automatically',
    'Pokazanie obrazka to jego pobranie — bajty lecą ze schowka plików dopiero wtedy. Dlatego przychodzące obrazy czekają na kliknięcie, a to ustawienie robi z tego automat.': 'Showing an image is downloading it — the bytes leave the file store only then. That is why an incoming image waits for a click, and why this setting turns that into an automatic one.',
    'Pokaż': 'Show',
    'Jeden plik naraz — wziąłem {name}': 'One file at a time — took {name}',
    'Najpierw otwórz rozmowę': 'Open a conversation first',
    'Aplikacja na komputerze': 'The desktop app',
    'Zamknięcie okna chowa do zasobnika': 'Closing the window hides it in the tray',
    'Uruchamiaj przy starcie systemu': 'Start when the system starts',
    'Ta aplikacja nie przechowuje wiadomości po drodze — żeby ktoś mógł do Ciebie napisać, musi być uruchomiona. Dlatego zamknięcie okna chowa ją do zasobnika; wyjście jest w menu ikony.': 'This app holds nothing for you in between — for anyone to reach you it has to be running. That is why closing the window hides it in the tray; quit is in the icon\u2019s menu.',
    'Pokaż onchato': 'Show onchato',
    'Zakończ': 'Quit',
    'onchato działa dalej': 'onchato is still running',
    'Okno zostało schowane do zasobnika — jesteś nadal osiągalny/a. Wyjście jest w menu ikony.': 'The window went to the tray — you are still reachable. Quit is in the icon\u2019s menu.',
    'System nie zgodził się na powiadomienia — trzeba ich pozwolić w ustawieniach systemu': 'The system refused notifications — they have to be allowed in the system settings',
    'Nie udało się ustawić startu przy uruchomieniu systemu': 'The login item could not be set',
    'Powiadomienia włączone': 'Notifications on',
    'Powiadomienia wyłączone': 'Notifications off',
    'Powiadomienie pojawia się tylko wtedy, gdy okno aplikacji nie jest na wierzchu. Treść wiadomości nie trafia do niego nigdy — powiadomienie widać na ekranie blokady i w historii powiadomień systemu, czyli w miejscach, w których ta aplikacja nic innego nie zostawia.':
      'A notification appears only while the app window is not in front. The text of a message never goes into one — a notification shows on the lock screen and in the system notification history, places this app leaves nothing else.',
    'Pokaż aparatowi kod z ekranu drugiej osoby. Nieznany klucz zaproponuję dodać, znany — porównam z tym, który już masz.':
      'Point the camera at the code on their screen. An unknown key is offered as a new contact; a known one is compared with what you already hold.',
    'Pokaż cytowaną wiadomość': 'Show the quoted message',
    'Pokój otwarty — czekam na {name}…': 'Room open — waiting for {name}…',
    'Potwierdzenie przyszło już po tym, jak przestaliśmy ponawiać — wiadomość jednak dotarła': 'The acknowledgement arrived after we stopped retrying — the message did get through',
    'Powtórz hasło': 'Repeat the password',
    'Powtórz nowe hasło': 'Repeat the new password',
    'poza pokojem': 'not in the room',
    'Pozostało bajtów UTF-8 na nazwę (limit {max})': 'UTF-8 bytes left for the name (limit {max})',
    'połączony': 'connected',
    'Profil': 'Profile',
    'Profil software': 'Software profile',
    'Profil w starym, niezaszyfrowanym formacie — usuń go przyciskiem Wipeout i załóż nowy.':
      'This profile predates password sealing — clear it with Wipeout and create a new one.',
    'Profile software na tym urządzeniu': 'Software profiles on this device',
    'Przeciągnij, aby zmienić szerokość (dwuklik = reset)': 'Drag to resize (double-click to reset)',
    'Przejdź do najnowszej wiadomości': 'Jump to the latest message',
    'Przełączono na węzeł {name} (poprzedni niedostępny)': 'Switched to node {name} (the previous one is unavailable)',
    'Przypiąć wiadomość?': 'Pin this message?',
    'Przypięcie zapisze ją w zaszyfrowanej formie w pamięci tej przeglądarki, żeby przetrwała przeładowanie. Ten komunikat pokaże się raz na sesję.':
      'Pinning stores it encrypted in this browser so it survives a reload. This notice is shown once a session.',
    'Przeglądarka nie zgodziła się na powiadomienia — trzeba jej pozwolić w ustawieniach strony':
      'The browser refused notifications — it has to be allowed in this site\'s settings',
    'Przysłano plik': 'A file arrived',
    'Przypnij': 'Pin',
    'Przypnij — zachowa w tej przeglądarce': 'Pin — keeps it in this browser',
    'Przynajmniej jeden węzeł musi być aktywny.': 'At least one node must be enabled.',
    'Reset urządzenia': 'Device reset',
    'Rotacja pokoju tej pary: północ UTC + offset (§5.4) — czas do najbliższej rotacji': 'This pair\'s room rotation: UTC midnight + offset (§5.4) — time until the next one',
    'Rozmówca wciąż widzi starą treść — mimo ponowień nie ma potwierdzenia':
      'They are still reading the old text — there is no acknowledgement despite the retries',
    'Rozmowa wymaga, żeby obie strony miały swoje klucze publiczne — bez tego nie ma nawet gdzie się spotkać. Wyślij komuś swój link, a on odeśle swój. Od tego momentu treść jest szyfrowana end-to-end i żaden serwer po drodze jej nie zobaczy.':
      'A conversation needs both sides to hold the other\u2019s public key \u2014 without that there is not even a place to meet. Send someone your link and they will send theirs back. From then on the content is end-to-end encrypted and no server along the way sees it.',
    'Rozmówca (odcisk klucza)': 'Contact (key fingerprint)',
    'Sesja': 'Session',
    'Sesja i transport': 'Session and transport',
    'sesja zamknięta (duplikat)': 'session closed (duplicate)',
    'Sieć': 'Network',
    'Sieć — wkrótce (lista węzłów, latencje)': 'Network — coming soon (node list, latencies)',
    'Skopiowano klucz publiczny ✓': 'Public key copied ✓',
    'Sprawdź adres HEM i czy urządzenie jest osiągalne z tej przeglądarki.': 'Check the HEM address, and that the device is reachable from this browser.',
    'Spróbuj ponownie': 'Try again',
    'Stan sprzed zmiany formatu tożsamości został wyczyszczony ({n}) — kontakty w HEM są nietknięte.': 'State from before the identity format change was cleared ({n} entries) — contacts in the HEM are untouched.',
    'Status': 'Status',
    'status HEM': 'HEM status',
    'Status węzła sieci': 'Network node status',
    'Szukaj kontaktu…': 'Search contacts…',
    'Szyfrowane E2E — interim, EH-2 w drodze': 'E2E encrypted — interim, EH-2 on the way',
    'Szyfruję…': 'Encrypting…',
    'Ta nazwa jest już zajęta przez kogoś o innym kluczu. Zastąpienie usunie tamten kontakt — jeśli to dwie różne osoby, wróć i nadaj inną nazwę.':
      'That name belongs to someone with a different key. Replacing removes that contact — if these are two different people, go back and pick another name.',
    'Ta przeglądarka nie wystarczy': 'This browser is not enough',
    'Tak': 'Yes',
    'Ten adres używa znaków spoza ASCII i może udawać inny. Przeglądarka otworzy: {host}.': 'This address uses non-ASCII characters and may be impersonating another. The browser will open: {host}.',
    'Ten HEM trzyma więcej niż jedną tożsamość. Krótki identyfikator obok nazwy rozróżnia je, gdy nazwy się powtarzają.': 'This HEM holds more than one identity. The short id beside each name tells them apart when the names repeat.',
    'Ten klucz jest już kontaktem tożsamości „{who}”, a urządzenie trzyma każdy klucz tylko raz.': 'This key is already a contact of the identity “{who}”, and a device holds each key only once.',
    'To nie wygląda na multiaddr (…/p2p/<PeerId>).': 'That does not look like a multiaddr (…/p2p/<PeerId>).',
    'To tożsamość, na której jesteś zalogowany. Znikną jej klucze, kontakty i grupy, a aplikacja wróci do ekranu logowania. Nieodwracalne — klucza nie da się odtworzyć.':
      'This is the identity you are signed in with. Its keys, contacts and groups go, and the app returns to the login screen. Irreversible — the key cannot be recovered.',
    'To Ty — ktoś zwrócił się do Ciebie ({hint})': 'That is you — somebody called your name ({hint})',
    'To nie jest kod zaproszenia — pokaż kod z okna „Udostępnij swój profil”':
      'That is not an invite code — show the one from the “Share your profile” window',
    'To Twój własny kod': 'That is your own code',
    'To Twój własny profil.': 'That is your own profile.',
    'Topiki': 'Topics',
    'Tożsamość': 'Identity',
    'Tożsamość programowa — brak klucza w HSM': 'Software identity — no key in an HSM',
    'tożsamość software (sandbox)': 'software identity (sandbox)',
    'Tożsamość trzymana w tej przeglądarce i zaszyfrowana hasłem. Bez HEM — do wypróbowania komunikatora.':
      'An identity kept in this browser and sealed with a password. No HEM needed — for trying the messenger out.',
    'Tożsamość zostaje ta sama — zmienia się wyłącznie hasło, którym jest zaszyfrowana. Kontakty i grupy bez zmian.':
      'The identity stays the same — only the password sealing it changes. Contacts and groups are untouched.',
    'Transport': 'Transport',
    'Transport treści': 'Content transport',
    'Treść poprawiona przez autora o {t} UTC': 'Corrected by its author at {t} UTC',
    'Treść bezpośrednio P2P — relay ślepy na treść/rozmiary/timing': 'Content directly P2P — the relay is blind to content, sizes and timing',
    'Treść przez relay (GossipSub)': 'Content over the relay (GossipSub)',
    'Treść przez relay (GossipSub) — WebRTC direct gdy się zestawi': 'Content over the relay (GossipSub) — WebRTC direct once it establishes',
    'Trwa uzgadnianie klucza sesji (msg1→msg2→msg3)': 'Agreeing the session key (msg1→msg2→msg3)',
    'Twój odcisk': 'Your fingerprint',
    'Twój PeerId': 'Your PeerId',
    'Ty': 'You',
    'Tylko „coś przyszło”': 'Only “something arrived”',
    'Tylko administrator grupy może zmienić jej nazwę': 'Only the group admin can rename it',
    'Tylko administrator może usunąć grupę': 'Only the admin can delete the group',
    'Uczestnicy': 'Members',
    'Uczestnicy grupy': 'Group members',
    'Udostępnij mój profil': 'Share my profile',
    'Udostępnij swój profil': 'Share your profile',
    'układ pulpitu': 'desktop layout',
    'układ telefonu': 'phone layout',
    'Urządzenie nie odpowiedziało w ciągu 5 sekund. Sprawdź, czy jest podłączone i odblokowane, i spróbuj ponownie.': 'The device did not answer within 5 seconds. Check that it is connected and unlocked, then try again.',
    'Ustawienia': 'Settings',
    'Usuń': 'Delete',
    'Usuń grupę': 'Delete group',
    'Usuń plik': 'Remove the file',
    'Usuń profil': 'Delete the profile',
    'Usuń wpis': 'Remove the entry',
    'Usuń z grupy': 'Remove from group',
    'Usunąć grupę?': 'Delete the group?',
    'Usunąć kontakt?': 'Delete the contact?',
    'Usunąć profil „{name}"?': 'Delete the profile “{name}”?',
    'Utwórz': 'Create',
    'Utwórz profil': 'Create the profile',
    'Utworzyć na tym urządzeniu nową tożsamość o tej nazwie? Jeśli chciałeś wejść na istniejącą, sprawdź pisownię — to osobne tożsamości, nie jedna.':
      'Create a new identity under that name on this device? If you meant to open an existing one, check the spelling \u2014 these are separate identities, not one.',
    'Uwaga: w tym pokoju jest ktoś, kto nie uwierzytelnia się jako ten kontakt': 'Careful: someone in this room does not authenticate as this contact',
    'W HEM (trwałe, przenośne)': 'In the HEM (durable, portable)',
    'Wczytać oficjalną listę?': 'Load the official list?',
    'Wczytaj oficjalną listę węzłów': 'Load the official node list',
    'Wczytano {n} węzłów': 'Loaded {n} nodes',
    'Wersja i commit tej wersji aplikacji': 'The version and commit this build came from',
    'węzeł': 'node',
    'W tej rozmowie można przypiąć {n} wiadomości — odepnij coś, żeby zrobić miejsce':
      'This conversation can keep {n} pinned messages — unpin one to make room',
    'Węzeł (relay)': 'Node (relay)',
    'Węzły sieci': 'Network nodes',
    'Węzły sieci — wybierz/edytuj': 'Network nodes — choose / edit',
    'Wiadomość': 'Message',
    'Wiadomość… (Enter = wyślij)': 'Message… (Enter to send)',
    'Wipeout kasuje lokalną tożsamość software, wszystkie kontakty i cały stan tej przeglądarki — jak nowy komputer (§10). Nieodwracalne. Kluczy w HSM nie dotyka.': 'Wipeout erases the local software identity, every contact and all state in this browser — like a new machine (§10). Irreversible. It does not touch keys in an HSM.',
    'wklej pubkey albo link zaproszenia…': 'paste their public key or an invite link…',
    'Wpis grupy „{name}” usunięty z HEM': 'The entry for “{name}” was removed from the HEM',
    'Wzmianka o {name} ({hint})': 'Mentions {name} ({hint})',
    'Wróć do kontaktów': 'Back to contacts',
    'wrócił/a': 'is back',
    'Wróciłem na węzeł {name}': 'Back on node {name}',
    'Wspólny pokój na dziś wyliczamy z Waszych kluczy i daty — nikt inny go nie zna. To spotkanie, nie skrzynka: wiadomości żyją tylko na ekranach uczestników.': 'Today\'s shared room is derived from your keys and the date — nobody else knows it. This is a meeting, not a mailbox: messages live only on the participants\' screens.',
    'Wszyscy członkowie „{name}” stracą dostęp do nowych wiadomości,': 'Every member of “{name}” will lose access to new messages,',
    'wszystkie kontakty już w grupie': 'every contact is already in the group',
    'Wszystkie topiki na jednym połączeniu. Więcej węzłów (i failover) dodasz z edytowalnej listy w oknie logowania.': 'Every topic on one connection. Add more nodes (and failover) from the editable list on the sign-in screen.',
    'Wybierz co najmniej jednego członka.': 'Select at least one member.',
    'Wybierz kontakt': 'Choose a contact',
    'Wybierz tożsamość': 'Choose an identity',
    'Wyślij poprawkę ponownie': 'Send the correction again',
    'Wygasł': 'Expired',
    'wygasł': 'expired',
    'Wyłączone': 'Off',
    'Wyjdziesz poza aplikację. Strona {host} pozna Twój adres IP i czas wejścia — tego rozmowa nie ujawnia.': 'You are leaving the app. {host} will learn your IP address and the time you arrived — the conversation itself reveals neither.',
    'Wykryto drugie okno zalogowane na tę samą tożsamość.': 'A second window signed in as the same identity was detected.',
    'Wylogować?': 'Sign out?',
    'Wyloguj': 'Sign out',
    'Wymiana zakończona — możecie rozmawiać': 'Exchange complete — you can talk now',
    'Wyślij ponownie': 'Send again',
    'Wyślij ponownie mój klucz do wszystkich': 'Send my key to everyone again',
    'Wyślij ten link dowolnym kanałem. Nie zawiera niczego tajnego — sam klucz publiczny.':
      'Send this link by any channel. It holds nothing secret — a public key and a name.',
    'Wyślij ➤': 'Send ➤',
    'Wysyłam…': 'Sending…',
    'wyszedł/wyszła': 'left',
    'Wysłane do grupy (broadcast — bez potwierdzeń doręczenia)': 'Sent to the group (broadcast — no delivery acknowledgements)',
    'Wysłano Twój klucz do członków grupy „{name}”': 'Your key was sent to the members of “{name}”',
    'Wyżej (wyżej = wcześniej wybierany)': 'Move up (higher = chosen earlier)',
    'wznawiam połączenie…': 'reconnecting…',
    'Zacznij od wymiany kluczy': 'Start by exchanging keys',
    'Zaloguj': 'Sign in',
    'Zaloguj się swoim HEM.': 'Sign in with your HEM.',
    'Zeskanuj kod QR': 'Scan a QR code',
    'Zamknij': 'Close',
    'Zapis': 'Storage',
    'Zapisano': 'Saved',
    'Zapisuję…': 'Saving…',
    'Zapisz': 'Save',
    'Zaproszenie': 'Invitation',
    'Zarejestruj tożsamość': 'Register an identity',
    'Zastąp': 'Replace',
    'Zastąpi Twoją listę {n} węzłami z publikacji. Twoje własne wpisy znikną.':
      'It will replace your list with {n} published nodes. Your own entries will be gone.',
    'Zaznaczone węzły są używane w tej sesji (pierwszy zaznaczony jako główny).': 'The checked nodes are used in this session (the first one as primary).',
    'Zaznaczono — skopiuj ręcznie': 'Selected — copy it manually',
    'Zmiana hasła': 'Change password',
    'Zmień hasło aktywnego profilu': 'Change the active profile’s password',
    'Zmień nazwę': 'Rename',
    'Zmień nazwę grupy': 'Rename group',
    'Zmień nazwę kontaktu': 'Rename contact',
    'Zmień w Ustawieniach': 'Change it in Settings',
    'Zmieniam…': 'Changing…',
    'Znikną klucze tego profilu, jego kontakty i grupy. Nieodwracalne — klucza nie da się odtworzyć.':
      'This profile’s keys, contacts and groups will go. Irreversible — the key cannot be recovered.',
    'Złe hasło.': 'Wrong password.',
    'Złe obecne hasło.': 'Wrong current password.',
    '{name} chce rozmawiać…': '{name} wants to talk…',
    '{name} usunięty z grupy': '{name} removed from the group',
    '{n} członków': { one: '{n} member', other: '{n} members' },
    '{n} poł.': { one: '{n} conn.', other: '{n} conns.' },
    'łączę…': 'connecting…',
    '— (klucz w przeglądarce)': '— (key in the browser)',
    '„{name}” zniknie z listy, rozmowa zostanie zamknięta': '“{name}” will disappear from the list and the conversation will close',
    '„{name}” zniknie z tego urządzenia i przestaniesz odbierać wiadomości.': '“{name}” will disappear from this device and you will stop receiving messages.',
    '⚠️ Książka kontaktów została zmieniona poza aplikacją — nie została wczytana': '⚠️ The contact book was changed outside the app — it was not loaded',
    '⚠️ Not secure': '⚠️ Not secure',
    '⚡ Jednorazowo — nie zapisuj nigdzie (tylko ten czat)': '⚡ Just this once — save nothing (this chat only)',
    '⚡ Jednorazowo — po przeładowaniu kontakt zniknie': '⚡ Just this once — the contact is gone after a reload',
    '⚪ Relay': '⚪ Relay',
    '⚪ Tylko przez węzeł — rozmówca nie pozna Twojego IP': '⚪ Through the node only - hide my IP from peer',
    '⚪ Tylko węzeł': '⚪ Node only',
    '💻 Tylko lokalnie — ta przeglądarka, nic nie trafia do HEM': '💻 This browser only — nothing reaches the HEM',
    '💻 Zapisz w tym profilu — zostaje na tym urządzeniu': '💻 Save in this profile — stays on this device',
    '🔐 Secure': '🔐 Secure',
    '✓ Ten sam klucz, który masz zapisany jako „{name}”': '✓ The same key you have saved as “{name}”',
    '👋 Puknięcie wysłane do pokoju — jeśli rozmówca tu jest, usłyszy je teraz':
      '👋 Knock sent into the room — if they are here, they hear it now',
    '👋 {name} puka': '👋 {name} is knocking',
    '👋 {name} puka — jest teraz przy klawiaturze': '👋 {name} is knocking — they are at the keyboard now',
    '🔒 E2E interim': '🔒 E2E interim',
    '🔒 W HEM — trwałe, przenośne między urządzeniami': '🔒 In the HEM — durable, portable between devices',
    '📷 Zeskanuj kod QR': '📷 Scan a QR code',
    '📌 Przypięte ({n})': '📌 Pinned ({n})',
    '🟢 Automatycznie': '🟢 Automatic',
    '🟢 Automatycznie — bezpośrednio, gdy się da': '🟢 Automatic — direct when it can be',
    '🟢 Direct': '🟢 Direct',
    '🤝 Securing…': '🤝 Securing…',
    '🧨 Wipeout — wyczyść wszystko': '🧨 Wipeout — erase everything',
  },
}

const SUPPORTED = ['pl', 'en']
const LS_KEY = 'ec-lang'

function detect(): string {
  // `?lang=en` pins the language, ahead of the saved choice and the browser's.
  // Two callers need it: the two-browser harness, whose assertions read the
  // Polish UI text and which runs on a runner with an English locale, and
  // support — "open it with ?lang=pl and send me the screenshot".
  try {
    const q = new URLSearchParams(location.search).get('lang')
    if (q && SUPPORTED.includes(q)) return q
  } catch {}
  try {
    const saved = localStorage.getItem(LS_KEY)
    if (saved && SUPPORTED.includes(saved)) return saved
  } catch {}
  // `navigator.languages` is ordered by preference; take the first we speak.
  for (const l of (navigator.languages ?? [navigator.language ?? 'en'])) {
    const base = String(l).toLowerCase().split('-')[0]
    if (SUPPORTED.includes(base)) return base
  }
  // English by default: the source text is Polish, so a browser that asks for
  // Polish still gets it above, and everyone else gets the language they are
  // likelier to read. Note the consequence — an untranslated key falls back to
  // its Polish source, so a new string added without a catalogue entry now
  // shows Polish to an English user rather than the other way round.
  return 'en'
}

let locale = detect()
let plural = new Intl.PluralRules(locale)

export const locales = () => SUPPORTED.slice()
export const getLocale = () => locale

/** Switch language and repaint everything that is static markup. */
export function setLocale(l: string) {
  if (!SUPPORTED.includes(l) || l === locale) return
  locale = l
  plural = new Intl.PluralRules(locale)
  try { localStorage.setItem(LS_KEY, l) } catch {}
  applyDom()
  document.documentElement.lang = l
}

const interpolate = (s: string, p?: Record<string, string | number>) =>
  p ? s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : s

/**
 * Translate. `params.n` additionally selects a plural form when the entry has
 * them — so one call site, `t('{n} członków', { n })`, is correct in a language
 * with two forms and in one with three.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const entry: Entry | undefined = CATALOG[locale]?.[key]
  if (entry === undefined) return interpolate(key, params)
  if (typeof entry === 'string') return interpolate(entry, params)
  const n = params?.n
  const cat = typeof n === 'number' ? plural.select(n) : 'other'
  return interpolate((entry as any)[cat] ?? entry.other, params)
}

/**
 * Translate the static markup: `data-i18n` for text, `data-i18n-title` and
 * `data-i18n-placeholder` for the attributes that are also user-visible. Called
 * at startup and again on every language switch, so index.html can hold the
 * Polish as its default content and still be translatable.
 */
export function applyDom(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n!)
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle!)
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder!)
  }
}
