const gptSizes = ['1K', '2K', '4K'];
const geminiSizes = ['1K', '2K', '4K'];
const qualities = ['low', 'medium', 'high'];
const premiumQualities = ['xhigh', 'max'];

export const models = [
  { id: 'gemini-3.1-flash-lite-image', name: '全能图片 2 Lite', credits: 3.6, family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-3.1-flash-image-preview', name: '全能图片 2', credits: 6, family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-nano-banana-2.1', name: '全能图片 2.1', credits: 9, family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-3-pro-image-preview', name: '全能图片 Pro', credits: 12, family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-3-pro-image-preview-vip', name: '全能图片 Pro-VIP', credits: 14.4, family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-3-pro-image-preview-svip', name: '全能图片 Pro-SVIP', credits: 30, family: 'gemini', sizes: geminiSizes },
  { id: 'gpt-image-2.6', name: '全能图片 G2.6', credits: 6, family: 'gpt', sizes: ['1K', '2K'], qualities },
  { id: 'gpt-image-2-oai', name: '全能图片 G-2.0 OAI', credits: 12, family: 'gpt', sizes: gptSizes, qualities },
  {
    id: 'gpt-image-2.6-sunburst-oai', name: '全能图片 G2.6 S OAI', credits: 14.4,
    family: 'gpt', sizes: gptSizes, qualities: [...qualities, ...premiumQualities],
    premium: { id: 'gpt-image-2.6-sunburst-max-oai', credits: 18 },
  },
  { id: 'doubao-seedream-5-0', name: 'Seedream-5-0', credits: 6, family: 'seedream', sizes: ['2K', '4K'] },
  { id: 'seedream-5-pro', name: 'Seedream-5-0-pro', credits: 18, family: 'seedream', sizes: ['1K', '2K'] },
  { id: 'seedream-5.5', name: 'Seedream 5.5', credits: 12, family: 'seedream', sizes: ['1K', '1.5K', '2K'] },
  { id: 'gpt-image-2.5-flare-oai', name: '全能图片 G2.5 F OAI', family: 'gpt', sizes: gptSizes, qualities },
];

// Older open tabs may still submit the previous model IDs.
const legacyModels = [
  { id: 'gpt-image-2.5-flare', family: 'gpt', sizes: gptSizes, qualities },
  {
    id: 'gpt-image-2.5-sunburst-oai', family: 'gpt', sizes: gptSizes, qualities: [...qualities, ...premiumQualities],
    premium: { id: 'gpt-image-2.5-sunburst-max-oai' },
  },
];

export const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export function creditLabel(model, quality) {
  if (model.credits === undefined) return '积分待确认';
  const base = model.credits.toFixed(1);
  if (!model.premium) return base + ' 积分/张';
  const premium = model.premium.credits.toFixed(1);
  if (!quality) return base + '–' + premium + ' 积分/张';
  return (premiumQualities.includes(quality) ? premium : base) + ' 积分/张';
}

export function isTaskId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value);
}

export function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function pixels(size, ratio) {
  const longest = { '1K': 1024, '2K': 2048, '4K': 4096 }[size];
  const [w, h] = ratio.split(':').map(Number);
  const round = (edge) => Math.round(edge * longest / Math.max(w, h) / 16) * 16;
  return [round(w), round(h)].join('x');
}

function mimeType(url) {
  const extension = new URL(url).pathname.split('.').at(-1).toLowerCase();
  return { png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[extension] || 'image/jpeg';
}

export function generationRequest(input) {
  if (!input || typeof input !== 'object') throw new Error('无效的创作设置。');
  const { model: id, ratio, size, quality, references = [] } = input;
  const model = models.find((item) => item.id === id) ?? legacyModels.find((item) => item.id === id);
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt || prompt.length > 8000) throw new Error('请输入 1 至 8000 字的提示词。');
  if (!model || !model.sizes.includes(size) || !ratios.includes(ratio)) throw new Error('请选择有效的模型、比例和分辨率。');
  if (!Array.isArray(references) || references.length > 6 || references.some((url) => !imageUrl(url))) {
    throw new Error('最多填写 6 个有效的公网 HTTP(S) 参考图链接。');
  }

  if (model.family === 'gemini') {
    return {
      path: '/v1beta/models/' + id + ':generateContent',
      body: {
        contents: [{ role: 'user', parts: [
          { text: prompt },
          ...references.map((url) => ({ inlineData: { mimeType: mimeType(url), data: url } })),
        ] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { output: 'url', aspectRatio: ratio, imageSize: size } },
      },
    };
  }

  let body = { model: id, response_format: 'url' };
  if (model.family === 'gpt') {
    if (!model.qualities.includes(quality)) throw new Error('该模型不支持所选质量。');
    if (model.premium && premiumQualities.includes(quality)) body.model = model.premium.id;
    body = { ...body, prompt: '创建图片,' + prompt, size: pixels(size, ratio), quality };
  } else {
    body = { ...body, prompt: prompt + '\n画面比例 ' + ratio, size, aspect_ratio: ratio, n: 1, watermark: false };
  }
  if (references.length) body.image = references;
  return { path: '/v1/images/generations', body };
}
