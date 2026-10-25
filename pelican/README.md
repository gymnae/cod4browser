# Pelican egg: KisakCOD LAN

`egg-kisakcod-lan.json` hosts the browser multiplayer build on a
[Pelican](https://pelican.dev) (or Pterodactyl) node. One server runs one Node.js
process that serves the WebAssembly game page and the LAN relay at `/lan`
(see `docs/lan-multiplayer.md`).

No game data is downloaded, packaged or served. Every player imports files from
their own Call of Duty 4 installation in the browser.

## Install

1. In the Pelican admin area, **Eggs → Import** `pelican/egg-kisakcod-lan.json`.
2. Create a server with that egg and one port allocation. During installation
   the egg builds the site from source:
   * memory: a 4 GB limit is comfortable. A full-LTO Release build peaked
     at about 1.7 GB of system memory with 4 jobs. `BUILD_FULL_LTO=0` lowers it
     further at some runtime cost.
   * time: the compile took 4 minutes on 4 cores, plus downloading the
     pinned Emscripten SDK (about 300 MB), FFmpeg and OpenAL Soft sources.
   * At runtime the server needs little: about 100 MB of memory and 50 MB of disk.
3. Start the server. The console shows
   `[lan-relay] listening on 0.0.0.0:<port>/lan, serving /home/container/site`.

To update, change **Source branch or tag** if needed and reinstall the server.
`BUILD_INFO.txt` in the server files records the commit that was built. The
matching source archive is served as `/kisakcod-web-source.tar.gz` (GPL-3.0).

## HTTPS in front

Browsers only allow the game's storage APIs (OPFS, Web Locks) in a secure
context, so players must reach the page over HTTPS. Point your reverse proxy
at the allocation; Caddy proxies the WebSocket upgrade automatically:

```caddyfile
cod4.example.lan {
    reverse_proxy <pelican-node-ip>:<allocated-port>
}
```

## Variables

| Variable | Purpose |
| --- | --- |
| `KISAK_BASIC_AUTH` | Optional `user:password` for the page and the relay (not `/healthz`). Useful if the allocation is reachable beyond your LAN. Alternatively authenticate in the reverse proxy. |
| `KISAK_UDP_BRIDGE` | Optional `VIP:PORT=HOST:PORT[,…]`: exposes native UDP game servers to browser players. |
| `GIT_REPO`, `GIT_REF` | Source the installer builds. |
| `BUILD_FULL_LTO`, `BUILD_JOBS` | Installer build settings. |

## Editing the egg

The installation script is `install.sh`. After changing it or
`generate_egg.py`, regenerate and verify the egg:

```bash
python3 pelican/generate_egg.py
python3 pelican/generate_egg.py --check
```
