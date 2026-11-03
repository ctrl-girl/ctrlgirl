// Página do link compartilhado de matéria: o mesmo index.html do app, com título, resumo e imagem
// da matéria nas tags que WhatsApp, Telegram e as redes leem para montar a prévia.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ENTITIES[char]);

// O título e a descrição do site saem, e entram os da matéria.
const SITE_HEAD = /<title>[^<]*<\/title>\s*<meta name="description" content="[^"]*" \/>/;

function articlePageHtml(template, article, origin) {
  const title = article.title.trim();
  const url = `${origin}/materia/${article.id}`;
  const meta = {
    'og:type': 'article',
    'og:site_name': 'CTRL GIRL',
    'og:locale': 'pt_BR',
    'og:title': title,
    'og:description': article.summary,
    'og:url': url,
    'og:image': new URL(article.image, origin).href,
    'og:image:alt': article.imageAlt ?? title,
  };
  const head = [
    `<title>${escapeHtml(title)} | CTRL GIRL</title>`,
    `<meta name="description" content="${escapeHtml(article.summary)}" />`,
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    ...Object.entries(meta).map(([property, content]) => `<meta property="${property}" content="${escapeHtml(content)}" />`),
    '<meta name="twitter:card" content="summary_large_image" />',
  ].join('\n  ');
  // Com função, um "$&" no título continua texto, em vez de virar padrão de substituição.
  return template.replace(SITE_HEAD, () => head);
}

module.exports = { articlePageHtml, SITE_HEAD };
