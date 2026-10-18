#!/bin/sh
# Render the site for NODE_HOST and run nginx. nginx refuses a certificate path
# that does not exist, so until certbot has one it serves only the HTTP side
# (the ACME challenge), and switches to the full site as soon as the
# certificate appears. A reload every 6 h picks up renewals.
set -eu
: "${NODE_HOST:?NODE_HOST is not set (node.env)}"
HOME_URL=${HOME_URL:-https://$NODE_HOST}
CERT=/etc/letsencrypt/live/$NODE_HOST/fullchain.pem
SITE=/etc/nginx/conf.d/onchato-node.conf

cp /etc/onchato/relay-limits.conf /etc/nginx/conf.d/relay-limits.conf
# Geoblock is opt-in for other operators and not wired in this image yet: the
# site includes the snippet, so it gets an empty one.
[ -f /etc/nginx/snippets/onchato-geoblock.conf ] || : > /etc/nginx/snippets/onchato-geoblock.conf

full() { sed "s/__HOST__/$NODE_HOST/g; s#__HOME__#$HOME_URL#g" /etc/onchato/relay-node.conf > "$SITE"; }
http_only() {
  cat > "$SITE" <<CONF
server {
    listen 80;
    listen [::]:80;
    server_name $NODE_HOST;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 503 "waiting for the certificate\n"; }
}
CONF
}

if [ -f "$CERT" ]; then full; else
  http_only
  echo "onchato-nginx: no certificate for $NODE_HOST yet - HTTP only until certbot has one"
  ( while [ ! -f "$CERT" ]; do sleep 5; done; full; nginx -t && nginx -s reload && echo "onchato-nginx: certificate found - full site on" ) &
fi
( while sleep 21600; do nginx -s reload; done ) &
exec nginx -g 'daemon off;'
