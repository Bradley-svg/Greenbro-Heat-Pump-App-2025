import { useVersion } from '@/hooks/useVersion';
import { brand } from '@/brand';
import '@/styles/about.css';

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

export function AboutModal({ open, onClose }: AboutModalProps): JSX.Element | null {
  const { data: version } = useVersion(0);

  if (!open) {
    return null;
  }

  return (
    <div role="dialog" aria-modal="true" className="modal" aria-label={`About ${brand.product}`}>
      <div className="card">
        <header className="row">
          <img src={brand.logoWhite} alt={brand.name} height={24} />
          <h3>About {brand.product}</h3>
        </header>
        <dl className="kv">
          <dt>Build</dt>
          <dd>
            <code>{version?.build_sha?.slice(0, 7) ?? 'dev'}</code>
          </dd>
          <dt>Date</dt>
          <dd>{version?.build_date ?? '—'}</dd>
          <dt>Schema</dt>
          <dd>{version?.schema_ok ? 'OK' : 'Check'}</dd>
          <dt>Brand</dt>
          <dd>
            {brand.name} / {brand.nameCaps}
          </dd>
        </dl>
        <footer className="row">
          <a href="/brand/manifest.webmanifest" target="_blank" rel="noreferrer">
            Manifest
          </a>
          <a href="/brand/logo-white.svg" target="_blank" rel="noreferrer">
            White logo
          </a>
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
