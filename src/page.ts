import { escapeHtml, renderReport } from "./markdown.ts";

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#1c1a17"/>
  <rect x="2.5" y="2.5" width="27" height="27" rx="6" fill="none" stroke="#a94e2d" stroke-width="1.5"/>
  <circle cx="11.5" cy="11.5" r="3.2" fill="#4cc38a"/>
  <circle cx="20.5" cy="20.5" r="3.2" fill="#e08161"/>
  <path d="M11.5 14.7V20.5H17.3" fill="none" stroke="#efe9de" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

const styles = `
  :root {
    --font-sans: "IBM Plex Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --font-mono: "IBM Plex Mono", "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
    font-family: var(--font-sans);
    line-height: 1.65;
    background: #f4f3ee;
    color-scheme: light;
  }
  html:has(#theme-dark:checked) {
    background: #1c1a17;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    html:has(#theme-system:checked) {
      background: #1c1a17;
      color-scheme: dark;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    background: inherit;
    -webkit-font-smoothing: antialiased;
  }
  .theme-option {
    position: absolute;
    width: 1px;
    height: 1px;
    clip-path: inset(50%);
    overflow: hidden;
  }
  .skip-link {
    position: absolute;
    left: 1rem;
    top: -3rem;
    z-index: 50;
    padding: .5rem .9rem;
    border-radius: 8px;
    background: var(--primary-bg);
    color: var(--primary-text);
    text-decoration: none;
    font-size: .875rem;
    font-weight: 500;
  }
  .skip-link:focus { top: .75rem; }
  .page {
    color-scheme: light;
    --bg: #f4f3ee;
    --paper: #fbfaf6;
    --raised: #ebe9e1;
    --ink: #1c1a17;
    --muted: #57514a;
    --subtle: #6b655b;
    --accent: #a94e2d;
    --accent-hover: #93421f;
    --primary-bg: #a94e2d;
    --primary-bg-hover: #93421f;
    --primary-text: #ffffff;
    --rule: rgba(28, 26, 23, 0.12);
    --rule-strong: rgba(28, 26, 23, 0.22);
    --well: #ebe9e1;
    --pass: #2a7a46;
    --pass-bg: rgba(42, 122, 70, 0.12);
    --open: #a94e2d;
    --open-bg: rgba(169, 78, 45, 0.12);
    --stale: #6b655b;
    --stale-bg: rgba(107, 101, 91, 0.14);
    --danger: #b53d29;
    --danger-bg: rgba(181, 61, 41, 0.1);
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
    --shadow-float: 0 8px 24px rgba(0, 0, 0, 0.06);
    min-height: 100vh;
    background: var(--bg);
    color: var(--ink);
    padding-inline: clamp(1rem, 4vw, 2.5rem);
    display: flex;
    flex-direction: column;
  }
  #theme-dark:checked ~ .page {
    color-scheme: dark;
    --bg: #1c1a17;
    --paper: #23201c;
    --raised: #2c2924;
    --ink: #efe9de;
    --muted: #aaa398;
    --subtle: #8f897e;
    --accent: #e08161;
    --accent-hover: #ea9273;
    --primary-bg: #efe9de;
    --primary-bg-hover: #ffffff;
    --primary-text: #1c1a17;
    --rule: rgba(239, 233, 222, 0.1);
    --rule-strong: rgba(239, 233, 222, 0.2);
    --well: #2c2924;
    --pass: #4cc38a;
    --pass-bg: rgba(76, 195, 138, 0.14);
    --open: #e08161;
    --open-bg: rgba(224, 129, 97, 0.16);
    --stale: #aaa398;
    --stale-bg: rgba(170, 163, 152, 0.14);
    --danger: #ef7c6b;
    --danger-bg: rgba(239, 124, 107, 0.14);
    --shadow-sm: none;
    --shadow-float: 0 8px 24px rgba(0, 0, 0, 0.24);
  }
  @media (prefers-color-scheme: dark) {
    #theme-system:checked ~ .page {
      color-scheme: dark;
      --bg: #1c1a17;
      --paper: #23201c;
      --raised: #2c2924;
      --ink: #efe9de;
      --muted: #aaa398;
      --subtle: #8f897e;
      --accent: #e08161;
      --accent-hover: #ea9273;
      --primary-bg: #efe9de;
      --primary-bg-hover: #ffffff;
      --primary-text: #1c1a17;
      --rule: rgba(239, 233, 222, 0.1);
      --rule-strong: rgba(239, 233, 222, 0.2);
      --well: #2c2924;
      --pass: #4cc38a;
      --pass-bg: rgba(76, 195, 138, 0.14);
      --open: #e08161;
      --open-bg: rgba(224, 129, 97, 0.16);
      --stale: #aaa398;
      --stale-bg: rgba(170, 163, 152, 0.14);
      --danger: #ef7c6b;
      --danger-bg: rgba(239, 124, 107, 0.14);
      --shadow-sm: none;
      --shadow-float: 0 8px 24px rgba(0, 0, 0, 0.24);
    }
  }
  .shell {
    width: 100%;
    max-inline-size: 68rem;
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 6px;
  }
  .masthead, .masthead nav, .rounds, .themes {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: .5rem .85rem;
  }
  .masthead {
    min-height: 4rem;
    padding-block: .75rem;
    justify-content: space-between;
    border-bottom: 1px solid var(--rule);
  }
  .wordmark {
    color: var(--ink);
    text-decoration: none;
    font-size: 1.0625rem;
    font-weight: 600;
    letter-spacing: -0.015em;
    display: inline-flex;
    align-items: center;
    gap: .5rem;
  }
  .masthead nav { gap: .25rem 1.25rem; font-size: .875rem; }
  .masthead nav a {
    color: var(--muted);
    text-decoration: none;
    padding-block: .25rem;
    transition: color 150ms var(--ease);
  }
  .masthead nav a:hover { color: var(--ink); }
  .masthead nav a.nav-cta {
    padding: .35rem .8rem;
    border-radius: 8px;
    border: 1px solid var(--rule-strong);
    background: var(--paper);
    color: var(--ink);
    font-weight: 500;
  }
  .masthead nav a.nav-cta:hover { background: var(--raised); }
  main { padding-block: clamp(1.25rem, 4vw, 2.5rem) 4rem; flex: 1; }
  a { color: var(--accent); text-underline-offset: .2em; }
  a:hover { color: var(--accent-hover); }
  .themes {
    gap: .2rem;
    font-size: .8125rem;
    padding: .2rem;
    border: 1px solid var(--rule);
    border-radius: 9px;
    background: var(--paper);
  }
  .themes label {
    padding: .25rem .6rem;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--muted);
    cursor: pointer;
    transition: background-color 150ms var(--ease), color 150ms var(--ease);
  }
  .themes label:hover { color: var(--ink); }
  #theme-system:checked ~ .page label[for=theme-system],
  #theme-light:checked ~ .page label[for=theme-light],
  #theme-dark:checked ~ .page label[for=theme-dark] {
    border-color: var(--rule);
    background: var(--raised);
    color: var(--ink);
    font-weight: 500;
  }
  #theme-system:focus-visible ~ .page label[for=theme-system],
  #theme-light:focus-visible ~ .page label[for=theme-light],
  #theme-dark:focus-visible ~ .page label[for=theme-dark] {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .rounds {
    margin-block-end: 1rem;
    gap: .4rem;
  }
  .rounds a {
    display: inline-flex;
    align-items: center;
    gap: .4rem;
    padding: .42rem .9rem;
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    text-decoration: none;
    font-size: .875rem;
    font-weight: 500;
    transition: background-color 150ms var(--ease), border-color 150ms var(--ease), color 150ms var(--ease);
  }
  .rounds a:hover { background: var(--paper); color: var(--ink); border-color: var(--rule-strong); }
  .rounds [aria-current=page] {
    border-color: var(--accent);
    background: var(--paper);
    color: var(--ink);
    box-shadow: var(--shadow-sm);
  }
  .btn, button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: .4rem;
    min-height: 2.35rem;
    padding: .45rem 1rem;
    border-radius: 8px;
    border: 1px solid var(--rule-strong);
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: .875rem;
    font-weight: 500;
    line-height: 1.25;
    text-decoration: none;
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    transition: background-color 150ms var(--ease), border-color 150ms var(--ease), color 150ms var(--ease);
  }
  .btn:hover, button:hover { background: var(--raised); color: var(--ink); }
  .btn-primary, button.btn-primary {
    background: var(--primary-bg);
    border-color: transparent;
    color: var(--primary-text);
  }
  .btn-primary:hover, button.btn-primary:hover {
    background: var(--primary-bg-hover);
    color: var(--primary-text);
  }
  .btn-danger, button.btn-danger {
    color: var(--danger);
    border-color: var(--danger);
    background: transparent;
  }
  .btn-danger:hover, button.btn-danger:hover {
    background: var(--danger-bg);
    color: var(--danger);
  }
  input[type="text"], input[type="search"], textarea, input[type="file"] {
    font: inherit;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--rule-strong);
    border-radius: 8px;
    padding: .5rem .75rem;
  }
  input[type="file"] {
    padding: .45rem .65rem;
    max-inline-size: 100%;
  }
  input[type="checkbox"] {
    accent-color: var(--accent);
    width: 1rem;
    height: 1rem;
    vertical-align: middle;
  }
  code {
    font-family: var(--font-mono);
    font-size: .875em;
    padding: .12rem .38rem;
    border-radius: 5px;
    background: var(--well);
  }
  pre code {
    padding: 0;
    background: transparent;
    border-radius: 0;
    font-size: .85rem;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: .8em;
    padding: .12rem .4rem;
    border-radius: 5px;
    border: 1px solid var(--rule-strong);
    border-bottom-width: 2px;
    background: var(--paper);
  }
  blockquote {
    margin: 1rem 0;
    padding: .75rem 1rem;
    border-inline-start: 3px solid var(--accent);
    background: var(--well);
    border-radius: 0 8px 8px 0;
    color: var(--muted);
  }
  blockquote > :first-child { margin-block-start: 0; }
  blockquote > :last-child { margin-block-end: 0; }
  article {
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 16px;
    padding: clamp(1.25rem, 4vw, 2.75rem);
    box-shadow: var(--shadow-float);
    overflow-wrap: break-word;
  }
  .source-status {
    color: var(--subtle);
    font-size: .8125rem;
    font-family: var(--font-mono);
    margin: 0 0 .75rem;
  }
  article h1, article h2, article h3 {
    font-family: var(--font-sans);
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.25;
  }
  article h1 { font-size: clamp(1.6rem, 3.6vw, 2.35rem); margin-block: 0 1rem; }
  article h2 {
    font-size: clamp(1.25rem, 2.4vw, 1.55rem);
    margin-block: 2rem .75rem;
    padding-block-end: .4rem;
    border-bottom: 1px solid var(--rule);
  }
  article h3 { font-size: 1.05rem; margin-block: 1.5rem .6rem; }
  article table {
    border-collapse: collapse;
    inline-size: 100%;
    font-size: .925rem;
    margin-block: 1rem;
  }
  article :is(th, td) {
    padding: .65rem .8rem;
    border-block-end: 1px solid var(--rule);
    vertical-align: top;
    text-align: left;
  }
  article th {
    background: var(--well);
    font-weight: 600;
    font-size: .8125rem;
    color: var(--muted);
  }
  article pre {
    overflow: auto;
    padding: .9rem 1rem;
    background: var(--well);
    border: 1px solid var(--rule);
    border-radius: 10px;
  }
  article .raw-html { white-space: pre-wrap; }
  article img { max-inline-size: 100%; block-size: auto; border-radius: 8px; }
  section { margin-block: 1.5rem; }
  .card {
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 16px;
    padding: clamp(1.15rem, 3vw, 1.75rem);
    box-shadow: var(--shadow-sm);
  }
  form { margin-block: .6rem; }
  .workspace-list { padding-inline-start: 0; list-style: none; display: grid; gap: .75rem; }
  .workspace-list li {
    padding: .9rem 1rem;
    border: 1px solid var(--rule);
    border-radius: 12px;
    background: var(--bg);
  }
  .workspace-meta { display: block; color: var(--muted); font-size: .85rem; margin-top: .25rem; }
  .copy-command {
    box-sizing: border-box;
    inline-size: 100%;
    font: inherit;
    font-family: var(--font-mono);
    font-size: .85rem;
    background: var(--well);
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; animation: none !important; }
  }
`;

