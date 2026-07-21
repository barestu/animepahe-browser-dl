// Injected into kwik pages ONLY (see manifest matches). The service worker opens kwik in a
// background tab and sniffs the *.m3u8 request via chrome.webRequest. Some kwik builds don't
// load the HLS manifest until playback starts, so nudge the player.

function forcePlay(): void {
  const video = document.querySelector('video');
  if (video) {
    video.muted = true;
    video.play().catch(() => {
      /* autoplay may be blocked; the click fallback below covers it */
    });
  }
  // Fallback: click the poster / play button some kwik skins use.
  const playBtn = document.querySelector<HTMLElement>(
    '.plyr__control--overlaid, button[data-plyr="play"], .play',
  );
  playBtn?.click();
}

// Retry a few times: the player element may mount after document_idle.
let tries = 0;
const timer = setInterval(() => {
  forcePlay();
  if (++tries >= 10) clearInterval(timer);
}, 500);

forcePlay();
