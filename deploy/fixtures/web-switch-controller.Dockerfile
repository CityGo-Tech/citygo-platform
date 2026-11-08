# Offline trusted TEST HOST only. Candidates never receive a Docker socket.
ARG PYTHON_IMAGE
ARG NGINX_IMAGE
ARG DIND_IMAGE
FROM ${PYTHON_IMAGE} AS python
FROM ${NGINX_IMAGE} AS nginx
FROM ${DIND_IMAGE}
# CPython's glibc loader/dependencies coexist with the Alpine/musl Docker tools.
COPY --from=python /usr/local/ /usr/local/
COPY --from=python /usr/lib/x86_64-linux-gnu/ /usr/lib/x86_64-linux-gnu/
COPY --from=python /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2
COPY --from=nginx /lib/ /lib/
COPY --from=nginx /usr/lib/ /usr/lib/
COPY --from=nginx /usr/sbin/nginx /usr/sbin/nginx
COPY --from=nginx /etc/nginx/ /etc/nginx/
RUN ln -s /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu \
 && ln -s /usr/local/bin/docker /usr/bin/docker \
 && addgroup -S nginx \
 && adduser -S -D -H -s /sbin/nologin -G nginx nginx \
 && mkdir -p /usr/lib/ssl /opt/citygo-controller-fixture /var/cache/nginx /var/log/nginx \
 && ln -sf /etc/ssl/certs/ca-certificates.crt /usr/lib/ssl/cert.pem \
 && python3 -c 'import ssl, os, signal; assert hasattr(os,"pidfd_open"); assert hasattr(signal,"pidfd_send_signal"); print(ssl.OPENSSL_VERSION)' \
 && /usr/sbin/nginx -V \
 && /usr/sbin/nginx -t \
 && /usr/bin/docker --version \
 && dockerd --version
ENTRYPOINT ["/usr/local/bin/python3", "-E", "-s", "-B", "/opt/citygo-controller-fixture/harness.py"]
