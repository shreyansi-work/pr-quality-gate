# PR Quality Gate: web

React + TypeScript + Vite. It replaces the plain-JS page that used to live in `api/public`.

## Develop

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

The dev server forwards `/api` to the Nest server on `http://localhost:3000`, so start the API first
(`cd ../api && npm run start:dev`). Edits show up in the browser immediately.

## Build for the Nest server

```bash
npm run build      # type-checks, then writes the site into ../api/public
```

`api/public` is what Nest already serves (`app.useStaticAssets(join(process.cwd(), 'public'))`),
so after a build you open `http://localhost:3000` as before. The build empties `api/public` first,
so do not keep other files there.

## Layout

```
src/
  main.tsx, App.tsx          entry and page shell (sidebar, routes)
  types.ts                   API shapes
  lib/api.ts                 fetch wrapper; every write reloads the screens (invalidate)
  lib/useApi.ts              data hook: keeps old data while reloading, optional auto refresh
  lib/route.ts               hash routing (#/  #/pr/5?f=48  #/tickets?pr=5)
  lib/format.ts              labels, dates, status wording
  lib/drawer.ts              open the ticket drawer from any screen
  components/                Pipeline, DetailModal, StagePanels, Drawers, controls, toast and dialogs
  views/                     PullsView, PullView, TicketsView
  styles.css                 all styling (Indigo theme, responsive)
```

Links such as `#/pr/5?f=48` work as before.
