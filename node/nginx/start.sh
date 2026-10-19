#!/bin/sh
# Render the site for NODE_HOST (and the network page for HOME_SITE, when set)
# and run nginx. nginx refuses a certificate path that does not exist, so until
# certbot has a certificate a name gets only the HTTP side (the ACME challenge),
# and its HTTPS block is switched on as soon as the certificate appears. A
# reload every 6 h picks up renewals.
set -eu
: "${NODE_HOST:?NODE_HOST is not set (node.env)}"
# No trailing slash: the template appends $request_uri (which starts with one).
HOME_URL=${HOME_URL:-https://$NODE_HOST}
HOME_URL=${HOME_URL%/}
HOME_SITE=${HOME_SITE:-}
SITE=/etc/nginx/conf.d/onchato-node.conf
HOME_CONF=/etc/nginx/conf.d/onchato-home.conf
cert() { [ -f "/etc/letsencrypt/live/$1/fullchain.pem" ]; }

cp /etc/onchato/relay-limits.conf /etc/nginx/conf.d/relay-limits.conf
# Geoblock is opt-in for other operators and not wired in this image yet: the
# site includes the snippet, so it gets an empty one.
[ -f /etc/nginx/snippets/onchato-geoblock.conf ] || : > /etc/nginx/snippets/onchato-geoblock.conf

render() {
  if cert "$NODE_HOST"; then
    sed "s/__HOST__/$NODE_HOST/g; s#__HOME__#$HOME_URL#g" /etc/onchato/relay-node.conf > "$SITE"
  else
    cat > "$SITE" <<CONF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $NODE_HOST;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 503 "waiting for the certificate\n"; }
}
CONF
  fi
  if [ -n "$HOME_SITE" ] && cert "$HOME_SITE"; then
    sed "s/__HOME_HOST__/$HOME_SITE/g" /etc/onchato/home-site.conf > "$HOME_CONF"
  else
    rm -f "$HOME_CONF"
  fi
}
# What is switched on now: changes when a certificate appears.
state() { s=; cert "$NODE_HOST" && s=n; [ -n "$HOME_SITE" ] && cert "$HOME_SITE" && s="${s}h"; echo "$s"; }
want() { s=n; [ -n "$HOME_SITE" ] && s="${s}h"; echo "$s"; }

render
now=$(state)
if [ "$now" != "$(want)" ]; then
  echo "onchato-nginx: waiting for certificates ($NODE_HOST${HOME_SITE:+ $HOME_SITE}) - HTTP only until certbot has them"
  ( while [ "$now" != "$(want)" ]; do
      sleep 5
      next=$(state)
      if [ "$next" != "$now" ]; then render; nginx -t && nginx -s reload && echo "onchato-nginx: certificate found - full site on ($next)"; now=$next; fi
    done ) &
fi
( while sleep 21600; do nginx -s reload; done ) &
exec nginx -g 'daemon off;'
