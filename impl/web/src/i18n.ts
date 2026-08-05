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
 */
const CATALOG: Record<string, Record<string, Entry>> = {
  pl: {
    '{n} członków': { one: '{n} członek', few: '{n} członkowie', many: '{n} członków', other: '{n} członka' },
    '{n} nieprzeczytane': { one: '{n} nieprzeczytana', few: '{n} nieprzeczytane', many: '{n} nieprzeczytanych', other: '{n} nieprzeczytanej' },
    '{n} poł.': { one: '{n} poł.', few: '{n} poł.', many: '{n} poł.', other: '{n} poł.' },
    '⚠️ Not secure': '⚠️ Niezabezpieczona',
    '🔐 Secure': '🔐 Bezpieczna',
    '🟢 Direct': '🟢 Bezpośrednio',
    '🤝 Securing…': '🤝 Zabezpieczam…',
  },
  en: {
    '{n} członków': { one: '{n} member', other: '{n} members' },
    '{n} nieprzeczytane': { one: '{n} unread', other: '{n} unread' },
    '{n} poł.': { one: '{n} conn.', other: '{n} conns.' },
    ' Ich dotychczasowa kopia rozmowy pozostanie u nich; nie da się jej usunąć zdalnie.': ' Their existing copy of the conversation stays with them; it cannot be deleted remotely.',
    ' Obie sesje zostały zamknięte — jedna tożsamość, jedna aktywna sesja.': ' Both sessions were closed — one identity, one active session.',
    ' Pozostali członkowie zachowują grupę — nie da się jej usunąć u nich.': ' The other members keep the group — it cannot be deleted on their devices.',
    ' Zamknij nadmiarową kartę i odśwież tę, w której chcesz rozmawiać.': ' Close the extra tab and reload the one you want to talk in.',
    ' a klucz grupy zostanie skasowany z HEM — grupy nie da się już przywrócić.': ' and the group key will be erased from the HEM — the group cannot be restored.',
    ' po {ms} ms': ' after {ms} ms',
    ' · wysyłam ponownie…': ' · resending…',
    ' · wysyłam…': ' · sending…',
    ' · wysłano': ' · sent',
    ' — najczęściej druga zakładka zalogowana na tę samą tożsamość. Zamknij jedną z nich.': ' — usually a second tab logged in as the same identity. Close one of them.',
    ' ⏱ spóźniona': ' ⏱ late',
    '(brak dopasowań)': '(no matches)',
    '(brak grup — utwórz)': '(no groups — create one)',
    '(brak kontaktów — dodaj peera)': '(no contacts — add a peer)',
    '+ Dodaj członka': '+ Add member',
    '+ dodaj': '+ add',
    ', a klucz kontaktu zostanie usunięty z HEM': ', and the contact\'s key will be removed from the HEM',
    '1. wybór': '1st choice',
    'Adres HEM': 'HEM address',
    'Anuluj': 'Cancel',
    'Brak potwierdzenia mimo ponowień — rozmówca prawdopodobnie tego nie dostał': 'No acknowledgement despite retries — they probably did not receive this',
    'Brak sesji — zaloguj się.': 'No session — sign in.',
    'Brak tożsamości czatu na tym HEM — zarejestruj.': 'No chat identity on this HEM — register one.',
    'Błąd tożsamości software: ': 'Software identity error: ',
    'Błąd zapisu: ': 'Save failed: ',
    'Błąd: ': 'Error: ',
    'Czekam na potwierdzenie od klienta rozmówcy': 'Waiting for their client to acknowledge',
    'Członkowie': 'Members',
    'Dodaj peera': 'Add a peer',
    'Dotarła po nowszych wiadomościach — wstawiona w miejscu, w którym została napisana': 'Arrived after newer messages — placed where it was written',
    'Dołączono do grupy „{name}”': 'Joined the group “{name}”',
    'Failover po liście węzłów: gdy pierwszy węzeł nie odpowiada, sesja przechodzi na następny. Węzły są zmeshowane, więc przełączenie nie dzieli rozmówców.': 'Failover down the node list: when the first node does not answer, the session moves to the next. The nodes are meshed, so switching does not separate you from anyone.',
    'Grupa „{name}” usunięta': 'Group “{name}” deleted',
    'Grupa „{name}” utworzona — rozsyłam zaproszenia…': 'Group “{name}” created — sending invitations…',
    'Grupy': 'Groups',
    'HEM nieosiągalny (adres / CORS)': 'HEM unreachable (address / CORS)',
    'Handle (widoczny dla kontaktów)': 'Handle (visible to contacts)',
    'Handshake EH-2 uzgodniony — forward secrecy per wiadomość, hybryda PQ (ML-KEM-768)': 'EH-2 handshake agreed — per-message forward secrecy, PQ hybrid (ML-KEM-768)',
    'Handshake nie doszedł do skutku — ponowi się przy następnym Announce': 'The handshake did not complete — it will retry on the next Announce',
    'Hasło': 'Password',
    'Historia': 'History',
    'Język': 'Language',
    'KID (klucz w HSM)': 'KID (key in the HSM)',
    'Klient rozmówcy potwierdził odbiór{when} — to nie jest „przeczytane”': 'Their client acknowledged receipt{when} — this is not “read”',
    'Klucz nie wygląda na 32-bajtowy X25519 (base64).': 'That does not look like a 32-byte X25519 key (base64).',
    'Klucz publiczny': 'Public key',
    'Kolejność decyduje o wyborze: pierwszy aktywny węzeł jest podstawowy, kolejne to zapas. Zmiany działają natychmiast — bez wylogowania.': 'Order decides: the first enabled node is the primary, the rest are its fallbacks. Changes take effect immediately — no sign-out needed.',
    'Kontakty': 'Contacts',
    'Lokalnie (ta przeglądarka)': 'Locally (this browser)',
    'Masz już konto?': 'Already have an account?',
    'Musi zostać co najmniej jeden węzeł.': 'At least one node must remain.',
    'Na pewno?': 'Are you sure?',
    'Najpierw dodaj kontakty — członkowie grupy muszą być kontaktami.': 'Add contacts first — group members must be contacts.',
    'Nazwa': 'Name',
    'Nazwa + członkowie. Tylko kontakty — każdy dostaje zaproszenie (klucze) przez Wasz kanał 1:1.': 'Name + members. Contacts only — each one gets an invitation (keys) over your 1:1 channel.',
    'Nazwa grupy': 'Group name',
    'Nazwa lokalna + jego klucz publiczny (base64, X25519).': 'A local name + their public key (base64, X25519).',
    'Nazwa nie może być pusta.': 'The name cannot be empty.',
    'Nazwa zmieni się u wszystkich członków — klucze zostają bez zmian.': 'The name changes for every member — the keys are untouched.',
    'Nie': 'No',
    'Nie masz konta?': 'No account yet?',
    'Niżej': 'Move down',
    'Nowa grupa': 'New group',
    'Opuszczono grupę „{name}”': 'Left the group “{name}”',
    'Opuścić grupę?': 'Leave the group?',
    'Opuść': 'Leave',
    'Opuść grupę': 'Leave group',
    'P1 · Prywatny': 'P1 · Private',
    'P2 · Wrogie otoczenie': 'P2 · Hostile environment',
    'P3 · Sieć własna': 'P3 · Own network',
    'PeerId (efemeryczny)': 'PeerId (ephemeral)',
    'PeerId węzła': 'Node PeerId',
    'Platforma': 'Platform',
    'Nie pokazuj tego ostrzeżenia ponownie': 'Don\'t show this warning again',
    'Otworzyć link?': 'Open this link?',
    'Otwórz': 'Open',
    'Otwórz {host} w nowej karcie': 'Open {host} in a new tab',
    'Otwórz — uwaga, adres używa znaków spoza ASCII; przeglądarka pójdzie do {host}': 'Open — careful, this address uses non-ASCII characters; the browser will go to {host}',
    'Ten adres używa znaków spoza ASCII i może udawać inny. Przeglądarka otworzy: {host}.': 'This address uses non-ASCII characters and may be impersonating another. The browser will open: {host}.',
    'Wyjdziesz poza aplikację. Strona {host} pozna Twój adres IP i czas wejścia — tego rozmowa nie ujawnia.': 'You are leaving the app. {host} will learn your IP address and the time you arrived — the conversation itself reveals neither.',
    'Ekran': 'Screen',
    'układ pulpitu': 'desktop layout',
    'układ telefonu': 'phone layout',
    '⚠️ Not secure': '⚠️ Not secure',
    '🔐 Secure': '🔐 Secure',
    '🟢 Direct': '🟢 Direct',
    '🤝 Securing…': '🤝 Securing…',
    '+ dodaj': '+ add',
    'Encedo Chat potrzebuje kilku funkcji, których tu brakuje. Bez nich nie da się nawet ustalić wspólnego pokoju, więc logowanie jest wyłączone.': 'Encedo Chat needs a few capabilities this browser does not have. Without them it cannot even derive a shared room, so signing in is disabled.',
    'Lista węzłów': 'Node list',
    'Status': 'Status',
    'Ta przeglądarka nie wystarczy': 'This browser is not enough',
    'Topiki': 'Topics',
    'Transport': 'Transport',
    'Twój PeerId': 'Your PeerId',
    'Węzeł (relay)': 'Node (relay)',
    'Węzły sieci': 'Network nodes',
    'bez WebRTC': 'no WebRTC',
    'failover': 'failover',
    ' · ⚠ niedostarczone': ' · ⚠ not delivered',
    '+ Dodaj peera': '+ Add a peer',
    '+ Nowa grupa': '+ New group',
    'Brak połączenia z przekaźnikiem — odśwież stronę': 'No connection to the relay — reload the page',
    'Błąd listy kontaktów: ': 'Contact list error: ',
    'Błąd usuwania: ': 'Delete failed: ',
    'Dwuklik = kopiuj klucz publiczny': 'Double-click to copy the public key',
    'Grupa idzie przez relay (GossipSub) — nie WebRTC': 'Groups go over the relay (GossipSub), not WebRTC',
    'Grupa — Sender Keys + per-recipient HMAC (deniable, §8)': 'Group — Sender Keys + per-recipient HMAC (deniable, §8)',
    'Klucz nie jest poprawnym base64.': 'That key is not valid base64.',
    'Nie udało się usunąć grupy: ': 'Could not delete the group: ',
    'Nie udało się zmienić nazwy grupy: ': 'Could not rename the group: ',
    'Nie udało się zmienić nazwy: ': 'Could not rename: ',
    'Nie udało się zmienić składu grupy': 'Could not change the group membership',
    'P1 · prywatny': 'P1 · private',
    'Podaj handle.': 'Enter a handle.',
    'Skopiowano klucz publiczny ✓': 'Public key copied ✓',
    'Szukaj kontaktu…': 'Search contacts…',
    'Szyfrowane E2E — interim, EH-2 w drodze': 'E2E encrypted — interim, EH-2 on the way',
    'Trwa uzgadnianie klucza sesji (msg1→msg2→msg3)': 'Agreeing the session key (msg1→msg2→msg3)',
    'Tylko administrator grupy może zmienić jej nazwę': 'Only the group admin can rename it',
    'Tylko administrator może usunąć grupę': 'Only the admin can delete the group',
    'Uczestnicy': 'Members',
    'Uczestnicy grupy': 'Group members',
    'Wybierz kontakt': 'Choose a contact',
    'Zamknij': 'Close',
    'np. alice': 'e.g. alice',
    'np. bob': 'e.g. bob',
    'status HEM': 'HEM status',
    'wklej pubkey kontaktu…': 'paste the contact\'s public key…',
    '⚠️ EH-2 nieudany': '⚠️ EH-2 failed',
    '⚪ Relay': '⚪ Relay',
    '⚪ Relay (grupa)': '⚪ Relay (group)',
    '🔐 EH-2 + ratchet': '🔐 EH-2 + ratchet',
    '🔐 Szyfrowana': '🔐 Encrypted',
    '🟢 WebRTC Direct': '🟢 WebRTC Direct',
    '🤝 EH-2 handshake…': '🤝 EH-2 handshake…',
    'Podaj adres HEM i hasło.': 'Enter the HEM address and password.',
    'Podaj nazwę grupy.': 'Enter a group name.',
    'Podaj nazwę i klucz.': 'Enter a name and a key.',
    'Pokój otwarty — czekam na {name}…': 'Room open — waiting for {name}…',
    'Potwierdzenie przyszło już po tym, jak przestaliśmy ponawiać — wiadomość jednak dotarła': 'The acknowledgement arrived after we stopped retrying — the message did get through',
    'Profil bezpieczeństwa': 'Security profile',
    'Profil bezpieczeństwa — wkrótce': 'Security profile — coming soon',
    'Profil — wkrótce': 'Profile — coming soon',
    'Przeciągnij, aby zmienić szerokość (dwuklik = reset)': 'Drag to resize (double-click to reset)',
    'Przejdź do najnowszej wiadomości': 'Jump to the latest message',
    'Przełączono na węzeł {name} (poprzedni niedostępny)': 'Switched to node {name} (the previous one is unavailable)',
    'Przynajmniej jeden węzeł musi być aktywny.': 'At least one node must be enabled.',
    'Relay-only na własnych węzłach z własnym kluczem podpisu.': 'Relay-only on your own nodes with your own signing key.',
    'Reset urządzenia': 'Device reset',
    'Rotacja pokoju': 'Room rotation',
    'Rotacja pokoju tej pary: północ UTC + offset (§5.4) — czas do najbliższej rotacji': 'This pair\'s room rotation: UTC midnight + offset (§5.4) — time until the next one',
    'Rozmówca': 'Contact',
    'Sesja': 'Session',
    'Sesja + profil bezpieczeństwa': 'Session + security profile',
    'Sieć': 'Network',
    'Sieć — wkrótce (lista węzłów, latencje)': 'Network — coming soon (node list, latencies)',
    'Status węzła sieci': 'Network node status',
    'Tak': 'Yes',
    'To nie wygląda na multiaddr (…/p2p/<PeerId>).': 'That does not look like a multiaddr (…/p2p/<PeerId>).',
    'Tożsamość': 'Identity',
    'Tożsamość programowa — brak klucza w HSM': 'Software identity — no key in an HSM',
    'Treść bezpośrednio P2P — relay ślepy na treść/rozmiary/timing': 'Content directly P2P — the relay is blind to content, sizes and timing',
    'Treść przez relay (GossipSub)': 'Content over the relay (GossipSub)',
    'Treść przez relay (GossipSub) — WebRTC direct gdy się zestawi': 'Content over the relay (GossipSub) — WebRTC direct once it establishes',
    'Ustawienia': 'Settings',
    'Usunąć grupę?': 'Delete the group?',
    'Usunąć kontakt?': 'Delete the contact?',
    'Usuń': 'Delete',
    'Usuń grupę': 'Delete group',
    'Usuń z grupy': 'Remove from group',
    'Utwórz': 'Create',
    'Uwaga: w tym pokoju jest ktoś, kto nie uwierzytelnia się jako ten kontakt': 'Careful: someone in this room does not authenticate as this contact',
    'W HEM (trwałe, przenośne)': 'In the HEM (durable, portable)',
    'WebRTC direct dozwolone. Rozmówca widzi Twoje IP.': 'WebRTC direct allowed. They can see your IP.',
    'Wiadomość… (Enter = wyślij)': 'Message… (Enter to send)',
    'Wipeout kasuje lokalną tożsamość software, wszystkie kontakty i cały stan tej przeglądarki — jak nowy komputer (§10). Nieodwracalne. Kluczy w HSM nie dotyka.': 'Wipeout erases the local software identity, every contact and all state in this browser — like a new machine (§10). Irreversible. It does not touch keys in an HSM.',
    'Wróciłem na węzeł {name}': 'Back on node {name}',
    'Wróć do kontaktów': 'Back to contacts',
    'Wspólny pokój na dziś wyliczamy z Waszych kluczy i daty — nikt inny go nie zna. To spotkanie, nie skrzynka: wiadomości żyją tylko na ekranach uczestników.': 'Today\'s shared room is derived from your keys and the date — nobody else knows it. This is a meeting, not a mailbox: messages live only on the participants\' screens.',
    'Wszyscy członkowie „{name}” stracą dostęp do nowych wiadomości,': 'Every member of “{name}” will lose access to new messages,',
    'Wszystkie topiki na jednym połączeniu. Więcej węzłów (i failover) dodasz z edytowalnej listy w oknie logowania.': 'Every topic on one connection. Add more nodes (and failover) from the editable list on the sign-in screen.',
    'Wybierz co najmniej jednego członka.': 'Select at least one member.',
    'Wykryto drugie okno zalogowane na tę samą tożsamość.': 'A second window signed in as the same identity was detected.',
    'Wyloguj': 'Sign out',
    'Wysłane do grupy (broadcast — bez potwierdzeń doręczenia)': 'Sent to the group (broadcast — no delivery acknowledgements)',
    'Wyłącznie relay — IP niewidoczne. (czeka na data plane §13)': 'Relay only — your IP stays hidden. (waiting on the §13 data plane)',
    'Wyślij ponownie': 'Send again',
    'Wyślij ➤': 'Send ➤',
    'Wyżej (wyżej = wcześniej wybierany)': 'Move up (higher = chosen earlier)',
    'Węzły sieci': 'Network nodes',
    'Węzły sieci — wybierz/edytuj': 'Network nodes — choose / edit',
    'Zaloguj': 'Sign in',
    'Zaloguj się swoim HEM. Klucz tożsamości nie opuszcza urządzenia.': 'Sign in with your HEM. The identity key never leaves the device.',
    'Zapis': 'Storage',
    'Zapisuję…': 'Saving…',
    'Zapisz': 'Save',
    'Zarejestruj tożsamość': 'Register an identity',
    'Zaznaczone węzły są używane w tej sesji (pierwszy zaznaczony jako główny).': 'The checked nodes are used in this session (the first one as primary).',
    'Zmień nazwę': 'Rename',
    'Zmień nazwę grupy': 'Rename group',
    'Zmień nazwę kontaktu': 'Rename contact',
    'brak połączenia z przekaźnikiem': 'no connection to the relay',
    'brak sygnału': 'no signal',
    'brak — sesja efemeryczna': 'none — ephemeral session',
    'błąd połączenia': 'connection error',
    'codziennie 00:00 UTC': 'daily at 00:00 UTC',
    'dostarczone': 'delivered',
    'dostarczone z opóźnieniem': 'delivered late',
    'np. Zespół': 'e.g. Team',
    'poza pokojem': 'not in the room',
    'połączony': 'connected',
    'sesja zamknięta (duplikat)': 'session closed (duplicate)',
    'tożsamość software (dev)': 'software identity (dev)',
    'wrócił/a': 'is back',
    'wszystkie kontakty już w grupie': 'every contact is already in the group',
    'wyszedł/wyszła': 'left',
    'wznawiam połączenie…': 'reconnecting…',
    'węzeł': 'node',
    '{name} chce rozmawiać…': '{name} wants to talk…',
    '{name} usunięty z grupy': '{name} removed from the group',
    '{who} udostępnił plik: {file} — interim (IPFS TODO)': '{who} shared a file: {file} — interim (IPFS TODO)',
    'łączę…': 'connecting…',
    '— (klucz w przeglądarce)': '— (key in the browser)',
    '„{name}” zniknie z listy, rozmowa zostanie zamknięta': '“{name}” will disappear from the list and the conversation will close',
    '„{name}” zniknie z tego urządzenia i przestaniesz odbierać wiadomości.': '“{name}” will disappear from this device and you will stop receiving messages.',
    '🔒 E2E interim': '🔒 E2E interim',
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