export function faviconResponse(): Response {
  return new Response(faviconSvg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function roundNavigation(round: 1 | 2): string {
  return `<nav class="rounds" aria-label="審查輪次">
  <a href="/sample?round=1"${round === 1 ? ' aria-current="page"' : ""}>Round 1</a>
  <a href="/sample?round=2"${round === 2 ? ' aria-current="page"' : ""}>Round 2</a>
</nav>`;
}

export function htmlResponse(title: string, content: string, status = 200, signedIn = false): Response {
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="pr-review-cloud-version" content="1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>${escapeHtml(title)} · PR Review Cloud</title>
  <style>${styles}</style>
</head>
<body>
  <input class="theme-option" type="radio" name="theme" id="theme-system" checked>
  <input class="theme-option" type="radio" name="theme" id="theme-light">
  <input class="theme-option" type="radio" name="theme" id="theme-dark">
  <div class="page">
    <a class="skip-link" href="#main-content">跳至主要內容</a>
    <div class="shell">
      <header class="masthead">
        <a class="wordmark" href="/">PR Review Cloud</a>
        <nav aria-label="網站導覽">
          <a href="/sample">公開範例</a>
          ${signedIn ? '<a class="nav-cta" href="/workspace">工作區</a>' : '<a class="nav-cta" href="/auth/github">Sign in with GitHub</a>'}
          <a href="https://gggodlin.com" rel="noopener noreferrer">GGGODLIN</a>
          <a href="https://github.com/GGGODLIN/claude-pr-review" rel="noopener noreferrer">GitHub</a>
        </nav>
        <div class="themes" role="group" aria-label="色彩主題">
          <label for="theme-system">系統</label>
          <label for="theme-light">淺色</label>
          <label for="theme-dark">深色</label>
        </div>
      </header>
      <main id="main-content">
        ${content}
      </main>
    </div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": signedIn ? "same-origin" : "no-referrer",
      "Content-Security-Policy": "default-src 'none'; img-src https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

export function reportPage(title: string, body: string, options: { round?: 1 | 2; actions?: string; signedIn?: boolean } = {}): Response {
  const { round, actions, signedIn } = options;
  return htmlResponse(title, `
    ${round ? roundNavigation(round) : ""}
    ${actions ?? ""}
    <p class="source-status">狀態以原報告內容為準</p>
    <article>${renderReport(body)}</article>
  `, 200, signedIn);
}
