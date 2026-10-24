import qrcode from 'qrcode-generator';
import { useEffect, useRef } from 'preact/hooks';

/** Renders a QR code to a canvas (no innerHTML/SVG strings, so it is Trusted Types safe). */
export function Qr({ value, label }: { value: string; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const qr = qrcode(0, 'L');
    qr.addData(value, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 3;
    const scale = Math.max(3, Math.floor(560 / (n + quiet * 2)));
    const size = (n + quiet * 2) * scale;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#0b0b14';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }, [value]);
  return <canvas ref={ref} class="qr" role="img" aria-label={label} />;
}
