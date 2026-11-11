import type { GlobalVendorArgs } from '@builderbot/bot/dist/types'
import { proto, WABrowserDescription, WAVersion } from 'baileys'
export interface BaileyGlobalVendorArgs extends GlobalVendorArgs {
    gifPlayback: boolean
    usePairingCode: boolean
    phoneNumber: string | null
    browser: WABrowserDescription
    experimentalSyncMessage?: string
    fallBackAction?: (ctx: proto.IWebMessageInfo) => Promise<void>
    useBaileysStore: boolean
    timeRelease?: number
    experimentalStore?: boolean
    offlineReplayEnabled?: boolean
    /** Silencio tras `receivedPendingNotifications` antes de cerrar la ventana de replay. */
    offlineReplayQuietMs?: number
    groupsIgnore: boolean
    readStatus: boolean
    version?: WAVersion //
    autoRefresh?: number
    host?: any
    /**
     * Si es true, ante `connectionReplaced` (440) el proceso termina con codigo 79
     * en vez de reconectar. Por defecto false (comportamiento historico).
     */
    exitOnReplaced?: boolean
}
