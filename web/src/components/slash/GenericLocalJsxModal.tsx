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

interface Props {
  metadata: WebSlashCommandMetadata
  args: string
  onClose: () => void
}

export function GenericLocalJsxModal({ metadata, args, onClose }: Props) {
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono">/{metadata.userFacingName}</span>
            <Badge variant="outline" className="text-[10px]">
              jsx
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
            <p className="font-semibold text-foreground">
              此命令在 TUI 端有完整互動 UI
            </p>
            <p>
              Web 端目前提供 metadata 預覽；要使用完整功能請在終端機執行
              <span className="font-mono mx-1">my-agent</span>
              後輸入
              <span className="font-mono mx-1">/{metadata.userFacingName}</span>
              。
            </p>
            <p>
              完整 React port 規劃在後續 milestone
              <span className="font-mono mx-1">M-WEB-SLASH-D-FULL</span>
              處理。
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            關閉
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
