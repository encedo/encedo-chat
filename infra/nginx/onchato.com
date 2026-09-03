limit_conn_zone $binary_remote_addr zone=mqtt_conn:10m;
limit_req_zone  $binary_remote_addr zone=mqtt_req:10m rate=30r/s;

# Relay: TE limity są jedyną ochroną przeciwzalewową. GossipSub ma scoring po IP
# wyłączony (IPColocationFactorWeight: 0 w relay/relay.mjs — za proxy każdy klient
# przychodzi ze 127.0.0.1, więc kara liczyła wszystkich jako jeden adres), czyli
# obrona MUSI stać tu, na brzegu, gdzie realny adres jeszcze istnieje.
# Limit dotyczy handshake'u HTTP — ustanowiony WebSocket żyje poza limit_req.
limit_conn_zone $binary_remote_addr zone=relay_conn:10m;
limit_req_zone  $binary_remote_addr zone=relay_req:10m rate=10r/s;

# Feedback: formularz z aplikacji (infra/feedback). Człowiek pisze jedno
# zgłoszenie na kilka minut — 1 r/s z burstem 5 puszcza każde uczciwe użycie
# i zatrzymuje skrypt, zanim napełni plik.
limit_req_zone  $binary_remote_addr zone=fb_req:10m rate=1r/s;


# --- HTTP redirect: onchato.com + chat.encedo.com ---
server {
    listen 80;
    server_name onchato.com chat.encedo.com;

    # ── NOWE: wyzwanie ACME MUSI dostać odpowiedź przed przekierowaniem ─────
    # "^~" wygrywa z regexami i z "location /", więc 301 niżej go nie zjada.
    # Bez tego walidacja webroot leci na HTTPS, tam try_files oddaje index.html
    # zamiast tokenu i certbot mówi tylko "unauthorized" — nic o przekierowaniu.
    # Zostaje na stałe: odnowienia i kolejne domeny nie wymagają wtedy, żeby
    # certbot edytował TEN plik (a edytowałby kopię na serwerze, którą i tak
    # nadpisujemy przez scp).
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
    }

    # Przekierowanie MUSI być w location, nie w serwerze. "return" na poziomie
    # serwera wykonuje się w fazie rewrite — ZANIM nginx wybierze location — więc
    # blok ACME wyżej nigdy nie dostawał szansy: 301 szedł pierwszy, CA leciało za
    # nim na HTTPS, a tam try_files oddawało index.html zamiast tokenu. Objaw:
    # "Invalid response" z treścią cudzej strony albo 404, i ani słowa o tym, że
    # wyzwanie w ogóle nie trafiło tam, gdzie leży.
    location / { return 301 https://$host$request_uri; }
}

# --- HTTPS: onchato.com — frontend statyczny (JEDYNY origin aplikacji) ---
# Certyfikat jest JEDEN (cert-name onchato.com), obejmuje też chat.encedo.com.
server {
    listen 443 ssl;
    server_name onchato.com;

    ssl_certificate     /etc/letsencrypt/live/onchato.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/onchato.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root /opt/github/encedo-chat/impl/web/dist;
    index index.html;

    # ── NOWE: strona publiczna odpowiada na sam "/" ────────────────────────
    # Blok "= /" (dopasowanie dokładne) wygrywa z "location /" niżej, więc to
    # jedyne miejsce, które przestaje serwować aplikację. Nagłówki są POWTÓRZONE
    # świadomie: add_header nie dziedziczy się do bloku, który ma własne.
    location = / {
        add_header Cross-Origin-Opener-Policy   "same-origin";
        add_header Cross-Origin-Embedder-Policy "require-corp";
        add_header Cache-Control "no-cache";
        try_files /landing.html =404;
    }

    # ── NOWE: /chat/ ze slashem musi wrócić na /chat ───────────────────────
    # Bez tego bazą dokumentu staje się "/chat/", więc względne ścieżki bundla
    # celują w /chat/app.<hash>.bundle.js → try_files oddaje index.html jako
    # JavaScript i aplikacja nie wstaje. Objaw: biała strona, w konsoli błąd
    # składni w miejscu, gdzie jest HTML.
    location = /chat/ { return 301 /chat; }

    location = /f {
        # CORS, bo paczka (Tauri/Android) NIE jest serwowana z tego origin.
        # Ładuje bundle z tauri://localhost, więc upload jest dla niej
        # cross-origin: bez tych nagłówków nginx odpowiada poprawnie, a
        # przeglądarka i tak odrzuca odpowiedź — w aplikacji wygląda to na
        # "wysyłanie plików nie działa". Web jest tu bez zmian: dla niego to
        # nadal ten sam origin i nagłówek jest nadmiarowy, nie szkodliwy.
        #
        # Preflight MUSI być przed limit_except i dlatego jest w "if": blok if
        # (moduł rewrite) wykonuje się przed fazą dostępu, więc OPTIONS wraca
        # 204 zanim limit_except zdąży odmówić. OPTIONS jest i tak dopisane do
        # limit_except — na wypadek, gdyby ktoś kiedyś ruszył ten "if".
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  "*";
            add_header Access-Control-Allow-Methods "POST, OPTIONS";
            add_header Access-Control-Allow-Headers "content-type";
            add_header Access-Control-Max-Age       86400;
            return 204;
        }
        add_header Access-Control-Allow-Origin "*" always;

        limit_except POST OPTIONS { deny all; }
        client_max_body_size 128m;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;

        proxy_set_header Origin     "";
        proxy_set_header Referer    "";
        proxy_set_header User-Agent "encedo-proxy";   # ← Kubo odrzuca UA zaczynające się od "Mozilla"
        proxy_ssl_server_name on;
        rewrite ^ /api/v0/add?pin=false&to-files=/ec/$msec-$request_id break;
        proxy_pass https://rpc.ipfs.encedo.com;
    }

    location ~ ^/f/(?<cid>[A-Za-z0-9]+)$ {
        # Jak wyżej: pobranie pliku w paczce to żądanie z innego origin. GET bez
        # własnych nagłówków nie robi preflightu, ale odpowiedź i tak musi się
        # przedstawić, inaczej fetch dostaje błąd zamiast bajtów.
        add_header Access-Control-Allow-Origin  "*" always;
        # Strona web chodzi z COEP require-corp, a zasób z innego origin musi
        # sam pozwolić się wciągnąć — inaczej blokuje go izolacja, nie CORS.
        add_header Cross-Origin-Resource-Policy "cross-origin" always;

        limit_except GET { deny all; }
        proxy_method POST;
        proxy_set_header Origin     "";
        proxy_set_header Referer    "";
        proxy_set_header User-Agent "encedo-proxy";   # ← Kubo odrzuca UA zaczynające się od "Mozilla"
	proxy_ssl_server_name on;
        rewrite ^ /api/v0/cat?arg=$cid&offline=true break;
        proxy_pass https://rpc.ipfs.encedo.com;
    }

    location = /feedback {
        # Formularz „💬 Feedback” z aplikacji → infra/feedback/feedback.mjs
        # (127.0.0.1:9201, jedna linia JSONL na zgłoszenie). CORS z tego
        # samego powodu co /f: paczka (Tauri/Android) wysyła z tauri://localhost.
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  "*";
            add_header Access-Control-Allow-Methods "POST, OPTIONS";
            add_header Access-Control-Allow-Headers "content-type";
            add_header Access-Control-Max-Age       86400;
            return 204;
        }
        add_header Access-Control-Allow-Origin "*" always;

        limit_except POST OPTIONS { deny all; }
        limit_req zone=fb_req burst=5 nodelay;      # per realne IP
        client_max_body_size 32k;                   # serwis tnie to samo

        # ŚWIADOMIE bez X-Real-IP / X-Forwarded-For: serwis nie ma poznać
        # adresu nadawcy, więc go nie dostaje. Adres zostaje tylko w access.log.
        proxy_set_header Origin  "";
        proxy_set_header Referer "";
        proxy_pass http://127.0.0.1:9201;
    }

    # zahashowane bundle: nazwa zmienia się z treścią → cache na zawsze
    location ~* \.bundle\.js$ {
        add_header Cross-Origin-Opener-Policy   "same-origin";
        add_header Cross-Origin-Embedder-Policy "require-corp";
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # index.html + reszta: zawsze rewaliduj → deploy łapany natychmiast
    location / {
        add_header Cross-Origin-Opener-Policy   "same-origin";
        add_header Cross-Origin-Embedder-Policy "require-corp";
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ /index.html;
    }
}

