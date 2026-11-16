import { creditLabel, generationRequest, isTaskId, maxReferenceBytes, maxReferences, models, ratios } from './models.js?v=5';

const cloudOrigin = 'https://new.linlangai88.cn';
const apiPath = '/mobile-image-api/';
const apiBase = location.hostname === '127.0.0.1' || location.origin === cloudOrigin ? apiPath : cloudOrigin + apiPath;
const keyStorage = 'mobile-image-studio.api-key';
const $ = (id) => document.getElementById(id);
let key = '';
let afterKey;
let dashboardFrame;
let dashboardChannel;
let dashboardTimer;
let balanceRequest;
let lastBalance;
const pointFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });
const tasks = [];
let managingTasks = false;
let nextHistory;
let historyLoading = false;
const emptyGallery = document.querySelector('[data-placeholder]');
const imageLoaders = new WeakMap();
const imageObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    imageObserver.unobserve(entry.target);
    imageLoaders.get(entry.target)?.();
  }
}, { rootMargin: '200px' });
const qualityLabels = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
const successStatuses = ['succeeded', 'completed', 'success'];
const failureStatuses = ['failed', 'not_found', 'uncertain', 'canceled', 'cancelled'];
const gallery = $('gallery');
const composer = $('create');
const fileInput = $('reference-files');
const referenceFiles = [];
let preparingReferences = false;
let draggedReference;
let menuTarget;
const taskMenu = $('task-menu');

function options(select, items, preferred) {
  const previous = select.value;
  select.replaceChildren(...items.map((item) => Array.isArray(item) ? new Option(item[1], item[0]) : new Option(item)));
  select.value = items.some((item) => (Array.isArray(item) ? item[0] : item) === previous) ? previous : preferred;
}

function syncModel() {
  const model = models.find((item) => item.id === $('model').value);
  options($('size'), model.sizes, '2K');
  $('quality-row').hidden = !model.qualities;
  if (model.qualities) {
    options($('quality'), model.qualities.map((value) => [value, qualityLabels[value]]), 'high');
  }
  syncCredits();
}

function syncCredits() {
  const model = models.find((item) => item.id === $('model').value);
  $('model-credits').textContent = creditLabel(model, $('quality').value);
}

function setKey(value, persist = true) {
  if (persist) {
    try {
      if (value) localStorage.setItem(keyStorage, value);
      else localStorage.removeItem(keyStorage);
      $('key-storage-status').textContent = '';
    } catch {
      $('key-storage-status').textContent = '浏览器无法写入本地存储，刷新后可能需要重新设置 Key。';
    }
  }
  if (value !== key) {
    taskMenu.hidePopover();
    balanceRequest?.abort();
    balanceRequest = undefined;
    lastBalance = undefined;
    closeDashboardFrame();
    for (const task of tasks) removeTaskCards(task);
    tasks.length = 0;
    nextHistory = undefined;
    historyLoading = false;
    managingTasks = false;
    $('more-tasks').hidden = true;
    $('history-note').textContent = '';
    updateTaskCount();
  }
  key = value;
  $('open-key').toggleAttribute('data-ready', Boolean(value));
  $('key-label').textContent = value ? 'API Key 已设置' : '设置 API Key';
  renderBalance(lastBalance ?? (value ? '查询中…' : '—'));
  if (value) refreshBalance();
  if (value) loadHistory(value);
  if (!$('dashboard-view').hidden) openDashboardFrame();
}

function closeDashboardFrame() {
  dashboardChannel?.close();
  dashboardChannel = undefined;
  dashboardFrame?.remove();
  dashboardFrame = undefined;
  clearTimeout(dashboardTimer);
}

