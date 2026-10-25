#!/usr/bin/env node
// KisakCOD browser LAN relay.
//
// Browsers cannot open UDP sockets, so each engine Worker opens one WebSocket
// to this relay and gets a virtual IPv4 address on 10.77.0.0/16. The relay
// forwards datagrams between those virtual hosts, including UDP-style
// broadcasts (which the stock COD4 LAN server browser relies on), and can
// bridge virtual addresses to real UDP servers such as a native dedicated
// server running next to it.
//
// Zero dependencies: Node's http module plus a minimal RFC 6455 server that
// accepts binary frames only. Put it behind a TLS reverse proxy (e.g. Caddy)
// so pages served over HTTPS reach it as wss://host/lan.
//
// It can also serve the generated browser site (--site), so one process is a
// complete LAN host, and require HTTP basic auth for everything except
// /healthz (KISAK_BASIC_AUTH=user:password). It never serves game data.
//
// Wire protocol (version 1, one datagram per binary WebSocket message):
//   client -> relay  BIND    0x01 port:u16be                  claim a UDP port
//   client -> relay  SEND    0x02 ip:4 port:u16be payload      send datagram
//   relay  -> client WELCOME 0x81 ip:4                         assigned address
//   relay  -> client RECV    0x82 ip:4 port:u16be payload      datagram arrived
// Multi-byte integers are big-endian (network order). A SEND to
// 255.255.255.255 or 10.77.255.255 reaches every other host bound to that port.

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { createSocket } from "node:dgram";
import { pathToFileURL } from "node:url";

export const PROTOCOL_VERSION = 1;
export const OP_BIND = 0x01;
export const OP_SEND = 0x02;
export const OP_WELCOME = 0x81;
export const OP_RECV = 0x82;
export const MAX_DATAGRAM = 16384;
const SUBNET = (10 << 24) | (77 << 16);
const SUBNET_MASK = 0xffff0000;
const SUBNET_BROADCAST = (SUBNET | 0xffff) >>> 0;
const LIMITED_BROADCAST = 0xffffffff;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = MAX_DATAGRAM + 16;
const MAX_BOUND_PORTS = 8;

export function ipToString(ip) {
    return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join(".");
}

