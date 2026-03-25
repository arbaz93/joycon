/**
 * FILE OVERVIEW:
 * Bootstraps the controller UI shell page. It delays loading the heavy
 * controller markup/scripts until landscape orientation is detected.
 */

const main = document.getElementById('app');
const warning = document.getElementById('warning');
const closeNotification = document.getElementById('close-notification');

const CONTENT_PATH = '/static/content.html';
const CONTROLLER_PATH = '/static/javascript/controller.js';
const JOYSTICK_PATH = '/static/javascript/virtual-joystick.js';

let isLoaded = false;
let isLoading = false;

/**
 * Ensure a script module is injected only once.
 *
 * @param {string} src - Script URL.
 * @param {string} id - Logical module id stored in data attributes.
 * @returns {void}
 * @sideEffects Appends a `<script>` element to `document.body` when absent.
 */
function ensureScript(src, id) {
  if (document.querySelector(`script[data-module="${id}"]`)) return;

  const script = document.createElement('script');
  script.src = src;
  script.defer = true;
  script.dataset.module = id;
  document.body.appendChild(script);
}

/**
 * Load controller runtime scripts after markup injection.
 *
 * @returns {void}
 * @sideEffects Injects controller-related script tags.
 */
function loadControllerScripts() {
  ensureScript(CONTROLLER_PATH, 'controller');
  ensureScript(JOYSTICK_PATH, 'virtual-joystick');
}

/**
 * Fetch and inject the controller HTML fragment.
 *
 * @returns {Promise<void>}
 * @sideEffects Mutates DOM (`#app`), toggles animation classes, and may render
 * fallback error markup when fetch fails.
 */
async function loadContent() {
  if (!main || isLoaded || isLoading) return;
  isLoading = true;

  try {
    const response = await fetch(CONTENT_PATH);
    if (!response.ok) {
      throw new Error(`Failed to fetch controller content: ${response.status}`);
    }
    const html = await response.text();
    main.innerHTML = html;

    loadControllerScripts();
    requestAnimationFrame(() => main.classList.add('visible'));
    isLoaded = true;
  } catch (_error) {
    // NOTE: Keep fallback message minimal to avoid blocking UI startup.
    // TODO: Add retry button for flaky network startup scenarios.
    main.innerHTML = '<p>Failed to load content</p>';
  } finally {
    isLoading = false;
  }
}

/**
 * Enforce "landscape-first" UX and lazy-load content when ready.
 *
 * @returns {void}
 * @sideEffects Toggles warning visibility and triggers async content loading.
 */
function handleOrientation() {
  if (!warning) return;

  const isLandscape = window.innerWidth > window.innerHeight;
  warning.classList.toggle('hidden', isLandscape);
  if (isLandscape) loadContent();
}

/**
 * Hide the fullscreen helper notification.
 *
 * @param {MouseEvent} event - Click event from notification controls.
 * @returns {void}
 * @sideEffects Updates notification container style (`display: none`).
 */
function hideFullscreenNotification(event) {
  const container = event.currentTarget.closest('.fs-container');
  if (container) container.style.display = 'none';
}

handleOrientation();
window.addEventListener('resize', handleOrientation, { passive: true });
window.addEventListener('orientationchange', handleOrientation, { passive: true });

if (closeNotification) {
  closeNotification.addEventListener('click', hideFullscreenNotification);
  const fullscreenNotificationButton = document.querySelector('.fullscreen-toggle-notification-btn');
  if (fullscreenNotificationButton) {
    fullscreenNotificationButton.addEventListener('click', hideFullscreenNotification);
  }
}
