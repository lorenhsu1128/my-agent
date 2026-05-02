/**
 * M-WEB-PARITY-7：Web header 的 model picker。
 *
 * GET /api/models 拉清單 + 當前；PUT /api/models/current 切換。Daemon 端走
 * setMainLoopModelOverride，下次 turn 立即生效（不重建 session）。
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError } from '@/api/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function ModelPicker() {
  const [models, setModels] = useState<
    { value: string; label: string; description: string }[]
  >([])
  const [current, setCurrent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh(): Promise<void> {
    try {
      const r = await api.listModels()
      setModels(r.models)
      setCurrent(r.current)
    } catch (err) {
      // 安靜處理；header 不適合顯示錯誤
      console.warn('[ModelPicker] list failed', err)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function onChange(value: string): Promise<void> {
    if (busy || value === current) return
    setBusy(true)
    try {
      await api.setCurrentModel(value)
      setCurrent(value)
      toast.success('已切換 model', { description: value })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
      toast.error('切換失敗', { description: msg })
    } finally {
      setBusy(false)
    }
  }

  if (models.length === 0) return null

  return (
    <Select value={current ?? undefined} onValueChange={onChange} disabled={busy}>
      <SelectTrigger className="h-7 w-44 text-xs">
        <SelectValue placeholder="選 model…" />
      </SelectTrigger>
      <SelectContent>
        {models.map(m => (
          <SelectItem key={m.value} value={m.value} className="text-xs">
            <div className="flex flex-col">
              <span className="font-medium">{m.label}</span>
              <span className="text-[10px] text-muted-foreground truncate max-w-[20rem]">
                {m.description}
              </span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