export function parseIp(text) {
    const parts = text.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
        throw new Error(`invalid IPv4 address: ${text}`);
    }
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function encodeFrame(payload) {
    const length = payload.length;
    const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x82; // FIN + binary
    if (length < 126) {
        header[1] = length;
    } else if (length < 65536) {
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    return Buffer.concat([header, payload]);
}

function controlFrame(opcode, payload = Buffer.alloc(0)) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

// One accepted WebSocket. Parses masked client frames and emits whole messages.
class WebSocketConnection {
    constructor(socket, onMessage, onClose) {
        this.socket = socket;
        this.onMessage = onMessage;
        this.onClose = onClose;
        this.buffer = Buffer.alloc(0);
        this.fragments = null;
        this.closed = false;
        socket.setNoDelay(true);
        socket.on("data", (chunk) => this.receive(chunk));
        socket.on("close", () => this.finish());
        socket.on("error", () => this.finish());
    }

    send(payload) {
        if (!this.closed) this.socket.write(encodeFrame(payload));
    }

    close(code = 1000) {
        if (this.closed) return;
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code, 0);
        this.socket.end(controlFrame(0x8, body));
        this.finish();
    }

    finish() {
        if (this.closed) return;
        this.closed = true;
        this.socket.destroy();
        this.onClose();
    }

    receive(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        while (!this.closed) {
            const frame = this.parseFrame();
            if (!frame) return;
            this.handleFrame(frame);
        }
    }

    parseFrame() {
        const b = this.buffer;
        if (b.length < 2) return null;
        const fin = (b[0] & 0x80) !== 0;
        const opcode = b[0] & 0x0f;
        const masked = (b[1] & 0x80) !== 0;
        let length = b[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (b.length < 4) return null;
            length = b.readUInt16BE(2);
            offset = 4;
        } else if (length === 127) {
            if (b.length < 10) return null;
            const big = b.readBigUInt64BE(2);
            if (big > BigInt(MAX_FRAME)) { this.close(1009); return null; }
            length = Number(big);
            offset = 10;
        }
        if (!masked || (b[0] & 0x70) !== 0) { this.close(1002); return null; }
        if (length > MAX_FRAME) { this.close(1009); return null; }
        if (b.length < offset + 4 + length) return null;
        const mask = b.subarray(offset, offset + 4);
        const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; ++i) payload[i] ^= mask[i & 3];
        this.buffer = b.subarray(offset + 4 + length);
        return { fin, opcode, payload };
    }

    handleFrame({ fin, opcode, payload }) {
        if (opcode === 0x8) { this.close(); return; }
        if (opcode === 0x9) { this.socket.write(controlFrame(0xa, payload.subarray(0, 125))); return; }
        if (opcode === 0xa) return;
        if (opcode === 0x1) { this.close(1003); return; } // binary protocol only
        if (opcode === 0x2) {
            if (this.fragments) { this.close(1002); return; }
            if (fin) this.onMessage(payload);
            else this.fragments = [payload];
            return;
        }
        if (opcode === 0x0 && this.fragments) {
            this.fragments.push(payload);
            const total = this.fragments.reduce((n, f) => n + f.length, 0);
            if (total > MAX_FRAME) { this.close(1009); return; }
            if (fin) {
                const message = Buffer.concat(this.fragments);
                this.fragments = null;
                this.onMessage(message);
            }
            return;
        }
        this.close(1002);
    }
}

// Routes datagrams between virtual hosts. Transport-independent so tests and
// the UDP bridge can attach endpoints directly.
export class LanRouter {
    constructor({ log = () => {} } = {}) {
        this.log = log;
        this.hosts = new Map(); // ip -> { deliver(srcIp, srcPort, payload), ports:Set }
        this.nextHost = 2;
    }

    allocateIp() {
        for (let attempt = 0; attempt < 0xfffd; ++attempt) {
            const host = this.nextHost;
            this.nextHost = host >= 0xfeff ? 2 : host + 1;
            const ip = (SUBNET | host) >>> 0;
            if (!this.hosts.has(ip)) return ip;
        }
        throw new Error("virtual subnet exhausted");
    }

    attach(deliver, ip = this.allocateIp()) {
        if (this.hosts.has(ip)) throw new Error(`address in use: ${ipToString(ip)}`);
        const host = { ip, deliver, ports: new Set() };
        this.hosts.set(ip, host);
        return host;
    }

    detach(host) {
        this.hosts.delete(host.ip);
    }

    bind(host, port) {
        if (host.ports.size >= MAX_BOUND_PORTS && !host.ports.has(port)) return false;
        host.ports.add(port);
        return true;
    }

    route(source, srcPort, dstIp, dstPort, payload) {
        if (dstIp === LIMITED_BROADCAST || dstIp === SUBNET_BROADCAST) {
            for (const host of this.hosts.values()) {
                if (host !== source && host.ports.has(dstPort)) host.deliver(source.ip, srcPort, payload);
            }
            return;
        }
        if (((dstIp & SUBNET_MASK) >>> 0) !== SUBNET) return; // nothing outside the virtual LAN
        const target = this.hosts.get(dstIp);
        if (target && target.ports.has(dstPort)) target.deliver(source.ip, srcPort, payload);
    }
}

function handleMessage(router, host, connection, message) {
    if (message.length < 1) return;
    const op = message[0];
    if (op === OP_BIND && message.length === 3) {
        router.bind(host, message.readUInt16BE(1));
        return;
    }
    if (op === OP_SEND && message.length >= 7 && message.length - 7 <= MAX_DATAGRAM) {
        const dstIp = message.readUInt32BE(1);
        const dstPort = message.readUInt16BE(5);
        // A host's source port is the first one it bound (its net_port).
        const srcPort = host.ports.values().next().value ?? 0;
        router.route(host, srcPort, dstIp, dstPort, message.subarray(7));
        return;
    }
    connection.close(1002);
}

