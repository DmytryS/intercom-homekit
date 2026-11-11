import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

/**
 * A small MQTT 3.1.1 client: QoS 0 publishing, QoS 0/1 delivery, retained messages,
 * last will, keepalive and automatic reconnects. Enough for Home Assistant discovery,
 * state and command topics without pulling a large dependency tree into the add-on.
 */

export interface MqttWill {
  topic: string;
  payload: string;
  retain?: boolean;
}

export interface MqttOptions {
  host: string;
  port: number;
  ssl?: boolean;
  username?: string;
  password?: string;
  clientId: string;
  keepaliveSec?: number;
  will?: MqttWill;
  /** Address to try when `host` doesn't resolve (e.g. an add-on hostname from a host-network add-on). */
  fallbackHosts?: string[];
}

export interface MqttMessage {
  topic: string;
  payload: Buffer;
  /** Delivered from the broker's retained store (sent before we subscribed), not live. */
  retain: boolean;
}

export interface MqttClientEvents {
  connect: [];
  close: [];
  error: [error: Error];
  message: [message: MqttMessage];
}

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const PUBACK = 4;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const PINGRESP = 13;
const DISCONNECT = 14;

const MAX_INCOMING = 1024 * 1024; // only small command messages are expected
const RECONNECT_MS = [1000, 2000, 5000, 10000, 30000];
const CONNACK_ERRORS: Record<number, string> = {
  1: 'unacceptable protocol version',
  2: 'client identifier rejected',
  3: 'server unavailable',
  4: 'bad username or password',
  5: 'not authorized',
};

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function lenString(s: string | Buffer): Buffer {
  const b = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  return Buffer.concat([u16(b.length), b]);
}

export function encodeRemainingLength(n: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return Buffer.from(bytes);
}

function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeRemainingLength(body.length), body]);
}

export function encodeConnect(o: Pick<MqttOptions, 'clientId' | 'username' | 'password' | 'will' | 'keepaliveSec'>): Buffer {
  let flags = 0x02; // clean session
  const payload = [lenString(o.clientId)];
  if (o.will) {
    flags |= 0x04 | (o.will.retain ? 0x20 : 0); // will QoS 0
    payload.push(lenString(o.will.topic), lenString(o.will.payload));
  }
  if (o.username) {
    flags |= 0x80;
    payload.push(lenString(o.username));
    if (o.password !== undefined) {
      flags |= 0x40;
      payload.push(lenString(o.password));
    }
  }
  const header = Buffer.concat([lenString('MQTT'), Buffer.from([4, flags]), u16(o.keepaliveSec ?? 60)]);
  return packet(CONNECT, 0, Buffer.concat([header, ...payload]));
}

export function encodePublish(topic: string, payload: string | Buffer, retain = false): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return packet(PUBLISH, retain ? 1 : 0, Buffer.concat([lenString(topic), body]));
}

export function encodeSubscribe(packetId: number, topics: string[], qos: 0 | 1 = 1): Buffer {
  return packet(SUBSCRIBE, 0x02, Buffer.concat([u16(packetId), ...topics.flatMap((t) => [lenString(t), Buffer.from([qos])])]));
}

/** Split complete packets off the front of `buf`; returns them and the unconsumed rest. */
export function readPackets(buf: Buffer): { packets: { type: number; flags: number; body: Buffer }[]; rest: Buffer } {
  const packets: { type: number; flags: number; body: Buffer }[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    let len = 0;
    let mul = 1;
    let i = off + 1;
    let complete = false;
    for (let n = 0; n < 4 && i < buf.length; n++, i++) {
      len += (buf[i] & 0x7f) * mul;
      mul *= 128;
      if ((buf[i] & 0x80) === 0) {
        complete = true;
        i++;
        break;
      }
    }
    if (!complete) {
      if (i - off - 1 >= 4) throw new Error('malformed MQTT remaining length');
      break;
    }
    if (len > MAX_INCOMING) throw new Error(`MQTT packet too large (${len} bytes)`);
    if (buf.length - i < len) break;
    packets.push({ type: buf[off] >> 4, flags: buf[off] & 0x0f, body: buf.subarray(i, i + len) });
    off = i + len;
  }
  return { packets, rest: buf.subarray(off) };
}

export class MqttClient extends EventEmitter<MqttClientEvents> {
  private readonly opts: MqttOptions;
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private connectedFlag = false;
  private ended = false;
  private attempt = 0;
  private hostIndex = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private awaitingPing = 0;
  private nextPacketId = 1;
  private readonly subscriptions = new Set<string>();

