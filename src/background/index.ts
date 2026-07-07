// Background service worker (ES module). Foundation stub only: the state
// machine, DNR rule management, and alarm handlers land in a later phase.
import type { Request } from '../shared/messages';

chrome.runtime.onInstalled.addListener(() => {
  console.debug('[dodgy] service worker installed');
});

chrome.runtime.onMessage.addListener((_request: Request, _sender, _sendResponse) => {
  // No handlers yet. Returning false keeps the message channel synchronous.
  return false;
});