# --- HTTPS: chat.encedo.com — TYLKO landing, aplikacja stoi na onchato.com ---
# Dlaczego nie druga instancja czatu pod tą nazwą: localStorage jest per origin,
# więc profil software, kontakty lokalne, cache grup (§10, z emp_pub) i przypięte
# wiadomości byłyby OSOBNE dla każdej domeny — użytkownik, który raz wejdzie tu,
# a raz tam, widzi dwa różne światy i "traci" grupy. Do tego blokada "jedna
# tożsamość, jedna aktywna sesja" opiera się na localStorage, więc przez drugi
# origin nie widzi drugiej sesji. Linki zaproszeń i tak są kanoniczne
# (CANONICAL_ORIGIN = https://onchato.com), więc druga instancja nie byłaby
# spójna nawet sama ze sobą.
#
# Landing jest samowystarczalny (żadnych lokalnych assetów, tylko /chat i kotwice),
# więc ten blok jest krótki z natury, a nie przez przeoczenie. Nagłówki są
# powtórzone świadomie: add_header się nie dziedziczy.
server {
    listen 443 ssl;
    server_name chat.encedo.com;

    ssl_certificate     /etc/letsencrypt/live/onchato.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/onchato.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root /opt/github/encedo-chat/impl/web/dist;

    location = / {
        add_header Cross-Origin-Opener-Policy   "same-origin";
        add_header Cross-Origin-Embedder-Policy "require-corp";
        add_header Cache-Control "no-cache";
        try_files /landing.html =404;
    }

    # Wszystko poza landingiem — w tym /chat spod przycisku — idzie na kanoniczny
    # adres. Fragment "#i=" z zaproszenia przeżywa przekierowanie: przeglądarka
    # dokleja go do celu, bo Location go nie zawiera.
    location / { return 301 https://onchato.com$request_uri; }
}

# --- HTTP redirect: bs1.onchato.com ---
server {
    listen 80;
    server_name bs1.onchato.com;
    return 301 https://$host$request_uri;
}

# --- HTTPS: bs1.onchato.com — libp2p relay ---
server {
    listen 443 ssl;
    server_name bs1.onchato.com;
    ssl_certificate /etc/letsencrypt/live/bs1.onchato.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/bs1.onchato.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # WebSocket relay — bez COOP/COEP, to nie przeglądarka
    location /relay {
        proxy_pass         http://127.0.0.1:9001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        limit_conn relay_conn 20;                    # per realne IP
        limit_req  zone=relay_req burst=30 nodelay;
    }

location /mqtt {
    proxy_pass http://127.0.0.1:9101;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 300s;   # klient pinguje co 15 s
    proxy_send_timeout 300s;
    limit_conn mqtt_conn 20;   # per realne IP
    limit_req  zone=mqtt_req burst=50 nodelay;
}

    # health check — opcjonalnie
    location /health {
        return 200 "bs1 ok\n";
        add_header Content-Type text/plain;
    }

}
