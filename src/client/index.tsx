/** Browser half: Qoder account status, composer quota readout, and plugin settings. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// The settings domain base owns the `settings.section` slot contract (and the
// 0.1.5-only `ctx.settingsScope` augmentation) — imported for its TYPES only,
// which is what keeps this bundle free of a runtime dependency on either
// version's settings package.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ComposerQuotaChip } from './ComposerQuota.tsx'
import { QoderProbeControl } from './QoderProbeControl.tsx'
import { QoderPluginCard } from './QoderPluginCard.tsx'
import type { QoderPluginCardInjected } from './QoderPluginCard.tsx'
import type { QuotaSection, QuotaSettingsScope } from './QuotaSettingsCard.tsx'
import { OwnQuotaSettingsScope } from './http-settings-scope.ts'
import { injectQuotaCss } from './quota-styles.ts'
import './quota-slots.ts'
import { quotaSignInState, setQuotaPollMs } from './quota-settings-store.ts'
import { en, zh } from './locales.ts'
import type { QoderSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Qoder plugin card copy, and the shared quota readout copy. */
    'settings.qoder': QoderSettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-connect-qoder-x-client'
/**
 * Client services this bundle requires BEFORE it activates.
 *
 * DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
 * hold the browser `ClientContext` alias and the `slots` service). The services
 * this card relies on now come from narrower packages: the `slots` registry
 * moved to `@deepseek-ai/dsh-client-ui-renderer` and `locale` stayed in
 * `@deepseek-ai/dsh-client-locale`. Both are named in the package's
 * `dsh.client.inject` list.
 *
 * NOT declared here: the settings services. `settingsScope` (0.1.5) does not
 * exist at all on 0.1.7 — a static service dependency on it is what left this
 * plugin's client activation pending forever — and `configForms` (0.1.7) does
 * not exist on 0.1.5. Neither is used any more (see `OwnQuotaSettingsScope`),
 * so no callback waits on them either.
 *
 * ALSO NOT declared here: `ui-plugin-manager`. The two plugin-configuration
 * seats this card registers into (`plugins.row.config`, `plugins.bundle.config`)
 * are declared by that package, but the registrations go through
 * `ctx.slots.inject`, which is a CALLBACK on a slot NAME — a deployment that
 * never composes the Plugins page simply never calls back, exactly like the
 * optional services above. A static dependency would instead gate this whole
 * client on a package the plugin does not need to serve models.
 */
// `modelDirectories` reads the active session through `remote.session`.
// Declaring that dependency at the client entry is required by the Desktop
// renderer; without it Cordis rejects `directoryFor()` before this bundle can
// finish registering its contributions.
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/**
 * The profile ROW ID this plugin runs as — the id its own patch declares.
 *
 * `cordis.patch.yml` inserts `- id: llm-qoder-x, name: dsh-connect-qoder-x`, so
 * the Plugins page reports this plugin's row as `llm-qoder-x`. The browser half
 * needs it for exactly one thing: the right half of {@link ROW_CONFIG_KEY}.
 */
const ENTRY_ID = 'llm-qoder-x'

/**
 * The two 0.1.7 seats this card registers into, on the Plugins page.
 *
 * Both are KEYED slots declared by `@deepseek-ai/dsh-client-ui-plugin-manager`
 * (`packages/client/ui-plugin-manager/src/client/slot-contract.ts`) and both
 * receive the same card component; only the key differs:
 *
 *   - `plugins.row.config`, keyed `<package name>#<row id>`, is the PRIMARY seat.
 *     Hitting it is what makes the Plugins page put a 「配置」 control on this
 *     plugin's row, and clicking that opens this card as the row's own page.
 *   - `plugins.bundle.config`, keyed by PACKAGE NAME alone, renders inline on the
 *     package detail page between the description and the row list.
 */
const ROW_CONFIG_SLOT = 'plugins.row.config'
const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config'

/** This plugin's package name — the `plugins.bundle.config` key, and the left half of the row key. */
const PACKAGE_NAME = 'dsh-connect-qoder-x'

