CREATE TABLE IF NOT EXISTS routes (
  site TEXT NOT NULL,
  task TEXT NOT NULL,
  start_state TEXT NOT NULL,
  route_json TEXT NOT NULL,
  PRIMARY KEY (site, task, start_state)
);

CREATE TABLE IF NOT EXISTS completed_runs (
  run_id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  task TEXT NOT NULL,
  start_state TEXT NOT NULL,
  FOREIGN KEY (site, task, start_state)
    REFERENCES routes (site, task, start_state)
);

CREATE TABLE IF NOT EXISTS planner_runs (
  run_id TEXT PRIMARY KEY,
  planning_calls INTEGER NOT NULL DEFAULT 0
);