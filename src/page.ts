import { escapeHtml, renderReport } from "./markdown.ts";

const styles = `
  :root {
    font-family: system-ui, sans-serif;
    line-height: 1.65;
  }
  body { margin: 0; }
  .theme-option {
    position: absolute;
    width: 1px;
    height: 1px;
    clip-path: inset(50%);
    overflow: hidden;
  }
  .page {
    color-scheme: light;
    --bg: #f4f3ee;
    --paper: #fbfaf6;
    --ink: #29231e;
    --accent: #a94e2d;
    --muted: #66584d;
    --rule: #d8cbbd;
    --well: #eee7dc;
    min-height: 100vh;
    background: var(--bg);
    color: var(--ink);
    padding-inline: clamp(1rem, 5vw, 3rem);
  }
  #theme-dark:checked ~ .page {
    color-scheme: dark;
    --bg: #201c19;
    --paper: #2a2420;
    --ink: #f5eadc;
    --accent: #f1a77e;
    --muted: #ccbbac;
    --rule: #645247;
    --well: #382e28;
  }
  @media (prefers-color-scheme: dark) {
    #theme-system:checked ~ .page {
      color-scheme: dark;
      --bg: #201c19;
      --paper: #2a2420;
      --ink: #f5eadc;
      --accent: #f1a77e;
      --muted: #ccbbac;
      --rule: #645247;
      --well: #382e28;
    }
  }
  .shell { max-inline-size: 66rem; margin-inline: auto; }
  .masthead, .masthead nav, .rounds, .themes {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: .6rem 1rem;
  }
  .masthead {
    min-height: 4rem;
    padding-block: .75rem;
    justify-content: space-between;
    border-bottom: 1px solid var(--rule);
  }
  .wordmark { color: var(--ink); text-decoration: none; font-weight: 750; }
  main { padding-block: clamp(1rem, 4vw, 2.75rem) 4rem; }
  a { color: var(--accent); text-underline-offset: .19em; }
  .themes { gap: .35rem; font-size: .875rem; }
  .themes label, .rounds a { padding: .25rem .65rem; border: 1px solid transparent; border-radius: .35rem; }
  .themes label { cursor: pointer; }
  .rounds { margin-block-end: .85rem; }
  #theme-system:checked ~ .page label[for=theme-system],
  #theme-light:checked ~ .page label[for=theme-light],
  #theme-dark:checked ~ .page label[for=theme-dark],
  .rounds [aria-current=page] { border-color: var(--rule); background: var(--paper); color: var(--ink); }
  #theme-system:focus-visible ~ .page label[for=theme-system],
  #theme-light:focus-visible ~ .page label[for=theme-light],
  #theme-dark:focus-visible ~ .page label[for=theme-dark] { outline: 2px solid var(--accent); }
  .summary, article {
    background: var(--paper);
    border: 1px solid var(--rule);
    padding: clamp(1rem, 4vw, 2.75rem);
    overflow-wrap: anywhere;
  }
  .summary { padding-block: .85rem; border-inline-start: .25rem solid var(--accent); margin-block-end: .75rem; }
  .summary p { margin-block: .2rem; }
  .source-status { color: var(--muted); font-size: .9rem; }
  article h1, article h2, article h3 { font-family: Georgia, "Noto Serif TC", serif; line-height: 1.25; }
  article h1 { font-size: clamp(1.85rem, 4vw, 3rem); margin-block-start: 0; }
  article h2 { margin-block-start: 1.8em; }
  article table { border-collapse: collapse; inline-size: 100%; }
  article :is(th, td) { padding: .45rem .65rem; border-block-end: 1px solid var(--rule); vertical-align: top; }
  article th { background: var(--well); }
  article pre { overflow: auto; padding: .75rem; background: var(--well); }
  article .raw-html { white-space: pre-wrap; }
  article img { max-inline-size: 100%; block-size: auto; }
`;

function roundNavigation(round: 1 | 2): string {
  return `<nav class="rounds" aria-label="審查輪次">
  <a href="/sample?round=1"${round === 1 ? ' aria-current="page"' : ""}>Round 1</a>
  <a href="/sample?round=2"${round === 2 ? ' aria-current="page"' : ""}>Round 2</a>
</nav>`;
}

export function reportPage(title: string, body: string, round?: 1 | 2): string {
  const { html, header } = renderReport(body);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="pr-review-cloud-version" content="1">
  <title>${escapeHtml(title)} · PR Review Cloud</title>
  <style>${styles}</style>
</head>
<body>
  <input class="theme-option" type="radio" name="theme" id="theme-system" checked>
  <input class="theme-option" type="radio" name="theme" id="theme-light">
  <input class="theme-option" type="radio" name="theme" id="theme-dark">
  <div class="page">
    <div class="shell">
      <header class="masthead">
        <a class="wordmark" href="/">PR Review Cloud</a>
        <nav aria-label="網站導覽">
          <a href="/sample">公開範例</a>
          <a href="https://gggodlin.com" rel="noopener noreferrer">GGGODLIN</a>
          <a href="https://github.com/GGGODLIN/claude-pr-review" rel="noopener noreferrer">GitHub</a>
        </nav>
        <div class="themes" role="group" aria-label="色彩主題">
          <label for="theme-system">系統</label>
          <label for="theme-light">淺色</label>
          <label for="theme-dark">深色</label>
        </div>
      </header>
      <main>
        ${round ? roundNavigation(round) : ""}
        <aside class="summary" aria-label="報告資訊">
          ${header ? `<p><strong>${header.title}</strong></p>` : ""}
          ${header?.pr ? `<p>${header.pr}</p>` : ""}
          ${header?.continuity ? `<p>跨輪對帳 · ${escapeHtml(header.continuity)}</p>` : ""}
          <p class="source-status">狀態以原報告內容為準</p>
        </aside>
        <article>${html}</article>
      </main>
    </div>
  </div>
</body>
</html>`;
}
