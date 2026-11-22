/** Links, commands and asset paths shared across the page. */
export const VERSION = __CLI_VERSION__;

/** The hero badge's feature and the minor release that introduced it. */
const HIGHLIGHT = { since: '0.2', text: 'networks across machines' };
/** "new in 0.2 · ..." during that minor, then the current version, so the badge never goes stale. */
export const BADGE = `${VERSION.startsWith(`${HIGHLIGHT.since}.`) ? `new in ${HIGHLIGHT.since}` : `v${VERSION}`} · ${HIGHLIGHT.text}`;

export const REPO = 'https://github.com/logickoder/agent-bridge';
export const DOCS = `${REPO}/tree/main/docs`;
export const INSTALL_GUIDE = `${REPO}/blob/main/docs/install.md`;
export const NETWORKS_DOC = `${REPO}/blob/main/docs/concepts.md#networks`;
export const NPM = 'https://www.npmjs.com/package/@logickoder/agent-bridge';
export const PORTFOLIO = 'https://logickoder.dev';
export const CASE_STUDY = 'https://logickoder.dev/projects/agent-bridge/';

export const INSTALL_NPM = 'npm install -g @logickoder/agent-bridge\nagent-bridge install';
export const INSTALL_SOURCE = [
  `git clone ${REPO}.git`,
  'cd agent-bridge && pnpm install && pnpm build',
  'node dist/cli.js install',
].join('\n');

export function asset(name: string): string {
  return `${import.meta.env.BASE_URL}assets/${name}`;
}
