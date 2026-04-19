/**
 * my-agent: OAuth 流程已停用。
 * 保留 ConsoleOAuthFlow export + Props 介面供 cli/handlers/util.tsx、
 * commands/login/login.tsx、components/Onboarding.tsx、components/TeleportError.tsx
 * import 不破，但實際 mount 時直接呼叫 onDone 後渲染 null。
 */
import * as React from 'react'
import { useEffect } from 'react'

type Props = {
  onDone(): void
  startingMessage?: string
  mode?: 'login' | 'setup-token'
  forceLoginMethod?: 'claudeai' | 'console'
}

export function ConsoleOAuthFlow({ onDone }: Props): React.ReactNode {
  useEffect(() => {
    onDone()
  }, [onDone])
  return null
}
