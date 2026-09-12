# Sonda zdrowia → Uptime Kuma (monitor typu Push)

Monitory HTTP w Kumie pytają `/health` każdego węzła, co dowodzi **nginxa, TLS-a
i nazwy**. Nie dowodzi przekaźnika: gdyby padł proces `onchato-relay`, wszystkie
świeciłyby na zielono przy nieczynnym komunikatorze. Ta sonda zamyka tę lukę.

Sprawdza lokalnie trzy rzeczy i dopiero wtedy puka do Kumy:

1. `onchato-relay` jest `active`,
2. port `9001` nasłuchuje (proces doszedł do nasłuchiwania),
3. w dzienniku jest linia `[stats 15m]` z ostatnich 25 minut — jej brak znaczy,
   że pętla zdarzeń stanęła: proces żyje, ale nie pracuje. Pomijane przez
   pierwsze 20 minut po starcie, bo wtedy żadne okno jeszcze się nie zamknęło.

Na wykres w Kumie trafia **najgorsze zacięcie pętli zdarzeń** z ostatniego okna
(`lag` z linii `[stats]`), a nie czas wykonania sondy.

## Instalacja na węźle

```sh
# 1. token z Kumy (Add New Monitor → Push → skopiuj Push URL BEZ parametrów)
printf 'PUSH_URL=https://status.encedo.com/api/push/<TOKEN>\n' | sudo tee /etc/onchato-health.env >/dev/null
sudo chmod 600 /etc/onchato-health.env

# 2. jednostki (repo jest już na węźle w /opt/github/encedo-chat)
sudo cp /opt/github/encedo-chat/infra/health/onchato-health.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now onchato-health.timer

# 3. sprawdzenie
sudo systemctl start onchato-health.service && journalctl -u onchato-health -n 5 --no-pager
```

**Token jest sekretem** — kto go ma, może zgłaszać „żyję" za węzeł. Dlatego
`/etc/onchato-health.env` ma prawa 0600 i nie ma go w repozytorium.

Cisza też jest sygnałem: gdy padnie cała maszyna, nie ma komu wysłać `down`,
a Kuma i tak zapala alarm po dwóch nieodebranych puknięciach.