function openDashboardFrame() {
  if (!key || dashboardFrame) return;
  const boardOrigin = 'https://task.imagesave.cn';
  // The board accepts its desktop client's protocol from an opaque parent.
  // The isolated relay passes credentials only to the board's exact HTTPS origin.
  const relay = `<!doctype html><html lang="zh-CN">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style>
    <iframe title="任务中心"></iframe>
    <script>
      const boardOrigin = ${JSON.stringify(boardOrigin)};
      const board = document.querySelector('iframe');
      const channel = new MessageChannel();
      let apiKey, requested = false;
      function authenticate() {
        if (!requested || !apiKey) return;
        board.contentWindow.postMessage({source:'aiwork-client',type:'auth-response',version:1,apiKey},boardOrigin);
        channel.port1.postMessage('board-connected');
      }
      channel.port1.onmessage = ({data}) => {
        if (typeof data !== 'string') return;
        apiKey = data;
        authenticate();
      };
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (event.origin !== boardOrigin || event.source !== board.contentWindow ||
            data?.source !== 'task-dashboard' || data.type !== 'auth-request' || data.version !== 1) return;
        requested = true;
        authenticate();
      });
      window.parent.postMessage('dashboard-channel', ${JSON.stringify(location.origin)}, [channel.port2]);
      board.src = boardOrigin + '/';
    </script></html>`;
  dashboardFrame = document.createElement('iframe');
  dashboardFrame.className = 'dashboard-frame';
  dashboardFrame.title = '任务看板';
  dashboardFrame.referrerPolicy = 'no-referrer';
  dashboardFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox');
  dashboardFrame.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(relay);
  $('dashboard-status').textContent = '正在加载任务看板…';
  $('dashboard-frame-host').append(dashboardFrame);
  dashboardTimer = setTimeout(() => {
    $('dashboard-status').textContent = '任务看板连接较慢。可切回生图，再打开看板重试。';
    closeDashboardFrame();
  }, 18000);
}

function switchView(showDashboard) {
  if (showDashboard && !key) return openKey(() => switchView(true));
  $('studio-view').hidden = showDashboard;
  $('dashboard-view').hidden = !showDashboard;
  $('show-studio').setAttribute('aria-pressed', String(!showDashboard));
  $('show-dashboard').setAttribute('aria-pressed', String(showDashboard));
  if (showDashboard) openDashboardFrame();
  refreshBalance();
}

function renderBalance(value, error = '') {
  $('balance-value').textContent = value;
  $('balance-refresh').toggleAttribute('data-error', Boolean(error));
  $('balance-refresh').title = error || '刷新积分余额';
  $('balance-refresh').setAttribute('aria-label', error ? '剩余积分 ' + value + '，' + error : '剩余积分 ' + value + '，点击刷新');
}

async function refreshBalance() {
  if (!key || balanceRequest) return;
  const controller = new AbortController();
  balanceRequest = controller;
  try {
    const response = await fetch(apiBase + 'balance', {
      headers: { Authorization: 'Bearer ' + key },
      cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    });
    const data = await response.json();
    if (!response.ok || (!data.unlimited && !Number.isFinite(data.remaining))) {
      throw new Error(data?.error || '暂时无法查询积分余额。');
    }
    if (balanceRequest !== controller) return;
    lastBalance = data.unlimited ? '无限' : pointFormat.format(data.remaining);
    renderBalance(lastBalance);
  } catch (error) {
    if (balanceRequest !== controller) return;
    renderBalance(lastBalance === undefined ? '查询失败' : lastBalance + ' · 未更新', error.message);
  } finally {
    if (balanceRequest === controller) balanceRequest = undefined;
  }
}

function openKey(callback) {
  afterKey = callback;
  $('api-key').value = '';
  $('key-dialog').showModal();
}

function withKey(callback) {
  if (key) return callback();
  openKey(callback);
}

function syncPrompt() {
  $('count').textContent = $('prompt').value.length + ' / 8000';
  $('collapsed-prompt').textContent = $('prompt').value.trim() || '输入提示词';
}

function toggleComposer(expanded) {
  $('composer-panel').hidden = !expanded;
  $('collapsed-prompt').hidden = expanded;
  $('toggle-composer').setAttribute('aria-expanded', String(expanded));
  $('toggle-composer').textContent = expanded ? '收起输入栏 ⌄' : '展开输入栏 ⌃';
}