/** The complete `plugins.row.config` key (`` `${pkg.name}#${rowId}` ``). */
const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ENTRY_ID}`

/**
 * Register card copy, the unified Qoder card on both Plugins-page seats, the
 * composer quota readout, and the context-window probe.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change (for
 * example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades
 * to a `console.error` instead of throwing into the DSH loader and raising
 * the red "Failed to load plugins" banner. The host provider keeps working:
 * the `qoder` model channel is unaffected, and `dsh-connect-qoder-x
 * status` reports host health via the heartbeat file.
 *
 * NOTE: the try/catch boundary of this function is mirrored (duplicated) in
 * `tests/client-fallback.spec.ts`, because the real client entry imports
 * browser-only DSH packages that cannot load in the Node test environment.
 * That test therefore does not import this function — it replicates its
 * shape. If you change the guarded body or the `console.error` message here,
 * update the mirrored `apply()` in that spec too, or the fallback test will
 * silently diverge from this real implementation.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-qoder-x: settings copy')
    const t = ctx.locale.bind(namespace) as QoderPluginCardInjected['t']

    // 1. The quota settings values the card edits, bound to this plugin's OWN
    // settings file. The face is filled in by `adoptQuotaScope` below.
    /**
     * The bound quota settings face, filled in as soon as this plugin's own
     * settings file answers (see {@link OwnQuotaSettingsScope}).
     *
     * It is bound on a STORED fact rather than when the card's inject factory
     * first runs: the factory only executes while the Plugins page renders, so a
     * fresh page load read no toggles and rendered no readout until the user
     * opened that page. The face's subscription mirrors the poll interval into
     * the shared store the composer readout reads; a deployment where the host
     * route never answers never binds, and the readout falls back to its
     * default interval.
     */
    let quotaScope: QuotaSettingsScope<QuotaSection> | undefined
    const adoptQuotaScope = (scope: QuotaSettingsScope<QuotaSection>): void => {
      quotaScope = scope
      const applySnapshot = (): void => {
        const value = scope.getSnapshot().value
        if (typeof value?.quotaPollMs === 'number') setQuotaPollMs(value.quotaPollMs)
      }
      applySnapshot()
      scope.subscribe(applySnapshot)
    }

    /**
     * The card's inject face. One face serves both seats: the card is the same
     * component either way, and it reads `view` from its PROPS (the owner's
     * contract), not from here.
     */
    const cardFace = (): QoderPluginCardInjected => ({
      t,
      scope: quotaScope,
      signedIn: () => quotaSignInState(),
      unified: true,
    })

    /**
     * Register the unified Qoder card on both Plugins-page configuration seats.
     *
     * Two registrations, one component, keys derived above. They are independent
     * — a deployment that declares only one of the two seats gets the card on
     * that one and simply never calls back for the other — so neither failure
     * can suppress the other.
     */
    const registerCard = (slot: typeof ROW_CONFIG_SLOT | typeof BUNDLE_CONFIG_SLOT, key: string): void => {
      try {
        ctx.slots.inject(slot, () => ctx.slots.register({
          name: slot,
          key,
          inject: cardFace,
        // The slot names are declared structurally in `quota-slots.ts`, where
        // the owner share (`view`) they carry is written out; the component is
        // typed against that same contract.
        } as never, QoderPluginCard as never))
      } catch (error: unknown) {
        console.error(`[dsh-connect-qoder-x] card slot "${slot}" failed to register (host provider unaffected):`, error)
      }
    }
    registerCard(ROW_CONFIG_SLOT, ROW_CONFIG_KEY)
    registerCard(BUNDLE_CONFIG_SLOT, PACKAGE_NAME)

    /**
     * 插件自有配置（`<profile>/.dsh-connect-qoder-x/settings.json`）：两条宿主线的
     * 读写都走宿主半的 settings face，不再经过 settingsScope / configForms。
     *
     * 0.1.7 的 configForms 写入会整树 reconcile + fiber 热重载（每次约
     * 1~1.5 秒，且每次保存都刷新所有客户端镜像）；自有文件写入是本地毫秒级
     * 原子写。卡片注册无条件进行：scope 在启动时载入，迟到也不会漏掉 UI。
     */
    const ownQuotaScope = new OwnQuotaSettingsScope()
    void ownQuotaScope.load()
    adoptQuotaScope(ownQuotaScope as unknown as QuotaSettingsScope<QuotaSection>)

    ctx.effect(() => injectQuotaCss(), 'dsh-connect-qoder-x: quota styles')

    // 2. The composer quota readout. It lives in the composer toolbar
    //    (`conversation.input.left`, a session-scoped list) and renders ONLY
    //    while the active session's selected model belongs to this plugin, so
    //    it never occupies space for readers who do not use Qoder. The chip
    //    expands into an anchored panel with both variants' figures.
    ctx.inject(['modelDirectories'], scope => {
      try {
        scope.slots.inject('conversation.input.left', () => scope.slots.register({
          name: 'conversation.input.left',
          id: 'qoder-quota-readout',
          order: 5,
          inject: (sessionId: string) => ({
            directory: scope.modelDirectories.directoryFor(
              sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
            ).store,
            t,
          }),
        } as never, ComposerQuotaChip as never))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder-x] could not register the composer quota readout:', error)
      }
    })

    // 3. The context-window probe: a compact control before the submit action
    //    that verifies requests carry a large enough context window.
    ctx.inject(['modelDirectories'], scope => {
      try {
        scope.slots.inject('conversation.input.right', () => scope.slots.register({
          name: 'conversation.input.right',
          id: 'qoder-probe',
          order: 10,
          inject: (sessionId: string) => ({
            directory: scope.modelDirectories.directoryFor(
              sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
            ).store,
            t,
          }),
        }, QoderProbeControl))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder-x] could not register the context probe:', error)
      }
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-connect-qoder-x] client card failed to load (host provider unaffected):', error)
  }
}
