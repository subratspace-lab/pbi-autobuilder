# PBI AutoBuilder

**Raw data + a project brief → a ready-to-open Power BI project.**

A local full-stack app (React + Node.js) that does the slow parts of a Power BI project:

1. **Understand.** It profiles every column (types, blanks, duplicates, inconsistent text, currency symbols, mixed date formats). Then an LLM reads the brief and explains the business, the questions to answer and the KPIs.
2. **Clean.** It suggests Power Query steps and shows a live before/after preview. Each step becomes a named step in *Applied Steps*.
3. **Model.** It designs a star schema (facts, dimensions, keys) and generates a Date table marked as the date table.
4. **Measures.** It writes DAX measures in layers: base → ratios (`DIVIDE`) → time intelligence (YTD, PY, YoY, MoM). A linter checks every column reference.
5. **Dashboard.** It lays out KPI cards, trend and breakdown charts, a matrix and slicers, plus a theme. The preview uses your real cleaned data.
6. **Export.** It writes a **Power BI Project (.pbip)**: TMDL semantic model plus a PBIR report. It also writes a README that explains every step, the expected totals and demo talking points. Open it in Power BI Desktop, then **Save as .pbix**.

> **Design principle: AI decides, templates generate.** The LLM only ever returns small JSON specs (cleaning operations, schema, measures, visual list). These are validated with zod and shown for review. Tested generators then turn them into Power Query M, TMDL and PBIR, so the AI never writes Power BI files directly.
> Every step also has a **rules** mode that works without any AI.

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Zustand, React Router, TanStack Table, React Flow (schema diagram), Monaco (DAX / M editors), Recharts (dashboard preview) |
| Backend | Node.js, Express, TypeScript (tsx), papaparse + SheetJS (CSV/Excel), pdf-parse + mammoth (brief), zod, Handlebars, archiver |
| AI | Any OpenAI-compatible API via the `openai` SDK: **Google Gemini (free tier)**, Groq, OpenRouter free models, or **Ollama** offline |
| Output | Power Query M · TMDL · PBIR (enhanced report format) · Power BI theme JSON |

## Quick start

Requirements: Node.js 20+ and Windows with [Power BI Desktop](https://aka.ms/pbidesktopstore) to open the result.

```bash
npm install
cp .env.example .env        # optional — you can also set the key in the app's Settings page
npm run dev                 # client http://localhost:5173 · API http://localhost:3000
```

Production-style (one port):

```bash
npm start                   # builds the client and serves everything on http://localhost:3000
```

Click **Try the sample project** on the home page. It loads a deliberately messy retail export plus a client brief (regenerate it with `node scripts/make-sample.mjs`).

### Free AI options

| Provider | Why | Key |
|---|---|---|
| **Gemini Flash** (recommended) | Free tier, large context, good at DAX/M, JSON mode | https://aistudio.google.com/apikey |
| Groq — Llama 3.3 70B | Free tier, very fast | https://console.groq.com/keys |
| OpenRouter `:free` models | Many free models | https://openrouter.ai/keys |
| Ollama — `qwen2.5-coder:7b` | Offline/private, needs 16 GB RAM + 6 GB GPU to be pleasant | https://ollama.com |

The app sends the AI only the column names, profile statistics, ~15 sample rows per table and the brief. It never sends the full dataset.

## Opening the result in Power BI

1. Power BI Desktop 2024+. On older builds, enable *Options → Preview features → Power BI Project (.pbip) save option* and *Store reports using enhanced metadata format (PBIR)*.
2. Open `<name>.pbip`. If the data moved, set *Transform data → Edit parameters → DataFolder* to the `Data\` folder.
3. **Refresh**, then compare the row counts and totals with the Export page / README.
4. **File → Save as → .pbix**.

## Project structure

```
client/                React app (pages: Upload, Profile, Clean, Model, Measures, Dashboard, Export, Settings)
server/src/
  routes/              REST API
  services/
    ingest.ts          CSV/Excel/brief parsing (mirrors Power Query's PromoteHeaders)
    profile.ts         column profiling
    cleaning.ts        cleaning op library — every op has applyJs() + toM()
    model.ts           star-schema validation & materialisation
    dax.ts             DAX linter + a small evaluator for preview/validation totals
    report.ts          visual roles + grid layout engine
    tmdl.ts, pbir.ts   Power BI file generators
    pbipWriter.ts      assembles the .pbip folder, README and zip
    rules.ts           rule-based suggestions (no AI)
    ai.ts, llm.ts      prompts → JSON → zod validation → normalisation
  prompts/             one prompt per step
shared/types.ts        spec types shared by client & server
scripts/               sample-data generator, end-to-end API smoke test
```

## Tests

```bash
npm test                          # unit tests (M generation, value parsing, DAX lint/evaluator)
node scripts/e2e.mjs rules        # full pipeline against a running server (or "ai")
```

## Known limitations

- The PBIR visual JSON follows Microsoft's published schema. If your Power BI Desktop version renders a visual differently, save any report as `.pbip` with that version and drop its folder into `server/reference/`. The base theme is then taken from it. The generated README also has a visual-by-visual build spec as a fallback.
- The preview evaluates simple measures (SUM, COUNT, DISTINCTCOUNT, AVERAGE, DIVIDE, arithmetic). Time-intelligence measures are computed only in Power BI.
- Map visuals depend on your tenant allowing Bing maps.
