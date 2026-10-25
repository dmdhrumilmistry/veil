import { useEffect, useRef } from 'preact/hooks';
import { toast } from '../state/store';

type Detector = { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> };

/** Native QR scanning (BarcodeDetector: Chrome/Edge on Android, macOS, ChromeOS). */
export const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices;

export function Scanner({ accept, onCode, onClose, hint }: { accept: (raw: string) => boolean; onCode: (raw: string) => void; onClose: () => void; hint?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const detector = new (window as unknown as { BarcodeDetector: new (o: object) => Detector }).BarcodeDetector({ formats: ['qr_code'] });
        const tick = async () => {
          if (stopped) return;
          try {
            const hit = (await detector.detect(v)).find((f) => accept(f.rawValue));
            if (hit) return onCode(hit.rawValue);
          } catch {
            /* frame not ready */
          }
          raf = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch {
        toast('Camera unavailable', 'error');
        onClose();
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return (
    <div class="scanner">
      <video ref={video} playsInline muted />
      <div class="scanner-frame" aria-hidden="true" />
      {hint && <p class="hint center">{hint}</p>}
      <button class="btn ghost sm" onClick={onClose}>Cancel scan</button>
    </div>
  );
}
