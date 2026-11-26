const copyAndMeasureScript = `
function reportHeight() {
  window.ReactNativeWebView.postMessage(JSON.stringify({height: Math.ceil(document.documentElement.scrollHeight)}));
}
window.addEventListener('load', reportHeight);
window.addEventListener('resize', reportHeight);
document.addEventListener('click', function(event) {
  const link = event.target.closest('[data-math-link]');
  if (!link) return;
  event.preventDefault();
  window.ReactNativeWebView.postMessage(JSON.stringify({link: link.getAttribute('data-math-link')}));
});
document.addEventListener('copy', function(event) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed || !event.clipboardData) return;
  const range = selection.getRangeAt(0).cloneRange();
  function wrapper(node) { return (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-copy-source]'); }
  const start = wrapper(range.startContainer), end = wrapper(range.endContainer);
  if (start) range.setStartBefore(start);
  if (end) range.setEndAfter(end);
  const content = document.createElement('div');
  content.appendChild(range.cloneContents());
  content.querySelectorAll('[data-copy-source]').forEach(function(node) {
    node.replaceWith(document.createTextNode(node.getAttribute('data-copy-source') || ''));
  });
  event.clipboardData.setData('text/plain', content.textContent || '');
  event.preventDefault();
});
`;

function safeColor(color: string): string {
  return /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(color) ? color : "#808080";
}

export function mathDocument(
  html: string,
  color: string,
  fontSize: number,
  lineHeight: number,
  linkColor: string,
  fontFamily: string,
  preserveSoftBreaks: boolean,
): string {
  const family = /^[\w -]+$/.test(fontFamily) ? `"${fontFamily}"` : "-apple-system";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body{margin:0;padding:0;background:transparent;color:${safeColor(color)};font:${Math.max(8, Math.min(fontSize, 48))}px/${Math.max(8, Math.min(lineHeight, 80))}px ${family},-apple-system,BlinkMacSystemFont,sans-serif;overflow-wrap:anywhere;white-space:${preserveSoftBreaks ? "pre-wrap" : "normal"}} math{white-space:normal} .display{display:block;overflow-x:auto;padding:4px 0} .math-source-block+.math-source-block{margin-top:8px} p{margin:0} li p{margin:0} ul,ol{margin:0;padding-left:1.5em} blockquote{margin:0;padding-left:1em;border-left:2px solid currentColor} table{border-collapse:collapse} td{border:1px solid currentColor;padding:4px} a{color:${safeColor(linkColor)};text-decoration:none} code{font-family:monospace} .plain-value{font-variant-numeric:tabular-nums}</style></head><body>${html}<script>${copyAndMeasureScript}</script></body></html>`;
}
