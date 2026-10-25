// Browser replacement for win32/win_net.cpp.
//
// Browsers have no UDP sockets. The engine Worker instead opens one WebSocket
// to the LAN relay (server/lan-relay/relay.mjs), which assigns this engine a
// virtual IPv4 address on 10.77.0.0/16 and forwards datagrams, including
// broadcasts, between virtual hosts. Canonical net_chan code above this layer
// is unchanged: it still sees NA_IP/NA_BROADCAST addresses and one socket
// bound at net_port.
//
// The JavaScript side keeps a bounded receive queue; Sys_GetPacket drains it
// without blocking. Datagram semantics are preserved: sends before the relay
// connection is ready, or after it drops, are silently lost like UDP.

#include <emscripten.h>

#include <cstdint>
#include <cstdio>
#include <cstring>

#include <qcommon/qcommon.h>
#include <universal/q_shared.h>
#include <universal/dvar.h>
#include <win32/win_net.h>

namespace
{
// Mirrors the relay wire protocol (server/lan-relay/relay.mjs, version 1).
EM_JS(int, KisakLanOpen, (int port), {
    const lan = globalThis.__kisakLan || (globalThis.__kisakLan = {
        ws: null, ip: 0, port: 0, rx: [], status: 0, lastAttempt: 0
    });
    lan.port = port & 0xffff;
    if (lan.ws && lan.ws.readyState <= 1) {
        if (lan.ws.readyState === 1) lan.ws.send(new Uint8Array([1, lan.port >> 8, lan.port & 255]));
        return 1;
    }
    const now = Date.now();
    if (now - lan.lastAttempt < 2000) return 0;
    lan.lastAttempt = now;
    let url = globalThis.kisakLanUrl;
    if (!url) {
        const where = globalThis.location;
        if (!where || !where.host) return 0;
        url = (where.protocol === "https:" ? "wss://" : "ws://") + where.host + "/lan";
    }
    url += (url.indexOf("?") < 0 ? "?" : "&") + "v=1";
    let ws;
    try {
        ws = new WebSocket(url);
    } catch (error) {
        lan.status = -1;
        return 0;
    }
    ws.binaryType = "arraybuffer";
    lan.ws = ws;
    lan.ip = 0;
    lan.status = 1;
    ws.onopen = () => ws.send(new Uint8Array([1, lan.port >> 8, lan.port & 255]));
    ws.onmessage = (event) => {
        const bytes = new Uint8Array(event.data);
        if (bytes.length >= 5 && bytes[0] === 0x81) {
            lan.ip = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
            lan.status = 2;
            globalThis.dispatchEvent?.(new CustomEvent("kisakcod:lan", {
                detail: { state: "connected", ip: lan.ip }
            }));
        } else if (bytes.length >= 7 && bytes[0] === 0x82) {
            if (lan.rx.length >= 1024) lan.rx.shift();
            lan.rx.push(bytes);
        }
    };
    ws.onclose = () => {
        if (lan.ws !== ws) return;
        lan.ws = null;
        lan.ip = 0;
        lan.status = 0;
        globalThis.dispatchEvent?.(new CustomEvent("kisakcod:lan", { detail: { state: "closed" } }));
    };
    return 1;
});

EM_JS(void, KisakLanClose, (), {
    const lan = globalThis.__kisakLan;
    if (!lan || !lan.ws) return;
    const ws = lan.ws;
    lan.ws = null;
    lan.ip = 0;
    lan.status = 0;
    lan.rx.length = 0;
    try { ws.close(); } catch (error) {}
});

EM_JS(std::uint32_t, KisakLanAddress, (), {
    const lan = globalThis.__kisakLan;
    return lan && lan.status === 2 ? lan.ip >>> 0 : 0;
});

// Returns 1 when the datagram was handed to the socket, 0 when dropped.
EM_JS(int, KisakLanSend, (std::uint32_t ip, int port, const std::uint8_t *data, int length), {
    const lan = globalThis.__kisakLan;
    if (!lan || !lan.ws || lan.ws.readyState !== 1 || lan.status !== 2) return 0;
    if (lan.ws.bufferedAmount > 1048576) return 0; // congested: drop like UDP
    const message = new Uint8Array(7 + length);
    message[0] = 2;
    message[1] = ip >>> 24; message[2] = (ip >>> 16) & 255; message[3] = (ip >>> 8) & 255; message[4] = ip & 255;
    message[5] = (port >> 8) & 255; message[6] = port & 255;
    message.set(HEAPU8.subarray(data, data + length), 7);
    lan.ws.send(message);
    return 1;
});

// Pops one datagram. Returns its length, 0 when the queue is empty, or -1 when
// the next datagram does not fit (it is discarded).
EM_JS(int, KisakLanRecv, (std::uint8_t *buffer, int capacity, std::uint32_t *ip, int *port), {
    const lan = globalThis.__kisakLan;
    if (!lan || !lan.rx.length) return 0;
    const bytes = lan.rx.shift();
    const length = bytes.length - 7;
    if (length > capacity) return -1;
    HEAPU32[ip >> 2] = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
    HEAP32[port >> 2] = (bytes[5] << 8) | bytes[6];
    HEAPU8.set(bytes.subarray(7), buffer);
    return length;
});

bool g_networkingEnabled = false;
const dvar_s *g_netPort = nullptr;
const dvar_s *g_netNoUdp = nullptr;

// netadr_t stores ports in network byte order (NET_StringToAdr uses BigShort).
std::uint16_t PortFromNetwork(unsigned short port)
{
    return static_cast<std::uint16_t>(((port & 0xffu) << 8) | ((port >> 8) & 0xffu));
}

unsigned short PortToNetwork(std::uint16_t port)
{
    return static_cast<unsigned short>(((port & 0xffu) << 8) | ((port >> 8) & 0xffu));
}

std::uint32_t AddressFromNetadr(const netadr_t &adr)
{
    return (static_cast<std::uint32_t>(adr.ip[0]) << 24) | (static_cast<std::uint32_t>(adr.ip[1]) << 16) |
        (static_cast<std::uint32_t>(adr.ip[2]) << 8) | adr.ip[3];
}

void OpenRelay()
{
    if (!g_netPort || g_netNoUdp->current.enabled)
        return;
    KisakLanOpen(g_netPort->current.integer);
}
} // namespace

