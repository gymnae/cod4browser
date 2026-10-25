// Multiplayer owners from qcommon/common.cpp for the browser runtime.
//
// The web build replaces common.cpp with common_gate3_prefix.inl and the
// common_runtime_*.cpp split, which were extracted for single-player. This
// file carries the canonical multiplayer pieces of common.cpp that the
// multiplayer client and server link against. Function bodies are copied
// from common.cpp unchanged.

#ifndef KISAK_MP
#error This File is MultiPlayer Only
#endif

#include <universal/q_shared.h>
#include <qcommon/qcommon.h>
#include <qcommon/net_chan_mp.h>
#include <qcommon/msg_mp.h>
#include <client_mp/client_mp.h>
#include <server_mp/server_mp.h>
#include <game_mp/g_public_mp.h>
#include <ui_mp/ui_mp.h>
#include <universal/dvar.h>
#include <universal/profile.h>

#include <cstring>

const dvar_t *com_dedicated;
const dvar_t *com_masterServerName;
const dvar_t *com_authServerName;
const dvar_t *com_masterPort;
const dvar_t *com_authPort;

// Called from the web Com_InitDvars before the shared registrations, matching
// the order of the multiplayer branch of native Com_InitDvars. Browser engines
// are always clients ("listen server" when hosting).
void Com_InitMultiplayerDvars()
{
    com_dedicated = Dvar_RegisterEnum("dedicated", g_dedicatedEnumNames, 0, DVAR_LATCH, "True if this is a dedicated server");
    com_masterServerName = Dvar_RegisterString(
        "masterServerName",
        "cod4master.activision.com",
        DVAR_CHEAT,
        "Master server name for listing public inet games");
    com_authServerName = Dvar_RegisterString(
        "authServerName",
        "cod4master.activision.com",
        DVAR_CHEAT,
        "Authentication server name for listing public inet games");
    com_masterPort = Dvar_RegisterInt("masterPort", 20810, 0, 0xFFFF, DVAR_CHEAT, "Master server port");
    com_authPort = Dvar_RegisterInt("authPort", 20800, 0, 0xFFFF, DVAR_CHEAT, "Auth server port");
}

void __cdecl Info_Print(const char* s)
{
    uint8_t* o; // [esp+0h] [ebp-410h]
    char* oa; // [esp+0h] [ebp-410h]
    char key[512]; // [esp+8h] [ebp-408h] BYREF
    char value[516]; // [esp+208h] [ebp-208h] BYREF

    if (*s == 92)
        ++s;
    while (*s)
    {
        o = (uint8_t*)key;
        while (*s && *s != 92)
            *o++ = *s++;
        if (o - (uint8_t*)key >= 20)
        {
            *o = 0;
        }
        else
        {
            memset(o, 0x20u, 20 - (o - (uint8_t*)key));
            key[20] = 0;
        }
        Com_Printf(0, "%s", key);
        if (!*s)
        {
            Com_Printf(16, "MISSING VALUE\n");
            return;
        }
        oa = value;
        ++s;
        while (*s && *s != 92)
            *oa++ = *s++;
        *oa = 0;
        if (*s)
            ++s;
        Com_Printf(0, "%s\n", value);
    }
}

uint8_t clientCommonMsgBuf[0x20000];
void __cdecl Com_ClientPacketEvent()
{
    msg_t netmsg; // [esp+4Ch] [ebp-40h] BYREF
    netadr_t adr; // [esp+74h] [ebp-18h] BYREF

    iassert(Sys_IsMainThread());

    PROF_SCOPED("Com_ClientPacketEvent");

    MSG_Init(&netmsg, clientCommonMsgBuf, sizeof(clientCommonMsgBuf));
    Com_PacketEventLoop(NS_CLIENT1, &netmsg);

    if (!com_sv_running->current.enabled)
    {
        while (NET_GetClientPacket(&adr, &netmsg))
            Com_DispatchClientPacketEvent(adr, &netmsg);
    }
}

void __cdecl Com_PacketEventLoop(netsrc_t client, msg_t* netmsg)
{
    netadr_t adr; // [esp+0h] [ebp-18h] BYREF

    while (NET_GetLoopPacket(client, &adr, netmsg))
    {
        CL_PacketEvent(client, adr, netmsg, Sys_Milliseconds());
    }
}

void __cdecl Com_DispatchClientPacketEvent(netadr_t adr, msg_t* netmsg)
{
    CL_PacketEvent(NS_CLIENT1, adr, netmsg, Sys_Milliseconds());
}

uint8_t serverCommonMsgBuf[0x20000];
void __cdecl Com_ServerPacketEvent()
{
    msg_t netmsg; // [esp+30h] [ebp-40h] BYREF
    netadr_t adr; // [esp+58h] [ebp-18h] BYREF

    PROF_SCOPED("Com_ServerPacketEvent");

    iassert(Sys_IsMainThread());

    MSG_Init(&netmsg, serverCommonMsgBuf, 0x20000);

    if (com_sv_running->current.enabled)
    {
        while (NET_GetServerPacket(&adr, &netmsg))
            SV_PacketEvent(adr, &netmsg);
    }
    while (NET_GetLoopPacket(NS_SERVER, &adr, &netmsg))
    {
        if (com_sv_running->current.enabled)
            SV_PacketEvent(adr, &netmsg);
    }
}

int Com_UpdateMenu()
{
    int result; // eax
    uiMenuCommand_t MenuScreen; // eax
    connstate_t clcState; // [esp+4h] [ebp-4h]

    clcState = clientUIActives[0].connectionState;
#ifdef KISAK_MP
    result = UI_IsFullscreen(0);
#elif KISAK_SP
    result = UI_IsFullscreen();
#endif
    if (!result && clcState == CA_DISCONNECTED)
    {
        MenuScreen = (uiMenuCommand_t)UI_GetMenuScreen();
        return UI_SetActiveMenu(0, MenuScreen);
    }
    return result;
}

int __cdecl Com_AddToString(const char* add, char* msg, int len, int maxlen, int mayAddQuotes)
{
    int addQuotes; // [esp+0h] [ebp-8h]
    int i; // [esp+4h] [ebp-4h]
    int ia; // [esp+4h] [ebp-4h]

    addQuotes = 0;
    if (mayAddQuotes)
    {
        if (*add)
        {
            for (i = 0; i < maxlen - len && add[i]; ++i)
            {
                if (add[i] <= 32)
                {
                    addQuotes = 1;
                    break;
                }
            }
        }
        else
        {
            addQuotes = 1;
        }
    }
    if (addQuotes && len < maxlen)
        msg[len++] = 34;
    for (ia = 0; len < maxlen && add[ia]; ++ia)
        msg[len++] = add[ia];
    if (addQuotes && len < maxlen)
        msg[len++] = 34;
    return len;
}
