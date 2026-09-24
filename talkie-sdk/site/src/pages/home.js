import '../lion.js';
import { mountShell, getBackendSettings } from '../shell.js';

mountShell('index');

// Insert a live preview of the widget.
import '../preview.js';

/* ------------------------------------------------------------------- live preview */

let preview = null;

function createPreview(settings) {
  // Removing the element ends its agent session (TalkieAssistant.disconnectedCallback).
  preview?.remove();
  preview = null;

  const container = document.getElementById('preview');
  if (!container) return;

  const p = document.createElement('talkie-preview');
  p.setAttribute('backend', settings.backend);
  if (settings.api !== 'http://localhost:8000') {
    p.setAttribute('api', settings.api);
  }
  container.appendChild(p);
  preview = p;
}

const demoNote = document.getElementById('demo-note');
const MOCK_NOTE = demoNote?.innerHTML ?? '';

/** Keep the note under the buttons true to what "Try the demo" will do. */
function renderDemoNote(settings) {
  if (!demoNote) return;
  if (settings.backend === 'live') {
    demoNote.textContent = `Live: the demo talks to ${settings.api}. It will ask for your microphone.`;
  } else {
    demoNote.innerHTML = MOCK_NOTE;
  }
}

const settings = getBackendSettings();
createPreview(settings);
renderDemoNote(settings);

// Listen for backend changes (live toggle or API input in shell).
window.addEventListener('talkie-site-backend', ({ detail }) => {
  createPreview(detail);
  renderDemoNote(detail);
});

/* ------------------------------------------------------------------- "Try it" — opens the current preview widget */

const tryBtn = document.getElementById('try-btn');
if (tryBtn) {
  tryBtn.addEventListener('click', () => {
    preview?.open();
  });
}
