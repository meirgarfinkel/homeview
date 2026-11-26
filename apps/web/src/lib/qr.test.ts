import { expect, it } from 'vitest';
import { qrSvg } from './qr';

it('draws an address as an svg with a viewBox', () => {
  const svg = qrSvg('https://192.168.1.20:8090');
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg).toContain('viewBox');
});
