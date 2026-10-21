# Roomwave

A lightweight screen-share-and-listen-together browser app with a Vercel static frontend and an optional **Render Free Web Service** for private PeerJS signaling.

## Features

- Create or join six-character invite-code rooms (up to 8 participants).
- Share screens over WebRTC, with multiple sharers supported on desktop browsers.
- Host selects a local audio file; the browser streams it directly to guests. No media file upload to either host.
- Music playback controls, ephemeral group chat, and transient room roster.
- Mobile-friendly watching and listening. Screen capture on mobile browsers is typically unavailable.

## Architecture

```text
Vercel static site (index.html, app.js, CSS)
    |  HTTPS health request + WSS signaling (room setup only)
    v
Render Free Node Web Service (backend/server.cjs)
    |  PeerJS ExpressPeerServer mounted at /peerjs
    |  No database; no stored messages, media, or accounts
    v
Browsers use encrypted WebRTC peer-to-peer data/media links
```

Render only exchanges WebRTC connection setup information. **It does not relay or store music or screen video.** Direct connectivity can fail on restrictive networks unless you separately provision a TURN server (which is not included in the free-tier build).

The previous production site stays on public PeerJS Cloud signaling until the Render service exists and its URL is explicitly set in the frontend. This avoids breaking the already-live app while deploying.

## Run locally

The frontend has no build step. Run both services in separate terminals:

```bash
# Terminal 1: free local signaling backend
cd backend
npm install
npm start

# Terminal 2, from repository root: frontend
python3 -m http.server 8080
```

In `index.html`, temporarily set:

```html
<script>window.ROOMWAVE_SIGNALING_URL = 'http://localhost:10000';</script>
```

Then open http://localhost:8080. Restore the URL to an empty string if you want to use PeerJS Cloud as a temporary fallback.

### Tests

```bash
npm run check && npm test
cd backend && npm run check && npm test
```

The tests cover frontend URL validation and backend wiring, but successful **real WebRTC connections** must also be tested with two browsers from different networks after deployment.

## Deploy Render backend at no compute charge

1. Push this project to a new GitHub repository (e.g., `kunalz06/roomwave`). A Git remote is required for Render's Git-backed creation flow.
2. Open **https://dashboard.render.com/blueprint/new** and select that repository. The root-level `render.yaml` defines exactly one `web` service: `roomwave-signaling` with `plan: free`, `region: singapore`, root directory `backend`, `npm install --omit=dev`, and `npm start`. No paid services or databases are requested.
3. Wait for the Render deployment to become Live; verify `https://YOUR-SERVICE.onrender.com/health` returns `{"status":"ok"}`.
4. Set in `index.html`: `window.ROOMWAVE_SIGNALING_URL = 'https://YOUR-SERVICE.onrender.com';`. Use the actual URL assigned by Render; do not guess it. Redeploy the frontend to Vercel. The browser connects to `wss://YOUR-SERVICE.onrender.com/peerjs`.
5. Visit Roomwave in two browsers, create a room and join its invite code. Verify chat, music, and screen sharing. Update `ALLOWED_ORIGINS` in Render if you change the frontend domain.

Alternatively, create a **Render Web Service** directly using your GitHub repository; choose the **Free** plan, Node runtime, Singapore region, build command `cd backend && npm install --omit=dev`, start command `cd backend && npm start`, and environment variable `ALLOWED_ORIGINS=https://roomwave-together.vercel.app`.

**Free-tier caveats:** Render spins down web instances after 15 minutes of no inbound HTTP requests or WebSocket messages. The client calls `/health` first to awaken a sleeping service; initial connection can take around a minute. Render's free allowance is 750 instance hours per workspace per month and monthly bandwidth/build quotas also apply. Free is best for a prototype, not guaranteed production uptime. If you enable billing, extra usage may incur charges according to your Render account settings.

## Security and limitations

- Use only music and screen content you have permission to share.
- Invite codes are **not passwords**; there is no signup, account verification, moderation, or admission authorization.
- Public PeerServer signaling is not a full-fledged scalable room backend. Peer discovery is disabled and CORS limits browser API origins, but neither substitutes for authentication/rate limiting.
- Host must stay online to keep the room and transmit music. Track data, room chat, and participant state live in browser memory only.
- WebRTC connections are encrypted, but peers establish direct connections and may see each other's public network IPs. PeerJS Cloud/Render signaling sees connection metadata; no media is intentionally stored.
- Browser autoplay can require listeners to tap the enable-audio button.
- Keep room sizes small (2–5 recommended) without an SFU, TURN, or bandwidth engineering.
- App loads pinned PeerJS 1.5.5 from an external CDN.

