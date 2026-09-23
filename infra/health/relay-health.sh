#!/bin/sh
# relay-health.sh — czy PRZEKAŹNIK żyje, a nie tylko nginx przed nim.
#
# Monitory HTTP w Kumie pytają `/health`, który dowodzi nginxa, TLS-a i nazwy —
# i nic ponadto. Gdyby padł proces `onchato-relay`, wszystkie świeciłyby na
# zielono przy nieczynnym komunikatorze. Ten skrypt sprawdza to, czego z
# zewnątrz nie widać, i dopiero wtedy puka do Kumy (monitor typu Push).
#
# Cisza też jest sygnałem: gdy padnie cała maszyna, nie ma komu wysłać "down",
# a Kuma i tak zrobi się czerwona po dwóch nieodebranych puknięciach.
#
# URL z tokenem NIE leży w repozytorium — przychodzi z /etc/onchato-health.env
# (0600, root). Token jest zdolnością: kto go ma, może zgłaszać "żyję" za węzeł.
set -u

PUSH="${PUSH_URL:-}"
[ -n "$PUSH" ] || { echo "brak PUSH_URL — nic nie robię" >&2; exit 0; }

ping_kuma() {  # $1=status $2=komunikat $3=wartość do wykresu (ms)
  # Ponawianie jest tu ważniejsze niż długi timeout: jedna zgubiona paczka po
  # drodze do Kumy NIE znaczy, że węzeł padł, a bez `--retry` wystarczała, żeby
  # pomalować go na czerwono. Krótka próba razy trzy mieści się w minutowym
  # timerze z zapasem, czego jedna dziesięciosekundowa próba nie gwarantowała.
  # `--retry-connrefused`, bo restart samej Kumy to odmowa połączenia, czyli
  # dokładnie ten przypadek, który ma przeczekać, a nie alarmować.
  curl -fsS -m 4 --retry 2 --retry-delay 2 --retry-connrefused --get \
    --data-urlencode "status=$1" \
    --data-urlencode "msg=$2" \
    --data-urlencode "ping=${3:-0}" \
    "$PUSH" >/dev/null 2>&1
  rc=$?
  # Puknięcie, które nie doszło, nie zostawiało ŻADNEGO śladu: w Kumie węzeł
  # robił się czerwony, a na samym węźle nie było czym odróżnić „sonda nie
  # wystartowała" od „sonda działała, tylko Kuma jest nieosiągalna". Teraz
  # journal mówi które — i z jakim kodem curla, bo 6 (DNS), 7 (połączenie)
  # i 28 (timeout) prowadzą do trzech różnych miejsc.
  [ "$rc" -eq 0 ] || echo "kuma: puknięcie '$1' nie doszło (curl $rc)" >&2
  return 0
}
fail() { ping_kuma down "$1" 0; exit 0; }

start_ms=$(date +%s%3N)

STATE=$(systemctl is-active onchato-relay 2>/dev/null || true)
[ "$STATE" = active ] || fail "onchato-relay: $STATE"

# Port surowego WS, w który celuje nginx. Nasłuch bez procesu (osierocone
# gniazdo) jest tak samo martwy jak brak nasłuchu, ale stan usługi wyżej to już
# wyklucza — tutaj chodzi o to, że proces DOSZEDŁ do nasłuchiwania.
ss -ltn 2>/dev/null | grep -q ':9001 ' || fail "port 9001 nie nasłuchuje"

