// Chrome's built-in side-panel toggle skips the activeTab grant. Use a normal
// action click, then open the panel while that user gesture is still active.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
chrome.action.onClicked.addListener(tab => {
  if (tab.id != null) chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});
// Profile data and credentials stay in extension contexts, never in content scripts.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
