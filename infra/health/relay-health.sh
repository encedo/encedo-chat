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
  curl -fsS -m 10 --get \
    --data-urlencode "status=$1" \
    --data-urlencode "msg=$2" \
    --data-urlencode "ping=${3:-0}" \
    "$PUSH" >/dev/null 2>&1 || true
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
if [ "$SVC_UP" -gt 1200 ]; then
  LINE=$(journalctl -u onchato-relay --since "25 min ago" -o cat 2>/dev/null | grep -F '[stats 15m] topics' | tail -1)
  [ -n "$LINE" ] || fail "brak linii [stats] od 25 min (pętla stoi?)"
  LAG=$(printf '%s' "$LINE" | grep -oE 'lag=[0-9]+' | cut -d= -f2)
fi

# Na wykresie w Kumie ląduje NAJGORSZE zacięcie pętli zdarzeń z ostatniego okna,
# a nie czas tej sondy: to jest liczba mówiąca o kondycji węzła, a czas skryptu
# mówiłby o kondycji skryptu.
MS=$(( $(date +%s%3N) - start_ms ))
ping_kuma up "ok (up ${SVC_UP}s)" "${LAG:-$MS}"
