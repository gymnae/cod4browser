#include <database/database.h>
#include <universal/q_shared.h>
#include <xanim/xmodel.h>
#include <gfx_d3d/material_types.h>

// Portable renderer-frontend registrations used by the browser fastfile
// runtime. Native loose-source registration remains in the D3D/asset tools.
XModel *__cdecl R_RegisterModel(const char *name)
{
    iassert(name && name[0]);
    return XModelPrecache_FastFile(name);
}

Material *__cdecl Material_RegisterHandle(const char *name, int imageTrack)
{
    (void)imageTrack;
    iassert(name);
    return DB_FindXAssetHeader(ASSET_TYPE_MATERIAL, name).material;
}

// Native compares against rgp.defaultMaterial ("$default"); missing
// fastfile materials resolve to copies of that asset's tables.
bool __cdecl Material_IsDefault(const Material *material)
{
    iassert(material);
    const Material *defaultMaterial =
        DB_FindXAssetHeader(ASSET_TYPE_MATERIAL, "$default").material;
    iassert(defaultMaterial);
    if (material->textureTable != defaultMaterial->textureTable)
        return false;
    if (material->constantTable == defaultMaterial->constantTable)
        return material->techniqueSet == defaultMaterial->techniqueSet;
    return false;
}

const FxEffectDef *__cdecl FX_Register(const char *name)
{
    iassert(name && name[0]);
    iassert(I_strncmp(name, "fx/", 3));
    return DB_FindXAssetHeader(ASSET_TYPE_FX, name).fx;
}
