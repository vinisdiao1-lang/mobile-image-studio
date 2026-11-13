import { generationRequest, isTaskId, models, ratios } from './models.js';

const example = '电影感风光摄影。黄昏时，寂静的火山湖倒映着一线铜色霞光，深色山脊环绕湖面，远处薄雾中升起一轮小月亮。石墨蓝阴影，轻微胶片颗粒，横向构图。';
const remoteApi = 'https://new.linlangai88.cn/mobile-image-api/';
const apiBase = location.hostname === '127.0.0.1' ? '/mobile-image-api/' : remoteApi;
const $ = (id) => document.getElementById(id);
let key = '';
let afterKey;
let activeId;
let busy = false;

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
    const labels = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
    options($('quality'), model.qualities.map((value) => [value, labels[value]]), 'high');
  }
}

function setKey(value) {
  key = value;
  $('open-key').toggleAttribute('data-ready', Boolean(value));
  $('key-label').textContent = value ? 'API Key 已设置' : '设置 API Key';
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
}

function setBusy(value) {
  busy = value;
  $('generate').disabled = value;
  $('resume').querySelector('button').disabled = value;
  $('poll-again').disabled = value;
}

function setStatus(badge, message, id, retry = false) {
  $('sample').hidden = true;
  $('images').hidden = true;
  $('pending').hidden = false;
  $('result-badge').textContent = badge;
  $('task-status').textContent = message;
  $('task-id').textContent = id ? '任务 ID  ' + id : '';
  $('poll-again').hidden = !retry;
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
      ? '提交结果暂时无法确认。请先检查新宝的任务记录，避免重复生成。'
      : '网络暂时不可用。可以继续查询这条任务。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || '服务返回 HTTP ' + response.status + '。');
  return data;
}

function showImages(urls) {
  $('pending').hidden = true;
  $('images').hidden = false;
  $('result-badge').textContent = '已生成';
  $('images').replaceChildren(...urls.map((url, index) => {
    const item = document.createElement('div');
    const image = new Image();
    image.alt = '生成结果 ' + (index + 1);
    image.referrerPolicy = 'no-referrer';
    image.src = url;
    const actions = document.createElement('div');
    actions.className = 'image-actions';
    const original = document.createElement('a');
    original.textContent = '打开原图 ↗';
    original.href = url;
    original.target = '_blank';
    original.rel = 'noopener noreferrer';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = '下载';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const response = await fetch(url, { referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('下载失败');
        const blob = await response.blob();
        const download = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        const extension = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })[blob.type] || 'png';
        download.href = objectUrl;
        download.download = '微光-' + (index + 1) + '.' + extension;
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
    actions.append(original, save);
    item.append(image, actions);
    return item;
  }));
}

async function poll(id, currentKey) {
  activeId = id;
  $('resume-id').value = id;
  const until = Date.now() + 15 * 60 * 1000;
  setStatus('进行中', '等待新宝返回生成结果…', id);
  while (Date.now() < until) {
    let data;
    try {
      data = await callApi('task', { id }, currentKey);
    } catch (error) {
      setStatus('查询暂停', error.message, id, true);
      return;
    }
    if (data.images?.length && ['succeeded', 'completed', 'success'].includes(data.status)) {
      showImages(data.images);
      return;
    }
    if (['failed', 'not_found', 'uncertain', 'canceled', 'cancelled', 'succeeded', 'completed', 'success'].includes(data.status)) {
      setStatus('任务结束', data.error || '新宝没有返回可显示的图片。', id, data.status === 'uncertain');
      return;
    }
    const delay = Math.max(3000, Math.min(60000, Number(data.nextPoll) || 10000));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  setStatus('查询暂停', '这条任务等待较久，可以继续查询。', id, true);
}

async function runPoll(id) {
  if (busy) return;
  setBusy(true);
  try {
    await poll(id, key);
  } finally {
    setBusy(false);
  }
}

async function submit(input) {
  if (busy) return;
  setBusy(true);
  const currentKey = key;
  setStatus('正在提交', '正在提交生图任务…');
  if (matchMedia('(max-width: 760px)').matches) $('result-title').scrollIntoView({ block: 'start' });
  try {
    const data = await callApi('generate', input, currentKey);
    if (data.images?.length) showImages(data.images);
    else await poll(data.id, currentKey);
  } catch (error) {
    setStatus('提交未完成', error.message);
  } finally {
    setBusy(false);
  }
}

options($('model'), models.map((item) => [item.id, item.name]), models[0].id);
options($('ratio'), ratios, '1:1');
syncModel();
$('model').addEventListener('change', syncModel);
$('prompt').addEventListener('input', syncPrompt);
$('example-button').addEventListener('click', () => {
  $('prompt').value = example;
  $('ratio').value = '3:2';
  syncPrompt();
});
$('open-key').addEventListener('click', () => openKey());
$('close-key').addEventListener('click', () => $('key-dialog').close());
$('clear-key').addEventListener('click', () => {
  setKey('');
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
$('create').addEventListener('submit', (event) => {
  event.preventDefault();
  $('form-note').textContent = '';
  const input = {
    model: $('model').value,
    prompt: $('prompt').value,
    ratio: $('ratio').value,
    size: $('size').value,
    quality: $('quality').value,
    references: $('references').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
  try {
    generationRequest(input);
    withKey(() => submit(input));
  } catch (error) {
    $('form-note').textContent = error.message;
  }
});
$('resume').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = $('resume-id').value.trim();
  if (!isTaskId(id)) return setStatus('无法查询', '请检查任务 ID。');
  withKey(() => runPoll(id));
});
$('poll-again').addEventListener('click', () => withKey(() => runPoll(activeId)));
