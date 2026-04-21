FROM nginx:1.27-alpine
RUN apk add --no-cache gettext
COPY nginx.conf.template /etc/nginx/nginx.conf.template
USER 101:101
EXPOSE 3000
CMD ["/bin/sh", "-c", "envsubst '${GATEWAY_AUTH_TOKEN}' < /etc/nginx/nginx.conf.template > /tmp/nginx.conf && exec nginx -c /tmp/nginx.conf -g 'daemon off;'"]
