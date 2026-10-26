FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Run Chromium in real (headed) mode under a virtual X server (xvfb-run) so the
# browser presents a non-headless fingerprint to bot detection (Cloudflare
# Turnstile). As of 2026 a headless Chromium is flagged at the CDP/TLS layer
# regardless of JS stealth, so headed mode is the single highest-leverage switch;
# the stealth plugin (see server.js) cleans up the residual JS-level tells.
# xvfb-run starts Xvfb, sets $DISPLAY for the child, and tears it down on exit;
# xauth is a hard dependency of xvfb-run.
RUN apt-get update \
  && apt-get install -y xvfb xauth \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
CMD ["xvfb-run", "--auto-servernum", "--server-args", "-screen 0 1280x800x24", "node", "server.js"]