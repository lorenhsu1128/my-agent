/**
 * M-WEB-SLASH-D1：所有 jsx-handoff 命令的共用 placeholder Modal。
 *
 * 顯示 command metadata + 「TUI 端有完整互動，web 端目前是 stub」說明。
 * D2 加 per-category hint（例如 /config 顯示 link to settings、/sessions
 * 顯示 link to session list）。M-WEB-SLASH-D-FULL 會逐個替換成真 React port。
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { WebSlashCommandMetadata } from '@/api/client'
import { categorize } from './commandCategory'
import { useUiStore, type ContextTabId } from '@/store/uiStore'

interface Props {
  metadata: WebSlashCommandMetadata
  args: string
  onClose: () => void
}

export function GenericLocalJsxModal({ metadata, args, onClose }: Props) {
  const cat = categorize(metadata.userFacingName)
  const setRightTab = useUiStore(s => s.setRightTab)
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span className="font-mono">/{metadata.userFacingName}</span>
            <Badge variant="outline" className="text-[10px]">
              jsx
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {cat.label}
            </Badge>
            {metadata.kind === 'workflow' && (
              <Badge variant="secondary" className="text-[10px]">
                workflow
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>{metadata.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {metadata.argumentHint && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">用法</span>
              <span className="font-mono text-xs">
                /{metadata.userFacingName} {metadata.argumentHint}
              </span>
            </div>
          )}
          {args.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">本次參數</span>
              <span className="font-mono text-xs break-all">{args}</span>
            </div>
          )}
          {metadata.aliases && metadata.aliases.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">別名</span>
              <div className="flex flex-wrap gap-1">
                {metadata.aliases.map(a => (
                  <Badge key={a} variant="outline" className="text-[10px] font-mono">
                    /{a}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <Separator />
          <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground space-y-2">
            <p className="font-semibold text-foreground">{cat.label} · 提示</p>
            <p>{cat.hint}</p>
            <p className="pt-1 text-[11px]">
              要使用完整 TUI 功能請在終端機執行
              <span className="font-mono mx-1">my-agent</span>後輸入
              <span className="font-mono mx-1">/{metadata.userFacingName}</span>。
              完整 React port 規劃在
              <span className="font-mono mx-1">M-WEB-SLASH-D-FULL</span>。
            </p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          {cat.relatedTab && (
            <Button
              variant="outline"
              onClick={() => {
                setRightTab(cat.relatedTab as ContextTabId)
                onClose()
              }}
            >
              開 {cat.relatedTab} tab
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            關閉
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
