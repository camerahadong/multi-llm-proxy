/** Minimal markdown → HTML renderer for the live /guide endpoint. */
export function renderMarkdown(md: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let html = escape(md);

  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, lang, code) => `<pre><code class="lang-${lang}">${code}</code></pre>`,
  );
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  html = html
    .replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  html = html.replace(/((?:^\|[^\n]+\|\n)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter((r) => !/^\|[\s\-:|]+\|$/.test(r));
    const cells = rows.map((r) => r.split('|').slice(1, -1).map((c) => c.trim()));
    if (cells.length === 0) return block;
    const head = `<thead><tr>${cells[0].map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
    const body = `<tbody>${cells
      .slice(1)
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody>`;
    return `<table>${head}${body}</table>`;
  });

  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/(^|\n)([^\n<#|][^\n]*?)(?=\n)/g, (m, lead, line) =>
    line.trim() ? `${lead}<p>${line}</p>` : m,
  );

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>API Guide</title>
<style>
body{max-width:900px;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.6;color:#222}
h1,h2,h3{border-bottom:1px solid #eee;padding-bottom:.3rem;margin-top:2rem}
code{background:#f4f4f4;padding:1px 5px;border-radius:3px;font-size:.9em}
pre{background:#1e1e2e;color:#cdd6f4;padding:1rem;border-radius:6px;overflow-x:auto}
pre code{background:transparent;color:inherit;padding:0}
table{border-collapse:collapse;margin:1rem 0;width:100%}
th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
th{background:#f8f8f8}
hr{border:none;border-top:1px solid #ddd;margin:2rem 0}
</style></head><body>${html}</body></html>`;
}
