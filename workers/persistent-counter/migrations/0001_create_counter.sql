CREATE TABLE counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0)
);

INSERT INTO counter (id, value) VALUES (1, 0);
