// The package manifest is the single source of truth for the release version.
// `scripts/verify-release.mjs` and the release workflow both fail if an
// artifact disagrees with it, so there is no second copy to drift.
import pkg from "../package.json" with { type: "json" };

export const VERSION = pkg.version;
export const PACKAGE_NAME = pkg.name;
export const NODE_REQUIREMENT = pkg.engines?.node ?? ">=24.0.0";

export const SUPPORTED_ENGINE_RANGE = ">=1.0.0 <2.0.0";
