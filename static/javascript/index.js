const main = document.getElementById('app');
const warning = document.getElementById('warning');
const closeNotification = document.getElementById('close-notification');

const CONTENT_PATH = '../static/content.html';
const CONTROLLER_PATH = '../static/javascript/controller.js';
const JOYSTICK_PATH = '../static/javascript/virtual-joystick.js';

let isLoaded = false;
let isLoading = false;

function ensureScript(src, id) {
  if (document.querySelector(`script[data-module="${id}"]`)) return;

  const script = document.createElement('script');
  script.src = src;
  script.defer = true;
  script.dataset.module = id;
  document.body.appendChild(script);
}

function loadControllerScripts() {
  ensureScript(CONTROLLER_PATH, 'controller');
  ensureScript(JOYSTICK_PATH, 'virtual-joystick');
}

async function loadContent() {
  if (!main || isLoaded || isLoading) return;
  isLoading = true;

  try {
    const response = await fetch(CONTENT_PATH);
    const html = await response.text();
    main.innerHTML = html;

    loadControllerScripts();
    requestAnimationFrame(() => main.classList.add('visible'));
    isLoaded = true;
  } catch (_error) {
    main.innerHTML = '<p>Failed to load content</p>';
  } finally {
    isLoading = false;
  }
}

function handleOrientation() {
  if (!warning) return;

  const isLandscape = window.innerWidth > window.innerHeight;
  warning.classList.toggle('hidden', isLandscape);
  if (isLandscape) loadContent();
}

function hideFullscreenNotification(event) {
  const container = event.currentTarget.closest('.fs-container');
  if (container) container.style.display = 'none';
}

handleOrientation();
window.addEventListener('resize', handleOrientation, { passive: true });
window.addEventListener('orientationchange', handleOrientation, { passive: true });

if (closeNotification) {
  closeNotification.addEventListener('click', hideFullscreenNotification);
  document.querySelector(".fullscreen-toggle-notification-btn").addEventListener('click', hideFullscreenNotification);
}