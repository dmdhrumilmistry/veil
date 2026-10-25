import { useEffect, useState } from 'preact/hooks';
import type { Contact, Message, Profile, Settings } from '../storage/repo';
import { DEFAULT_SETTINGS } from '../storage/repo';

export type Phase = 'loading' | 'unsupported' | 'onboarding' | 'locked' | 'ready' | 'handoff' | 'restoring' | 'elsewhere';

export type ConnectFlow =
  | {
      mode: 'invite';
      /** `link`: a long-lived invite link (needs a mailbox). Others: the live one-time code flow. */
      step: 'creating' | 'link' | 'waiting' | 'connecting' | 'error';
      code?: string;
      link?: string;
      error?: string;
      forContact?: string;
      expires?: number;
    }
  | {
      mode: 'join';
      /** `confirm`: reviewing an invite link; `requested`: join sent, waiting for them. */
      step: 'input' | 'creating' | 'waiting' | 'connecting' | 'error' | 'confirm' | 'requested';
      code?: string;
      link?: string;
      error?: string;
      peerName?: string;
    };

export interface InviteSummary {
  iid: string;
  created: number;
  expires: number;
  claimed: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export type Presence = 'connecting' | 'online';

export interface AppState {
  phase: Phase;
  myId: string;
  profile: Profile;
  settings: Settings;
  contacts: Contact[];
  messages: Record<string, Message[]>;
  presence: Record<string, Presence>;
  typing: Record<string, number>;
  activeChat?: string;
  connect: ConnectFlow | null;
  toasts: Toast[];
  /** Live transfer progress (bytes) keyed by fileId; avoids rewriting messages on every chunk. */
  progress: Record<string, number>;
  handoffMessage?: string;
  view: 'chats' | 'settings' | 'info';
  restoring?: { phase: string; done: number; total: number };
  /** Why this window is inactive: another one is open, or took over from us. */
  elsewhere?: 'open' | 'taken';
  /** A new app version is installed and waiting for a reload. */
  updateReady?: boolean;
  /** Contacts we can message while they are offline (mailbox + ratchet ready). */
  offline: Record<string, boolean>;
  /** Connection state of each public relay we read from. */
  relayStatus: { url: string; state: 'connecting' | 'open' | 'closed' }[];
  /** Active invite links we created. */
  invites: InviteSummary[];
}

type Listener = () => void;

class Store {
  state: AppState = {
    phase: 'loading',
    myId: '',
    profile: { name: '' },
    settings: DEFAULT_SETTINGS,
    contacts: [],
    messages: {},
    presence: {},
    typing: {},
    connect: null,
    toasts: [],
    progress: {},
    offline: {},
    invites: [],
    relayStatus: [],
    view: 'chats',
  };
  private listeners = new Set<Listener>();
  private scheduled = false;

  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    // Batch renders into one animation frame-ish microtask.
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        for (const l of this.listeners) l();
      });
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const store = new Store();

export function useApp(): AppState {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
  return store.state;
}

let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000) {
  const id = ++toastSeq;
  store.set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
