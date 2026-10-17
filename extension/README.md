# PDF Wizard: X Video Downloader (browser extension)

Adds a **Download** button to every post on X (Twitter) that has a video or
GIF. Clicking it offers **Video (MP4)** or **Audio (MP3)** and opens PDF
Wizard's X downloader with the post's link already filled in.

- Runs only on `x.com` and `twitter.com`.
- Requests **no permissions**: no access to other sites, tabs, history,
  cookies or storage.
- Collects and sends nothing. It reads the clicked post's link and opens a tab.
- Visits it starts carry `utm_source=extension`, so Google Analytics can show
  how many people come from it (after they accept cookies on the site).

## Files

| File | What it is |
|---|---|
| `manifest.json` | Name, version, icons, where the script runs |
| `content.js` | Finds video posts, adds the button and menu |
| `content.css` | Button and menu styles, following X's light or dark theme |
| `icons/` | 16, 32, 48 and 128 px icons from the site logo |

## Try it locally

1. Chrome or Edge → `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → choose this `extension` folder.
4. Open x.com, scroll to a post with a video, click **Download**.

## Package

```bash
npm run pack:extension   # → dist/pdf-wizard-x-<version>.zip
```

Bump `version` in `manifest.json` for every store update.

## Publish

**Chrome Web Store** (one-off $5 developer fee):
1. Go to the Chrome Web Store Developer Dashboard and sign in with your Google
   account. Pay the registration fee and verify your email.
2. **New item** → upload the zip.
3. Store listing: description, at least one 1280×800 screenshot (a post on X
   with the Download menu open) and the 128 px icon. Category: Productivity.
4. Privacy: single purpose "Adds a download button to X videos that opens
   PDF Wizard". Permissions: none. Data use: does not collect user data.
   Privacy policy URL: `https://pdfwizard.xyz/privacy`.
5. Submit for review (usually a few days).

**Microsoft Edge Add-ons** (free): Partner Center → Edge → **Create new
extension** → upload the same zip and listing.

Store reviewers may question video-download extensions. The extension itself
only opens a web page, and the site only fetches public posts; state that
clearly in the listing.
