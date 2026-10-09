/**
 * Test fixtures. BRANDS_JSON reproduces the company table in the case-study
 * brief (names and websites are requirements, not observed answers). The
 * catalog is built with the shipped config/brands.config.json, so tests also
 * check the real configuration.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildBrandCatalog, parseBrandConfig, parseBrandsJson } from "../../src/lib/brands";
import type { BrandCatalog } from "../../src/lib/brandTypes";

export const BRANDS_JSON = {
  client: { name: "Corvane Fleet", website: "corvanefleet.com" },
  tracked_competitors: [
    { name: "Trakvia", website: "trakvia.com" },
    { name: "Routelyne", website: "routelyne.com" },
    { name: "Gridwell Systems", website: "gridwell.io" },
  ],
  other_companies: [
    { name: "Fleetora", website: "fleetora.com" },
    { name: "Novahaul", website: "novahaul.com" },
  ],
};

export const SHIPPED_CONFIG_PATH = fileURLToPath(new URL("../../config/brands.config.json", import.meta.url));

export function shippedConfig(): unknown {
  return JSON.parse(readFileSync(SHIPPED_CONFIG_PATH, "utf8"));
}

export function shippedCatalog(): BrandCatalog {
  const { config, issues } = parseBrandConfig(shippedConfig());
  if (!config) throw new Error(`shipped config invalid: ${JSON.stringify(issues)}`);
  const { entries } = parseBrandsJson(BRANDS_JSON);
  const built = buildBrandCatalog(entries, config);
  if (!built.catalog) throw new Error(`shipped catalog invalid: ${JSON.stringify(built.issues)}`);
  return built.catalog;
}
