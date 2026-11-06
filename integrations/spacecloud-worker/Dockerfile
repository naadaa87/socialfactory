# Keep this browser image and package.json playwright version identical.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --chown=pwuser:pwuser *.mjs ./
RUN mkdir -p /var/lib/spacecloud-profile && chown pwuser:pwuser /var/lib/spacecloud-profile && chmod 700 /var/lib/spacecloud-profile
USER pwuser
ENV SPACECLOUD_PROFILE_DIR=/var/lib/spacecloud-profile SPACECLOUD_HEADLESS=true
CMD ["node", "worker.mjs"]
