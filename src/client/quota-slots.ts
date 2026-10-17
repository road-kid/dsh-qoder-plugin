/**
 * SlotMap merge for the seats this plugin contributes to. The seats are
 * declared by packages this plugin does not depend on, so they are re-stated
 * here to make them type-check. Import this module (for its side effect) in
 * any file that registers into them.
 *
 * The declarations must stay STRUCTURALLY IDENTICAL to upstream's: when a peer
 * package ships its own merge, a duplicate conflicting member would fail
 * compilation — the guard against drift.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Compact controls BEFORE the composer's submit action. Declared by
     * `@deepseek-ai/dsh-client-ui-conversation` as `{ kind: 'list'; scope:
     * 'session' }`; the owner renders each entry inline in the composer
     * toolbar and passes the owning session id to the inject factory.
     *
     * This is where the quota readout chip lives.
     */
    'conversation.input.left': { kind: 'list'; scope: 'session' }
    /**
     * Compact controls BEFORE the composer submit action. Declared by
     * `@deepseek-ai/dsh-client-ui-conversation` as `{ kind: 'list'; scope:
     * 'session' }`. Carries the Qoder probe button.
     */
    'conversation.input.right': { kind: 'list'; scope: 'session' }
    /**
     * The Plugins page's row-configuration seat, declared by
     * `@deepseek-ai/dsh-client-ui-plugin-manager` (not a dependency of this
     * bundle). It is a KEYED slot dispatched with `entryKey = <package
     * name>#<row id>`; hitting it is what puts a 「配置」 control on this
     * plugin's row in the Plugins page and opens this card as that row's page.
     */
    'plugins.row.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewOwnerProps }
    /**
     * The Plugins page's bundle-configuration seat, same owner package, keyed
     * by BUNDLE NAME alone. Rendered inline on the package detail page between
     * the description and the row list — the second way into the same card for
     * a reader who opened the package itself rather than the row.
     */
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewOwnerProps }
  }
}

/**
 * Owner share of both plugin-configuration seats, mirrored structurally from
 * `ui-plugin-manager`'s `PluginConfigViewProps`.
 *
 * `view` is the contract: `summary` asks for the one-liner the card list shows
 * (and the fallback for a row with no description), `page` asks for the
 * configuration body rendered inside the detail page — where the OWNER already
 * draws the title, icon, and breadcrumb, so a registrant must not draw its own
 * heading or disclosure chrome.
 *
 * `form` (the host-owned config form for the entry) is deliberately not
 * declared: this plugin serves its own configuration over its own loopback
 * route, so it never reads the host's form. A different shape from the
 * owner's is harmless — the owner only ever passes it through.
 */
export interface PluginConfigViewOwnerProps {
  /** Which face of the card the page asks for. */
  view: 'summary' | 'page'
}
