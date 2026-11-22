import { CASE_STUDY, INSTALL_GUIDE, NPM, PORTFOLIO, REPO, VERSION } from '../site';
import { Wrap } from './Layout';

const LINKS = [
  { label: 'Case study', href: CASE_STUDY },
  { label: 'Install guide', href: INSTALL_GUIDE },
  { label: 'npm', href: NPM },
  { label: 'GitHub', href: REPO },
];

export function Footer() {
  return (
    <footer className="border-t border-rule2">
      <Wrap className="flex flex-wrap justify-between gap-4 py-8 text-sm text-mute">
        <span>
          MIT · v{VERSION} · Built by{' '}
          <a href={PORTFOLIO} className="hover:text-ink">
            Jeffery Orazulike
          </a>
        </span>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          {LINKS.map((l) => (
            <a key={l.label} href={l.href} className="hover:text-ink">
              {l.label}
            </a>
          ))}
        </nav>
      </Wrap>
    </footer>
  );
}
