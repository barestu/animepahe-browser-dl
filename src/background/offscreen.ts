// Manage the single offscreen document (reason BLOBS). It owns ffmpeg + createObjectURL.

const OFFSCREEN_PATH = 'src/offscreen/index.html';

let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: 'Assemble HLS segments and mux to mp4 via ffmpeg.wasm, then create a blob URL.',
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

export async function closeOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) await chrome.offscreen.closeDocument();
}