function updateTaskCount() {
  const active = tasks.filter((task) => task.running).length;
  $('result-badge').textContent = active ? active + ' 个进行中 / ' + tasks.length + ' 个任务' : tasks.length + ' 个任务';
  emptyGallery.hidden = tasks.length !== 0;
  const eligible = tasks.filter((task) => !task.running);
  const selected = eligible.filter((task) => task.selection.checked);
  $('manage-tasks').hidden = !eligible.length && !managingTasks;
  $('manage-tasks').textContent = managingTasks ? '完成管理' : '管理任务';
  $('delete-tasks').hidden = !managingTasks;
  $('delete-tasks').disabled = !selected.length;
  $('delete-tasks').textContent = selected.length ? '删除所选（' + selected.length + '）' : '删除所选';
  for (const task of tasks) task.selection.parentElement.hidden = !managingTasks || task.running;
}

function setPreviewSize(value) {
  const percent = Math.max(50, Math.min(150, value));
  gallery.style.setProperty('--preview-scale', String(percent / 100));
  $('preview-size').value = String(percent);
  $('preview-percent').textContent = percent + '%';
  $('zoom-out').disabled = percent === 50;
  $('zoom-in').disabled = percent === 150;
}

function showPreview(url, alt) {
  const image = $('preview-image');
  image.alt = alt;
  image.src = url;
  $('image-dialog').showModal();
}

function referenceLinks() {
  return $('references').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function updateReferences() {
  const count = referenceFiles.length + referenceLinks().length;
  $('reference-count').textContent = count + ' / ' + maxReferences;
  $('reference-thumbnails').hidden = referenceFiles.length === 0;
  $('add-reference').disabled = preparingReferences || count >= maxReferences;
  $('generate').disabled = preparingReferences;
}

async function prepareImage(file) {
  if (file.size > 30 * 1024 * 1024) throw new Error('单张原图不能超过 30 MB。');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (file.type === 'image/png') {
      const png = canvas.toDataURL('image/png');
      if (png.length <= maxReferenceBytes * 4 / 3) return png;
    }
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL('image/jpeg', 0.82);
    if (jpeg.length > maxReferenceBytes * 4 / 3) throw new Error('图片太大，请缩小后重新添加。');
    return jpeg;
  } finally {
    URL.revokeObjectURL(source);
  }
}

function addReferenceThumbnail(file, data) {
  const item = document.createElement('li');
  item.className = 'reference-item';
  item.draggable = true;
  item.tabIndex = 0;
  item.setAttribute('aria-label', file.name + '，可拖动或用左右方向键排序');
  const image = new Image();
  image.src = data;
  image.alt = file.name;
  image.draggable = false;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-reference';
  remove.textContent = '×';
  remove.setAttribute('aria-label', '移除参考图 ' + file.name);
  const reference = { data, item };
  item.addEventListener('dragstart', (event) => {
    draggedReference = reference;
    event.dataTransfer.setData('text/plain', '');
    event.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragover', (event) => {
    if (!draggedReference || draggedReference === reference) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    item.setAttribute('data-drop', '');
  });
  item.addEventListener('dragleave', () => item.removeAttribute('data-drop'));
  item.addEventListener('dragend', () => {
    draggedReference = undefined;
    for (const ref of referenceFiles) ref.item.removeAttribute('data-drop');
  });
  item.addEventListener('drop', (event) => {
    if (!draggedReference) return;
    event.preventDefault();
    moveReference(draggedReference, referenceFiles.indexOf(reference));
    item.removeAttribute('data-drop');
    draggedReference = undefined;
  });
  item.addEventListener('keydown', (event) => {
    if (event.target !== item || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = referenceFiles.indexOf(reference);
    moveReference(reference, index + (event.key === 'ArrowRight' ? 1 : -1));
    item.focus();
  });
  image.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    image.setPointerCapture(event.pointerId);
    item.setAttribute('data-drop', '');
  });
  image.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'touch') return;
    const destination = document.elementFromPoint(event.clientX, event.clientY)?.closest('.reference-item');
    moveReference(reference, referenceFiles.findIndex((ref) => ref.item === destination));
  });
  image.addEventListener('lostpointercapture', () => item.removeAttribute('data-drop'));
  remove.addEventListener('click', () => {
    referenceFiles.splice(referenceFiles.indexOf(reference), 1);
    item.remove();
    $('reference-note').textContent = '';
    updateReferences();
  });
  referenceFiles.push(reference);
  item.append(image, remove);
  $('reference-thumbnails').append(item);
}

