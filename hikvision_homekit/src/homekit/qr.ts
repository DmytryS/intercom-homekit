import { encode } from 'uqr';

const BLACK_ON_WHITE = '\x1b[30;47m';
const RESET = '\x1b[0m';

/**
 * A QR code as text: half-block characters (two module rows per line, so it stays compact and
 * roughly square) drawn black on white with ANSI colours, so it scans in both light and dark
 * log viewers. A HomeKit setup URI fits in a 21×21 code: 13 lines with the quiet zone.
 */
export function qrLines(text: string, color = true): string[] {
  const { data } = encode(text, { ecc: 'M', border: 2 });
  const lines: string[] = [];
  for (let y = 0; y < data.length; y += 2) {
    let line = '';
    for (let x = 0; x < data[y].length; x++) {
      const top = data[y][x];
      const bottom = data[y + 1]?.[x] ?? false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(color ? BLACK_ON_WHITE + line + RESET : line);
  }
  return lines;
}
