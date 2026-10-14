/**
 * Local Read-Only Dashboard embedded HTML/CSS/JS assets for Antigravity MCP Bridge.
 *
 * Invariants:
 * - Pure Node.js built-in, zero external assets, fonts, or CDNs.
 * - Strict CSP and no-store security posture.
 * - Read-only: no mutation buttons, no arbitrary filesystem access.
 * - Safe DOM text APIs only: never assign untrusted content via innerHTML.
 * - Dense and responsive layout optimized for Codex side panel or browser tabs.
 */
export declare function getDashboardHtml(token: string): string;
