FROM python:3.12-slim

# ffmpeg merges HD video+audio tracks and extracts MP3.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---- Word and Excel to PDF (office.py) --------------------------------------
# LibreOffice Writer and Calc without the desktop parts, the UNO bridge for
# the system Python (office.py runs LibreOffice through /usr/bin/python3),
# and fonts made to the same widths as Office's own, so lines and pages break
# where they did: Carlito (Calibri), Caladea (Cambria), Liberation (Arial,
# Times New Roman, Courier New), with DejaVu and Noto for other scripts.
# Licences: THIRD_PARTY_NOTICES.md. Roughly 500-650 MB more image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui python3-uno \
      fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 \
      fonts-dejavu-core fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
# ---- end of Word and Excel to PDF -------------------------------------------

WORKDIR /app
COPY requirements.txt .
# YouTube breaks old yt-dlp releases often. Change this value (or pass
# --build-arg YTDLP_REFRESH=$(date +%F)) to force a fresh install on rebuild.
ARG YTDLP_REFRESH=2026-09-28
RUN echo "yt-dlp refresh: $YTDLP_REFRESH" \
 && pip install --no-cache-dir -U -r requirements.txt \
 && deno --version
COPY worker.py .
# Word and Excel to PDF.
COPY office.py .

# Run as an unprivileged user.
RUN useradd --create-home worker
USER worker

ENV PORT=8080
EXPOSE 8080
# Hosts that set their own PORT get it checked there.
HEALTHCHECK CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8080'))" || exit 1
# YTDLP_AUTO_UPDATE=1 upgrades yt-dlp at every start, between rebuilds.
CMD ["sh", "-c", "if [ \"$YTDLP_AUTO_UPDATE\" = 1 ]; then pip install --user --no-cache-dir -qU 'yt-dlp[default,deno]' || true; fi; exec python worker.py"]