function moveReference(reference, target) {
  const from = referenceFiles.indexOf(reference);
  if (target === from || target < 0 || target >= referenceFiles.length) return;
  referenceFiles.splice(from, 1);
  referenceFiles.splice(target, 0, reference);
  const next = referenceFiles[target + 1]?.item ?? null;
  $('reference-thumbnails').insertBefore(reference.item, next);
}

async function addReferenceFiles(files) {
  if (!files.length || preparingReferences) return;
  preparingReferences = true;
  $('reference-note').textContent = '正在读取参考图…';
  updateReferences();
  const errors = new Set();
  for (const file of files) {
    if (referenceFiles.length + referenceLinks().length >= maxReferences) {
      errors.add('参考图最多 6 张，含图片链接。');
      break;
    }
    try {
      const data = await prepareImage(file);
      if (referenceFiles.length + referenceLinks().length >= maxReferences) {
        errors.add('参考图最多 6 张，含图片链接。');
        break;
      }
      addReferenceThumbnail(file, data);
    } catch {
      errors.add(file.name + ' 无法添加，请使用浏览器可打开的图片（如 JPG 或 PNG，原图不超过 30 MB）。');
    }
  }
  preparingReferences = false;
  $('reference-note').textContent = [...errors].join(' ');
  updateReferences();
}

function addTask(title, settings, record = crypto.randomUUID(), append = false) {
  const node = $('task-template').content.firstElementChild.cloneNode(true);
  const task = {
    node,
    status: node.querySelector('.task-status'),
    state: node.querySelector('.task-state'),
    taskId: node.querySelector('.task-id'),
    retry: node.querySelector('.poll-again'),
    placeholder: node.querySelector('.task-placeholder'),
    actions: node.querySelector('.image-actions'),
    selection: node.querySelector('input[type=checkbox]'),
    record,
    cards: [node],
    blobs: new Set(),
    running: false,
  };
  const heading = node.querySelector('h3');
  heading.textContent = title;
  heading.title = title;
  const meta = node.querySelector('.task-settings');
  meta.textContent = settings || '';
  meta.hidden = !settings;
  task.retry.addEventListener('click', () => withKey(() => runPoll(task, key)));
  task.selection.setAttribute('aria-label', '选择任务 ' + title.slice(0, 100));
  task.selection.addEventListener('change', updateTaskCount);
  tasks.push(task);
  if (append) gallery.append(node);
  else gallery.prepend(node);
  updateTaskCount();
  if (!append) gallery.scrollTop = 0;
  return task;
}

function removeTaskCards(task) {
  task.removed = true;
  for (const card of task.cards) {
    for (const image of card.querySelectorAll('img')) imageObserver.unobserve(image);
    card.remove();
  }
  for (const url of task.blobs) URL.revokeObjectURL(url);
}

async function historyRequest(path, currentKey, payload) {
  const response = await fetch(apiBase + path, {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + currentKey, ...(payload && { 'Content-Type': 'application/json' }) },
    body: payload && JSON.stringify(payload),
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) throw new Error('创作记录暂时无法访问。');
  return response.json();
}

async function loadHistory(currentKey, more = false) {
  if (historyLoading) return;
  historyLoading = true;
  const cursor = more && nextHistory ? '?' + new URLSearchParams({ before: nextHistory.created, record: nextHistory.record }) : '';
  try {
    const data = await historyRequest('history' + cursor, currentKey);
    if (key !== currentKey) return;
    for (const row of data.tasks) {
      if (tasks.some((task) => task.record === row.record)) continue;
      const task = addTask(row.prompt, row.settings, row.record, true);
      task.id = row.id;
      task.persisted = true;
      task.repeatable = row.repeatable;
      task.prompt = row.prompt === '查询已有任务' && !row.repeatable ? '' : row.prompt;
      if (row.images.length) showImages(task, row.images, currentKey, row.saving);
      else if (row.status === 'pending' && row.id) runPoll(task, currentKey);
      else setStatus(task, row.status === 'failed' ? '任务结束' : '提交未确认', row.error || '暂无任务回执。');
    }
    nextHistory = data.next;
    $('more-tasks').hidden = !nextHistory;
    $('history-note').textContent = '';
  } catch {
    if (key === currentKey) $('history-note').textContent = '暂时无法加载历史记录，刷新页面可重试。';
  } finally {
    if (key === currentKey) historyLoading = false;
  }
}