## Project layout

- `index.html`, `styles.css`, `app.js`, `room-utils.mjs`, `favicon.svg`: static frontend
- `backend/server.cjs`, `backend/config.cjs`, `backend/package.json`: Node.js PeerJS signaling server
- `backend/tests/`, `tests/`: Node.js unit tests
- `render.yaml`: reproducible Render free-tier deployment

Copyright © 2026. All rights reserved unless separately licensed.

## Live tab/device audio sharing

Anyone in a Roomwave room can click **Share tab / device audio** and choose a source through the browser's permission picker. Desktop Chrome or Edge can share audio from some tabs; supported desktop OS/browser combinations may offer window or system audio. The picker **requires a screen/tab selection even when only audio is sent to the room**. If the chosen source contains no audio track, Roomwave stops capture and shows an actionable message. Screen sharing also requests optional audio and sends it as a separate WebRTC audio-only track. A **Share microphone instead** fallback is available in browsers that support microphone capture; it records surrounding sound, not internal app audio.

Listeners—including mobile browser users—can hear the shared stream when WebRTC connectivity and audio autoplay permissions allow; a visible **Tap to enable shared sound** button handles autoplay restrictions. The host's file-player audio and screen sharing remain available. Each sharing user controls and can stop their own capture; Render handles room signaling, not media relay.

### Platform limitations

- **Desktop Chrome/Edge:** tab audio is the recommended option. System/window audio is offered only when the OS/browser supports it; no option can force unavailable system audio.
- **iOS / Android browser:** capturing audio playing in another app via `getDisplayMedia()` is generally unsupported. Mobile can **listen**; microphone capture is an optional lower-quality fallback and cannot replace internal system audio capture.
- **Network:** media is WebRTC peer-to-peer, so particularly restrictive networks can require a separately configured TURN relay. Render's free signaling server does not provide TURN.
- **Rights:** share only sources you have permission to rebroadcast. This does not unlock DRM-protected audio or bypass Spotify's redistribution restrictions.
## YouTube watch party (songs and videos)

The host can paste a YouTube watch, Shorts, live or YouTube Music watch URL into the **YouTube Watch Party** panel. The official, visible YouTube IFrame player loads the video for each participant. The host can play, pause and seek using YouTube's player or the Roomwave Play/Pause/Sync controls; Render relays the host's position and playback state and new guests receive the current video.

* YouTube playback happens **separately on each viewer's device**, not by screen capture or rebroadcasting any media.
* The YouTube IFrame Player API needs no API key for known video URLs. Searching YouTube's catalog would require a separate Data API integration.
* Some videos disallow embedding or have geographic or age restrictions; the player displays its own error, or participants may open the link on YouTube.
* On mobile browsers and devices with autoplay restrictions, users may have to click **Enable YouTube playback** or Play within the visible YouTube player. Keep the embedded player visible when playing. Do not use it for hidden or background audio-only playback.
* Playback sync is best effort, corrected periodically. It cannot guarantee sample-accurate synchronization or skip any YouTube advertisements.
* The backend accepts only a host's YouTube state updates; participant attempts to change the room video are ignored. Room state is ephemeral and disappears when the host leaves or Render restarts.
* Roomwave leaves YouTube player branding, controls, and advertisements intact, and does not strip or transmit its audio/video.

YouTube remains a separate mode alongside screen sharing, authorized live tab/device audio capture, and host-provided local audio files.

## Ad-free authorized audio and OS media controls

Roomwave's host-controlled local music files are not sourced from YouTube and have no Roomwave-inserted advertisements. You must have permission to stream the files to other participants.

Roomwave uses the Web Media Session API for its own local music player (and received host music streams, when available): lock-screen and system media Play/Pause controls, with seeking for the host's local file only. It does **not** modify embedded YouTube playback or advertisements. Browser/OS support varies; device sleep, closing the browser, iOS backgrounding, and suspended WebRTC connections can prevent continued background listening. The app cannot guarantee uninterrupted background playback.

YouTube's policies prohibit blocking embedded-player advertising or permitting its embedded content to play invisibly/in the background. Use the official YouTube/YouTube Music app for subscription-based features where available. Roomwave does not download YouTube media, intercept ads, separate audio, or create hidden YouTube players.

