// Aplica o tema antes de a página aparecer, para o modo escuro não piscar claro ao abrir.
// A escolha feita no botão vale mais que o tema do aparelho. O botão em si fica no app.mjs.
(() => {
  let saved = null;
  try {
    saved = localStorage.getItem('ctrlgirl_theme');
  } catch {
    // Sem acesso ao armazenamento: segue o tema do aparelho.
  }
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