function setStatus(task, badge, message = '', retry = false) {
  task.state.textContent = badge;
  task.status.textContent = message;
  task.status.hidden = !message;
  task.taskId.textContent = task.id ? '任务 ID  ' + task.id : '';
  task.taskId.hidden = !task.id;
  task.retry.hidden = !retry;
}

function setRunning(task, running) {
  task.running = running;
  updateTaskCount();
}

async function callApi(path, payload, currentKey) {
  let response;
  try {
    response = await fetch(apiBase + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + currentKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(27000),
    });
  } catch {
    throw new Error(path === 'generate'
      ? '提交结果暂时无法确认。请先核对任务记录，避免重复生成。'
      : '网络暂时不可用。可以继续查询这条任务。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || '服务返回 HTTP ' + response.status + '。');
  return data;
}

function imageCardParts(task, url, index, currentKey) {
  const thumbnail = document.createElement('button');
  thumbnail.type = 'button';
  thumbnail.className = 'thumbnail';
  thumbnail.setAttribute('aria-label', '预览生成结果 ' + (index + 1));
  const image = new Image();
  image.alt = '生成结果 ' + (index + 1);
  image.loading = 'lazy';
  image.referrerPolicy = 'no-referrer';
  const archived = url.startsWith('history-image/');
  if (!archived) image.src = url;
  const zoom = document.createElement('span');
  zoom.className = 'zoom';
  zoom.setAttribute('aria-hidden', 'true');
  zoom.textContent = '↗';
  thumbnail.append(image, zoom);
  thumbnail.addEventListener('click', () => {
    if (image.getAttribute('src')) showPreview(image.src, image.alt);
  });
  const original = document.createElement('a');
  original.textContent = '打开原图 ↗';
  if (!archived) original.href = url;
  original.target = '_blank';
  original.rel = 'noopener noreferrer';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = '下载';
  if (archived) {
    save.disabled = true;
    imageLoaders.set(image, () => fetch(apiBase + url, {
      headers: { Authorization: 'Bearer ' + currentKey },
      signal: AbortSignal.timeout(18000),
    }).then((response) => {
      if (!response.ok) throw new Error('Image unavailable');
      return response.blob();
    }).then((blob) => {
      if (task.removed) return;
      const objectUrl = URL.createObjectURL(blob);
      task.blobs.add(objectUrl);
      image.src = objectUrl;
      original.href = objectUrl;
      save.disabled = false;
    }).catch(() => {
      save.textContent = '图片读取失败';
    }));
    imageObserver.observe(image);
  }
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const response = await fetch(image.src, { referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('下载失败');
      const blob = await response.blob();
      const download = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      const extension = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })[blob.type] || 'png';
      download.href = objectUrl;
      download.download = '密码象-' + (task.id || task.number) + '-' + (index + 1) + '.' + extension;
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    } catch {
      save.textContent = '请打开原图长按保存';
    } finally {
      save.disabled = false;
    }
  });
  const preview = document.createElement('div');
  preview.className = 'image-preview';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'more-actions';
  more.textContent = '⋯';
  more.setAttribute('aria-label', '图片操作');
  const openMenu = (x, y) => openTaskMenu({ task, url }, x, y);
  more.addEventListener('click', () => {
    const rect = more.getBoundingClientRect();
    openMenu(rect.left, rect.bottom);
  });
  preview.append(thumbnail, more);
  return { preview, original, save, openMenu };
}

function openTaskMenu(target, x, y) {
  if (target.task.removed) return;
  menuTarget = target;
  const task = target.task;
  const repeat = taskMenu.querySelector('[data-task-action=repeat]');
  repeat.disabled = !task.repeatable || task.repeating;
  repeat.title = task.repeatable ? '' : '此任务未保存原始生成参数';
  for (const name of ['copy', 'push']) {
    taskMenu.querySelector('[data-task-action=' + name + ']').disabled = !task.prompt;
  }
  taskMenu.style.left = '0px';
  taskMenu.style.top = '0px';
  if (!taskMenu.matches(':popover-open')) taskMenu.showPopover();
  taskMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - taskMenu.offsetWidth - 4)) + 'px';
  taskMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - taskMenu.offsetHeight - 4)) + 'px';
  taskMenu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