function recvMessage(srcIp, srcPort, payload) {
    const message = Buffer.alloc(7 + payload.length);
    message[0] = OP_RECV;
    message.writeUInt32BE(srcIp >>> 0, 1);
    message.writeUInt16BE(srcPort, 5);
    payload.copy(message, 7);
    return message;
}

// Exposes a real UDP server (e.g. a native dedicated server) as a virtual host.
// Each browser client gets its own UDP socket so the server sees distinct peers.
export function attachUdpBridge(router, { virtualIp, virtualPort, targetHost, targetPort }) {
    const sockets = new Map(); // client ip -> dgram socket
    const bridge = router.attach((srcIp, srcPort, payload) => {
        let socket = sockets.get(srcIp);
        if (!socket) {
            socket = createSocket("udp4");
            socket.on("message", (reply) => {
                const client = router.hosts.get(srcIp);
                if (client) client.deliver(virtualIp, virtualPort, reply);
            });
            socket.on("error", () => {});
            sockets.set(srcIp, socket);
        }
        socket.send(payload, targetPort, targetHost);
    }, virtualIp);
    router.bind(bridge, virtualPort);
    return {
        bridge,
        forget(ip) {
            const socket = sockets.get(ip);
            if (socket) { socket.close(); sockets.delete(ip); }
        },
        close() {
            for (const socket of sockets.values()) socket.close();
            sockets.clear();
            router.detach(bridge);
        },
    };
}

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

// Returns true when the request carries the expected basic credentials.
export function checkBasicAuth(header, expected) {
    if (!expected) return true;
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header ?? "");
    if (!match) return false;
    const given = Buffer.from(Buffer.from(match[1], "base64").toString("utf8"));
    const want = Buffer.from(expected);
    return given.length === want.length && timingSafeEqual(given, want);
}

function serveStatic(root, request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" });
        response.end();
        return;
    }
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, "http://relay").pathname);
    } catch {
        response.writeHead(400);
        response.end();
        return;
    }
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = resolve(root, "." + pathname);
    let stats = null;
    if (file.startsWith(root + sep)) {
        try { stats = statSync(file); } catch { stats = null; }
    }
    if (!stats || !stats.isFile()) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found\n");
        return;
    }
    response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": stats.size,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") {
        response.end();
        return;
    }
    createReadStream(file).pipe(response);
}

export function createRelayServer({ path = "/lan", log = () => {}, bridges = [], site = null, auth = null } = {}) {
    const siteRoot = site ? resolve(site) : null;
    const router = new LanRouter({ log });
    const udpBridges = bridges.map((b) => attachUdpBridge(router, b));
    const server = createServer((request, response) => {
        if (request.url === "/healthz") {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end(`ok ${router.hosts.size}\n`);
            return;
        }
        if (!checkBasicAuth(request.headers.authorization, auth)) {
            response.writeHead(401, { "www-authenticate": 'Basic realm="KisakCOD", charset="UTF-8"' });
            response.end();
            return;
        }
        const pathname = new URL(request.url, "http://relay").pathname;
        if (siteRoot && pathname !== path) {
            serveStatic(siteRoot, request, response);
            return;
        }
        response.writeHead(426, { "content-type": "text/plain" });
        response.end("WebSocket upgrade required\n");
    });
    server.on("upgrade", (request, socket) => {
        const url = new URL(request.url, "http://relay");
        const key = request.headers["sec-websocket-key"];
        if (!checkBasicAuth(request.headers.authorization, auth)) {
            socket.end("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"KisakCOD\"\r\nConnection: close\r\n\r\n");
            return;
        }
        if (url.pathname !== path || !key || request.headers.upgrade?.toLowerCase() !== "websocket" ||
            url.searchParams.get("v") !== String(PROTOCOL_VERSION)) {
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            return;
        }
        const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
        let host = null;
        const connection = new WebSocketConnection(socket,
            (message) => handleMessage(router, host, connection, message),
            () => {
                if (!host) return;
                router.detach(host);
                for (const b of udpBridges) b.forget(host.ip);
                log(`leave ${ipToString(host.ip)} (${router.hosts.size} connected)`);
            });
        host = router.attach((srcIp, srcPort, payload) => connection.send(recvMessage(srcIp, srcPort, payload)));
        const welcome = Buffer.alloc(5);
        welcome[0] = OP_WELCOME;
        welcome.writeUInt32BE(host.ip, 1);
        connection.send(welcome);
        log(`join ${ipToString(host.ip)} from ${request.headers["x-forwarded-for"] ?? socket.remoteAddress}`);
    });
    server.on("close", () => { for (const b of udpBridges) b.close(); });
    return { server, router };
}

