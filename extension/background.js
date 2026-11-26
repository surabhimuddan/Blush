// Placeholder until piece 6.
import { DEBUG } from "./config.js";

// Toolbar click opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
    if (DEBUG) console.warn("KoiPilot: setPanelBehavior failed", e);
  });
});