async function useTaskAction(action, { task, url }) {
  const currentKey = key;
  if (task.removed || !currentKey) return;
  $('history-note').textContent = '';
  if (action === 'repeat') {
    if (task.repeating) return;
    task.repeating = true;
    try {
      const input = await historyRequest('history-recipe?record=' + task.record, currentKey);
      if (currentKey !== key || task.removed) return;
      void submit(input, currentKey);
    } catch {
      $('history-note').textContent = '无法读取原始生成参数。';
    } finally {
      task.repeating = false;
    }
    return;
  }
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(task.prompt);
      $('history-note').textContent = '提示词已复制。';
    } catch {
      $('history-note').textContent = '无法访问剪贴板，可推送到输入框后手动复制。';
    }
    return;
  }
  toggleComposer(true);
  if (action === 'push') {
    $('prompt').value = task.prompt;
    syncPrompt();
    $('prompt').focus();
    return;
  }
  try {
    if (referenceFiles.length + referenceLinks().length >= maxReferences) {
      $('reference-note').textContent = '参考图最多 6 张，含图片链接。';
      return;
    }
    const archived = url.startsWith('history-image/');
    const response = await fetch(archived ? apiBase + url : url, {
      ...(archived && { headers: { Authorization: 'Bearer ' + currentKey } }),
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('Image unavailable');
    const blob = await response.blob();
    if (currentKey === key && !task.removed) await addReferenceFiles([new File([blob], '任务图片', { type: blob.type })]);
  } catch {
    $('reference-note').textContent = '图片暂时无法读取，请等原图留存后再试。';
  }
}

function showImages(task, urls, currentKey, saving = false) {
  if (task.removed || task.completed) return;
  setStatus(task, '已生成', saving ? '正在留存原图…' : '');
  task.completed = true;
  let previous = task.node;
  urls.forEach((url, index) => {
    const { preview, original, save, openMenu } = imageCardParts(task, url, index, currentKey);
    const card = index === 0 ? task.node : document.createElement('article');
    card.oncontextmenu = (event) => {
      event.preventDefault();
      openMenu(event.clientX, event.clientY);
    };
    if (index === 0) {
      task.placeholder.replaceWith(preview);
      task.actions.append(original, save);
      task.actions.hidden = false;
      return;
    }
    card.className = 'task';
    const content = document.createElement('div');
    content.className = 'task-content';
    const heading = document.createElement('h3');
    heading.textContent = task.node.querySelector('h3').textContent;
    heading.title = heading.textContent;
    const actions = document.createElement('div');
    actions.className = 'image-actions';
    actions.append(original, save);
    content.append(heading, actions);
    card.append(preview, content);
    previous.after(card);
    task.cards.push(card);
    previous = card;
  });
  if (saving) void checkArchive(task, currentKey);
}

async function checkArchive(task, currentKey) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (task.removed || key !== currentKey) return;
    try {
      const row = await historyRequest('history-record?record=' + task.record, currentKey);
      if (!row.saving) {
        if (task.removed) return;
        for (const card of task.cards.slice(1)) {
          for (const image of card.querySelectorAll('img')) imageObserver.unobserve(image);
          card.remove();
        }
        const preview = task.node.querySelector('.image-preview');
        imageObserver.unobserve(preview.querySelector('img'));
        preview.replaceWith(task.placeholder);
        task.cards.length = 1;
        task.actions.replaceChildren();
        task.completed = false;
        for (const url of task.blobs) URL.revokeObjectURL(url);
        task.blobs.clear();
        showImages(task, row.images, currentKey);
        return;
      }
    } catch {
      // Retain the visible result while the server retries the copy.
    }
  }
  if (!task.removed) setStatus(task, '已生成', '原图留存尚未确认，可先下载。');
}

