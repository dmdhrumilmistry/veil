import { useState } from 'preact/hooks';
import { dismissInstall, promptInstall, useInstall } from '../state/install';
import { toast } from '../state/store';
import { Icon } from './icons';

/**
 * Install helper. `compact` renders a dismissible banner (sidebar); the full variant
 * lives in Settings and is always available while Veil runs in a browser tab.
 */
export function InstallCard({ compact }: { compact?: boolean }) {
  const { standalone, canPrompt, steps, dismissed } = useInstall();
  const [open, setOpen] = useState(!compact);
  if (standalone || (compact && dismissed) || (!canPrompt && !steps)) return null;

  const install = async () => {
    if (await promptInstall()) toast('Veil installed', 'success');
  };

  return (
    <div class={`install-card ${compact ? 'compact' : ''}`} role="region" aria-label="Install Veil">
      <div class="install-top">
        <span class="install-icon"><Icon name="download" size={18} /></span>
        <span class="install-text">
          <b>Install Veil</b>
          <span>Opens like a native app, works offline.</span>
        </span>
        {compact && (
          <button class="icon-btn sm" aria-label="Dismiss install suggestion" onClick={dismissInstall}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
      {canPrompt ? (
        <button class="btn primary sm" onClick={() => void install()}>
          <Icon name="download" size={16} /> Install app
        </button>
      ) : open ? (
        <ol class="install-steps">
          {steps!.map((s) => <li>{s}</li>)}
        </ol>
      ) : (
        <button class="btn ghost sm" onClick={() => setOpen(true)}>Show me how</button>
      )}
    </div>
  );
}
