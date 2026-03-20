    // ============================================
    // Performance Optimizations:
    // ============================================
    // 1. requestAnimationFrame: Joystick updates are synced to browser frames (60fps max)
    // 2. Debounced emissions: Socket.io events throttled to ~60fps to reduce network chatter
    // 3. Haptic feedback: Uses Vibration API for tactile feedback on button press/release
    // 4. touch-action: none: Prevents browser default touch behaviors (scroll, zoom)
    // 5. Passive event listeners: Used where possible to improve scroll performance
    // 6. Immediate preventDefault(): Reduces input latency by preventing default actions early
    // 7. Optimized DOM queries: Cached element references to avoid repeated lookups
    // ============================================

    const socket = io();

    const enforceLandscape = () => {
    const tryLock = async () => {
    try {
    if (screen.orientation?.lock) {
    await screen.orientation.lock('landscape');
}
} catch (err) {
    console.warn('Orientation lock failed:', err);
}
};

    tryLock();

    const firstGestureLock = () => {
    tryLock();
};

    window.addEventListener('click', firstGestureLock, { once: true });
    window.addEventListener('touchstart', firstGestureLock, { once: true });
};

    enforceLandscape();

    const controlMeta = {
    'left-shoulders': { type: 'trigger', groupId: 'shoulders' },
    'right-shoulders': { type: 'trigger', groupId: 'shoulders' },
    'left-stick': { type: 'joystick', groupId: 'left-stick' },
    'right-stick': { type: 'joystick', groupId: 'right-stick' },
    'dpad': { type: 'dpad', groupId: 'dpad' },
    'face-buttons': { type: 'button-group', groupId: 'face-buttons' },
    'system-buttons': { type: 'button-group', groupId: 'system-buttons' },
    'home-button': { type: 'button-group', groupId: 'system-buttons' },
};

    const controlGroups = {
    shoulders: ['left-shoulders', 'right-shoulders'],
    'left-stick': ['left-stick'],
    'right-stick': ['right-stick'],
    dpad: ['dpad'],
    'face-buttons': ['face-buttons'],
    'system-buttons': ['system-buttons'],
    'home-button': ['home-button'],
};

    const templateStorageKey = 'webcontroller-layout-templates-v7';
    const defaultTemplateName = 'Default';
    const immutableTemplates = new Set([defaultTemplateName]);
    const defaultTemplateUrl = '/static/default-template.json';
    let bundledTemplates = null;
    const defaultTemplateNames = ['Default', 'Minimal'];
    const deepClone = (value) => JSON.parse(JSON.stringify(value));

    let templates = {};
    let currentTemplate = defaultTemplateNames[0];
    let layoutState = {};
    let isEditMode = false;
    let selectedControlId = null;
    let selectedGroupId = null;
    let selectionMode = 'single'; // 'single' or 'group'
    let pointerInfo = null;
    let longPressTimeout = null;


    const loadTemplates = () => {
    try {
    const stored = localStorage.getItem(templateStorageKey);
    if (!stored) return null;
    return JSON.parse(stored);
} catch (error) {
    console.warn('Failed to load templates:', error);
    return null;
}
};

    const loadBundledTemplates = async () => {
    try {
    const res = await fetch(defaultTemplateUrl, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
} catch (error) {
    console.warn('Failed to load bundled templates:', error);
    return null;
}
};

    const saveTemplates = () => {
    localStorage.setItem(templateStorageKey, JSON.stringify({
        templates,
        currentTemplate,
    }));
};

    const captureDefaultLayout = (el, target) => {
    const id = el.dataset.layoutId;
    if (!id) return;

    const panel = el.closest('.panel');
    if (!panel) return;

    const panelRect = panel.getBoundingClientRect();
    const rect = el.getBoundingClientRect();

    const x = (rect.left - panelRect.left) / panelRect.width;
    const y = (rect.top - panelRect.top) / panelRect.height;
    const width = rect.width / panelRect.width;
    const height = rect.height / panelRect.height;

    target[id] = {
    id,
    type: controlMeta[id]?.type || 'unknown',
    groupId: controlMeta[id]?.groupId || null,
    x: parseFloat(x.toFixed(4)),
    y: parseFloat(y.toFixed(4)),
    width: parseFloat(width.toFixed(4)),
    height: parseFloat(height.toFixed(4)),
    visible: true,
};
};

    const createDefaultTemplates = () => {
    const base = {};
    document.querySelectorAll('.editable').forEach((el) => captureDefaultLayout(el, base));

    const minimal = deepClone(base);
    Object.values(minimal).forEach((info) => {
    info.width = Math.max(48, Math.round(info.width * 0.72));
    info.height = Math.max(48, Math.round(info.height * 0.72));
    info.x = Math.max(0, Math.round(info.x + 8));
    info.y = Math.max(0, Math.round(info.y + 8));
});

    templates = {
    [defaultTemplateNames[0]]: base,
    [defaultTemplateNames[1]]: minimal,
};

    currentTemplate = defaultTemplateNames[0];
    saveTemplates();
};

    const applyLayout = (el) => {
    const id = el.dataset.layoutId;
    if (!id) return;
    let info = layoutState[id];
    if (!info) {
    return;
}

    const panel = el.closest('.panel');
    if (!panel) return;
    const panelRect = panel.getBoundingClientRect();

    // Backfill old-style px values (if any) so existing data remains compatible
    if (info.width > 1 || info.height > 1 || info.x > 1 || info.y > 1) {
    info = {
    ...info,
    x: info.x / panelRect.width,
    y: info.y / panelRect.height,
    width: info.width / panelRect.width,
    height: info.height / panelRect.height,
};
    layoutState[id] = info;
}

    const xPx = clamp(info.x * panelRect.width, 0, panelRect.width - (info.width * panelRect.width || 1));
    const yPx = clamp(info.y * panelRect.height, 0, panelRect.height - (info.height * panelRect.height || 1));
    let wPx = clamp(info.width * panelRect.width, 48, panelRect.width);
    let hPx = clamp(info.height * panelRect.height, 48, panelRect.height);

    // Keep joysticks and dpad square to avoid stretch on orientation changes
    if (controlMeta[id]?.type === 'joystick') {
    const size = Math.min(wPx, hPx);
    wPx = size;
    hPx = size;
}

    if (id === 'dpad') {
    const size = clamp(Math.min(wPx, hPx), 90, panelRect.width * 0.32);
    wPx = size;
    hPx = size;
}

    el.style.position = 'absolute';
    el.style.left = `${xPx}px`;
    el.style.top = `${yPx}px`;
    el.style.width = `${wPx}px`;
    el.style.height = `${hPx}px`;

    // Persist scaled values as percentage (use panel height for height so square
    // elements stay square across aspect ratios)
    info.x = parseFloat((xPx / panelRect.width).toFixed(4));
    info.y = parseFloat((yPx / panelRect.height).toFixed(4));
    info.width = parseFloat((wPx / panelRect.width).toFixed(4));
    info.height = parseFloat((hPx / panelRect.height).toFixed(4));
    layoutState[id] = info;

    if (info.visible === false) {
    el.classList.add('hidden');
} else {
    el.classList.remove('hidden');
}
};

    const applyLayoutToAll = () => {
    document.querySelectorAll('.editable').forEach((el) => {
        if (!layoutState[el.dataset.layoutId]) captureDefaultLayout(el, layoutState);
        applyLayout(el);
    });
};

    const setCurrentTemplate = (templateName) => {
    if (!templates[templateName]) return;
    currentTemplate = templateName;
    layoutState = deepClone(templates[templateName]);
    applyLayoutToAll();
    updateTemplateSelect();
    saveTemplates();
};

    const updateTemplateSelect = () => {
    const select = document.getElementById('template-select-settings');
    if (!select) return; // Safety check

    const current = select.value;
    select.innerHTML = '';

    Object.keys(templates).forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
});

    select.value = currentTemplate;
};

    const createTemplate = (name) => {
    templates[name] = deepClone(layoutState);
    setCurrentTemplate(name);
};

    const deleteTemplate = (name) => {
    if (!templates[name]) return;
    if (immutableTemplates.has(name)) {
    showToast('Default template cannot be deleted', 2500, true);
    return;
}
    delete templates[name];
    const next = Object.keys(templates)[0];
    setCurrentTemplate(next);
};

    const resetLayout = () => {
    setCurrentTemplate(currentTemplate);
};

    const exportLayout = () => {
    const exportData = {
    timestamp: new Date().toISOString(),
    templateName: currentTemplate,
    templates: templates,
};

    const dataStr = JSON.stringify(exportData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `webcontroller-layout-${currentTemplate.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    triggerHaptic(30);
};

    const importLayout = (file) => {
    if (!file || !file.name.endsWith('.json')) {
    alert('Please select a valid JSON file');
    triggerHaptic(50);
    return;
}

    const reader = new FileReader();
    reader.onload = (e) => {
    try {
    const importedData = JSON.parse(e.target.result);

    if (!importedData.templates || typeof importedData.templates !== 'object') {
    alert('Invalid layout file format');
    triggerHaptic(50);
    return;
}

    // Merge imported templates with existing ones
    const importCount = Object.keys(importedData.templates).length;
    Object.assign(templates, importedData.templates);

    // Switch to first imported template if available
    if (importedData.templateName && templates[importedData.templateName]) {
    setCurrentTemplate(importedData.templateName);
} else {
    const firstTemplate = Object.keys(templates)[0];
    setCurrentTemplate(firstTemplate);
}

    updateTemplateSelect();
    saveTemplates();

    alert(`Successfully imported ${importCount} template(s)!`);
    triggerHaptic(40);
} catch (error) {
    console.error('Failed to import layout:', error);
    alert('Failed to import layout. Please check the file format.');
    triggerHaptic(50);
}
};

    reader.onerror = () => {
    alert('Failed to read file');
    triggerHaptic(50);
};

    reader.readAsText(file);
};

    const setEditMode = (on) => {
    if (on && immutableTemplates.has(currentTemplate)) {
    showToast('Default template is locked. Create a new template to edit.', 3000, true);
    return;
}
    isEditMode = on;
    document.body.classList.toggle('editing', on);
    const editButton = document.getElementById('edit-mode-btn');
    if (editButton) {
    editButton.textContent = on ? 'Disable Edit Mode' : 'Enable Edit Mode';
}

    const editableEls = Array.from(document.querySelectorAll('.editable'));

    if (on) {
    addGlobalEditListeners();
    editableEls.forEach((el) => {
    if (!layoutState[el.dataset.layoutId]) captureDefaultLayout(el, layoutState);
    applyLayout(el);
    makeEditable(el);
});
} else {
    removeGlobalEditListeners();
    editableEls.forEach((el) => teardownEditable(el));
    if (!immutableTemplates.has(currentTemplate)) {
    templates[currentTemplate] = deepClone(layoutState);
    saveTemplates();
}
}
};

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    const getControlState = (id) => layoutState[id];
    const setControlState = (id, state) => {
    layoutState[id] = { ...layoutState[id], ...state };
};

    const getSelectedIds = () => {
    if (selectionMode === 'group' && selectedGroupId && controlGroups[selectedGroupId]) {
    return controlGroups[selectedGroupId];
}
    if (selectedControlId) return [selectedControlId];
    return [];
};

    const updateSelectionVisuals = () => {
    document.querySelectorAll('.editable').forEach((el) => {
        const id = el.dataset.layoutId;
        const selected = getSelectedIds().includes(id);
        el.classList.toggle('selected', selected);

        const handle = el.querySelector('.resize-handle');
        if (handle) {
            handle.classList.toggle('active', selected);
        }
    });
};

    const setSelection = (id, group = false) => {
    if (!id) return;
    selectedControlId = id;
    selectedGroupId = group ? controlMeta[id]?.groupId : null;
    selectionMode = group ? 'group' : 'single';
    updateSelectionVisuals();
};

    const clearSelection = () => {
    selectedControlId = null;
    selectedGroupId = null;
    selectionMode = 'single';
    updateSelectionVisuals();
};

    const pointerState = {
    active: false,
    mode: null, // 'drag' | 'resize'
    startX: 0,
    startY: 0,
    initialLayout: {},
    targetIds: [],
    groupAnchor: null,
    longPressId: null,
    dragStartThresholdReached: false,
    initialTimestamp: 0,
};

    const DRAG_DELAY_MS = 100;
    const LONG_PRESS_MS = 450;
    const DRAG_THRESHOLD = 6;

    const getPanelElements = (id) => {
    const el = document.querySelector(`[data-layout-id="${id}"]`);
    return el;
};

    const getGroupBounds = (ids, panelRect) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach((id) => {
    const state = getControlState(id);
    if (!state) return;
    const xPx = state.x * panelRect.width;
    const yPx = state.y * panelRect.height;
    const wPx = state.width * panelRect.width;
    const hPx = state.height * panelRect.height;
    minX = Math.min(minX, xPx);
    minY = Math.min(minY, yPx);
    maxX = Math.max(maxX, xPx + wPx);
    maxY = Math.max(maxY, yPx + hPx);
});
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

    const startInteraction = (e, elementId, mode) => {
    if (!isEditMode) return;
    if (pointerState.active) return;

    const panel = getPanelElements(elementId)?.closest('.panel');
    if (!panel) return;

    const panelRect = panel.getBoundingClientRect();
    const ids = getSelectedIds().length ? getSelectedIds() : [elementId];

    pointerState.active = true;
    pointerState.mode = mode;
    pointerState.startX = e.clientX;
    pointerState.startY = e.clientY;
    pointerState.initialTimestamp = performance.now();
    pointerState.dragStartThresholdReached = false;
    pointerState.targetIds = ids;
    pointerState.groupAnchor = getGroupBounds(ids, panelRect);

    pointerState.initialLayout = ids.reduce((acc, id) => {
    const st = getControlState(id) || {};
    acc[id] = { ...st };
    return acc;
}, {});

    pointerState.longPressId = setTimeout(() => {
    pointerState.longPressId = null;
    if (controlMeta[elementId]?.groupId) {
    setSelection(elementId, true);
}
}, LONG_PRESS_MS);
};

    const handlePointerMove = (e) => {
    if (!pointerState.active) return;
    const dx = e.clientX - pointerState.startX;
    const dy = e.clientY - pointerState.startY;

    if (!pointerState.dragStartThresholdReached) {
    const elapsed = performance.now() - pointerState.initialTimestamp;
    if (elapsed < DRAG_DELAY_MS || Math.hypot(dx, dy) < DRAG_THRESHOLD) {
    return;
}
    pointerState.dragStartThresholdReached = true;
}

    if (pointerState.longPressId) {
    clearTimeout(pointerState.longPressId);
    pointerState.longPressId = null;
}

    if (pointerState.mode === 'drag') {
    const ids = pointerState.targetIds;
    const basePanel = getPanelElements(ids[0]).closest('.panel');
    if (!basePanel) return;

    const panelRect = basePanel.getBoundingClientRect();

    ids.forEach((id) => {
    const original = pointerState.initialLayout[id];
    if (!original) return;

    const newX = clamp((original.x * panelRect.width + dx), 0, panelRect.width - original.width * panelRect.width);
    const newY = clamp((original.y * panelRect.height + dy), 0, panelRect.height - original.height * panelRect.height);

    const updatedState = {
    ...original,
    x: parseFloat((newX / panelRect.width).toFixed(4)),
    y: parseFloat((newY / panelRect.height).toFixed(4)),
};

    setControlState(id, updatedState);
    const el = getPanelElements(id);
    if (el) {
    el.style.left = `${newX}px`;
    el.style.top = `${newY}px`;
}
});
}

    if (pointerState.mode === 'resize') {
    const ids = pointerState.targetIds;
    const basePanel = getPanelElements(ids[0]).closest('.panel');
    if (!basePanel) return;

    const panelRect = basePanel.getBoundingClientRect();
    const groupBounds = pointerState.groupAnchor;
    const diagonal = Math.max(groupBounds.width, groupBounds.height);
    const delta = Math.max(dx, dy);
    const scale = clamp((diagonal + delta) / diagonal, 0.4, 3.0);

    ids.forEach((id) => {
    const original = pointerState.initialLayout[id];
    if (!original) return;

    let newWidth = original.width * scale;
    let newHeight = original.height * scale;

    const type = controlMeta[id]?.type;
    if (type === 'joystick' || type === 'trigger' || type === 'button-group') {
    const ratio = original.width / original.height || 1;
    newHeight = newWidth / ratio;
}

    // Convert to px, scale position around groupTopLeft
    const origXpx = original.x * panelRect.width;
    const origYpx = original.y * panelRect.height;
    const relativeX = origXpx - groupBounds.x;
    const relativeY = origYpx - groupBounds.y;

    const newXpx = clamp(groupBounds.x + relativeX * scale, 0, panelRect.width - newWidth * panelRect.width);
    const newYpx = clamp(groupBounds.y + relativeY * scale, 0, panelRect.height - newHeight * panelRect.height);

    const relativeWidth = clamp(newWidth, 48 / panelRect.width, 1);
    const relativeHeight = clamp(newHeight, 48 / panelRect.height, 1);

    const updatedState = {
    ...original,
    x: parseFloat((newXpx / panelRect.width).toFixed(4)),
    y: parseFloat((newYpx / panelRect.height).toFixed(4)),
    width: parseFloat(relativeWidth.toFixed(4)),
    height: parseFloat(relativeHeight.toFixed(4)),
};

    setControlState(id, updatedState);
    const el = getPanelElements(id);
    if (el) {
    el.style.left = `${updatedState.x * panelRect.width}px`;
    el.style.top = `${updatedState.y * panelRect.height}px`;
    el.style.width = `${updatedState.width * panelRect.width}px`;
    el.style.height = `${updatedState.height * panelRect.height}px`;
}
});
}

    e.preventDefault();
};

    const endInteraction = () => {
    if (pointerState.longPressId) {
    clearTimeout(pointerState.longPressId);
    pointerState.longPressId = null;
}

    if (pointerState.active) {
    if (!immutableTemplates.has(currentTemplate)) {
    templates[currentTemplate] = deepClone(layoutState);
    saveTemplates();
}
}

    pointerState.active = false;
    pointerState.mode = null;
    pointerState.targetIds = [];
    pointerState.initialLayout = {};
    pointerState.groupAnchor = null;
    pointerState.dragStartThresholdReached = false;
};

    const addGlobalEditListeners = () => {
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', endInteraction, { passive: false });
    window.addEventListener('pointercancel', endInteraction, { passive: false });
    document.body.style.overscrollBehavior = 'none';
    document.body.style.touchAction = 'none';
};

    const removeGlobalEditListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', endInteraction);
    window.removeEventListener('pointercancel', endInteraction);
    document.body.style.overscrollBehavior = '';
    document.body.style.touchAction = '';
};

    const makeEditable = (el) => {
    const id = el.dataset.layoutId;
    if (!id) return;

    if (!el.querySelector('.visibility-toggle')) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'visibility-toggle';
    toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const info = layoutState[id] || {};
    info.visible = !info.visible;
    layoutState[id] = info;
    el.classList.toggle('hidden', !info.visible);
        syncVisibilityCheckboxes()
        console.log("visibilty sync")
    if (!immutableTemplates.has(currentTemplate)) {
    templates[currentTemplate] = deepClone(layoutState);
    saveTemplates();
}
});
    el.appendChild(toggle);

}

    if (!el.querySelector('.resize-handle')) {
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    el.appendChild(handle);

    const onResizeStart = (e) => {
    if (!isEditMode) return;
    e.stopPropagation();
    e.preventDefault();

    const selectedIds = getSelectedIds();
    if (!selectedIds.includes(id)) {
    setSelection(id, false);
}

    startInteraction(e, id, 'resize');
    el.classList.add('resizing');
};

    handle.addEventListener('pointerdown', onResizeStart, { passive: false });
    el._resizeHandlers = { onResizeStart };
}

    const onDragStart = (e) => {

    if (!isEditMode) return;

    if (e.target.classList.contains('resize-handle') || e.target.classList.contains('visibility-toggle')) return;

    e.preventDefault();
    e.stopPropagation();

    if (!selectedControlId || selectedControlId !== id) {
    setSelection(id, false);
}

    startInteraction(e, id, 'drag');
    el.classList.add('dragging');
};

    el.addEventListener('pointerdown', onDragStart, { passive: false });
    el._editHandlers = { onDragStart };
};

    const teardownEditable = (el) => {
    el.classList.remove('dragging', 'resizing');
    el.classList.remove('selected');

    if (el._editHandlers) {
    el.removeEventListener('pointerdown', el._editHandlers.onDragStart);
    delete el._editHandlers;
}

    if (el._resizeHandlers) {
    const handle = el.querySelector('.resize-handle');
    if (handle) handle.removeEventListener('pointerdown', el._resizeHandlers.onResizeStart);
    delete el._resizeHandlers;
}

    const handle = el.querySelector('.resize-handle');
    if (handle) handle.remove();

    const toggle = el.querySelector('.visibility-toggle');
    if (toggle) {
        toggle.remove();

    }
};

    const buttonMap = {
    A: 'A',
    B: 'B',
    X: 'X',
    Y: 'Y',
    L1: 'LB',
    R1: 'RB',
    Select: 'SELECT',
    Start: 'START',
    Home: 'HOME',
};

    const triggerMap = {
    L2: 'LT',
    R2: 'RT',
};

    const RATE_LIMIT = 16;
    const activeInputs = {};
    const lastState = {};
    let dpadState = { x: 0, y: 0 };

    const ensureInput = (key) => {
    if (!activeInputs[key]) {
    activeInputs[key] = { running: false, rafId: null, lastSent: 0 };
}
};

    const startLoop = (key, callback) => {
    ensureInput(key);
    if (activeInputs[key].running) return;
    activeInputs[key].running = true;

    const loop = () => {
    if (!activeInputs[key]?.running) return;
    callback();
    activeInputs[key].rafId = requestAnimationFrame(loop);
};

    loop();
};

    const stopLoop = (key, onStop) => {
    if (!activeInputs[key]) return;
    activeInputs[key].running = false;
    if (activeInputs[key].rafId) {
    cancelAnimationFrame(activeInputs[key].rafId);
}
    if (onStop) onStop();
    delete activeInputs[key];
};

    const emitButton = (button, state) => {
    if (isEditMode) return;
    const mapped = buttonMap[button] || button;
    const now = performance.now();
    ensureInput(button);
    const lastTime = activeInputs[button].lastSent;
    if (lastState[button] === state && now - lastTime < RATE_LIMIT) return;
    lastState[button] = state;
    activeInputs[button].lastSent = now;
    socket.emit('button', { button: mapped, state });
    triggerHaptic(state ? 20 : 10);
};

    const emitTrigger = (button, value) => {
    if (isEditMode) return;
    socket.emit('trigger', { trigger: triggerMap[button], value });
    triggerHaptic(value ? 20 : 10);
};

    const emitDpad = (x, y) => {
    const now = performance.now();
    const last = lastState.DPAD;
    ensureInput('DPAD');
    const lastTime = activeInputs.DPAD.lastSent;
    if (last && last.x === x && last.y === y && now - lastTime < RATE_LIMIT) return;
    lastState.DPAD = { x, y };
    activeInputs.DPAD.lastSent = now;
    socket.emit('dpad', { x, y });
};

    const pressButton = (button) => {
    if (triggerMap[button]) {
    emitTrigger(button, 1);
    return;
}
    startLoop(button, () => emitButton(button, 1));
};

    const releaseButton = (button) => {
    if (triggerMap[button]) {
    emitTrigger(button, 0);
    return;
}
    stopLoop(button, () => emitButton(button, 0));
};

    // Haptic feedback utility
    const triggerHaptic = (duration = 20) => {
    if (navigator.vibrate) {
    navigator.vibrate(duration);
} else if (navigator.webkitVibrate) {
    navigator.webkitVibrate(duration);
}
};

    const buttonEls = Array.from(document.querySelectorAll('.btn[data-button]'))
    .filter((el) =>
    !el.closest('[data-layout-id="dpad"]') &&
    !el.closest('[data-layout-id="face-buttons"]') &&
    !el.closest('[data-layout-id="left-shoulders"]') &&
    !el.closest('[data-layout-id="right-shoulders"]')
    );

    buttonEls.forEach((el) => {
    const button = el.dataset.button;

    const setActive = (active) => {
    el.classList.toggle('active', active);
};

    const press = () => {
    setActive(true);
    pressButton(button);
};
    const release = () => {
    setActive(false);
    releaseButton(button);
};

    el.addEventListener('touchstart', (e) => {
    if (isControllerDisabled()) return;
    e.preventDefault();
    press();
}, { passive: false });

    el.addEventListener('touchend', (e) => {
    if (isControllerDisabled()) return;
    e.preventDefault();
    release();
}, { passive: false });
    el.addEventListener('touchcancel', () => {
    if (isControllerDisabled()) return;
    release();
}, { passive: true });

    // Mouse support for quick desktop testing
    el.addEventListener('mousedown', (e) => {
    if (isControllerDisabled()) return;
    e.preventDefault();
    press();
});

    el.addEventListener('mouseup', (e) => {
    if (isControllerDisabled()) return;
    e.preventDefault();
    release();
});
    el.addEventListener('mouseleave', () => {
    if (isControllerDisabled()) return;
    release();
});
});

    // D-pad slide support (drag across buttons to change direction)
    (() => {
    const dpad = document.querySelector('[data-layout-id="dpad"]');
    if (!dpad) return;

    let activeTouchId = null;
    let activeBtn = null;
    const startDpad = () => startLoop('DPAD', () => emitDpad(dpadState.x, dpadState.y));
    const stopDpad = () => stopLoop('DPAD', () => emitDpad(0, 0));

    const dirForBtn = (btn) => {
    if (!btn) return { x: 0, y: 0 };
    const name = btn.dataset.button;
    if (name === 'Left') return { x: -1, y: 0 };
    if (name === 'Right') return { x: 1, y: 0 };
    if (name === 'Up') return { x: 0, y: -1 };
    if (name === 'Down') return { x: 0, y: 1 };
    return { x: 0, y: 0 };
};

    const setBtn = (btnEl) => {
    if (btnEl === activeBtn) return;
    if (activeBtn) {
    activeBtn.classList.remove('active');
}
    activeBtn = btnEl;
    if (activeBtn) {
    activeBtn.classList.add('active');
}
    const { x, y } = dirForBtn(activeBtn);
    dpadState = { x, y };
    if (activeBtn) {
    startDpad();
    emitDpad(dpadState.x, dpadState.y);
} else {
    stopDpad();
}
};

    const buttonFromPoint = (clientX, clientY) => {
    const target = document.elementFromPoint(clientX, clientY);
    if (target && target.dataset && target.dataset.button && target.closest('[data-layout-id="dpad"]')) {
    return target;
}
    return null;
};

    const endCurrent = () => {
    if (activeBtn) activeBtn.classList.remove('active');
    activeBtn = null;
    dpadState = { x: 0, y: 0 };
    stopDpad();
    activeTouchId = null;
};

    dpad.addEventListener('touchstart', (e) => {
    if (isControllerDisabled()) return;
    const t = e.changedTouches[0];
    activeTouchId = t.identifier;
    const btn = buttonFromPoint(t.clientX, t.clientY);
    setBtn(btn);
    e.preventDefault();
}, { passive: false });

    dpad.addEventListener('touchmove', (e) => {
    if (activeTouchId === null || isControllerDisabled()) return;
    const touch = Array.from(e.touches).find((t) => t.identifier === activeTouchId);
    if (!touch) return;
    const btn = buttonFromPoint(touch.clientX, touch.clientY);
    setBtn(btn);
    e.preventDefault();
}, { passive: false });

    dpad.addEventListener('touchend', (e) => {
    if (activeTouchId === null || isControllerDisabled()) return;
    const touch = Array.from(e.changedTouches).find((t) => t.identifier === activeTouchId);
    if (!touch) return;
    endCurrent();
    e.preventDefault();
}, { passive: false });

    dpad.addEventListener('touchcancel', () => {
    endCurrent();
});

    // Mouse drag support
    let mouseDown = false;
    dpad.addEventListener('mousedown', (e) => {
    if (isControllerDisabled()) return;
    mouseDown = true;
    setBtn(buttonFromPoint(e.clientX, e.clientY));
});

    window.addEventListener('mousemove', (e) => {
    if (!mouseDown || isControllerDisabled()) return;
    setBtn(buttonFromPoint(e.clientX, e.clientY));
});

    window.addEventListener('mouseup', () => {
    if (!mouseDown) return;
    mouseDown = false;
    endCurrent();
});
})();

    // Face buttons slide support (drag across A/B/X/Y)
    (() => {
    const face = document.querySelector('[data-layout-id="face-buttons"]');
    if (!face) return;

    let activeTouchId = null;
    let activeBtn = null;
    let mouseDown = false;

    const setBtn = (btnEl) => {
    if (btnEl === activeBtn) return;
    if (activeBtn) {
    activeBtn.classList.remove('active');
    releaseButton(activeBtn.dataset.button);
}
    if (btnEl) {
    activeBtn = btnEl;
    activeBtn.classList.add('active');
    pressButton(activeBtn.dataset.button);
} else {
    activeBtn = null;
}
};

    const buttonFromPoint = (clientX, clientY) => {
    const target = document.elementFromPoint(clientX, clientY);
    if (target && target.dataset && target.dataset.button && target.closest('[data-layout-id="face-buttons"]')) {
    return target;
}
    return null;
};

    const endCurrent = () => {
    if (activeBtn) {
    activeBtn.classList.remove('active');
    releaseButton(activeBtn.dataset.button);
    activeBtn = null;
}
    activeTouchId = null;
};

    face.addEventListener('touchstart', (e) => {
    if (isControllerDisabled()) return;
    const t = e.changedTouches[0];
    activeTouchId = t.identifier;
    setBtn(buttonFromPoint(t.clientX, t.clientY));
    e.preventDefault();
}, { passive: false });

    face.addEventListener('touchmove', (e) => {
    if (activeTouchId === null || isControllerDisabled()) return;
    const touch = Array.from(e.touches).find((t) => t.identifier === activeTouchId);
    if (!touch) return;
    setBtn(buttonFromPoint(touch.clientX, touch.clientY));
    e.preventDefault();
}, { passive: false });

    face.addEventListener('touchend', (e) => {
    if (activeTouchId === null || isControllerDisabled()) return;
    const touch = Array.from(e.changedTouches).find((t) => t.identifier === activeTouchId);
    if (!touch) return;
    endCurrent();
    e.preventDefault();
}, { passive: false });

    face.addEventListener('touchcancel', () => endCurrent());

    face.addEventListener('mousedown', (e) => {
    if (isControllerDisabled()) return;
    mouseDown = true;
    setBtn(buttonFromPoint(e.clientX, e.clientY));
});

    window.addEventListener('mousemove', (e) => {
    if (!mouseDown || isControllerDisabled()) return;
    setBtn(buttonFromPoint(e.clientX, e.clientY));
});

    window.addEventListener('mouseup', () => {
    if (!mouseDown) return;
    mouseDown = false;
    endCurrent();
});
})();

    // Shoulder buttons slide support (LT/LB and RT/RB)
    (() => {
    const left = document.querySelector('[data-layout-id="left-shoulders"]');
    const right = document.querySelector('[data-layout-id="right-shoulders"]');
    const groups = [left, right].filter(Boolean);
    if (!groups.length) return;

    groups.forEach((groupEl) => {
    let activeTouchId = null;
    let activeBtn = null;
    let mouseDown = false;

    const setBtn = (btnEl) => {
    if (btnEl === activeBtn) return;
    if (activeBtn) {
    activeBtn.classList.remove('active');
    releaseButton(activeBtn.dataset.button);
}
    if (btnEl) {
    activeBtn = btnEl;
    activeBtn.classList.add('active');
    pressButton(activeBtn.dataset.button);
} else {
    activeBtn = null;
}
};

    const buttonFromPoint = (clientX, clientY) => {
    const target = document.elementFromPoint(clientX, clientY);
    if (target && target.dataset && target.dataset.button && target.closest(`[data-layout-id="${groupEl.dataset.layoutId}"]`)) {
    return target;
}
    return null;
};

    const endCurrent = () => {
    if (activeBtn) {
    activeBtn.classList.remove('active');
    releaseButton(activeBtn.dataset.button);
    activeBtn = null;
}
    activeTouchId = null;
};

    groupEl.addEventListener('touchstart', (e) => {
    if (isControllerDisabled()) return;
    const t = e.changedTouches[0];
    activeTouchId = t.identifier;
    setBtn(buttonFromPoint(t.clientX, t.clientY));
    e.preventDefault();
}, { passive: false });

    groupEl.addEventListener('touchmove', (e) => {
    if (activeTouchId === null || isControllerDisabled()) return;
    const touch = Array.from(e.touches).find((t) => t.identifier === activeTouchId);
    if (!touch) return;
    setBtn(buttonFromPoint(touch.clientX, touch.clientY));
    e.preventDefault();
}, { passive: false });

    groupEl.addEventListener('touchend', (e) => {
    if (activeTouchId === null || isControllerDisabled()) return;
    const touch = Array.from(e.changedTouches).find((t) => t.identifier === activeTouchId);
    if (!touch) return;
    endCurrent();
    e.preventDefault();
}, { passive: false });

    groupEl.addEventListener('touchcancel', () => endCurrent());

    groupEl.addEventListener('mousedown', (e) => {
    if (isControllerDisabled()) return;
    mouseDown = true;
    setBtn(buttonFromPoint(e.clientX, e.clientY));
});

    window.addEventListener('mousemove', (e) => {
    if (!mouseDown || isControllerDisabled()) return;
    setBtn(buttonFromPoint(e.clientX, e.clientY));
});

    window.addEventListener('mouseup', () => {
    if (!mouseDown) return;
    mouseDown = false;
    endCurrent();
});
});
})();

    function setupStick(stickId, thumbId, joystickId) {
    const stick = document.getElementById(stickId);
    const thumb = document.getElementById(thumbId);
    let active = false;
    let activeTouchId = null;
    let rect = null;
    let animFrameId = null;
    let lastEmitTime = 0;
    const emitDebounceMs = 8; // ~120fps - snappier response
    let pendingUpdate = null;

    const normalize = (x, y) => {
    const magnitude = Math.hypot(x, y);
    if (magnitude === 0) return { x: 0, y: 0 };
    const max = Math.min(magnitude, 1);
    const ratio = max / magnitude;
    return { x: x * ratio, y: y * ratio };
};

    const applyThumbTransform = (x, y) => {
    const translateX = x * 42;
    const translateY = y * 42;
    thumb.style.transform = `translate(calc(-50% + ${translateX}px), calc(-50% + ${translateY}px))`;
};

    const emitJoystick = (x, y) => {
    const now = performance.now();
    if (now - lastEmitTime >= emitDebounceMs) {
    socket.emit('joystick', { stick: joystickId, x, y });
    lastEmitTime = now;
    // Light haptic feedback for significant movement
    if ((Math.abs(x) > 0.5 || Math.abs(y) > 0.5) && active) {
    triggerHaptic(5);
}
}
};

    const updateFrame = (clientX, clientY) => {
    if (!rect) return;
    const dx = (clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    const dy = (clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
    const { x, y } = normalize(dx, dy);

    // Update thumb position immediately in requestAnimationFrame
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = requestAnimationFrame(() => {
    applyThumbTransform(x, y);
    emitJoystick(x, y);
});
};

    const reset = () => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    thumb.style.transform = 'translate(-50%, -50%)';
    socket.emit('joystick', { stick: joystickId, x: 0, y: 0 });
    triggerHaptic(10);
};

    const start = (clientX, clientY) => {
    active = true;
    rect = stick.getBoundingClientRect();
    lastEmitTime = 0;
    updateFrame(clientX, clientY);
};

    const findTouch = (touchList) => {
    if (activeTouchId === null) return null;
    for (let i = 0; i < touchList.length; i += 1) {
    if (touchList[i].identifier === activeTouchId) return touchList[i];
}
    return null;
};

    stick.addEventListener('touchstart', (e) => {
    if (isControllerDisabled()) return;
    const t = e.changedTouches[0];
    activeTouchId = t.identifier;
    e.preventDefault();
    start(t.clientX, t.clientY);
}, { passive: false });

    stick.addEventListener('touchmove', (e) => {
    if (!active || isControllerDisabled()) return;
    const t = findTouch(e.touches);
    if (!t) return;
    e.preventDefault();
    updateFrame(t.clientX, t.clientY);
}, { passive: false });

    stick.addEventListener('touchend', (e) => {
    if (!active || isControllerDisabled()) return;
    const t = findTouch(e.changedTouches);
    if (!t) return;
    active = false;
    activeTouchId = null;
    reset();
}, { passive: false });

    // Mouse support for desktop testing
    stick.addEventListener('mousedown', (e) => {
    if (isControllerDisabled()) return;
    e.preventDefault();
    start(e.clientX, e.clientY);
});

    window.addEventListener('mousemove', (e) => {
    if (!active || isControllerDisabled()) return;
    updateFrame(e.clientX, e.clientY);
});

    window.addEventListener('mouseup', () => {
    if (!active || isControllerDisabled()) return;
    active = false;
    reset();
});
}

    setupStick('left-stick', 'left-thumb', 'left');
    setupStick('right-stick', 'right-thumb', 'right');

    // ============================================
    // SETTINGS PANEL & UI ENHANCEMENTS
    // ============================================

    // Toast notification system
    const showToast = (message, duration = 3000, isError = false) => {
    let toast = document.getElementById('toast');
    if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
}

    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');

    if (toast.timeoutId) clearTimeout(toast.timeoutId);
    toast.timeoutId = setTimeout(() => {
    toast.classList.remove('show');
}, duration);
};

    // Settings panel open/close
    let settingsPanelOpen = false;
    const settingsPanel = document.getElementById('settings-panel');
    const settingsOverlay = document.getElementById('settings-overlay');
    const hamburgerMenu = document.getElementById('hamburger-menu');
    const settingsClose = document.getElementById('settings-close');
    const fullscreenBtn = document.getElementById('fullscreen-toggle-btn');

    const openSettingsPanel = () => {
    settingsPanelOpen = true;
    settingsPanel.classList.add('open');
    settingsOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    triggerHaptic(15);
};

    const closeSettingsPanel = () => {
    settingsPanelOpen = false;
    settingsPanel.classList.remove('open');
    settingsOverlay.classList.remove('active');
    document.body.style.overflow = '';
    triggerHaptic(10);
};

    hamburgerMenu.addEventListener('click', openSettingsPanel);
    settingsClose.addEventListener('click', closeSettingsPanel);
    settingsOverlay.addEventListener('click', closeSettingsPanel);

    // Prevent settings panel clicks from closing it
    settingsPanel.addEventListener('click', (e) => e.stopPropagation());

    // Disable controller when settings is open
    const isControllerDisabled = () => settingsPanelOpen || isEditMode;

    const fullscreenElement = () =>
    document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;

    const enterFullscreen = async () => {
    const target = document.documentElement;
    if (target.requestFullscreen) return target.requestFullscreen();
    if (target.webkitRequestFullscreen) return target.webkitRequestFullscreen();
    if (target.msRequestFullscreen) return target.msRequestFullscreen();
    throw new Error('Fullscreen API not supported');
};

    const exitFullscreen = async () => {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
    if (document.msExitFullscreen) return document.msExitFullscreen();
    throw new Error('Fullscreen API not supported');
};

    const updateFullscreenButton = () => {
    if (!fullscreenBtn) return;
    const active = Boolean(fullscreenElement());
    fullscreenBtn.textContent = active ? 'Exit Full Screen' : 'Enter Full Screen';
};

    // Map control IDs to visibility checkboxes
    const visibilityCheckboxMap = {
    'left-stick': 'vis-left-stick',
    'right-stick': 'vis-right-stick',
    'dpad': 'vis-dpad',
    'face-buttons': 'vis-face-buttons',
    'left-shoulders': 'vis-shoulders',
    'right-shoulders': 'vis-shoulders',
};

    // Update visibility checkboxes from layout state
    const syncVisibilityCheckboxes = () => {
    Object.entries(visibilityCheckboxMap).forEach(([layoutId, checkboxId]) => {
        const checkbox = document.getElementById(checkboxId);
        if (checkbox) {
            const visible = layoutState[layoutId]?.visible !== false;
            checkbox.checked = visible;
        }
    });
};

    // Handle visibility checkbox changes
    Object.values(visibilityCheckboxMap).forEach((checkboxId) => {
    const checkbox = document.getElementById(checkboxId);
    if (!checkbox) return;

    checkbox.addEventListener('change', () => {
    const visible = checkbox.checked;
    const affectedIds = Object.keys(visibilityCheckboxMap).filter(
    (id) => visibilityCheckboxMap[id] === checkboxId
    );

    affectedIds.forEach((layoutId) => {
    const el = document.querySelector(`[data-layout-id="${layoutId}"]`);
    if (el && layoutState[layoutId]) {
    layoutState[layoutId].visible = visible;
    if (visible) {
    el.classList.remove('hidden');
} else {
    el.classList.add('hidden');
}
}

});

    if (!immutableTemplates.has(currentTemplate)) {
    templates[currentTemplate] = deepClone(layoutState);
    saveTemplates();
}
    showToast(`${checkbox.parentElement.textContent.trim()} ${visible ? 'shown' : 'hidden'}`);
    triggerHaptic(15);
});
});

    // Scale controls setup
    const scaleControlsToSize = (controlSelector, scalePercent) => {
    const elements = document.querySelectorAll(controlSelector);
    elements.forEach((el) => {
    const scale = scalePercent / 100;
    el.style.transform = `scale(${scale})`;
    el.style.transformOrigin = 'center';
});
};

    const setupScaleSlider = (sliderId, valueId, controlSelector, storageKey) => {
    const slider = document.getElementById(sliderId);
    const valueDisplay = document.getElementById(valueId);

    // Load saved value
    const savedValue = localStorage.getItem(storageKey) || '100';
    slider.value = savedValue;
    valueDisplay.textContent = `${savedValue}%`;
    scaleControlsToSize(controlSelector, parseInt(savedValue));

    slider.addEventListener('input', (e) => {
    const value = e.target.value;
    valueDisplay.textContent = `${value}%`;
    localStorage.setItem(storageKey, value);
    scaleControlsToSize(controlSelector, parseInt(value));
    triggerHaptic(10);
});
};

    // setupScaleSlider('button-scale', 'button-scale-value', '.btn[data-button]', 'webcontroller-button-scale');
    setupScaleSlider('button-set-scale', 'button-set-scale-value', '.button-set', 'webcontroller-button-set-scale');
    setupScaleSlider('button-scale', 'button-scale-value', '.face-buttons', 'webcontroller-facebuttons-scale');
    setupScaleSlider('joystick-scale', 'joystick-scale-value', '.stick', 'webcontroller-joystick-scale');
    setupScaleSlider('dpad-scale', 'dpad-scale-value', '.dpad', 'webcontroller-dpad-scale');

    // Fine position adjustment arrows use editor selection
    const selectControl = (layoutId) => {
    setSelection(layoutId, false);
    showToast(`Selected: ${layoutId}`, 2000);
    triggerHaptic(20);
};

    // Make editable elements selectable on click in edit mode
    document.querySelectorAll('.editable').forEach((el) => {
    el.addEventListener('click', (e) => {
        if (isEditMode) {
            e.stopPropagation();
            selectControl(el.dataset.layoutId);
        }
    });
});

    const moveSelectedControl = (dx, dy) => {
    const ids = getSelectedIds();
    if (!ids.length) return;

    ids.forEach((id) => {
    const info = layoutState[id];
    if (!info) return;

    const el = document.querySelector(`[data-layout-id="${id}"]`);
    if (!el) return;

    const panel = el.closest('.panel');
    if (!panel) return;

    const panelRect = panel.getBoundingClientRect();

    const xPx = info.x * panelRect.width;
    const yPx = info.y * panelRect.height;
    const newX = clamp(xPx + dx, 0, panelRect.width - info.width * panelRect.width);
    const newY = clamp(yPx + dy, 0, panelRect.height - info.height * panelRect.height);

    info.x = parseFloat((newX / panelRect.width).toFixed(4));
    info.y = parseFloat((newY / panelRect.height).toFixed(4));

    el.style.left = `${newX}px`;
    el.style.top = `${newY}px`;
});

    if (!immutableTemplates.has(currentTemplate)) {
    templates[currentTemplate] = deepClone(layoutState);
    saveTemplates();
}
    triggerHaptic(10);
};

    const centerAllControls = () => {
    document.querySelectorAll('.editable').forEach((el) => {
        const panel = el.closest('.panel');
        if (!panel) return;

        const panelRect = panel.getBoundingClientRect();
        const layoutId = el.dataset.layoutId;

        const centerX = (panelRect.width - el.offsetWidth) / 2;
        const centerY = (panelRect.height - el.offsetHeight) / 2;

        if (layoutState[layoutId]) {
            layoutState[layoutId].x = parseFloat((centerX / panelRect.width).toFixed(4));
            layoutState[layoutId].y = parseFloat((centerY / panelRect.height).toFixed(4));
        }

        el.style.left = `${centerX}px`;
        el.style.top = `${centerY}px`;
    });

    if (!immutableTemplates.has(currentTemplate)) {
    templates[currentTemplate] = deepClone(layoutState);
    saveTemplates();
}
    showToast('All controls centered');
    triggerHaptic(25);
};

    // Arrow button listeners
    document.getElementById('arrow-up').addEventListener('click', () => moveSelectedControl(0, -10));
    document.getElementById('arrow-down').addEventListener('click', () => moveSelectedControl(0, 10));
    document.getElementById('arrow-left').addEventListener('click', () => moveSelectedControl(-10, 0));
    document.getElementById('arrow-right').addEventListener('click', () => moveSelectedControl(10, 0));
    document.getElementById('arrow-center').addEventListener('click', () => {
    if (selectedControlId && layoutState[selectedControlId]) {
    const el = document.querySelector(`[data-layout-id="${selectedControlId}"]`);
    const panel = el?.closest('.panel');
    if (panel) {
    const panelRect = panel.getBoundingClientRect();
    const centerX = (panelRect.width - el.offsetWidth) / 2;
    const centerY = (panelRect.height - el.offsetHeight) / 2;
    layoutState[selectedControlId].x = centerX;
    layoutState[selectedControlId].y = centerY;
    el.style.left = `${centerX}px`;
    el.style.top = `${centerY}px`;
    if (!immutableTemplates.has(currentTemplate)) {
    templates[currentTemplate] = deepClone(layoutState);
    saveTemplates();
}
    showToast('Control centered');
    triggerHaptic(20);
}
} else {
    showToast('Select a control first', 2000, true);
}
});

    // Settings button handlers
    document.getElementById('save-layout-btn').addEventListener('click', () => {
    if (immutableTemplates.has(currentTemplate)) {
    showToast('Default template is locked. Create a new template to save changes.', 3000, true);
    return;
}
    templates[currentTemplate] = deepClone(layoutState);
    saveTemplates();
    showToast('Layout saved successfully');
    triggerHaptic(25);
});

    document.getElementById('reset-layout-btn').addEventListener('click', () => {
    if (confirm('Reset layout to default? This cannot be undone.')) {
    setCurrentTemplate(defaultTemplateName);
    updateSettingsTemplateSelect();
    syncVisibilityCheckboxes();
    showToast('Switched to locked Default template');
    triggerHaptic(25);
}
});

    document.getElementById('center-controls-btn').addEventListener('click', centerAllControls);

    document.getElementById('edit-mode-btn').addEventListener('click', () => {
    setEditMode(!isEditMode);
    const btn = document.getElementById('edit-mode-btn');
    btn.textContent = isEditMode ? 'Disable Edit Mode' : 'Enable Edit Mode';
    showToast(isEditMode ? 'Edit mode enabled' : 'Edit mode disabled');
    triggerHaptic(30);
});

    const toggleFullscreen = async () => {
    try {
    if (fullscreenElement()) {
    await exitFullscreen();
    showToast('Exited full screen');
} else {
    await enterFullscreen();
    showToast('Entered full screen');
}
    updateFullscreenButton();
    triggerHaptic(20);
} catch (err) {
    console.error('Fullscreen toggle failed:', err);
    showToast('Fullscreen not supported', 3000, true);
}
};

    if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', toggleFullscreen);
}

    ['fullscreenchange', 'webkitfullscreenchange', 'msfullscreenchange'].forEach((evt) => {
    document.addEventListener(evt, updateFullscreenButton);
});

    document.getElementById('new-template-btn').addEventListener('click', () => {
    const name = window.prompt('New template name:', `Template ${Object.keys(templates).length + 1}`);
    if (!name) return;
    if (templates[name] && !window.confirm(`Template "${name}" exists. Overwrite?`)) return;
    createTemplate(name);
    updateSettingsTemplateSelect();
    showToast(`Template "${name}" created`);
    triggerHaptic(25);
});

    document.getElementById('delete-template-btn').addEventListener('click', () => {
    if (Object.keys(templates).length <= 1) {
    showToast('Cannot delete the last template', 3000, true);
    return;
}
    if (confirm(`Delete template "${currentTemplate}"?`)) {
    deleteTemplate(currentTemplate);
    updateSettingsTemplateSelect();
    showToast('Template deleted');
    triggerHaptic(25);
}
});

    document.getElementById('export-layout-btn').addEventListener('click', () => {
    exportLayout();
    showToast('Layout exported');
});

    document.getElementById('import-layout-btn').addEventListener('click', () => {
    document.getElementById('import-file-settings').click();
});

    document.getElementById('import-file-settings').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
    importLayout(e.target.files[0]);
    updateSettingsTemplateSelect();
    e.target.value = '';
}
});

    // Update settings template select
    const updateSettingsTemplateSelect = () => {
    const select = document.getElementById('template-select-settings');
    select.innerHTML = '';
    Object.keys(templates).forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
});
    select.value = currentTemplate;
};

    document.getElementById('template-select-settings').addEventListener('change', (e) => {
    setCurrentTemplate(e.target.value);
    syncVisibilityCheckboxes();
    showToast(`Switched to "${e.target.value}"`);
    triggerHaptic(20);
});

    const initTemplates = async () => {
    const bundled = await loadBundledTemplates();
    if (bundled?.templates) {
    bundledTemplates = bundled.templates;
}

    const stored = loadTemplates();
    if (stored && stored.templates) {
    templates = stored.templates;
    currentTemplate = stored.currentTemplate || defaultTemplateName;
} else if (bundledTemplates) {
    templates = deepClone(bundledTemplates);
    currentTemplate = defaultTemplateName;
} else {
    createDefaultTemplates();
}

    if (bundledTemplates && bundledTemplates[defaultTemplateName]) {
    templates[defaultTemplateName] = deepClone(bundledTemplates[defaultTemplateName]);
}

    updateTemplateSelect();
    setCurrentTemplate(currentTemplate);
    updateSettingsTemplateSelect();
    syncVisibilityCheckboxes();
    updateFullscreenButton();
    setEditMode(false);
};

    initTemplates();




    // ============================================
    // FULL MERGED FILE WITH MULTI-TOUCH + ANALOG + TRUE BLENDING
    // ============================================

    // =============================
    // ANALOG + BLENDING UTILS
    // =============================
    const lerp = (a, b, t) => a + (b - a) * t;
    const SMOOTH_FACTOR = 0.25;
    const BLEND_RADIUS = 50;

    let smoothDpad = { x: 0, y: 0 };

    // =============================
    // TRUE BLENDING: DETECT MULTIPLE NEARBY BUTTONS
    // =============================
    const getButtonsAtPoint = (x, y) => {
        const buttons = document.querySelectorAll('[data-button]');
        const hits = [];

        buttons.forEach(btn => {
            const rect = btn.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            const dist = Math.hypot(cx - x, cy - y);

            if (dist <= BLEND_RADIUS) {
                hits.push({ btn, dist });
            }
        });

        // Sort closest first
        hits.sort((a, b) => a.dist - b.dist);

        return hits;
    };

    // =============================
    // FACE BUTTONS (MULTI + BLENDED)
    // =============================
    (() => {
        const face = document.querySelector('[data-layout-id="face-buttons"]');
        if (!face) return;

        const activeTouches = new Map(); // touchId -> Set(buttons)

        const handleTouch = (touchId, x, y) => {
            const hits = getButtonsAtPoint(x, y);
            const buttons = new Set();

            hits.forEach(h => buttons.add(h.btn));

            const prev = activeTouches.get(touchId) || new Set();

            // release buttons no longer touched
            prev.forEach(btn => {
                if (!buttons.has(btn)) {
                    btn.classList.remove('active');
                    releaseButton(btn.dataset.button);
                }
            });

            // press new buttons
            buttons.forEach(btn => {
                if (!prev.has(btn)) {
                    btn.classList.add('active');
                    pressButton(btn.dataset.button);
                }
            });

            activeTouches.set(touchId, buttons);
        };

        const endTouch = (touchId) => {
            const prev = activeTouches.get(touchId);
            if (prev) {
                prev.forEach(btn => {
                    btn.classList.remove('active');
                    releaseButton(btn.dataset.button);
                });
                activeTouches.delete(touchId);
            }
        };

        face.addEventListener('touchstart', (e) => {
            if (isControllerDisabled()) return;
            for (const t of e.changedTouches) {
                handleTouch(t.identifier, t.clientX, t.clientY);
            }
            e.preventDefault();
        }, { passive: false });

        face.addEventListener('touchmove', (e) => {
            if (isControllerDisabled()) return;
            for (const t of e.touches) {
                if (!activeTouches.has(t.identifier)) continue;
                handleTouch(t.identifier, t.clientX, t.clientY);
            }
            e.preventDefault();
        }, { passive: false });

        face.addEventListener('touchend', (e) => {
            if (isControllerDisabled()) return;
            for (const t of e.changedTouches) {
                endTouch(t.identifier);
            }
            e.preventDefault();
        }, { passive: false });
    })();

    // =============================
    // D-PAD WITH TRUE ANALOG BLENDING + SMOOTHING
    // =============================
    // (() => {
    //     const dpad = document.querySelector('[data-layout-id="dpad"]');
    //     if (!dpad) return;
    //
    //     const activeTouches = new Map();
    //
    //     const dirForBtn = (btn) => {
    //         if (!btn) return { x: 0, y: 0 };
    //         const name = btn.dataset.button;
    //         if (name === 'Left') return { x: -1, y: 0 };
    //         if (name === 'Right') return { x: 1, y: 0 };
    //         if (name === 'Up') return { x: 0, y: -1 };
    //         if (name === 'Down') return { x: 0, y: 1 };
    //         return { x: 0, y: 0 };
    //     };
    //
    //     const handleTouch = (touchId, x, y) => {
    //         const hits = getButtonsAtPoint(x, y);
    //
    //         const directions = [];
    //
    //         hits.forEach(({ btn, dist }) => {
    //             const strength = 1 - Math.min(dist / BLEND_RADIUS, 1);
    //             const dir = dirForBtn(btn);
    //             directions.push({ x: dir.x * strength, y: dir.y * strength });
    //         });
    //
    //         activeTouches.set(touchId, directions);
    //         emitCombined();
    //     };
    //
    //     const endTouch = (touchId) => {
    //         activeTouches.delete(touchId);
    //         emitCombined();
    //     };
    //
    //     const emitCombined = () => {
    //         let x = 0, y = 0;
    //
    //         for (const dirs of activeTouches.values()) {
    //             dirs.forEach(d => {
    //                 x += d.x;
    //                 y += d.y;
    //             });
    //         }
    //
    //         const mag = Math.hypot(x, y);
    //         if (mag > 1) {
    //             x /= mag;
    //             y /= mag;
    //         }
    //
    //         // SMOOTHING
    //         smoothDpad.x = lerp(smoothDpad.x, x, SMOOTH_FACTOR);
    //         smoothDpad.y = lerp(smoothDpad.y, y, SMOOTH_FACTOR);
    //
    //         dpadState = {
    //             x: Math.round(smoothDpad.x * 100) / 100,
    //             y: Math.round(smoothDpad.y * 100) / 100
    //         };
    //
    //         startLoop('DPAD', () => emitDpad(dpadState.x, dpadState.y));
    //         emitDpad(dpadState.x, dpadState.y);
    //     };
    //
    //     dpad.addEventListener('touchstart', (e) => {
    //         if (isControllerDisabled()) return;
    //         for (const t of e.changedTouches) {
    //             handleTouch(t.identifier, t.clientX, t.clientY);
    //         }
    //         e.preventDefault();
    //     }, { passive: false });
    //
    //     dpad.addEventListener('touchmove', (e) => {
    //         if (isControllerDisabled()) return;
    //         for (const t of e.touches) {
    //             if (!activeTouches.has(t.identifier)) continue;
    //             handleTouch(t.identifier, t.clientX, t.clientY);
    //         }
    //         e.preventDefault();
    //     }, { passive: false });
    //
    //     dpad.addEventListener('touchend', (e) => {
    //         if (isControllerDisabled()) return;
    //         for (const t of e.changedTouches) {
    //             endTouch(t.identifier);
    //         }
    //         e.preventDefault();
    //     }, { passive: false });
    // })();

    // =============================
    // REST OF YOUR ORIGINAL FILE REMAINS UNCHANGED
    // =============================
