/**
 * Modules.
 *
 * A module is a top-level content domain. Only `web` and `app` are enabled
 * now (§34); the rest are declared so that the database enum, the CMS filters
 * and the public API already understand them. Turning one on later is a
 * `enabled: true` flip plus that module's own content kinds — it does not
 * touch media, taxonomy, sources, review, publishing or provenance, all of
 * which are module-agnostic by construction.
 *
 * Note what is deliberately absent: there is no `uxui` module. UX and UI are a
 * classification layer applied to content (§"IMPORTANT CONCEPT"), expressed as
 * `ux_pattern` / `ui_pattern` taxonomy kinds, not as a content source.
 */

export const MODULES = {
  web: {
    label: "Web",
    description: "Websites: pages, flows, states and interactions captured from the browser.",
    enabled: true,
    /** Content kinds this module can own. */
    kinds: ["website", "page", "flow", "state", "interaction"],
  },
  app: {
    label: "App",
    description: "Native and mobile apps: screens, flows, states and interactions.",
    enabled: true,
    kinds: ["app", "screen", "flow", "state", "interaction"],
  },
  brand: {
    label: "Brand identity",
    description: "Identity systems, logos, brand guidelines.",
    enabled: false,
    kinds: [],
  },
  graphic: {
    label: "Graphic design",
    description: "Editorial, poster and layout work.",
    enabled: false,
    kinds: [],
  },
  motion: {
    label: "Motion",
    description: "Motion design and animation.",
    enabled: false,
    kinds: [],
  },
  three_d: {
    label: "3D",
    description: "3D and spatial design.",
    enabled: false,
    kinds: [],
  },
  packaging: {
    label: "Packaging",
    description: "Physical packaging and print.",
    enabled: false,
    kinds: [],
  },
  email: {
    label: "Email",
    description: "Email design and lifecycle messaging.",
    enabled: false,
    kinds: [],
  },
  campaign: {
    label: "Campaigns",
    description: "Multi-channel campaigns.",
    enabled: false,
    kinds: [],
  },
} as const satisfies Record<string, ModuleMeta>;

export interface ModuleMeta {
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly kinds: readonly string[];
}

export type ModuleKey = keyof typeof MODULES;

export const MODULE_KEYS = Object.keys(MODULES) as [ModuleKey, ...ModuleKey[]];

/** Modules an operator can currently select in the CMS. */
export const ENABLED_MODULE_KEYS = MODULE_KEYS.filter((k) => MODULES[k].enabled);

export function isModuleEnabled(key: string): key is ModuleKey {
  return key in MODULES && MODULES[key as ModuleKey].enabled;
}

export function moduleLabel(key: ModuleKey): string {
  return MODULES[key].label;
}