void NET_Config(bool enableNetworking)
{
    g_netNoUdp = Dvar_RegisterBool("net_noudp", 0, DVAR_ARCHIVE | DVAR_LATCH, "Disable networking");
    Dvar_RegisterString("net_ip", "localhost", DVAR_LATCH, "Network IP Address");
    g_netPort = Dvar_RegisterInt("net_port", 28960, 0xFFFF00000000LL, DVAR_LATCH, "Network port");
    if (g_netNoUdp->current.enabled)
        enableNetworking = false;
    if (enableNetworking == g_networkingEnabled)
        return;
    g_networkingEnabled = enableNetworking;
    if (enableNetworking)
        OpenRelay();
    else
        KisakLanClose();
}

void NET_Init()
{
    Com_Printf(16, "LAN relay networking initialized\n");
    NET_Config(true);
}

void NET_Shutdown()
{
    NET_Config(false);
}

void NET_Restart()
{
    if (!g_networkingEnabled)
        return;
    KisakLanClose();
    OpenRelay();
}

const char *NET_ErrorString()
{
    return "LAN relay unavailable";
}

qboolean Sys_GetPacket(netadr_t *net_from, msg_t *net_message)
{
    if (!g_networkingEnabled)
        return qfalse;
    // Reconnects lazily (rate-limited in JS) if the relay connection dropped.
    if (!KisakLanAddress())
        OpenRelay();
    for (;;)
    {
        std::uint32_t ip = 0;
        int port = 0;
        const int length = KisakLanRecv(net_message->data, net_message->maxsize, &ip, &port);
        if (length == 0)
            return qfalse;
        if (length < 0 || length == net_message->maxsize)
        {
            Com_Printf(16, "Oversize packet from LAN relay\n");
            continue;
        }
        std::memset(net_from, 0, sizeof(*net_from));
        net_from->type = NA_IP;
        net_from->ip[0] = static_cast<unsigned char>(ip >> 24);
        net_from->ip[1] = static_cast<unsigned char>(ip >> 16);
        net_from->ip[2] = static_cast<unsigned char>(ip >> 8);
        net_from->ip[3] = static_cast<unsigned char>(ip);
        net_from->port = PortToNetwork(static_cast<std::uint16_t>(port));
        net_message->readcount = 0;
        net_message->cursize = length;
        return qtrue;
    }
}

char __cdecl Sys_SendPacket(int length, unsigned __int8 *data, netadr_t to)
{
    std::uint32_t ip;
    switch (to.type)
    {
    case NA_BROADCAST:
        ip = 0xffffffffu;
        break;
    case NA_IP:
        ip = AddressFromNetadr(to);
        break;
    default:
        Com_Error(ERR_FATAL, "Sys_SendPacket: bad address type");
        return 0;
    }
    if (!g_networkingEnabled || length <= 0)
        return 1;
    KisakLanSend(ip, PortFromNetwork(to.port), data, length);
    return 1; // undeliverable datagrams are dropped silently, as with UDP
}

bool __cdecl Sys_IsLANAddress_IgnoreSubnet(netadr_t adr)
{
    if (adr.type == NA_LOOPBACK || adr.type == NA_BOT)
        return true;
    if (adr.type != NA_IP)
        return false;
    if (adr.ip[0] == 10 || adr.ip[0] == 127)
        return true;
    if (adr.ip[0] == 169 && adr.ip[1] == 254)
        return true;
    if (adr.ip[0] == 172 && (adr.ip[1] & 0xF0) == 0x10)
        return true;
    return adr.ip[0] == 192 && adr.ip[1] == 168;
}

bool __cdecl Sys_IsLANAddress(netadr_t adr)
{
    // Every relay peer shares the virtual 10.77.0.0/16 subnet.
    return Sys_IsLANAddress_IgnoreSubnet(adr);
}

void Sys_ShowIP()
{
    const std::uint32_t ip = KisakLanAddress();
    if (!ip)
    {
        Com_Printf(16, "IP: not connected to the LAN relay\n");
        return;
    }
    Com_Printf(16, "IP: %u.%u.%u.%u\n", ip >> 24, (ip >> 16) & 255u, (ip >> 8) & 255u, ip & 255u);
}

qboolean Sys_StringToAdr(const char *s, netadr_t *a)
{
    unsigned int parts[4];
    char trailing;
    // Only dotted IPv4 literals: there is no DNS inside the virtual LAN.
    if (std::sscanf(s, "%u.%u.%u.%u%c", &parts[0], &parts[1], &parts[2], &parts[3], &trailing) != 4)
        return qfalse;
    for (unsigned int part : parts)
    {
        if (part > 255u)
            return qfalse;
    }
    std::memset(a, 0, sizeof(*a));
    a->type = NA_IP;
    for (int i = 0; i < 4; ++i)
        a->ip[i] = static_cast<unsigned char>(parts[i]);
    return qtrue;
}

qboolean Sys_StringToSockaddr(const char *s, struct sockaddr *)
{
    netadr_t adr;
    return Sys_StringToAdr(s, &adr);
}
