// Browser replacement for win32/win_steam.cpp.
//
// The browser product has no Steam client. Multiplayer here targets a trusted
// LAN reached through the relay (src/web/web_net.cpp), so the Steam ticket
// exchange in getchallenge carries a fixed-format LAN identity instead:
//
//   ticket  = "KISAKLAN1" magic followed by 8 random bytes
//   steamID = random 64-bit identity chosen once per engine session
//
// Servers accept any well-formed LAN ticket. This is identity for scoreboards
// and ban lists, not authentication: anyone on the relay can claim any ID.

#include <win32/win_steam.h>

#include <cstdint>
#include <cstring>
#include <random>

namespace
{
constexpr char LAN_TICKET_MAGIC[] = "KISAKLAN1";
constexpr std::size_t LAN_TICKET_MAGIC_LENGTH = sizeof(LAN_TICKET_MAGIC) - 1u;
constexpr std::size_t LAN_TICKET_LENGTH = LAN_TICKET_MAGIC_LENGTH + 8u;

unsigned char g_ticket[LAN_TICKET_LENGTH];
std::uint64_t g_steamId = 0;

void EnsureIdentity()
{
    if (g_steamId)
        return;
    std::random_device device;
    std::uint64_t id = 0;
    while (!id)
        id = (static_cast<std::uint64_t>(device()) << 32) | device();
    // Keep the value inside the individual-account range so code that parses
    // or prints it as a SteamID64 still sees a plausible shape.
    g_steamId = 0x0110000100000000ull | (id & 0xffffffffull);
    std::memcpy(g_ticket, LAN_TICKET_MAGIC, LAN_TICKET_MAGIC_LENGTH);
    for (std::size_t i = 0; i < 8u; ++i)
        g_ticket[LAN_TICKET_MAGIC_LENGTH + i] = static_cast<unsigned char>(id >> (i * 8u));
}
} // namespace

bool g_steamInitialized = false;

void Steam_Init()
{
    EnsureIdentity();
    g_steamInitialized = true;
}

void Steam_Shutdown()
{
    g_steamInitialized = false;
}

bool Steam_UpdateClientAuthTicket(netadr_t)
{
    EnsureIdentity();
    return true;
}

bool Steam_GetRawClientTicket(unsigned char **pBuffer, uint32 *pSize)
{
    EnsureIdentity();
    *pBuffer = g_ticket;
    *pSize = static_cast<uint32>(LAN_TICKET_LENGTH);
    return true;
}

void Steam_CancelClientTicket() {}

uint64_t Steam_GetClientSteamID64()
{
    EnsureIdentity();
    return g_steamId;
}

bool Steam_CheckClientTicket(const void *pAuthTicket, uint32 authTicketLen, uint64_t steamID64)
{
    return steamID64 != 0 && authTicketLen == LAN_TICKET_LENGTH &&
        std::memcmp(pAuthTicket, LAN_TICKET_MAGIC, LAN_TICKET_MAGIC_LENGTH) == 0;
}

void Steam_CheckClients() {}

void Steam_OnClientDropped(uint64_t) {}

void Steam_SV_AddTestCommands() {}
