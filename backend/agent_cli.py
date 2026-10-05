import argparse, json, sys
from engine.agent import run_agent, load_cached
ap = argparse.ArgumentParser()
ap.add_argument("--target", required=True)
ap.add_argument("--live", action="store_true")
a = ap.parse_args()
r = run_agent(a.target) if a.live else load_cached(a.target)
print(json.dumps(r["summary"], indent=1), "cost", r["cost_usd"])
for x in r["results"]:
    print(f'{x["status"]:4} {x["severity"]:8} {x["case_id"]:22} {x["category"]:16} obs={x["observed"]!r} ref={x["reference_U"]}')