// VIP:PORT=HOST:PORT, e.g. 10.77.1.1:28960=127.0.0.1:28960
function parseBridge(text) {
    const match = /^([\d.]+):(\d+)=([^:]+):(\d+)$/.exec(text.trim());
    if (!match) throw new Error("a UDP bridge must be VIP:PORT=HOST:PORT");
    const virtualIp = parseIp(match[1]);
    if (((virtualIp & SUBNET_MASK) >>> 0) !== SUBNET) throw new Error("bridge address must be in 10.77.0.0/16");
    return { virtualIp, virtualPort: Number(match[2]), targetHost: match[3], targetPort: Number(match[4]) };
}

function parseArguments(argv) {
    const options = { listen: "127.0.0.1", port: 8481, path: "/lan", bridges: [], site: null };
    for (let i = 0; i < argv.length; ++i) {
        const arg = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
            return argv[++i];
        };
        if (arg === "--listen") options.listen = value();
        else if (arg === "--port") options.port = Number(value());
        else if (arg === "--path") options.path = value();
        else if (arg === "--site") options.site = value();
        else if (arg === "--udp-bridge") options.bridges.push(parseBridge(value()));
        else if (arg === "--help") {
            console.log("usage: relay.mjs [--listen ADDR] [--port N] [--path /lan] [--site DIR]\n" +
                "                [--udp-bridge VIP:PORT=HOST:PORT]...\n" +
                "environment: KISAK_BASIC_AUTH=user:password requires HTTP basic auth\n" +
                "             KISAK_UDP_BRIDGE=VIP:PORT=HOST:PORT[,...] adds UDP bridges");
            process.exit(0);
        } else throw new Error(`unknown argument: ${arg}`);
    }
    return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const options = parseArguments(process.argv.slice(2));
    for (const bridge of (process.env.KISAK_UDP_BRIDGE ?? "").split(",").filter((b) => b.trim()))
        options.bridges.push(parseBridge(bridge));
    const auth = process.env.KISAK_BASIC_AUTH || null;
    if (auth && !auth.includes(":")) throw new Error("KISAK_BASIC_AUTH must be user:password");
    const { server } = createRelayServer({
        path: options.path,
        bridges: options.bridges,
        site: options.site,
        auth,
        log: (line) => console.log(`[lan-relay] ${line}`),
    });
    server.listen(options.port, options.listen, () => {
        console.log(`[lan-relay] listening on ${options.listen}:${options.port}${options.path}` +
            (options.site ? `, serving ${resolve(options.site)}` : "") +
            (auth ? ", basic auth required" : ""));
        for (const b of options.bridges) {
            console.log(`[lan-relay] bridge ${ipToString(b.virtualIp)}:${b.virtualPort} -> ${b.targetHost}:${b.targetPort}`);
        }
    });
}
