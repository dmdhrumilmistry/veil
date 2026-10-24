import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from './icons';

/** Accessible dialog built on <dialog>: focus trapping, Esc to close and inert background for free. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, [onClose]);
  return (
    <dialog ref={ref} class={`modal ${wide ? 'wide' : ''}`} aria-labelledby="modal-title" onClick={(e) => e.target === ref.current && onClose()}>
      <div class="modal-body">
        <header class="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button class="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
