import type { DecodedPart } from './command-preview.js';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** All command content is escaped text, never executable markup. */
export function renderAgentHistory(history: unknown): string {
  const data = history as {label?: string; records?: Record<string, unknown>[]} | null;
  const records = data?.records ?? [];
  const cards = records.map((r, i) => {
    const parts = (Array.isArray(r.decodedParts) ? r.decodedParts : []) as DecodedPart[];
    let readable = String(r.decodedInput ?? r.input ?? '无命令内容');
    for (const [j, part] of parts.entries()) if (part.expression) readable = readable.replace(part.expression, `[内容片段 ${j + 1}，见下方]`);
    const cwd = r.directoryBeforeInput as {cwd?: string; observedAt?: string} | undefined;
    return `<article><h2>操作 ${i + 1}</h2><p>${escape(r.time)} · ${escape(r.state)} · 执行完成状态：${escape(r.completion ?? '未知')}</p><p>发送前观测目录：${escape(cwd?.cwd ?? '未知')} ${escape(cwd?.observedAt ?? '')}</p><pre>${escape(readable)}</pre>${parts.map((part,j) => `<h3>内容片段 ${j + 1}</h3>${part.status === 'decoded' ? `<pre>${escape(part.text)}</pre>` : `<p>未解码：${escape(part.reason)}</p>`}`).join('')}${r.decodedInput ? `<details><summary>查看原始命令与完整解码外壳</summary><h3>原始命令</h3><pre>${escape(r.input)}</pre><h3>解码外壳</h3><pre>${escape(r.decodedInput)}</pre></details>` : ''}<details><summary>记录元数据</summary><pre>${escape(JSON.stringify({requestId:r.requestId,time:r.time,directoryBeforeInput:r.directoryBeforeInput},null,2))}</pre></details></article>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>操作记录</title><style>body{font:16px system-ui;margin:0;background:#121820;color:#e7edf5}main{max-width:1000px;margin:auto;padding:20px}article{background:#1b2430;border:1px solid #3b495b;border-radius:12px;padding:18px;margin:18px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#10151d;padding:14px;border-radius:8px;font:14px/1.6 monospace}p{overflow-wrap:anywhere;color:#b5c1d1}summary{cursor:pointer;padding:12px 0}h2{font-size:20px}h3{font-size:16px}</style></head><body><main><h1>${escape(data?.label ?? '会话不存在')}</h1><p>操作记录 · ${records.length} 条。内容仅供阅读，不执行。片段编号对应上方表达式，替换后的预览不用于直接执行。未识别的编码可能仍保留；记录不代表命令执行成功。</p>${cards || '<p>没有可显示的记录。</p>'}</main></body></html>`;
}
