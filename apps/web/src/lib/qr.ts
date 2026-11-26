import qrcode from 'qrcode-generator';

/** A QR code for `text` as an `<svg>` string that scales to its container. */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}
