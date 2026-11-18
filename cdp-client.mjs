import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let headerLen = 2;
  if (len >= 126 && len <= 65535) headerLen = 4;
  else if (len > 65535) headerLen = 10;

  const maskKey = randomBytes(4);
  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f);

  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len <= 65535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }

  maskKey.copy(frame, headerLen);
  for (let i = 0; i < len; i++) {
    frame[headerLen + 4 + i] = payloadBuf[i] ^ maskKey[i & 3];
  }
  return frame;
}

/**
 * Minimal zero-dependency RFC 6455 WebSocket + CDP JSON-RPC client (Node >= 18).
 */
export class CdpClient {
  #socket = null;
  #nextId = 1;
  #pending = new Map();
  #recvBuf = Buffer.alloc(0);
  #fragments = [];
  #fragmentOpcode = 0;
  #closed = false;
  #onCloseCallbacks = [];

  static connect(wsUrl, timeoutMs = 5000) {
    const client = new CdpClient();
    return client.#open(wsUrl, timeoutMs);
  }

  #open(wsUrl, timeoutMs) {
    const url = new URL(wsUrl);
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`CDP WebSocket connect timeout: ${wsUrl}`));
      }, timeoutMs);

      const req = http.request({
        hostname: url.hostname,
        port: Number(url.port) || 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });

      req.on('upgrade', (res, socket, head) => {
        clearTimeout(timer);
        if (res.headers['sec-websocket-accept'] !== expectedAccept) {
          socket.destroy();
          reject(new Error('Invalid Sec-WebSocket-Accept from CDP target'));
          return;
        }
        this.#socket = socket;
        socket.setNoDelay(true);
        if (head && head.length > 0) {
          this.#onData(head);
        }
        socket.on('data', (chunk) => this.#onData(chunk));
        socket.on('error', () => this.#handleClose());
        socket.on('close', () => this.#handleClose());
        resolve(this);
      });

      req.on('response', (res) => {
        clearTimeout(timer);
        reject(new Error(`Unexpected HTTP status ${res.statusCode} upgrading CDP WebSocket`));
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.end();
    });
  }

  onClose(cb) {
    if (this.#closed) {
      cb();
      return;
    }
    this.#onCloseCallbacks.push(cb);
  }

  send(method, params = {}, timeoutMs = 8000) {
    if (this.#closed || !this.#socket) {
      return Promise.reject(new Error('CDP client is closed'));
    }
    const id = this.#nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP request timeout (${method})`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.#socket.write(encodeFrame(0x1, payload));
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  close() {
    if (this.#closed) return;
    try {
      this.#socket?.write(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      // Ignore write failure during teardown
    }
    this.#socket?.end();
    this.#handleClose();
  }

  #onData(chunk) {
    this.#recvBuf = Buffer.concat([this.#recvBuf, chunk]);

    while (this.#recvBuf.length >= 2) {
      const b0 = this.#recvBuf[0];
      const b1 = this.#recvBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.#recvBuf.length < 4) return;
        payloadLen = this.#recvBuf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.#recvBuf.length < 10) return;
        payloadLen = Number(this.#recvBuf.readBigUInt64BE(2));
        offset = 10;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.#recvBuf.length < offset + payloadLen) return;

      const payload = Buffer.from(this.#recvBuf.subarray(offset, offset + payloadLen));
      if (masked) {
        const mask = this.#recvBuf.subarray(maskOffset, maskOffset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }
      this.#recvBuf = this.#recvBuf.subarray(offset + payloadLen);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        try {
          this.#socket?.write(encodeFrame(0xA, payload));
        } catch {
          // Ignore pong write error
        }
        continue;
      }
      if (opcode === 0xA) {
        continue;
      }

      if (opcode !== 0x0) {
        this.#fragmentOpcode = opcode;
        this.#fragments = [payload];
      } else {
        this.#fragments.push(payload);
      }

      if (fin && this.#fragmentOpcode === 0x1) {
        const text = Buffer.concat(this.#fragments).toString('utf8');
        this.#fragments = [];
        this.#fragmentOpcode = 0;
        this.#handleMessage(text);
      } else if (fin) {
        this.#fragments = [];
        this.#fragmentOpcode = 0;
      }
    }
  }

  #handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.#pending.has(msg.id)) {
      const waiter = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        waiter.resolve(msg.result);
      }
    }
  }

  #handleClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#pending.values()) {
      waiter.reject(new Error('CDP connection closed'));
    }
    this.#pending.clear();
    for (const cb of this.#onCloseCallbacks) {
      try {
        cb();
      } catch {
        // Ignore callback failure
      }
    }
    this.#onCloseCallbacks = [];
  }
}
