// LAN multiplayer installation profile. The multiplayer site is built with
// this module in place of asset_profile.mjs (see scripts/web/CMakeLists.txt),
// so it keeps the same exports. Only the multiplayer fastfile families are
// imported; single-player campaign zones are skipped to save browser storage.
const BASE_ARCHIVES = Object.freeze(Array.from(
    { length: 14 },
    (_, index) => `main/iw_${String(index).padStart(2, "0")}.iwd`,
));
// Zones loaded by the multiplayer renderer/UI startup (CL_SetFastFileNames
// in client_mp/cl_main_mp.cpp) plus the guaranteed retail map.
const STARTUP_ZONES = Object.freeze([
    "code_post_gfx_mp", "localized_code_post_gfx_mp",
    "ui_mp", "common_mp", "localized_common_mp",
]);
const REQUIRED_MAP = "mp_shipment";

export function getInstallProfile(language = "english")
{
    if (typeof language !== "string" || !/^[a-z]{1,16}$/.test(language))
        throw new TypeError("Invalid installation language path component.");
    return Object.freeze({
        version: 1,
        id: `mp-lan-${language}-v1`,
        product: "lan-multiplayer",
        language,
        map: REQUIRED_MAP,
        baseArchives: BASE_ARCHIVES,
        localizedArchives: Object.freeze(Array.from({ length: 7 },
            (_, index) => `main/localized_${language}_iw${String(index).padStart(2, "0")}.iwd`)),
        startupZones: Object.freeze(STARTUP_ZONES.map((name) => `zone/${language}/${name}.ff`)),
        mapZone: `zone/${language}/${REQUIRED_MAP}.ff`,
    });
}

export function getRequiredAssets(language = "english")
{
    const profile = getInstallProfile(language);
    return Object.freeze([
    Object.freeze({
        path: "localization.txt",
        minimumSize: 1,
        maximumSize: 4095,
        label: "Localization configuration",
        kind: "localization",
    }),
    ...BASE_ARCHIVES.map((path) => Object.freeze({
        path, minimumSize: 100, maximumSize: 512 * 1024 * 1024,
        label: "Base asset archive", kind: "iwd",
    })),
    ...profile.localizedArchives.map((path) => Object.freeze({
        path, minimumSize: 100, maximumSize: 512 * 1024 * 1024,
        label: "Localized asset archive", kind: "iwd",
    })),
    ...profile.startupZones.map((path) => Object.freeze({
        path, minimumSize: 14, maximumSize: 512 * 1024 * 1024,
        label: "Multiplayer startup fastfile", kind: "fastfile",
    })),
    Object.freeze({
        path: profile.mapZone,
        minimumSize: 14,
        maximumSize: 512 * 1024 * 1024,
        label: "Shipment map fastfile",
        kind: "fastfile",
    }),
    ]);
}

export const M12_INSTALL_PROFILE = getInstallProfile();
export const REQUIRED_ASSETS = getRequiredAssets();

/** @param {string} path */
export function isCinematicPath(path)
{
    return /^main\/video\/[a-z0-9_]+\.bik$/.test(path);
}

/**
 * Optional fastfiles admitted into this profile: every multiplayer map and
 * multiplayer support zone (mp_*.ff, *_mp.ff), e.g. mp_killhouse.
 * The export name is shared with the single-player profile module.
 */
export function isAdditionalSinglePlayerFastfile(
    /** @type {string} */
    path, language = M12_INSTALL_PROFILE.language)
{
    const prefix = `zone/${language}/`;
    if (!path.startsWith(prefix) || path.length <= prefix.length ||
        path.slice(prefix.length).includes("/") || !path.endsWith(".ff")) return false;
    const name = path.slice(prefix.length, -3);
    return /^[a-z0-9_]+$/.test(name) && (name.startsWith("mp_") || name.endsWith("_mp"));
}

/** @param {string} path */
export function isSupportedImportedPath(path, language = "english")
{
    return path === "localization.txt" || BASE_ARCHIVES.includes(path) ||
        Array.from({ length: 7 }, (_, index) =>
            `main/localized_${language}_iw${String(index).padStart(2, "0")}.iwd`).includes(path) ||
        isAdditionalSinglePlayerFastfile(path, language) || isCinematicPath(path);
}