async function poll(task, currentKey) {
  const until = Date.now() + 15 * 60 * 1000;
  setStatus(task, '进行中', '正在等待生成结果…');
  while (Date.now() < until) {
    if (task.removed) return;
    let data;
    try {
      data = await callApi('task', { id: task.id, record: task.record, import: !task.persisted }, currentKey);
      task.persisted = true;
    } catch (error) {
      setStatus(task, '查询暂停', error.message, true);
      return;
    }
    if (data.images?.length && successStatuses.includes(data.status)) {
      showImages(task, data.images, currentKey, data.saving ?? true);
      return;
    }
    if (failureStatuses.includes(data.status) || successStatuses.includes(data.status)) {
      setStatus(task, '任务结束', data.error || '这条任务没有返回可显示的图片。', data.status === 'uncertain');
      return;
    }
    const delay = Math.max(3000, Math.min(60000, Number(data.nextPoll) || 10000));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  setStatus(task, '查询暂停', '这条任务等待较久，可以继续查询。', true);
}

async function runPoll(task, currentKey) {
  if (task.running) return;
  setRunning(task, true);
  try {
    await poll(task, currentKey);
  } finally {
    setRunning(task, false);
  }
}

async function submit(input, currentKey) {
  const model = models.find((item) => item.id === input.model);
  const settings = [model.name, input.ratio, input.size, creditLabel(model, input.quality)].join(' · ');
  const task = addTask(input.prompt.trim(), settings);
  task.prompt = input.prompt;
  task.repeatable = true;
  task.number = tasks.length;
  setRunning(task, true);
  setStatus(task, '正在提交', '正在提交生图任务…');
  try {
    const data = await callApi('generate', { ...input, record: task.record }, currentKey);
    task.persisted = true;
    if (currentKey === key) refreshBalance();
    if (isTaskId(data.id)) task.id = data.id;
    if (data.images?.length) showImages(task, data.images, currentKey, data.saving ?? true);
    else if (task.id) await poll(task, currentKey);
    else setStatus(task, '提交未确认', '未收到任务 ID。请先核对任务记录，避免重复生成。');
  } catch (error) {
    setStatus(task, '提交未完成', error.message);
  } finally {
    setRunning(task, false);
    if (currentKey === key) refreshBalance();
  }
}

options($('model'), models.map((model) => [model.id, model.name + ' · ' + creditLabel(model)]), 'gemini-nano-banana-2.1');
options($('ratio'), ratios, '1:1');
syncModel();
syncPrompt();
setPreviewSize(100);
$('preview-size').addEventListener('input', (event) => setPreviewSize(Number(event.target.value)));
$('zoom-out').addEventListener('click', () => setPreviewSize(Number($('preview-size').value) - 10));
$('zoom-in').addEventListener('click', () => setPreviewSize(Number($('preview-size').value) + 10));
$('toggle-composer').addEventListener('click', () => toggleComposer($('composer-panel').hidden));
taskMenu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-task-action]')?.dataset.taskAction;
  if (!action || !menuTarget) return;
  const target = menuTarget;
  taskMenu.hidePopover();
  void useTaskAction(action, target);
});
$('more-tasks').addEventListener('click', () => { if (key) loadHistory(key, true); });
$('manage-tasks').addEventListener('click', () => {
  managingTasks = !managingTasks;
  for (const task of tasks) task.selection.checked = false;
  updateTaskCount();
});
$('delete-tasks').addEventListener('click', () => {
  const count = tasks.filter((task) => !task.running && task.selection.checked).length;
  if (!count) return;
  $('delete-dialog').returnValue = '';
  $('delete-description').textContent = '删除这 ' + count + ' 条创作记录及本站留存的图片？此操作不可撤销。';
  $('delete-dialog').showModal();
});
$('delete-dialog').addEventListener('close', async () => {
  if ($('delete-dialog').returnValue !== 'delete' || !key) return;
  const currentKey = key;
  const selected = tasks.filter((task) => !task.running && task.selection.checked);
  $('history-note').textContent = '';
  try {
    for (let start = 0; start < selected.length; start += 60) {
      const batch = selected.slice(start, start + 60);
      await historyRequest('history-delete', currentKey, { records: batch.map((task) => task.record) });
      if (currentKey !== key) return;
      for (const task of batch) {
        if (!tasks.includes(task)) continue;
        removeTaskCards(task);
        tasks.splice(tasks.indexOf(task), 1);
      }
      updateTaskCount();
    }
    managingTasks = false;
    updateTaskCount();
  } catch {
    if (currentKey === key) $('history-note').textContent = '暂时无法删除所选记录，请重试。';
  }
});
$('close-preview').addEventListener('click', () => $('image-dialog').close());
$('image-dialog').addEventListener('close', () => $('preview-image').removeAttribute('src'));
$('model').addEventListener('change', syncModel);
$('quality').addEventListener('change', syncCredits);
$('prompt').addEventListener('input', syncPrompt);
$('prompt').addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  void addReferenceFiles(files);
});
$('add-reference').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  addReferenceFiles(files);
});
$('references').addEventListener('input', updateReferences);
document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  const inside = composer.contains(event.target);
  composer.toggleAttribute('data-dragging', inside);
  event.dataTransfer.dropEffect = inside ? 'copy' : 'none';
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget || !composer.contains(event.relatedTarget)) composer.removeAttribute('data-dragging');
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  composer.removeAttribute('data-dragging');
  if (composer.contains(event.target)) addReferenceFiles([...event.dataTransfer.files]);
});
$('open-key').addEventListener('click', () => openKey());
$('show-studio').addEventListener('click', () => switchView(false));
$('show-dashboard').addEventListener('click', () => switchView(true));
window.addEventListener('message', (event) => {
  if (!dashboardFrame || dashboardChannel || event.source !== dashboardFrame.contentWindow ||
      event.origin !== 'null' || event.data !== 'dashboard-channel' || event.ports.length !== 1) return;
  const port = event.ports[0];
  dashboardChannel = port;
  port.onmessage = ({ data }) => {
    if (dashboardChannel !== port || data !== 'board-connected') return;
    clearTimeout(dashboardTimer);
    $('dashboard-status').textContent = '';
    refreshBalance();
  };
  port.postMessage(key);
});
window.addEventListener('storage', (event) => {
  if (event.storageArea !== localStorage || (event.key !== keyStorage && event.key !== null)) return;
  setKey(event.newValue || '', false);
  if (!key) switchView(false);
});
$('balance-refresh').addEventListener('click', () => withKey(refreshBalance));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshBalance();
});
setInterval(() => {
  if (!document.hidden) refreshBalance();
}, 20000);
$('close-key').addEventListener('click', () => $('key-dialog').close());
$('clear-key').addEventListener('click', () => {
  setKey('');
  switchView(false);
  $('key-dialog').close();
});
$('key-dialog').addEventListener('close', () => {
  afterKey = undefined;
  $('api-key').value = '';
});
$('key-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('api-key').value.trim().replace(/^Bearer\s+/i, '');
  if (!/^[!-~]{1,512}$/.test(value)) {
    $('api-key').setCustomValidity('请输入有效的 API Key。');
    $('api-key').reportValidity();
    return;
  }
  const callback = afterKey;
  setKey(value);
  $('key-dialog').close();
  callback?.();
});
$('api-key').addEventListener('input', () => $('api-key').setCustomValidity(''));
try {
  const savedKey = localStorage.getItem(keyStorage);
  if (savedKey && /^[!-~]{1,512}$/.test(savedKey)) setKey(savedKey, false);
} catch {
  $('key-storage-status').textContent = '浏览器无法读取本地存储，刷新后可能需要重新设置 Key。';
}
composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (preparingReferences) return;
  $('form-note').textContent = '';
  const input = {
    model: $('model').value,
    prompt: $('prompt').value,
    ratio: $('ratio').value,
    size: $('size').value,
    quality: $('quality').value,
    references: referenceLinks(),
    referenceFiles: referenceFiles.map((reference) => reference.data),
  };
  try {
    if (input.references.length + input.referenceFiles.length > maxReferences) throw new Error('参考图最多 6 张，含图片链接。');
    generationRequest(input);
    withKey(() => submit(input, key));
  } catch (error) {
    $('form-note').textContent = error.message;
  }
});
$('resume').addEventListener('submit', (event) => {
  event.preventDefault();
  $('resume-note').textContent = '';
  const id = $('resume-id').value.trim();
  if (!isTaskId(id)) {
    $('resume-note').textContent = '请检查任务 ID。';
    return;
  }
  withKey(() => {
    let task = tasks.find((item) => item.id === id);
    if (!task) {
      task = addTask('查询已有任务');
      task.id = id;
    }
    task.node.scrollIntoView({ block: 'nearest' });
    if (!task.completed) runPoll(task, key);
  });
});