# Świeżość licznika. Relay pisze [stats 15m] co kwadrans, więc brak takiej linii
# od 25 minut znaczy, że pętla zdarzeń stanęła — proces żyje, a nie pracuje.
# Pominięte przez pierwsze 20 minut po starcie, bo wtedy jeszcze żadnego okna
# nie zamknięto i alarm byłby fałszywy.
UP_US=$(systemctl show -p ActiveEnterTimestampMonotonic --value onchato-relay 2>/dev/null || echo 0)
NOW_S=$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)
SVC_UP=$(( NOW_S - UP_US / 1000000 ))
LAG=""
NOTE=""
if [ "$SVC_UP" -gt 1200 ]; then
  LINE=$(journalctl -u onchato-relay --since "25 min ago" -o cat 2>/dev/null | grep -F '[stats 15m] topics' | tail -1)
  [ -n "$LINE" ] || fail "brak linii [stats] od 25 min (pętla stoi?)"
  LAG=$(printf '%s' "$LINE" | grep -oE 'lag=[0-9]+' | cut -d= -f2)

  # ---- sufit tematów --------------------------------------------------------
  # Najgroźniejsza awaria tego systemu jest CICHA. Po przekroczeniu
  # `--max-topics` przekaźnik odmawia subskrypcji, a klient NIE dostaje o tym
  # nic: pokój wygląda żywo i nikt się w nim nie pojawia. To jest nieodróżnialne
  # od normalnego działania produktu, bo bez store-and-forward "nikogo nie ma"
  # znaczy też "druga osoba nie jest online" — więc ani użytkownik, ani
  # zgłoszenie nie powiedzą, że uderzyliśmy w sufit.
  #
  # Licznik istniał od początku (linia [stats] i Redis) i nikt na niego nie
  # patrzył. Tutaj zaczyna być alarmem.
  #
  # Zmierzone 2026-09-23: 4 tematy na klienta, bo temat powstaje na KAŻDY
  # KONTAKT, a nie na klienta. Przy domyślnych 250 sufit wypada koło 60
  # klientów — i skaluje się z grafem społecznym, nie z liczbą ludzi.
  MAXT=$(systemctl show -p ExecStart --value onchato-relay 2>/dev/null \
    | grep -oE -- '--max-topics [0-9]+' | grep -oE '[0-9]+' | head -1)
  [ -n "${MAXT:-}" ] || MAXT=250   # tyle, ile zakłada relay.mjs bez flagi

  REFUSED=$(printf '%s' "$LINE" | grep -oE 'REFUSED=[0-9]+' | cut -d= -f2)
  # REFUSED pojawia się w linii TYLKO gdy jest niezerowe, więc jego obecność
  # sama w sobie jest zdarzeniem: właśnie straciliśmy komuś pokój.
  [ -z "${REFUSED:-}" ] || fail "sufit tematów: ODMÓWIONO $REFUSED (limit $MAXT) — pokoje cicho nie powstają"

  TOPICS=$(printf '%s' "$LINE" | grep -oE 'topics=[0-9]+' | cut -d= -f2)
  if [ -n "${TOPICS:-}" ] && [ "$MAXT" -gt 0 ]; then
    PCT=$(( TOPICS * 100 / MAXT ))
    # Alarm PRZED odmową, nie po niej. Przy 90% zostaje kilkanaście pokojów
    # zapasu, a kolejne odmowy byłyby już niewidoczne dla wszystkich poza tym
    # skryptem. Świadomie ryzykuję fałszywy alarm, bo cena pomyłki w drugą
    # stronę to ludzie, którym komunikator "po prostu nie działa".
    [ "$PCT" -lt 90 ] || fail "sufit tematów blisko: $TOPICS/$MAXT ($PCT%) — podnieś --max-topics"
    # Poniżej progu tylko mówimy. Widać w journalu i w komunikacie w Kumie,
    # zanim zrobi się pilne.
    [ "$PCT" -lt 75 ] || echo "uwaga: tematy $TOPICS/$MAXT ($PCT%)" >&2
    NOTE=" tematy ${TOPICS}/${MAXT}"
  fi
fi

# Na wykresie w Kumie ląduje NAJGORSZE zacięcie pętli zdarzeń z ostatniego okna,
# a nie czas tej sondy: to jest liczba mówiąca o kondycji węzła, a czas skryptu
# mówiłby o kondycji skryptu.
MS=$(( $(date +%s%3N) - start_ms ))
ping_kuma up "ok (up ${SVC_UP}s)${NOTE:-}" "${LAG:-$MS}"
