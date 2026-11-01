/** 壳经 desktop/preload.cjs 给页面的东西。不在壳里打开（比如浏览器）时没有 campusShell。 */

/** 检查更新走到哪了（desktop/update.cjs）。 */
interface CampusUpdateState {
  status: 'unavailable' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'no-access' | 'error'
  /** 现在装着的版本。 */
  current: string
  /** 正在下或已经下好的那一版。 */
  version?: string
  /** 下到百分之几。 */
  percent?: number
  /** 没成功的原因。 */
  message?: string
}

interface Window {
  campusShell?: {
    loginPta: () => Promise<{ status: 'saved' | 'cancelled' | 'error', message?: string }>
    closeToTray: () => Promise<boolean>
    setCloseToTray: (on: boolean) => Promise<boolean>
    /** 新消息时弹不弹 Windows 的系统通知。 */
    notify: () => Promise<boolean>
    setNotify: (on: boolean) => Promise<boolean>
    /** Windows 的通知是不是被用户在系统设置里关掉了（关着时应用弹不出来）。 */
    notifyBlocked: () => Promise<boolean>
    update: () => Promise<CampusUpdateState | undefined>
    checkUpdate: () => Promise<CampusUpdateState | undefined>
    installUpdate: () => Promise<void>
    /** 存下查更新时带上的 GitHub 令牌（可以不填；给空的是删掉），随后重新查一次。 */
    saveUpdateToken: (token: string) => Promise<CampusUpdateState | undefined>
    /** 托盘上点的那条消息要打开哪里：一个对话，或者侧栏上的一页；取一次就没了。 */
    takeOpen: () => Promise<{ sessionId?: string, panel?: string } | undefined>
  }
}
