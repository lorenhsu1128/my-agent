# `web/` — my-agent Web UI (M-WEB)

Discord 風格三欄式 web UI，嵌在 daemon process 內。瀏覽器透過 LAN IP 連入。

## 開發

```bash
# 在 my-agent 根目錄
bun run dev:web    # Vite dev server on 127.0.0.1:5173 with proxy → daemon :9090
bun run build:web  # 產出 web/dist/
```

## 架構

- React 18 + TypeScript + Vite
- Tailwind CSS（Discord-inspired dark palette）
- zustand（state management）
- react-router-dom（左欄 project / session 路由）

`web/dist` 由 daemon 內 `src/web/staticServer.ts` 直接 serve。

## 計畫

詳見 `docs/plans/M-WEB.md`。
