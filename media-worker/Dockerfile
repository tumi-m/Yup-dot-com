FROM python:3.12-slim

# ffmpeg merges HD video+audio tracks and extracts MP3.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# YouTube breaks old yt-dlp releases often. Change this value (or pass
# --build-arg YTDLP_REFRESH=$(date +%F)) to force a fresh install on rebuild.
ARG YTDLP_REFRESH=2026-09-28
RUN echo "yt-dlp refresh: $YTDLP_REFRESH" \
 && pip install --no-cache-dir -U -r requirements.txt \
 && deno --version
COPY worker.py .

# ---------------------------------------------------------------------------
# HTML to PDF (render.py). Chromium's headless shell, the build the pinned
# Playwright expects, with the system libraries it needs (and the fonts
# Playwright adds for Chinese, Japanese, Thai and emoji), plus Noto for most
# other scripts. Adds about 600 MB; give the worker 1 GB of memory or more.
# ---------------------------------------------------------------------------
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN python -m playwright install --with-deps --only-shell chromium \
 && apt-get update && apt-get install -y --no-install-recommends fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
COPY render.py .
# --------------------------------------------------------------------------- end HTML to PDF

# Run as an unprivileged user.
RUN useradd --create-home worker
USER worker

ENV PORT=8080
EXPOSE 8080
# Hosts that set their own PORT get it checked there.
HEALTHCHECK CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8080'))" || exit 1
# YTDLP_AUTO_UPDATE=1 upgrades yt-dlp at every start, between rebuilds.
CMD ["sh", "-c", "if [ \"$YTDLP_AUTO_UPDATE\" = 1 ]; then pip install --user --no-cache-dir -qU 'yt-dlp[default,deno]' || true; fi; exec python worker.py"]
