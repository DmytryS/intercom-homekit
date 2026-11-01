import dgram from 'node:dgram';

export function bindUdp(type: 'udp4' | 'udp6', address?: string, port = 0): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket(type);
    s.once('error', reject);
    s.bind(port, address, () => {
      s.off('error', reject);
      resolve(s);
    });
  });
}

/** Find an even local port whose successor is also free (ffmpeg binds RTP and RTCP on port and port+1). */
export async function allocPortPair(address = '127.0.0.1'): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const a = await bindUdp('udp4', address);
    const port = a.address().port;
    if (port % 2 !== 0 || port >= 65535) {
      a.close();
      continue;
    }
    const b = await bindUdp('udp4', address, port + 1).catch(() => undefined);
    a.close();
    if (b) {
      b.close();
      return port;
    }
  }
  throw new Error('No free UDP port pair');
}