See `media-session.mjs` and `tests/media-session.test.mjs`.

## Roomwave Music Bot (Discord-style room DJ)

The room host uploads licensed or authorized music files into a temporary, in-memory Render queue. All participants receive the same server-owned playback timeline over /rooms WebSocket. Each client streams the **same audio file from Render over HTTP**, so the host does not need to continuously broadcast a browser tab or establish WebRTC media calls for bot tracks. The bot advances to the next song when the shared timeline reaches the end. Guests joining late load the current audio at the bot's playback position. The host controls Play, Pause, Skip, and Stop.

This is a synchronized server-hosted audio jukebox, not a Discord voice participant or an SFU-based RTP broadcaster. Playback clocks are synchronized approximately; seeking or mobile device autoplay/background restrictions vary by browser. Listeners may need to press Enable Bot Audio. The host must keep the room open; leaving closes the room and deletes its temporary music. Render Free also sleeps/restarts, losing the in-memory queue. For durable always-on playback, use persistent object storage plus a paid media-capable backend.

**Limits and security:** 12 MiB maximum per track, 5 total queued/current tracks per room, 64 MiB global storage cap, 2-hour maximum track duration. Host-only upload uses an unguessable token delivered to the room host WebSocket session and checked on the backend. Audio files are served using unguessable track URLs and HTTP Range support, without extracting YouTube media. The files are transient and are deleted as they finish or the host leaves; the URLs should be treated like temporary share links. The bot applies MIME validation, origin allowlist for uploads, and memory/queue limits, but it does not scan uploaded content or validate media magic bytes. Only upload files you own or have permission to rebroadcast.

YouTube watch parties remain separate, use official visible embeds, and retain YouTube ads. Music Bot does not fetch, download, transform, or stream YouTube audio.

## Collaborative YouTube queue and playback modes

Anyone currently connected to a Roomwave room can paste a YouTube video link into the Watch Party panel and add it to the shared queue. Render keeps the authoritative queue (up to 40 queued videos, per room). Only the room host can start a queued video, reorder or remove queued videos, skip to the next video, or change playback mode:
- **Sequential:** on the host's YouTube IFrame Player API `ENDED` event, play queued videos in order.
- **Shuffle:** choose a queued item at random when the host's player ends or the host presses Next.
- **Repeat current:** replay the same current video when the host's player ends.
- **Manual:** stop at the end and let the host choose the next track.

The queue is transmitted to new guests on room join and refreshed to existing members over Render's /rooms WebSocket. These are valid YouTube video or YouTube Music watch links, not entire playlist imports. Videos run in **the official, visible YouTube embedded player on each participant's device**. YouTube retains its ads, controls and restrictions; Roomwave does not extract audio or provide background-only YouTube playback. On devices that block autoplay, users must tap Play in the visible player. Automatic transitions rely on the host's iframe reporting end of playback; when the host goes offline, Roomwave does not continue playing the YouTube queue.

## Installable PWA and background behavior

Roomwave now has an installable web app manifest and an app-shell service worker. On supported browsers, use the Install app button or **Add to Home Screen**; on iOS, use Safari's Share > Add to Home Screen. The worker only caches the frontend shell for offline loading; it does not run WebRTC or room WebSockets after the app has been stopped.

You can often keep Roomwave open and hear its **own authorized music bot/local audio** while switching apps, depending on platform media policies. The Media Session API provides lock-screen transport controls where supported. However **no browser-only app can guarantee a persistent live room or media stream after the browser is force-closed, the tab is cleared, or mobile OS suspends the page**. YouTube always requires a visible embedded player and is paused when hidden or scrolled out of view. A native client with an OS-approved background audio service is required for more dependable background music.

### October 21 queue and PWA refinements

The first submitted YouTube link automatically becomes the currently selected video with playback requested, subject to the visible YouTube iframe and each browser's autoplay rules. Further links form the up-next queue. Playback position now accounts for elapsed time between server messages so periodic synchronization doesn't repeatedly seek guests backward. If YouTube blocks the host's autoplay, the host's room playback state is paused until they start playback manually. Queue entries show YouTube thumbnails.

Android installation includes PNG icons at 192 and 512 px; on iOS, use Add to Home Screen. The service worker caches only app-shell files. Neither installation nor the service worker creates a persistent background media connection after a browser or OS kills the page.
