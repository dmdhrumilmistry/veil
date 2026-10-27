import { useState } from 'preact/hooks';
import { saveSettings } from '../state/app';
import { notifyPermission, requestNotifyPermission } from '../state/notify';
import { toast, useApp } from '../state/store';
import { Icon } from './icons';

const DISMISS = 'veil-notify-prompt-dismissed';

/** Notifications are off by default (they need a user gesture); offer them once, clearly. */
export function NotifyPrompt() {
  const { settings } = useApp();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISS) === '1';
    } catch {
      return false;
    }
  });
  const perm = notifyPermission();
  if (hidden || settings.notifications || perm === 'denied' || perm === 'unsupported') return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS, '1');
    } catch {
      /* ignore */
    }
    setHidden(true);
  };
  return (
    <div class="install-card compact" role="region" aria-label="Turn on notifications">
      <div class="install-top">
        <span class="install-icon"><Icon name="bell" size={18} /></span>
        <span class="install-text">
          <b>Get notified</b>
          <span>{perm === 'needs-install' ? 'Install Veil to the Home Screen to get notifications on iPhone.' : 'Know when messages arrive while Veil is in the background. Never shows message text.'}</span>
        </span>
        <button class="icon-btn sm" aria-label="Dismiss" onClick={dismiss}><Icon name="x" size={16} /></button>
      </div>
      {perm !== 'needs-install' && (
        <button class="btn primary sm" onClick={async () => {
          if ((await requestNotifyPermission()) !== 'granted') return toast('Notifications were blocked in the browser', 'error');
          await saveSettings({ notifications: true });
          toast('Notifications on', 'success', 2000);
        }}>
          <Icon name="bell" size={16} /> Turn on notifications
        </button>
      )}
    </div>
  );
}
