const gptSizes = ['1K', '2K', '4K'];
const geminiSizes = ['1K', '2K', '4K'];
const qualities = ['low', 'medium', 'high'];

export const models = [
  { id: 'gemini-nano-banana-2.1', name: '全能图片 2.1', family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-3.1-flash-lite-image', name: '全能图片 2 Lite', family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-3.1-flash-image-preview', name: '全能图片 2', family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-3-pro-image-preview', name: '全能图片 Pro', family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-3-pro-image-preview-vip', name: '全能图片 Pro VIP', family: 'gemini', sizes: geminiSizes },
  { id: 'gemini-3-pro-image-preview-svip', name: '全能图片 Pro SVIP', family: 'gemini', sizes: geminiSizes },
  { id: 'gpt-image-2.5-flare', name: '全能图片 G2.5', family: 'gpt', sizes: gptSizes, qualities },
  { id: 'gpt-image-2-oai', name: '全能图片 G2 OAI', family: 'gpt', sizes: gptSizes, qualities },
  { id: 'gpt-image-2.5-flare-oai', name: '全能图片 G2.5 F OAI', family: 'gpt', sizes: gptSizes, qualities },
  { id: 'gpt-image-2.5-sunburst-oai', name: '全能图片 G2.5 S OAI', family: 'gpt', sizes: gptSizes, qualities: [...qualities, 'xhigh', 'max'] },
  { id: 'doubao-seedream-5-0', name: 'Seedream 5.0', family: 'seedream', sizes: ['2K', '4K'] },
  { id: 'seedream-5-pro', name: 'Seedream 5 Pro', family: 'seedream', sizes: ['1K', '2K'] },
];

export const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

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
  const model = models.find((item) => item.id === id);
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
    if (['xhigh', 'max'].includes(quality)) body.model = 'gpt-image-2.5-sunburst-max-oai';
    body = { ...body, prompt: '创建图片,' + prompt, size: pixels(size, ratio), quality };
  } else {
    body = { ...body, prompt: prompt + '\n画面比例 ' + ratio, size, aspect_ratio: ratio, n: 1, watermark: false };
  }
  if (references.length) body.image = references;
  return { path: '/v1/images/generations', body };
}
