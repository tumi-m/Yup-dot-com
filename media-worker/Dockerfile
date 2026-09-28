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

# Run as an unprivileged user.
RUN useradd --create-home worker
USER worker

ENV PORT=8080
EXPOSE 8080
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/health')" || exit 1
# YTDLP_AUTO_UPDATE=1 upgrades yt-dlp at every start, between rebuilds.
CMD ["sh", "-c", "if [ \"$YTDLP_AUTO_UPDATE\" = 1 ]; then pip install --user --no-cache-dir -qU 'yt-dlp[default,deno]' || true; fi; exec python worker.py"]