  constructor(opts: MqttOptions) {
    super();
    this.opts = opts;
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  /** The broker address of the current (or last) connection attempt. */
  get address(): string {
    return `${this.hosts()[this.hostIndex]}:${this.opts.port}`;
  }

  private hosts(): string[] {
    return [this.opts.host, ...(this.opts.fallbackHosts ?? [])];
  }

  connect(): void {
    this.ended = false;
    this.open();
  }

  private open(): void {
    const host = this.hosts()[this.hostIndex];
    const { port } = this.opts;
    const socket = this.opts.ssl ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.setTimeout(15000, () => socket.destroy(new Error('connection timed out')));
    socket.once(this.opts.ssl ? 'secureConnect' : 'connect', () => socket.write(encodeConnect(this.opts)));
    socket.on('data', (d: Buffer) => this.onData(socket, d));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      // An add-on hostname may not resolve from a host-network container: try the fallback
      // next, and go back to the configured host if the fallback fails too.
      const hosts = this.hosts().length;
      if (hosts > 1 && !this.connectedFlag) {
        const dnsFailure = err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN';
        if (dnsFailure || this.hostIndex > 0) this.hostIndex = (this.hostIndex + 1) % hosts;
      }
      this.emit('error', err);
    });
    socket.on('close', () => this.onClose(socket));
  }

  private onData(socket: net.Socket, data: Buffer): void {
    if (socket !== this.socket) return;
    let parsed;
    try {
      parsed = readPackets(this.buffer.length ? Buffer.concat([this.buffer, data]) : data);
    } catch (err) {
      socket.destroy(err as Error);
      return;
    }
    this.buffer = Buffer.from(parsed.rest);
    for (const p of parsed.packets) this.onPacket(socket, p.type, p.flags, p.body);
  }

  private onPacket(socket: net.Socket, type: number, flags: number, body: Buffer): void {
    switch (type) {
      case CONNACK: {
        const rc = body[1];
        if (rc !== 0) {
          const err = new Error(`MQTT broker refused the connection: ${CONNACK_ERRORS[rc] ?? `code ${rc}`}`);
          if (rc === 4 || rc === 5) this.attempt = RECONNECT_MS.length; // don't hammer with bad credentials
          socket.destroy(err);
          return;
        }
        socket.setTimeout(0);
        this.connectedFlag = true;
        this.attempt = 0;
        this.awaitingPing = 0;
        const keepaliveMs = (this.opts.keepaliveSec ?? 60) * 1000;
        this.pingTimer = setInterval(() => {
          if (this.awaitingPing >= 2) {
            socket.destroy(new Error('MQTT keepalive timed out'));
            return;
          }
          this.awaitingPing++;
          socket.write(packet(PINGREQ, 0, Buffer.alloc(0)));
        }, keepaliveMs / 2);
        if (this.subscriptions.size) socket.write(encodeSubscribe(this.packetId(), [...this.subscriptions]));
        this.emit('connect');
        return;
      }
      case PUBLISH: {
        const qos = (flags >> 1) & 0x03;
        const topicLen = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + topicLen).toString('utf8');
        let off = 2 + topicLen;
        if (qos > 0) {
          const id = body.readUInt16BE(off);
          off += 2;
          if (qos === 1) socket.write(packet(PUBACK, 0, u16(id)));
        }
        this.emit('message', { topic, payload: Buffer.from(body.subarray(off)), retain: (flags & 0x01) === 1 });
        return;
      }
      case PINGRESP:
        this.awaitingPing = 0;
        return;
      case SUBACK:
        if (body.subarray(2).includes(0x80)) this.emit('error', new Error('MQTT broker rejected a subscription'));
        return;
      default:
        return;
    }
  }

  private onClose(socket: net.Socket): void {
    if (socket !== this.socket) return;
    const wasConnected = this.connectedFlag;
    this.connectedFlag = false;
    this.socket = undefined;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    if (this.ended) return;
    if (wasConnected) this.emit('close');
    const delay = RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private packetId(): number {
    const id = this.nextPacketId;
    this.nextPacketId = (this.nextPacketId % 0xffff) + 1;
    return id;
  }

  /** Subscribe now and after every reconnect. */
  subscribe(...topics: string[]): void {
    const fresh = topics.filter((t) => !this.subscriptions.has(t));
    for (const t of fresh) this.subscriptions.add(t);
    if (fresh.length && this.connectedFlag) this.socket?.write(encodeSubscribe(this.packetId(), fresh));
  }

  /** Fire-and-forget (QoS 0). Returns false when not connected; callers republish state on 'connect'. */
  publish(topic: string, payload: string | Buffer, opts: { retain?: boolean } = {}): boolean {
    if (!this.connectedFlag || !this.socket) return false;
    this.socket.write(encodePublish(topic, payload, opts.retain));
    return true;
  }

  /** Disconnect cleanly (the broker then does not publish the last will). */
  async end(): Promise<void> {
    this.ended = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 1000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.connectedFlag) socket.end(packet(DISCONNECT, 0, Buffer.alloc(0)));
      else socket.destroy();
    });
  }
}
