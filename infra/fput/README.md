# fput — osiem bajtow miedzy uploadem a magazynem

`POST /f` przyjmuje plik od kazdego i tak ma zostac: uwierzytelniony upload
wiedzialby, kto co wyslal i kiedy, czyli dokladnie to, czego reszta produktu
unika. Ten serwis nie zmienia tej decyzji — zmienia to, **co da sie z magazynu
wyciagnac**.

## Co robi

Dokleja osiem bajtow (`ECF1` + wersja + zapas, `impl/lib/fileenvelope.ts`) na
poczatek kazdego uploadu, zanim trafi on do Kubo. Nikt ich po drodze nie zdejmuje
— ani `/f`, ani publiczna bramka. Zdejmuje je dopiero klient przy deszyfrowaniu.

**Co wchodzi, nie jest tym, co wychodzi.** Magazyn przestaje oddawać cokolwiek
1:1, wiec nie da sie go uzyc jako hostingu plikow, a przegladarka dostaje z
bramki `application/octet-stream` zamiast strony: Kubo rozpoznaje typ po
pierwszych bajtach, a te sa binarne. Sprawdzone na zywym uploadzie —
`<!doctype html>` wraca jako `text/html`, `ECF1…<!doctype html>` jako
`application/octet-stream`.

## Czego nie robi

**Nie odmawia.** Kto zna nasz format, dalej zaparkuje tu 128 MB na piec minut, i
bez uwierzytelniania nie da sie tego odroznic od naszego szyfrogramu. Znika
konkretna szkoda: klikalna strona pod nasza domena, a po niej Safe Browsing, po
ktorym aplikacja nie otwiera sie nikomu. Zostaje przechowalnia na bajty, ktorych
nikt nie otworzy ani jako strony, ani jako programu.

## Jak jest wpiete

    klient -> nginx `location = /f` -> 127.0.0.1:9202 -> rpc.ipfs.encedo.com /api/v0/add

nginx zostaje brzegiem: limity tempa, `limit_conn`, CORS, `limit_except`,
`client_max_body_size 128m` i **`proxy_request_buffering off`**. Bez tej ostatniej
nginx zapisuje cale cialo do pliku tymczasowego, zanim serwis cokolwiek zobaczy.

Z nginxa przenioslo sie tutaj: nazwa wpisu w ksiedze zamiatacza
(`/ec/<epoch>-<unikat>` — wpis poza tym schematem **nigdy nie wygasa**, a
`ipfs-ttl.sh` nie zglosi tego jako bledu), `pin=false`, oraz `User-Agent:
encedo-proxy`, bo Kubo odrzuca naglowki zaczynajace sie od "Mozilla".

`GET /f/<cid>` **nie idzie przez ten serwis** — dalej nginx prosto do Kubo. Cale
pobieranie omija Node, a prefiks i tak zostaje na miejscu.

## Uruchomienie i sprawdzenie

    node fput.mjs                              # 127.0.0.1:9202
    IPFS_RPC=http://127.0.0.1:5001 node fput.mjs
    node --test *.test.mjs                     # offline, przeciw udawanemu Kubo

Po wdrozeniu dwa sprawdzenia, ktore musza dac PRZECIWNE odpowiedzi:

    # cudza strona: wchodzi, ale bramka nie chce jej wyrenderowac
    C=$(curl -s -F file=@evil.html https://onchato.com/f | grep -o '"Hash":"[^"]*"' | cut -d'"' -f4)
    curl -sI https://ipfs.encedo.com/ipfs/$C | grep -i content-type   # ma byc octet-stream

    # nasz plik: wysyla sie i otwiera w aplikacji, a po TTL znika
    docker exec ipfs1 ipfs files ls /ec | tail -3

## Uwaga dla kogokolwiek, kto to zmienia

Nic tu nie wolno wczytac "w calosci". Jeden `await req.text()` albo dowolny
gotowy parser multipartu i 128 MB laduje w pamieci albo na dysku — a to jest
jedyny powod, dla ktorego ten plik jest napisany strumieniowo.
