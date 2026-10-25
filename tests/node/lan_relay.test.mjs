import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import {
    createRelayServer, ipToString, parseIp, OP_BIND, OP_SEND, OP_WELCOME, OP_RECV,
} from "../../server/lan-relay/relay.mjs";

async function startRelay(options = {}) {
    const { server, router } = createRelayServer(options);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, router, url: `ws://127.0.0.1:${server.address().port}/lan?v=1` };
}

// Minimal client mirroring what the engine Worker transport does.
async function connect(url, port) {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const inbox = [];
    const waiters = [];
    ws.onmessage = (event) => {
        const bytes = Buffer.from(event.data);
        const waiter = waiters.shift();
        if (waiter) waiter(bytes); else inbox.push(bytes);
    };
    const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r));
    await once(ws, "open");
    const welcome = await next();
    assert.equal(welcome[0], OP_WELCOME);
    const ip = welcome.readUInt32BE(1);
    const bind = Buffer.alloc(3);
    bind[0] = OP_BIND;
    bind.writeUInt16BE(port, 1);
    ws.send(bind);
    return {
        ws, ip, next,
        pending: () => inbox.length,
        send(dstIp, dstPort, payload) {
            const message = Buffer.alloc(7 + payload.length);
            message[0] = OP_SEND;
            message.writeUInt32BE(dstIp >>> 0, 1);
            message.writeUInt16BE(dstPort, 5);
            Buffer.from(payload).copy(message, 7);
            ws.send(message);
        },
    };
}

function decodeRecv(message) {
    assert.equal(message[0], OP_RECV);
    return { ip: message.readUInt32BE(1), port: message.readUInt16BE(5), payload: message.subarray(7).toString() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("addresses parse and format", () => {
    assert.equal(ipToString(parseIp("10.77.0.2")), "10.77.0.2");
    assert.throws(() => parseIp("10.77.0"));
});

test("unicast and broadcast between virtual hosts", async () => {
    const { server, url } = await startRelay();
    try {
        const host = await connect(url, 28960);
        const joiner = await connect(url, 28961);
        const other = await connect(url, 28962);
        assert.notEqual(host.ip, joiner.ip);
        assert.equal(ipToString(host.ip).startsWith("10.77."), true);
        await settle(); // BIND messages are processed

        // LAN discovery: broadcast to the server port reaches only hosts bound there.
        joiner.send(parseIp("255.255.255.255"), 28960, "\xff\xff\xff\xffgetinfo xxx");
        const query = decodeRecv(await host.next());
        assert.equal(query.ip, joiner.ip);
        assert.equal(query.port, 28961);
        assert.match(query.payload, /getinfo/);

        // Reply goes back to the joiner's address and port only.
        host.send(query.ip, query.port, "infoResponse");
        const reply = decodeRecv(await joiner.next());
        assert.deepEqual([reply.ip, reply.port, reply.payload], [host.ip, 28960, "infoResponse"]);
        await settle();
        assert.equal(other.pending(), 0);

        // Wrong port and addresses outside the virtual LAN are dropped.
        joiner.send(host.ip, 1234, "nope");
        joiner.send(parseIp("192.168.1.1"), 28960, "nope");
        await settle();
        assert.equal(host.pending(), 0);
        for (const c of [host, joiner, other]) c.ws.close();
    } finally {
        server.close();
    }
});

test("rejects upgrades on the wrong path or version", async () => {
    const { server } = await startRelay();
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/lan?v=999`);
        await once(ws, "error");
    } finally {
        server.close();
    }
});

test("bridges a virtual address to a real UDP server", async () => {
    const udp = createSocket("udp4");
    udp.on("message", (message, rinfo) => udp.send(Buffer.from(`echo:${message}`), rinfo.port, rinfo.address));
    udp.bind(0, "127.0.0.1");
    await once(udp, "listening");
    const bridgeIp = parseIp("10.77.1.1");
    const { server, url } = await startRelay({
        bridges: [{ virtualIp: bridgeIp, virtualPort: 28960, targetHost: "127.0.0.1", targetPort: udp.address().port }],
    });
    try {
        const a = await connect(url, 28961);
        const b = await connect(url, 28961);
        await settle();
        a.send(bridgeIp, 28960, "from-a");
        b.send(bridgeIp, 28960, "from-b");
        const ra = decodeRecv(await a.next());
        const rb = decodeRecv(await b.next());
        assert.deepEqual([ra.ip, ra.port, ra.payload], [bridgeIp, 28960, "echo:from-a"]);
        assert.equal(rb.payload, "echo:from-b");
        // Broadcast discovery also reaches the bridged server.
        a.send(parseIp("255.255.255.255"), 28960, "bcast");
        assert.equal(decodeRecv(await a.next()).payload, "echo:bcast");
        a.ws.close();
        b.ws.close();
    } finally {
        server.close();
        udp.close();
    }
});

test("serves the browser site without escaping its directory", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "relay-site-"));
    const site = join(root, "site");
    mkdirSync(site);
    writeFileSync(join(site, "index.html"), "<!doctype html>hello");
    writeFileSync(join(site, "kisakcod.wasm"), Buffer.from([0, 97, 115, 109]));
    writeFileSync(join(root, "secret.txt"), "outside");
    const { server } = await startRelay({ site });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const index = await fetch(`${base}/`);
        assert.equal(index.status, 200);
        assert.match(index.headers.get("content-type"), /text\/html/);
        assert.equal(await index.text(), "<!doctype html>hello");
        const wasm = await fetch(`${base}/kisakcod.wasm`);
        assert.equal(wasm.headers.get("content-type"), "application/wasm");
        for (const escape of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"]) {
            assert.equal((await fetch(base + escape)).status, 404, escape);
        }
        assert.equal((await fetch(`${base}/missing.mjs`)).status, 404);
        assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
    } finally {
        server.close();
    }
});

test("basic auth guards the site and the relay but not health checks", async () => {
    const { server } = await startRelay({ site: process.cwd(), auth: "lan:party" });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const good = "Basic " + Buffer.from("lan:party").toString("base64");
    const bad = "Basic " + Buffer.from("lan:nope").toString("base64");
    try {
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        const denied = await fetch(`${base}/package.json`);
        assert.equal(denied.status, 401);
        assert.match(denied.headers.get("www-authenticate"), /^Basic/);
        assert.equal((await fetch(`${base}/package.json`, { headers: { authorization: bad } })).status, 401);
        assert.equal((await fetch(`${base}/package.json`, { headers: { authorization: good } })).status, 200);

        const { request } = await import("node:http");
        const upgrade = (authorization) => new Promise((resolveUpgrade) => {
            const headers = { connection: "Upgrade", upgrade: "websocket",
                "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
            if (authorization) headers.authorization = authorization;
            const req = request({ port, path: "/lan?v=1", headers });
            req.on("upgrade", (res, socket) => { socket.destroy(); resolveUpgrade(101); });
            req.on("response", (res) => { res.resume(); resolveUpgrade(res.statusCode); });
            req.on("error", () => resolveUpgrade(-1));
            req.end();
        });
        assert.equal(await upgrade(null), 401);
        assert.equal(await upgrade(good), 101);
    } finally {
        server.close();
    }
});
