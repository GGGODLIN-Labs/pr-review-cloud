import { escapeHtml, renderReportWithMeta, type ContinuityCounts, type TocHeading } from "./markdown.ts";

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
    --open: #ef9a7c;
    --open-bg: rgba(239, 154, 124, 0.14);
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
  .table-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    margin-block: 1rem;
    border: 1px solid var(--rule);
    border-radius: 10px;
  }
  .table-scroll table {
    margin-block: 0;
    min-inline-size: 32rem;
  }
  .table-scroll tr:last-child td { border-block-end: none; }
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
    white-space: nowrap;
  }
  article td[data-status] {
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: .78rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  article td[data-status]::before {
    content: "";
    display: inline-block;
    width: .45rem;
    height: .45rem;
    border-radius: 50%;
    background: currentColor;
    margin-inline-end: .45rem;
    vertical-align: middle;
  }
  article td[data-status="FIXED"] { color: var(--pass); }
  article td[data-status="STILL_OPEN"] { color: var(--open); }
  article td[data-status="STALE"] { color: var(--stale); }
  .report-reader { position: relative; }
  .filter-radio {
    position: absolute;
    width: 1px;
    height: 1px;
    clip-path: inset(50%);
    overflow: hidden;
  }
  .convergence-card {
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 14px;
    padding: 1rem 1.25rem;
    margin-block-end: 1rem;
    box-shadow: var(--shadow-sm);
  }
  .convergence-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: .5rem 1rem;
  }
  .convergence-label {
    font-family: var(--font-mono);
    font-size: .78rem;
    color: var(--subtle);
    letter-spacing: 0.02em;
  }
  .convergence-rate {
    font-family: var(--font-mono);
    font-size: .85rem;
    font-weight: 600;
    color: var(--ink);
  }
  .convergence-pills {
    display: flex;
    flex-wrap: wrap;
    gap: .5rem;
    margin-block: .65rem .75rem;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: .4rem;
    padding: .22rem .65rem;
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: .78rem;
    font-weight: 500;
  }
  .status-pill::before {
    content: "";
    width: .45rem;
    height: .45rem;
    border-radius: 50%;
    background: currentColor;
  }
  .status-pill.is-fixed { color: var(--pass); background: var(--pass-bg); }
  .status-pill.is-open { color: var(--open); background: var(--open-bg); }
  .status-pill.is-stale { color: var(--stale); background: var(--stale-bg); }
  .convergence-bar {
    display: flex;
    height: 8px;
    border-radius: 999px;
    overflow: hidden;
    background: var(--well);
    gap: 2px;
  }
  .convergence-seg.is-fixed { background: var(--pass); }
  .convergence-seg.is-open { background: var(--open); }
  .convergence-seg.is-stale { background: var(--stale); }
  .reader-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: .6rem 1rem;
    margin-block-end: .85rem;
  }
  .finding-filters {
    display: inline-flex;
    align-items: center;
    gap: .25rem;
    padding: .2rem;
    border: 1px solid var(--rule);
    border-radius: 9px;
    background: var(--paper);
    font-size: .8125rem;
  }
  .finding-filters label {
    padding: .26rem .7rem;
    border-radius: 6px;
    border: 1px solid transparent;
    color: var(--muted);
    cursor: pointer;
    font-weight: 500;
  }
  .finding-filters label:hover { color: var(--ink); }
  #filter-all:checked ~ .reader-toolbar label[for=filter-all],
  #filter-open:checked ~ .reader-toolbar label[for=filter-open] {
    border-color: var(--rule);
    background: var(--raised);
    color: var(--ink);
  }
  #filter-all:focus-visible ~ .reader-toolbar label[for=filter-all],
  #filter-open:focus-visible ~ .reader-toolbar label[for=filter-open] {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  #filter-open:checked ~ article tr[data-row-status="FIXED"],
  #filter-open:checked ~ article tr[data-row-status="STALE"] {
    display: none;
  }
  .report-toc {
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 12px;
    padding: .65rem 1rem;
    margin-block-end: 1rem;
    font-size: .875rem;
  }
  .report-toc summary {
    cursor: pointer;
    font-weight: 500;
    color: var(--ink);
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .report-toc summary::-webkit-details-marker { display: none; }
  .report-toc summary::after {
    content: "展開";
    font-family: var(--font-mono);
    font-size: .75rem;
    color: var(--subtle);
    flex-shrink: 0;
    white-space: nowrap;
    margin-inline-start: .75rem;
  }
  .report-toc[open] summary::after { content: "收合"; }
  .report-toc ol {
    margin: .65rem 0 .2rem;
    padding-inline-start: 1.25rem;
    display: grid;
    gap: .3rem;
  }
  .report-toc li.toc-h3 { margin-inline-start: 1rem; list-style-type: circle; }
  .report-toc a { color: var(--muted); text-decoration: none; }
  .report-toc a:hover { color: var(--accent); text-decoration: underline; }
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
    padding: .95rem 1.1rem;
    border: 1px solid var(--rule);
    border-radius: 12px;
    background: var(--bg);
  }
  .workspace-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-block-end: 1.5rem;
  }
  .workspace-identity {
    display: flex;
    align-items: center;
    gap: .85rem;
  }
  .avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid var(--rule-strong);
    object-fit: cover;
    background: var(--well);
  }
  .workspace-header h1 { margin: 0; font-size: 1.6rem; line-height: 1.2; letter-spacing: -0.02em; }
  .workspace-login { margin: .15rem 0 0; color: var(--muted); font-size: .875rem; font-family: var(--font-mono); }
  .workspace-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr));
    gap: 1rem;
    margin-block-end: 1.5rem;
  }
  .workspace-grid section { margin-block: 0; }
  .card h2 { margin-block: 0 .65rem; font-size: 1.1rem; letter-spacing: -0.01em; }
  .quota-track {
    height: 8px;
    border-radius: 999px;
    background: var(--well);
    overflow: hidden;
    margin-block: .65rem .85rem;
  }
  .quota-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--pass);
  }
  .quota-fill.is-high { background: var(--open); }
  .report-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: .4rem .8rem;
  }
  .report-row-title { font-weight: 600; text-decoration: none; color: var(--ink); }
  .report-row-title:hover { color: var(--accent); text-decoration: underline; }
  .badge {
    display: inline-flex;
    align-items: center;
    padding: .15rem .55rem;
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: .75rem;
    font-weight: 500;
    background: var(--well);
    color: var(--muted);
  }
  .badge.is-shared { color: var(--pass); background: var(--pass-bg); }
  .key-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: .6rem 1rem;
  }
  .danger-confirm { display: inline-block; }
  .danger-confirm summary {
    display: inline-flex;
    align-items: center;
    min-height: 2.2rem;
    padding: .35rem .8rem;
    border-radius: 8px;
    border: 1px solid var(--danger);
    color: var(--danger);
    font-size: .85rem;
    font-weight: 500;
    cursor: pointer;
    list-style: none;
  }
  .danger-confirm summary::-webkit-details-marker { display: none; }
  .danger-confirm summary:hover { background: var(--danger-bg); }
  .danger-confirm[open] {
    display: block;
    margin-top: .5rem;
    padding: .75rem .9rem;
    border: 1px solid var(--danger);
    border-radius: 10px;
    background: var(--danger-bg);
  }
  .danger-confirm .confirm-note {
    margin: .5rem 0 .45rem;
    font-size: .85rem;
    color: var(--ink);
  }
  .report-actions {
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 14px;
    padding: 1rem 1.25rem;
    margin-block-end: 1rem;
    display: grid;
    gap: .85rem;
  }
  .report-actions-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: .6rem 1rem;
  }
  .pr-timeline {
    align-items: center;
    padding: .75rem 1rem;
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 14px;
    margin-block-end: 1rem;
  }
  .pr-timeline-label {
    font-family: var(--font-mono);
    font-size: .78rem;
    color: var(--subtle);
    margin-inline-end: .35rem;
  }
  .upload-form { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
  .hint { color: var(--muted); font-size: .85rem; margin: .45rem 0 0; }
  .workspace-meta { display: block; color: var(--muted); font-size: .825rem; margin-top: .3rem; font-family: var(--font-mono); }
  .copy-command {
    box-sizing: border-box;
    inline-size: 100%;
    font: inherit;
    font-family: var(--font-mono);
    font-size: .85rem;
    background: var(--well);
  }
  .intro-banner {
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 16px;
    padding: clamp(1.15rem, 3vw, 1.65rem);
    margin-block-end: 1.5rem;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem 1.5rem;
  }
  .intro-copy { max-inline-size: 40rem; }
  .intro-eyebrow {
    font-family: var(--font-mono);
    font-size: .75rem;
    color: var(--accent);
    letter-spacing: 0.04em;
    margin: 0 0 .35rem;
  }
  .intro-title {
    font-size: clamp(1.2rem, 2.4vw, 1.5rem);
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 .35rem;
    line-height: 1.3;
  }
  .intro-desc {
    margin: 0;
    color: var(--muted);
    font-size: .925rem;
  }
  .intro-actions {
    display: flex;
    flex-wrap: wrap;
    gap: .6rem;
    align-items: center;
  }
  .signin-card {
    max-inline-size: 36rem;
    margin: clamp(1.5rem, 6vw, 4rem) auto;
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 16px;
    padding: clamp(1.5rem, 4vw, 2.25rem);
    box-shadow: var(--shadow-float);
  }
  .signin-card h1 {
    margin: 0 0 .6rem;
    font-size: 1.55rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.25;
  }
  .signin-card p { margin: 0 0 1rem; color: var(--muted); }
  .trust-list {
    list-style: none;
    padding: 0;
    margin: 1rem 0 1.4rem;
    border-top: 1px solid var(--rule);
  }
  .trust-list li {
    padding: .55rem 0;
    border-bottom: 1px solid var(--rule);
    font-size: .875rem;
    color: var(--ink);
  }
  .trust-list li span { color: var(--muted); }
  .site-footer {
    margin-top: auto;
    padding: 1.5rem 0 2.25rem;
    border-top: 1px solid var(--rule);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: .75rem 1.5rem;
    font-size: .8125rem;
    color: var(--subtle);
  }
  .site-footer nav {
    display: flex;
    flex-wrap: wrap;
    gap: .5rem 1.25rem;
  }
  .site-footer a {
    color: var(--muted);
    text-decoration: none;
  }
  .site-footer a:hover { color: var(--ink); }
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

export function robotsTxtResponse(): Response {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Allow: /sample",
    "Disallow: /workspace",
    "Disallow: /s/",
    "Disallow: /auth/",
    "Disallow: /api/",
    "",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function llmsTxtResponse(): Response {
  const body = [
    "# PR Review Cloud",
    "",
    "> Zero-LLM-burn cloud workspace for storing, comparing, and sharing multi-axis pull request review reports produced locally by claude-pr-review.",
    "",
    "## Public Routes",
    "",
    "- [Live 2-round sample](https://app.gggodlin.com/sample): Interactive read-only demonstration of Round 1 and Round 2 finding reconciliation (`FIXED`, `STILL_OPEN`, `STALE`).",
    "- [Workspace sign-in](https://app.gggodlin.com/workspace): Private workspace authenticated with GitHub OAuth (`read:user` scope only; no repository access).",
    "- [GGGODLIN Labs home](https://gggodlin.com/): Product overview, pricing, privacy policy, terms of service, and refund policy.",
    "- [claude-pr-review CLI](https://github.com/GGGODLIN/claude-pr-review): Open-source local review runner that generates `Report projection schema: 2` and `3` Markdown reports.",
    "",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function homeIntroBanner(signedIn: boolean): string {
  return `<section class="intro-banner" aria-label="PR Review Cloud 簡介">
    <div class="intro-copy">
      <p class="intro-eyebrow">ZERO-LLM-BURN REVIEW HUB · SCHEMA 2</p>
      <p class="intro-title">本機多模型 PR 審查，雲端跨輪對帳與可撤銷分享</p>
      <p class="intro-desc">在開發機以開源 CLI 跑完審查並上傳 <code>.md</code> 報告；雲端不呼叫任何語言模型、不存模型金鑰，直接呈現每輪修復狀態。</p>
    </div>
    <div class="intro-actions">
      ${signedIn
        ? '<a class="btn btn-primary" href="/workspace">前往工作區</a>'
        : '<a class="btn btn-primary" href="/auth/github">Sign in with GitHub</a>'}
      <a class="btn" href="https://github.com/GGGODLIN/claude-pr-review" rel="noopener noreferrer">安裝開源 CLI</a>
    </div>
  </section>`;
}

export function signInRequiredPage(): Response {
  return htmlResponse("需要登入", `
    <section class="signin-card" aria-label="登入 PR Review Cloud 工作區">
      <p class="intro-eyebrow">GITHUB SIGN-IN · WORKSPACE</p>
      <h1>登入 PR Review Cloud 工作區</h1>
      <p>使用 GitHub 帳號登入後，即可保存本機 <code>claude-pr-review</code> 報告、對照同一 PR 的跨輪修復進度、簽發 CLI 上傳金鑰並建立可隨時撤銷的唯讀分享連結。</p>
      <ul class="trust-list">
        <li>最小權限授權：<span>僅向 GitHub 索取 <code>read:user</code> 身分識別，不存取任何程式碼儲存庫。</span></li>
        <li>預設私有保存：<span>所有上傳報告預設僅本人可讀，公開分享連結撤銷後立即回傳 404。</span></li>
        <li>零伺服器 LLM 費用：<span>伺服器端不代跑模型推論、不保存模型 API 金鑰。</span></li>
      </ul>
      <div class="intro-actions">
        <a class="btn btn-primary" href="/auth/github">Sign in with GitHub</a>
        <a class="btn" href="/sample">先看 2 輪公開範例</a>
      </div>
    </section>
  `, 401, false, {
    description: "登入 PR Review Cloud 工作區，管理本機多模型 PR 審查報告與可撤銷分享連結。",
    privatePage: true,
  });
}

export function errorPage(
  title: string,
  message: string,
  status: number,
  options: { signedIn?: boolean; backHref?: string; backLabel?: string } = {},
): Response {
  const { signedIn = false, backHref, backLabel } = options;
  const href = backHref ?? (signedIn ? "/workspace" : "/");
  const label = backLabel ?? (signedIn ? "返回工作區" : "返回首頁");
  return htmlResponse(title, `
    <section class="signin-card" aria-label="${escapeHtml(title)}">
      <p class="intro-eyebrow">HTTP ${status}</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <div class="intro-actions">
        <a class="btn btn-primary" href="${escapeHtml(href)}">${escapeHtml(label)}</a>
        <a class="btn" href="/sample">檢視公開範例</a>
      </div>
    </section>
  `, status, signedIn, { privatePage: true });
}

function roundNavigation(round: 1 | 2): string {
  return `<nav class="rounds" aria-label="審查輪次">
  <a href="/sample?round=1"${round === 1 ? ' aria-current="page"' : ""}>Round 1</a>
  <a href="/sample?round=2"${round === 2 ? ' aria-current="page"' : ""}>Round 2</a>
</nav>`;
}

export interface HtmlMetaOptions {
  description?: string;
  privatePage?: boolean;
}

const defaultDescription = "PR Review Cloud — 本機多模型 PR 審查的雲端報告工作區，提供跨輪修復對帳與即時可撤銷分享，伺服器零模型推論成本。";

export function htmlResponse(
  title: string,
  content: string,
  status = 200,
  signedIn = false,
  meta: HtmlMetaOptions = {},
): Response {
  const description = meta.description ?? defaultDescription;
  const fullTitle = `${title} · PR Review Cloud`;
  const seoMeta = meta.privatePage
    ? '  <meta name="robots" content="noindex">'
    : `  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(fullTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta name="twitter:card" content="summary">`;
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="pr-review-cloud-version" content="1">
  <meta name="description" content="${escapeHtml(description)}">
${seoMeta}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>${escapeHtml(fullTitle)}</title>
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
      <footer class="site-footer">
        <div>© 2026 GGGODLIN Labs · Zero-LLM-burn cloud workspace</div>
        <nav aria-label="頁尾連結">
          <a href="https://gggodlin.com/privacy" rel="noopener noreferrer">Privacy</a>
          <a href="https://gggodlin.com/terms" rel="noopener noreferrer">Terms</a>
          <a href="https://gggodlin.com/refund" rel="noopener noreferrer">Refunds</a>
          <a href="https://gggodlin.com" rel="noopener noreferrer">gggodlin.com</a>
          <a href="https://github.com/GGGODLIN/claude-pr-review" rel="noopener noreferrer">CLI</a>
        </nav>
      </footer>
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

function renderConvergenceCard(continuity: ContinuityCounts | null): string {
  if (!continuity) return "";
  const pct = continuity.total > 0 ? Math.round((continuity.fixed / continuity.total) * 100) : 100;
  const segments = [
    continuity.fixed > 0 ? `<span class="convergence-seg is-fixed" style="flex:${continuity.fixed}"></span>` : "",
    continuity.stillOpen > 0 ? `<span class="convergence-seg is-open" style="flex:${continuity.stillOpen}"></span>` : "",
    continuity.stale > 0 ? `<span class="convergence-seg is-stale" style="flex:${continuity.stale}"></span>` : "",
  ].join("");
  return `<section class="convergence-card" aria-label="跨輪修復收斂摘要">
    <div class="convergence-head">
      <span class="convergence-label">跨輪對帳 · ${escapeHtml(continuity.status)}</span>
      <span class="convergence-rate">${continuity.fixed} / ${continuity.total} 已修復（${pct}%）</span>
    </div>
    <div class="convergence-pills">
      <span class="status-pill is-fixed">FIXED · ${continuity.fixed}</span>
      <span class="status-pill is-open">STILL_OPEN · ${continuity.stillOpen}</span>
      <span class="status-pill is-stale">STALE · ${continuity.stale}</span>
    </div>
    ${segments ? `<div class="convergence-bar" role="img" aria-label="已修復 ${continuity.fixed}，未修復 ${continuity.stillOpen}，已過時 ${continuity.stale}">${segments}</div>` : ""}
  </section>`;
}

function renderToc(toc: TocHeading[]): string {
  if (toc.length < 2) return "";
  const items = toc.map((item) =>
    `<li class="toc-h${item.depth}"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`).join("");
  return `<details class="report-toc">
    <summary>章節目錄（${toc.length} 節）</summary>
    <ol>${items}</ol>
  </details>`;
}

function renderPrCommentBox(
  title: string,
  continuity: ContinuityCounts | null,
  stillOpenTitles: string[],
  shareUrl?: string,
): string {
  if (!continuity) return "";
  const lines = [
    `### PR Review Summary — ${title}`,
    `- Continuity: \`${continuity.raw}\``,
  ];
  if (stillOpenTitles.length > 0) {
    lines.push("- Still open:");
    for (const item of stillOpenTitles) {
      lines.push(`  - ${item}`);
    }
  }
  if (shareUrl) {
    lines.push(`- Full report: ${shareUrl}`);
  }
  const snippet = lines.join("\n");
  return `<details class="report-toc pr-comment-box">
    <summary>GitHub PR Comment 摘要（可直接貼回 PR）</summary>
    <p class="hint">由原報告對帳欄位確定性整理（零 LLM 重寫），選取後複製即可貼上。</p>
    <textarea class="copy-command" id="pr-comment-summary" name="pr_comment_summary" rows="${Math.min(10, lines.length + 1)}" readonly aria-label="GitHub PR Comment 摘要">${escapeHtml(snippet)}</textarea>
  </details>`;
}

export function reportPage(
  title: string,
  body: string,
  options: { round?: 1 | 2; intro?: string; actions?: string; signedIn?: boolean; privatePage?: boolean; shareUrl?: string } = {},
): Response {
  const { round, intro, actions, signedIn, privatePage, shareUrl } = options;
  const rendered = renderReportWithMeta(body);
  const canFilterOpen = rendered.hasStillOpenRows && rendered.hasResolvedOrStaleRows;
  const filterInputs = canFilterOpen ? `
    <input class="filter-radio" type="radio" name="finding-filter" id="filter-all" checked>
    <input class="filter-radio" type="radio" name="finding-filter" id="filter-open">
  ` : "";
  const filterControls = canFilterOpen ? `
    <div class="finding-filters" role="group" aria-label="篩選發現狀態">
      <label for="filter-all">全部項目（${rendered.totalStatusRowCount}）</label>
      <label for="filter-open">只看 STILL_OPEN（${rendered.stillOpenRowCount}）</label>
    </div>
  ` : "";
  return htmlResponse(title, `
    ${intro ?? ""}
    ${round ? roundNavigation(round) : ""}
    ${actions ?? ""}
    ${renderConvergenceCard(rendered.continuity)}
    ${renderToc(rendered.toc)}
    ${renderPrCommentBox(title, rendered.continuity, rendered.stillOpenTitles, shareUrl)}
    <div class="report-reader">
      ${filterInputs}
      <div class="reader-toolbar">
        <p class="source-status">狀態以原報告內容為準</p>
        ${filterControls}
      </div>
      <article>${rendered.html}</article>
    </div>
  `, 200, signedIn, { privatePage: privatePage ?? signedIn });
}
