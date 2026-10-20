# The node's nginx: OUR site template (infra/nginx/relay-node.conf, the one
# bs2/bs3 run) rendered for the operator's name at start. Context: repo root.
FROM nginx:1.27-bookworm
RUN rm -f /etc/nginx/conf.d/default.conf && mkdir -p /etc/nginx/snippets /var/www/html /srv/onchato /srv/app
COPY infra/nginx/relay-node.conf infra/nginx/relay-limits.conf /etc/onchato/
COPY node/nginx/onchato-extra-profile.conf /etc/nginx/snippets/
COPY node/nginx/home-site.conf node/nginx/onchato-app.conf node/nginx/onchato-extra-store.conf node/nginx/store-limits.conf node/nginx/onchato-extra-enroll.conf node/nginx/enroll-limits.conf /etc/onchato/
COPY node/nginx/start.sh /usr/local/bin/onchato-nginx
RUN chmod 755 /usr/local/bin/onchato-nginx
ENTRYPOINT ["onchato-nginx"]
