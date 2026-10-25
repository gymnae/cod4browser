// Multiplayer-only registry queries for the browser runtime.
//
// The web build compiles db_registry_lifecycle.inl instead of the native
// db_registry.cpp. These are the db_registry.cpp owners that only the
// multiplayer client/server reach (referenced-fastfile lists sent to
// clients, map existence checks and the debug zone). Zone file access goes
// through the browser platform file API instead of Win32 CreateFileA.

#ifndef KISAK_MP
#error This File is MultiPlayer Only
#endif

#include <database/database.h>
#include <database/db_file_platform.h>
#include <database/db_registry_publication.h>
#include <qcommon/qcommon.h>
#include <universal/com_files.h>
#include <universal/com_memory.h>
#include <universal/q_shared.h>

#include <cstdio>
#include <cstring>

namespace
{
char g_zoneNameList[2080];
}

char *__cdecl DB_ReferencedFFChecksums()
{
    const int localizedPrefixLength = static_cast<int>(strlen("localized_"));
    g_zoneNameList[0] = 0;
    for (int i = 0; i < 32; ++i)
    {
        if (g_zones[i].name[0] && I_strncmp(g_zones[i].name, "localized_", localizedPrefixLength))
        {
            if (g_zoneNameList[0])
                I_strncat(g_zoneNameList, sizeof(g_zoneNameList), " ");
            char zoneSizeStr[16];
            std::snprintf(zoneSizeStr, sizeof(zoneSizeStr), "%d", g_zones[i].fileSize);
            I_strncat(g_zoneNameList, sizeof(g_zoneNameList), zoneSizeStr);
        }
    }
    return g_zoneNameList;
}

char *__cdecl DB_ReferencedFFNameList()
{
    const int localizedPrefixLength = static_cast<int>(strlen("localized_"));
    g_zoneNameList[0] = 0;
    for (int i = 0; i < 32; ++i)
    {
        if (g_zones[i].name[0] && I_strncmp(g_zones[i].name, "localized_", localizedPrefixLength))
        {
            if (g_zoneNameList[0])
                I_strncat(g_zoneNameList, sizeof(g_zoneNameList), " ");
            // The browser runtime does not load mod zones (DB_ModFileExists
            // is false), so no zone carries the fs_game prefix.
            iassert(!g_zones[i].modZone);
            I_strncat(g_zoneNameList, sizeof(g_zoneNameList), g_zones[i].name);
        }
    }
    return g_zoneNameList;
}

int32_t __cdecl DB_FileSize(const char *zoneName, int32_t isMod)
{
    if (isMod)
        return 0; // no mod zones in the browser runtime
    char filename[260];
    DB_PlatformBuildZonePath(zoneName, 0x100u, filename);
    const DBPlatformFile zoneFile = DB_PlatformOpenFile(filename);
    if (zoneFile == DB_PLATFORM_INVALID_FILE)
        return 0;
    const std::int64_t size = DB_PlatformFileSize(zoneFile);
    DB_PlatformCloseFile(zoneFile);
    return size > 0 && size <= INT32_MAX ? static_cast<int32_t>(size) : 0;
}

void __cdecl DB_UpdateDebugZone()
{
    // The native debug zone is set by the "loadzone" console command
    // (DB_LoadZone_f), which the browser registry does not register.
}

void __cdecl Hunk_OverrideDataForFile(int32_t type, const char *name, void *data)
{
    iassert(Sys_IsMainThread());
    for (fileData_s *searchFileData = com_fileDataHashTable[FS_HashFileName(name, 1024)];
        searchFileData;
        searchFileData = searchFileData->next)
    {
        if (searchFileData->type == type && !I_stricmp(searchFileData->name, name))
        {
            searchFileData->data = data;
            return;
        }
    }
    iassert(!"Hunk_OverrideDataForFile: could not find data");
}
