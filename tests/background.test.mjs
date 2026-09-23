import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('toolbar uses the normal action path and opens the clicked tab without losing its user gesture', async () => {
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  let listener;
  let builtInToggle = true; // An upgrade must also clear the old persisted setting.
  const openedTabs = [];
  const chrome = {
    sidePanel: {
      setPanelBehavior: async options => { builtInToggle = options.openPanelOnActionClick; },
      open: async options => { openedTabs.push(options.tabId); },
    },
    action: { onClicked: { addListener: callback => { listener = callback; } } },
    storage: {
      local: { setAccessLevel: async () => {} },
      session: { setAccessLevel: async () => {} },
    },
  };
  runInNewContext(source, { chrome, console });
  assert.equal(builtInToggle, false, 'automatic side-panel toggling bypasses activeTab');
  assert.equal(typeof listener, 'function');
  listener({ id: 42 });
  assert.deepEqual(openedTabs, [42], 'open() must run synchronously within the action gesture');
  listener({ id: 73 });
  assert.deepEqual(openedTabs, [42, 73], 'a new click must target the newly authorized tab');
  listener({});
  assert.deepEqual(openedTabs, [42, 73]);
});
