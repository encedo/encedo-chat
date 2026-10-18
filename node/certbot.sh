#!/bin/sh
# The certificate for NODE_HOST: issued over HTTP-01 through nginx's webroot,
# then `certbot renew` twice a day. CERT_MODE=self makes a self-signed one
# instead (a test box with no public DNS); the apps refuse it, curl -k does not.
set -eu
: "${NODE_HOST:?NODE_HOST is not set (node.env)}"
LIVE=/etc/letsencrypt/live/$NODE_HOST
if [ "${CERT_MODE:-letsencrypt}" = self ]; then
  if [ ! -f "$LIVE/fullchain.pem" ]; then
    mkdir -p "$LIVE"
    python3 - "$NODE_HOST" "$LIVE" <<'PY'
import sys, datetime
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
host, live = sys.argv[1], sys.argv[2]
key = ec.generate_private_key(ec.SECP256R1())
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now).not_valid_after(now + datetime.timedelta(days=90))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False).sign(key, hashes.SHA256()))
open(f"{live}/privkey.pem", "wb").write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
open(f"{live}/fullchain.pem", "wb").write(cert.public_bytes(serialization.Encoding.PEM))
PY
    echo "onchato-certbot: self-signed certificate for $NODE_HOST (test only)"
  fi
  exec sleep infinity
fi
: "${ACME_EMAIL:?ACME_EMAIL is not set (node.env)}"
until [ -f "$LIVE/fullchain.pem" ]; do
  certbot certonly --webroot -w /var/www/html -d "$NODE_HOST" --email "$ACME_EMAIL" --agree-tos --non-interactive --no-eff-email \
    || { echo "onchato-certbot: no certificate yet (DNS? port 80?) - again in 60 s"; sleep 60; }
done
while true; do certbot renew --webroot -w /var/www/html --quiet || true; sleep 43200; done
