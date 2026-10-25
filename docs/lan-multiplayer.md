# LAN multiplayer

Status: in progress. The relay (`server/lan-relay/`) and the engine transport
(`src/web/web_net.cpp`) exist. The multiplayer browser target is being brought up
(see "Bring-up status" below). Nothing here is a qualified release.

## Goal

Players on one LAN open a single HTTPS URL, pick a map such as `mp_shipment`,
and play without installing anything or running a server process themselves.

## How it works

Browsers cannot open UDP sockets, which COD4 networking is built on. Each
engine Worker instead keeps one WebSocket to the **LAN relay**. The relay gives
every tab a virtual IPv4 address on `10.77.0.0/16` and forwards datagrams
between those addresses, including broadcasts:

```text
 browser tab A (10.77.0.2:28960) ─┐                       ┌─ UDP ─ native dedicated server
 browser tab B (10.77.0.3:28960) ─┼─ wss:// ─ Caddy ─ relay ┤        (bridged as 10.77.1.1:28960)
 browser tab C (10.77.0.4:28960) ─┘                       └─ ...
```

* The canonical `net_chan` code is unchanged. `src/web/web_net.cpp` replaces
  `win32/win_net.cpp`: `Sys_SendPacket`/`Sys_GetPacket` speak the relay protocol
  instead of calling `sendto`/`recvfrom`.
* The stock **LAN server browser** works as-is. It broadcasts
  `getinfo` to `255.255.255.255:28960`, and the relay delivers that to every
  virtual host bound at that port.
* Virtual addresses are in `10.0.0.0/8`, so `Sys_IsLANAddress` treats every
  peer as LAN. Servers skip master/auth checks and rate limits for them, as for
  a real LAN.
* Every tab binds `net_port` 28960 on its own virtual address, so hosting
  and joining use the same port without conflicts.
* `--udp-bridge` exposes a real UDP server (for example a native KisakCOD
  dedicated server on the same machine) as a virtual host. Each browser peer
  gets its own UDP source socket, so the server sees distinct clients.

Relay wire protocol (version 1): one datagram per binary WebSocket message.

| Direction | Message | Layout |
| --- | --- | --- |
| client → relay | BIND | `0x01` port:u16be |
| client → relay | SEND | `0x02` ip:4 port:u16be payload |
| relay → client | WELCOME | `0x81` ip:4 |
| relay → client | RECV | `0x82` ip:4 port:u16be payload |

The engine connects to `wss://<page host>/lan?v=1` by default. Set
`globalThis.kisakLanUrl` in the engine Worker to override it.

## Server setup (Linux + Caddy)

1. Build the browser site (`tools/build_web.sh`; the multiplayer target is
   `KisakCOD-web-mp` once it builds) and copy `build/web*/site` to
   `/srv/kisakcod/site`.
2. Run the relay. It needs Node.js 22 or newer and has no npm dependencies:

   ```ini
   # /etc/systemd/system/kisakcod-lan-relay.service
   [Unit]
   Description=KisakCOD browser LAN relay
   After=network.target

   [Service]
   ExecStart=/usr/bin/node /srv/kisakcod/server/lan-relay/relay.mjs --listen 127.0.0.1 --port 8481
   # Optional: bridge a native dedicated server on this machine.
   # ExecStart=/usr/bin/node /srv/kisakcod/server/lan-relay/relay.mjs --listen 127.0.0.1 --port 8481 \
   #     --udp-bridge 10.77.1.1:28960=127.0.0.1:28960
   DynamicUser=yes
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

3. Caddy serves the site and proxies the relay. Caddy proxies WebSocket upgrades
   automatically:

   ```caddyfile
   cod4.example.lan {
       # Only the LAN may reach the game and relay.
       @outside not remote_ip private_ranges
       respond @outside 403

       handle /lan* {
           reverse_proxy 127.0.0.1:8481
       }
       handle {
           root * /srv/kisakcod/site
           file_server
           header {
               Cache-Control "no-cache"
               X-Content-Type-Options "nosniff"
           }
       }
   }
   ```

   HTTPS matters. OPFS, Web Locks and the other storage APIs the launcher requires
   only work in a secure context, so plain `http://192.168.x.y` does not work for
   other machines. A real certificate (or Caddy's internal CA trusted on the
   clients) avoids per-player setup.

4. Check: `curl https://cod4.example.lan/lan` returns `426 WebSocket upgrade
   required`, and `curl http://127.0.0.1:8481/healthz` reports connected peers.

The server does not need a GPU. Every browser renders locally; the relay and
an optional dedicated server only move packets and run game logic.

## Game files

Each player still imports a legally owned COD4 installation in the launcher
(stored privately in browser storage). Streaming the installation from the
server, so players skip the import, is planned. See `docs/WEB_PORT_PLAN.md` in
the KisakCOD repository, Phase 2. Keep any such endpoint restricted to your
LAN and to owners of the game, because the files are Activision's.

## Bring-up status

| Piece | State |
| --- | --- |
| Relay, broadcast, UDP bridge | Implemented; `node --test tests/node/lan_relay.test.mjs` |
| Engine transport (`web_net.cpp`) | Implemented; compiled only by the multiplayer target |
| Multiplayer browser target | In progress |
| Native Linux dedicated server | Not started |
| Asset streaming | Not started |
