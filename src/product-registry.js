/**
 * Canonical Coderax product registry.
 *
 * Single source of truth for the five-product ecosystem. Dependency-free ESM
 * so the browser bundle, the CLI and the Electron shell can all consume it.
 *
 * Truthfulness rule: `status` may only describe functionality that exists and
 * has been verified. Do not promote a product to "live" from this file alone.
 */

/** @typedef {'live' | 'preview' | 'in-development'} ProductStatus */

/**
 * @typedef {object} Product
 * @property {string} id
 * @property {string} name
 * @property {string} tagline
 * @property {string} description
 * @property {ProductStatus} status
 * @property {string} availabilityNote
 * @property {string} icon
 * @property {string} shortcut
 * @property {'internal' | 'external' | 'none'} launchKind
 * @property {string | null} target
 * @property {string} cta
 * @property {string[]} roadmap
 */

/** @type {ReadonlyArray<Product>} */
export const PRODUCTS = Object.freeze([
  Object.freeze({
    id: 'desktop',
    name: 'Desktop',
    tagline: 'Installable app for Windows, macOS and Linux',
    description:
      'The full Coderax workspace in a native window with local file access, '
      + 'auto-updates and the same account as the browser.',
    status: 'preview',
    availabilityNote:
      'Electron sources and the Windows packager exist in desktop/; no signed '
      + 'installer artifact has been verified from this build.',
    icon: 'Monitor',
    shortcut: '1',
    launchKind: 'none',
    target: null,
    cta: 'View install options',
    roadmap: Object.freeze([
      'Verify the Windows installer artifact from desktop/package.ps1',
      'Sign and notarise macOS builds',
      'Publish auto-update feed',
    ]),
  }),
  Object.freeze({
    id: 'web',
    name: 'Web',
    tagline: 'The complete Coderax app in your browser',
    description:
      'Chat, Work mode, agents, tools, projects and settings, served from the '
      + 'existing React client with your saved conversations intact.',
    status: 'live',
    availabilityNote: 'The production web client is deployed and serving traffic.',
    icon: 'Globe',
    shortcut: '3',
    launchKind: 'internal',
    target: '/c/new',
    cta: 'Open Coderax Web',
    roadmap: Object.freeze([]),
  }),
  Object.freeze({
    id: 'chat',
    name: 'Chat',
    tagline: 'Unified AI conversation across every client',
    description:
      'Multi-model chat with streaming responses, thinking effort, files, '
      + 'agents and MCP tools — shared by Web, Desktop and the CLI.',
    status: 'live',
    availabilityNote:
      'The existing chat and Work surfaces are the live implementation of this product.',
    icon: 'MessagesSquare',
    shortcut: '5',
    launchKind: 'internal',
    target: '/c/new',
    cta: 'Start a conversation',
    roadmap: Object.freeze([]),
  }),
  Object.freeze({
    id: 'cli',
    name: 'CLI',
    tagline: 'Coderax from your terminal',
    description:
      'Sign in, chat, run agents and drive Cloud projects from PowerShell or '
      + 'bash, with JSON output and meaningful exit codes for automation.',
    status: 'preview',
    availabilityNote:
      'The cli/ package runs from source and passes its test suite; npm '
      + 'publishing is not configured yet.',
    icon: 'TerminalSquare',
    shortcut: '2',
    launchKind: 'none',
    target: null,
    cta: 'See CLI setup',
    roadmap: Object.freeze([
      'Publish @coderax/cli to the npm registry',
      'Device-code login flow against the Coderax API',
      'Cloud subcommands once Cloud execution exists',
    ]),
  }),
  Object.freeze({
    id: 'cloud',
    name: 'Cloud',
    tagline: 'Remote agents and sandboxed execution',
    description:
      'Connect a repository, provision an isolated workspace and let agents '
      + 'build and test away from your machine, with logs you can watch.',
    status: 'in-development',
    availabilityNote:
      'No managed executor exists in this repository yet; nothing is billed and '
      + 'no workspace can be provisioned.',
    icon: 'CloudCog',
    shortcut: '4',
    launchKind: 'none',
    target: null,
    cta: 'See the Cloud roadmap',
    roadmap: Object.freeze([
      'Sandbox provider selection and cost ceilings',
      'Repository authorisation and workspace provisioning',
      'Job queue, live logs, cancellation and cleanup',
      'Quota metering tied to subscription entitlements',
    ]),
  }),
]);

/** Human-facing labels. Keep in sync with ProductStatus. */
export const STATUS_LABELS = Object.freeze({
  live: 'Live',
  preview: 'Preview',
  'in-development': 'In development',
});

/** Sort order used by the rail and the launcher grid. */
export const PRODUCT_ORDER = Object.freeze(['desktop', 'cli', 'web', 'cloud', 'chat']);

/**
 * @param {string} id
 * @returns {Product | undefined}
 */
export function getProduct(id) {
  return PRODUCTS.find((product) => product.id === id);
}

/**
 * Products that can be opened right now.
 * @returns {Product[]}
 */
export function getLaunchableProducts() {
  return getOrderedProducts().filter((product) => product.launchKind !== 'none');
}

/**
 * @returns {Product[]}
 */
export function getOrderedProducts() {
  return PRODUCT_ORDER.map((id) => getProduct(id)).filter(
    (product) => product !== undefined,
  );
}

/**
 * @param {Product} product
 * @returns {boolean}
 */
export function isLaunchable(product) {
  return product.launchKind !== 'none' && product.target !== null;
}

/**
 * Resolve the action a card should perform.
 * @param {Product} product
 * @returns {{kind: 'navigate', to: string} | {kind: 'external', href: string} | {kind: 'roadmap'}}
 */
export function resolveLaunch(product) {
  if (product.launchKind === 'internal' && product.target) {
    return { kind: 'navigate', to: product.target };
  }
  if (product.launchKind === 'external' && product.target) {
    return { kind: 'external', href: product.target };
  }
  return { kind: 'roadmap' };
}

/**
 * The product implied by a pathname, so the rail highlights the right entry.
 * @param {string} pathname
 * @returns {string | null}
 */
export function productForPath(pathname) {
  if (!pathname) {
    return null;
  }
  if (/^\/(cloud|projects)(\/|$)/.test(pathname)) {
    return 'cloud';
  }
  if (/^\/(c|chat)(\/|$)/.test(pathname) || pathname === '/') {
    return 'chat';
  }
  return 'web';
}
