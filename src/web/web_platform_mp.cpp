// Browser definitions for native platform services that only the multiplayer
// client reaches. Each one either has no browser equivalent yet (voice chat)
// or is native developer tooling (cubemap shots, reflection probe baking).

#ifndef KISAK_MP
#error This File is MultiPlayer Only
#endif

#include <universal/q_shared.h>
#include <qcommon/qcommon.h>
#include <qcommon/com_bsp.h>
#include <qcommon/threads.h>
#include <gfx_d3d/r_reflection_probe.h>
#include <gfx_d3d/r_rendercmds.h>
#include <gfx_d3d/r_screenshot.h>
#include <win32/win_local.h>

#include <cstdint>

// --- Process control -------------------------------------------------------

void __cdecl Sys_QuitAndStartProcess(const char *exeName, const char *)
{
    // Native multiplayer uses this to launch single-player or an auto-update
    // installer. A browser page cannot start other executables.
    Com_Printf(16, "Starting %s is not available in the browser.\n", exeName ? exeName : "a process");
}

// --- Threads -----------------------------------------------------------------

WinThreadLock __cdecl Win_GetThreadLock()
{
    // The engine runs on a single Worker thread; sys_lockThreads has no effect.
    return THREAD_LOCK_NONE;
}

// --- World loading -----------------------------------------------------------

void __cdecl Com_UnloadBsp()
{
    // Loose BSP loading is unavailable in the browser fastfile runtime; world
    // assets are released with their zones (see Com_CleanupBsp).
    iassert(IsFastFileLoad());
}

// --- Voice chat --------------------------------------------------------------
// Not part of the first browser multiplayer slice (needs microphone capture
// and speex in Wasm). The client behaves as if nobody is talking.

double __cdecl Voice_GetVoiceLevel()
{
    return 0.0;
}

void __cdecl Voice_Playback() {}

void __cdecl Voice_IncomingVoiceData(unsigned __int8, unsigned __int8 *, int) {}

int __cdecl Voice_GetLocalVoiceData()
{
    return 0;
}

bool __cdecl Voice_IsClientTalking(uint32_t)
{
    return false;
}

// --- Renderer developer tooling ---------------------------------------------
// cubemapShot and r_reflectionProbeGenerate bake assets with the native D3D9
// renderer. The WebGL2 backend does not implement them.

void __cdecl R_BeginCubemapShot(int, int)
{
    Com_Error(ERR_DROP, "cubemapShot is not available in the browser renderer");
}

void __cdecl R_EndCubemapShot(CubemapShot) {}

void __cdecl R_SaveCubemapShot(char *, CubemapShot, float, float) {}

void __cdecl R_LightingFromCubemapShots(const float *) {}

void __cdecl R_ClearClientCmdList2D() {}

void __cdecl R_BspGenerateReflections()
{
    Com_Printf(16, "r_reflectionProbeGenerate is not available in the browser renderer.\n");
}
