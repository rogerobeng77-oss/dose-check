# Dose Check

Tests real open-source insulin bolus calculators against a cited formula and shows where they give unsafe doses.

Live: https://fewuw3j4sm.ap-southeast-1.awsapprunner.com

Pipeline: Nemotron 3 Super reads the source and states the formula it implements; Nemotron 3.5 Lightning calls a `run_test` tool that executes the real calculator code in a restricted Node subprocess; a deterministic Python oracle (Zhu et al. 2020 Eq. 4, Huckvale et al. 2015 categories) scores every result; Super explains failures and proposes a patch, which is re-run against the real code.

## NVIDIA Nemotron and Nebius Token Factory

- **Nemotron:** `nvidia/nemotron-3-super-120b-a12b` reads the calculator source and states its formula, then explains failures and proposes a patch. `nvidia/Nemotron-3_5-Lightning` makes the `run_test` tool calls that execute the real code.
- **Token Factory:** Every model call runs on Nebius Token Factory, which is serverless and OpenAI-compatible, so one base URL and the standard OpenAI client reached every model with no GPU and no dedicated endpoint to provision. That is what let this be built and deployed quickly, and the tiers put function calling on the small Lightning model and the reasoning on Super.
- **Other models:** none. No other model is used; measurement/logic is classical code (the Python oracle and the Node sandbox).

Targets: mxklb/boluscalculator (MIT), Pancreas-Digital/bolus-calculator (GPL-3.0), nightscout/cgm-remote-monitor Bolus Wizard Preview (AGPL-3.0).

Run: `cd backend && NEBIUS_API_KEY=... uvicorn server:app --port 8123` (frontend: `cd frontend && npm i && npm run build`).
Cached agent runs are served by default; "Run agent" re-runs live against Token Factory (rate limited).
Docker: `docker build -t dose-check . && docker run -p 8080:8080 -e NEBIUS_API_KEY=... dose-check`

Stack: Python, FastAPI, React (Vite), Node test sandbox, NVIDIA Nemotron on Nebius Token Factory.

Licensed under the Apache License 2.0 (target sources keep their own licences).
